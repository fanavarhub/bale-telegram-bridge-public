import test from 'node:test';
import assert from 'node:assert/strict';
import { BotApi, ApiError } from '../src/api.js';

const TOKEN = '123:private_test_token';
const ok = (result, init) => Response.json({ ok: true, result }, init);
const api = (platform, fetchImpl, overrides = {}) => new BotApi({
  platform, token: TOKEN, fetchImpl, ...overrides,
});

test('polling uses only the official host and preserves offset and subscriptions', async () => {
  for (const [platform, origin] of [['bale', 'https://tapi.bale.ai'], ['telegram', 'https://api.telegram.org']]) {
    const bot = api(platform, async (url, options) => {
      assert.equal(url, `${origin}/bot${TOKEN}/getUpdates`);
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers['content-type'], 'application/json');
      assert.ok(options.signal instanceof AbortSignal);
      assert.deepEqual(JSON.parse(options.body), {
        offset: 104, timeout: 25, limit: 100,
        ...(platform === 'telegram' ? { allowed_updates: ['message', 'edited_message'] } : {}),
      });
      return ok([{ update_id: 104 }]);
    });
    assert.deepEqual(await bot.getUpdates({ offset: 104 }), [{ update_id: 104 }]);
  }
});

test('polling accepts the complete configured 1..50-second interval', async () => {
  for (const timeout of [1, 25, 30, 31, 50]) {
    const bot = api('telegram', async (_url, options) => {
      assert.equal(JSON.parse(options.body).timeout, timeout);
      return ok([]);
    }, { requestTimeoutMs: 65_000 });
    assert.deepEqual(await bot.getUpdates({ timeout }), []);
  }
  const bot = api('bale', async () => { assert.fail('invalid polling timeout must not make a request'); });
  await assert.rejects(bot.getUpdates({ timeout: 51 }), error => error.category === 'permanent');
});

test('fresh getFile is downloaded privately and repeated on each attempt', async () => {
  let requests = 0;
  const bot = api('bale', async (url, options) => {
    requests++;
    if (url.endsWith('/getFile')) {
      assert.deepEqual(JSON.parse(options.body), { file_id: 'source-only-file-id' });
      return ok({ file_path: 'voice/abc.ogg', file_size: 3 });
    }
    assert.equal(url, `https://tapi.bale.ai/file/bot${TOKEN}/voice/abc.ogg`);
    assert.equal(options.method, 'GET');
    return new Response(new Uint8Array([1, 2, 3]));
  });
  const first = await bot.getFileBuffer('source-only-file-id');
  assert.deepEqual(first, { bytes: Buffer.from([1, 2, 3]), filename: 'abc.ogg' });
  await bot.getFileBuffer('source-only-file-id');
  assert.equal(requests, 4);
});

test('uploads actual multipart bytes, fixes target, and adapts replies', async () => {
  for (const platform of ['bale', 'telegram']) {
    const bot = api(platform, async (_url, options) => {
      assert.equal(options.headers, undefined, 'fetch sets the multipart boundary');
      assert.ok(options.body instanceof FormData);
      assert.equal(options.body.get('chat_id'), '22222222');
      assert.equal(options.body.get('business_connection_id'), null);
      assert.equal(options.body.get('message_thread_id'), null);
      if (platform === 'telegram') {
        assert.equal(options.body.get('reply_to_message_id'), null);
        assert.deepEqual(JSON.parse(options.body.get('reply_parameters')), {
          message_id: 23, allow_sending_without_reply: true,
        });
      } else {
        assert.equal(options.body.get('reply_parameters'), null);
        assert.equal(options.body.get('reply_to_message_id'), '23');
      }
      const uploaded = options.body.get('voice');
      assert.equal(uploaded.name, 'صدا.ogg');
      assert.equal(uploaded.type, 'audio/ogg');
      assert.deepEqual(Buffer.from(await uploaded.arrayBuffer()), Buffer.from('real media'));
      return ok({ message_id: 88 });
    });
    assert.deepEqual(await bot.send({
      method: 'sendVoice',
      params: { chat_id: 'attacker', reply_to_message_id: 9, reply_parameters: { message_id: 9 },
        business_connection_id: 'untrusted', message_thread_id: 888, voice: 'untrusted-file-id' },
      file: { field: 'voice', fileId: 'foreign-file-id', mimeType: 'audio/ogg' },
    }, { chatId: '22222222', replyToId: 23, bytes: Buffer.from('real media'), filename: 'صدا.ogg' }),
    { message_id: 88 });
  }
});

test('file safety rejects absolute paths, encoded traversal and redirects', async () => {
  for (const file_path of ['https://evil.example/x', '//evil/x', '/root/x', '../x', 'a/../x',
    'a/./x', 'a/%2e%2e/x', 'a\\x', 'a/x?token=bad', 'a//x', 'a/\ud800']) {
    let requests = 0;
    const bot = api('telegram', async () => { requests++; return ok({ file_path }); });
    await assert.rejects(bot.getFileBuffer('file-id'), error => error.category === 'permanent');
    assert.equal(requests, 1, file_path);
  }
  const redirected = api('telegram', async () => new Response('', {
    status: 302, headers: { location: 'https://evil.example' },
  }));
  await assert.rejects(redirected.call('getMe'), error => error.category === 'permanent');
  const leakedRedirect = api('telegram', async url => {
    if (url.endsWith('/getFile')) return ok({ file_path: 'safe/path.bin' });
    const response = new Response('remote bytes');
    Object.defineProperty(response, 'url', { value: 'https://evil.example/path.bin' });
    return response;
  });
  await assert.rejects(leakedRedirect.getFileBuffer('id'), error => error.category === 'permanent');
});

test('metadata size, content-length, and streamed cumulative size each enforce the cap', async () => {
  let requests = 0;
  const metadata = api('telegram', async () => {
    requests++; return ok({ file_path: 'a.bin', file_size: 5 });
  }, { maxFileBytes: 4 });
  await assert.rejects(metadata.getFileBuffer('id'), error => error.category === 'file_too_large');
  assert.equal(requests, 1);
  for (const declared of [true, false]) {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      },
    });
    const bot = api('bale', async url => url.endsWith('/getFile')
      ? ok({ file_path: 'a.bin' })
      : new Response(body, declared ? { headers: { 'content-length': '6' } } : {}), { maxFileBytes: 4 });
    await assert.rejects(bot.getFileBuffer('id'), error => error.category === 'file_too_large');
  }
});

test('API errors are classified and do not expose secrets or remote error text', async () => {
  for (const [status, category, permanent] of [
    [400, 'permanent', true], [401, 'auth', true], [403, 'permanent', true],
    [409, 'conflict', true], [429, 'rate_limit', false], [503, 'transient', false],
  ]) {
    const bot = api('telegram', async () => Response.json({
      ok: false, error_code: status, description: `DANGEROUS ${TOKEN}`,
      parameters: { retry_after: 17 },
    }, { status }));
    await assert.rejects(bot.call('getMe'), error => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.category, category);
      assert.equal(error.permanent, permanent);
      assert.equal(error.code, status);
      assert.equal(error.retryAfterMs, 17_000);
      assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, /private_test_token|DANGEROUS|api\.telegram/);
      return true;
    });
  }
  const broken = api('telegram', async () => { throw new Error(`Failed at token ${TOKEN}`); });
  await assert.rejects(broken.call('getMe'), error => error.category === 'network'
    && !`${error.stack} ${JSON.stringify(error)}`.includes(TOKEN));
});

test('HTTP 200 API errors and HTTP retry-after headers are honored', async () => {
  const logical = api('bale', async () => Response.json({
    ok: false, error_code: 429, parameters: { retry_after: 2.5 },
  }));
  await assert.rejects(logical.call('getMe'), error => error.category === 'rate_limit' && error.retryAfterMs === 2500);
  const header = api('telegram', async () => new Response('unparseable', {
    status: 429, headers: { 'retry-after': '19' },
  }));
  await assert.rejects(header.call('getMe'), error => error.category === 'rate_limit' && error.retryAfterMs === 19_000);
  const both = api('telegram', async () => Response.json({
    ok: false, error_code: 429, parameters: { retry_after: 5 },
  }, { status: 429, headers: { 'retry-after': '23' } }));
  await assert.rejects(both.call('getMe'), error => error.retryAfterMs === 23_000);
});

test('bounds JSON responses, rejects malformed results, and prevents method injection', async () => {
  const oversized = api('telegram', async () => new Response('x', {
    headers: { 'content-length': String(4 * 1024 * 1024 + 1) },
  }));
  await assert.rejects(oversized.call('getMe'), error => error.category === 'transient');
  const malformed = api('telegram', async () => ok({ not: 'an array' }));
  await assert.rejects(malformed.getUpdates(), error => error.category === 'transient');
  await assert.rejects(malformed.call('../evil'), error => error.category === 'permanent');
  await assert.rejects(malformed.send({ method: 'forwardMessage' }, { chatId: 1 }),
    error => error.category === 'permanent');
  await assert.rejects(malformed.send({ method: 'sendPhoto', file: { field: 'photo' } }, { chatId: 1 }),
    error => error.category === 'permanent');
});

test('JSON text sends preserve user text without applying markup', async () => {
  const bot = api('telegram', async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), { text: '<b>سلام 😀</b>', chat_id: '22222222' });
    return ok({ message_id: 4 });
  });
  await bot.send({ method: 'sendMessage', params: { text: '<b>سلام 😀</b>', chat_id: -123 } },
    { chatId: 22222222 });
});

test('multipart filenames and MIME headers cannot inject extra fields', async () => {
  const bot = api('bale', async (url, options) => {
    assert.equal(url, `https://tapi.bale.ai/bot${TOKEN}/sendDocument`);
    const file = options.body.get('document');
    assert.equal(file.type, 'application/octet-stream');
    assert.equal(file.name, 'private__X-Header_ injected_.txt');
    const request = new Request(url, options);
    const encoded = Buffer.from(await request.arrayBuffer()).toString('utf8');
    assert.match(request.headers.get('content-type'), /^multipart\/form-data; boundary=/);
    assert.doesNotMatch(encoded, /\r\nX-Header: injected/);
    assert.equal(options.body.get('chat_id'), '11111111');
    return ok({ message_id: 10 });
  });
  await bot.send({ method: 'sendDocument', file: {
    field: 'document', filename: '../private\r\nX-Header: injected".txt',
    mimeType: 'text/plain\r\nX-Header: injected',
  } }, { chatId: 11111111, bytes: Buffer.from('data') });
});

test('malformed responses and stream failures expose only generic safe errors', async () => {
  const badJson = api('telegram', async () => new Response(`{${TOKEN}`));
  await assert.rejects(badJson.call('getMe'), error => error.category === 'transient'
    && !`${error.stack} ${JSON.stringify(error)}`.includes(TOKEN));
  const brokenStream = api('telegram', async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error(`read failed ${TOKEN}`)); },
  })));
  await assert.rejects(brokenStream.call('getMe'), error => error.category === 'network'
    && !`${error.stack} ${JSON.stringify(error)}`.includes(TOKEN));
  const unsafeId = api('telegram', async () => assert.fail('unsafe IDs must be rejected locally'));
  await assert.rejects(unsafeId.send({ method: 'sendMessage', params: { text: 'x' } },
    { chatId: 1, replyToId: '9007199254740993' }), error => error.category === 'permanent');
});
