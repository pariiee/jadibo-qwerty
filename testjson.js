'use strict';
// Self-check .test (render JSON proto -> WA).
// Jalankan: node testjson.js
// Menguji kode strip() ASLI dari plugins/05-owner.js, bukan salinannya.
const fs = require('fs');
const assert = require('assert');
const { proto } = require('zapo-js');

// ── Ambil fungsi strip() langsung dari plugin ──
const src = fs.readFileSync('plugins/05-owner.js', 'utf8');
const fnStart = src.indexOf('const strip = (o, pathKey');
assert(fnStart > -1, 'strip() tidak ditemukan di 05-owner.js');
const fnEnd = src.indexOf('const node = strip(parsed);', fnStart);
const strip = new Function('dropped', src.slice(fnStart, fnEnd) + '\nreturn strip;')([]);

// ── Payload persis seperti yang Pak kirim (dengan wrapper __*) ──
const INPUT = {
  "__source": "quoted",
  "__topKeys": ["buttonsMessage"],
  "__aiRichPaths": [],
  "buttonsMessage": {
    "buttons": [
      { "buttonId": "btnv2_1", "buttonText": { "displayText": "Tombol 1" }, "type": 1 },
      { "buttonId": "btnv2_2", "buttonText": { "displayText": "Tombol 2" }, "type": 1 }
    ],
    "locationMessage": {
      "degreesLatitude": -6.2,
      "degreesLongitude": 106.816666,
      "name": "Moszy AI MD • Button V2",
      "address": "Testing custom thumbnail di location header",
      "jpegThumbnail": { "__type": "bytes", "length": 20497, "preview": "ffd8ffdb004300080808080908090a0a090d0e0c0e0d1311101011131c141614…" }
    },
    "contentText": "Testing ButtonV2 — location header + legacy buttons",
    "footerText": "Moszy Button V2 Test",
    "headerType": 6
  }
};
const clean = (o) => JSON.parse(JSON.stringify(o));

// ── 1. Normalisasi ──
{
  const out = strip(clean(INPUT));
  assert.deepStrictEqual(Object.keys(out), ['buttonsMessage'], 'top-level harus buttonsMessage saja');
  const bm = out.buttonsMessage;
  assert.strictEqual(bm.contentText, 'Testing ButtonV2 — location header + legacy buttons');
  assert.strictEqual(bm.footerText, 'Moszy Button V2 Test');
  assert.strictEqual(bm.headerType, 6, 'headerType 6 = LOCATION');
  assert.strictEqual(bm.buttons.length, 2);
  assert.strictEqual(bm.buttons[0].buttonId, 'btnv2_1');
  assert.strictEqual(bm.buttons[0].buttonText.displayText, 'Tombol 1');
  assert.strictEqual(bm.buttons[0].type, 1, 'type 1 = RESPONSE');
  assert.strictEqual(bm.locationMessage.degreesLatitude, -6.2);
  assert.strictEqual(bm.locationMessage.degreesLongitude, 106.816666);
  assert.strictEqual(bm.locationMessage.name, 'Moszy AI MD • Button V2');
  assert.strictEqual(bm.locationMessage.jpegThumbnail, undefined, 'preview terpotong harus DIBUANG');
  console.log('[PASS] wrapper __* dibuang; teks, 2 button, lokasi utuh');
  console.log('[PASS] jpegThumbnail (preview terpotong) dibuang, bukan byte rusak');
}

// ── 2. Bytes lengkap jadi Buffer ──
{
  const out = strip({ jpegThumbnail: { __type: 'bytes', length: 4, preview: 'ffd8ffdb' } });
  assert.ok(Buffer.isBuffer(out.jpegThumbnail), 'hex lengkap harus jadi Buffer');
  assert.strictEqual(out.jpegThumbnail.toString('hex'), 'ffd8ffdb');
  console.log('[PASS] hex lengkap -> Buffer(4) ffd8ffdb');
}

// ── 3. Tanpa wrapper tetap jalan ──
{
  const out = strip({ buttonsMessage: { buttons: [], contentText: 'x', footerText: 'y', headerType: 1 } });
  assert.deepStrictEqual(Object.keys(out), ['buttonsMessage']);
  console.log('[PASS] tanpa wrapper __* tetap jalan');
}

// ── 4. ENCODE + DECODE proto zapo (yang sebenarnya terjadi saat send) ──
{
  const node = strip(clean(INPUT));
  const enc = proto.Message.encode(node);
  const buf = enc.finish ? enc.finish() : enc;
  const back = proto.Message.decode(buf).buttonsMessage;
  assert.strictEqual(back.contentText, node.buttonsMessage.contentText);
  assert.strictEqual(back.headerType, 6);
  assert.strictEqual(back.buttons.length, 2);
  assert.strictEqual(back.buttons[0].buttonText.displayText, 'Tombol 1');
  assert.strictEqual(back.locationMessage.name, 'Moszy AI MD • Button V2');
  const HT = proto.Message.ButtonsMessage.HeaderType;
  const BT = proto.Message.ButtonsMessage.Button.Type;
  console.log(`[PASS] encode ${buf.length} bytes -> decode utuh`);
  console.log(`[PASS] headerType 6 = ${Object.keys(HT).find(k => HT[k] === 6)}; button type 1 = ${Object.keys(BT).find(k => BT[k] === 1)}`);
}

console.log('\n*** SEMUA CEK LULUS — node valid, pesan akan terkirim ***');
