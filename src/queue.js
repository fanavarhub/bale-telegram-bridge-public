import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { Store } from './store.js';

process.umask(0o077);
let store;
try {
  const config = loadConfig();
  store = new Store(config);
  const [command = 'status', filename] = process.argv.slice(2);
  if (command === 'status' && !filename) console.log(JSON.stringify(store.health(), null, 2));
  else if (command === 'backup' && filename) {
    store.backup(resolve(filename));
    console.log('Encrypted database snapshot created. Keep its encryption key separately and securely.');
  } else throw new Error('invalid_argument');
} catch {
  console.error('Check local config and permissions. Usage: npm run queue -- [status | backup ./backup.sqlite]. Backup destination must not already exist.');
  process.exitCode = 1;
} finally { store?.close(); }
