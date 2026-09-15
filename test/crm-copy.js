'use strict';
/**
 * test/crm-copy.js — cek `.crm` / `.crm2`:
 *   - cuma dev + owner yang boleh
 *   - tanpa reply -> diminta reply dulu, bukan diem
 *   - pesan yang di-reply DI-RELAY ulang ke chat
 *   - kodenya dikirim sebagai file `.js` berisi `conn.relayMessage(...)` siap tempel
 *   - key bungkus framework dibuang, fungsi dibuang, Buffer (jpegThumbnail) -> base64
 *
 * Jalanin: node test/crm-copy.js
 */

const handler = require('../plugins/10-crm');
const assert  = require('assert');

let out  = [];  // teks via reply()
let sent = [];  // pesan via client.message.send()
let opts = [];  // opsi (quote) tiap send
let reacts = [];

const quotedImage = {
  mtype: 'imageMessage', fakeObj: {}, key: { id: 'ABC' }, download1: () => {},
  imageMessage: {
    url: 'https://mmg.whatsapp.net/x.enc',
    mimetype: 'image/jpeg',
    caption: 'halo dari bang AL',
    fileLength: '22172',
    jpegThumbnail: Buffer.from('FAKEJPEG'),
    contextInfo: { mentionedJid: ['6287778032605@s.whatsapp.net'] },
  },
};

const ctxOf = (over = {}) => ({
  isCmd: true, command: 'crm', args: [], body: '.crm',
  reply: async (t) => { out.push(t); },
  react: async (r) => { reacts.push(r); },
  client: { message: { send: async (jid, m, o) => { sent.push(m); opts.push(o); return {}; } } },
  jid: '120363403895277092@g.us',
  sender: '6287778032605@s.whatsapp.net',
  isGroup: true, mentioned: [], isOwner: false,
  mess: { reactSuccess: '✅' },
  botData: { id: 1, prefix: '.', owner_number: '6287778032605', footer_text: 'labs.yapari.web.id' },
  msg: { message: { extendedTextMessage: { text: '.crm', contextInfo: { quotedMessage: quotedImage } } } },
  ...over,
});

// document dikirim lewat send() -> ambil isi file-nya
const docOf = () => sent.find((m) => m.type === 'document');
const docText = () => String(docOf().media);

(async () => {
  let pass = 0, fail = 0;
  const ok = (name, fn) => {
    try { fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + ' -> ' + e.message); }
  };

  // 1. user biasa (bukan owner/dev) -> ditolak, pesannya nggak di-relay
  out = []; sent = []; reacts = [];
  let handled = await handler(ctxOf({ isOwner: false }));
  console.log('\n[1] user biasa -> ' + JSON.stringify(out[0]));
  ok('user biasa ditolak + nggak ada yang dikirim', () => {
    assert.strictEqual(handled, true);
    assert.ok(/khusus dev & owner/.test(out[0]), 'balasan gate nggak sesuai');
    assert.strictEqual(sent.length, 0, 'pesan tetap dikirim walau ditolak');
    assert.strictEqual(reacts.length, 0, 'react jalan walau ditolak');
  });

  // 2. owner tapi nggak reply pesan apa pun
  out = []; sent = [];
  await handler(ctxOf({ isOwner: true, msg: { message: { conversation: '.crm' } } }));
  console.log('\n[2] owner tanpa reply -> ' + JSON.stringify(out[0]));
  ok('tanpa reply -> disuruh reply dulu, nggak ngirim apa-apa', () => {
    assert.ok(/Reply pesan/.test(out[0]));
    assert.strictEqual(sent.length, 0);
  });

  // 3. owner + reply gambar -> relay + file .js
  out = []; sent = []; opts = []; reacts = [];
  await handler(ctxOf({ isOwner: true }));
  console.log('\n[3] owner reply gambar:');
  console.log('    relay  -> ' + JSON.stringify(sent[0]).slice(0, 140));
  console.log('    file   -> ' + docOf().fileName + ' | ' + docOf().mimetype);
  console.log('    isi:\n' + docText().split('\n').map(l => '    ' + l).join('\n'));

  ok('pesan di-relay ulang ke chat (imageMessage, caption utuh)', () => {
    assert.ok(sent[0]?.imageMessage, 'relay bukan imageMessage');
    assert.strictEqual(sent[0].imageMessage.caption, 'halo dari bang AL');
  });
  ok('relay & file dua-duanya di-quote ke pesan .crm-nya', () => {
    assert.strictEqual(opts.length, 2, 'harusnya 2x send (relay + file)');
    assert.ok(opts[0]?.quote, 'relay nggak di-quote');
    assert.strictEqual(opts[1].quote, opts[0].quote, 'quote file beda dari relay');
  });
  ok('kode dikirim sebagai file <Tipe>.js', () => {
    assert.strictEqual(docOf().fileName, 'ImageMessage.js');
    assert.strictEqual(docOf().mimetype, 'application/javascript');
    assert.ok(/ImageMessage\.js/.test(docOf().caption));
  });
  ok('kode = conn.relayMessage(...) siap tempel', () => {
    assert.ok(/conn\.relayMessage\(m\.chat,/.test(docText()), 'bukan relayMessage');
    assert.ok(docText().includes('imageMessage'), 'isi pesan ilang');
    assert.ok(docText().includes('halo dari bang AL'), 'caption ilang');
  });
  ok('Buffer jpegThumbnail jadi base64 (FAKEJPEG = RkFLRUpQRUc=)', () => {
    assert.ok(docText().includes('"RkFLRUpQRUc="'), 'base64 thumbnail nggak ada');
  });
  ok('key bungkus framework dibuang (mtype/fakeObj/download1/key)', () => {
    for (const k of ['mtype', 'fakeObj', 'download1']) {
      assert.ok(!docText().includes(`${k}:`), `${k} masih ikut`);
    }
    assert.ok(!/\bkey:/.test(docText()), 'key masih ikut');
  });
  ok('contextInfo di dalam pesan TETAP ikut', () => assert.ok(docText().includes('contextInfo')));
  ok('react ✅ abis kirim', () => assert.deepStrictEqual(reacts, ['✅']));

  // 4. dev (DEVELOPER_NUMBER) boleh walau bukan owner
  out = []; sent = [];
  process.env.DEVELOPER_NUMBER = '628123456789';
  await handler(ctxOf({ isOwner: false, sender: '628123456789@s.whatsapp.net' }));
  console.log('\n[4] dev (DEVELOPER_NUMBER) -> relay=' + !!sent[0] + ' file=' + docOf()?.fileName);
  ok('dev lolos gate walau bukan owner bot', () => {
    assert.ok(sent[0]?.imageMessage, 'dev malah ditolak');
    assert.strictEqual(docOf().fileName, 'ImageMessage.js');
  });
  delete process.env.DEVELOPER_NUMBER;

  // 5. teks biasa (conversation) -> di-relay sebagai extendedTextMessage
  out = []; sent = [];
  await handler(ctxOf({ isOwner: true, msg: { message: { extendedTextMessage: {
    text: '.crm', contextInfo: { quotedMessage: { conversation: 'pesan polos' } } } } } }));
  console.log('\n[5] reply teks polos -> relay=' + JSON.stringify(sent[0]) + ' file=' + docOf()?.fileName);
  ok('conversation -> extendedTextMessage.text', () => {
    assert.strictEqual(sent[0].extendedTextMessage.text, 'pesan polos');
    assert.strictEqual(docOf().fileName, 'ExtendedTextMessage.js');
  });

  // 6. proto didalam kode harus dibungkus `message:` (relayMessage butuh Message, bukan content)
  ok('kode relay bungkus { message: {...} }', () => {
    assert.ok(/relayMessage\(m\.chat, \{\s*\n?\s*message: \{/.test(docText()), 'protonya nggak dibungkus message:');
  });

  // 7. command lain nggak diambil plugin ini
  const claimed = await handler(ctxOf({ command: 'menu', isOwner: true }));
  ok('command lain -> return false (nggak nyerobot)', () => assert.strictEqual(claimed, false));

  // 8. crm2 = alias, perilaku sama
  out = []; sent = [];
  await handler(ctxOf({ isOwner: true, command: 'crm2' }));
  ok('crm2 alias jalan sama', () => {
    assert.ok(sent[0]?.imageMessage);
    assert.strictEqual(docOf().fileName, 'ImageMessage.js');
  });

  console.log(`\ncrm-copy: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
