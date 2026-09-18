'use strict';

/**
 * engine/template.js
 * Render teks template (.setwelcome / .setbye / .setopen / .setclose / …).
 * SATU tempat render — dipakai engine/whatsappEngine.js (member join/left) dan
 * server.js (cron jadwal buka/tutup grup), biar placeholder-nya konsisten.
 */

const HARI  = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const BULAN = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

// Urutan PENTING: yang lebih panjang dulu, kalau nggak '@tagsendiri' bakal makan
// '@tagsend' dan hasilnya "@628xxx dir". `usertag`/`sender`/`subject`/`groupname`
// tinggal alias lama biar teks yang sudah tersimpan di DB tetap ke-render —
// sengaja nggak didaftarkan di VAR_INFO/VAR_ORDER (lihat catatan di bawah).
const KEYS = [
  'groupname', 'subject', 'namegc', 'usertag', 'tagreply', 'tagdiri',
  'pesanan', 'namabulan', 'tanggal', 'bulan', 'tahun', 'hari',
  'detik', 'menit', 'jam', 'desc', 'user', 'sender',
];

const RE = new RegExp(`@(${KEYS.join('|')})`, 'g');

// Waktu WIB (bot & cron pakai Asia/Jakarta)
function wib(now) {
  return new Date(new Date(now).toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
}

/**
 * renderTemplate(teks, ctx) -> { text, mentions }
 * ctx: { groupName, groupDesc, target, sender, replyTo, pesanan, now }
 */
function renderTemplate(teks, ctx = {}) {
  if (!teks) return { text: '', mentions: [] };

  const now      = wib(ctx.now || new Date());
  const mentions = [];

  const tag = (jid) => {
    if (!jid) return '';
    const j = String(jid);
    if (!mentions.includes(j)) mentions.push(j);
    // '@123:4@s.whatsapp.net' -> '123'
    return `@${j.split('@')[0].split(':')[0]}`;
  };

  const map = {
    groupname: ctx.groupName || '',
    subject:   ctx.groupName || '',
    namegc:    ctx.groupName || '',
    desc:      ctx.groupDesc || '',
    usertag:   tag(ctx.target || ctx.user),
    user:      tag(ctx.target || ctx.user),
    tagdiri:   tag(ctx.sender),
    sender:    tag(ctx.sender),
    tagreply:  tag(ctx.replyTo),
    pesanan:   ctx.pesanan || '',
    jam:       String(now.getHours()).padStart(2, '0'),
    menit:     String(now.getMinutes()).padStart(2, '0'),
    detik:     String(now.getSeconds()).padStart(2, '0'),
    hari:      HARI[now.getDay()],
    tanggal:   String(now.getDate()),
    bulan:     String(now.getMonth() + 1),
    tahun:     String(now.getFullYear()),
    namabulan: BULAN[now.getMonth()],
  };

  const text = String(teks).replace(RE, (match, key) => (key in map ? map[key] : match));
  return { text, mentions };
}

// Daftar variable buat `.catatan` — sumbernya KEYS di atas, biar nggak beda.
// ponytail: `groupname` & `subject` masih ADA di KEYS/map (template lama yang
// sudah tersimpan di DB tetap ke-render), tapi sengaja nggak didaftarkan di sini
// — nama grup cukup `@namegc`. Hapus dari KEYS juga kalau nggak ada teks lama.
const VAR_INFO = {
  namegc:    'Nama grup',
  user:      'Tag member (yang join/keluar)',
  tagdiri:   'Tag pengirim',
  tagreply:  'Tag orang yang di-reply',
  jam:       'Jam sekarang',
  menit:     'Menit sekarang',
  detik:     'Detik sekarang',
  hari:      'Hari sekarang',
  tanggal:   'Tanggal sekarang',
  bulan:     'Bulan sekarang (angka)',
  tahun:     'Tahun sekarang',
  namabulan: 'Nama bulan sekarang',
  desc:      'Deskripsi grup',
  pesanan:   'Isi pesanan (khusus setproses/setdone)',
};

const VAR_ORDER = [
  'namegc', 'user', 'tagdiri', 'tagreply',
  'jam', 'menit', 'detik', 'hari', 'tanggal', 'bulan', 'tahun', 'namabulan', 'desc', 'pesanan',
];

// Teks bantuan: `.catatan` = semua, atau filter per perintah.
function catatan(perintah) {
  const list = VAR_ORDER.filter((k) => VAR_INFO[k]);
  const lines = [`┌─ *VARIABEL ${perintah ? String(perintah).toUpperCase() : 'TEMPLATE'}*`];
  list.forEach((k, i) => {
    lines.push(`▢ *@${k}* : ${VAR_INFO[k]}`);
    if (i === list.length - 1) lines.push('└──────────────');
  });
  return lines.join('\n');
}

module.exports = { renderTemplate, catatan };
