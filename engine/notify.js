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
  if (!rows.length) return false;

  // Lazy: hindari urutan load yang rewel antara controller & engine.
  const { activeBots } = require('../controllers/botController');

  for (const b of rows) {
    const client = activeBots.get(b.id) || activeBots.get(String(b.id));
    if (!client) continue;

    const nomor = String(b.owner_number).split(',')[0].replace(/\D/g, '');
    if (!nomor) continue;

    try {
      await client.message.send(nomor + '@s.whatsapp.net', { text: teks });
      return true;
    } catch {
      // Bot ada di Map tapi socket-nya sudah mati — coba bot berikutnya.
    }
  }
  return false;
}

module.exports = { kirimKeOwner };
