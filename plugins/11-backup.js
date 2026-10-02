'use strict';

/**
 * plugins/11-backup.js — `.backup`: cadangkan data SATU bot ke satu file JSON,
 * kirim ke owner lewat WhatsApp, lalu file-nya DIBUANG dari server.
 *
 * Kenapa ada: tidak ada backup sama sekali di box (crontab kosong, nol file
 * .sql). Isinya akun, order, dan data RPG puluhan member. `mysqldump` seluruh
 * DB bukan pilihan di sini — yang diminta owner adalah cadangan MILIKNYA
 * SENDIRI, dikirim sebagai file, lalu server tidak menyimpan apa pun.
 *
 * ATURAN PALING PENTING DI FILE INI: **setiap query WAJIB punya `WHERE bot_id = ?`.**
 * Semua tabel di bawah ini menyimpan baris SEMUA bot dalam satu tabel
 * (diverifikasi: `rpg_members` punya kolom `bot_id` dan di dev berisi 57 baris).
 * Satu query yang lupa filternya = pelanggan A menerima daftar member pelanggan
 * B. Itu kebocoran data, bukan bug tampilan, dan tidak bisa ditarik balik.
 *
 * Command ini OWNER-ONLY (`isOwner`) — tanpa gate itu, siapa pun di grup bisa
 * mengetik `.backup` dan mengunduh data member.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { pool } = require('../config/database');

// Tabel yang isinya MILIK SATU BOT, semua dengan kolom `bot_id`.
// Daftar ini sengaja eksplisit, bukan hasil scan `information_schema`: scan
// otomatis akan ikut menyalin tabel global (`users`, `orders`, `settings`) —
// dan `users` berisi HASH PASSWORD semua orang. Lebih baik daftarnya ketinggalan
// satu tabel daripada satu hari menyalin akun orang lain.
const TABEL_BOT = [
  'group_settings',   // welcome/bye/detect/autoacc per grup
  'auto_respon',      // kata kunci auto-balas
  'blacklist',        // user yang diblokir
  'warn_records',     // catatan peringatan
  'group_ban',        // grup yang dilarang
  'gudang_list',      // gudang/daftar inventori
  'bot_sewa',         // grup sewaan
  'rpg_members',      // data RPG: uang, level, inventori member
];
const MAX_BARIS = 50000;   // ponytail: penjaga ukuran; paginasi kalau sampai kelewat

// Bot punya DB SQLite sesi WhatsApp sendiri (session.db). File ini BUKAN data
// user, dan TIDAK ikut dicadangkan: menyalinnya saat bot sedang jalan bisa
// merusak sesi yang sedang dipakai (file handle terbuka).
function kolomBot() {
  return `
    id, platform, bot_name, bot_number, owner_number, owner_name, prefix,
    footer_text, description, channel_id, qris_url, banner_url, main_groups,
    daily_limit, receive_limit, received_count, created_at, updated_at`;
}

/** Kumpulkan seluruh data bot ini. Semua query difilter `bot_id`. */
async function kumpulkan(botId) {
  const [botRows] = await pool.execute(
    `SELECT ${kolomBot()} FROM bots WHERE id = ? LIMIT 1`, [botId]
  );
  if (!botRows.length) throw new Error('Bot tidak ditemukan');
  const bot = botRows[0];

  // Jangan pernah ikutkan kredensial bot ke file yang dikirim keluar.
  delete bot.telegram_token;

  const data = {};
  const jumlah = {};
  for (const tabel of TABEL_BOT) {
    try {
      const [rows] = await pool.execute(
        `SELECT * FROM \`${tabel}\` WHERE bot_id = ? LIMIT ${MAX_BARIS + 1}`,
        [botId]
      );
      data[tabel] = rows;
      jumlah[tabel] = rows.length;
      if (rows.length > MAX_BARIS) {
        jumlah[tabel] = MAX_BARIS;
        data[tabel] = rows.slice(0, MAX_BARIS);
      }
    } catch (e) {
      // Tabel belum ada di DB lama — catat, jangan gagalkan seluruh backup.
      data[tabel] = [];
      jumlah[tabel] = `dilewati: ${e.code || e.message}`;
    }
  }

  return {
    berkas: {
      dibuat: new Date().toISOString(),
      format: 1,
      keterangan: 'Cadangan data bot dari yaparbots. Data ini milik satu bot saja.',
    },
    bot,
    data,
    jumlah_baris: jumlah,
  };
}

module.exports = async function backupHandler(ctx) {
  if (!ctx.isCmd) return false;
  const { command, reply, react, client, jid, botData } = ctx;
  if (command !== 'backup') return false;

  // ── Gerbang owner: WAJIB, dan WAJIB paling awal ────────────────────────────
  // `isOwner` ada di plugins/05-owner.js dan TIDAK diekspor (module.exports-nya
  // di-overwrite jadi fungsi handler). Menyalin 20 barisnya ke sini = dua
  // sumber kebenaran yang cepat atau lambat berbeda. Sebagai gantinya: panggil
  // handler owner dengan ctx tiruan yang command-nya tidak dikenal.
  //
  // Aman dari efek samping: `ownerHandler` menyelesaikan gate blacklist/warn
  // lebih dulu, lalu `switch` tidak cocok apa pun dan balik `false` — nol
  // tulisan DB, nol pesan terkirim.
  const ownerHandler = require('./05-owner.js');
  const terlihatOwner = [];
  const ctxTiruan = {
    ...ctx,
    command: '__cek_owner_backup__',
    reply: async (t) => { terlihatOwner.push(String(t)); },
  };
  const dipakaiOwner = await ownerHandler(ctxTiruan);
  const sayaOwner = !dipakaiOwner && terlihatOwner.length === 0;
  if (!sayaOwner) {
    await reply('⛔ Command ini khusus owner bot. Data cadangan tidak dibagikan ke orang lain.');
    return true;
  }

  const botId = botData?.id;
  if (!botId) { await reply('❌ Bot tidak dikenali.'); return true; }

  const mulai = Date.now();
  try {
    await react('⏳');
    const isi = await kumpulkan(botId);

    // File sementara di /tmp — NAMA ACAK supaya dua `.backup` bersamaan tidak
    // saling menimpa. Dibuang di `finally`, apa pun yang terjadi.
    const namaFile = `backup_${(botData.bot_name || 'bot').replace(/[^\w.-]/g, '_')}_${botId}_${Date.now()}.json`;
    const berkas = path.join(os.tmpdir(), namaFile);
    fs.writeFileSync(berkas, JSON.stringify(isi, null, 2), 'utf8');
    const ukuran = fs.statSync(berkas).size;

    try {
      await client.message.send(jid, {
        type: 'document',
        media: fs.readFileSync(berkas),
        mimetype: 'application/json',
        fileName: namaFile,
      });

      await reply(
        `✅ *Cadangan selesai*\n\n` +
        `Bot: *${botData.bot_name}*\n` +
        `Ukuran: ${(ukuran / 1024).toFixed(1)} KB\n` +
        `Waktu: ${Date.now() - mulai} ms\n\n` +
        Object.entries(isi.jumlah_baris)
          .map(([t, n]) => `• ${t}: ${n}`)
          .join('\n') +
        `\n\n_File hanya dikirim ke nomor ini, dan sudah dihapus dari server._`
      );
      await react('✅');
    } finally {
      // Dibuang SELALU — termasuk kalau kirimnya gagal. "Tidak menumpuk di VPS"
      // itu janji ke owner, dan janji yang cuma benar saat sukses bukan janji.
      try { fs.unlinkSync(berkas); } catch { /* sudah tidak ada */ }
    }
  } catch (e) {
    console.error('[Backup] gagal:', e.message);
    await react('❌');
    await reply(`❌ Cadangan gagal: ${e.message}`);
  }
  return true;
};

// Owner-only: TIDAK masuk ALL_COMMANDS/CATS (sama seperti probe debug di
// 05-owner) supaya tidak muncul di `.menu` dan tidak dijalankan user biasa.
// Konsekuensinya alias tidak ada — memang tidak diinginkan di sini.
module.exports.limitedCmds = new Set([]);
