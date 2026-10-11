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
  if (!_plugins) _plugins = loadPlugins();
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

async function startDiscordBot(botData) {
  if (!Client) throw new Error('discord.js tidak terinstall');

  const botId = botData.id;
  const token = botData.discord_token;
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
    await pool.execute("UPDATE bots SET status = 'connected', is_running = 1 WHERE id = ?", [botId]);
    broadcast(botId, 'status', { status: 'connected', username: client.user.tag });
  });

  client.on('messageCreate', (message) => {
    handleDiscordMessage(client, message, botData, botId).catch((err) => {
      logBot(botId, 'cmderr', `[error] ${err.message}`);
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
