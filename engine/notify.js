'use strict';

/**
 * engine/notify.js — kabar ke owner bot lewat WhatsApp.
 *
 * Dipakai billingController setelah pembayaran masuk: user bayar, paket aktif,
 * tapi sebelumnya TIDAK ADA kabar apa pun — baik ke user maupun ke pemilik.
 * Kalau webhook telat, satu-satunya cara tahu cuma muter-muter di /billing.
 *
 * Yang dikirim cuma pesan teks lewat bot yang SEDANG online milik user itu.
 * Nggak ada tabel baru, nggak ada antrean: kalau nggak ada bot online, fungsi
 * ini balikin false dan pemanggilnya jalan terus. Notifikasi itu bonus —
 * JANGAN sampai bikin pembayaran gagal.
 */

const { pool } = require('../config/database');

/**
 * Kirim teks ke nomor owner milik `userId`, lewat bot-nya sendiri yang online.
 * @returns {Promise<boolean>} true kalau ada satu pesan yang benar-benar terkirim
 */
async function kirimKeOwner(userId, teks) {
  if (!userId || !teks) return false;

  // owner_number boleh berisi beberapa nomor dipisah koma — ambil yang pertama.
  const [rows] = await pool.execute(
    `SELECT id, owner_number FROM bots
      WHERE user_id = ? AND owner_number IS NOT NULL AND owner_number <> ''
      ORDER BY id`,
    [userId]
  );

  for (const b of rows) {
    const nomor = String(b.owner_number).split(',')[0].replace(/\D/g, '');
    if (!nomor) continue;
    if (await kirimLewatBot(b.id, nomor, teks)) return true;
  }

  // JALUR KEDUA — nomor HP user sendiri. Nomor bot bisa sedang putus tepat
  // waktu user bayar, dan itu justru momen dia paling butuh kabar. Nomor HP
  // dikirim dari bot mana pun yang sedang online, jadi tidak bergantung bot
  // milik user itu sendiri.
  const hp = await nomorHpUser(userId);
  if (hp) {
    for (const b of rows) {
      if (await kirimLewatBot(b.id, hp, teks)) return true;
    }
    // User belum punya bot sama sekali — pakai bot online mana pun.
    const { activeBots } = require('../controllers/botController');
    for (const id of activeBots.keys()) {
      if (await kirimLewatBot(id, hp, teks)) return true;
    }
  }
  return false;
}

/** Kirim satu pesan lewat bot tertentu. false = bot itu tidak bisa dipakai. */
async function kirimLewatBot(botId, nomor, teks) {
  const { activeBots } = require('../controllers/botController');
  const client = activeBots.get(botId) || activeBots.get(String(botId));
  if (!client) return false;
  try {
    await client.message.send(nomor + '@s.whatsapp.net', { text: teks });
    return true;
  } catch {
    return false; // socket sudah mati — coba bot berikutnya
  }
}

/** Nomor HP user (buat jalur kedua). '' kalau belum diisi. */
async function nomorHpUser(userId) {
  try {
    const [r] = await pool.execute('SELECT phone FROM users WHERE id = ? LIMIT 1', [userId]);
    return String(r[0]?.phone || '').replace(/\D/g, '');
  } catch {
    return ''; // kolomnya belum ada (DB lama) — notif WA tetap jalan
  }
}

module.exports = { kirimKeOwner, nomorHpUser };
