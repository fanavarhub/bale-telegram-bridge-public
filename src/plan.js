const MAX_TEXT = 4096;
const MAX_CAPTION = 1024;
const MAX_PHOTO = 10 * 1024 * 1024;
const EDIT_PREFIX = '✏️ ویرایش پیام قبلی\n';
const CONTEXT_FIELDS = ['business_connection_id', 'guest_query_id', 'receiver_user', 'ephemeral_message_id'];

function checkPlatform(platform) {
  if (!['bale', 'telegram'].includes(platform)) throw new TypeError('Unknown platform');
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function specialContext(value) {
  return CONTEXT_FIELDS.some((field) => Object.hasOwn(value, field));
}

/** Accept only the intended human in their own private chat, on this platform. */
export function authorizedMessage(platform, update, { userId, chatId = userId } = {}) {
  checkPlatform(platform);
  if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(chatId) || chatId <= 0) return null;
  if (!record(update) || !Number.isSafeInteger(update.update_id) || update.update_id < 0 || specialContext(update)) return null;
  const edited = record(update.edited_message);
  if (record(update.message) === edited) return null;
  const message = edited ? update.edited_message : update.message;
  if (!record(message) || !Number.isSafeInteger(message.message_id) || message.message_id <= 0) return null;
  if (specialContext(message)) return null;
  if (!record(message.from) || !record(message.chat)) return null;
  if (message.from.id !== userId || message.chat.id !== chatId || message.chat.type !== 'private') return null;
  if (message.from.is_bot === true || message.sender_chat !== undefined) return null;
  return { message, edited };
}

// Bot API limits count UTF-16 code units. Keep each surrogate pair together.
function chunks(value, limit) {
  const result = [];
  let offset = 0;
  while (offset < value.length) {
    let end = Math.min(value.length, offset + limit);
    const last = value.charCodeAt(end - 1);
    const next = value.charCodeAt(end);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
    result.push(value.slice(offset, end));
    offset = end;
  }
  return result;
}

function textSteps(text, notice = false) {
  return chunks(text, MAX_TEXT).map((part) => ({
    method: 'sendMessage', params: { text: part }, ...(notice ? { notice: true } : {}),
  }));
}

function cleanName(value, fallback) {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  const safe = chunks(value.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/^\.+/, ''), 180)[0]?.trim();
  return safe || fallback;
}

function mime(value, fallback) {
  return typeof value === 'string' && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value) ? value : fallback;
}

function fileSelection(platform, message) {
  if (record(message.animation)) return { kind: 'animation', media: message.animation, method: 'sendAnimation', field: 'animation', name: 'animation.gif', type: 'image/gif' };
  if (record(message.voice)) return { kind: 'voice', media: message.voice, method: 'sendVoice', field: 'voice', name: 'voice.ogg', type: 'audio/ogg' };
  if (record(message.audio)) return { kind: 'audio', media: message.audio, method: 'sendAudio', field: 'audio', name: 'audio.mp3', type: 'audio/mpeg' };
  if (record(message.video_note)) return { kind: 'video_note', media: message.video_note, method: 'sendVideo', field: 'video', name: 'video-note.mp4', type: 'video/mp4', label: 'ویدئومسیج؛ به‌صورت ویدئوی معمولی منتقل شد.' };
  if (record(message.video)) return { kind: 'video', media: message.video, method: 'sendVideo', field: 'video', name: 'video.mp4', type: 'video/mp4' };
  if (Array.isArray(message.photo)) {
    const available = message.photo.filter((photo) => record(photo) && typeof photo.file_id === 'string' && photo.file_id.length > 0);
    const area = (photo) => Number.isFinite(photo.width) && Number.isFinite(photo.height) ? photo.width * photo.height : 0;
    available.sort((a, b) => area(b) - area(a) || (b.file_size || 0) - (a.file_size || 0));
    if (available.length) return { kind: 'photo', media: available[0], method: 'sendPhoto', field: 'photo', name: 'photo.jpg', type: 'image/jpeg' };
  }
  if (record(message.sticker)) {
    const sticker = message.sticker;
    let name = 'sticker.bin';
    let type = 'application/octet-stream';
    if (platform === 'telegram') {
      [name, type] = sticker.is_animated ? ['sticker.tgs', 'application/x-tgsticker']
        : sticker.is_video ? ['sticker.webm', 'video/webm'] : ['sticker.webp', 'image/webp'];
    }
    return { kind: 'sticker', media: sticker, method: 'sendDocument', field: 'document', name, type,
      label: `استیکر به‌صورت فایل${typeof sticker.emoji === 'string' ? `: ${sticker.emoji}` : ''}` };
  }
  if (record(message.document)) return { kind: 'document', media: message.document, method: 'sendDocument', field: 'document', name: 'attachment.bin', type: 'application/octet-stream' };
  return null;
}

function validLocation(location) {
  return record(location) && Number.isFinite(location.latitude) && Number.isFinite(location.longitude)
    && location.latitude >= -90 && location.latitude <= 90 && location.longitude >= -180 && location.longitude <= 180;
}

function sourceNotice(text) {
  return textSteps(text, true);
}

/**
 * Produces transport-independent relay operations. No destinations, source file
 * URLs, arbitrary keyboards or entity instructions are copied into the plan.
 * A notice:true step must be sent back to the origin, never the destination.
 */
export function planMessage(platform, message, { edited = false, maxFileBytes = 20 * 1024 * 1024 } = {}) {
  checkPlatform(platform);
  if (!record(message)) throw new TypeError('Message must be an object');
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) throw new TypeError('Invalid file limit');
  if (message.has_protected_content === true) return sourceNotice('این پیام به علت محدودیت حفاظت محتوا منتقل نشد.');
  if (specialContext(message)) return sourceNotice('پیام در زمینهٔ تجاری، مهمان یا موقت خارج از گفت‌وگوی خصوصی مجاز است و منتقل نشد.');
  // Telegram also sets photo for backward compatibility; checking this first
  // prevents accidentally relaying only the still image and dropping motion.
  if (Object.hasOwn(message, 'live_photo')) return sourceNotice('انتقال کامل عکس زنده در این نسخه پشتیبانی نمی‌شود و پیام منتقل نشد. آن را به‌صورت ویدئو یا فایل معمولی بفرستید.');
  const prefix = edited ? EDIT_PREFIX : '';
  const caption = typeof message.caption === 'string' ? message.caption : '';
  const selected = fileSelection(platform, message);
  if (selected) {
    const { media } = selected;
    if (typeof media.file_id !== 'string' || !media.file_id.trim()) return sourceNotice('این فایل شناسهٔ معتبر ندارد و منتقل نشد.');
    if (Number.isFinite(media.file_size) && media.file_size > maxFileBytes) return sourceNotice('حجم این فایل بیشتر از سقف مجاز انتقال است و منتقل نشد.');
    let { method, field, label = '' } = selected;
    if (selected.kind === 'photo' && Number.isFinite(media.file_size) && media.file_size > MAX_PHOTO) {
      method = 'sendDocument';
      field = 'document';
      label = 'عکس به علت محدودیت حجم، به‌صورت فایل منتقل شد.';
    }
    const hasText = typeof message.text === 'string' && message.text.length > 0;
    const fullCaption = (hasText ? '' : prefix) + [label, caption].filter(Boolean).join('\n');
    const captionParts = chunks(fullCaption, MAX_CAPTION);
    const params = captionParts.length ? { caption: captionParts[0] } : {};
    const steps = [];
    if (hasText) steps.push(...textSteps(prefix + message.text));
    steps.push({ method, params, file: {
      field, fileId: media.file_id, filename: cleanName(media.file_name, selected.name), mimeType: mime(media.mime_type, selected.type),
    } });
    if (captionParts.length > 1) steps.push(...textSteps(captionParts.slice(1).join('')));
    return steps;
  }
  if (typeof message.text === 'string' && message.text.length) return textSteps(prefix + message.text);
  if (record(message.contact)) {
    const contact = message.contact;
    if (typeof contact.phone_number !== 'string' || !contact.phone_number.trim()) return sourceNotice('اطلاعات این مخاطب برای انتقال کامل نیست.');
    const params = { phone_number: contact.phone_number, first_name: typeof contact.first_name === 'string' && contact.first_name ? contact.first_name : 'مخاطب' };
    if (typeof contact.last_name === 'string') params.last_name = contact.last_name;
    const steps = prefix ? textSteps(prefix.trimEnd()) : [];
    steps.push({ method: 'sendContact', params });
    // Bale does not document vcard; preserve it as readable plain text instead.
    if (typeof contact.vcard === 'string' && contact.vcard) steps.push(...textSteps(`اطلاعات تکمیلی مخاطب:\n${contact.vcard}`));
    return steps;
  }
  const venue = record(message.venue) ? message.venue : null;
  const location = venue ? venue.location : message.location;
  if (validLocation(location)) {
    const descriptions = [];
    if (prefix) descriptions.push(prefix.trimEnd());
    if (venue) descriptions.push([venue.title, venue.address].filter((value) => typeof value === 'string' && value).join('\n'));
    if (Object.hasOwn(location, 'live_period')) descriptions.push('موقعیت زنده به‌صورت یک نقطهٔ ثابت در زمان این پیام منتقل شد.');
    const steps = textSteps(descriptions.filter(Boolean).join('\n'));
    const params = { latitude: location.latitude, longitude: location.longitude };
    if (Number.isFinite(location.horizontal_accuracy) && location.horizontal_accuracy >= 0 && location.horizontal_accuracy <= 1500) params.horizontal_accuracy = location.horizontal_accuracy;
    steps.push({ method: 'sendLocation', params });
    return steps;
  }
  if (record(message.poll)) {
    const poll = message.poll;
    const lines = ['نظرسنجی؛ نسخهٔ متنی و غیرتعاملی', typeof poll.question === 'string' ? poll.question : 'بدون عنوان'];
    if (Array.isArray(poll.options)) poll.options.forEach((option, index) => {
      if (!record(option)) return;
      const votes = Number.isSafeInteger(option.voter_count) && option.voter_count >= 0 ? ` (${option.voter_count} رأی)` : '';
      lines.push(`${index + 1}. ${typeof option.text === 'string' ? option.text : 'گزینه'}${votes}`);
    });
    if (Number.isSafeInteger(poll.total_voter_count) && poll.total_voter_count >= 0) lines.push(`تعداد رأی‌دهندگان در زمان انتقال: ${poll.total_voter_count}`);
    lines.push('تغییر رأی‌ها و نتیجه‌های بعدی همگام‌سازی نمی‌شود.');
    return textSteps(prefix + lines.join('\n'));
  }
  if (record(message.dice)) {
    const emoji = typeof message.dice.emoji === 'string' ? message.dice.emoji : '🎲';
    const value = Number.isSafeInteger(message.dice.value) ? String(message.dice.value) : 'نامشخص';
    return textSteps(`${prefix}${emoji} نتیجهٔ تاس/بازی: ${value}\nنمایش متنی؛ انیمیشن بازی منتقل نمی‌شود.`);
  }
  if (record(message.game)) {
    const details = [message.game.title, message.game.description, message.game.text].filter((value) => typeof value === 'string' && value);
    return textSteps(`${prefix}بازی؛ اجرای تعاملی در پل پشتیبانی نمی‌شود.\n${details.join('\n')}${caption ? `\n${caption}` : ''}`);
  }
  const metadata = new Set(['message_id', 'message_thread_id', 'from', 'sender_chat', 'chat', 'date', 'edit_date', 'forward_origin', 'forward_from', 'forward_from_chat', 'forward_from_message_id', 'forward_date', 'forward_sender_name', 'is_automatic_forward', 'reply_to_message', 'external_reply', 'quote', 'reply_to_story', 'via_bot', 'media_group_id', 'has_protected_content', 'is_from_offline', 'caption', 'caption_entities', 'entities', 'reply_markup', 'effect_id', 'business_connection_id']);
  const types = Object.keys(message).filter((key) => !metadata.has(key)).map((key) => key.replace(/[^a-z0-9_]/gi, '').slice(0, 60)).filter(Boolean).slice(0, 3).join(', ');
  return sourceNotice(`${prefix}این نوع پیام در پل پشتیبانی نمی‌شود${types ? ` (${types})` : ''} و منتقل نشد.${caption ? `\n${caption}` : ''}`);
}
