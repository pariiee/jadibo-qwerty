'use strict';

/**
 * config/net.js — paksa SELURUH koneksi keluar lewat IPv4.
 *
 * Host media (googlevideo dkk) mengiklankan AAAA, tapi VPS ini nggak punya
 * rute IPv6: tiap unduhan nyoba IPv6 dulu, mati, lalu IPv4-nya timeout —
 * media gagal terkirim. Terbukti: axios polos GAGAL, agent family:4 berhasil.
 * setDefaultResultOrder('ipv4first') TIDAK cukup (happy-eyeballs tetap nyoba
 * IPv6 lebih dulu). Dulu ditambal `family: 4` di satu pemanggil axios saja,
 * jadi jalur lain tetap kena — sekarang dipasang sekali di sini.
 *
 * Dipakai server.js DAN workers/botWorker.js: dua-duanya narik keluar
 * (web: API downloader; worker: WhatsApp/Telegram).
 */
const https = require('https');
const http = require('http');
const dns = require('dns');

for (const proto of [https, http]) proto.globalAgent = new proto.Agent({ family: 4 });
dns.setDefaultResultOrder('ipv4first');

// Box ini jalan UTC. Semua tanggal yang dilihat user (`.market`, stalking,
// masa aktif sewa, dll) harus WIB — kalau nggak, antara jam 00:00–07:00 WIB
// tanggalnya ketulis kemarin.
// CATATAN: ini cuma menolong kalau engine belum pernah nge-format tanggal.
// Node mengunci zona waktu saat PERTAMA kali dipakai, jadi set setelahnya
// nggak ngefek — makanya startup wajib: `TZ=Asia/Jakarta node server.js`.
process.env.TZ = process.env.TZ || 'Asia/Jakarta';
