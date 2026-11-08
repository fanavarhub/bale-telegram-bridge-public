import { loadConfig, PLATFORMS } from './config.js';
import { Store } from './store.js';
import { BotApi } from './api.js';
import { runBridge, log } from './runtime.js';

process.umask(0o077);
const shutdown = new AbortController();
process.once('SIGTERM', () => shutdown.abort());
process.once('SIGINT', () => shutdown.abort());
let store;
try {
  const config = loadConfig();
  store = new Store(config);
  const apis = Object.fromEntries(PLATFORMS.map(platform => [platform, new BotApi({ platform, token: config.tokens[platform], maxFileBytes: config.maxFileBytes, requestTimeoutMs: (config.pollTimeout + 15) * 1000 })]));
  log('bridge_starting');
  await runBridge({ config, store, apis, signal: shutdown.signal });
  log('bridge_stopped');
} catch (error) {
  const known = typeof error.code === 'string' && /^[a-z_]{1,70}$/.test(error.code);
  log('bridge_fatal', { code: known ? error.code : error.category || 'configuration_or_storage_error' });
  // Configuration errors contain only key names, never values. All other
  // exceptions are reduced to categories, including fetch errors with URLs.
  if (!store) console.error('Check local .env, encryption key and data directory permissions.');
  process.exitCode = 1;
} finally {
  store?.close();
}
