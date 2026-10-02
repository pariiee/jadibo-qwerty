'use strict';
/**
 * test/swgc-laporan-jujur.js
 *
 * `.swgc` (status grup) sudah lama "berhasil" di mata user: emoji ✅ muncul,
 * tapi statusnya tidak pernah jadi, dan nol pemberitahuan.
 *
 * Akarnya dua lapis:
 *
 *  1. zapo 1.9.0 tidak punya jalur kirim `groupStatusMessageV2`. Semua kirim
 *     lewat `STATUS_BROADCAST_JID` dengan daftar KONTAK sebagai penerima, jadi
 *     jid `@g.us` di situ selalu ditolak server → `error=479 SMAX_INVALID`.
 *  2. Kode menelan penolakan itu: `catch` menyaring string 'negative publish
 *     ack' dan menganggapnya "400 policy yang boleh dibuang" — padahal 479 juga
 *     berbentuk 'negative publish ack'. Lalu `react('✅')` tetap dijalankan.
 *
 * Tes ini mengunci lapis 2: apa pun yang gagal, user HARUS diberi tahu, dan
 * centang ✅ tidak boleh muncul saat kirimnya gagal.
 */

const fs = require('fs');
const path = require('path');

let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`✅ ${nama}`);
  else { gagal++; console.log(`❌ ${nama}${info ? ' — ' + info : ''}`); }
};

const SUMBER = path.join(__dirname, '..', 'plugins', '02-group.js');
const src = fs.readFileSync(SUMBER, 'utf8');

// Ambil blok `case 'swgc':` ... sampai `case ` berikutnya.
const mulai = src.indexOf("case 'swgc':");
const akhir = src.indexOf('\n    // ── default', mulai);
const blok = src.slice(mulai, akhir > 0 ? akhir : mulai + 4000);
cek('blok case swgc ditemukan', mulai > 0 && blok.length > 500, `panjang ${blok.length}`);

console.log('\n=== LAPIS 2: kegagalan tidak boleh ditelan ===');

// 1. Tidak ada lagi penyaringan yang membuang 'negative publish ack'.
cek('tidak ada lagi `includes(\'negative publish ack\')` yang menelan error',
  !/includes\(\s*['"]negative publish ack['"]\s*\)/.test(blok));

// 2. react('✅') harus berada DI DALAM try, setelah kirim sukses.
const idxTry     = blok.indexOf('try {');
const idxRelay   = blok.indexOf('relayStatusGrup');
const idxReact   = blok.indexOf("react('✅')");
const idxCatch   = blok.indexOf('} catch (e) {', idxRelay);
cek('relayStatusGrup dipanggil', idxRelay > 0);
cek('react(\'✅\') ada', idxReact > 0);
cek("react('✅') SESUDAH relayStatusGrup", idxReact > idxRelay,
  `relay@${idxRelay} react@${idxReact}`);
cek("react('✅') DI DALAM try (sebelum catch-nya)", idxReact < idxCatch,
  `react@${idxReact} catch@${idxCatch} — kalau sesudah catch, centang keluar walau gagal`);

// 3. Ada `reply(...)` di blok catch-nya.
const blokCatch = blok.slice(idxCatch, idxCatch + 900);
cek('catch memanggil reply(...) — user diberi tahu',
  /await reply\(/.test(blokCatch), blokCatch.slice(0, 120).replace(/\s+/g, ' '));
cek('catch melaporkan kegagalan (kata "gagal" / "menolak")',
  /gagal|menolak/i.test(blokCatch));

// 4. Pembedaan 400 vs 479 harus BENAR: 479 BUKAN policy yang boleh didiamkan.
const idxPolicy = blokCatch.indexOf('policyWA');
cek('ada pembedaan policyWA (400 polos) vs error lain',
  idxPolicy > 0, 'tanpa ini, 479 diperlakukan sama seperti 400');
const barisPolicy = blokCatch.slice(idxPolicy, idxPolicy + 200);
cek('policyWA mensyaratkan 400 DAN mengecualikan 479',
  /\\b400\\b/.test(barisPolicy) && /\\b479\\b/.test(barisPolicy),
  barisPolicy.split('\n')[0]?.trim());

console.log('\n=== LAPIS 1: batasan zapo dicatat di kode, bukan di kepala ===');
cek('komentar menyebut groupStatusMessageV2 tidak punya jalur kirim',
  /groupStatusMessageV2/.test(blok));
cek('komentar menyebut kode error 479 / SMAX_INVALID',
  /479|SMAX_INVALID/.test(blok));

console.log('\n=== Deskripsi command tidak menyesatkan lagi ===');
const info = fs.readFileSync(path.join(__dirname, '..', 'config', 'commandInfo.js'), 'utf8');
const m = info.match(/"swgc"\s*:\s*"([^"]+)"/);
cek('deskripsi swgc ada', !!m, String(m));
cek('deskripsi BUKAN "Simpan pengaturan grup" (itu deskripsi yang salah)',
  !/simpan pengaturan/i.test(m?.[1] || ''), `sekarang: "${m?.[1]}"`);
cek('deskripsi menyebut apa yang sebenarnya dilakukan / batasannya',
  /status|grup/i.test(m?.[1] || ''), `sekarang: "${m?.[1]}"`);

console.log('');
console.log(gagal ? `=== GAGAL: ${gagal} masalah ===` : '=== SEMUA CEK LULUS ===');
process.exit(gagal ? 1 : 0);
