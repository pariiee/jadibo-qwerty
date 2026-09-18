'use strict';
/**
 * test/profile-picture.js — kunci kontrak PP (`.ppgc` / `.getpp`):
 *   1. adapter `profile.getProfilePicture` SELALU balikin string url atau null
 *      (Baileys `profilePictureUrl` balikin string, bukan `{ url }` — dulu
 *      call-site baca `pp?.url` → selalu undefined → jatuh ke PP default
 *      pixabay "ikon orang putih" padahal grupnya punya PP)
 *   2. nggak ada PP default palsu lagi — kalau url-nya kosong, bot bilang
 *      "nggak ada PP", bukan ngirim avatar orang putih
 *
 * Jalanin: node test/profile-picture.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { normalizeProfilePicture } = require('../engine/baileys/client');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

ok('string url dilewatkan apa adanya', () => {
  assert.strictEqual(normalizeProfilePicture('https://pps.whatsapp.net/x'), 'https://pps.whatsapp.net/x');
});

ok('bentuk lama { url } tetap kebaca (kompat)', () => {
  assert.strictEqual(normalizeProfilePicture({ url: 'https://pps.whatsapp.net/y' }), 'https://pps.whatsapp.net/y');
});

ok('kosong/undefined -> null (bukan string kosong)', () => {
  for (const v of [undefined, null, '', {}, { url: '' }]) {
    assert.strictEqual(normalizeProfilePicture(v), null, `gagal untuk ${JSON.stringify(v)}`);
  }
});

ok('adapter bungkus hasilnya pakai normalizeProfilePicture', () => {
  const src = read('engine/baileys/client.js');
  assert.match(src, /getProfilePicture: async \(jid, type = 'image'\) => normalizeProfilePicture\(/,
    'adapter nggak normalisasi — call-site bakal baca bentuk mentah lagi');
});

ok('02-group: nggak ada PP default pixabay lagi', () => {
  const src = read('plugins/02-group.js');
  assert.ok(!/cdn\.pixabay\.com/.test(src), 'PP default palsu muncul lagi di 02-group.js');
  assert.ok(!/pp\??\.url/.test(src), 'call-site masih baca `.url` dari hasil getProfilePicture');
});

ok('02-group: PP di-fetch lewat fetchImageBuffer (validasi content-type)', () => {
  const src = read('plugins/02-group.js');
  const pakai = (src.match(/await fetchImageBuffer\(/g) || []).length;
  assert.ok(pakai >= 2, `fetchImageBuffer cuma dipakai ${pakai}x — .getpp/.ppgc harus lewat situ`);
});

console.log(`\nprofile-picture: ${pass}/${pass} PASS`);
