'use strict';

/**
 * config/engineBus.js — SHIM panel zapo.
 *
 * Panel zapo nggak pakai worker terpisah: engine WhatsApp (zapo) hidup di
 * proses web yang sama. Controller web (botController) ditulis buat pemanggilan
 * lewat bus, jadi file ini nyediain bentuk API yang sama (`start`/`stop`/
 * `restart`/`stopIfRunning`) tapi DITERUSKAN ke engine zapo lokal —
 * bukan dikirim ke proses lain.
 *
 * Hasilnya: controller tetap nggak perlu tahu engine-nya di mana, dan panel
 * zapo tetap satu proses seperti sebelumnya.
 */

const { isMine } = require('./engineScope');

/** Bot harus milik panel ini — kalau bukan, jangan disentuh. */
function wajibMilikSaya(botId) {
  if (!isMine(botId)) {
    const e = new Error('Bot ini bukan milik panel ini');
    e.status = 403;
    throw e;
  }
}

async function ambilBot(botId) {
  const { pool } = require('./database');
  const [rows] = await pool.execute('SELECT * FROM bots WHERE id = ?', [botId]);
  if (!rows.length) {
    const e = new Error('Bot tidak ditemukan');
    e.status = 404;
    throw e;
  }
  return rows[0];
}

/**
 * Nyalain bot. Nggak ada proses lain yang dipanggil — langsung ke engine.
 * Bot telegram tetap lewat engine telegram (dulu pun satu proses).
 */
async function start(botId, usePairingCode = false) {
  wajibMilikSaya(botId);
  const botData = await ambilBot(botId);

  if (botData.platform === 'telegram') {
    const { startTelegramBot } = require('../engine/telegramEngine');
    await startTelegramBot(botData);
  } else {
    const { startWhatsAppBot } = require('../engine/whatsappEngine');
    await startWhatsAppBot(botData, usePairingCode === true);
  }
  return { ok: true, message: 'Bot dijalankan' };
}

async function stop(botId) {
  wajibMilikSaya(botId);
  const botData = await ambilBot(botId);

  if (botData.platform === 'telegram') {
    const { stopTelegramBot } = require('../engine/telegramEngine');
    await stopTelegramBot(botId);
  } else {
    const { stopWhatsAppBot } = require('../engine/whatsappEngine');
    await stopWhatsAppBot(botId);
  }
  return { ok: true, message: 'Bot dihentikan' };
}

async function restart(botId) {
  wajibMilikSaya(botId);
  const botData = await ambilBot(botId);

  if (botData.platform === 'telegram') {
    const { stopTelegramBot, startTelegramBot } = require('../engine/telegramEngine');
    await stopTelegramBot(botId);
    await startTelegramBot(botData);
  } else {
    const { restartWhatsAppBot } = require('../engine/whatsappEngine');
    await restartWhatsAppBot(botId);
  }
  return { ok: true, message: 'Bot direstart' };
}

/**
 * Matiin cuma kalau memang lagi jalan — dipakai deleteBot/clearSession.
 * Jangan lempar kalau bot nggak ada: pemanggilnya justru sedang menghapus.
 */
async function stopIfRunning(botId) {
  const { pool } = require('./database');
  const [rows] = await pool.execute(
    'SELECT id, platform, is_running FROM bots WHERE id = ?', [botId]
  );
  if (!rows.length || !rows[0].is_running) return { ok: true, skipped: true };
  try {
    return await stop(botId);
  } catch (e) {
    // Bot yang sesinya lagi dihapus bisa gagal stop — jangan gagalkan hapusnya.
    console.error('[engineBus] stopIfRunning gagal:', e.message);
    return { ok: false, message: e.message };
  }
}

module.exports = { start, stop, restart, stopIfRunning };
