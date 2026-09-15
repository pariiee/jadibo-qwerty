'use strict';
/**
 * test/crm-copy.js — cek `.crm` (copy raw pesan yang di-reply) :
 *   - cuma dev + owner yang boleh
 *   - tanpa reply -> diminta reply dulu, bukan diem
 *   - hasilnya kode JS literal isi pesan aslinya, key bungkus framework dibuang,
 *     Buffer (jpegThumbnail) jadi base64
 *
 * Jalanin: node test/crm-copy.js
 */

const handler = require('../plugins/10-crm');
const assert  = require('assert');

let out = [];   // teks yang dikirim via reply()
let sent = [];  // pesan mentah via client.message.send()

const media = {
  jpegThumbnail: Buffer.from('FAKEJPEG'),
};

// Pesan yang di-reply: gambar + caption, plus key bungkus ala framework lain
const quotedImage = {
  mtype: 'imageMessage', fakeObj: {}, key: { id: 'ABC' }, download1: () => {},
  imageMessage: {
    url: 'https://mmg.whatsapp.net/x.enc',
    mimetype: 'image/jpeg',
    caption: 'halo dari bang AL',
    fileLength: '22172',
    ...media,
    contextInfo: { mentionedJid: ['6287778032605@s.whatsapp.net'] },
  },
};

const ctxOf = (over = {}) => ({
  isCmd: true, command: 'crm', args: [], body: '.crm',
  reply: async (t) => { out.push(t); },
  react: async () => {},
  client: { message: { send: async (jid, m) => { sent.push(m); return {}; } } },
  jid: '120363403895277092@g.us',
  sender: '6287778032605@s.whatsapp.net',
  isGroup: true, mentioned: [], isOwner: false,
  botData: { id: 1, prefix: '.', owner_number: '6287778032605', footer_text: 'labs.yapari.web.id' },
  msg: { message: { extendedTextMessage: { text: '.crm', contextInfo: { quotedMessage: quotedImage } } } },
  ...over,
});

(async () => {
  let pass = 0, fail = 0;
  const ok = (name, fn) => {
    try { fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + ' -> ' + e.message); }
  };

  // 1. user biasa (bukan owner/dev) -> ditolak, nggak ada kode
  out = []; sent = [];
  let handled = await handler(ctxOf({ isOwner: false }));
  console.log('\n[1] user biasa -> ' + JSON.stringify(out[0]));
  ok('user biasa ditolak + nggak ada kode keluar', () => {
    assert.strictEqual(handled, true);
    assert.ok(/khusus dev & owner/.test(out[0]), 'balasan gate nggak sesuai');
    assert.strictEqual(out.length, 1);
  });

  // 2. owner tapi nggak reply pesan apa pun
  out = [];
  await handler(ctxOf({ isOwner: true, msg: { message: { conversation: '.crm' } } }));
  console.log('\n[2] owner tanpa reply -> ' + JSON.stringify(out[0]));
  ok('tanpa reply -> disuruh reply dulu', () => {
    assert.ok(/Reply pesan/.test(out[0]));
  });

  // 3. owner + reply gambar -> kode JS literal
  out = [];
  await handler(ctxOf({ isOwner: true }));
  console.log('\n[3] owner reply gambar -> hasil .crm:\n' + out[0]);
  ok('kode = JS literal pesan aslinya', () => {
    assert.ok(/```javascript/.test(out[0]), 'nggak ada code block');
    assert.ok(out[0].includes('imageMessage'), 'imageMessage ilang');
    assert.ok(out[0].includes('halo dari bang AL'), 'caption ilang');
    assert.ok(out[0].includes('"image/jpeg"'), 'mimetype ilang');
  });
  ok('Buffer jpegThumbnail jadi base64 (FAKEJPEG = RkFLRUpQRUc=)', () => {
    assert.ok(out[0].includes('"RkFLRUpQRUc="'), 'base64 thumbnail nggak ada');
  });
  ok('key bungkus framework dibuang (mtype/fakeObj/key/download1)', () => {
    for (const k of ['mtype', 'fakeObj', 'download1']) {
      assert.ok(!out[0].includes(`${k}:`), `${k} masih ikut ke-copy`);
    }
    assert.ok(!/^\s*key:/m.test(out[0]), 'key masih ikut');
  });
  ok('contextInfo di dalam pesan TETAP ikut (itu bagian pesan aslinya)', () => {
    assert.ok(out[0].includes('contextInfo'), 'contextInfo ilang');
  });

  // 4. dev (DEVELOPER_NUMBER) boleh walau bukan owner
  out = [];
  process.env.DEVELOPER_NUMBER = '628123456789';
  await handler(ctxOf({ isOwner: false, sender: '628123456789@s.whatsapp.net' }));
  console.log('\n[4] dev (DEVELOPER_NUMBER) -> ' + (out[0] ? out[0].split('\n')[0] : '(kosong)'));
  ok('dev lolos gate walau bukan owner bot', () => {
    assert.ok(/Raw message/.test(out[0]), 'dev malah ditolak');
  });
  delete process.env.DEVELOPER_NUMBER;

  // 5. teks biasa (conversation) -> dinormalkan jadi extendedTextMessage
  out = [];
  await handler(ctxOf({ isOwner: true, msg: { message: { extendedTextMessage: {
    text: '.crm', contextInfo: { quotedMessage: { conversation: 'pesan polos' } } } } } }));
  console.log('\n[5] reply teks polos ->\n' + out[0]);
  ok('conversation -> extendedTextMessage.text', () => {
    assert.ok(out[0].includes('extendedTextMessage'));
    assert.ok(out[0].includes('pesan polos'));
  });

  // 6. command lain nggak diambil plugin ini
  const claimed = await handler(ctxOf({ command: 'menu', isOwner: true }));
  ok('command lain -> return false (nggak nyerobot)', () => assert.strictEqual(claimed, false));

  console.log(`\ncrm-copy: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
