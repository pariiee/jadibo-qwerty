'use strict';
/**
 * test/antidelete-strip.js
 *
 * Antidelete nyimpen salinan pesan buat dikirim ulang. Salinan itu HARUS cuma
 * metadata: `.media` (buffer hasil unduhan) nggak pernah dibaca — kirim ulang
 * pakai mediaKey/fileSha256/fileEncSha256 lalu unduh ULANG. Kalau buffer-nya
 * ikut disimpen, video 16 MB nginep 2 hari di RAM+disk dan `JSON.stringify`
 * bikin dia jadi 73 MB (Buffer -> array angka, ~4x lipat). 5 pesan kayak gitu
 * = 118 MB file store.
 *
 * Jalankan: node test/antidelete-strip.js
 */
const assert = require('assert');
process.env.SESSIONS_DIR = process.env.SESSIONS_DIR || './sessions';
const { ringkasPesan } = require('../plugins/02-group');

const MB = 1024 * 1024;
const meta = (extra = {}) => ({
  mediaKey: Buffer.alloc(32), fileSha256: Buffer.alloc(32), fileEncSha256: Buffer.alloc(32),
  url: 'https://mmg.whatsapp.net/x', directPath: '/v/y', ...extra,
});

// ── 1. Jalur zapo: video yang udah bawa buffer hasil unduhan ─────────────────
const VIDEO = {
  video: meta({
    media: Buffer.alloc(16 * MB), jpegThumbnail: Buffer.alloc(1231),
    mimetype: 'video/mp4', caption: '📷 Instagram', fileLength: 16741798,
  }),
};
const sebelum = JSON.stringify(VIDEO).length;
const hasil = ringkasPesan(VIDEO);
const sesudah = JSON.stringify(hasil).length;
console.log('── 1. video 16 MB (yang bikin file 73 MB) ──');
console.log(`   sebelum : ${(sebelum / MB).toFixed(1)} MB JSON`);
console.log(`   sesudah : ${sesudah} byte`);
assert.ok(hasil, 'video 16 MB harus tetap disimpen');
assert.ok(sesudah < 2000, `harusnya < 2 KB, dapat ${sesudah} byte`);
assert.ok(sesudah < sebelum / 10000, 'harusnya turun >10.000x');
console.log('   ✓ buffer dibuang, turun >10.000x');

// ── 2. Metadata buat unduh ulang HARUS utuh ──────────────────────────────────
console.log('\n── 2. metadata unduh-ulang utuh ──');
const v = hasil.video;
for (const f of ['mediaKey', 'fileSha256', 'fileEncSha256']) {
  assert.ok(Buffer.isBuffer(v[f]), `${f} harus tetap Buffer`);
  console.log(`   ✓ ${f} (${v[f].length} byte)`);
}
for (const f of ['mimetype', 'caption', 'fileLength', 'url', 'directPath']) {
  assert.ok(v[f] !== undefined, `${f} wajib ada`);
}
console.log('   ✓ mimetype/caption/fileLength/url/directPath ada');
assert.ok(!('media' in v), 'media harus HILANG');
assert.ok(!('jpegThumbnail' in v), 'jpegThumbnail harus HILANG');
console.log('   ✓ media & jpegThumbnail hilang');

// ── 3. Pesan tanpa buffer: jangan disentuh ───────────────────────────────────
console.log('\n── 3. pesan tanpa buffer (dilewatkan apa adanya) ──');
const TEKS = { conversation: 'halo' };
assert.strictEqual(ringkasPesan(TEKS), TEKS);
const EXT = { extendedTextMessage: { text: 'wkwk', contextInfo: { mentionedJid: [] } } };
assert.strictEqual(ringkasPesan(EXT), EXT);
const FOTO_META = { imageMessage: meta({ mimetype: 'image/jpeg', caption: 'foto' }) };
assert.strictEqual(ringkasPesan(FOTO_META), FOTO_META);
console.log('   ✓ conversation / extendedTextMessage / imageMessage-murni');

// ── 4. Batas 20 MB ───────────────────────────────────────────────────────────
console.log('\n── 4. batas 20 MB (pakai fileLength, ukuran video asli) ──');
const PAS = { videoMessage: { ...meta({ fileLength: 20 * MB }), media: Buffer.alloc(20 * MB) } };
assert.ok(ringkasPesan(PAS), 'tepat 20 MB masih boleh');
console.log('   ✓ 20 MB tepat -> masih disimpen');

const LEWAT = { videoMessage: { ...meta({ fileLength: 20 * MB + 1 }), media: Buffer.alloc(20 * MB) } };
assert.strictEqual(ringkasPesan(LEWAT), null, 'di atas 20 MB harus di-skip');
console.log('   ✓ 20 MB + 1 byte -> di-skip (nggak disimpen)');

// tanpa fileLength: jatuh ke ukuran buffer
const NO_LEN = { videoMessage: { ...meta(), media: Buffer.alloc(21 * MB) } };
assert.strictEqual(ringkasPesan(NO_LEN), null, 'fallback ke ukuran buffer');
console.log('   ✓ tanpa fileLength -> fallback ke ukuran buffer');

// ── 5. Jalur non-zapo tetap jalan ────────────────────────────────────────────
console.log('\n── 5. objek tanpa `media` sama sekali ──');
const BAIL = { imageMessage: { mediaKey: Buffer.alloc(32), mimetype: 'image/jpeg', caption: 'foto' } };
assert.strictEqual(ringkasPesan(BAIL), BAIL);
console.log('   ✓ nggak disentuh');

// ── 6. Bentuk 1: hasil normalisasi zapo (hook pesan-terkirim) ────────────────
// INI yang bikin file 134 MB: 72 rekaman, 36,9 MB buffer, semuanya fromMe.
console.log('\n── 6. bentuk normalisasi zapo `{type, media}` ──');
const NORM = {
  type: 'video', media: Buffer.alloc(16 * MB), mimetype: 'video/mp4',
  caption: '📷 Instagram', jpegThumbnail: Buffer.alloc(1231),
};
const nHasil = ringkasPesan(NORM);
assert.ok(nHasil, 'video 16 MB harus tetap disimpen');
assert.strictEqual(JSON.stringify(nHasil).length, JSON.stringify({
  type: 'video', mimetype: 'video/mp4', caption: '📷 Instagram',
}).length);
assert.ok(!('media' in nHasil) && !('jpegThumbnail' in nHasil));
assert.strictEqual(nHasil.caption, '📷 Instagram');
assert.strictEqual(nHasil.mimetype, 'video/mp4');
console.log('   ✓ 16 MB -> ' + JSON.stringify(nHasil).length + ' byte, caption+mimetype utuh');

const nLewat = ringkasPesan({ ...NORM, media: Buffer.alloc(21 * MB) });
assert.strictEqual(nLewat, null, 'di atas 20 MB harus di-skip');
console.log('   ✓ 21 MB -> di-skip');

// Bentuk yang ADA DI FILE: `media` sudah jadi {type:'Buffer',data:[…]}
console.log('\n── 7. bentuk JSON (dari file, buat migrasi) ──');
const JSOND = {
  type: 'video', mimetype: 'video/mp4', caption: 'x',
  media: { type: 'Buffer', data: new Array(16 * MB).fill(0) },
};
const jHasil = ringkasPesan(JSOND);
assert.ok(jHasil && !('media' in jHasil), 'media bentuk JSON harus ikut dibuang');
console.log('   ✓ {type:Buffer,data:[…]} ikut dibuang');

const jLewat = ringkasPesan({
  type: 'video', mimetype: 'video/mp4',
  media: { type: 'Buffer', data: new Array(21 * MB).fill(0) },
});
assert.strictEqual(jLewat, null, 'ukurannya kebaca walau bentuk JSON');
console.log('   ✓ 21 MB bentuk JSON -> di-skip (ukurannya kebaca)');

console.log('\n=== ANTIDELETE: CUMA METADATA YANG DISIMPEN ===');
