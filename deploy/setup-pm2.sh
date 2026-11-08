#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

bridge_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$bridge_dir"

command -v node >/dev/null || { printf '%s\n' 'Install Node.js 24+ first.' >&2; exit 1; }
command -v pm2 >/dev/null || { printf '%s\n' 'Install PM2 for the current user first: npm install -g pm2' >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)' || { printf '%s\n' 'Node.js 24+ is required.' >&2; exit 1; }

# Tests are isolated and do not connect to either bot.
npm test

if [[ -L .env ]]; then
  printf '%s\n' 'Refusing a symbolic-link .env; inspect local configuration manually.' >&2
  exit 1
fi

if [[ ! -e .env ]]; then
  if [[ -e data/bridge.sqlite ]]; then
    printf '%s\n' 'A database exists without .env. Restore the original encryption key; do not generate another key.' >&2
    exit 1
  fi
  printf '%s\n' 'Enter bot tokens and the two allowed identities locally. All input is hidden and is not sent to GitHub.'
  IFS= read -r -s -p 'Bale bot token: ' bale_token </dev/tty
  printf '\n' >/dev/tty
  IFS= read -r -s -p 'Telegram bot token: ' telegram_token </dev/tty
  printf '\n' >/dev/tty
  IFS= read -r -s -p 'Allowed Bale human user ID: ' bale_user_id </dev/tty
  printf '\n' >/dev/tty
  IFS= read -r -s -p 'Allowed Telegram human user ID: ' telegram_user_id </dev/tty
  printf '\n' >/dev/tty
  IFS= read -r -s -p 'Expected Bale bot username: ' bale_username </dev/tty
  printf '\n' >/dev/tty
  IFS= read -r -s -p 'Expected Telegram bot username: ' telegram_username </dev/tty
  printf '\n' >/dev/tty
  bale_username="${bale_username#@}"
  telegram_username="${telegram_username#@}"
  if [[ ! "$bale_token" =~ ^[A-Za-z0-9:_-]{10,256}$ || ! "$telegram_token" =~ ^[A-Za-z0-9:_-]{10,256}$ ]]; then
    printf '%s\n' 'Invalid token format; no configuration was written.' >&2
    exit 1
  fi
  valid_user_id() {
    [[ "$1" =~ ^[1-9][0-9]{0,15}$ ]] && (( 10#$1 <= 9007199254740991 ))
  }
  if ! valid_user_id "$bale_user_id" || ! valid_user_id "$telegram_user_id"; then
    printf '%s\n' 'User IDs must be positive safe integers; no configuration was written.' >&2
    exit 1
  fi
  if [[ ! "$bale_username" =~ ^[A-Za-z][A-Za-z0-9_]{4,63}$ || ! "$telegram_username" =~ ^[A-Za-z][A-Za-z0-9_]{4,63}$ ]]; then
    printf '%s\n' 'Invalid bot username format; no configuration was written.' >&2
    exit 1
  fi
  encryption_key="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))')"
  temporary_env="$(mktemp "$bridge_dir/.env.XXXXXX")"
  trap 'if [[ -n "${temporary_env:-}" && -f "$temporary_env" ]]; then rm -- "$temporary_env"; fi' EXIT
  {
    printf 'BALE_BOT_TOKEN=%s\n' "$bale_token"
    printf 'TELEGRAM_BOT_TOKEN=%s\n' "$telegram_token"
    printf 'BALE_ALLOWED_USER_ID=%s\n' "$bale_user_id"
    printf 'TELEGRAM_ALLOWED_USER_ID=%s\n' "$telegram_user_id"
    printf 'BALE_BOT_USERNAME=%s\n' "$bale_username"
    printf 'TELEGRAM_BOT_USERNAME=%s\n' "$telegram_username"
    printf 'DATA_ENCRYPTION_KEY=%s\n' "$encryption_key"
    printf '%s\n' 'BALE_PRIVATE_CHAT_ID=' 'DATA_DIR=./data' 'POLL_TIMEOUT_SECONDS=25' 'MAX_FILE_MIB=20' 'MAX_PENDING_JOBS=1000' 'METADATA_RETENTION_DAYS=7' 'SEND_INTERVAL_MS=1100' 'REMOVE_EXISTING_WEBHOOK=false'
  } >"$temporary_env"
  chmod 600 "$temporary_env"
  # Atomic no-clobber publish: an existing .env is never replaced.
  ln -- "$temporary_env" .env
  rm -- "$temporary_env"
  temporary_env=''
  unset bale_token telegram_token bale_user_id telegram_user_id bale_username telegram_username encryption_key
  printf '%s\n' 'Created .env once. Back it up securely; preserve this encryption key on every restart/update.'
elif [[ ! -f .env ]]; then
  printf '%s\n' '.env exists but is not a regular file.' >&2
  exit 1
else
  printf '%s\n' 'Keeping existing .env and encryption key unchanged.'
fi

chmod 600 .env
mkdir -p data
chmod 700 data
if ! node --env-file=.env --input-type=module -e 'import { loadConfig } from "./src/config.js"; loadConfig();'; then
  printf '%s\n' 'Complete the required local identity fields in .env: BALE_ALLOWED_USER_ID, TELEGRAM_ALLOWED_USER_ID, BALE_BOT_USERNAME, TELEGRAM_BOT_USERNAME. Preserve existing tokens and encryption key; see README.fa.md.' >&2
  exit 1
fi

# This diagnostic only calls getMe/getWebhookInfo; it does not poll messages,
# acknowledge updates, change webhooks or conflict with a running bridge.
npm run doctor -- --samples=1

pm2 startOrRestart ecosystem.config.cjs --update-env
pm2 save
pm2 status bale-telegram-bridge
printf '%s\n' 'Run the startup command from deploy/PM2.fa.md once to enable automatic startup after server reboot.'
