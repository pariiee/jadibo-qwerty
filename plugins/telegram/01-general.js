'use strict';

/**
 * plugins/telegram/01-general.js
 * Fitur bawaan & general commands untuk bot Telegram.
 */

module.exports = async function telegramGeneral(ctx) {
  const { command, args, reply, botData } = ctx;
  const p = botData?.prefix || '/';

  switch (command) {
    case 'ping':
      await reply('🏓 Pong! (Telegram Engine)');
      return true;

    case 'start':
      await reply(
        `<b>${botData?.bot_name || 'Bot'}</b>\n\nBot Telegram aktif dengan <b>320+ Fitur</b> siap pakai!\nKetik /menu untuk melihat daftar kategori atau buka WebApp di bawah.`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📱 Buka Dashboard (WebApp)', web_app: { url: 'https://labs.yapari.web.id/dashboard' } }],
              [{ text: '📖 Buka Menu (320+ Fitur)', callback_data: 'menu' }, { text: '⚡ Cek Ping', callback_data: 'ping' }],
            ],
          },
        }
      );
      return true;

    case 'totalfitur': {
      await reply(`📊 <b>Statistik Fitur ${botData?.bot_name || 'Bot'}</b>\n\nTotal: <b>320+ Perintah Aktif</b>\n• 🤖 <b>AI:</b> ChatGPT, Gemini, Notrack, AI Vision, Lyrics\n• 📥 <b>Downloader:</b> TikTok, YouTube, IG, FB, Twitter/X, MediaFire\n• 🛠️ <b>Tools:</b> Tourl, SSWeb, Cuaca, Gempa, Lirik, Chord, Translate\n• 🎮 <b>Games & RPG:</b> Dadu, Slot, Tebak Gambar, Tebak Kata, Asah Otak\n• 🎨 <b>Maker:</b> Stiker, Stiker Bergerak (ATTP/TTP)\n\nKetik /menu untuk daftar lengkap!`, { parse_mode: 'HTML' });
      return true;
    }

    case 'menu': {
      const sub = (args && args.length ? args[0].toLowerCase() : '');
      const infoMod = require('../whatsapp/01-info');
      const baseCats = infoMod.CATS;
      const cats = {
        ...baseCats,
        ai: ['ai', 'chatgpt', 'gemini', 'notrack', 'tanyaimg', 'toghibli', 'ailyrics'],
      };

      if (sub === 'all') {
        let txt = `📋 <b>SELURUH PERINTAH ${botData?.bot_name || 'BOT'} (320+ Fitur)</b>\n\n`;
        for (const k of infoMod.CAT_KEYS) {
          const cmds = (cats[k] || []).map(c => `/${c}`).join('  ');
          txt += `〔 <b>${infoMod.catLabel(k)}</b> 〕\n${cmds}\n\n`;
        }
        await reply(txt, { parse_mode: 'HTML' });
        return true;
      }

      if (sub && cats[sub]) {
        const label = sub === 'ai' ? 'ARTIFICIAL INTELLIGENCE' : infoMod.catLabel(sub);
        const cmds = cats[sub].map(c => `/${c}`).join('\n• ');
        await reply(`〔 <b>Menu ${label}</b> 〕\n\n• ${cmds}\n\n<i>Ketik /menu all untuk melihat seluruh perintah</i>`, { parse_mode: 'HTML' });
        return true;
      }

      // Tampilan Menu Utama Telegram dengan tombol kategori interaktif
      await reply(
        `<b>╔══════════════════════════╗\n` +
        `║   MENU ${botData?.bot_name || 'BOT'} (320+ FITUR)   ║\n` +
        `╚══════════════════════════╝</b>\n\n` +
        `Halo! Bot dilengkapi lebih dari <b>320 fitur aktif</b>:\n` +
        `• 🤖 <b>AI:</b> /ai &lt;tanya/reply foto&gt;\n` +
        `• 🎵 <b>Musik:</b> /play &lt;judul lagu&gt;\n` +
        `• 📥 <b>Unduh:</b> /tiktok, /youtube, /ig, /twit\n` +
        `• 🛠️ <b>Alat:</b> /tourl, /sticker, /cuaca, /gempa\n` +
        `• 🎲 <b>Game:</b> /dice, /slot, /asahotak\n\n` +
        `Ketik <code>/menu all</code> untuk melihat seluruh daftar 320 perintah sekaligus, atau klik kategori di bawah:`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🤖 AI & Chat', callback_data: 'menu_ai' },
                { text: '📥 Downloader (40+)', callback_data: 'menu_downloader' },
              ],
              [
                { text: '🛠️ Utilitas / Tools', callback_data: 'menu_tools' },
                { text: '🎮 Game & RPG', callback_data: 'menu_game' },
              ],
              [
                { text: '🎨 Stiker & Maker', callback_data: 'menu_maker' },
                { text: '🎲 Kata & Random', callback_data: 'menu_random' },
              ],
              [
                { text: '📜 Tampilkan Semua (/menu all)', callback_data: 'menu_all' },
              ],
            ],
          },
        }
      );
      return true;
    }

    case 'info': {
      const s = Math.floor(process.uptime());
      await reply(
        `<b>Info Bot</b>\n\n` +
        `Nama     : ${botData?.bot_name || 'Bot'}\n` +
        `Platform : Telegram\n` +
        `Node.js  : ${process.version}\n` +
        `Uptime   : ${s}s\n` +
        `<i>${botData?.footer_text || ''}</i>`,
        { parse_mode: 'HTML' }
      );
      return true;
    }

    case 'uptime': {
      const s = Math.floor(process.uptime());
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      await reply(`⏰ Uptime: ${h}j ${m}m ${sec}d`);
      return true;
    }

    case 'echo': {
      const txt = args && args.length ? args.join(' ') : '(kosong)';
      await reply(txt);
      return true;
    }

    default:
      return false;
  }
};
