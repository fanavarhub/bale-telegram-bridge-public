import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizedMessage as authorize, planMessage } from '../src/plan.js';

// Synthetic fixtures only; production identities are required local settings.
const USERS = Object.freeze({ bale: 11111111, telegram: 22222222 });
const authorizedMessage = (platform, update, options = {}) => authorize(platform, update, { userId: USERS[platform], chatId: USERS[platform], ...options });

const baleMessage = (extra = {}) => ({ message_id: 7, chat: { id: 11111111, type: 'private' }, from: { id: 11111111, is_bot: false }, ...extra });
const telegramMessage = (extra = {}) => ({ message_id: 9, chat: { id: 22222222, type: 'private' }, from: { id: 22222222, is_bot: false }, ...extra });

test('authorization fails closed without an explicit valid local identity', () => {
  const update = { update_id: 1, message: baleMessage() };
  assert.equal(authorize('bale', update), null);
  assert.equal(authorize('bale', update, { userId: '11111111' }), null);
  assert.equal(authorize('bale', update, { userId: 11111111, chatId: 0 }), null);
  assert.equal(authorize('bale', update, { userId: NaN }), null);
  assert.ok(authorize('bale', update, { userId: 11111111 }));
});

test('authorization accepts exactly each human and platform, including edits', () => {
  const message = baleMessage({ text: 'سلام' });
  assert.deepEqual(authorizedMessage('bale', { update_id: 0, message }), { message, edited: false });
  const edited = telegramMessage({ text: 'ویرایش' });
  assert.deepEqual(authorizedMessage('telegram', { update_id: 1, edited_message: edited }), { message: edited, edited: true });
  assert.equal(authorizedMessage('telegram', { update_id: 2, message }), null);
});

test('authorization rejects groups, spoofed chats, bots, missing IDs and ambiguous updates', () => {
  const invalid = [
    baleMessage({ chat: { id: -7, type: 'group' } }),
    baleMessage({ chat: { id: 11111111, type: 'group' } }),
    baleMessage({ chat: { id: 999, type: 'private' } }),
    baleMessage({ from: { id: 999 } }),
    baleMessage({ from: { id: 11111111, is_bot: true } }),
    baleMessage({ sender_chat: { id: 11111111 } }),
    baleMessage({ message_id: 0 }), baleMessage({ message_id: 1.5 }), baleMessage({ from: null }),
  ];
  for (const message of invalid) assert.equal(authorizedMessage('bale', { update_id: 2, message }), null);
  assert.equal(authorizedMessage('bale', { message: baleMessage() }), null);
  assert.equal(authorizedMessage('bale', { update_id: -1, message: baleMessage() }), null);
  assert.equal(authorizedMessage('bale', { update_id: 2, message: baleMessage(), edited_message: baleMessage() }), null);
  assert.equal(authorizedMessage('bale', { update_id: 2, callback_query: {} }), null);
  assert.equal(authorizedMessage('bale', { update_id: 2, message: baleMessage({ from: { id: '11111111' } }) }), null);
  assert.throws(() => authorizedMessage('other', {}), /Unknown platform/);
});

test('business, guest and ephemeral contexts cannot reuse an allowed private identity', () => {
  for (const field of ['business_connection_id', 'guest_query_id', 'receiver_user', 'ephemeral_message_id']) {
    const message = telegramMessage({ [field]: field === 'receiver_user' ? { id: 22222222 } : 'context' });
    assert.equal(authorizedMessage('telegram', { update_id: 5, message }), null);
    assert.equal(authorizedMessage('telegram', { update_id: 5, [field]: 'context', message: telegramMessage() }), null);
    const planned = planMessage('telegram', { ...message, text: 'sensitive', document: { file_id: 'private' } });
    assert.ok(planned.every((step) => step.notice === true && !step.file && !step.params.text.includes('sensitive')));
  }
});

test('Unicode text splits within UTF16 limits without damaging emoji or interpreting markup', () => {
  const text = 'x'.repeat(4095) + '🫶' + 'سلام <b>😊</b> '.repeat(700);
  const steps = planMessage('telegram', { text });
  assert.equal(steps.map((step) => step.params.text).join(''), text);
  assert.ok(steps.every((step) => step.params.text.length <= 4096 && step.params.text.isWellFormed()));
  assert.ok(steps.every((step) => !Object.hasOwn(step.params, 'parse_mode') && !Object.hasOwn(step.params, 'chat_id')));
});

test('edits relay as a clearly marked new message', () => {
  const steps = planMessage('bale', { text: 'متن جدید' }, { edited: true });
  assert.equal(steps[0].method, 'sendMessage');
  assert.match(steps[0].params.text, /^✏️ ویرایش پیام قبلی\nمتن جدید$/);
});

test('media mapping preserves largest photo and chooses animation over duplicate document', () => {
  const image = planMessage('bale', { photo: [{ file_id: 'small', width: 100, height: 100 }, { file_id: 'large', width: 1024, height: 1024 }] });
  assert.equal(image[0].file.fileId, 'large');
  assert.equal(image[0].method, 'sendPhoto');
  const animation = planMessage('telegram', { animation: { file_id: 'gif' }, document: { file_id: 'duplicate' } });
  assert.equal(animation.length, 1);
  assert.equal(animation[0].method, 'sendAnimation');
  for (const [kind, method] of [['voice', 'sendVoice'], ['audio', 'sendAudio'], ['document', 'sendDocument'], ['video', 'sendVideo']]) {
    assert.equal(planMessage('bale', { [kind]: { file_id: 'file' } })[0].method, method);
  }
});

test('caption splitting preserves Unicode and carries overflow as text', () => {
  const caption = 'a'.repeat(1023) + '🫶' + 'ب'.repeat(5000);
  const steps = planMessage('bale', { video: { file_id: 'v', file_name: '../bad\nname.mp4', mime_type: 'video/mp4' }, caption });
  assert.ok(steps[0].params.caption.length <= 1024);
  assert.equal(steps[0].params.caption + steps.slice(1).map((step) => step.params.text).join(''), caption);
  assert.ok(steps[0].params.caption.isWellFormed());
  assert.ok(!/[\n/\\]/.test(steps[0].file.filename));
  assert.equal(steps[0].file.mimeType, 'video/mp4');
});

test('combined text and file preserve Unicode, captions and safe filename boundaries', () => {
  const text = 'x'.repeat(4095) + '🫶' + 'متن';
  const caption = 'y'.repeat(1023) + '🫶' + 'کپشن'.repeat(1100);
  const filename = 'a'.repeat(179) + '🫶.mp4';
  const steps = planMessage('telegram', { text, caption, video: { file_id: 'v', file_name: filename } }, { edited: true });
  const mediaIndex = steps.findIndex((step) => step.file);
  assert.equal(steps.slice(0, mediaIndex).map((step) => step.params.text).join(''), '✏️ ویرایش پیام قبلی\n' + text);
  assert.equal(steps[mediaIndex].params.caption + steps.slice(mediaIndex + 1).map((step) => step.params.text).join(''), caption);
  assert.ok(steps.every((step) => (!step.params.text || step.params.text.length <= 4096) && (!step.params.caption || step.params.caption.length <= 1024)));
  assert.ok(steps.every((step) => (!step.params.text || step.params.text.isWellFormed()) && (!step.params.caption || step.params.caption.isWellFormed())));
  assert.ok(steps[mediaIndex].file.filename.isWellFormed());
});

test('video notes and stickers have explicit portable representations', () => {
  const note = planMessage('telegram', { video_note: { file_id: 'n' } });
  assert.equal(note[0].method, 'sendVideo');
  assert.equal(note[0].file.field, 'video');
  assert.match(note[0].params.caption, /ویدئوی معمولی/);
  const sticker = planMessage('telegram', { sticker: { file_id: 's', is_animated: true, emoji: '🙌' } });
  assert.equal(sticker[0].method, 'sendDocument');
  assert.equal(sticker[0].file.filename, 'sticker.tgs');
  assert.match(sticker[0].params.caption, /🙌/);
  assert.equal(planMessage('bale', { sticker: { file_id: 's' } })[0].file.filename, 'sticker.bin');
});

test('oversized and protected payloads become source notices, not destination sends', () => {
  for (const message of [{ document: { file_id: 'big', file_size: 20 * 1024 * 1024 + 1 } }, { text: 'secret', has_protected_content: true }]) {
    const steps = planMessage('telegram', message);
    assert.ok(steps.every((step) => step.notice === true && step.method === 'sendMessage' && !step.file));
  }
  const photo = planMessage('bale', { photo: [{ file_id: 'large', width: 10, height: 10, file_size: 11 * 1024 * 1024 }] });
  assert.equal(photo[0].method, 'sendDocument');
  assert.equal(photo[0].file.field, 'document');
  assert.throws(() => planMessage('bale', {}, { maxFileBytes: -1 }), /Invalid file limit/);
});

test('protected content cannot leak through any alternate content branch', () => {
  for (const payload of [
    { text: 'secret', document: { file_id: 'private' } },
    { photo: [{ file_id: 'private', width: 10, height: 10 }], caption: 'secret' },
    { live_photo: {}, photo: [{ file_id: 'private' }] },
    { poll: { question: 'secret' } },
    { contact: { phone_number: '+secret', first_name: 'secret' } },
    { location: { latitude: 35, longitude: 51 } },
    { game: { title: 'secret' } },
    { unknown_type: { value: 'secret' }, caption: 'secret' },
  ]) {
    const steps = planMessage('telegram', { ...payload, has_protected_content: true });
    assert.ok(steps.every((step) => step.notice === true && !step.file && step.method === 'sendMessage'));
    assert.ok(!JSON.stringify(steps).includes('secret'));
  }
});

test('live photos refuse visibly before backward-compatible photo or text handling', () => {
  const steps = planMessage('telegram', { live_photo: { file_id: 'motion' }, photo: [{ file_id: 'still', width: 10, height: 10 }], text: 'body', caption: 'caption' });
  assert.equal(steps.length, 1);
  assert.equal(steps[0].notice, true);
  assert.equal(steps[0].method, 'sendMessage');
  assert.match(steps[0].params.text, /عکس زنده/);
  assert.ok(!steps[0].file);
});

test('contact, venue and live location do not copy platform-specific user identifiers', () => {
  const contact = planMessage('telegram', { contact: { phone_number: '+123', first_name: 'نام', last_name: 'خانوادگی', user_id: 999, vcard: 'BEGIN:VCARD' } });
  assert.deepEqual(contact[0], { method: 'sendContact', params: { phone_number: '+123', first_name: 'نام', last_name: 'خانوادگی' } });
  assert.match(contact[1].params.text, /BEGIN:VCARD/);
  const location = planMessage('telegram', { location: { latitude: 35, longitude: 51, live_period: 60 } });
  assert.match(location[0].params.text, /نقطهٔ ثابت/);
  assert.deepEqual(location[1], { method: 'sendLocation', params: { latitude: 35, longitude: 51 } });
  const venue = planMessage('telegram', { venue: { title: 'کافه', address: 'تهران', location: { latitude: 35, longitude: 51 } } });
  assert.match(venue[0].params.text, /کافه\nتهران/);
});

test('polls, dice, games and unknown payloads are visible instead of silently dropped', () => {
  const poll = planMessage('telegram', { poll: { question: 'کدام؟', options: [{ text: 'یک', voter_count: 3 }], total_voter_count: 3 } });
  assert.match(poll[0].params.text, /کدام؟/);
  assert.match(poll[0].params.text, /1\. یک \(3 رأی\)/);
  assert.match(poll[0].params.text, /غیرتعاملی/);
  assert.match(planMessage('telegram', { dice: { emoji: '🎯', value: 6 } })[0].params.text, /6/);
  assert.match(planMessage('telegram', { game: { title: 'بازی من', description: 'شرح' } })[0].params.text, /بازی من/);
  const unknown = planMessage('bale', { unknown_type: {}, caption: 'متن همراه' });
  assert.match(unknown[0].params.text, /unknown_type/);
  assert.match(unknown[0].params.text, /متن همراه/);
  assert.ok(unknown.every((step) => step.notice === true && !step.file));
  assert.match(unknown[0].params.text, /منتقل نشد/);
});
