'use strict';
/**
 * test/prepare-media-bentuk.js
 *
 * Kenapa tes ini ada: `prepareMedia` dipanggil dengan DUA bentuk berbeda di repo
 * ini, dan signature yang cuma menerima satu bentuk gagal TANPA error apa pun.
 *
 *   prepareMedia(buf, 'image/jpeg')                  // bentuk lama (string)
 *   prepareMedia(buf, { type: 'image', mimetype })   // 02-group & 05-owner
 *
 * Kalau bentuk object tidak didukung: `String({...})` = "[object Object]" →
 * tidak diawali `image/` → jenisnya jatuh ke 'document' → balikannya
 * `{ documentMessage }`, sementara pemanggil men-destructure `{ imageMessage }`
 * = undefined. Hasilnya media status grup jadi document kosong, TANPA satu pun
 * error di log — persis gejala ".swgc reply media gagal, tapi teks jalan".
 *
 * Karena itu tes ini MEMANGGIL fungsi aslinya (`normalisasiMedia`), bukan
 * mencocokkan teks sumber — tes teks tidak akan pernah menangkap bug bentuk
 * argumen.
 */

const { normalisasiMedia } = require('../engine/zapo/client.js');

let gagal = 0;
const cek = (nama, dapat, harus) => {
  if (dapat === harus) console.log(`✅ ${nama}`);
  else { gagal++; console.log(`❌ ${nama} — dapat "${dapat}", harus "${harus}"`); }
};

console.log('=== 1. Bentuk OBJECT { type, mimetype } — dipakai 02-group & 05-owner ===');
cek('{ type: image, image/jpeg } -> image',
  normalisasiMedia({ type: 'image', mimetype: 'image/jpeg' }).type, 'image');
cek('{ type: video, video/mp4 }  -> video',
  normalisasiMedia({ type: 'video', mimetype: 'video/mp4' }).type, 'video');
cek('{ type: audio, audio/mp4 }  -> audio',
  normalisasiMedia({ type: 'audio', mimetype: 'audio/mp4' }).type, 'audio');

console.log('\n=== 2. Bentuk STRING mimetype (lama) — harus tetap jalan ===');
cek('image/jpeg -> image', normalisasiMedia('image/jpeg').type, 'image');
cek('video/mp4  -> video', normalisasiMedia('video/mp4').type, 'video');
cek('audio/mp4  -> audio', normalisasiMedia('audio/mp4').type, 'audio');
cek('application/pdf -> document', normalisasiMedia('application/pdf').type, 'document');
cek('kosong -> image (default lama)', normalisasiMedia(undefined).type, 'image');

console.log('\n=== 3. mimetype ikut terbawa, bukan jadi "[object Object]" ===');
cek('mimetype object diteruskan apa adanya',
  normalisasiMedia({ type: 'image', mimetype: 'image/jpeg' }).mimetype, 'image/jpeg');
cek('mimetype string diteruskan apa adanya',
  normalisasiMedia('video/mp4').mimetype, 'video/mp4');

console.log('\n=== 4. Jebakan lama harus tetap terlihat ===');
// Bug aslinya: `String(opsi)` dipakai sebagai mimetype → selalu 'document'.
cek('String(object mentah) -> document (bukti jebakannya nyata)',
  (String({ type: 'image', mimetype: 'image/jpeg' }).startsWith('image/') ? 'image' : 'document'),
  'document');

console.log('');
console.log(gagal ? `=== GAGAL: ${gagal} masalah ===` : '=== SEMUA CEK LULUS ===');
process.exit(gagal ? 1 : 0);
