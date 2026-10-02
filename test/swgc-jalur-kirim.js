'use strict';
/**
 * test/swgc-jalur-kirim.js
 *
 * Kenapa tes ini ada: perbaikan `.swgc` sebelumnya TIDAK BERPENGARUH SAMA
 * SEKALI karena `relayStatusGrup` didefinisikan DUA KALI di adapter —
 * satu di objek `message` (masih `status.send`, jalur story/lama) dan satu di
 * objek `status` (jalur grup yang baru). Plugin memanggil `client.message.*`,
 * jadi yang benar tidak pernah terpakai, dan stack trace produksi tetap
 * menunjuk `WaStatusCoordinator.send`.
 *
 * Mengerjakan ulang tanpa tes = mengulang kesalahan yang sama. Tes ini membaca
 * adapter sebagai TEKS dan memastikan:
 *   1. hanya ada SATU implementasi relayStatusGrup yang benar-benar mengirim,
 *   2. implementasi itu memakai messageDispatch + node `<meta is_group_status>`,
 *   3. TIDAK memakai `status.send` (jalur story yang terbukti error=479).
 */

const fs = require('fs');
const path = require('path');

let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`✅ ${nama}`);
  else { gagal++; console.log(`❌ ${nama}${info ? ' — ' + info : ''}`); }
};

const SRC = fs.readFileSync(path.join(__dirname, '..', 'engine', 'zapo', 'client.js'), 'utf8');

console.log('=== 1. Cuma SATU relayStatusGrup yang benar-benar mengirim ===');

// Buang baris komentar dulu — kalau tidak, komentar yang MENYEBUT nama method
// ikut terhitung dan tesnya jadi bohong.
const kode = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const deklarasi = [];
const re = /async relayStatusGrup\s*\(/g;
let m;
while ((m = re.exec(kode)) !== null) deklarasi.push(m.index);

// Body tiap deklarasi (sampai 1200 char setelahnya) buat diperiksa isinya.
const body = deklarasi.map((i) => kode.slice(i, i + 1200));
// Yang "benar-benar mengirim" = body-nya menyentuh jalur kirim.
const pengirim = body.filter((b) => /sendMessage\s*\(|message\.send\s*\(/.test(b));

cek(`jumlah deklarasi relayStatusGrup = 1 (ditemukan ${deklarasi.length})`,
  deklarasi.length === 1,
  'dua deklarasi = salah satunya menimpa yang lain, dan pemanggil bisa dapat yang salah');
cek(`jumlah yang benar-benar mengirim = 1 (ditemukan ${pengirim.length})`,
  pengirim.length === 1,
  'kalau ada 2 pengirim, pasti ada implementasi yang menimpa dan bisa tidak terpakai');

console.log('\n=== 2. Kirim lewat jalur GRUP, bukan status story ===');

for (const [i, b] of pengirim.entries()) {
  const label = `pengirim#${i}`;
  cek(`${label}: pakai messageDispatch.sendMessage`, /sendMessage\s*\(/.test(b));
  cek(`${label}: kirim node <meta is_group_status="true">`,
    /is_group_status/.test(b) && /tag:\s*'meta'/.test(b),
    'tanpa node ini, WA tidak tahu ini status grup');
  // `status.send` mengirim ke STATUS_BROADCAST_JID + daftar kontak → 479.
  cek(`${label}: TIDAK memakai status.send (jalur story, error=479)`,
    !/status\?\.\s*send\s*\(/.test(b) && !/client\.status\.send/.test(b),
    'status.send selalu ke STATUS_BROADCAST_JID dengan penerima KONTAK');
}

console.log('\n=== 3. Ada jalur cadangan yang jujur, bukan diam ===');
const gabungan = pengirim.join('\n');
cek('ada fallback ke message.send kalau messageDispatch tidak ada',
  /return\s+message\.send\s*\(/.test(gabungan));
cek('fallback memberi tahu lewat console.warn (bukan diam)',
  /console\.warn\s*\(/.test(gabungan),
  'logger.warn tidak ada di adapter — itu ReferenceError di jalur cadangan');
cek('tidak memakai `logger.` (tidak didefinisikan di file ini)',
  !/\blogger\./.test(gabungan));

console.log('\n=== 4. Pemanggil di plugin mengarah ke method yang benar ===');
const plugin = fs.readFileSync(path.join(__dirname, '..', 'plugins', '02-group.js'), 'utf8');
cek('plugins/02-group.js memanggil client.message.relayStatusGrup',
  /client\.message\.relayStatusGrup\s*\(/.test(plugin),
  'kalau dipanggil lewat client.status.*, itu jalur story');

console.log('');
console.log(gagal ? `=== GAGAL: ${gagal} masalah ===` : '=== SEMUA CEK LULUS ===');
process.exit(gagal ? 1 : 0);
