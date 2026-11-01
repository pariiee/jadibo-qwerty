'use strict';

/**
 * engine/discordEngine.js
 * Multi-session Discord engine menggunakan discord.js & Universal Message Adapter.
 * Setiap bot punya instance Client tersendiri dengan token dari DB.
 */

const { pool } = require('../config/database');
const { buildUniversalContext } = require('./universalAdapter');
const { loadPlugins } = require('./whatsappEngine');

let Client, GatewayIntentBits;
try {
  const djs = require('discord.js');
  Client = djs.Client;
  GatewayIntentBits = djs.GatewayIntentBits;
} catch {
  console.warn('[DiscordEngine] discord.js tidak terinstall — Discord engine disabled');
}

// Map botId -> Discord Client instance
const activeDiscordBots = new Map();

let _plugins = null;
function getPlugins() {
  if (!_plugins) _plugins = loadPlugins('discord');
  return _plugins;
}

let _wsBroadcast = () => {};
function setWsBroadcast(fn) { _wsBroadcast = fn; }

function broadcast(botId, type, payload) {
  _wsBroadcast({ botId, type, payload, ts: Date.now() });
}

async function logBot(botId, level, message) {
  try {
    await pool.execute(
      'INSERT INTO bot_logs (bot_id, level, message) VALUES (?, ?, ?)',
      [botId, level, message]
    );
    broadcast(botId, 'log', { level, message, ts: Date.now() });
  } catch { /* non-critical */ }
}

async function handleDiscordMessage(client, message, botData, botId) {
  if (!message || message.author?.bot) return;

  const text = message.content || '';
  if (!text) return;

  try {
    await pool.execute("UPDATE stats SET stat_value = stat_value + 1 WHERE stat_key = 'total_messages'");
  } catch {}

  const ctx = buildUniversalContext({
    platform: 'discord',
    bot: client,
    chatId: message.channel.id,
    senderId: message.author.id,
    pushName: message.author.globalName || message.author.username || 'Discord User',
    text,
    rawMsg: message,
    botData,
  });

  if (!ctx.isCmd || !ctx.command) return;

  // Built-in commands
  if (ctx.command === 'ping') {
    return ctx.reply('🏓 Pong! (Discord Engine)');
  }
  if (ctx.command === 'uptime') {
    const s = Math.floor(process.uptime());
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return ctx.reply(`⏰ Uptime: ${h}j ${m}m ${s % 60}d`);
  }

  // Universal plugins
  const plugins = getPlugins();
  for (const handler of plugins) {
    try {
      const handled = await handler(ctx);
      if (handled) {
        await logBot(botId, 'cmd', `[discord-cmd] ${ctx.command}`);
        return;
      }
    } catch (e) {
      console.warn(`[DiscordPlugin] ${ctx.command}:`, e.message);
    }
  }
}

// Built-in list of native Discord Slash Commands (termasuk hierarki Subcommands)
const DISCORD_SLASH_COMMANDS = [
  { name: 'help', desc: 'Tampilkan menu dan panduan command bot' },
  { name: 'ping', desc: 'Cek kecepatan respon bot' },
  { name: 'uptime', desc: 'Lihat durasi aktif bot' },
  { name: 'menu', desc: 'Daftar semua menu dan kategori command' },
  { name: 'ai', desc: 'Tanya jawab kecerdasan buatan (AI)' },
  { name: 'tiktok', desc: 'Download video/audio TikTok tanpa watermark' },
  { name: 'youtube', desc: 'Download video atau lagu dari YouTube' },
  { name: 'play', desc: 'Cari dan putar lagu audio' },
  { name: 'tourl', desc: 'Upload file media menjadi URL publik' },
  { name: 'sticker', desc: 'Buat stiker dari gambar' },
  { name: 'chord', desc: 'Cari kunci gitar lagu' },
  { name: 'lirik', desc: 'Cari lirik lagu' },
  { name: 'cuaca', desc: 'Cek prakiraan cuaca kota' },
  { name: 'gempa', desc: 'Info gempa terkini BMKG' },
  { name: 'stats', desc: 'Statistik performa dan kuota bot' },
  { name: 'ig', desc: 'Download konten Instagram (Post/Reels)' },
  { name: 'twit', desc: 'Download media Twitter / X' },
  { name: 'translate', desc: 'Terjemahkan teks ke berbagai bahasa' },
  { name: 'ssweb', desc: 'Screenshot halaman website' },
  { name: 'quotes', desc: 'Quotes bijak acak' },
  {
    name: 'config',
    desc: 'Pengaturan bot di server ini',
    subcommands: [
      { name: 'show', desc: 'Lihat info konfigurasi dan batas kuota bot' },
      {
        name: 'setprefix',
        desc: 'Ubah prefix command bot',
        options: [{ name: 'prefix', desc: 'Prefix baru (misal !, ., $)', type: 3, required: true }],
      },
    ],
  },
  {
    name: 'server',
    desc: 'Informasi dan utilitas server Discord',
    subcommands: [
      { name: 'info', desc: 'Lihat jumlah member, owner, dan statistik server' },
      { name: 'roles', desc: 'Lihat daftar role yang ada di server' },
    ],
  },
];

async function registerSlashCommands(client) {
  if (!client?.application?.commands) return;
  const payload = DISCORD_SLASH_COMMANDS.map((c) => {
    if (c.subcommands) {
      return {
        name: c.name,
        description: c.desc.slice(0, 100),
        options: c.subcommands.map((s) => ({
          name: s.name,
          description: s.desc.slice(0, 100),
          type: 1, // ApplicationCommandOptionType.Subcommand
          options: (s.options || []).map((o) => ({
            name: o.name,
            description: o.desc.slice(0, 100),
            type: o.type || 3,
            required: !!o.required,
          })),
        })),
      };
    }
    return {
      name: c.name,
      description: c.desc.slice(0, 100),
      options: [{
        name: 'query',
        description: 'Teks, link, atau parameter pencarian',
        type: 3, // ApplicationCommandOptionType.String
        required: false,
      }],
    };
  });
  await client.application.commands.set(payload);
}

async function handleDiscordInteraction(client, interaction, botData, botId) {
  if (!interaction.isChatInputCommand()) return;

  const subCmd = interaction.options.getSubcommand(false);
  const isPrivate = interaction.commandName === 'config';
  await interaction.deferReply({ ephemeral: isPrivate }).catch(() => {});

  let text = '';
  if (subCmd) {
    const optVal = interaction.options.getString('prefix') || interaction.options.getString('query') || '';
    text = `${botData.prefix || '!'}${interaction.commandName} ${subCmd}${optVal ? ' ' + optVal : ''}`.trim();
  } else {
    const query = interaction.options.getString('query') || '';
    text = `${botData.prefix || '!'}${interaction.commandName}${query ? ' ' + query : ''}`.trim();
  }

  try {
    await pool.execute("UPDATE stats SET stat_value = stat_value + 1 WHERE stat_key = 'total_messages'");
  } catch {}

  const ctx = buildUniversalContext({
    platform: 'discord',
    bot: client,
    chatId: interaction.channelId,
    senderId: interaction.user.id,
    pushName: interaction.user.globalName || interaction.user.username || 'Discord User',
    text,
    rawMsg: interaction,
    botData,
  });

  // Built-in commands & Subcommands
  if (interaction.commandName === 'config') {
    if (subCmd === 'show') {
      return ctx.replyEmbed({
        title: `⚙️ Konfigurasi Bot: ${botData.bot_name}`,
        description: `Berikut pengaturan bot aktif saat ini di dashboard:`,
        color: 0x5865F2,
        fields: [
          { name: 'Prefix', value: `\`${botData.prefix || '!'}\``, inline: true },
          { name: 'Platform', value: 'Discord', inline: true },
          { name: 'Daily Limit', value: String(botData.daily_limit || 20), inline: true },
          { name: 'Footer Text', value: botData.footer_text || 'Powered by qwertygate', inline: false },
        ],
      });
    }
    if (subCmd === 'setprefix') {
      const newP = interaction.options.getString('prefix');
      if (newP) {
        botData.prefix = newP;
        await pool.execute('UPDATE bots SET prefix = ? WHERE id = ?', [newP, botId]).catch(() => {});
        return ctx.reply(`✅ Prefix berhasil diubah menjadi: \`${newP}\``);
      }
    }
  }

  if (interaction.commandName === 'server') {
    const guild = interaction.guild;
    if (!guild) return ctx.reply('Perintah ini hanya bisa dijalankan di dalam server/guild Discord.');

    if (subCmd === 'info') {
      return ctx.replyEmbed({
        title: `🏰 Info Server: ${guild.name}`,
        color: 0x5865F2,
        thumbnail: guild.iconURL({ dynamic: true }) ? { url: guild.iconURL({ dynamic: true }) } : undefined,
        fields: [
          { name: 'Server ID', value: `\`${guild.id}\``, inline: true },
          { name: 'Owner ID', value: `<@${guild.ownerId}>`, inline: true },
          { name: 'Total Member', value: `${guild.memberCount || 'N/A'} user`, inline: true },
          { name: 'Dibuat Pada', value: guild.createdAt ? guild.createdAt.toLocaleDateString('id-ID') : 'N/A', inline: false },
        ],
      });
    }
    if (subCmd === 'roles') {
      const rolesList = guild.roles.cache.map((r) => r.name).filter((n) => n !== '@everyone').slice(0, 25).join(', ');
      return ctx.replyEmbed({
        title: `🎭 Roles di ${guild.name}`,
        description: rolesList || 'Tidak ada role kustom.',
        color: 0x5865F2,
      });
    }
  }

  if (ctx.command === 'ping') return ctx.reply('🏓 Pong! (Discord Engine)');
  if (ctx.command === 'uptime') {
    const s = Math.floor(process.uptime());
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return ctx.reply(`⏰ Uptime: ${h}j ${m}m ${s % 60}d`);
  }

  const plugins = getPlugins();
  for (const handler of plugins) {
    try {
      const handled = await handler(ctx);
      if (handled) {
        await logBot(botId, 'cmd', `[slash-cmd] /${ctx.command}${subCmd ? ' ' + subCmd : ''}`);
        return;
      }
    } catch (e) {
      console.warn(`[DiscordSlash] ${ctx.command}:`, e.message);
    }
  }
  await ctx.reply(`Perintah /${ctx.command} berhasil dijalankan.`);
}

async function startDiscordBot(botData) {
  if (!Client) throw new Error('discord.js tidak terinstall');

  const botId = botData.id;
  const token = botData.discord_token || botData.telegram_token;
  if (!token) throw new Error('Token Discord tidak ditemukan');

  if (activeDiscordBots.has(botId)) {
    try { activeDiscordBots.get(botId).destroy(); } catch {}
    activeDiscordBots.delete(botId);
  }

  await logBot(botId, 'info', `Memulai bot Discord "${botData.bot_name}"...`);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  client.once('ready', async () => {
    await logBot(botId, 'info', `Terhubung sebagai ${client.user.tag}`);
    try {
      client.user.setPresence({
        activities: [{ name: `${botData.prefix || '!'}help | ${botData.bot_name}`, type: 0 }],
        status: 'online',
      });
    } catch {}
    try {
      await registerSlashCommands(client);
      await logBot(botId, 'info', 'Slash commands auto-complete aktif');
    } catch (e) {
      console.warn(`[Bot ${botId}] Gagal register slash commands:`, e.message);
    }
    await pool.execute("UPDATE bots SET status = 'connected', is_running = 1 WHERE id = ?", [botId]);
    broadcast(botId, 'status', { status: 'connected', username: client.user.tag });
  });

  client.on('messageCreate', (message) => {
    handleDiscordMessage(client, message, botData, botId).catch((err) => {
      logBot(botId, 'cmderr', `[error] ${err.message}`);
    });
  });

  client.on('interactionCreate', (interaction) => {
    handleDiscordInteraction(client, interaction, botData, botId).catch((err) => {
      logBot(botId, 'cmderr', `[slash-err] ${err.message}`);
    });
  });

  client.on('error', (err) => {
    logBot(botId, 'error', `Discord error: ${err.message}`);
  });

  await client.login(token);
  activeDiscordBots.set(botId, client);
}

async function stopDiscordBot(botId) {
  const client = activeDiscordBots.get(botId);
  if (client) {
    try { client.destroy(); } catch {}
    activeDiscordBots.delete(botId);
  }
  await pool.execute("UPDATE bots SET status = 'stopped', is_running = 0 WHERE id = ?", [botId]);
  broadcast(botId, 'status', { status: 'stopped' });
}

module.exports = {
  startDiscordBot,
  stopDiscordBot,
  setWsBroadcast,
  logBot,
};
