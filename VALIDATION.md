# Validation

Date: 2026-11-08. The public configuration version passes **67 mocked tests, 0 failed**, including 11 runtime integration tests plus doctor preflight and transport privacy tests, on Node.js v26.13.0. Required identity configuration, closed authorization defaults, queue participant binding and pinned bot identity are covered in this version.

The suite uses synthetic user IDs, synthetic bot names, fake API responses and isolated temporary databases. It must not use production credentials or send bot messages.

Coverage includes:

- Exact user and pinned private-chat authorization; rejection of groups, bots, business/guest contexts and ambiguous identities.
- Unicode text/caption splitting, media conversion/fallback planning and protected/unsupported content handling.
- Fixed official API hosts, multipart bytes, reply differences, safe filenames, redacted errors, invalid responses, redirect/path rejection and real streamed byte caps.
- Atomic update/outbox/offset commits, safe prefix ingestion when capacity is smaller than a polling batch, deduplication and idle cursor recovery.
- Restart recovery between delivery steps; encrypted queued text/media, wrong-key rejection, ciphertext tamper rejection, ciphertext backup and restoration.
- Independent directions during outages, source commands during a destination outage, media staging while the destination is down, source failure notices without recursion and retained messages after recipient 403.
- Exponential retry and shared per-bot retry-after gating, including a local status response that cannot bypass a 429 cooldown.
- Read-only doctor preflight rejects webhook conflicts before PM2 startup, allows explicitly authorized startup removal, and never logs the configured webhook URL or deletes it itself.
- Network diagnostics expose only allowlisted Node/Undici transport codes and the failed public-probe stage; nested causes, aggregate errors, mutable getters and stream failures cannot leak raw messages, tokens or URLs.

Public DNS/TLS reachability alone does not validate credentials, getUpdates, file downloads, uploads, codecs, bot ownership, user IDs or future connectivity during network restrictions.

Not performed for this public release: authenticated provider requests, real two-person round trips, real power-failure or production-load testing, a messenger security audit, Docker execution or a trial on the final Linux server. Node 24 is the declared minimum and Docker base. Follow the Persian README acceptance checklist on the actual host before relying on the relay.

PM2 deployment additions were reviewed on 2026-11-08: `ecosystem.config.cjs` loads under Node with a single fork, absolute working/script/.env paths and no embedded credentials; the setup script passes GNU Bash 5.3.15 syntax checking via the bundled Git shell. The Linux/systemd/PM2 startup procedure has not been executed on a real server. Shell scripts are stored with LF line endings, enforced by `.gitattributes`.
