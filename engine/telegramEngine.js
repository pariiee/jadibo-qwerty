'use strict';

/**
 * engine/telegramEngine.js
 * Multi-session Telegram engine menggunakan node-telegram-bot-api.
 * Setiap bot punya instance TelegramBot tersendiri dengan token dari DB.
 */

const { pool } = require('../config/database');
const { activeBots } = require('../controllers/botController');
const { buildUniversalContext } = require('./universalAdapter');
const { loadPlugins } = require('./whatsappEngine');

let _plugins = null;
function getPlugins() {
  if (!_plugins) _plugins = loadPlugins('telegram');
  return _plugins;
}

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

// Map botId -> Set of group chat IDs
const tgActiveGroups = new Map();

// ─── Plugin commands ──────────────────────────────────────────────────────────
const COMMANDS = {
  '/ping': (bot, chatId) => bot.sendMessage(chatId, '🏓 Pong!'),

  '/bcgc': async (bot, chatId, botData, msg) => {
    const isOwner = String(msg?.from?.id) === String(botData.owner_number);
    if (!isOwner) return bot.sendMessage(chatId, '❌ Perintah broadcast hanya untuk Owner bot.');
    const text = (msg?.text || '').replace(/^\/bcgc(@\w+)?\s*/i, '').trim();
    if (!text) return bot.sendMessage(chatId, 'Penggunaan: /bcgc <pesan>');

    const groups = tgActiveGroups.get(botData.id) || new Set();
    if (!groups.size) return bot.sendMessage(chatId, 'Belum ada grup aktif yang tercatat.');

    let sent = 0;
    for (const gId of groups) {
      await bot.sendMessage(gId, `📢 <b>Broadcast ${botData.bot_name}</b>\n\n${text}\n\n<i>${botData.footer_text || ''}</i>`, { parse_mode: 'HTML' }).catch(() => {});
      sent++;
    }
    return bot.sendMessage(chatId, `✅ Broadcast berhasil dikirim ke <b>${sent}</b> grup Telegram.`, { parse_mode: 'HTML' });
  },

  '/start': (bot, chatId, botData) =>
    bot.sendMessage(chatId,
      `<b>${botData.bot_name}</b>\n\nBot Telegram aktif dan siap digunakan!\nBuka Dashboard WebApp langsung di Telegram atau gunakan menu perintah di bawah.`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📱 Buka Dashboard (WebApp)', web_app: { url: 'https://labs.yapari.web.id/dashboard' } },
            ],
            [
              { text: '📖 Buka Menu', callback_data: 'menu' },
              { text: '⚡ Cek Ping', callback_data: 'ping' },
            ],
          ],
        },
      }
    ),

  '/dice': (bot, chatId) => bot.sendDice(chatId, { emoji: '🎲' }),
  '/slot': (bot, chatId) => bot.sendDice(chatId, { emoji: '🎰' }),
  '/dart': (bot, chatId) => bot.sendDice(chatId, { emoji: '🎯' }),

  '/menu': async (bot, chatId, botData, msg) => {
    const text = (msg?.text || '').toLowerCase().trim();
    const infoMod = require('../plugins/whatsapp/01-info');
    const cats = infoMod.CATS;
    const catKeys = infoMod.CAT_KEYS;

    const sub = text.split(/\s+/)[1] || '';
    if (sub === 'all') {
      let txt = `📋 <b>SELURUH FITUR ${botData.bot_name} (320+ Perintah)</b>\n\n`;
      for (const k of catKeys) {
        const cmds = (cats[k] || []).map(c => `/${c}`).join('  ');
        txt += `〔 <b>${infoMod.catLabel(k)}</b> 〕\n${cmds}\n\n`;
      }
      return bot.sendMessage(chatId, txt, { parse_mode: 'HTML' });
    }

    if (sub && cats[sub]) {
      const cmds = (cats[sub] || []).map(c => `/${c}`).join('\n• ');
      return bot.sendMessage(chatId, `〔 <b>Menu ${infoMod.catLabel(sub)}</b> 〕\n\n• ${cmds}\n\n<i>Ketik /menu all untuk melihat semua perintah</i>`, { parse_mode: 'HTML' });
    }

    let menuTxt = `<b>╔══════════════════════════╗\n` +
      `║   MENU ${botData.bot_name} (320+ FITUR)   ║\n` +
      `╚══════════════════════════╝</b>\n\n` +
      `Halo! Bot dilengkapi lebih dari <b>320 fitur aktif</b>:\n` +
      `• 🤖 <b>AI:</b> <code>/ai &lt;tanya / reply gambar&gt;</code>\n` +
      `• 🎵 <b>Musik:</b> <code>/play &lt;judul lagu&gt;</code>\n` +
      `• 📥 <b>Unduh:</b> <code>/tiktok</code>, <code>/youtube</code>, <code>/ig</code>, <code>/twit</code>\n` +
      `• 🛠️ <b>Alat:</b> <code>/tourl</code>, <code>/sticker</code>, <code>/cuaca</code>, <code>/gempa</code>\n` +
      `• 🎮 <b>Game:</b> <code>/dice</code>, <code>/slot</code>, <code>/asahotak</code>\n\n` +
      `<b>Kategori Perintah:</b>\n`;

    for (const k of catKeys) {
      const count = (cats[k] || []).length;
      menuTxt += `• <b>${infoMod.catLabel(k)}</b> (${count}): <code>/menu ${k}</code>\n`;
    }

    menuTxt += `\n<i>Ketik <code>/menu all</code> untuk melihat seluruh 320 perintah sekaligus atau klik tombol di bawah:</i>`;

    const inline_keyboard = [
      [
        { text: '🤖 AI', callback_data: 'menu_tools' },
        { text: '📥 Downloader', callback_data: 'menu_tools' },
      ],
      [
        { text: '🎮 Game & RPG', callback_data: 'menu_game' },
        { text: '🛠️ Semua Tools', callback_data: 'menu_tools' },
      ],
      [
        { text: '📜 Tampilkan Semua (320+ Fitur)', callback_data: 'menu_all' },
      ],
      [
        { text: '📱 Buka Dashboard WebApp', web_app: { url: 'https://labs.yapari.web.id/dashboard' } },
      ],
    ];

    return bot.sendMessage(chatId, menuTxt, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard },
    });
  },

  '/info': (bot, chatId, botData) => {
    const s = Math.floor(process.uptime());
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return bot.sendMessage(chatId,
      `<b>Info Bot ${botData.bot_name}</b>\n\n` +
      `• Platform : Telegram\n` +
      `• Total Fitur : <b>320+ Perintah Aktif</b>\n` +
      `• Status : Connected & Online\n` +
      `• Prefix : <code>${botData.prefix || '/'}</code>\n` +
      `• Uptime : ${h}j ${m}m ${s % 60}d\n` +
      `• Node.js : ${process.version}\n\n` +
      `<i>${botData.footer_text || 'Powered by qwertygate'}</i>`,
      { parse_mode: 'HTML' }
    );
  },

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

  // Catat grup aktif & jalankan Anti-Link Guard di grup Telegram
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  if (isGroup) {
    if (!tgActiveGroups.has(botId)) tgActiveGroups.set(botId, new Set());
    tgActiveGroups.get(botId).add(chatId);

    const LINK_TG = /(?:https?:\/\/|www\.)[^\s]+|t\.me\/[^\s]+|chat\.whatsapp\.com\/[^\s]+/i;
    if (LINK_TG.test(text)) {
      const isOwner = String(msg.from?.id) === String(botData.owner_number);
      if (!isOwner) {
        await tgBot.deleteMessage(chatId, msg.message_id).catch(() => {});
        return tgBot.sendMessage(chatId, `⚠️ <b>${msg.from?.first_name || 'Member'}</b>, dilarang mengirim tautan atau link asing di grup ini!`, { parse_mode: 'HTML' })
          .then(m => setTimeout(() => tgBot.deleteMessage(chatId, m.message_id).catch(() => {}), 4000)).catch(() => {});
      }
    }
  }

  // Berikan feedback visual typing ke user
  tgBot.sendChatAction(chatId, 'typing').catch(() => {});

  // Normalize ke /command format
  // - prefix kosong atau '/' → pakai text langsung
  // - prefix custom (!, ., dll) → strip prefix lalu prepend /
  let normalized;
  if (prefix === '' || prefix === '/') {
    normalized = text.split(' ')[0].toLowerCase().replace(/@\w+$/i, '');
  } else if (text.startsWith(prefix)) {
    normalized = '/' + text.slice(prefix.length).split(' ')[0].toLowerCase().replace(/@\w+$/i, '');
  } else if (text.startsWith('/')) {
    normalized = text.split(' ')[0].toLowerCase().replace(/@\w+$/i, '');
  } else {
    // Bukan command — abaikan
    return;
  }

  // Handler command yang dikenal
  if (COMMANDS[normalized]) {
    try {
      await COMMANDS[normalized](tgBot, chatId, botData, msg);
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

  // ── Universal Plugin Dispatch (AI, Tools, Downloader, Games) ──
  try {
    const ctx = buildUniversalContext({
      platform: 'telegram',
      bot: tgBot,
      chatId,
      senderId: msg.from?.id,
      pushName: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || 'Telegram User',
      text,
      rawMsg: msg,
      botData,
    });

    const plugins = getPlugins();
    // Cooldown terpusat — sama dengan whatsappEngine, tolak SEBELUM plugin.
    const { cooldownGuard } = require('./cooldown');
    const cd = await cooldownGuard(ctx);
    if (cd.ok) {
      for (const handler of plugins) {
        try {
          const handled = await handler(ctx);
          if (handled) {
            await logBot(botId, 'cmd', `[cmd] ${ctx.command}`);
            return;
          }
        } catch (err) {
          console.warn(`[TelegramPlugin] ${ctx.command}:`, err.message);
        }
      }
    }
  } catch (e) {
    console.warn('[TelegramAdapter] Error:', e.message);
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
    const isUnauthorized = err.response?.statusCode === 401 || String(err.message).includes('401');
    const msg = err.code === 'ETELEGRAM'
      ? `Telegram API error: ${err.response?.body?.description || err.message}`
      : err.message;
    await logBot(botId, isUnauthorized ? 'error' : 'warn', msg);

    // Hanya matikan bot jika token beneran invalid/revoked (401), jangan matikan jika cuma timeout/502/network glitch
    if (isUnauthorized) {
      broadcast(botId, 'status', { status: 'disconnected' });
      await pool.execute("UPDATE bots SET status = 'disconnected', is_running = 0 WHERE id = ?", [botId]);
    }
  });

  // ── Event: message & group alerts ─────────────────────────────────────────
  tgBot.on('message', async (msg) => {
    try {
      // 1. Sambutan anggota baru masuk grup
      if (msg.new_chat_members && msg.new_chat_members.length) {
        for (const m of msg.new_chat_members) {
          if (m.is_bot) continue;
          const name = [m.first_name, m.last_name].filter(Boolean).join(' ') || 'Member';
          await tgBot.sendMessage(
            msg.chat.id,
            `👋 <b>Selamat Datang di ${msg.chat.title || 'Grup'}!</b>\nHalo <b>${name}</b>, selamat bergabung! Ketik /menu untuk melihat daftar command.`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        }
        return;
      }

      // 2. Notifikasi anggota keluar grup
      if (msg.left_chat_member) {
        const leftName = [msg.left_chat_member.first_name, msg.left_chat_member.last_name].filter(Boolean).join(' ') || 'Member';
        await tgBot.sendMessage(
          msg.chat.id,
          `👋 <b>${leftName}</b> telah meninggalkan grup.`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
        return;
      }

      const from = msg.from?.username || msg.from?.first_name || String(msg.from?.id);
      const text = msg.text || '[media]';
      const isCmd = msg.text && (msg.text.startsWith('/') || msg.text.startsWith(botData.prefix ?? '/'));
      await logBot(botId, isCmd ? 'cmd' : 'info', `${from}: ${text}`);
      await handleMessage(tgBot, msg, botData, botId);
    } catch (e) {
      await logBot(botId, 'error', `Message handler error: ${e.message}`);
    }
  });

  // ── Event: inline_query (Share bot command dari chat room manapun) ───────
  tgBot.on('inline_query', async (iq) => {
    try {
      const q = String(iq.query || '').trim();
      const results = [];

      if (q) {
        results.push({
          type: 'article',
          id: 'ai_' + iq.id,
          title: `🤖 Tanya AI: "${q}"`,
          description: `Kirim pertanyaan ini ke bot AI`,
          input_message_content: {
            message_text: `<b>🤖 Tanya AI:</b>\n<i>${q}</i>\n\nKetik <code>/ai ${q}</code> untuk jawaban langsung dari bot.`,
            parse_mode: 'HTML',
          },
        });

        results.push({
          type: 'article',
          id: 'yt_' + iq.id,
          title: `🎵 Cari Lagu: "${q}"`,
          description: `Cari dan unduh lagu via bot`,
          input_message_content: {
            message_text: `<b>🎵 Cari Lagu:</b>\nKetik <code>/play ${q}</code> di chat bot.`,
            parse_mode: 'HTML',
          },
        });
      }

      results.push({
        type: 'article',
        id: 'menu_' + iq.id,
        title: `📖 Buka Menu Bot (${botData.bot_name})`,
        description: 'Tampilkan menu dan daftar perintah bot',
        input_message_content: {
          message_text: `<b>${botData.bot_name}</b>\nBot asisten multifungsi Telegram!\n\nKetik <code>/menu</code> untuk melihat seluruh fitur lengkap.`,
          parse_mode: 'HTML',
        },
      });

      results.push({
        type: 'article',
        id: 'ping_' + iq.id,
        title: `⚡ Cek Status & Kecepatan Bot`,
        description: `Status aktif bot ${botData.bot_name}`,
        input_message_content: {
          message_text: `🏓 <b>Pong!</b>\nBot <b>${botData.bot_name}</b> aktif dan online.`,
          parse_mode: 'HTML',
        },
      });

      await tgBot.answerInlineQuery(iq.id, results, { cache_time: 10 });
    } catch (err) {
      console.warn(`[TelegramInline] error:`, err?.message || err);
    }
  });

  // ── Event: callback_query (Handle klik tombol inline keyboard) ────────────
  tgBot.on('callback_query', async (cb) => {
    try {
      await tgBot.answerCallbackQuery(cb.id).catch(() => {});
      const data = String(cb.data || '');
      const chatId = cb.message.chat.id;

      if (data === 'ping') {
        await tgBot.sendMessage(chatId, '🏓 Pong! (Telegram Engine)');
      } else if (data === 'menu') {
        await handleMessage(tgBot, { chat: { id: chatId }, from: cb.from, text: '/menu' }, botData, botId);
      } else if (data === 'menu_all') {
        await handleMessage(tgBot, { chat: { id: chatId }, from: cb.from, text: '/menu all' }, botData, botId);
      } else if (data.startsWith('menu_')) {
        const cat = data.replace('menu_', '');
        await handleMessage(tgBot, { chat: { id: chatId }, from: cb.from, text: `/menu ${cat}` }, botData, botId);
      }
    } catch {}
  });

  // ── Verifikasi token dengan getMe & daftarkan menu perintah ───────────────
  try {
    const me = await tgBot.getMe();
    await logBot(botId, 'info', `Terhubung sebagai @${me.username} (${me.first_name})`);

    // Daftarkan autocomplete list command resmi di menu bot Telegram
    try {
      await tgBot.setMyCommands([
        { command: 'start', description: 'Mulai bot dan tampilkan menu sambutan' },
        { command: 'menu', description: 'Daftar semua kategori command' },
        { command: 'ping', description: 'Cek kecepatan respon bot' },
        { command: 'uptime', description: 'Lihat durasi aktif bot' },
        { command: 'ai', description: 'Tanya jawab dengan Artificial Intelligence' },
        { command: 'tiktok', description: 'Download video/audio TikTok tanpa watermark' },
        { command: 'youtube', description: 'Download video atau lagu YouTube' },
        { command: 'play', description: 'Cari dan unduh audio lagu' },
        { command: 'tourl', description: 'Upload file media menjadi URL' },
        { command: 'sticker', description: 'Buat stiker dari foto' },
        { command: 'chord', description: 'Cari kunci gitar lagu' },
        { command: 'lirik', description: 'Cari lirik lagu' },
        { command: 'cuaca', description: 'Prakiraan cuaca kota' },
        { command: 'gempa', description: 'Info gempa terkini BMKG' },
        { command: 'dice', description: 'Animasi dadu interaktif Telegram' },
        { command: 'slot', description: 'Animasi mesin jackpot slot' },
      ]);
      await logBot(botId, 'info', 'Menu commands Telegram terdaftar');
    } catch {}

    // Pasang tombol WebApp resmi di sebelah kolom chat keyboard Telegram
    try {
      await tgBot.setChatMenuButton({
        menu_button: {
          type: 'web_app',
          text: 'Dashboard',
          web_app: { url: 'https://labs.yapari.web.id/dashboard' },
        },
      });
      await logBot(botId, 'info', 'Telegram WebApp Menu Button aktif');
    } catch {}

    // Simpan username bot ke bot_number agar link t.me/username langsung aktif
    if (me.username) {
      await pool.execute("UPDATE bots SET bot_number = COALESCE(bot_number, ?) WHERE id = ?", [me.username, botId]).catch(() => {});
    }

    await pool.execute("UPDATE bots SET status = 'connected', is_running = 1 WHERE id = ?", [botId]);
    broadcast(botId, 'status', { status: 'connected', username: me.username });
  } catch (e) {
    await logBot(botId, 'error', `Gagal verifikasi token: ${e.message}`);
    await pool.execute("UPDATE bots SET status = 'disconnected', is_running = 0 WHERE id = ?", [botId]);
    activeBots.delete(botId);
    throw e;
  }
}

// ─── Stop Telegram Bot ────────────────────────────────────────────────────────
// Instansnya nyimpen destroy() sendiri (lihat activeBots.set di atas) — jadi
// berhentiin = panggil destroy() lalu buang dari Map. destroy() sekaligus
// nulis status='disconnected' + is_running=0 ke DB, biar nggak ke-auto-start
// lagi pas boot. Kalau botnya memang nggak jalan, jangan lempar: pemanggilnya
// (deleteBot/clearSession) justru sedang membersihkan.
async function stopTelegramBot(botId) {
  const inst = activeBots.get(botId);
  if (!inst) return { ok: true, skipped: true };

  try {
    await inst.destroy?.();
  } catch (e) {
    await logBot(botId, 'error', `Gagal stop bot Telegram: ${e.message}`);
  }
  activeBots.delete(botId);
  broadcast(botId, 'status', { status: 'disconnected' });
  return { ok: true };
}

module.exports = { startTelegramBot, stopTelegramBot, setWsBroadcast };
