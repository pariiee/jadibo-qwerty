'use strict';

/**
 * plugins/discord/01-general.js
 * Fitur bawaan & general commands untuk bot Discord.
 */

module.exports = async function discordGeneral(ctx) {
  const { command, args, reply, botData } = ctx;
  const p = botData?.prefix || '!';

  switch (command) {
    case 'ping':
      await reply('🏓 Pong! (Discord Engine)');
      return true;

    case 'uptime': {
      const s = Math.floor(process.uptime());
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      await reply(`⏰ Uptime: ${h}j ${m}m ${s % 60}d`);
      return true;
    }

    case 'info':
      await reply(
        `**Info Bot**\n` +
        `Nama     : ${botData?.bot_name || 'Bot'}\n` +
        `Platform : Discord\n` +
        `Node.js  : ${process.version}\n` +
        `Uptime   : ${Math.floor(process.uptime())}s`
      );
      return true;

    case 'echo': {
      const txt = args && args.length ? args.join(' ') : '(kosong)';
      await reply(txt);
      return true;
    }

    default:
      return false;
  }
};
