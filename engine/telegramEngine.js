'use strict';

/**
 * engine/telegramEngine.js
 * Multi-session Telegram engine menggunakan node-telegram-bot-api.
 * Setiap bot punya instance TelegramBot tersendiri dengan token dari DB.
 */

const { pool, incrementStat, decrementStat } = require('../config/database');
const { activeBots } = require('../controllers/botController');

let TelegramBot;
try {
  TelegramBot = require('node-telegram-bot-api');
} catch {
  console.warn('[TelegramEngine] node-telegram-bot-api tidak terinstall — Telegram engine disabled');
}

// ─── WS broadcast helper ──────────────────────────────────────────────────────
let _wsBroadcast = () => {};
function setWsBroadcast(fn) { _wsBroadcast = fn; }

function broadcast(botId, type, payload) {
  _wsBroadcast({ botId, type, payload, ts: Date.now() });
}

// ─── Log helper ───────────────────────────────────────────────────────────────
async function logBot(botId, level, message) {
  try {
    await pool.execute(
      'INSERT INTO bot_logs (bot_id, level, message) VALUES (?, ?, ?)',
      [botId, level, message]
    );
    broadcast(botId, 'log', { level, message, ts: Date.now() });
  } catch { /* non-critical */ }
}

// ─── Plugin commands ──────────────────────────────────────────────────────────
const COMMANDS = {
  '/ping': (bot, chatId) => bot.sendMessage(chatId, '🏓 Pong!'),

  '/start': (bot, chatId, botData) =>
    bot.sendMessage(chatId,
      `<b>${botData.bot_name}</b>\n\nBot Telegram aktif!\nGunakan /menu untuk melihat daftar perintah.`,
      { parse_mode: 'HTML' }
    ),

  '/menu': (bot, chatId, botData) => {
    const p = botData.prefix || '/';
    return bot.sendMessage(chatId,
      `<b>Menu ${botData.bot_name}</b>\n\n` +
      `${p}ping - Cek koneksi\n` +
      `${p}info - Info bot\n` +
      `${p}uptime - Waktu aktif\n` +
      `${p}echo &lt;teks&gt; - Balas teks\n` +
      `${p}menu - Menu ini`,
      { parse_mode: 'HTML' }
    );
  },

  '/info': (bot, chatId, botData) =>
    bot.sendMessage(chatId,
      `<b>Info Bot</b>\n\n` +
      `Nama     : ${botData.bot_name}\n` +
      `Platform : Telegram\n` +
      `Node.js  : ${process.version}\n` +
      `Uptime   : ${Math.floor(process.uptime())}s\n` +
      `<i>${botData.footer_text || ''}</i>`,
      { parse_mode: 'HTML' }
    ),

  '/uptime': (bot, chatId) => {
    const s   = Math.floor(process.uptime());
    const h   = Math.floor(s / 3600);
    const m   = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return bot.sendMessage(chatId, `⏰ Uptime: ${h}j ${m}m ${sec}d`);
  },
};

// ─── Handle pesan masuk ───────────────────────────────────────────────────────
async function handleMessage(tgBot, msg, botData, botId) {
  const chatId = msg.chat.id;
  const text   = msg.text || '';
  // Telegram selalu pakai prefix '/' — prefix custom tidak berlaku
  const prefix = '/';

  if (!text) return;

  // Hitung pesan masuk ke stats
  try { await pool.execute("UPDATE stats SET stat_value = stat_value + 1 WHERE stat_key = 'total_messages'"); } catch {}

  // Normalize ke /command format
  // - prefix kosong atau '/' → pakai text langsung
  // - prefix custom (!, ., dll) → strip prefix lalu prepend /
  let normalized;
  if (prefix === '' || prefix === '/') {
    normalized = text.split(' ')[0].toLowerCase().replace(`@${tgBot.options?.username || ''}`, '');
  } else if (text.startsWith(prefix)) {
    normalized = '/' + text.slice(prefix.length).split(' ')[0].toLowerCase();
  } else if (text.startsWith('/')) {
    normalized = text.split(' ')[0].toLowerCase().replace(`@${tgBot.options?.username || ''}`, '');
  } else {
    // Bukan command — abaikan
    return;
  }

  // Handler command yang dikenal
  if (COMMANDS[normalized]) {
    try {
      await COMMANDS[normalized](tgBot, chatId, botData);
      await logBot(botId, 'cmd', `[cmd] ${normalized}`);
    } catch (e) {
      await logBot(botId, 'cmderr', `[error] ${normalized}: ${e.message}`);
    }
    return;
  }

  // /echo atau prefix+echo
  if (normalized === '/echo') {
    const args = text.includes(' ') ? text.slice(text.indexOf(' ') + 1) : '(kosong)';
    await tgBot.sendMessage(chatId, args);
    await logBot(botId, 'cmd', `[cmd] echo`);
    return;
  }

  // Command tidak dikenal
  await tgBot.sendMessage(chatId, `Command tidak dikenal. Ketik ${prefix || '/'}menu untuk daftar.`);
  await logBot(botId, 'cmderr', `[unknown] ${normalized}`);
}

// ─── Start Telegram Bot ───────────────────────────────────────────────────────
async function startTelegramBot(botData) {
  if (!TelegramBot) throw new Error('node-telegram-bot-api tidak terinstall');

  const botId = botData.id;
  const token = botData.telegram_token;

  if (!token) throw new Error('Token Telegram tidak ditemukan');

  // Stop instance lama kalau ada — cegah conflict polling
  if (activeBots.has(botId)) {
    try { await activeBots.get(botId).destroy?.(); } catch {}
    activeBots.delete(botId);
    // Tunggu Telegram server release koneksi lama
    await new Promise(r => setTimeout(r, 2000));
  }

  await logBot(botId, 'info', 'Memulai Telegram bot...');
  await pool.execute("UPDATE bots SET status = 'connecting' WHERE id = ?", [botId]);
  broadcast(botId, 'status', { status: 'connecting' });

  // Buat instance bot dengan polling
  const tgBot = new TelegramBot(token, { polling: true });

  // Simpan di activeBots — expose destroy() untuk stop
  activeBots.set(botId, {
    destroy: async () => {
      try {
        await tgBot.stopPolling();
      } catch { /* ignore */ }
      // Tandai berhenti di DB — biar nggak ke-auto-start lagi pas boot
      await pool.execute("UPDATE bots SET status = 'disconnected', is_running = 0 WHERE id = ?", [botId]).catch(() => {});
    },
    platform: 'telegram',
    instance: tgBot,
  });

  // ── Event: polling error ──────────────────────────────────────────────────
  tgBot.on('polling_error', async (err) => {
    const msg = err.code === 'ETELEGRAM'
      ? `Telegram API error: ${err.response?.body?.description || err.message}`
      : err.message;
    await logBot(botId, 'error', msg);
    broadcast(botId, 'status', { status: 'disconnected' });
    await pool.execute("UPDATE bots SET status = 'disconnected', is_running = 0 WHERE id = ?", [botId]);
  });

  // ── Event: message ────────────────────────────────────────────────────────
  tgBot.on('message', async (msg) => {
    try {
      const from = msg.from?.username || msg.from?.first_name || String(msg.from?.id);
      const text = msg.text || '[media]';
      const isCmd = msg.text && (msg.text.startsWith('/') || msg.text.startsWith(botData.prefix ?? '/'));
      await logBot(botId, isCmd ? 'cmd' : 'info', `${from}: ${text}`);
      await handleMessage(tgBot, msg, botData, botId);
    } catch (e) {
      await logBot(botId, 'error', `Message handler error: ${e.message}`);
    }
  });

  // ── Verifikasi token dengan getMe ─────────────────────────────────────────
  try {
    const me = await tgBot.getMe();
    await logBot(botId, 'info', `Terhubung sebagai @${me.username} (${me.first_name})`);
    await pool.execute("UPDATE bots SET status = 'connected', is_running = 1 WHERE id = ?", [botId]);
    await incrementStat('total_bots_online');
    broadcast(botId, 'status', { status: 'connected', username: me.username });
  } catch (e) {
    await logBot(botId, 'error', `Gagal verifikasi token: ${e.message}`);
    await pool.execute("UPDATE bots SET status = 'disconnected', is_running = 0 WHERE id = ?", [botId]);
    activeBots.delete(botId);
    throw e;
  }
}

module.exports = { startTelegramBot, setWsBroadcast };
