import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store, QueueFullError } from '../src/store.js';

function fixture(t, maxPendingJobs = 100) {
  const dataDir = mkdtempSync(join(tmpdir(), 'private-bridge-test-'));
  const config = { dataDir, key: randomBytes(32), maxPendingJobs };
  const store = new Store(config);
  t.after(() => { try { store.close(); } catch {} rmSync(dataDir, { recursive: true, force: true }); });
  return { store, config };
}
const entry = (id, text = 'secret-payload-فقط-دو-نفر') => ({ updateId: id, messageId: id, payload: { message: { text } } });
const textPlan = text => [{ method: 'sendMessage', params: { text } }];
const participants = () => ({
  users: { bale: 11111111, telegram: 22222222 },
  chatIds: { bale: 11111111, telegram: 22222222 },
  botNames: { bale: 'ExampleBaleBot', telegram: 'ExampleTelegramBot' },
});

test('participant binding persists a canonical fingerprint and rejects rerouting after restart', t => {
  const { store, config } = fixture(t);
  const identity = participants();
  const fingerprint = store.bindParticipants(identity);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(store.bindParticipants({ ...identity, botNames: { bale: 'EXAMPLEBALEBOT', telegram: 'exampletelegrambot' } }), fingerprint);
  store.ingest('bale', [entry(1)]);
  store.close();
  const restored = new Store(config);
  try {
    assert.equal(restored.bindParticipants(identity), fingerprint);
    for (const altered of [
      { ...identity, users: { ...identity.users, bale: 33333333 } },
      { ...identity, chatIds: { ...identity.chatIds, bale: 44444444 } },
      { ...identity, botNames: { ...identity.botNames, telegram: 'OtherExampleBot' } },
    ]) assert.throws(() => restored.bindParticipants(altered), error => error.code === 'participant_configuration_changed');
    assert.equal(restored.offset('bale'), 2);
    assert.equal(restored.stats().received, 1);
    assert.equal(restored.nextUnprepared('bale').raw.message.text, 'secret-payload-فقط-دو-نفر');
  } finally { restored.close(); }
});

test('unbound legacy jobs, mappings or prior receive cursors cannot be claimed by a new configuration', t => {
  for (const legacy of ['jobs', 'mappings', 'offset']) {
    const { store } = fixture(t);
    if (legacy === 'jobs') store.ingest('bale', [entry(5)]);
    else if (legacy === 'mappings') store.db.prepare('INSERT INTO mappings VALUES (?,?,?,?,?)').run('bale', 1, 'telegram', 2, Date.now());
    else store.db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('offset:bale', '90');
    assert.throws(() => store.bindParticipants(participants()), error => error.code === 'unbound_existing_queue');
    assert.equal(store.db.prepare("SELECT value FROM meta WHERE key='participant_fingerprint'").get(), undefined);
  }
});

test('a reused bot username cannot silently rebind the queue to a different bot ID', t => {
  const { store } = fixture(t);
  store.bindParticipants(participants());
  store.bindBotIdentity('bale', 900001);
  store.bindBotIdentity('bale', 900001);
  assert.throws(() => store.bindBotIdentity('bale', 900002), error => error.code === 'bot_identity_changed');
  assert.equal(store.db.prepare('SELECT value FROM meta WHERE key=?').get('bot_id:bale').value, '900001');
});

test('atomic persistence does not advance offset or leave partial rows on a failed transaction', t => {
  const { store } = fixture(t);
  assert.throws(() => store.ingest('bale', [entry(1), { updateId: NaN }]));
  assert.equal(store.offset('bale'), 0);
  assert.deepEqual(store.stats(), {});
  assert.equal(store.ingest('bale', [entry(1), entry(2)]), 2);
  assert.equal(store.offset('bale'), 3);
  assert.equal(store.ingest('bale', [entry(1), entry(2)]), 0);
  assert.equal(store.stats().received, 2);
});

test('capacity commits a safe prefix and never acknowledges a pending unpersisted update', t => {
  const { store } = fixture(t, 2);
  assert.equal(store.ingest('bale', [entry(10), entry(11), entry(12)]), 2);
  assert.equal(store.offset('bale'), 12);
  assert.throws(() => store.ingest('bale', [entry(12)]), QueueFullError);
  assert.equal(store.offset('bale'), 12);
  const first = store.nextUnprepared('bale');
  store.prepare(first.id, textPlan('a'));
  store.advance(store.headReady('bale'), 'telegram', { message_id: 88 });
  assert.equal(store.ingest('bale', [entry(12)]), 1);
  assert.equal(store.offset('bale'), 13);
});

test('restart restores encrypted queued text and attachment; completed steps do not repeat', t => {
  const { store, config } = fixture(t);
  store.ingest('bale', [entry(5)]);
  const job = store.nextUnprepared('bale');
  const content = Buffer.from('secret-media-bytes-123456');
  store.prepare(job.id, [...textPlan('secret-queued-text-abcdef'), ...textPlan('second')], new Map([[1, content]]));
  store.advance(store.headReady('bale'), 'telegram', { message_id: 18 });
  store.close();
  const restored = new Store(config);
  assert.equal(restored.offset('bale'), 6);
  assert.equal(restored.headReady('bale').step_index, 1);
  assert.deepEqual(restored.attachment(job.id, 1), content);
  assert.equal(restored.replyTarget('telegram', 18), 5);
  assert.equal(restored.replyTarget('bale', 5), 18);
  for (const file of readdirSync(config.dataDir)) {
    const bytes = readFileSync(join(config.dataDir, file));
    assert.equal(bytes.includes(Buffer.from('secret-media-bytes-123456')), false);
    assert.equal(bytes.includes(Buffer.from('secret-queued-text-abcdef')), false);
  }
  restored.advance(restored.headReady('bale'), 'telegram', { message_id: 19 });
  assert.equal(restored.attachment(job.id, 1), undefined);
  assert.equal(restored.headReady('bale'), null);
  assert.equal(restored.stats().delivered, 1);
  restored.close();
});

test('local status and notices bypass blocked remote FIFO without reordering relay content', t => {
  const { store } = fixture(t);
  store.ingest('bale', [entry(1), entry(2), entry(3)]);
  store.prepare('bale:1', textPlan('remote1'));
  store.defer('bale:1', 'send', 'network', Date.now() + 100000);
  store.prepare('bale:2', textPlan('remote2'));
  store.prepare('bale:3', [{ method: 'sendMessage', notice: true, params: { text: 'status' } }]);
  assert.equal(store.headReady('bale').id, 'bale:3');
  store.advance(store.headReady('bale'), 'bale', { message_id: 10 });
  assert.equal(store.headReady('bale'), null);
  assert.equal(store.headReady('bale', Date.now() + 200000).id, 'bale:1');
});

test('Telegram idle cursor resets before weekly random IDs while keeping already queued jobs', t => {
  const { store } = fixture(t);
  const start = Date.now();
  store.ingest('telegram', [entry(900000)], start);
  store.ingest('bale', [entry(900000)], start);
  assert.equal(store.pollOffset('telegram', start + 86400000), 900001);
  assert.equal(store.pollOffset('telegram', start + 2 * 86400000), 0);
  assert.equal(store.pollOffset('bale', start + 8 * 86400000), 900001);
  assert.equal(store.ingest('telegram', [entry(123)], start + 8 * 86400000), 1);
  assert.equal(store.offset('telegram'), 124);
  assert.equal(store.stats('telegram').received, 2);
});

test('mismatched key and altered authenticated ciphertext fail closed', t => {
  const { store, config } = fixture(t);
  assert.throws(() => new Store({ ...config, key: randomBytes(32) }), /key does not match/);
  store.ingest('telegram', [entry(1)]);
  const row = store.db.prepare('SELECT raw FROM jobs').get();
  const corrupt = Buffer.from(row.raw); corrupt[corrupt.length - 1] ^= 1;
  store.db.prepare('UPDATE jobs SET raw=?').run(corrupt);
  assert.throws(() => store.nextUnprepared('telegram'));
});

test('lease excludes a second active instance and encrypted consistent backups recover pending jobs', t => {
  const { store, config } = fixture(t);
  assert.equal(store.acquireLease('owner1', 1000, 1000), true);
  assert.equal(store.acquireLease('owner2', 1001, 1000), false);
  assert.equal(store.renewLease('owner1', 1500, 1000), true);
  assert.equal(store.renewLease('owner1', 2600, 1000), false);
  assert.equal(store.acquireLease('owner2', 2600, 1000), true);
  store.ingest('telegram', [entry(30)]);
  const backup = join(config.dataDir, 'snapshot.sqlite');
  store.backup(backup);
  assert.equal(readFileSync(backup).includes(Buffer.from('secret-payload')), false);
  assert.ok(readFileSync(backup).byteLength > 0);
  const restoreDir = join(config.dataDir, 'restored');
  mkdirSync(restoreDir);
  copyFileSync(backup, join(restoreDir, 'bridge.sqlite'));
  const restored = new Store({ ...config, dataDir: restoreDir });
  try {
    assert.equal(restored.offset('telegram'), 31);
    assert.equal(restored.nextUnprepared('telegram').raw.message.text, 'secret-payload-فقط-دو-نفر');
  } finally { restored.close(); }
});
