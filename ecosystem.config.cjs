const path = require('node:path');

module.exports = {
  apps: [{
    name: 'bale-telegram-bridge',
    cwd: __dirname,
    script: path.join(__dirname, 'src', 'main.js'),
    interpreter: process.execPath,
    node_args: [`--env-file=${path.join(__dirname, '.env')}`],
    exec_mode: 'fork',
    instances: 1,
    watch: false,
    autorestart: true,
    restart_delay: 5000,
    min_uptime: 10000,
    max_restarts: 15,
    kill_timeout: 15000,
    time: false,
    // Read secrets in the child through Node's .env support, never in this file
    // or PM2's saved process environment. Filter stale inherited values too.
    filter_env: ['BALE_', 'TELEGRAM_', 'DATA_ENCRYPTION_KEY', 'DATA_DIR',
      'POLL_TIMEOUT_SECONDS', 'MAX_FILE_MIB', 'MAX_PENDING_JOBS',
      'METADATA_RETENTION_DAYS', 'SEND_INTERVAL_MS', 'REMOVE_EXISTING_WEBHOOK'],
    env: { NODE_ENV: 'production' },
  }],
};
