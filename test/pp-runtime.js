'use strict';
/**
 * test/pp-runtime.js — jalankan handler `.pp` beneran (bukan grep sumber).
 *
 * Dua bug live yang lolos dari tes-grep:
 *   - `.pp` tanpa tag/reply  -> "Cannot read properties of undefined (reading 'split')"
 *     (`mentioned[0].split(...)` dipakai buat caption padahal `mentioned` kosong)
 *   - reply `.pp`            -> "Assignment to constant variable."
 *     (`target` di-reassign padahal `const`)
 * Tes-grep nggak akan pernah nangkep ini; handler-nya harus dieksekusi.
 *
 * Aturan yang dikunci sekarang: `.pp` polos = INSTRUKSI, bukan PP pengirim.
 */
const assert = require('assert');
const handler = require('../plugins/02-group.js');

const PNG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).buffer;
const realFetch = global.fetch;

let sent = [];
let replied = [];

function makeCtx(over = {}) {
  const client = {
    message: { send: async (jid, payload) => { sent.push(payload); return { key: { id: 'x' } }; } },
    profile: { getProfilePicture: async () => over.pp ?? null },
    group: {
      queryGroupMetadata: async () => ({
        subject: 'Grup Tester',
        participants: [{ jid: '628111@s.whatsapp.net', lid: '999@lid', phoneNumber: '628111@s.whatsapp.net' }],
      }),
    },
    contact: {},
  };
  return {
    isCmd: true,
    isGroup: true,
    command: 'pp',
    args: [],
    jid: '120363418054099388@g.us',
    sender: '999@lid',
    pushName: 'Pak',
    botData: { prefix: '.', bot_number: '628000' },
    msg: { key: { id: 'm1', remoteJid: '120363418054099388@g.us' }, message: { conversation: '.pp' } },
    reply: async (t) => { replied.push(t); },
    react: async () => {},
    client,
    sock: {},
    ...over,
  };
}

const stubImage = async () => ({ ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => PNG });

(async () => {
  // 1. `.pp` polos -> INSTRUKSI. Ada PP pun, jangan kirim gambar (permintaan Pak:
  //    "kasih text suruh reply user atau mention aja ga usah pp sendiri").
  sent = []; replied = [];
  global.fetch = stubImage;
  const r1 = await handler(makeCtx({ pp: 'https://pps.whatsapp.net/v/t1/abc' }));
  global.fetch = realFetch;
  assert.strictEqual(r1, true, 'handler harus klaim command');
  assert.strictEqual(sent.length, 0, '.pp polos -> JANGAN kirim gambar');
  assert.strictEqual(replied.length, 1, 'harus ada balasan, bukan diem');
  assert.match(replied[0], /reply|tag|mention/i, `balasan aneh: ${replied[0]}`);
  console.log('  ok  .pp polos -> instruksi tag/reply, nggak kirim PP');

  // 2. `.pp 999` (argumen teks, bukan tag) -> sama, instruksi.
  sent = []; replied = [];
  global.fetch = stubImage;
  await handler(makeCtx({ pp: 'https://pps.whatsapp.net/v/t1/abc', args: ['999'] }));
  global.fetch = realFetch;
  assert.strictEqual(sent.length, 0, 'argumen teks bukan target orang -> jangan kirim gambar');
  assert.match(replied[0], /reply|tag|mention/i);
  console.log('  ok  .pp <teks> -> instruksi juga, nggak error');

  // 3. `.pp @user` asli (mentionedJid keisi) -> gambar + mention target.
  sent = []; replied = [];
  const mentionCtx = makeCtx({ pp: 'https://pps.whatsapp.net/v/t1/abc' });
  mentionCtx.msg = {
    key: { id: 'm3' },
    message: {
      extendedTextMessage: { text: '.pp @user', contextInfo: { mentionedJid: ['628222@s.whatsapp.net'] } },
    },
  };
  global.fetch = stubImage;
  await handler(mentionCtx);
  global.fetch = realFetch;
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(sent[0].mentions, ['628222@s.whatsapp.net'], 'mention target harus ada');
  assert.match(sent[0].caption, /@628222/, `caption: ${sent[0].caption}`);
  console.log('  ok  .pp @user -> gambar + mention target');

  // 4. reply ke pesan orang -> target dari contextInfo, semua jenis pesan.
  sent = []; replied = [];
  const replyCtx = makeCtx({ pp: 'https://pps.whatsapp.net/v/t1/abc' });
  replyCtx.msg = {
    key: { id: 'm2' },
    message: {
      extendedTextMessage: {
        text: '.pp',
        contextInfo: { participant: '628333@s.whatsapp.net', quotedMessage: { conversation: 'hai' } },
      },
    },
  };
  global.fetch = stubImage;
  const r4 = await handler(replyCtx);
  global.fetch = realFetch;
  assert.strictEqual(r4, true);
  assert.strictEqual(sent.length, 1, 'reply -> harus kirim gambar');
  assert.deepStrictEqual(sent[0].mentions, ['628333@s.whatsapp.net']);
  console.log('  ok  reply -> target kebaca dari contextInfo');

  // 5. target ada tapi nggak pasang PP -> pesan jelas, bukan avatar default.
  sent = []; replied = [];
  const noPpCtx = makeCtx({ pp: null });
  noPpCtx.msg = {
    key: { id: 'm4' },
    message: {
      extendedTextMessage: { text: '.pp @user', contextInfo: { mentionedJid: ['628222@s.whatsapp.net'] } },
    },
  };
  await handler(noPpCtx);
  assert.strictEqual(sent.length, 0, 'nggak ada PP -> jangan kirim apa-apa');
  assert.match(replied[0], /nggak pasang|tidak ada/i, `balasan: ${replied[0]}`);
  console.log('  ok  target tanpa PP -> pesan jelas');

  console.log('\npp-runtime: 5/5 PASS');
})().catch((e) => { console.error('\nFAIL:', e.message); process.exit(1); });
