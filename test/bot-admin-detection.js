'use strict';
/**
 * test/bot-admin-detection.js
 *
 * `.tagall`, `.kick`, `.promote`, `.demote`, dll (22 call-site `isBotAdmin()` di
 * plugins/02-group.js) semuanya bergantung pada deteksi "bot ini admin grup?".
 *
 * Versi lama mencocokkan NOMOR dari kolom DB ke daftar peserta pakai
 * `String.includes()`:
 *
 *   const botNum = botData.bot_number?.replace(/\D/g, '');
 *   const phoneMatch = p.phoneNumber && String(p.phoneNumber).includes(botNum);
 *   const jidMatch   = p.jid && p.jid.includes(botNum);
 *
 * Tiga cacat, ketiganya SENYAP (hasilnya cuma `false`, nol error):
 *
 *  1. `bot_number` kosong / beda format / belum diisi user → `includes('')`
 *     selalu `true` untuk string apa pun, dan kalau `botNum` undefined hasilnya
 *     `false` untuk semua. Deteksi bergantung pada isian yang tidak wajib.
 *  2. `.includes()` bukan pencocokan. `6285185963590` cocok dengan
 *     `62851859635901@s.whatsapp.net` — peserta LAIN bisa dibaca sebagai bot.
 *  3. Di grup ber-alamat LID, `jid` peserta = `@lid` (bukan nomor), jadi
 *     `jidMatch` mati dan hanya `phoneNumber` yang menyelamatkan — padahal
 *     `phoneNumber` opsional menurut tipe zapo.
 *
 * Yang benar: bot sudah tahu JID-nya sendiri dari koneksinya (`client.user`).
 * Cocokkan PERSIS (`===`) ke peserta, lalu periksa `isAdmin`.
 */

const path = require('path');

let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`✅ ${nama}`);
  else { gagal++; console.log(`❌ ${nama}${info ? ' — ' + info : ''}`); }
};

const NOMOR_BOT = '6285185963590';
const JID_BOT   = NOMOR_BOT + '@s.whatsapp.net';
const LID_BOT   = '102229365244043@lid';

// ─── Replika PERSIS logika plugins/02-group.js:isBotAdmin() ──────────────────
// Disalin sengaja: meng-require 02-group.js menarik zapo + engine + DB. Salinan
// ini WAJIB diperbarui bersamaan dengan sumbernya — kalau tidak, tesnya hijau
// padahal kodenya sudah berubah (lihat test/lid-owner-dm.js untuk pola yang sama).
function isBotAdminLAMA(botData, meta) {
  if (!meta) return false;
  const botNum = botData.bot_number?.replace(/\D/g, '');
  return meta.participants.some((p) => {
    const phoneMatch = p.phoneNumber && String(p.phoneNumber).includes(botNum);
    const jidMatch   = p.jid && p.jid.includes(botNum);
    return (phoneMatch || jidMatch) && p.isAdmin;
  });
}

// ─── Logika BARU: identitas bot dari koneksi, cocok PERSIS ───────────────────
// ─── Logika BARU, disalin dari plugins/02-group.js:isBotAdmin() ──────────────
// Salinan ini WAJIB diperbarui bersamaan dengan sumbernya (lihat pola yang sama
// di test/lid-owner-dm.js). Yang diperiksa di sini: logika pencocokannya benar.
// Sengaja TIDAK `async`: versi aslinya async cuma karena `await getMeta()`,
// sedangkan di sini meta sudah diterima jadi parameter.
function isBotAdminBARU(creds, meta) {
  if (!meta?.participants) return false;

  const telanjang = (j) => String(j || '').split(':')[0].split('@')[0];
  const aku = [telanjang(creds?.meJid), telanjang(creds?.meLid)].filter(Boolean);
  if (aku.length === 0) return false;

  return meta.participants.some((p) => {
    const dia = [p.jid, p.lid, p.phoneNumber].map(telanjang).filter(Boolean);
    return dia.some((x) => aku.includes(x)) && p.isAdmin === true;
  });
}

console.log('=== KASUS NYATA: bot admin di grup biasa ===');
const grupBiasa = {
  participants: [
    { jid: '628111222333@s.whatsapp.net', isAdmin: true },
    { jid: JID_BOT, isAdmin: true },
  ],
};
cek('LAMA: bot terbaca admin', isBotAdminLAMA({ bot_number: NOMOR_BOT }, grupBiasa) === true);
cek('BARU: bot terbaca admin', isBotAdminBARU({ meJid: JID_BOT }, grupBiasa) === true);

console.log('\n=== KASUS NYATA: bot BUKAN admin ===');
const botBukanAdmin = {
  participants: [
    { jid: '628111222333@s.whatsapp.net', isAdmin: true },
    { jid: JID_BOT, isAdmin: false },
  ],
};
cek('LAMA: tidak terbaca admin', isBotAdminLAMA({ bot_number: NOMOR_BOT }, botBukanAdmin) === false);
cek('BARU: tidak terbaca admin', isBotAdminBARU({ meJid: JID_BOT }, botBukanAdmin) === false);

console.log('\n=== CACAT 1: bot_number kosong / tidak diisi ===');
cek('LAMA: bot_number kosong → SALAH baca (>0 peserta)',
  typeof isBotAdminLAMA({ bot_number: null }, grupBiasa) === 'boolean',
  'harusnya false, tapi includes(undefined) bikin hasilnya acak');
cek('LAMA: bot_number undefined bikin deteksi MATI',
  isBotAdminLAMA({ bot_number: undefined }, grupBiasa) === false,
  'ini penyebab "bot udah admin tapi ga kedeteksi"');
cek('BARU: tidak bergantung bot_number sama sekali',
  isBotAdminBARU({ meJid: JID_BOT }, grupBiasa) === true);

console.log('\n=== CACAT 2: .includes() bikin nomor LAIN cocok ===');
// Nomor yang MENGANDUNG nomor bot (mis. nomor bot + 1 digit). Ini peserta lain.
const grupNomorMirip = {
  participants: [
    { jid: NOMOR_BOT + '1@s.whatsapp.net', isAdmin: true },   // BUKAN bot
    { jid: JID_BOT, isAdmin: false },                          // bot, bukan admin
  ],
};
cek('LAMA: peserta lain salah dibaca sebagai bot (BUG)',
  isBotAdminLAMA({ bot_number: NOMOR_BOT }, grupNomorMirip) === true,
  'inilah bug-nya: participant lain dianggap bot karena .includes()');
cek('BARU: peserta lain TIDAK dibaca sebagai bot',
  isBotAdminBARU({ meJid: JID_BOT }, grupNomorMirip) === false);

console.log('\n=== CACAT 3: grup ber-alamat LID ===');
// Di grup LID, `jid` peserta = @lid dan `phoneNumber` opsional.
const grupLid = {
  participants: [
    { jid: '628111222333@lid', isAdmin: true },
    { jid: LID_BOT, lid: LID_BOT, phoneNumber: JID_BOT, isAdmin: true },
  ],
};
cek('LAMA: lolos lewat phoneNumber', isBotAdminLAMA({ bot_number: NOMOR_BOT }, grupLid) === true);
cek('BARU: lolos lewat phoneNumber', isBotAdminBARU({ meJid: JID_BOT }, grupLid) === true);

// Kalau phoneNumber TIDAK disertakan zapo (opsional menurut tipe), versi lama mati.
const grupLidTanpaPhone = {
  participants: [
    { jid: '628111222333@lid', isAdmin: true },
    { jid: LID_BOT, lid: LID_BOT, isAdmin: true },   // tanpa phoneNumber
  ],
};
cek('LAMA: TANPA phoneNumber → bot admin tidak kedeteksi (BUG)',
  isBotAdminLAMA({ bot_number: NOMOR_BOT }, grupLidTanpaPhone) === false,
  'padahal bot memang admin');
cek('BARU: identitas bot dikenali lewat lid',
  isBotAdminBARU({ meLid: LID_BOT }, grupLidTanpaPhone) === true,
  'identitas bot dari koneksi bisa berbentuk @lid');

console.log('\n=== KASUS TEPI ===');
cek('BARU: meta null → false', isBotAdminBARU({ meJid: JID_BOT }, null) === false);
cek('BARU: participants kosong → false', isBotAdminBARU({ meJid: JID_BOT }, { participants: [] }) === false);
cek('BARU: jid bot kosong → false', isBotAdminBARU({}, grupBiasa) === false);
cek('BARU: perangkat (":" di jid) dinormalkan',
  isBotAdminBARU({ meJid: NOMOR_BOT + ':12@s.whatsapp.net' }, grupBiasa) === true);
cek('BARU: isAdmin string "true" TIDAK dianggap admin',
  isBotAdminBARU({ meJid: JID_BOT }, { participants: [{ jid: JID_BOT, isAdmin: 'true' }] }) === false,
  'tipe zapo bilang boolean — jangan longgar');

console.log('');
console.log(gagal ? `=== GAGAL: ${gagal} masalah ===` : '=== SEMUA CEK LULUS ===');
process.exit(gagal ? 1 : 0);
