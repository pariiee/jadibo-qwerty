'use strict';

/**
 * config/mess.js
 * Pesan standar bot yang bisa dikustomisasi via .env
 */

const mess = {
  // Sticker
  packname: process.env.STICKER_PACK_NAME || 'YaaParBot',
  author:   process.env.STICKER_AUTHOR    || 'yapari.web.id',

  // Footer global
  footer: process.env.FOOTER_TEXT || 'Powered by YaaParBot',

  // Pesan umum
  loading:    process.env.MSG_LOADING       || '⏳ Tunggu sebentar...',
  error:      process.env.MSG_ERROR         || 'Terjadi kesalahan, coba lagi nanti!',
  invLink:    process.env.MSG_INVALID_LINK  || 'Link yang kamu masukkan tidak valid!',
  call:       process.env.MSG_CALL          || 'Dilarang menelepon bot!',
  timeout:    process.env.MSG_TIMEOUT       || 'Waktu permintaan telah habis (timeout).',

  // React emoji (dipakai sebagai react pada pesan, bukan teks reply)
  reactLoading: process.env.REACT_LOADING || '⏳',
  reactSuccess: process.env.REACT_SUCCESS || '✅',
  reactError:   process.env.REACT_ERROR   || '❌',

  // Pembatasan akses
  OnlyGroup:    process.env.MSG_ONLY_GROUP     || 'Fitur ini hanya dapat digunakan di dalam grup!',
  OnlyPM:       process.env.MSG_ONLY_PM        || 'Fitur ini hanya dapat digunakan di chat pribadi!',
  GrupAdmin:    process.env.MSG_ONLY_ADMIN     || 'Fitur ini khusus untuk Admin grup!',
  BotAdmin:     process.env.MSG_BOT_MUST_ADMIN || 'Jadikan bot sebagai Admin grup terlebih dahulu!',
  ownerOnly:    process.env.MSG_ONLY_OWNER     || 'Fitur ini khusus untuk Owner bot!',
  limitExceeded:process.env.MSG_LIMIT_EXCEEDED || 'Limit penggunaan kamu sudah habis!',
  onlyPremium:  process.env.MSG_ONLY_PREMIUM   || 'Fitur ini khusus untuk Member Premium!',
  onlySewa:     process.env.MSG_ONLY_SEWA      || 'Grup ini belum menyewa bot!',

  // QRIS
  qrisDefault:  process.env.QRIS_DEFAULT        || '',

  // ── Teks default jadwal buka/tutup grup (dipakai kalau .setopen/.setclose
  //    diset tanpa teks pengumuman) ─────────────────────────────────────────
  openDefault:  process.env.DEFAULT_SETOPEN  || '',
  closeDefault: process.env.DEFAULT_SETCLOSE || '',

  // ── Teks template welcome/bye (dipakai kalau .setwelcome/.setbye belum diset)
  //    Placeholder: @user @usertag @subject @groupname @namegc @desc @jam
  //    @menit @detik @hari @tanggal @bulan @tahun @namabulan
  welcomeDefault: process.env.DEFAULT_WELCOME || '',
  byeDefault:     process.env.DEFAULT_SETBYE  || '',
};

module.exports = mess;
