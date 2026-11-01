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

let voice = null;
let playDl = null;
try {
  voice = require('@discordjs/voice');
  playDl = require('play-dl');
} catch (e) {
  console.warn('[DiscordVoice] @discordjs/voice atau play-dl tidak tersedia:', e?.message || e);
}

// Map botId -> Discord Client instance
const activeDiscordBots = new Map();
// Map botId -> Map(guildId -> { player, connection, song })
const botVoiceSessions = new Map();

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
      {
        name: 'setautorole',
        desc: 'Atur role default yang otomatis diberikan ke anggota baru',
        options: [{ name: 'role', desc: 'Nama role (misal Member) atau ID Role', type: 3, required: true }],
      },
    ],
  },
  {
    name: 'server',
    desc: 'Informasi dan utilitas server Discord',
    subcommands: [
      { name: 'info', desc: 'Lihat jumlah member, owner, dan statistik server' },
      { name: 'roles', desc: 'Lihat daftar role yang ada di server' },
      { name: 'verify_panel', desc: 'Kirim panel tombol verifikasi role anggota di channel ini' },
      {
        name: 'purge',
        desc: 'Hapus pesan spam massal di channel ini (1-100 pesan)',
        options: [{ name: 'count', desc: 'Jumlah pesan yang dihapus (1-100)', type: 4, required: true }],
      },
      {
        name: 'announce',
        desc: 'Kirim pengumuman resmi dengan format embed di channel ini',
        options: [{ name: 'pesan', desc: 'Isi pengumuman', type: 3, required: true }],
      },
    ],
  },
  {
    name: 'music',
    desc: 'Pemutar musik voice channel server',
    subcommands: [
      {
        name: 'play',
        desc: 'Putar lagu dari YouTube / judul lagu ke dalam voice channel',
        options: [{ name: 'query', desc: 'Judul lagu atau link YouTube', type: 3, required: true }],
      },
      { name: 'stop', desc: 'Hentikan pemutaran musik dan keluarkan bot dari voice channel' },
      { name: 'pause', desc: 'Jeda sementara pemutaran lagu saat ini' },
      { name: 'resume', desc: 'Lanjutkan kembali lagu yang sedang dijeda' },
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
          { name: 'Auto-Role', value: `\`${botData.discord_autorole || botData.main_groups || 'Member'}\``, inline: true },
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
    if (subCmd === 'setautorole') {
      const r = interaction.options.getString('role');
      if (r) {
        botData.discord_autorole = r;
        await pool.execute('UPDATE bots SET main_groups = ? WHERE id = ?', [r, botId]).catch(() => {});
        return ctx.reply(`✅ Auto-Role default untuk anggota baru diatur ke: **${r}**`);
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
    if (subCmd === 'verify_panel') {
      const channel = interaction.channel;
      const targetRole = botData.discord_autorole || botData.main_groups || 'Member';
      if (!channel) return ctx.reply('Channel tidak valid.');
      await channel.send({
        embeds: [{
          title: '🛡️ Verifikasi Anggota Server',
          description: `Selamat datang di **${guild.name}**!\n\nUntuk membuka akses seluruh channel dan mendapatkan role **${targetRole}**, silakan klik tombol verifikasi di bawah ini.`,
          color: 0x5865F2,
          footer: { text: botData.footer_text || 'Powered by qwertygate' },
        }],
        components: [{
          type: 1, // ActionRow
          components: [{
            type: 2, // Button
            style: 3, // Success (Green)
            label: 'Verifikasi Diri',
            custom_id: 'verify_member',
            emoji: { name: '✅' },
          }],
        }],
      }).catch((e) => {
        return ctx.reply(`Gagal mengirim panel: ${e.message}`);
      });
      return ctx.reply('✅ Panel verifikasi anggota berhasil dikirim ke channel ini.');
    }
    if (subCmd === 'purge') {
      const channel = interaction.channel;
      const count = Math.min(100, Math.max(1, interaction.options.getInteger('count') || 10));
      if (!channel?.bulkDelete) return ctx.reply('Tidak bisa menghapus pesan di channel ini.');
      const deleted = await channel.bulkDelete(count, true).catch((e) => {
        return ctx.reply(`Gagal menghapus pesan: ${e.message}`);
      });
      return ctx.reply(`🧹 Berhasil membersihkan **${deleted?.size || count}** pesan terakhir.`);
    }
    if (subCmd === 'announce') {
      const pesan = interaction.options.getString('pesan');
      if (!pesan) return ctx.reply('Teks pengumuman tidak boleh kosong.');
      await interaction.channel.send({
        embeds: [{
          title: '📢 PENGUMUMAN RESMI',
          description: pesan,
          color: 0xFEE75C,
          footer: { text: `Diumumkan oleh ${interaction.user.tag} · ${botData.footer_text || 'Powered by qwertygate'}` },
          timestamp: new Date().toISOString(),
        }],
      }).catch((e) => {
        return ctx.reply(`Gagal mengirim pengumuman: ${e.message}`);
      });
      return ctx.reply('✅ Pengumuman berhasil disiarkan.');
    }
  }

  if (interaction.commandName === 'music') {
    if (!voice || !playDl) {
      return ctx.reply('Fitur Voice Music belum aktif karena dependensi audio belum siap di server.');
    }
    const guild = interaction.guild;
    if (!guild) return ctx.reply('Perintah musik hanya bisa digunakan di dalam server.');

    const memberVoice = interaction.member?.voice?.channel;
    if (!memberVoice && subCmd === 'play') {
      return ctx.reply('⚠️ Kamu harus masuk ke Voice Channel terlebih dahulu untuk memutar musik!');
    }

    if (!botVoiceSessions.has(botId)) botVoiceSessions.set(botId, new Map());
    const guildSessions = botVoiceSessions.get(botId);
    let session = guildSessions.get(guild.id);

    if (subCmd === 'play') {
      const q = interaction.options.getString('query');
      if (!q) return ctx.reply('Masukkan judul lagu atau URL YouTube.');

      try {
        const searchResults = await playDl.search(q, { limit: 1 });
        if (!searchResults || !searchResults.length) {
          return ctx.reply(`❌ Lagu tidak ditemukan untuk pencarian: "${q}"`);
        }
        const video = searchResults[0];

        if (!session || !session.connection) {
          const connection = voice.joinVoiceChannel({
            channelId: memberVoice.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
          });
          const player = voice.createAudioPlayer();
          connection.subscribe(player);
          session = { connection, player, channelId: memberVoice.id, song: null };
          guildSessions.set(guild.id, session);

          player.on('error', (err) => {
            console.error(`[Bot ${botId}] Audio player error:`, err.message);
          });
          player.on(voice.AudioPlayerStatus.Idle, () => {
            session.song = null;
          });
        }

        const audioStream = await playDl.stream(video.url);
        const resource = voice.createAudioResource(audioStream.stream, { inputType: audioStream.type });
        session.player.play(resource);
        session.song = video;

        return ctx.replyEmbed({
          title: '🎶 Sedang Memutar Lagu di Voice Channel',
          description: `[${video.title}](${video.url})`,
          color: 0x1DB954,
          thumbnail: video.thumbnails?.[0]?.url ? { url: video.thumbnails[0].url } : undefined,
          fields: [
            { name: 'Channel', value: `🔊 <#${memberVoice.id}>`, inline: true },
            { name: 'Durasi', value: video.durationRaw || 'Live', inline: true },
            { name: 'Pemohon', value: `<@${interaction.user.id}>`, inline: true },
          ],
          footer: { text: botData.footer_text || 'Powered by qwertygate' },
        });
      } catch (err) {
        return ctx.reply(`❌ Gagal memutar musik: ${err.message}`);
      }
    }

    if (subCmd === 'stop') {
      if (!session) return ctx.reply('Bot sedang tidak memutar musik di server ini.');
      try {
        session.player.stop();
        session.connection.destroy();
      } catch {}
      guildSessions.delete(guild.id);
      return ctx.reply('⏹️ Musik dihentikan dan bot telah keluar dari voice channel.');
    }

    if (subCmd === 'pause') {
      if (!session) return ctx.reply('Bot sedang tidak memutar musik.');
      session.player.pause();
      return ctx.reply('⏸️ Musik dijeda sementara.');
    }

    if (subCmd === 'resume') {
      if (!session) return ctx.reply('Bot sedang tidak memutar musik.');
      session.player.unpause();
      return ctx.reply('▶️ Melanjutkan pemutaran musik.');
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
  botData.discord_autorole = botData.main_groups || 'Member';

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildVoiceStates,
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

  // Auto-Role & Welcome Notification saat member baru bergabung
  client.on('guildMemberAdd', async (member) => {
    try {
      const targetRole = botData.discord_autorole || botData.main_groups || 'Member';
      const role = member.guild.roles.cache.find(
        (r) => r.name.toLowerCase() === targetRole.toLowerCase() || r.id === targetRole
      );
      if (role && member.guild.members.me?.permissions.has('ManageRoles')) {
        await member.roles.add(role).catch(() => {});
        await logBot(botId, 'info', `[Auto-Role] Role "${role.name}" diberikan ke ${member.user.tag}`);
      }

      const welcomeChannel = member.guild.systemChannel || member.guild.channels.cache.find(
        (c) => c.isTextBased() && (c.name.includes('welcome') || c.name.includes('selamat-datang') || c.name.includes('general') || c.name.includes('chat'))
      );
      if (welcomeChannel && welcomeChannel.permissionsFor(member.guild.members.me)?.has('SendMessages')) {
        await welcomeChannel.send({
          embeds: [{
            title: `👋 Selamat Datang di ${member.guild.name}!`,
            description: `Halo <@${member.id}>, selamat bergabung di server!\nKamu adalah member ke-**${member.guild.memberCount}**. Ketik \`/help\` untuk panduan bot.`,
            color: 0x5865F2,
            thumbnail: member.user.displayAvatarURL ? { url: member.user.displayAvatarURL({ dynamic: true }) } : undefined,
            footer: { text: botData.footer_text || 'Powered by qwertygate' },
            timestamp: new Date().toISOString(),
          }],
        }).catch(() => {});
      }
    } catch (err) {
      console.warn(`[Bot ${botId}] guildMemberAdd error:`, err?.message || err);
    }
  });

  // Goodbye notification saat member keluar
  client.on('guildMemberRemove', async (member) => {
    try {
      const channel = member.guild.systemChannel || member.guild.channels.cache.find(
        (c) => c.isTextBased() && (c.name.includes('goodbye') || c.name.includes('welcome') || c.name.includes('leave'))
      );
      if (channel && channel.permissionsFor(member.guild.members.me)?.has('SendMessages')) {
        await channel.send({
          embeds: [{
            description: `👋 **${member.user.tag}** telah meninggalkan server. Total member sekarang: **${member.guild.memberCount}**.`,
            color: 0xED4245,
          }],
        }).catch(() => {});
      }
    } catch {}
  });

  client.on('messageCreate', (message) => {
    handleDiscordMessage(client, message, botData, botId).catch((err) => {
      logBot(botId, 'cmderr', `[error] ${err.message}`);
    });
  });

  client.on('interactionCreate', async (interaction) => {
    // 1. Handle Klik Tombol Verifikasi Server
    if (interaction.isButton() && interaction.customId === 'verify_member') {
      try {
        const member = interaction.member;
        const targetRole = botData.discord_autorole || botData.main_groups || 'Member';
        const role = interaction.guild?.roles.cache.find(
          (r) => r.name.toLowerCase() === targetRole.toLowerCase() || r.id === targetRole
        );
        if (!role) {
          return interaction.reply({
            content: `⚠️ Role verifikasi **"${targetRole}"** belum tersedia di server ini. Hubungi admin.`,
            ephemeral: true,
          });
        }
        if (member.roles.cache.has(role.id)) {
          return interaction.reply({
            content: `ℹ️ Kamu sudah terverifikasi dengan role **${role.name}**.`,
            ephemeral: true,
          });
        }
        await member.roles.add(role);
        await logBot(botId, 'info', `[Verifikasi] ${member.user.tag} berhasil verifikasi -> role "${role.name}"`);
        return interaction.reply({
          content: `✅ Verifikasi sukses! Role **${role.name}** telah diberikan. Selamat datang di ${interaction.guild.name}!`,
          ephemeral: true,
        });
      } catch (err) {
        return interaction.reply({
          content: `❌ Gagal membagikan role: ${err.message}. Pastikan posisi role bot di atas role target.`,
          ephemeral: true,
        }).catch(() => {});
      }
    }

    // 2. Handle Chat Input Slash Command
    if (interaction.isChatInputCommand()) {
      handleDiscordInteraction(client, interaction, botData, botId).catch((err) => {
        logBot(botId, 'cmderr', `[slash-err] ${err.message}`);
      });
    }
  });

  client.on('shardDisconnect', () => {
    logBot(botId, 'warn', 'Koneksi Discord Gateway terputus, mencoba rekoneksi...');
  });
  client.on('shardReconnecting', () => {
    logBot(botId, 'info', 'Menghubungkan kembali ke Discord Gateway...');
  });

  client.on('error', (err) => {
    logBot(botId, 'error', `Discord error: ${err.message}`);
  });

  await client.login(token);
  activeDiscordBots.set(botId, client);
}

async function stopDiscordBot(botId) {
  const sessions = botVoiceSessions.get(botId);
  if (sessions) {
    for (const session of sessions.values()) {
      try { session.player?.stop(); session.connection?.destroy(); } catch {}
    }
    botVoiceSessions.delete(botId);
  }
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
