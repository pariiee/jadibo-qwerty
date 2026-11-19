'use strict';

/**
 * engine/supervisor.js — auto-reconnect lintas platform.
 *
 * Kenapa ada: `is_running` cuma niat ("user mau bot ini jalan"), bukan keadaan
 * sebenarnya. Kalau proses bot mati sendiri, flag itu tetap 1 dan tidak ada
 * yang pernah mencoba lagi — bot Telegram pernah diam 6 hari begini. Modul ini
 * yang menutup celah itu.
 *
 * Aturannya:
 *   - Bot yang TIDAK hidup dipaksa nyala ulang, apa pun isi `is_running`.
 *   - Bot yang sedang tidur karena masa aktif habis (`stop_reason = 'expired'`)
 *     tidak disentuh — supervisor bukan jalan pintas untuk menembus paket.
 *   - Bot yang sudah hidup dilewati; kalau tidak, tiap menit bot sehat
 *     di-restart dan justru bikin putus-nyambung tanpa henti.
 */

const { pool } = require('../config/database');

const JEDA_MINIMAL_MS = 120000;      // jangan coba bot yang sama lebih dari sekali / 2 menit
const percobaanTerakhir = new Map(); // botId -> timestamp

function moduleFor(platform) {
  switch (platform) {
    case 'telegram': return require('./telegramEngine');
    case 'discord':  return require('./discordEngine');
    case 'whatsapp': return require('./whatsappEngine');
    default:         return null;
  }
}

// Kenapa lewat modul: Map instance tiap engine privat, jadi "masih hidup?"
// harus ditanyakan ke engine-nya, bukan dibaca langsung dari DB.
function aliveCheck(platform, mod) {
  if (platform === 'telegram') return mod.isTelegramAlive;
  if (platform === 'discord')  return mod.isDiscordAlive;
  return mod.isWhatsAppAlive;
}

function starterFor(platform, mod) {
  if (platform === 'telegram') return mod.startTelegramBot;
  if (platform === 'discord')  return mod.startDiscordBot;
  return (botData) => mod.startWhatsAppBot(botData, false);
}

/**
 * Satu putaran pemeriksaan.
 * @returns {Promise<{diperiksa:number, dinyalakan:string[], dilewati:number}>}
 */
async function jalankan() {
  const hasil = { diperiksa: 0, dinyalakan: [], dilewati: 0 };

  const [bots] = await pool.execute(
    `SELECT * FROM bots
      WHERE (stop_reason IS NULL OR stop_reason <> 'expired')`
  );
  hasil.diperiksa = bots.length;

  for (const bot of bots) {
    const mod = moduleFor(bot.platform);
    if (!mod) { hasil.dilewati++; continue; }

    const hidup = aliveCheck(bot.platform, mod);
    if (typeof hidup !== 'function') { hasil.dilewati++; continue; }

    // Sudah jalan — jangan diganggu.
    if (hidup(bot.id)) { hasil.dilewati++; continue; }

    // Beri jeda supaya bot yang sedang connect tidak ditabrak percobaan berikutnya.
    const terakhir = percobaanTerakhir.get(bot.id) || 0;
    if (Date.now() - terakhir < JEDA_MINIMAL_MS) { hasil.dilewati++; continue; }

    percobaanTerakhir.set(bot.id, Date.now());
    try {
      // is_running dikembalikan ke 1 supaya dashboard jujur soal niat.
      await pool.execute('UPDATE bots SET is_running = 1 WHERE id = ?', [bot.id]);
      await starterFor(bot.platform, mod)(bot);
      hasil.dinyalakan.push(`${bot.platform}:${bot.bot_name}`);
      console.log(`[Supervisor] Bot "${bot.bot_name}" (${bot.platform}) dinyalakan ulang`);
    } catch (e) {
      console.error(`[Supervisor] Gagal menyalakan "${bot.bot_name}": ${e.message}`);
    }
  }

  return hasil;
}

module.exports = { jalankan, JEDA_MINIMAL_MS };
