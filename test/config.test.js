import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { commandPlan, retryDelay, intakeEntries } from '../src/runtime.js';

// Synthetic fixtures only. No personal defaults belong in the public source.
const env = () => ({
  BALE_BOT_TOKEN: '123456789:test-value', TELEGRAM_BOT_TOKEN: '123456789:test-value',
  BALE_ALLOWED_USER_ID: '11111111', TELEGRAM_ALLOWED_USER_ID: '22222222',
  BALE_BOT_USERNAME: 'ExampleBaleBot', TELEGRAM_BOT_USERNAME: 'ExampleTelegramBot',
  DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
});
test('config requires two local identities and valid secrets, then freezes the allowlist', () => {
  const config = loadConfig(env());
  assert.deepEqual(config.users, { bale: 11111111, telegram: 22222222 });
  assert.deepEqual(config.botNames, { bale: 'ExampleBaleBot', telegram: 'ExampleTelegramBot' });
  assert.deepEqual(config.chatIds, config.users);
  for (const value of [config, config.users, config.botNames, config.chatIds, config.tokens]) assert.ok(Object.isFrozen(value));
  assert.throws(() => { config.users.bale = 999; }, TypeError);
  assert.equal(config.maxFileBytes, 20 * 1024 * 1024);
  assert.throws(() => loadConfig({ ...env(), DATA_ENCRYPTION_KEY: 'invalid' }), /DATA_ENCRYPTION_KEY/);
  assert.throws(() => loadConfig({ ...env(), MAX_FILE_MIB: '100' }));
  assert.throws(() => loadConfig({ ...env(), SEND_INTERVAL_MS: '1' }));
  assert.throws(() => loadConfig({ ...env(), REMOVE_EXISTING_WEBHOOK: 'yes' }));
});
test('missing local identities never fall back to a shipped account or bot', () => {
  for (const key of ['BALE_ALLOWED_USER_ID', 'TELEGRAM_ALLOWED_USER_ID', 'BALE_BOT_USERNAME', 'TELEGRAM_BOT_USERNAME']) {
    const values = env(); delete values[key];
    assert.throws(() => loadConfig(values), new RegExp(key));
    assert.throws(() => loadConfig({ ...env(), [key]: '' }), new RegExp(key));
  }
});
test('user IDs are positive safe decimal integers and bot names are normalized locally', () => {
  for (const value of ['0', '-1', '1.5', '1e3', '9007199254740992', 'not-an-id']) {
    assert.throws(() => loadConfig({ ...env(), BALE_ALLOWED_USER_ID: value }), /BALE_ALLOWED_USER_ID/);
  }
  for (const value of ['@@ExampleBot', 'name/other', 'bad name', 'abcd', 'x'.repeat(65)]) {
    assert.throws(() => loadConfig({ ...env(), TELEGRAM_BOT_USERNAME: value }), /TELEGRAM_BOT_USERNAME/);
  }
  assert.equal(loadConfig({ ...env(), BALE_BOT_USERNAME: ' @ExampleBaleBot ' }).botNames.bale, 'ExampleBaleBot');
});
test('backoff is bounded and retry_after is a lower bound', () => {
  assert.equal(retryDelay(20, 0, () => 1), 60000);
  assert.equal(retryDelay(20, 120000, () => 0), 120000);
  assert.equal(retryDelay(0, 0, () => 0), 500);
});
test('bot commands remain source-only while normal text is relayed', () => {
  assert.equal(commandPlan('bale', { text: 'سلام' }, {}), null);
  assert.equal(commandPlan('bale', { text: '/start@someone_else' }, {}), null);
  assert.equal(commandPlan('bale', { text: '/start@ExampleBaleBot' }, {}, { botName: 'ExampleBaleBot' })[0].notice, true);
  assert.equal(commandPlan('bale', { text: '/start@ExampleBaleBot' }, {}), null);
  const status = commandPlan('telegram', { text: '/status' }, { received: 2, ready: 3 });
  assert.equal(status[0].notice, true);
  assert.match(status[0].params.text, /5/);
});
test('a separately pinned Bale private chat never changes the immutable allowed user', () => {
  const config = loadConfig({ ...env(), BALE_PRIVATE_CHAT_ID: '889900' });
  const message = { message_id: 7, from: { id: 11111111, is_bot: false }, chat: { id: 889900, type: 'private' }, text: 'سلام' };
  assert.equal(intakeEntries('bale', [{ update_id: 9, message }])[0].payload, null);
  const identity = { userId: config.users.bale, chatId: config.chatIds.bale };
  assert.ok(intakeEntries('bale', [{ update_id: 9, message }], identity)[0].payload);
  assert.equal(intakeEntries('bale', [{ update_id: 9, message: { ...message, from: { id: 999 } } }], identity)[0].payload, null);
  assert.throws(() => loadConfig({ ...env(), BALE_PRIVATE_CHAT_ID: '-1' }));
});
