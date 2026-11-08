import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export class QueueFullError extends Error {
  constructor() { super('queue_capacity_reached'); this.code = 'queue_capacity_reached'; }
}

// SQL metadata contains counters and message identifiers; message text, plans,
// attachment names and bytes are always authenticated ciphertext on disk.
export class Store {
  constructor({ dataDir, key, maxPendingJobs = 1000 }) {
    this.key = key;
    this.maxPendingJobs = maxPendingJobs;
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, 'bridge.sqlite'));
    try { chmodSync(dataDir, 0o700); chmodSync(join(dataDir, 'bridge.sqlite'), 0o600); } catch { /* Windows ACLs differ. */ }
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      PRAGMA foreign_keys=ON;
      PRAGMA secure_delete=ON;
      PRAGMA trusted_schema=OFF;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS leases (name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE, source TEXT NOT NULL, update_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL, created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'received', local_only INTEGER NOT NULL DEFAULT 0, raw BLOB, plan BLOB,
        step_index INTEGER NOT NULL DEFAULT 0,
        stage_attempts INTEGER NOT NULL DEFAULT 0, send_attempts INTEGER NOT NULL DEFAULT 0,
        next_stage_at INTEGER NOT NULL DEFAULT 0, next_send_at INTEGER NOT NULL DEFAULT 0,
        error_code TEXT, finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(source,status,seq);
      CREATE TABLE IF NOT EXISTS attachments (
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        step_index INTEGER NOT NULL, body BLOB NOT NULL,
        PRIMARY KEY(job_id, step_index)
      );
      CREATE TABLE IF NOT EXISTS mappings (
        source TEXT NOT NULL, source_id INTEGER NOT NULL,
        target TEXT NOT NULL, target_id INTEGER NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(source, source_id, target)
      );
      CREATE INDEX IF NOT EXISTS mappings_inverse ON mappings(target,target_id);
    `);
    const check = this.db.prepare("SELECT value FROM meta WHERE key='key_check'").get();
    if (check) {
      try {
        if (this.decrypt(Buffer.from(check.value, 'base64'), 'key_check').toString() !== 'private-bridge-v1') throw new Error();
      } catch { this.db.close(); throw new Error('Database encryption key does not match'); }
    } else {
      this.db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('key_check', this.encrypt(Buffer.from('private-bridge-v1'), 'key_check').toString('base64'));
    }
  }
  encrypt(bytes, context) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }
  decrypt(blob, context) {
    const bytes = Buffer.from(blob);
    const cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    cipher.setAAD(Buffer.from(context));
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
  }
  pack(value, context) { return this.encrypt(Buffer.from(JSON.stringify(value)), context); }
  unpack(value, context) { return value ? JSON.parse(this.decrypt(value, context).toString('utf8')) : null; }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  bindParticipants({ users, chatIds, botNames }) {
    const fail = code => { const error = new Error(code); error.code = code; throw error; };
    const identity = ['bridge-participants-v1'];
    for (const platform of ['bale', 'telegram']) {
      const userId = users?.[platform], chatId = chatIds?.[platform], botName = botNames?.[platform];
      if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(chatId) || chatId <= 0
          || typeof botName !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{4,63}$/.test(botName)) fail('participant_configuration_invalid');
      identity.push(platform, userId, chatId, botName.toLowerCase());
    }
    const fingerprint = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT value FROM meta WHERE key='participant_fingerprint'").get();
      if (existing) {
        if (existing.value !== fingerprint) fail('participant_configuration_changed');
        return fingerprint;
      }
      const legacy = this.db.prepare(`SELECT
        EXISTS(SELECT 1 FROM jobs) OR EXISTS(SELECT 1 FROM mappings) OR
        EXISTS(SELECT 1 FROM meta WHERE key LIKE 'offset:%' AND CAST(value AS INTEGER)>0) AS present`).get();
      if (legacy.present) fail('unbound_existing_queue');
      this.db.prepare("INSERT INTO meta(key,value) VALUES ('participant_fingerprint',?)").run(fingerprint);
      return fingerprint;
    });
  }
  bindBotIdentity(platform, id) {
    const fail = code => { const error = new Error(code); error.code = code; throw error; };
    if (!['bale', 'telegram'].includes(platform) || !Number.isSafeInteger(id) || id <= 0) fail('bot_identity_invalid');
    this.transaction(() => {
      const key = `bot_id:${platform}`;
      const existing = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
      if (existing && existing.value !== String(id)) fail('bot_identity_changed');
      if (!existing) this.db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run(key, String(id));
    });
  }
  offset(source) { return Number(this.db.prepare('SELECT value FROM meta WHERE key=?').get(`offset:${source}`)?.value || 0); }
  pollOffset(source, now = Date.now()) {
    if (source === 'telegram' && this.offset(source) > 0) {
      const last = Number(this.db.prepare('SELECT value FROM meta WHERE key=?').get(`last_update:${source}`)?.value || 0);
      // Telegram randomizes update IDs after a week of silence. Reset well
      // before that boundary; unreceived provider updates expire within 24h.
      // Durable local jobs and their dedupe records are kept intact.
      if (!last || now - last >= 2 * 86400000) {
        this.db.prepare("UPDATE meta SET value='0' WHERE key=?").run(`offset:${source}`);
      }
    }
    return this.offset(source);
  }
  ingest(source, entries, now = Date.now()) {
    return this.transaction(() => {
      let offset = this.offset(source);
      const initialOffset = offset;
      let inserted = 0;
      const count = Number(this.db.prepare("SELECT count(*) AS n FROM jobs WHERE status IN ('received','ready')").get().n);
      for (const entry of entries) {
        if (!Number.isSafeInteger(entry.updateId) || entry.updateId < 0) throw new Error('Invalid update ID');
        if (entry.updateId < offset) continue;
        const id = `${source}:${entry.updateId}`;
        if (entry.payload && !this.db.prepare('SELECT 1 FROM jobs WHERE id=?').get(id)) {
          if (count + inserted >= this.maxPendingJobs) {
            if (offset === initialOffset && inserted === 0) throw new QueueFullError();
            // Commit a fitting prefix, never acknowledge the first unqueued
            // update. A batch bigger than capacity must still make progress.
            break;
          }
          this.db.prepare('INSERT INTO jobs(id,source,update_id,message_id,created_at,raw) VALUES (?,?,?,?,?,?)')
            .run(id, source, entry.updateId, entry.messageId, now, this.pack(entry.payload, `${id}:raw`));
          inserted++;
        }
        offset = Math.max(offset, entry.updateId + 1);
      }
      this.db.prepare('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(`offset:${source}`, String(offset));
      if (entries.length && offset !== initialOffset) this.db.prepare('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(`last_update:${source}`, String(now));
      return inserted;
    });
  }
  decode(row) {
    if (!row) return null;
    return { ...row, raw: this.unpack(row.raw, `${row.id}:raw`), plan: this.unpack(row.plan, `${row.id}:plan`) };
  }
  nextUnprepared(source, now = Date.now()) {
    return this.decode(this.db.prepare("SELECT * FROM jobs WHERE source=? AND status='received' AND next_stage_at<=? ORDER BY seq LIMIT 1").get(source, now));
  }
  headReady(source, now = Date.now()) {
    // Local help/status/failure notices remain usable while the remote service
    // is offline. Only actual relay content must retain cross-platform FIFO.
    const notice = this.db.prepare("SELECT * FROM jobs WHERE source=? AND status='ready' AND local_only=1 AND next_send_at<=? ORDER BY seq LIMIT 1").get(source, now);
    if (notice) return this.decode(notice);
    const row = this.db.prepare("SELECT * FROM jobs WHERE source=? AND local_only=0 AND status IN ('received','ready') ORDER BY seq LIMIT 1").get(source);
    return row?.status === 'ready' && row.next_send_at <= now ? this.decode(row) : null;
  }
  prepare(id, plan, files = new Map()) {
    if (!Array.isArray(plan) || !plan.length) throw new Error('Empty delivery plan');
    this.transaction(() => {
      for (const [index, bytes] of files) {
        this.db.prepare('INSERT OR REPLACE INTO attachments(job_id,step_index,body) VALUES (?,?,?)')
          .run(id, index, this.encrypt(bytes, `${id}:file:${index}`));
      }
      this.db.prepare("UPDATE jobs SET status='ready',local_only=?,raw=NULL,plan=?,error_code=NULL WHERE id=? AND status='received'")
        .run(plan.every(s => s.notice) ? 1 : 0, this.pack(plan, `${id}:plan`), id);
    });
  }
  attachment(id, index) {
    const row = this.db.prepare('SELECT body FROM attachments WHERE job_id=? AND step_index=?').get(id, index);
    return row ? this.decrypt(row.body, `${id}:file:${index}`) : undefined;
  }
  replaceStep(job, step) {
    const plan = job.plan.map((value, index) => index === job.step_index ? step : value);
    this.db.prepare('UPDATE jobs SET plan=?,send_attempts=0,next_send_at=0,error_code=NULL WHERE id=?')
      .run(this.pack(plan, `${job.id}:plan`), job.id);
  }
  defer(id, phase, code, nextAt) {
    if (!['stage', 'send'].includes(phase)) throw new Error('Invalid retry phase');
    const column = phase === 'stage' ? 'stage_attempts' : 'send_attempts';
    const next = phase === 'stage' ? 'next_stage_at' : 'next_send_at';
    this.db.prepare(`UPDATE jobs SET ${column}=${column}+1,${next}=?,error_code=? WHERE id=?`).run(nextAt, code, id);
  }
  advance(job, target, result, now = Date.now()) {
    this.transaction(() => {
      const step = job.plan[job.step_index];
      // The first copy is enough for reply threading. Split messages and albums
      // are documented as separate messages; no remote read receipt is inferred.
      if (!step.notice && Number.isSafeInteger(result?.message_id)) {
        this.db.prepare('INSERT OR IGNORE INTO mappings(source,source_id,target,target_id,created_at) VALUES (?,?,?,?,?)')
          .run(job.source, job.message_id, target, result.message_id, now);
      }
      const next = job.step_index + 1;
      if (next >= job.plan.length) {
        this.db.prepare("UPDATE jobs SET status=?,step_index=?,raw=NULL,plan=NULL,error_code=NULL,finished_at=? WHERE id=?")
          .run(job.plan.every(s => s.notice) ? 'notified' : 'delivered', next, now, job.id);
        this.db.prepare('DELETE FROM attachments WHERE job_id=?').run(job.id);
      } else {
        this.db.prepare('UPDATE jobs SET step_index=?,send_attempts=0,next_send_at=0,error_code=NULL WHERE id=?').run(next, job.id);
      }
    });
  }
  failWithNotice(job, reason, now = Date.now()) {
    this.transaction(() => {
      this.db.prepare("UPDATE jobs SET status='failed',raw=NULL,plan=NULL,error_code=?,finished_at=? WHERE id=?").run(reason, now, job.id);
      this.db.prepare('DELETE FROM attachments WHERE job_id=?').run(job.id);
      // Best-effort, durable source notice. If that notice itself cannot be
      // delivered, it is failed without recursively creating another notice.
      if (!job.id.startsWith('notice:')) {
        const id = `notice:${job.id}`;
        const plan = [{ method: 'sendMessage', notice: true, params: { text: `انتقال پیام شمارهٔ ${job.message_id} کامل نشد. ${reason === 'file_too_large' ? 'فایل از سقف مجاز بزرگ‌تر است.' : 'ارسال یا دریافت این پیام با خطا روبه‌رو شد؛ وضعیت اتصال را بررسی کنید.'}` } }];
        this.db.prepare("INSERT OR IGNORE INTO jobs(id,source,update_id,message_id,created_at,status,local_only,plan) VALUES (?,?,?,?,?,'ready',1,?)")
          .run(id, job.source, job.update_id, job.message_id, now, this.pack(plan, `${id}:plan`));
      }
    });
  }
  enqueueNotice(job, text, suffix, now = Date.now()) {
    const id = `notice:${job.id}:${suffix}`;
    const plan = [{ method: 'sendMessage', notice: true, params: { text } }];
    this.db.prepare("INSERT OR IGNORE INTO jobs(id,source,update_id,message_id,created_at,status,local_only,plan) VALUES (?,?,?,?,?,'ready',1,?)")
      .run(id, job.source, job.update_id, job.message_id, now, this.pack(plan, `${id}:plan`));
  }
  replyTarget(source, messageId) {
    if (!Number.isSafeInteger(messageId)) return undefined;
    const inverse = this.db.prepare('SELECT source_id AS id FROM mappings WHERE target=? AND target_id=? ORDER BY created_at DESC LIMIT 1').get(source, messageId);
    if (inverse) return Number(inverse.id);
    return this.db.prepare('SELECT target_id AS id FROM mappings WHERE source=? AND source_id=? ORDER BY created_at DESC LIMIT 1').get(source, messageId)?.id;
  }
  stats(source) {
    const rows = source
      ? this.db.prepare('SELECT status,count(*) AS n FROM jobs WHERE source=? GROUP BY status').all(source)
      : this.db.prepare('SELECT status,count(*) AS n FROM jobs GROUP BY status').all();
    return Object.fromEntries(rows.map(row => [row.status, Number(row.n)]));
  }
  health(now = Date.now()) {
    const pending = this.db.prepare("SELECT count(*) AS n,min(created_at) AS oldest FROM jobs WHERE status IN ('received','ready')").get();
    const media = this.db.prepare('SELECT coalesce(sum(length(body)),0) AS bytes FROM attachments').get();
    return {
      counts: this.stats(), pending: Number(pending.n),
      oldestPendingSeconds: pending.oldest === null ? 0 : Math.max(0, Math.floor((now - pending.oldest) / 1000)),
      encryptedMediaBytes: Number(media.bytes),
      offsets: { bale: this.offset('bale'), telegram: this.offset('telegram') },
    };
  }
  backup(filename) {
    // SQLite's consistent snapshot includes WAL changes; copying only the main
    // sqlite file while the service runs is not a valid backup procedure.
    this.db.prepare('VACUUM INTO ?').run(filename);
  }
  acquireLease(owner, now = Date.now(), ttl = 60000) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM leases WHERE name='bridge'").get();
      if (row && row.owner !== owner && row.expires > now) return false;
      this.db.prepare("INSERT INTO leases(name,owner,expires) VALUES ('bridge',?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires=excluded.expires")
        .run(owner, now + ttl);
      return true;
    });
  }
  renewLease(owner, now = Date.now(), ttl = 60000) {
    return Number(this.db.prepare("UPDATE leases SET expires=? WHERE name='bridge' AND owner=? AND expires>?").run(now + ttl, owner, now).changes) === 1;
  }
  releaseLease(owner) { this.db.prepare("DELETE FROM leases WHERE name='bridge' AND owner=?").run(owner); }
  prune(before) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM jobs WHERE finished_at<?').run(before);
      this.db.prepare('DELETE FROM mappings WHERE created_at<?').run(before);
    });
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  }
  close() { this.db.close(); }
}
