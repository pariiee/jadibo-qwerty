'use strict';
/**
 * test/swgc-jalur-kirim.js
 *
 * Kenapa tes ini ada — tiga kesalahan berturut-turut di fitur status grup:
 *
 *  1. `relayStatusGrup` didefinisikan DUA KALI di adapter (objek `message` dan
 *     objek `status`). Plugin memanggil yang di `message`, jadi perbaikan di
 *     objek `status` TIDAK BERPENGARUH SAMA SEKALI — stack trace produksi
 *     membuktikan jalurnya masih `WaStatusCoordinator.send`.
 *  2. Isi status berupa `{ conversation: teks }`. `conversation` tidak membawa
 *     `messageContextInfo`, jadi `messageSecret` status tidak ikut; akibatnya WA
 *     menuliskannya ke STATUS PRIBADI pengirim (kejadian di produksi).
 *  3. Node `<meta is_group_status="true"/>` dipaksa lewat `customNodes`
 *     berdasarkan satu payload mentah. Referensi yang TERBUKTI jalan (Baileys)
 *     tidak memakai node itu sama sekali.
 *
 * Sumber kebenarannya `refrensi-botz/plugins/owner-upswtag.js`:
 *
 *   const messageSecret = crypto.randomBytes(32);
 *   { messageContextInfo: { messageSecret },
 *     groupStatusMessageV2: { message: { ...inside, messageContextInfo: { messageSecret } } } }
 */

const fs = require('fs');
const path = require('path');

let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`✅ ${nama}`);
  else { gagal++; console.log(`❌ ${nama}${info ? ' — ' + info : ''}`); }
};

const SRC = fs.readFileSync(path.join(__dirname, '..', 'engine', 'zapo', 'client.js'), 'utf8');
// Buang baris komentar dulu — komentar yang MENYEBUT nama method/atribut ikut
// terhitung dan bikin tesnya hijau palsu.
const kode = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

console.log('=== 1. Cuma SATU relayStatusGrup yang benar-benar mengirim ===');

const deklarasi = [];
const re = /async relayStatusGrup\s*\(/g;
let m;
while ((m = re.exec(kode)) !== null) deklarasi.push(m.index);
const body = deklarasi.map((i) => kode.slice(i, i + 1800));
const pengirim = body.filter((b) => /sendMessage\s*\(/.test(b));

cek(`jumlah deklarasi relayStatusGrup = 1 (ditemukan ${deklarasi.length})`,
  deklarasi.length === 1,
  'dua deklarasi = salah satunya menimpa yang lain, dan pemanggil bisa dapat yang salah');
cek(`jumlah yang benar-benar mengirim = 1 (ditemukan ${pengirim.length})`,
  pengirim.length === 1,
  'kalau ada 2 pengirim, pasti ada implementasi yang menimpa dan bisa tidak terpakai');

console.log('\n=== 2. Kirim lewat jalur GRUP, bukan status story ===');
const b = pengirim[0] || '';
cek('pakai messageDispatch.sendMessage', /sendMessage\s*\(/.test(b));
cek('TIDAK memakai status.send (jalur story, error=479)',
  !/status\?\.\s*send\s*\(/.test(b) && !/client\.status\.send/.test(b),
  'status.send selalu ke STATUS_BROADCAST_JID dengan penerima KONTAK');
cek('membungkus isi dengan groupStatusMessageV2', /groupStatusMessageV2/.test(b));

console.log('\n=== 3. messageSecret di DUA lapis (kunci: status, bukan pesan biasa) ===');
cek('menghasilkan messageSecret 32 byte', /randomBytes\(\s*32\s*\)/.test(b));
const hitungSecret = (b.match(/messageSecret/g) || []).length;
cek(`messageSecret muncul >= 3x (ditemukan ${hitungSecret})`,
  hitungSecret >= 3,
  'sekali bikin, sekali di lapis luar, sekali di dalam groupStatusMessageV2.message');

console.log('\n=== 4. TIDAK memaksa node <meta is_group_status> ===');
cek('tidak ada is_group_status di adapter', !/is_group_status/.test(kode),
  'zapo tidak mengenal atribut itu; referensi yang jalan tidak memakainya');
cek('tidak mengirim customNodes di relayStatusGrup', !/customNodes/.test(b),
  'customNodes mengubah stanza yang terbukti jalan');

console.log('\n=== 5. Pemanggil: kirim ISI-nya, jangan bungkus sendiri ===');
const plugin = fs.readFileSync(path.join(__dirname, '..', 'plugins', '02-group.js'), 'utf8');
const pKode = plugin.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

cek('memanggil client.message.relayStatusGrup',
  /client\.message\.relayStatusGrup\s*\(/.test(pKode),
  'kalau lewat client.status.*, itu jalur story');
cek('pemanggil TIDAK ikut membungkus dengan groupStatusMessageV2',
  !/relayStatusGrup\s*\([^)]*groupStatusMessageV2/.test(pKode),
  'adapter yang membungkus — kalau pemanggil ikut membungkus, jadi bersarang');

console.log('\n=== 6. Isi teks pakai PROTO MENTAH, bukan shorthand zapo ===');
cek('tidak ada `conversation:` di plugins/02-group.js', !/\bconversation\s*:/.test(pKode),
  'conversation tidak bawa messageContextInfo → status pribadi yang ke-update');
cek('tidak mengirim shorthand `{ text: ... }` sama sekali',
  !/=\s*\{\s*text\s*:/.test(pKode),
  'toZapoContent({ text }) → { type: "text" } = bahasa zapo, bukan Proto.IMessage');
cek('pakai `{ extendedTextMessage: { text } }`',
  /\{\s*extendedTextMessage\s*:\s*\{\s*text\s*:/.test(pKode),
  'extendedTextMessage ada di PROTO_KEYS, jadi diteruskan apa adanya');

console.log('');
console.log(gagal ? `=== GAGAL: ${gagal} masalah ===` : '=== SEMUA CEK LULUS ===');
process.exit(gagal ? 1 : 0);
