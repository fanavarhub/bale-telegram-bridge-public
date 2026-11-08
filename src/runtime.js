import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { PLATFORMS } from './config.js';
import { authorizedMessage, planMessage } from './plan.js';

export const other = platform => platform === 'bale' ? 'telegram' : 'bale';
export function retryDelay(attempt = 0, minimum = 0, random = Math.random) {
  const ceiling = Math.min(60000, 1000 * 2 ** Math.min(attempt, 6));
  return Math.max(minimum || 0, Math.round(ceiling * (0.5 + random() * 0.5)));
}
export function log(event, fields = {}) {
  // Deliberately whitelist metadata: never log API URLs, message bodies, tokens,
  // downloaded filenames, raw exceptions or API error descriptions.
  const safe = { time: new Date().toISOString(), event };
  for (const key of ['platform', 'job', 'code', 'count', 'retryMs']) if (fields[key] !== undefined) safe[key] = fields[key];
  console.log(JSON.stringify(safe));
}
const pause = async (ms, signal) => {
  try { await delay(Math.max(1, Math.min(ms, 60000)), undefined, { signal }); } catch (e) { if (!signal.aborted) throw e; }
};

export function commandPlan(platform, message, stats, { botName } = {}) {
  const match = /^\/(start|help|status)(?:@([a-z0-9_]+))?(?:\s|$)/i.exec(message.text || '');
  if (!match || (match[2] && match[2].toLowerCase() !== botName?.toLowerCase())) return null;
  let text;
  if (match[1].toLowerCase() === 'status') {
    const pending = (stats.received || 0) + (stats.ready || 0);
    text = `پیام‌های در انتظار انتقال از این سمت: ${pending}\nانتقال‌های ثبت‌شده: ${stats.delivered || 0}\nخطاهای ثبت‌شده: ${stats.failed || 0}\nاین آمار مربوط به بازهٔ نگهداری سامانه است. ارسال موفق به ربات مقصد به معنی خوانده شدن پیام نیست.`;
  } else {
    text = 'این پل خصوصی فقط برای دو حساب تعیین‌شده فعال است.\nمتن، عکس، ویس، ویدئو و فایل بفرستید؛ فایل‌ها حداکثر ۲۰ مگابایت هستند. بعضی قالب‌ها به فایل یا توضیح متنی تبدیل می‌شوند.\n/status وضعیت صف را نشان می‌دهد.\nپیام‌ها رمزگذاری سرتاسری ندارند؛ اطلاعات بسیار حساس نفرستید. در قطعی ارتباط، پیام دریافت‌شده در صف می‌ماند.';
  }
  return [{ method: 'sendMessage', notice: true, params: { text } }];
}

export function intakeEntries(platform, updates, { userId, chatId = userId } = {}) {
  return updates.map(update => {
    const accepted = authorizedMessage(platform, update, { userId, chatId });
    return {
      updateId: update.update_id,
      messageId: accepted?.message.message_id,
      payload: accepted ? { message: accepted.message, edited: accepted.edited } : null,
    };
  }).sort((a, b) => a.updateId - b.updateId);
}

class FatalError extends Error { constructor(code) { super(code); this.code = code; } }
function fatalApi(error) { return ['auth', 'conflict'].includes(error?.category); }
function safeCode(error) {
  const code = error?.category || error?.code;
  return typeof code === 'string' && /^[a-z_]{1,60}$/.test(code) ? code : 'internal_error';
}

export async function runBridge({ config, store, apis, signal, onFatal = () => {} }) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  const shutdown = controller.signal;
  const owner = randomUUID();
  if (!store.acquireLease(owner)) throw new FatalError('another_instance_is_running');
  try { store.bindParticipants(config); }
  catch (error) {
    store.releaseLease(owner);
    signal?.removeEventListener('abort', stop);
    throw error;
  }
  const state = Object.fromEntries(PLATFORMS.map(p => [p, { ready: false, lastSend: 0, blockedUntil: 0 }]));
  function rateGate(platform, error, ms) {
    if (error?.category === 'rate_limit') state[platform].blockedUntil = Math.max(state[platform].blockedUntil, Date.now() + ms);
  }
  let fatal;
  const fail = error => {
    if (!fatal) { fatal = error; onFatal(error); }
    stop();
  };

  async function bootstrap(platform) {
    let attempt = 0;
    while (!shutdown.aborted) {
      if (state[platform].blockedUntil > Date.now()) { await pause(Math.min(1000, state[platform].blockedUntil - Date.now()), shutdown); continue; }
      try {
        const me = await apis[platform].call('getMe', {}, { signal: shutdown });
        if (!Number.isSafeInteger(me?.id) || me.id <= 0 || me?.is_bot !== true || me?.username?.toLowerCase() !== config.botNames[platform].toLowerCase()) throw new FatalError('bot_username_mismatch');
        try { store.bindBotIdentity(platform, me.id); }
        catch (error) { throw new FatalError(error.code || 'bot_identity_changed'); }
        const webhook = await apis[platform].call('getWebhookInfo', {}, { signal: shutdown });
        if (typeof webhook?.url !== 'string') throw new FatalError('invalid_webhook_response');
        if (webhook?.url) {
          if (!config.removeWebhook) throw new FatalError('existing_webhook_set_remove_flag_locally');
          // Bale documents clearing via setWebhook with empty url; Telegram has
          // deleteWebhook. Neither request intentionally discards pending data.
          await apis[platform].call(platform === 'bale' ? 'setWebhook' : 'deleteWebhook', platform === 'bale' ? { url: '' } : { drop_pending_updates: false }, { signal: shutdown });
          log('webhook_removed', { platform });
        }
        state[platform].ready = true;
        log('platform_ready', { platform });
        return;
      } catch (error) {
        if (shutdown.aborted) return;
        if (error instanceof FatalError || fatalApi(error) || error.permanent) throw error;
        const ms = retryDelay(attempt++, error.retryAfterMs);
        rateGate(platform, error, ms);
        log('bootstrap_retry', { platform, code: safeCode(error), retryMs: ms });
        await pause(ms, shutdown);
      }
    }
  }
  async function poll(platform) {
    await bootstrap(platform);
    let attempt = 0;
    while (!shutdown.aborted) {
      if (state[platform].blockedUntil > Date.now()) { await pause(Math.min(1000, state[platform].blockedUntil - Date.now()), shutdown); continue; }
      try {
        const offset = store.pollOffset(platform);
        const updates = await apis[platform].getUpdates({ offset, timeout: config.pollTimeout, signal: shutdown });
        if (!Array.isArray(updates)) throw new FatalError('invalid_updates_response');
        // Persist and commit before the next getUpdates call acknowledges them.
        const count = store.ingest(platform, intakeEntries(platform, updates, { userId: config.users[platform], chatId: config.chatIds[platform] }));
        if (count) log('updates_queued', { platform, count });
        attempt = 0;
        if (!updates.length) await pause(250, shutdown);
      } catch (error) {
        if (shutdown.aborted) return;
        if (error instanceof FatalError || fatalApi(error) || (error.permanent && !['file_too_large'].includes(error.category))) throw error;
        if (!['network', 'transient', 'rate_limit', 'queue_capacity_reached'].includes(safeCode(error))) throw error;
        const ms = retryDelay(attempt++, error.retryAfterMs);
        rateGate(platform, error, ms);
        log('poll_retry', { platform, code: safeCode(error), retryMs: ms });
        await pause(ms, shutdown);
      }
    }
  }
  async function stage(platform) {
    while (!shutdown.aborted) {
      if (!state[platform].ready) { await pause(500, shutdown); continue; }
      if (state[platform].blockedUntil > Date.now()) { await pause(Math.min(1000, state[platform].blockedUntil - Date.now()), shutdown); continue; }
      const job = store.nextUnprepared(platform);
      if (!job) { await pause(350, shutdown); continue; }
      try {
        const { message, edited } = job.raw;
        const counts = store.stats(platform);
        counts.received = Math.max(0, (counts.received || 0) - 1);
        const plan = (!edited && commandPlan(platform, message, counts, { botName: config.botNames[platform] })) || planMessage(platform, message, { edited, maxFileBytes: config.maxFileBytes });
        const files = new Map();
        for (let i = 0; i < plan.length; i++) {
          const step = plan[i];
          if (step.file) {
            const file = await apis[platform].getFileBuffer(step.file.fileId, { signal: shutdown });
            files.set(i, file.bytes);
            step.file.filename = step.file.filename || file.filename;
          }
          if (!step.notice && message.reply_to_message?.message_id) step.replyToSourceId = message.reply_to_message.message_id;
        }
        // Stage every accepted file independently of destination availability.
        // A later ready job waits for earlier jobs only in the sending loop.
        store.prepare(job.id, plan, files);
        log('message_prepared', { platform, job: job.id });
      } catch (error) {
        if (shutdown.aborted) return;
        if (fatalApi(error)) throw error;
        if (error.permanent) {
          store.failWithNotice(job, safeCode(error));
          log('message_failed', { platform, job: job.id, code: safeCode(error) });
        } else if (['network', 'transient', 'rate_limit'].includes(safeCode(error))) {
          const ms = retryDelay(job.stage_attempts, error.retryAfterMs);
          rateGate(platform, error, ms);
          store.defer(job.id, 'stage', safeCode(error), Date.now() + ms);
          log('download_retry', { platform, job: job.id, code: safeCode(error), retryMs: ms });
        } else throw error;
      }
    }
  }
  async function send(source) {
    while (!shutdown.aborted) {
      const job = store.headReady(source);
      if (!job) { await pause(350, shutdown); continue; }
      const step = job.plan[job.step_index];
      const target = step.notice ? source : other(source);
      if (!state[target].ready) { await pause(500, shutdown); continue; }
      const wait = Math.max(config.sendIntervalMs - (Date.now() - state[target].lastSend), state[target].blockedUntil - Date.now());
      if (wait > 0) { await pause(wait, shutdown); continue; }
      // Reserve before await so the other direction's source notices share the
      // same per-bot rate gate rather than racing this send.
      state[target].lastSend = Date.now();
      const replyToId = step.replyDropped ? undefined : store.replyTarget(source, step.replyToSourceId);
      try {
        const bytes = step.file ? store.attachment(job.id, job.step_index) : undefined;
        if (step.file && !bytes) throw new FatalError('attachment_missing');
        const result = await apis[target].send(step, { chatId: config.chatIds[target], replyToId, bytes, filename: step.file?.filename, signal: shutdown });
        if (!Number.isSafeInteger(result?.message_id) || result.message_id <= 0) throw new FatalError('invalid_send_response');
        store.advance(job, target, result);
        log('step_sent', { platform: target, job: job.id });
      } catch (error) {
        if (shutdown.aborted) return;
        if (error instanceof FatalError || fatalApi(error)) throw error;
        if (error.code === 403 && !step.notice) {
          // A private recipient may not have pressed Start yet or may have
          // blocked the bot. Keep the original in its durable queue.
          const ms = retryDelay(job.send_attempts, Math.max(60000, error.retryAfterMs || 0));
          store.defer(job.id, 'send', 'recipient_unavailable', Date.now() + ms);
          store.enqueueNotice(job, 'طرف مقابل فعلاً پیام ربات را دریافت نمی‌کند؛ ممکن است هنوز Start را نزده یا ربات را مسدود کرده باشد. پیام شما در صف می‌ماند.', 'recipient_unavailable');
          log('send_retry', { platform: target, job: job.id, code: 'recipient_unavailable', retryMs: ms });
        } else if (error.permanent) {
          // A mapped reply can expire or be deleted. Retry the content once
          // without its reference before selecting an attachment fallback.
          if (replyToId && !step.replyDropped && error.category === 'permanent' && error.code !== 403) {
            store.replaceStep(job, { ...step, replyDropped: true });
          } else if (step.file && step.method !== 'sendDocument' && error.category === 'permanent' && error.code !== 403) {
            const caption = (step.params?.caption || '').slice(0, 950);
            store.replaceStep(job, { ...step, method: 'sendDocument', file: { ...step.file, field: 'document' }, params: { caption: caption ? `${caption}\n(فایل اصلی)` : 'فایل اصلی؛ نمایش در قالب اولیه ممکن نشد.' } });
          } else {
            store.failWithNotice(job, safeCode(error));
            log('message_failed', { platform: target, job: job.id, code: safeCode(error) });
          }
        } else if (['network', 'transient', 'rate_limit'].includes(safeCode(error))) {
          const ms = retryDelay(job.send_attempts, error.retryAfterMs);
          rateGate(target, error, ms);
          store.defer(job.id, 'send', safeCode(error), Date.now() + ms);
          log('send_retry', { platform: target, job: job.id, code: safeCode(error), retryMs: ms });
        } else throw error;
      }
    }
  }

  async function maintenance() {
    while (!shutdown.aborted) {
      await pause(10000, shutdown);
      if (shutdown.aborted) break;
      if (!store.renewLease(owner)) throw new FatalError('lease_lost');
      store.prune(Date.now() - config.retentionMs);
    }
  }
  const tasks = [maintenance(), ...PLATFORMS.flatMap(p => [poll(p), stage(p), send(p)])].map(task => task.catch(fail));
  try {
    await Promise.all(tasks);
    if (fatal) throw fatal;
  } finally {
    store.releaseLease(owner);
    signal?.removeEventListener('abort', stop);
  }
}
