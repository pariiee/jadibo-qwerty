'use strict';

/**
 * config/cooldown.js — tabel cooldown per kelompok command.
 *
 * Setiap kelompok = { ms, balasan: bool, daftar }. Cooldown dipusatkan
 * di `engine/cooldown.js` (cooldownGuard) yang dipanggil di dispatcher
 * SEBELUM plugin handler.
 *
 * Cara menambah command baru: taruh di `daftar` kelompok yang sesuai,
 * atau buat kelompok baru. JANGAN tambahkan hardcoded cooldown di
 * masing-masing plugin — penambalan tersebar bikin satu per satu bisa
 * kelewat, dan dispatcher adalah satu titik yang lebih mudah diaudit.
 *
 * Siapa yang KECUALI (opsi A — keputusan Pak):
 *   - HANYA kelompok yang mendefinisikan `pengecualian` yang membebaskan
 *     owner/dev dari cooldown. Saat ini cuma 'umum' (0.5 dtk).
 *   - Semua kelompok lain — 'berat', 'upload', 'judi', 'admin-grup',
 *     'owner-destructive' — TETAP kena untuk owner & dev juga.
 *   - Mau membebaskan kelompok lain? Tambahkan `pengecualian` di kelompok
 *     ITU. Jangan tambal di engine/cooldown.js — perilakunya sengaja
 *     dibaca dari tabel ini supaya satu tempat saja yang menentukan.
 *
 * Mengubah nilai: edit ms, deploy. Tidak perlu restart plugin.
 */
const TABEL = {
  // Anti-flood lembut. Diam, tidak balas. Berlaku untuk SEMUA command
  // yang tidak masuk kelompok lain.
  'umum': {
    ms: 500,
    balasan: false,
    daftar: null,  // null = catch-all (semua command yang tidak masuk kategori lain)
    pengecualian: { isOwner: true, isDev: true },
  },
  // Downloader & ffmpeg (play, tiktok, ig, fb, dll). Balas "⏳ Tunggu X detik"
  // SEKALI per jendela cooldown; pelanggaran berikutnya di jendela sama
  // diam (lihat engine/cooldown.js).
  'berat': {
    ms: 3000,
    balasan: true,
    // Tanpa `pengecualian` = owner & dev TETAP kena (opsi A).
    daftar: [
      // 04-tools — downloader
      'play','tiktok','tiktokdl','ttdl','tt','ttsearch',
      'youtube','ytdl','yt','igdl','ig','instagram',
      'fbdl','fb','facebook','twitter','twit','xdl',
      'soundcloud','scdl','mediafire','mfdl','capcut','capcutdl',
      'douyin','douyindl','bilibili','bilibildl','sfile','sfilemobi','sfileco',
      'lk21','lk21trending','lk21search','filmsearch','xnxx',
      'likee','likeedl','moddroid','moddroiddl','tiktokphoto','ttkphoto',
      'rednote','xiaohongshu','xhs','reddit','redditdl',
      'kuaishou','kwai','kuaishoudl','threads','threadsdl',
      'pindl','spotifydl','genshin','stalkgenshin','minecraft','mc','stalkmc',
      'stalkgithub','ghstalk','stalkroblox','cekroblox','roblox',
      'stalktiktok','stalktt','tiktokstalk','stalkff','ff','freefire',
      'stalkdiscord','discord','stalkchess','chess',
      // Sticker maker juga ffmpeg
      'brat','bratv2','bratvid','sticker','s','wm',
    ],
  },
  // Upload file (tourl, tourl2). Sama dengan 'berat' tapi cooldown lebih
  // panjang karena file bisa gede.
  'upload': {
    ms: 5000,
    balasan: true,
    daftar: ['tourl', 'upload', 'tourl2', 'upload2'],
  },
  // Judi & game berisiko. Tahan spam tanpa mengganggu user legit.
  'judi': {
    ms: 1500,
    balasan: true,
    daftar: [
      'coinflip','cf','slot','gacha',
      'tictactoe','ttt','suitpvp','suit',
      'mancing','berburu','hunt',
    ],
  },
  // Moderasi grup (admin-grup). Anti-flood tombol admin.
  'admin-grup': {
    ms: 3000,
    balasan: true,
    daftar: ['kick','kickall','promote','demote','add','totag','forward'],
  },
  // Owner-only destructive. Anti-typo, bukan anti-spam. Berlaku untuk owner
  // & dev juga — mereka yang paling terdampak mis-click.
  'owner-destructive': {
    ms: 10_000,
    balasan: true,
    daftar: [
      'restart','leaveall','clearsession','cleartmp',
      'broadcast','bc','bcgc','bcgcht',
      'addprem','delprem','addsewa','delsewa','setsewa',
      'addlimit','dellimit','addmoney','delmoney','addxp','delxp',
      'addlevel','dellevel','setbio','setpp','setqris',
      'addrespon','delrespon','addlist','reset',
      'gcutama','setlimitgc','get',
    ],
  },
};

/** Cari kelompok untuk satu command. null = tidak ada (pakai 'umum'). */
function kelompokUntuk(command) {
  for (const [nama, cfg] of Object.entries(TABEL)) {
    if (nama === 'umum') continue;
    if (cfg.daftar && cfg.daftar.includes(command)) return { nama, ...cfg };
  }
  return null;
}

/** Konfigurasi default kalau command tidak masuk kategori manapun. */
function cfgDefault(command) {
  return { nama: 'umum', ...TABEL.umum };
}

module.exports = { TABEL, kelompokUntuk, cfgDefault };
