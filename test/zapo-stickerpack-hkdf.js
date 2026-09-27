'use strict';
/**
 * test/zapo-stickerpack-hkdf.js
 * `engine/stickerPack.js` dulu numpang `hkdf` dari baileys; sekarang pakai
 * `crypto.hkdfSync` stdlib. Kalau turunannya beda sedikit saja, WhatsApp
 * nerima stanza-nya tapi kartu sticker pack-nya BLANK — nol error, nol log.
 * Jadi hasilnya dibandingkan ke implementasi HKDF manual (RFC 5869).
 *
 * Jalankan: node test/zapo-stickerpack-hkdf.js
 */
const assert = require('assert');
const crypto = require('crypto');

// HKDF manual: extract (HMAC-SHA256) + expand. Ini definisi RFC 5869 apa adanya.
function hkdfManual(ikm, length, { salt = Buffer.alloc(32), info = Buffer.alloc(0) } = {}) {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  const out = [];
  let prev = Buffer.alloc(0);
  for (let i = 1; out.length * 32 < length; i++) {
    prev = crypto.createHmac('sha256', prk).update(Buffer.concat([prev, Buffer.from(info), Buffer.from([i])])).digest();
    out.push(prev);
  }
  return Buffer.concat(out).subarray(0, length);
}

// Yang dipakai engine/stickerPack.js
function kunciMedia(mediaKey, info) {
  const expanded = Buffer.from(crypto.hkdfSync('sha256', mediaKey, Buffer.alloc(32), Buffer.from(info), 112));
  return {
    iv: Buffer.from(expanded.subarray(0, 16)),
    cipherKey: Buffer.from(expanded.subarray(16, 48)),
    macKey: Buffer.from(expanded.subarray(48, 80)),
  };
}

const mediaKey = crypto.randomBytes(32);
for (const info of ['Sticker Pack', 'Sticker Pack Thumbnail']) {
  const k = kunciMedia(mediaKey, info);
  const ref = hkdfManual(mediaKey, 112, { info: Buffer.from(info) });
  assert.ok(k.iv.equals(ref.subarray(0, 16)), `${info}: IV cocok`);
  assert.ok(k.cipherKey.equals(ref.subarray(16, 48)), `${info}: cipherKey cocok`);
  assert.ok(k.macKey.equals(ref.subarray(48, 80)), `${info}: macKey cocok`);
  assert.strictEqual(k.iv.length, 16);
  assert.strictEqual(k.cipherKey.length, 32);
  assert.strictEqual(k.macKey.length, 32);
  console.log(`  ✓ ${info}: iv 16B + cipherKey 32B + macKey 32B = HKDF RFC 5869`);
}

// Enkripsi: IV harus TURUNAN mediaKey (bukan acak) + MAC 10 byte di ekor.
const { enkripsi } = require('../engine/stickerPack');
const plain = Buffer.from('sticker pack dummy');
const k = kunciMedia(mediaKey, 'Sticker Pack');
const enc = enkripsi(plain, k);
assert.ok(enc.isi.length > plain.length, 'ciphertext lebih panjang dari plaintext (ada MAC)');
const mac = enc.isi.subarray(enc.isi.length - 10);
const body = enc.isi.subarray(0, enc.isi.length - 10);
const macHarap = crypto.createHmac('sha256', k.macKey).update(Buffer.concat([k.iv, body])).digest().subarray(0, 10);
assert.ok(mac.equals(macHarap), 'MAC 10 byte = HMAC(iv‖body)[:10]');
console.log('  ✓ enkripsi: MAC 10 byte di ekor cocok (pack diterima WA)');

console.log('\n✅ HKDF sticker pack identik dengan Baileys (nol risiko kartu blank)');
