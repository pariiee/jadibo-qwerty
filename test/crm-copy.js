'use strict';
/**
 * test/crm-copy.js — cek `.crm` / `.crm2`:
 *   - cuma dev + owner yang boleh
 *   - tanpa reply -> diminta reply dulu, bukan diem
 *   - pesan yang di-reply DI-RELAY ulang ke chat
 *   - kodenya dikirim sekaligus: file `.js` di header + tombol native-flow
 *     "Salin kode" (cta_copy) yang isinya kode relay siap tempel
 *   - key bungkus framework dibuang, fungsi dibuang, Buffer (jpegThumbnail) -> base64
 *
 * Jalanin: node test/crm-copy.js
 */

const handler = require('../plugins/10-crm');
const assert  = require('assert');
const baileys = require('baileys');
const fs      = require('fs');
const path    = require('path');

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

// Upload media palsu — bentuknya sama kaya hasil prepareWAMessageMedia asli
// (proto Message.IDocumentMessage), cukup buat ngecek struktur.
const fakeUpload = async (buf, mimetype, fileName) => ({
  documentMessage: {
    url: 'https://mmg.whatsapp.net/doc.enc',
    mimetype, fileName, fileLength: String(buf.length),
    mediaKey: Buffer.from('KEY'), fileEncSha256: Buffer.from('SHA'),
  },
});

const ctxOf = (over = {}) => ({
  isCmd: true, command: 'crm', args: [], body: '.crm',
  reply: async (t) => { out.push(t); },
  react: async (r) => { reacts.push(r); },
  client: { message: {
    send: async (jid, m, o) => { sent.push(m); opts.push(o); return {}; },
    prepareDocument: fakeUpload,
  } },
  jid: '120363403895277092@g.us',
  sender: '6287778032605@s.whatsapp.net',
  isGroup: true, mentioned: [], isOwner: false,
  mess: { reactSuccess: '✅' },
  botData: { id: 1, prefix: '.', owner_number: '6287778032605', footer_text: 'labs.yapari.web.id' },
  msg: { message: { extendedTextMessage: { text: '.crm', contextInfo: { quotedMessage: quotedImage } } } },
  ...over,
});

// Pesan ke-2 = kiriman kode (yang pertama relay). Dua bentuk: interactive (baru)
// atau document polos (fallback kalau prepareDocument nggak ada / kode kepanjangan).
const codeMsg   = () => sent.find((m) => m.interactiveMessage || m.type === 'document');
const isInter   = () => !!codeMsg()?.interactiveMessage;
const header    = () => codeMsg().interactiveMessage.header;
const button    = () => codeMsg().interactiveMessage.nativeFlowMessage.buttons[0];
const params    = () => JSON.parse(button().buttonParamsJson);
const fileNameOf = () => (isInter() ? header().documentMessage.fileName : codeMsg().fileName);
const mimeOf     = () => (isInter() ? header().documentMessage.mimetype : codeMsg().mimetype);
const captionOf  = () => (isInter() ? codeMsg().interactiveMessage.body.text : codeMsg().caption);
const codeText   = () => (isInter() ? params().copy_code : String(codeMsg().media));

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

  // 3. owner + reply gambar -> relay + file .js + tombol "Salin kode"
  out = []; sent = []; opts = []; reacts = [];
  await handler(ctxOf({ isOwner: true }));
  console.log('\n[3] owner reply gambar:');
  console.log('    relay  -> ' + JSON.stringify(sent[0]).slice(0, 140));
  console.log('    kiriman kode -> ' + (isInter() ? 'interactiveMessage' : 'document polos'));
  console.log('    header -> ' + JSON.stringify({ doc: fileNameOf(), mime: mimeOf(), adaMedia: header().hasMediaAttachment }));
  console.log('    tombol -> ' + JSON.stringify(params()));
  console.log('    isi kode:\n' + codeText().split('\n').map(l => '    ' + l).join('\n'));

  ok('pesan di-relay ulang ke chat (imageMessage, caption utuh)', () => {
    assert.ok(sent[0]?.imageMessage, 'relay bukan imageMessage');
    assert.strictEqual(sent[0].imageMessage.caption, 'halo dari bang AL');
  });
  ok('relay & kiriman kode dua-duanya di-quote ke pesan .crm-nya', () => {
    assert.strictEqual(opts.length, 2, 'harusnya 2x send (relay + kode)');
    assert.ok(opts[0]?.quote, 'relay nggak di-quote');
    assert.strictEqual(opts[1].quote, opts[0].quote, 'quote kode beda dari relay');
  });
  ok('kode dikirim sebagai file <Tipe>.js di header pesan tombol', () => {
    assert.ok(isInter(), 'harusnya jalur interactiveMessage');
    assert.strictEqual(fileNameOf(), 'ImageMessage.js');
    assert.strictEqual(mimeOf(), 'application/javascript');
    assert.ok(/ImageMessage\.js/.test(captionOf()));
    assert.strictEqual(header().hasMediaAttachment, true, 'header nggak nandain ada media');
  });
  ok('tombol "Salin kode" (cta_copy) bawa kode relay', () => {
    assert.strictEqual(button().name, 'cta_copy');
    assert.strictEqual(params().display_text, 'Salin kode');
    assert.ok(params().id, 'id tombol kosong');
    assert.strictEqual(params().copy_code, codeText());
  });
  ok('kode = conn.relayMessage(...) siap tempel', () => {
    assert.ok(/conn\.relayMessage\(m\.chat,/.test(codeText()), 'bukan relayMessage');
    assert.ok(codeText().includes('imageMessage'), 'isi pesan ilang');
    assert.ok(codeText().includes('halo dari bang AL'), 'caption ilang');
  });
  ok('Buffer jpegThumbnail jadi base64 (FAKEJPEG = RkFLRUpQRUc=)', () => {
    assert.ok(codeText().includes('"RkFLRUpQRUc="'), 'base64 thumbnail nggak ada');
  });
  ok('key bungkus framework dibuang (mtype/fakeObj/download1/key)', () => {
    for (const k of ['mtype', 'fakeObj', 'download1']) {
      assert.ok(!codeText().includes(`${k}:`), `${k} masih ikut`);
    }
    assert.ok(!/\bkey:/.test(codeText()), 'key masih ikut');
  });
  ok('contextInfo di dalam pesan TETAP ikut', () => assert.ok(codeText().includes('contextInfo')));
  ok('react ✅ abis kirim', () => assert.deepStrictEqual(reacts, ['✅']));

  // 3b. yang DIKIRIM ke WA harus lolos proto asli + dapet node tombol
  ok('proto Message.create: interactiveMessage + header.documentMessage survive', () => {
    const p = baileys.proto.Message.create(codeMsg());
    assert.ok(p.interactiveMessage, 'interactiveMessage ilang di proto');
    assert.ok(p.interactiveMessage.header?.documentMessage?.url, 'header dokumen ilang');
    assert.strictEqual(p.interactiveMessage.nativeFlowMessage.buttons[0].name, 'cta_copy');
  });
  ok('buttonNodes(): kiriman kode dapet node <biz> (tombol ke-render WA)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'baileys', 'client.js'), 'utf8');
    const fnSrc = src.match(/function buttonNodes\(normalized\)\s*\{[\s\S]*?\n\}/);
    const buttonNodes = new Function('return ' + fnSrc[0])();
    const norm = baileys.normalizeMessageContent(baileys.proto.Message.create(codeMsg()));
    assert.strictEqual(buttonNodes(norm).length, 1, 'nggak dapet node <biz>');
  });
  // Guard buat bug yg udah kejadian: prepareWAMessageMedia balikin `{documentMessage}`,
  // bukan `document` — kalau plugin baca `.documentMessage` hilang, headernya kosong
  // dan WA nampilin pesan tanpa file (tombol jalan, file ilang).
  ok('engine prepareDocument: upload punya timeout + diekspos, plugin baca .documentMessage', () => {
    const eng = fs.readFileSync(path.join(__dirname, '..', 'engine', 'baileys', 'client.js'), 'utf8');
    assert.ok(/mediaUploadTimeoutMs:\s*60000/.test(eng), 'upload nggak dibatasin waktu');
    assert.ok(/^\s*prepareDocument,$/m.test(eng), 'prepareDocument nggak diekspos di client.message');
    assert.ok(/doc\?\.documentMessage/.test(fs.readFileSync(path.join(__dirname, '..', 'plugins', '10-crm.js'), 'utf8')));
  });

  // 3c. fallback: engine nggak punya prepareDocument -> document polos (jangan error)
  out = []; sent = [];
  await handler(ctxOf({ isOwner: true, client: { message: { send: async (jid, m, o) => { sent.push(m); opts.push(o); return {}; } } } }));
  console.log('\n[3c] tanpa prepareDocument -> ' + (sent[1]?.type === 'document' ? 'document polos (fallback)' : '??'));
  ok('fallback document polos kalau upload nggak tersedia', () => {
    assert.strictEqual(sent[1].type, 'document');
    assert.strictEqual(sent[1].fileName, 'ImageMessage.js');
  });

  // 4. dev (DEVELOPER_NUMBER) boleh walau bukan owner
  out = []; sent = [];
  process.env.DEVELOPER_NUMBER = '628123456789';
  await handler(ctxOf({ isOwner: false, sender: '628123456789@s.whatsapp.net' }));
  console.log('\n[4] dev (DEVELOPER_NUMBER) -> relay=' + !!sent[0] + ' file=' + fileNameOf());
  ok('dev lolos gate walau bukan owner bot', () => {
    assert.ok(sent[0]?.imageMessage, 'dev malah ditolak');
    assert.strictEqual(fileNameOf(), 'ImageMessage.js');
  });
  delete process.env.DEVELOPER_NUMBER;

  // 5. teks biasa (conversation) -> di-relay sebagai extendedTextMessage
  out = []; sent = [];
  await handler(ctxOf({ isOwner: true, msg: { message: { extendedTextMessage: {
    text: '.crm', contextInfo: { quotedMessage: { conversation: 'pesan polos' } } } } } }));
  console.log('\n[5] reply teks polos -> relay=' + JSON.stringify(sent[0]) + ' file=' + fileNameOf());
  ok('conversation -> extendedTextMessage.text', () => {
    assert.strictEqual(sent[0].extendedTextMessage.text, 'pesan polos');
    assert.strictEqual(fileNameOf(), 'ExtendedTextMessage.js');
  });

  // 6. proto didalam kode harus dibungkus `message:` (relayMessage butuh Message, bukan content)
  ok('kode relay bungkus { message: {...} }', () => {
    assert.ok(/relayMessage\(m\.chat, \{\s*\n?\s*message: \{/.test(codeText()), 'protonya nggak dibungkus message:');
  });

  // 7. command lain nggak diambil plugin ini
  const claimed = await handler(ctxOf({ command: 'menu', isOwner: true }));
  ok('command lain -> return false (nggak nyerobot)', () => assert.strictEqual(claimed, false));

  // 8. crm2 = alias, perilaku sama
  out = []; sent = [];
  await handler(ctxOf({ isOwner: true, command: 'crm2' }));
  ok('crm2 alias jalan sama', () => {
    assert.ok(sent[0]?.imageMessage);
    assert.strictEqual(fileNameOf(), 'ImageMessage.js');
  });

  console.log(`\ncrm-copy: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
