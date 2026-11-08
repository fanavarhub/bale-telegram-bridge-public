import { lookup } from 'node:dns/promises';
import { connect } from 'node:tls';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { BotApi } from './api.js';
import { loadConfig, PLATFORMS } from './config.js';

const args = process.argv.slice(2);
function option(name, fallback, min, max) {
  const found = args.find(a => a.startsWith(`--${name}=`));
  const value = found ? Number(found.slice(name.length + 3)) : fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('invalid_argument');
  return value;
}
function timedTls(host) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const socket = connect({ host, port: 443, servername: host, rejectUnauthorized: true, timeout: 10000 });
    socket.once('secureConnect', () => { const ms = Math.round(performance.now() - start); socket.destroy(); resolve(ms); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('tls_timeout')); });
    socket.once('error', () => { socket.destroy(); reject(new Error('tls_failed')); });
  });
}
async function measurePublic(platform) {
  const host = platform === 'bale' ? 'tapi.bale.ai' : 'api.telegram.org';
  const result = { platform };
  try {
    let start = performance.now();
    await Promise.race([
      lookup(host),
      delay(10000, undefined, { ref: false }).then(() => { throw new Error('dns_timeout'); }),
    ]);
    result.dnsMs = Math.round(performance.now() - start);
    result.tlsMs = await timedTls(host);
    start = performance.now();
    const response = await fetch(`https://${host}/`, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    result.httpMs = Math.round(performance.now() - start);
    result.httpStatus = response.status;
    await response.body?.cancel();
    // A 404 at the bare host still proves HTTPS reachability, not API health.
    result.publicReachable = response.status >= 100 && response.status < 600;
  } catch {
    result.publicReachable = false;
    result.error = 'dns_tls_or_http_failed';
  }
  return result;
}

try {
  if (args.some(a => !['--public', '--media', '--private-chat'].includes(a) && !/^--(?:samples|interval)=\d+$/.test(a))) throw new Error('invalid_argument');
  const samples = option('samples', 3, 1, 100000);
  const interval = option('interval', 10, 1, 86400);
  const publicOnly = args.includes('--public');
  const media = args.includes('--media');
  const privateChat = args.includes('--private-chat');
  if (publicOnly && (media || privateChat)) throw new Error('invalid_argument');
  const config = publicOnly ? null : loadConfig();
  let failed = false;
  const summary = Object.fromEntries(PLATFORMS.map(p => [p, { publicOk: 0, apiOk: 0, mediaOk: 0 }]));
  const apis = config ? Object.fromEntries(PLATFORMS.map(p => [p, new BotApi({ platform: p, token: config.tokens[p], maxFileBytes: config.maxFileBytes })])) : null;
  for (let sample = 1; sample <= samples; sample++) {
    const results = await Promise.all(PLATFORMS.map(async platform => {
      const result = await measurePublic(platform);
      if (result.publicReachable) summary[platform].publicOk++;
      else failed = true;
      if (apis) {
        try {
          const start = performance.now();
          const me = await apis[platform].call('getMe');
          result.apiMs = Math.round(performance.now() - start);
          result.botMatches = Number.isSafeInteger(me?.id) && me.id > 0 && me.is_bot === true && me.username?.toLowerCase() === config.botNames[platform].toLowerCase();
          const webhook = await apis[platform].call('getWebhookInfo');
          if (typeof webhook?.url !== 'string') throw new Error('invalid_webhook_response');
          result.webhookConfigured = Boolean(webhook.url);
          if (result.botMatches) summary[platform].apiOk++; else failed = true;
          if (privateChat) {
            // Operator runs this only with the bridge stopped. offset=0 confirms
            // no positive update IDs; no body or other person's ID is printed.
            const updates = await apis[platform].getUpdates({ offset: 0, timeout: 0 });
            const ids = new Set();
            for (const update of updates) {
              const message = update.message;
              if (message?.from?.id === config.users[platform] && message.from.is_bot !== true && message.chat?.type === 'private'
                  && Number.isSafeInteger(message.chat.id) && message.chat.id > 0 && !message.sender_chat
                  && !message.business_connection_id && !message.guest_query_id) ids.add(message.chat.id);
            }
            result.authorizedPrivateChatIds = [...ids];
            result.configuredPrivateChatFound = ids.has(config.chatIds[platform]);
            if (!result.configuredPrivateChatFound) failed = true;
            if (!ids.size) result.privateChatNote = 'Send Start from the allowed human while the bridge is stopped, then repeat.';
          }
          if (media) {
            const id = process.env[`DIAGNOSTIC_${platform.toUpperCase()}_FILE_ID`];
            if (!id) { result.media = 'set_local_diagnostic_file_id'; failed = true; }
            else {
              const mediaStart = performance.now();
              const file = await apis[platform].getFileBuffer(id);
              result.mediaMs = Math.round(performance.now() - mediaStart);
              result.mediaBytes = file.bytes.byteLength;
              result.media = 'download_ok';
              summary[platform].mediaOk++;
            }
          }
        } catch (error) {
          result.apiOrMediaError = ['network', 'rate_limit', 'auth', 'conflict', 'permanent', 'transient', 'file_too_large'].includes(error.category) ? error.category : 'validation_failed';
          failed = true;
        }
      }
      return result;
    }));
    console.log(JSON.stringify({ time: new Date().toISOString(), sample, results }));
    if (sample < samples) await delay(interval * 1000);
  }
  console.log(JSON.stringify({ summary, samples, publicOnly, note: 'Run on the final server. Public reachability is not authenticated API or media verification; media download does not test upload. No positive update IDs were acknowledged and no messages were sent. Use --private-chat only with the bridge stopped.' }));
  process.exitCode = failed ? 1 : 0;
} catch {
  console.error('Check local .env or arguments: [--public] [--media] [--private-chat] [--samples=3] [--interval=10]. Never paste tokens into commands.');
  process.exitCode = 1;
}
