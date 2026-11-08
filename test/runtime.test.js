import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store, QueueFullError } from '../src/store.js';
import { ApiError } from '../src/api.js';
import { runBridge, intakeEntries as intake } from '../src/runtime.js';
// Synthetic fixtures only; no personal identities are shipped.
const USERS = Object.freeze({ bale: 11111111, telegram: 22222222 });
const BOT_NAMES = Object.freeze({ bale: 'ExampleBaleBot', telegram: 'ExampleTelegramBot' });
const intakeEntries = (platform, updates) => intake(platform, updates, { userId: USERS[platform], chatId: USERS[platform] });

// Only in-memory fake APIs are used. Private-message data for each test is
// written to an isolated temporary SQLite database, outside the project tree.
const scratchRoot = join(tmpdir(), 'private-bridge-runtime-tests');
const key = Buffer.alloc(32, 71);
const config = {
  users: USERS, botNames: BOT_NAMES, chatIds: USERS,
  maxFileBytes: 20 * 1024 * 1024,
  pollTimeout: 1,
  sendIntervalMs: 1,
  retentionMs: 86400000,
  removeWebhook: false,
};

function update(platform, updateId, content = {}, overrides = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 100,
      from: { id: USERS[platform], is_bot: false },
      chat: { id: USERS[platform], type: 'private' },
      date: 1700000000,
      ...content,
      ...overrides,
    },
  };
}

class FakeApi {
  constructor(platform, updates = []) {
    this.platform = platform;
    this.updates = updates;
    this.bootstrapDown = false;
    this.calls = [];
    this.offsets = [];
    this.attempts = [];
    this.sent = [];
    this.downloads = [];
    this.fileBytes = Buffer.from('private media bytes');
    this.sendImpl = null;
    this.fileImpl = null;
  }
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === 'getMe') {
      if (this.bootstrapDown) throw new ApiError('network');
      return { id: this.platform === 'bale' ? 900001 : 900002, is_bot: true, username: BOT_NAMES[this.platform] };
    }
    if (method === 'getWebhookInfo') return { url: '' };
    throw new Error(`Unexpected fake API method: ${method}`);
  }
  async getUpdates({ offset }) {
    this.offsets.push(offset);
    return this.updates.filter(item => item.update_id >= offset).slice(0, 100);
  }
  async getFileBuffer(fileId, options) {
    this.downloads.push(fileId);
    if (this.fileImpl) return this.fileImpl(fileId, options);
    return { bytes: Buffer.from(this.fileBytes), filename: 'received.bin' };
  }
  async send(step, options) {
    const attempt = {
      step: structuredClone(step),
      chatId: options.chatId,
      replyToId: options.replyToId,
      bytes: options.bytes ? Buffer.from(options.bytes) : undefined,
    };
    this.attempts.push(attempt);
    if (this.sendImpl) await this.sendImpl(attempt, options);
    this.sent.push(attempt);
    return { message_id: 1000 + this.sent.length };
  }
}

async function until(predicate, label, milliseconds = 6000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    if (predicate()) return;
    await delay(15);
  }
  assert.fail(`Timed out: ${label}`);
}

function fixture(t, { bale = [], telegram = [], maxPendingJobs = 10000 } = {}) {
  mkdirSync(scratchRoot, { recursive: true });
  const dataDir = mkdtempSync(join(scratchRoot, 'case-'));
  let store = new Store({ dataDir, key, maxPendingJobs });
  store.bindParticipants(config);
  let controller;
  let running;
  let failure;
  const apis = { bale: new FakeApi('bale', bale), telegram: new FakeApi('telegram', telegram) };
  const result = {
    get store() { return store; },
    apis,
    start() {
      assert.ok(!running, 'previous runtime has stopped');
      controller = new AbortController();
      failure = undefined;
      running = runBridge({ config, store, apis, signal: controller.signal })
        .catch(error => { failure = error; });
    },
    abort() { controller?.abort(); },
    async stop() {
      controller?.abort();
      if (running) await running;
      running = undefined;
      assert.equal(failure, undefined, failure?.code || failure?.message);
    },
    async reopen() {
      await result.stop();
      store.close();
      store = new Store({ dataDir, key, maxPendingJobs });
    },
  };
  t.after(async () => {
    try { await result.stop(); }
    finally {
      store.close();
      const absolute = resolve(dataDir);
      assert.ok(absolute.startsWith(resolve(scratchRoot) + '\\') || absolute.startsWith(resolve(scratchRoot) + '/'));
      rmSync(absolute, { recursive: true, force: true });
    }
  });
  return result;
}

test('a transient send outage preserves the queue and the other direction keeps delivering', async t => {
  const f = fixture(t, {
    bale: [update('bale', 10, { text: 'از ایران' })],
    telegram: [update('telegram', 20, { text: 'از ترکیه' })],
  });
  f.apis.telegram.sendImpl = () => {
    if (f.apis.telegram.attempts.length === 1) throw new ApiError('network');
  };
  f.start();
  await until(() => f.apis.telegram.attempts.length === 1 && f.store.stats('telegram').delivered === 1,
    'retry is pending while reverse delivery succeeds');
  assert.equal(f.store.offset('bale'), 11);
  assert.equal(f.store.stats('bale').ready, 1);
  assert.equal(f.apis.bale.sent[0].chatId, USERS.bale);
  assert.equal(f.apis.bale.sent[0].step.params.text, 'از ترکیه');
  await until(() => f.store.stats('bale').delivered === 1, 'retry after recovery');
  assert.equal(f.apis.telegram.attempts.length, 2);
  assert.equal(f.apis.telegram.sent.length, 1);
  assert.equal(f.apis.telegram.sent[0].step.params.text, 'از ایران');
});

test('restart resumes only remaining delivery steps and retains the committed polling offset', async t => {
  const text = 'a'.repeat(5000);
  const f = fixture(t, { bale: [update('bale', 41, { text })] });
  f.apis.telegram.sendImpl = () => { f.abort(); };
  f.start();
  await until(() => f.apis.telegram.sent.length === 1, 'first split message sends');
  await f.stop();
  assert.equal(f.store.offset('bale'), 42);
  const partial = f.store.headReady('bale');
  assert.equal(partial.step_index, 1);
  assert.equal(f.apis.telegram.sent[0].step.params.text.length, 4096);
  await f.reopen();
  assert.equal(f.store.offset('bale'), 42);
  f.apis.telegram.sendImpl = null;
  f.apis.bale.offsets = [];
  f.start();
  await until(() => f.store.stats('bale').delivered === 1, 'second split message resumes');
  assert.equal(f.apis.bale.offsets[0], 42);
  assert.equal(f.apis.telegram.sent.length, 2);
  assert.equal(f.apis.telegram.sent[1].step.params.text.length, 904);
  assert.equal(f.apis.telegram.sent.map(item => item.step.params.text).join(''), text);
  const finished = f.store.db.prepare('SELECT raw,plan FROM jobs WHERE id=?').get('bale:41');
  assert.equal(finished.raw, null);
  assert.equal(finished.plan, null);
});

test('unauthorized identities and groups advance offsets without storing or downloading private content', async t => {
  const f = fixture(t, { bale: [
    update('bale', 1, { document: { file_id: 'forbidden-file' } }, { from: { id: 999, is_bot: false } }),
    update('bale', 2, { text: 'forbidden group text' }, { chat: { id: USERS.bale, type: 'group' } }),
    update('bale', 3, { text: 'authorized text' }),
  ] });
  f.start();
  await until(() => f.store.stats('bale').delivered === 1, 'authorized message forwards');
  assert.equal(f.store.offset('bale'), 4);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 1);
  assert.deepEqual(f.apis.bale.downloads, []);
  assert.equal(f.apis.telegram.sent.length, 1);
  assert.equal(f.apis.telegram.sent[0].step.params.text, 'authorized text');
  assert.equal(f.apis.bale.sent.length, 0);
});

test('duplicate updates enqueue once and bot commands reply only to their own source user', async t => {
  const command = update('bale', 5, { text: '/start@ExampleBaleBot' });
  const ordinary = update('bale', 6, { text: 'one copy' });
  const f = fixture(t, { bale: [command, command, ordinary, ordinary] });
  f.start();
  await until(() => f.store.stats('bale').notified === 1 && f.store.stats('bale').delivered === 1,
    'command notice and one relay copy');
  assert.equal(f.store.offset('bale'), 7);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 2);
  assert.equal(f.apis.bale.sent.length, 1);
  assert.equal(f.apis.bale.sent[0].chatId, USERS.bale);
  assert.equal(f.apis.bale.sent[0].step.notice, true);
  assert.equal(f.apis.telegram.sent.length, 1);
  assert.equal(f.apis.telegram.sent[0].step.params.text, 'one copy');
});

test('local status bypasses relay FIFO while destination bootstrap is offline', async t => {
  const f = fixture(t, { bale: [
    update('bale', 1, { text: 'queued for unavailable destination' }),
    update('bale', 2, { text: '/status' }),
  ] });
  f.apis.telegram.bootstrapDown = true;
  f.start();
  await until(() => f.apis.bale.sent.length === 1, 'status reply while destination remains offline');
  assert.equal(f.apis.telegram.sent.length, 0);
  assert.equal(f.apis.telegram.offsets.length, 0);
  assert.equal(f.store.stats('bale').ready, 1);
  assert.equal(f.store.offset('bale'), 3);
  assert.equal(f.apis.bale.sent[0].step.notice, true);
  assert.match(f.apis.bale.sent[0].step.params.text, /در انتظار انتقال/);
});

test('source polling and encrypted media staging continue while the other bootstrap is offline', async t => {
  const secret = Buffer.from('unique private attachment that must not be plaintext');
  const f = fixture(t, { bale: [update('bale', 30, {
    document: { file_id: 'source-file', file_name: 'private-name.txt', file_size: secret.length },
    caption: 'private caption',
  })] });
  f.apis.bale.fileBytes = secret;
  f.apis.telegram.bootstrapDown = true;
  f.start();
  await until(() => f.store.stats('bale').ready === 1, 'file is durable before destination recovery');
  assert.equal(f.store.offset('bale'), 31);
  assert.deepEqual(f.apis.bale.downloads, ['source-file']);
  assert.equal(f.apis.telegram.sent.length, 0);
  const persisted = f.store.db.prepare('SELECT raw,plan FROM jobs WHERE id=?').get('bale:30');
  const attachment = f.store.db.prepare('SELECT body FROM attachments WHERE job_id=?').get('bale:30');
  assert.equal(persisted.raw, null);
  assert.equal(Buffer.from(persisted.plan).includes(Buffer.from('private caption')), false);
  assert.equal(Buffer.from(attachment.body).includes(secret), false);
  assert.deepEqual(f.store.attachment('bale:30', 0), secret);
  f.apis.telegram.bootstrapDown = false;
  await until(() => f.store.stats('bale').delivered === 1, 'staged file sends after bootstrap recovery');
  assert.deepEqual(f.apis.telegram.sent[0].bytes, secret);
  assert.equal(f.apis.bale.downloads.length, 1, 'staged bytes are reused rather than redownloaded');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM attachments').get().n, 0);
});

test('a permanent rejection creates one durable source notice and a rejected notice does not recurse', async t => {
  const f = fixture(t, { bale: [update('bale', 1, { text: 'rejected content' })] });
  f.apis.telegram.sendImpl = () => { throw new ApiError('permanent', { code: 400 }); };
  f.apis.bale.sendImpl = () => { throw new ApiError('permanent', { code: 400 }); };
  f.start();
  await until(() => f.store.stats('bale').failed === 2, 'content and its single notice are failed');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 2);
  assert.equal(f.apis.telegram.attempts.length, 1);
  assert.equal(f.apis.bale.attempts.length, 1);
  assert.equal(f.apis.bale.attempts[0].step.notice, true);
  assert.equal(f.apis.bale.attempts[0].chatId, USERS.bale);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM jobs WHERE raw IS NOT NULL OR plan IS NOT NULL').get().n, 0);
});

test('a recipient 403 keeps original content queued while notifying only the source', async t => {
  const f = fixture(t, { bale: [update('bale', 7, { text: 'retain until recipient starts' })] });
  f.apis.telegram.sendImpl = () => { throw new ApiError('permanent', { code: 403 }); };
  f.start();
  await until(() => f.store.stats('bale').notified === 1, 'source receives recipient unavailable notice');
  const queued = f.store.db.prepare('SELECT * FROM jobs WHERE id=?').get('bale:7');
  assert.equal(queued.status, 'ready');
  assert.equal(queued.error_code, 'recipient_unavailable');
  assert.ok(queued.next_send_at > Date.now() + 50000);
  assert.equal(f.store.decode(queued).plan[0].params.text, 'retain until recipient starts');
  assert.equal(f.apis.telegram.attempts.length, 1);
  assert.equal(f.apis.telegram.sent.length, 0);
  assert.equal(f.apis.bale.sent[0].step.notice, true);
  assert.equal(f.store.offset('bale'), 8);
});

test('batches larger than queue capacity commit only a fitting prefix without acknowledging the remainder', async t => {
  const f = fixture(t, { maxPendingJobs: 2 });
  const updates = [update('bale', 1, { text: 'one' }), update('bale', 2, { text: 'two' }), update('bale', 3, { text: 'three' })];
  const entries = intakeEntries('bale', updates);
  assert.equal(f.store.ingest('bale', entries), 2);
  assert.equal(f.store.offset('bale'), 3, 'third accepted update must remain unacknowledged');
  assert.equal(f.store.stats('bale').received, 2);
  assert.throws(() => f.store.ingest('bale', entries), QueueFullError);
  assert.equal(f.store.offset('bale'), 3);
  // A transaction must still advance over a rejected/unauthorized update when
  // full, but must stop before the next authorized update it cannot store.
  const tail = intakeEntries('bale', [
    update('bale', 3, { text: 'forbidden' }, { from: { id: 999 } }),
    update('bale', 4, { text: 'four' }),
  ]);
  assert.equal(f.store.ingest('bale', tail), 0);
  assert.equal(f.store.offset('bale'), 4);
});

test('an oversized source download is reported locally and is never uploaded or retained', async t => {
  const f = fixture(t, { bale: [update('bale', 8, { voice: { file_id: 'unbounded-source-file' } })] });
  f.apis.bale.fileImpl = () => { throw new ApiError('file_too_large'); };
  f.start();
  await until(() => f.store.stats('bale').notified === 1, 'file size failure notice is delivered');
  assert.equal(f.store.stats('bale').failed, 1);
  assert.equal(f.apis.telegram.attempts.length, 0);
  assert.equal(f.apis.bale.sent.length, 1);
  assert.match(f.apis.bale.sent[0].step.params.text, /بزرگ‌تر/);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM attachments').get().n, 0);
});

test('source media failures expose only operation and HTTP diagnostics before any destination upload', async t => {
  const lines = [];
  t.mock.method(console, 'log', line => lines.push(JSON.parse(line)));
  const f = fixture(t, { bale: [update('bale', 80, {
    voice: { file_id: 'private-file-id-not-for-logs', file_name: 'private-voice.ogg' },
  })] });
  f.apis.bale.fileImpl = () => { throw new ApiError('permanent', { code: 404, operation: 'download_file' }); };
  f.start();
  await until(() => f.store.stats('bale').notified === 1, 'source media failure notice');
  await f.stop();
  assert.equal(f.apis.telegram.attempts.length, 0);
  const failed = lines.find(line => line.event === 'message_failed');
  assert.equal(failed.platform, 'bale');
  assert.equal(failed.operation, 'download_file');
  assert.equal(failed.httpCode, 404);
  assert.equal(failed.code, 'permanent');
  assert.doesNotMatch(JSON.stringify(lines), /private-file-id-not-for-logs|private-voice|https:/);
});

test('a bot-wide 429 retry floor also delays a later local status notice to that same bot', async t => {
  const f = fixture(t, { bale: [update('bale', 10, { text: 'relay waiting for rate-limit recovery' })] });
  const retryAfterMs = 1200;
  const attemptedAt = [];
  let limitedAt;
  let releaseUpdate;
  let firstPoll = true;
  const normalPoll = f.apis.telegram.getUpdates.bind(f.apis.telegram);

  // Model an already in-flight long poll: it returns a new /status update just
  // after the relay send is rate-limited. This makes the local notice pending
  // during retry_after, even if subsequent Telegram polling is also delayed.
  f.apis.telegram.getUpdates = async options => {
    if (!firstPoll) return normalPoll(options);
    firstPoll = false;
    f.apis.telegram.offsets.push(options.offset);
    await new Promise(resolvePoll => {
      releaseUpdate = resolvePoll;
      options.signal.addEventListener('abort', resolvePoll, { once: true });
    });
    if (options.signal.aborted) return [];
    return [update('telegram', 50, { text: '/status' })];
  };
  f.apis.telegram.sendImpl = () => {
    attemptedAt.push(Date.now());
    if (attemptedAt.length === 1) {
      limitedAt = attemptedAt[0];
      assert.equal(typeof releaseUpdate, 'function', 'Telegram long poll is already waiting');
      releaseUpdate();
      throw new ApiError('rate_limit', { code: 429, retryAfterMs });
    }
  };

  f.start();
  await until(() => f.store.offset('telegram') === 51, 'later status command is durably received');
  const command = f.store.db.prepare('SELECT created_at FROM jobs WHERE id=?').get('telegram:50');
  assert.ok(command.created_at >= limitedAt);
  assert.ok(command.created_at < limitedAt + retryAfterMs, 'command is pending before the retry floor expires');
  await until(() => f.store.stats('bale').delivered === 1 && f.store.stats('telegram').notified === 1,
    'both relay content and status recover after the shared floor');
  assert.equal(attemptedAt.length, 3, 'one rejected send, one relay retry, one local status');
  assert.ok(attemptedAt.slice(1).every(time => time >= limitedAt + retryAfterMs),
    'neither the local status nor relay retry may send before retry_after');
  assert.equal(f.apis.telegram.sent.length, 2);
  assert.equal(f.apis.telegram.sent.filter(item => item.step.notice).length, 1);
  assert.ok(f.apis.telegram.sent.every(item => item.chatId === USERS.telegram));
});
