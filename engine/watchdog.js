'use strict';

/**
 * Watchdog bot mati — "kabari kalau bot kamu nggak nyambung lagi".
 *
 * Kenapa nggak langsung kirim di handler `close`: bot reconnect TIAP 5 DETIK.
 * Kalau WhatsApp sedang bermasalah, nomor owner bisa dibanjiri puluhan pesan
 * "bot mati" dalam semenit. Jadi:
 *
 *   1. handler `close` cuma MENJADWALKAN timer (setTimeout, unref) — di sini.
 *   2. kalau bot SEMBUH sebelum timer habis, timer dibatalkan. Nggak ada kabar.
 *   3. kalau tetap mati, BARU kirim sekali.
 *
 * Durasinya dilebihkan (bukan 30 detik): reconnect normal biasanya cepat, dan
 * notifikasi yang datang buat gangguan sekejap cuma bikin panik.
 */
const TENGGANG_MS = 2 * 60 * 1000; // ponytail: 2 menit hardcoded — naikkan kalau masih kelewat cerewet

const timer = new Map(); // botId -> timeout yang lagi jalan

/** Dipanggil dari handler `close` — jadwalkan kabar, jangan langsung kirim. */
async function jadwalkanNotifMati(botId, opts = {}) {
  if (timer.has(botId)) return false; // sudah ada yang dijadwalkan, jangan dobel-dobel
  const tenggang = opts.tenggang ?? TENGGANG_MS;

  const t = setTimeout(async () => {
    timer.delete(botId);
    try {
      // Kalau ternyata sudah nyambung lagi, nggak ada yang perlu dikabari.
      const [rows] = await pool.execute(
        "SELECT status FROM bots WHERE id = ?", [botId]
      );
      if (!rows.length || rows[0].status === 'connected') return;

      await kirimKeOwnerBot(botId,
        `⚠️ *Bot kamu sedang tidak terhubung*\n\n` +
        `Bot-nya nggak nyambung ke WhatsApp sejak ${tenggang / 60000} menit lalu.\n` +
        `Coba buka dashboard buat scan ulang QR kalau masih tetap begini:\n` +
        `/dashboard`
      );
    } catch { /* notifikasi itu bonus, bukan alasan bikin engine ribut */ }
  }, tenggang);

  if (t.unref) t.unref(); // jangan tahan proses cuma gara-gara timer ini
  timer.set(botId, t);
  return true;
}

/** Bot sudah nyambung lagi — batalkan kabar yang lagi dijadwalkan. */
function batalkanNotifMati(botId) {
  const t = timer.get(botId);
  if (!t) return false;
  clearTimeout(t);
  timer.delete(botId);
  return true;
}

// ── bagian yang nyentuh DB & WA; sengaja dipisah biar gampang dites ──────────
const { pool } = require('../config/database');

async function kirimKeOwnerBot(botId, teks) {
  const [rows] = await pool.execute(
    'SELECT id, user_id, owner_number FROM bots WHERE id = ?', [botId]
  );
  if (!rows.length) return false;
  const { kirimKeOwner } = require('./notify');
  return kirimKeOwner(rows[0].user_id, teks);
}

module.exports = { jadwalkanNotifMati, batalkanNotifMati, kirimKeOwnerBot, TENGGANG_MS };
