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
        `<b>${botData?.bot_name || 'Bot'}</b>\n\nBot Telegram aktif!\nGunakan ${p}menu untuk melihat daftar perintah.`,
        { parse_mode: 'HTML' }
      );
      return true;

    case 'menu':
      await reply(
        `<b>Menu ${botData?.bot_name || 'Bot'}</b>\n\n` +
        `${p}ping - Cek koneksi\n` +
        `${p}info - Info bot\n` +
        `${p}uptime - Waktu aktif\n` +
        `${p}echo &lt;teks&gt; - Balas teks\n` +
        `${p}menu - Menu ini`,
        { parse_mode: 'HTML' }
      );
      return true;

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
