const HOSTS = Object.freeze({
  bale: 'https://tapi.bale.ai',
  telegram: 'https://api.telegram.org',
});

const FILE_FIELDS = Object.freeze({
  sendPhoto: 'photo',
  sendAudio: 'audio',
  sendDocument: 'document',
  sendVideo: 'video',
  sendAnimation: 'animation',
  sendVoice: 'voice',
  sendSticker: 'sticker',
  sendVideoNote: 'video_note',
});

const SEND_METHODS = new Set([
  'sendMessage', ...Object.keys(FILE_FIELDS), 'sendLocation', 'sendVenue', 'sendContact',
]);
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MESSAGES = Object.freeze({
  network: 'The service connection failed or timed out.',
  rate_limit: 'The service requested a later retry.',
  auth: 'The bot credentials were rejected.',
  conflict: 'Another update receiver or webhook conflicts with this process.',
  permanent: 'The service rejected this operation.',
  transient: 'The service is temporarily unavailable or returned an invalid response.',
  file_too_large: 'The file exceeds the configured transfer size limit.',
});

/** Deliberately excludes remote descriptions, URLs, tokens and raw causes. */
export class ApiError extends Error {
  constructor(category, { code = null, retryAfterMs = 0 } = {}) {
    super(MESSAGES[category] ?? MESSAGES.transient);
    this.name = 'ApiError';
    this.category = Object.hasOwn(MESSAGES, category) ? category : 'transient';
    this.code = Number.isSafeInteger(code) ? code : null;
    this.permanent = ['auth', 'conflict', 'permanent', 'file_too_large'].includes(this.category);
    this.retryAfterMs = Number.isFinite(retryAfterMs) && retryAfterMs >= 0
      ? Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(retryAfterMs)) : 0;
  }
}

function errorFor(code, retryAfterMs = 0) {
  const category = code === 429 ? 'rate_limit'
    : code === 401 ? 'auth'
      : code === 409 ? 'conflict'
        : code >= 500 || code === 408 ? 'transient' : 'permanent';
  return new ApiError(category, { code, retryAfterMs });
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function positiveId(value) {
  return /^[1-9]\d*$/.test(String(value)) && positiveInteger(Number(value));
}

function safeFilename(value, fallback = 'media.bin') {
  if (typeof value !== 'string') return fallback;
  const leaf = value.split(/[\\/]/).at(-1)
    .replace(/[\u0000-\u001f\u007f"<>:|?*]/g, '_').trim().slice(0, 200);
  return leaf && leaf !== '.' && leaf !== '..' ? leaf : fallback;
}

function filePathSegments(value) {
  if (typeof value !== 'string' || !value || value.length > 2048
      || /[\\%\s\u0000-\u001f\u007f?#:]/u.test(value) || value.startsWith('/')) {
    throw new ApiError('permanent');
  }
  const segments = value.split('/');
  if (segments.some(part => !part || part === '.' || part === '..')) {
    throw new ApiError('permanent');
  }
  return segments;
}

function retryDelay(response, body) {
  const seconds = Number(body?.parameters?.retry_after);
  const header = response.headers?.get('retry-after');
  const headerSeconds = Number(header);
  const headerDate = header && !Number.isFinite(headerSeconds) ? Date.parse(header) : NaN;
  const fromBody = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  const fromHeader = Number.isFinite(headerSeconds) && headerSeconds > 0 ? headerSeconds * 1000
    : Number.isFinite(headerDate) ? Math.max(0, headerDate - Date.now()) : 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(Math.max(fromBody, fromHeader)));
}

async function readBounded(response, limit, category) {
  const declared = response.headers?.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
    try { await response.body?.cancel(); } catch { /* No remote error is exposed. */ }
    throw new ApiError(category);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  let total = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        try { await reader.cancel(); } catch { /* Preserve the safe size error. */ }
        throw new ApiError(category);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('network');
  } finally {
    reader.releaseLock();
  }
}

/** Fixed official hosts: no arbitrary upstream URL, proxy or local-file adapter. */
export class BotApi {
  #token;
  #origin;
  #fetchImpl;
  #requestTimeoutMs;
  #downloadTimeoutMs;
  #uploadTimeoutMs;

  constructor({
    platform,
    token,
    maxFileBytes = 20 * 1024 * 1024,
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = 40_000,
    downloadTimeoutMs = 90_000,
    uploadTimeoutMs = 90_000,
  } = {}) {
    if (!Object.hasOwn(HOSTS, platform) || typeof token !== 'string'
        || !/^[A-Za-z0-9:_-]{1,512}$/.test(token) || typeof fetchImpl !== 'function'
        || ![maxFileBytes, requestTimeoutMs, downloadTimeoutMs, uploadTimeoutMs].every(positiveInteger)) {
      throw new ApiError('permanent');
    }
    this.platform = platform;
    this.maxFileBytes = maxFileBytes;
    this.#token = token;
    this.#origin = HOSTS[platform];
    this.#fetchImpl = fetchImpl;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#downloadTimeoutMs = downloadTimeoutMs;
    this.#uploadTimeoutMs = uploadTimeoutMs;
  }

  #url(method) {
    if (typeof method !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(method)) {
      throw new ApiError('permanent');
    }
    return `${this.#origin}/bot${this.#token}/${method}`;
  }

  async #request(url, init, timeoutMs, signal) {
    try {
      const combined = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      const response = await this.#fetchImpl(url, {
        ...init, redirect: 'manual', signal: combined,
      });
      if ((response.status >= 300 && response.status < 400) || response.redirected
          || (response.url && response.url !== url)) {
        try { await response.body?.cancel(); } catch { /* Ignore unsafe remote metadata. */ }
        throw new ApiError('permanent', { code: response.status });
      }
      return response;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('network');
    }
  }

  async #json(url, init, timeoutMs, signal) {
    const response = await this.#request(url, init, timeoutMs, signal);
    let body;
    try {
      const bytes = await readBounded(response, MAX_JSON_BYTES, 'transient');
      body = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      if (!response.ok) throw errorFor(response.status, retryDelay(response));
      if (error instanceof ApiError) throw error;
      throw new ApiError('transient', { code: 502 });
    }
    if (!response.ok || body?.ok !== true) {
      const code = !response.ok ? response.status
        : Number.isSafeInteger(body?.error_code) && body.error_code >= 400 && body.error_code <= 599
          ? body.error_code : 502;
      throw errorFor(code, retryDelay(response, body));
    }
    if (!Object.hasOwn(body, 'result')) throw new ApiError('transient', { code: 502 });
    return body.result;
  }

  async call(method, params = {}, { signal } = {}) {
    let body;
    try { body = JSON.stringify(params); } catch { throw new ApiError('permanent'); }
    return this.#json(this.#url(method), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    }, this.#requestTimeoutMs, signal);
  }

  async getUpdates({ offset, timeout = 25, signal } = {}) {
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 50
        || offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) {
      throw new ApiError('permanent');
    }
    const result = await this.call('getUpdates', {
      ...(offset === undefined ? {} : { offset }),
      timeout,
      limit: 100,
      ...(this.platform === 'telegram' ? { allowed_updates: ['message', 'edited_message'] } : {}),
    }, { signal });
    if (!Array.isArray(result)) throw new ApiError('transient', { code: 502 });
    return result;
  }

  async getFileBuffer(fileId, { signal } = {}) {
    if (typeof fileId !== 'string' || !fileId || fileId.length > 4096) {
      throw new ApiError('permanent');
    }
    // Refresh getFile for every attempt; cached download links may have expired.
    const info = await this.call('getFile', { file_id: fileId }, { signal });
    if (Number(info?.file_size) > this.maxFileBytes) throw new ApiError('file_too_large');
    const segments = filePathSegments(info?.file_path);
    let path;
    try { path = segments.map(encodeURIComponent).join('/'); }
    catch { throw new ApiError('permanent'); }
    const url = `${this.#origin}/file/bot${this.#token}/${path}`;
    const response = await this.#request(url, { method: 'GET' }, this.#downloadTimeoutMs, signal);
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* No remote error is exposed. */ }
      throw errorFor(response.status, retryDelay(response));
    }
    const bytes = await readBounded(response, this.maxFileBytes, 'file_too_large');
    return { bytes, filename: safeFilename(segments.at(-1)) };
  }

  async send(step, { chatId, replyToId, bytes, filename, signal } = {}) {
    if (!step || !SEND_METHODS.has(step.method)
        || !positiveId(chatId)
        || replyToId !== undefined && !positiveId(replyToId)) {
      throw new ApiError('permanent');
    }
    const params = { ...(step.params ?? {}) };
    // These fields must never redirect delivery or impersonate another context.
    for (const field of ['chat_id', 'reply_to_message_id', 'reply_parameters', 'business_connection_id',
      'message_thread_id', 'direct_messages_topic_id', 'ephemeral_message_parameters']) delete params[field];
    params.chat_id = String(chatId);
    if (replyToId !== undefined) {
      if (this.platform === 'telegram') {
        params.reply_parameters = { message_id: Number(replyToId), allow_sending_without_reply: true };
      } else {
        params.reply_to_message_id = Number(replyToId);
      }
    }
    const fileField = FILE_FIELDS[step.method];
    if (!fileField) {
      if (step.file) throw new ApiError('permanent');
      return this.call(step.method, params, { signal });
    }
    if (!step.file || step.file.field !== fileField
        || !(bytes instanceof Uint8Array) || !bytes.byteLength) {
      throw new ApiError('permanent');
    }
    if (bytes.byteLength > this.maxFileBytes) throw new ApiError('file_too_large');
    delete params[fileField];
    const form = new FormData();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
      }
    }
    const mime = typeof step.file.mimeType === 'string'
      && /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(step.file.mimeType)
      ? step.file.mimeType : 'application/octet-stream';
    form.append(fileField, new Blob([bytes], { type: mime }),
      safeFilename(filename ?? step.file.filename));
    return this.#json(this.#url(step.method), { method: 'POST', body: form }, this.#uploadTimeoutMs, signal);
  }
}
