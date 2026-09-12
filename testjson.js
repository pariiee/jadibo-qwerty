'use strict';
// Self-check .test (render JSON ATAU kode JS -> WA).
// Jalankan: node testjson.js
// Menguji kode strip() ASLI dari plugins/05-owner.js, bukan salinannya.
const fs = require('fs');
const assert = require('assert');
const { proto } = require('zapo-js');

// ── Ambil fungsi strip() langsung dari plugin ──
const src = fs.readFileSync('plugins/05-owner.js', 'utf8');
const fnStart = src.indexOf('const strip = (o, pathKey');
assert(fnStart > -1, 'strip() tidak ditemukan di 05-owner.js');
const fnEnd = src.indexOf('const node = strip(seed);', fnStart);
assert(fnEnd > fnStart, 'pemanggilan strip(seed) tidak ditemukan');
const strip = new Function('dropped', src.slice(fnStart, fnEnd) + '\nreturn strip;')([]);

// ── Tiru parse pipeline plugin: JSON dulu, gagal -> kode JS ──
const parse = (raw) => {
  const clean = String(raw).replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim();
  try { return { ok: true, via: 'json', val: JSON.parse(clean) }; }
  catch {
    try { return { ok: true, via: 'code', val: new Function(`return (${clean})`)() }; }
    catch (e) { return { ok: false, err: e.message }; }
  }
};

const FULL_JSON = {
  "__source": "quoted",
  "__topKeys": ["buttonsMessage"],
  "__aiRichPaths": [],
  "buttonsMessage": {
    "buttons": [
      { "buttonId": "btnv2_1", "buttonText": { "displayText": "Tombol 1" }, "type": 1 },
      { "buttonId": "btnv2_2", "buttonText": { "displayText": "Tombol 2" }, "type": 1 }
    ],
    "locationMessage": {
      "degreesLatitude": -6.2, "degreesLongitude": 106.816666,
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

// ── 1. INPUT KODE JS (bukan JSON) — ini yang Pak mau ──
const CODE_INPUT = `{
  buttonsMessage: {
    buttons: [
      { buttonId: 'btnv2_1', buttonText: { displayText: 'Tombol 1' }, type: 1 },
      { buttonId: 'btnv2_2', buttonText: { displayText: 'Tombol 2' }, type: 1 }
    ],
    locationMessage: {
      degreesLatitude: -6.2, degreesLongitude: 106.816666,
      name: 'Moszy AI MD • Button V2',
      address: 'Testing custom thumbnail di location header'
    },
    contentText: 'Testing ButtonV2 — location header + legacy buttons',
    footerText: 'Moszy Button V2 Test',
    headerType: 6
  }
}`;
{
  const p = parse(CODE_INPUT);
  assert.ok(p.ok, `kode JS harus bisa di-parse: ${p.err}`);
  assert.strictEqual(p.via, 'code', 'harus lewat jalur kode (bukan JSON)');
  const node = strip(p.val);
  assert.deepStrictEqual(Object.keys(node), ['buttonsMessage']);
  assert.strictEqual(node.buttonsMessage.headerType, 6);
  assert.strictEqual(node.buttonsMessage.buttons.length, 2);
  console.log('[PASS] INPUT KODE JS (tanpa kutip key) -> node valid');
}

// ── 2. INPUT JSON (tetap jalan, buat backward-compat) ──
{
  const p = parse(JSON.stringify(FULL_JSON));
  assert.strictEqual(p.via, 'json');
  const node = strip(p.val);
  const bm = node.buttonsMessage;
  assert.strictEqual(bm.headerType, 6, 'headerType 6 = LOCATION');
  assert.strictEqual(bm.buttons[0].buttonText.displayText, 'Tombol 1');
  assert.strictEqual(bm.locationMessage.degreesLatitude, -6.2);
  assert.strictEqual(bm.locationMessage.jpegThumbnail, undefined, 'preview terpotong harus DIBUANG');
  assert.strictEqual(node.__source, undefined, 'wrapper __* harus dibuang');
  console.log('[PASS] INPUT JSON -> node valid; jpegThumbnail terpotong dibuang');
}

// ── 3. Kode PAKAI Buffer asli (jpegThumbnail dari fs.readFileSync) ──
{
  const code = `({ buttonsMessage: { contentText: 'x', footerText: 'y', headerType: 4, buttons: [],
    imageMessage: { jpegThumbnail: Buffer.from('ffd8ffdb', 'hex'), mimetype: 'image/jpeg' } } })`;
  const p = parse(code);
  assert.ok(p.ok, `kode pakai Buffer harus jalan: ${p.err}`);
  const node = strip(p.val);
  assert.ok(Buffer.isBuffer(node.buttonsMessage.imageMessage.jpegThumbnail), 'Buffer asli harus lewat utuh');
  assert.strictEqual(node.buttonsMessage.imageMessage.jpegThumbnail.toString('hex'), 'ffd8ffdb');
  console.log('[PASS] kode pakai Buffer asli -> Buffer utuh (nggak dirusak strip)');
}

// ── 4. Teks command mentah ".test" -> pesan pakai, bukan crash ──
{
  const p = parse('.test');
  assert.ok(!p.ok, '".test" memang bukan JSON/kode — harus ketahuan kosong duluan');
  console.log('[PASS] ".test" polos dikenali bukan payload (ditangani cek panjang)');
}

// ── 5. ENCODE + DECODE proto zapo (yang sebenarnya terjadi saat send) ──
{
  const node = strip(parse(CODE_INPUT).val);
  const enc = proto.Message.encode(node);
  const buf = enc.finish ? enc.finish() : enc;
  const back = proto.Message.decode(buf).buttonsMessage;
  assert.strictEqual(back.headerType, 6);
  assert.strictEqual(back.buttons.length, 2);
  assert.strictEqual(back.buttons[0].buttonId, 'btnv2_1');
  assert.strictEqual(back.locationMessage.name, 'Moszy AI MD • Button V2');
  const HT = proto.Message.ButtonsMessage.HeaderType;
  const BT = proto.Message.ButtonsMessage.Button.Type;
  console.log(`[PASS] encode ${buf.length} bytes -> decode utuh`);
  console.log(`[PASS] headerType 6 = ${Object.keys(HT).find(k => HT[k] === 6)}; button type 1 = ${Object.keys(BT).find(k => BT[k] === 1)}`);
}

console.log('\n*** SEMUA CEK LULUS — node valid, pesan akan terkirim ***');
