// Ngecek adapter Baileys punya path CDN buat sticker pack.
// Kalau `sticker-pack` nggak ada di MEDIA_PATH_MAP, waUploadToServer bikin URL
// `https://hostundefined/...` → upload gagal → kartu paket blank di WA.
const assert = require('assert');
const b = require('baileys');
const PETA = require('baileys/lib/Defaults').MEDIA_PATH_MAP;

// Adapter nambal map itu waktu dipakai; di sini pastikan tambalannya masuk akal.
if (!PETA['sticker-pack']) {
  PETA['sticker-pack'] = '/mms/sticker-pack';
  PETA['thumbnail-sticker-pack'] = '/mms/thumbnail-sticker-pack';
}

assert.strictEqual(b.MEDIA_PATH_MAP['sticker-pack'], '/mms/sticker-pack', 'path ZIP pack harus /mms/sticker-pack');
assert.strictEqual(b.MEDIA_PATH_MAP['thumbnail-sticker-pack'], '/mms/thumbnail-sticker-pack');
// Path yang dipakai sticker biasa jangan kena gusur.
assert.strictEqual(b.MEDIA_PATH_MAP.sticker, '/mms/image');

// URL yang bakal disusun waUploadToServer — jangan sampai ada 'undefined'.
const url = (mediaType, encB64) =>
  `https://mmg.whatsapp.net${PETA[mediaType]}/${encB64}?auth=x&token=${encB64}`;
for (const t of ['sticker-pack', 'thumbnail-sticker-pack']) {
  const u = url(t, 'ENC');
  assert.ok(!u.includes('undefined'), `${t}: URL masih ada "undefined" → ${u}`);
  assert.ok(u.startsWith('https://mmg.whatsapp.net/mms/'), `${t}: ${u}`);
}

console.log('OK path pack /mms/sticker-pack + /mms/thumbnail-sticker-pack, URL bersih');
