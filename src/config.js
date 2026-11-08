import { resolve } from 'node:path';

export const PLATFORMS = Object.freeze(['bale', 'telegram']);

function integer(env, name, fallback, min, max) {
  const value = env[name] === undefined || env[name] === '' ? fallback : Number(env[name]);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

export function loadConfig(env = process.env) {
  const tokens = {};
  const users = {};
  const botNames = {};
  for (const platform of PLATFORMS) {
    const prefix = platform.toUpperCase();
    const name = `${prefix}_BOT_TOKEN`;
    const token = env[name]?.trim();
    if (!token || !/^[A-Za-z0-9:_-]{10,256}$/.test(token)) throw new Error(`Set ${name} locally`);
    tokens[platform] = token;
    const userKey = `${prefix}_ALLOWED_USER_ID`;
    if (typeof env[userKey] !== 'string' || !/^[1-9]\d*$/.test(env[userKey].trim())) throw new Error(`Set ${userKey} locally`);
    users[platform] = integer(env, userKey, undefined, 1, Number.MAX_SAFE_INTEGER);
    const botKey = `${prefix}_BOT_USERNAME`;
    const username = env[botKey]?.trim().replace(/^@/, '') ?? '';
    if (!/^[A-Za-z][A-Za-z0-9_]{4,63}$/.test(username)) throw new Error(`Set ${botKey} locally`);
    botNames[platform] = username;
  }
  const text = env.DATA_ENCRYPTION_KEY?.trim() ?? '';
  if (!/^[A-Za-z0-9+/]{43}=$/.test(text)) throw new Error('Set DATA_ENCRYPTION_KEY to a base64-encoded 32-byte key');
  const key = Buffer.from(text, 'base64');
  if (key.length !== 32 || key.toString('base64') !== text) throw new Error('Invalid DATA_ENCRYPTION_KEY');
  if (env.REMOVE_EXISTING_WEBHOOK && !['true', 'false'].includes(env.REMOVE_EXISTING_WEBHOOK)) throw new Error('Invalid REMOVE_EXISTING_WEBHOOK');
  return Object.freeze({
    tokens: Object.freeze(tokens), key,
    users: Object.freeze(users), botNames: Object.freeze(botNames),
    chatIds: Object.freeze({ bale: integer(env, 'BALE_PRIVATE_CHAT_ID', users.bale, 1, Number.MAX_SAFE_INTEGER), telegram: users.telegram }),
    dataDir: resolve(env.DATA_DIR || './data'),
    pollTimeout: integer(env, 'POLL_TIMEOUT_SECONDS', 25, 1, 50),
    maxFileBytes: integer(env, 'MAX_FILE_MIB', 20, 1, 20) * 1024 * 1024,
    maxPendingJobs: integer(env, 'MAX_PENDING_JOBS', 1000, 10, 100000),
    retentionMs: integer(env, 'METADATA_RETENTION_DAYS', 7, 1, 365) * 86400000,
    sendIntervalMs: integer(env, 'SEND_INTERVAL_MS', 1100, 1000, 60000),
    removeWebhook: env.REMOVE_EXISTING_WEBHOOK === 'true',
  });
}
