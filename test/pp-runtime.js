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
 */
const assert = require('assert');
const handler = require('../plugins/02-group.js');

const PNG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).buffer;

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
    msg: { key: { id: 'm1', remoteJid: '120363418099388@g.us' }, message: { conversation: '.pp' } },
    reply: async (t) => { replied.push(t); },
    react: async () => {},
    client,
    sock: {},
    ...over,
  };
}

(async () => {
  // 1. `.pp` polos, user nggak punya PP -> nggak boleh error, harus ada balasan.
  sent = []; replied = [];
  const r1 = await handler(makeCtx());
  assert.strictEqual(r1, true, 'handler harus klaim command');
  assert.strictEqual(sent.length, 0, 'nggak ada PP -> jangan kirim gambar');
  assert.strictEqual(replied.length, 1, 'harus balas pesan, bukan diem');
  assert.match(replied[0], /belum pasang|nggak pasang/i, `balasan aneh: ${replied[0]}`);
  console.log('  ok  .pp polos (tanpa PP) -> balasan, nggak error');

  // 2. `.pp` polos, ada PP -> kirim gambar, TANPA mention (nggak ada yang di-tag).
  sent = []; replied = [];
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => PNG });
  await handler(makeCtx({ pp: 'https://pps.whatsapp.net/v/t1/abc' }));
  global.fetch = realFetch;
  assert.strictEqual(sent.length, 1, 'harus kirim 1 gambar');
  assert.strictEqual(sent[0].type, 'image');
  assert.ok(!sent[0].mentions, 'self -> jangan mention diri sendiri');
  assert.match(sent[0].caption, /kamu/i, `caption: ${sent[0].caption}`);
  console.log('  ok  .pp polos (ada PP) -> gambar, tanpa mention');

  // 3. `.pp 999 @ <text>` -> argumen TIDAK menunjuk orang lain (cuma teks),
  //    jadi jatuh ke pengirim sendiri — nggak boleh error & nggak diem.
  sent = []; replied = [];
  global.fetch = async () => ({ ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => PNG });
  await handler(makeCtx({ pp: 'https://pps.whatsapp.net/v/t1/abc', args: ['999'] }));
  global.fetch = realFetch;
  assert.strictEqual(sent.length, 1, 'argumen teks bukan target orang -> tetap kirim PP pengirim');
  assert.match(sent[0].caption, /kamu/i, `caption: ${sent[0].caption}`);
  console.log('  ok  .pp <teks> -> jatuh ke PP pengirim, nggak error');

  // 3b. `.pp @user` asli (mentionedJid keisi) -> mention target beneran.
  sent = []; replied = [];
  const mentionCtx = makeCtx({ pp: 'https://pps.whatsapp.net/v/t1/abc' });
  mentionCtx.msg = {
    key: { id: 'm3' },
    message: {
      extendedTextMessage: { text: '.pp @user', contextInfo: { mentionedJid: ['628222@s.whatsapp.net'] } },
    },
  };
  global.fetch = async () => ({ ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => PNG });
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
  global.fetch = async () => ({ ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => PNG });
  const r4 = await handler(replyCtx);
  global.fetch = realFetch;
  assert.strictEqual(r4, true);
  assert.strictEqual(sent.length, 1, 'reply -> harus kirim gambar');
  assert.deepStrictEqual(sent[0].mentions, ['628333@s.whatsapp.net']);
  console.log('  ok  reply -> target kebaca dari contextInfo');

  console.log('\npp-runtime: 5/5 PASS');
})().catch((e) => { console.error('\nFAIL:', e.message); process.exit(1); });
