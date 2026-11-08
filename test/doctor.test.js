import test from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor } from '../src/doctor.js';
import { ApiError } from '../src/api.js';

const PRIVATE_WEBHOOK = 'https://private.invalid/do-not-log-this-credential';

async function diagnose({ webhooks = { bale: '', telegram: '' }, removeWebhook = false, mismatchedBot, apiErrors = {}, args = ['--samples=1'] } = {}) {
  const calls = [];
  const lines = [];
  const errors = [];
  const status = await runDoctor(args, {
    configLoader: () => ({ botNames: { bale: 'example_bale', telegram: 'example_telegram' }, removeWebhook }),
    publicProbe: async platform => ({ platform, publicReachable: true }),
    apiFactory: platform => ({
      async call(method) {
        calls.push({ platform, method });
        if (apiErrors[platform]) throw apiErrors[platform];
        if (method === 'getMe') return { id: 12345, is_bot: true, username: platform === mismatchedBot ? 'wrong_bot' : `example_${platform}` };
        if (method === 'getWebhookInfo') return { url: webhooks[platform] };
        assert.fail(`Unexpected API mutation or polling: ${method}`);
      },
    }),
    output: line => lines.push(line),
    errorOutput: line => errors.push(line),
  });
  return { status, calls, lines, errors, results: JSON.parse(lines[0]).results };
}

for (const platform of ['bale', 'telegram']) {
  test(`doctor fails preflight for an existing ${platform} webhook without removal permission`, async () => {
    const result = await diagnose({ webhooks: { bale: '', telegram: '', [platform]: PRIVATE_WEBHOOK } });
    assert.equal(result.status, 1);
    const blocked = result.results.find(row => row.platform === platform);
    assert.equal(blocked.botMatches, true);
    assert.equal(blocked.webhookConfigured, true);
    assert.equal(blocked.pollingReady, false);
    assert.match(blocked.pollingNote, new RegExp(platform, 'i'));
    assert.match(blocked.pollingNote, /REMOVE_EXISTING_WEBHOOK=true/);
    assert.match(blocked.pollingNote, /local \.env/);
    assert.equal(result.lines.join('').includes(PRIVATE_WEBHOOK), false);
    assert.equal(result.errors.length, 0);
    assert.deepEqual(result.calls.filter(call => call.platform === platform).map(call => call.method), ['getMe', 'getWebhookInfo']);
  });
}

test('doctor allows authorized removal at startup while leaving both webhooks unchanged', async () => {
  const result = await diagnose({ webhooks: { bale: PRIVATE_WEBHOOK, telegram: PRIVATE_WEBHOOK }, removeWebhook: true });
  assert.equal(result.status, 0);
  for (const row of result.results) {
    assert.equal(row.webhookConfigured, true);
    assert.equal(row.pollingReady, true);
    assert.match(row.pollingNote, /removal at bridge startup/);
    assert.match(row.pollingNote, /diagnostic leaves the webhook unchanged/);
    assert.deepEqual(result.calls.filter(call => call.platform === row.platform).map(call => call.method), ['getMe', 'getWebhookInfo']);
  }
  assert.equal(result.lines.join('').includes(PRIVATE_WEBHOOK), false);
});

test('doctor passes polling readiness without webhooks and without enabling removal', async () => {
  const result = await diagnose();
  assert.equal(result.status, 0);
  assert.ok(result.results.every(row => row.pollingReady === true && row.webhookConfigured === false));
  assert.ok(result.results.every(row => row.pollingNote === undefined));
});

test('removal permission does not bypass a mismatched bot identity', async () => {
  const result = await diagnose({ webhooks: { bale: '', telegram: PRIVATE_WEBHOOK }, removeWebhook: true, mismatchedBot: 'telegram' });
  assert.equal(result.status, 1);
  const telegram = result.results.find(row => row.platform === 'telegram');
  assert.equal(telegram.botMatches, false);
  assert.equal(telegram.pollingReady, false);
});

test('an invalid webhook response fails without reporting private response contents', async () => {
  const result = await diagnose({ webhooks: { bale: '', telegram: { secret: PRIVATE_WEBHOOK } } });
  assert.equal(result.status, 1);
  assert.equal(result.results.find(row => row.platform === 'telegram').apiOrMediaError, 'validation_failed');
  assert.equal(result.lines.join('').includes(PRIVATE_WEBHOOK), false);
});

test('public-only diagnostics never load credentials or create bot clients', async () => {
  const lines = [];
  const status = await runDoctor(['--public', '--samples=1'], {
    configLoader: () => assert.fail('public checks must not load credentials'),
    apiFactory: () => assert.fail('public checks must not access bots'),
    publicProbe: async platform => ({ platform, publicReachable: true }),
    output: line => lines.push(line),
  });
  assert.equal(status, 0);
  assert.ok(JSON.parse(lines[0]).results.every(row => row.pollingReady === undefined));
});

test('doctor reports only allowlisted API network codes without raw transport causes', async () => {
  const error = new ApiError('network', { networkCode: 'UND_ERR_CONNECT_TIMEOUT' });
  const result = await diagnose({ apiErrors: { telegram: error } });
  assert.equal(result.status, 1);
  const telegram = result.results.find(row => row.platform === 'telegram');
  assert.equal(telegram.apiOrMediaError, 'network');
  assert.equal(telegram.apiNetworkCode, 'UND_ERR_CONNECT_TIMEOUT');
  assert.equal(telegram.pollingReady, undefined);
  assert.equal(result.lines.join('').includes(PRIVATE_WEBHOOK), false);
  assert.equal(result.errors.length, 0);
});

test('doctor suppresses unknown API network codes and unrelated error properties', async () => {
  const error = new ApiError('network');
  error.networkCode = PRIVATE_WEBHOOK;
  error.cause = new Error(PRIVATE_WEBHOOK);
  const result = await diagnose({ apiErrors: { telegram: error } });
  const telegram = result.results.find(row => row.platform === 'telegram');
  assert.equal(result.status, 1);
  assert.equal(telegram.apiOrMediaError, 'network');
  assert.equal(telegram.apiNetworkCode, undefined);
  assert.equal(result.lines.join('').includes(PRIVATE_WEBHOOK), false);
  const http = await diagnose({ apiErrors: { telegram: new ApiError('auth', { code: 401 }) } });
  assert.equal(http.results.find(row => row.platform === 'telegram').apiNetworkCode, undefined);
});

test('public-only doctor output preserves distinct DNS, TCP/TLS and HTTP failure stages', async () => {
  for (const stage of ['dns', 'tcp_tls', 'http']) {
    const lines = [];
    const status = await runDoctor(['--public', '--samples=1'], {
      configLoader: () => assert.fail('public checks must not load credentials'),
      apiFactory: () => assert.fail('public checks must not access bots'),
      publicProbe: async platform => ({ platform, publicReachable: false,
        error: 'dns_tls_or_http_failed', stage, errorCode: 'ECONNRESET' }),
      output: line => lines.push(line),
    });
    assert.equal(status, 1);
    assert.ok(JSON.parse(lines[0]).results.every(row => row.stage === stage && row.errorCode === 'ECONNRESET'));
    assert.equal(JSON.parse(lines[1]).publicOnly, true);
    assert.equal(lines.join('').includes(PRIVATE_WEBHOOK), false);
  }
});
