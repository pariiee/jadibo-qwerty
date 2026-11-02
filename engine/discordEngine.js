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

async function executeDiscordVoiceAction({
  action,
  query,
  ctx,
  guild,
  memberVoice,
  user,
  textChannel,
  botData,
  botId,
}) {
  if (!voice || !playDl) {
    return ctx.reply('⚠️ Modul voice player Discord belum aktif di server.');
  }
  if (!guild) return ctx.reply('Perintah voice musik hanya berlaku di dalam server Discord.');

  if (!botVoiceSessions.has(botId)) botVoiceSessions.set(botId, new Map());
  const guildSessions = botVoiceSessions.get(botId);
  let session = guildSessions.get(guild.id);

  const playSongStream = async (targetSession, videoInfo) => {
    targetSession.song = videoInfo;
    const audioStream = await playDl.stream(videoInfo.url);
    const resource = voice.createAudioResource(audioStream.stream, { inputType: audioStream.type });
    targetSession.player.play(resource);
  };

  if (action === 'play') {
    if (!memberVoice) {
      return ctx.reply('⚠️ Kamu harus bergabung ke dalam **Voice Channel** (seperti Lounge) terlebih dahulu agar bot bisa masuk & on mic memutar lagu!');
    }
    const q = query?.trim();
    if (!q) return ctx.reply('Masukkan judul lagu atau URL YouTube yang ingin diputar.');

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
          selfDeaf: false,
          selfMute: false,
        });
        const player = voice.createAudioPlayer();
        connection.subscribe(player);
        session = { connection, player, channelId: memberVoice.id, song: null, queue: [], textChannel };
        guildSessions.set(guild.id, session);

        player.on('error', (err) => {
          console.error(`[Bot ${botId}] Audio player error:`, err.message);
        });

        player.on(voice.AudioPlayerStatus.Idle, async () => {
          session.song = null;
          if (session.queue.length > 0) {
            const nextSong = session.queue.shift();
            try {
              await playSongStream(session, nextSong);
              if (session.textChannel?.send) {
                session.textChannel.send({
                  embeds: [{
                    title: '▶️ Memutar Lagu Berikutnya dari Playlist',
                    description: `[${nextSong.title}](${nextSong.url})`,
                    color: 0x1DB954,
                    fields: [
                      { name: 'Durasi', value: nextSong.durationRaw || 'N/A', inline: true },
                      { name: 'Sisa Antrean', value: `${session.queue.length} lagu`, inline: true },
                    ],
                  }],
                }).catch(() => {});
              }
            } catch (e) {
              console.error(`[Bot ${botId}] Gagal memutar next song:`, e.message);
            }
          }
        });
      }

      session.textChannel = textChannel;

      // Jika bot sudah memutar lagu lain, masukkan ke antrean
      if (session.song) {
        session.queue.push(video);
        return ctx.replyEmbed({
          title: '📋 Ditambahkan ke Antrean Musik',
          description: `[${video.title}](${video.url})`,
          color: 0x5865F2,
          fields: [
            { name: 'Posisi Antrean', value: `#${session.queue.length}`, inline: true },
            { name: 'Channel Suara', value: `🔊 <#${memberVoice.id}>`, inline: true },
            { name: 'Durasi', value: video.durationRaw || 'Live', inline: true },
          ],
          footer: { text: `Total antrean: ${session.queue.length} lagu` },
        });
      }

      // Mulai putar di Voice Channel
      await playSongStream(session, video);

      return ctx.replyEmbed({
        title: '🎤 Bot Masuk ke Voice & Memutar Musik Live',
        description: `Bot telah bergabung ke Voice Channel **<#${memberVoice.id}>** dan menyalakan mikrofon untuk memutar:\n\n🎶 **[${video.title}](${video.url})**`,
        color: 0x1DB954,
        thumbnail: video.thumbnails?.[0]?.url ? { url: video.thumbnails[0].url } : undefined,
        fields: [
          { name: '🔊 Kanal Suara', value: `<#${memberVoice.id}>`, inline: true },
          { name: '⏱️ Durasi', value: video.durationRaw || 'Live', inline: true },
          { name: '👤 Pemohon', value: `<@${user.id}>`, inline: true },
        ],
        footer: { text: 'Ketik /music stop atau .stop untuk menghentikan musik' },
      });
    } catch (err) {
      return ctx.reply(`❌ Gagal memutar audio di Voice Channel: ${err.message}`);
    }
  }

  if (action === 'skip') {
    if (!session || !session.song) return ctx.reply('Tidak ada lagu yang sedang diputar untuk di-skip.');
    session.player.stop();
    return ctx.reply('⏭️ Lagu berhasil dilewati (Skip).');
  }

  if (action === 'queue') {
    if (!session || (!session.song && session.queue.length === 0)) {
      return ctx.reply('Antrean musik kosong.');
    }
    let desc = `**Sedang Diputar di Voice:**\n▶️ [${session.song?.title || 'None'}](${session.song?.url || ''}) (\`${session.song?.durationRaw || 'N/A'}\`)\n\n**Playlist Antrean:**\n`;
    if (session.queue.length === 0) {
      desc += '_Tidak ada lagu di antrean berikutnya._';
    } else {
      desc += session.queue.slice(0, 10).map((v, i) => `${i + 1}. [${v.title}](${v.url}) (\`${v.durationRaw || 'N/A'}\`)`).join('\n');
      if (session.queue.length > 10) desc += `\n_...dan ${session.queue.length - 10} lagu lainnya._`;
    }
    return ctx.replyEmbed({
      title: '🎵 Playlist Antrean Musik Voice',
      description: desc,
      color: 0x5865F2,
      footer: { text: `Total: ${session.queue.length + (session.song ? 1 : 0)} lagu` },
    });
  }

  if (action === 'stop') {
    if (!session) return ctx.reply('Bot sedang tidak berada di Voice Channel server ini.');
    session.queue = [];
    try {
      session.player.stop();
      session.connection.destroy();
    } catch {}
    guildSessions.delete(guild.id);
    return ctx.reply('⏹️ Musik dihentikan, mikrofon dimatikan, dan bot telah keluar dari Voice Channel.');
  }

  if (action === 'pause') {
    if (!session) return ctx.reply('Bot sedang tidak memutar musik.');
    session.player.pause();
    return ctx.reply('⏸️ Musik dijeda sementara.');
  }

  if (action === 'resume') {
    if (!session) return ctx.reply('Bot sedang tidak memutar musik.');
    session.player.unpause();
    return ctx.reply('▶️ Melanjutkan pemutaran musik.');
  }
}

async function renderDiscordMenu(ctx, botData) {
  const infoMod = require('../plugins/whatsapp/01-info');
  const cats = infoMod.CATS;
  const catKeys = infoMod.CAT_KEYS;
  const sub = (ctx.args[0] || '').toLowerCase();
  const p = botData?.prefix || '!';

  if (sub === 'all') {
    let txt = `📋 **SELURUH FITUR ${botData.bot_name} (320+ Perintah)**\n\n`;
    for (const k of catKeys) {
      const cmds = (cats[k] || []).map(c => `\`${p}${c}\``).join('  ');
      txt += `〔 **${infoMod.catLabel(k)}** 〕\n${cmds}\n\n`;
    }
    return ctx.reply(txt);
  }

  if (sub && cats[sub]) {
    const cmds = (cats[sub] || []).map(c => `\`${p}${c}\``).join(', ');
    return ctx.replyEmbed({
      title: `〔 Menu ${infoMod.catLabel(sub)} 〕`,
      description: cmds,
      color: 0x5865F2,
      footer: { text: `Ketik ${p}menu all untuk melihat seluruh perintah` },
    });
  }

  const fields = [
    { name: '🤖 AI (Kecerdasan Buatan)', value: `\`${p}ai\`, \`/ai\` (Tanya & Foto)`, inline: true },
    { name: '🎵 Musik Voice Channel', value: `\`/music play\`, \`/music queue\`, \`/music skip\``, inline: true },
    { name: '📥 Downloader (40+)', value: `\`${p}tiktok\`, \`${p}youtube\`, \`${p}ig\`, \`${p}twit\``, inline: true },
    { name: '🛠️ Utilitas / Tools', value: `\`${p}tourl\`, \`${p}sticker\`, \`${p}cuaca\`, \`${p}gempa\``, inline: true },
    { name: '🎮 Game & RPG', value: `\`${p}dice\`, \`${p}slot\`, \`${p}asahotak\``, inline: true },
    { name: '🛡️ Server Moderasi', value: `\`/server purge\`, \`/server verify_panel\``, inline: true },
  ];

  return ctx.replyEmbed({
    title: `⚡ MENU UTAMA ${botData.bot_name} (320+ Fitur Aktif)`,
    description: `Gunakan prefix **\`${p}\`** atau Slash Command **\`/\`** untuk menjalankan perintah.\nKetik **\`${p}menu all\`** untuk melihat semua 320 perintah lengkap.`,
    color: 0x5865F2,
    fields,
    footer: { text: botData.footer_text || 'Powered by qwertygate' },
  });
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
  if (ctx.command === 'menu' || ctx.command === 'help') {
    return renderDiscordMenu(ctx, botData);
  }

  // Voice player Discord jika dipanggil dengan prefix .play, .stop, dsb.
  const memberVoice = message.member?.voice?.channel;
  if (memberVoice && ctx.command === 'play') {
    return executeDiscordVoiceAction({
      action: 'play',
      query: ctx.args.join(' '),
      ctx,
      guild: message.guild,
      memberVoice,
      user: message.author,
      textChannel: message.channel,
      botData,
      botId,
    });
  }
  if (['stop', 'skip', 'pause', 'resume', 'queue'].includes(ctx.command)) {
    const hasVoiceSession = botVoiceSessions.get(botId)?.get(message.guild?.id);
    if (hasVoiceSession) {
      return executeDiscordVoiceAction({
        action: ctx.command,
        query: ctx.args.join(' '),
        ctx,
        guild: message.guild,
        memberVoice,
        user: message.author,
        textChannel: message.channel,
        botData,
        botId,
      });
    }
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
      {
        name: 'broadcast',
        desc: 'Kirim siaran pengumuman ke seluruh server Discord tempat bot berada',
        options: [{ name: 'pesan', desc: 'Teks broadcast', type: 3, required: true }],
      },
    ],
  },
  {
    name: 'music',
    desc: 'Pemutar musik voice channel server',
    subcommands: [
      {
        name: 'play',
        desc: 'Putar lagu atau tambahkan ke antrean playlist',
        options: [{ name: 'query', desc: 'Judul lagu atau link YouTube', type: 3, required: true }],
      },
      { name: 'skip', desc: 'Lewati lagu saat ini dan putar antrean berikutnya' },
      { name: 'queue', desc: 'Lihat daftar antrean lagu saat ini' },
      { name: 'stop', desc: 'Hentikan musik, bersihkan antrean, dan keluar dari voice channel' },
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
    if (subCmd === 'broadcast') {
      const isOwner = interaction.user.id === botData.owner_number || interaction.member?.permissions?.has('Administrator');
      if (!isOwner) return ctx.reply('Perintah broadcast hanya bisa dijalankan oleh Admin atau Owner bot.');
      const pesan = interaction.options.getString('pesan');
      if (!pesan) return ctx.reply('Isi pesan broadcast tidak boleh kosong.');

      let totalSent = 0;
      for (const g of client.guilds.cache.values()) {
        const ch = g.systemChannel || g.channels.cache.find(c => c.isTextBased() && c.permissionsFor(g.members.me)?.has('SendMessages'));
        if (ch) {
          await ch.send({
            embeds: [{
              title: `📢 Broadcast ${botData.bot_name}`,
              description: pesan,
              color: 0x5865F2,
              footer: { text: botData.footer_text || 'Powered by qwertygate' },
            }],
          }).catch(() => {});
          totalSent++;
        }
      }
      return ctx.reply(`✅ Broadcast berhasil dikirim ke **${totalSent}** server Discord.`);
    }
  }

  if (interaction.commandName === 'music' || ['play', 'stop', 'skip', 'pause', 'resume', 'queue'].includes(interaction.commandName)) {
    const act = interaction.commandName === 'music' ? subCmd : interaction.commandName;
    const q = interaction.options.getString('query') || interaction.options.getString('judul') || ctx.args.join(' ');
    return executeDiscordVoiceAction({
      action: act,
      query: q,
      ctx,
      guild: interaction.guild,
      memberVoice: interaction.member?.voice?.channel,
      user: interaction.user,
      textChannel: interaction.channel,
      botData,
      botId,
    });
  }

  if (ctx.command === 'ping') return ctx.reply('🏓 Pong! (Discord Engine)');
  if (ctx.command === 'uptime') {
    const s = Math.floor(process.uptime());
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return ctx.reply(`⏰ Uptime: ${h}j ${m}m ${s % 60}d`);
  }
  if (ctx.command === 'menu' || ctx.command === 'help') {
    return renderDiscordMenu(ctx, botData);
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

  // Anti-Link Guard: deteksi link grup / undangan / phishing di server
  const DISCORD_LINK_PATTERN = /(?:https?:\/\/|www\.)[^\s]+|discord(?:\.gg|app\.com\/invite)\/[^\s]+|t\.me\/[^\s]+|chat\.whatsapp\.com\/[^\s]+/i;

  client.on('messageCreate', async (message) => {
    if (message.guild && !message.author?.bot && DISCORD_LINK_PATTERN.test(message.content)) {
      const isOwnerOrAdmin = message.member?.permissions?.has('Administrator') || message.author.id === botData.owner_number;
      if (!isOwnerOrAdmin) {
        await message.delete().catch(() => {});
        return message.channel.send({
          content: `⚠️ <@${message.author.id}>, dilarang mengirim tautan atau link asing di server ini!`,
        }).then(m => setTimeout(() => m.delete().catch(() => {}), 4000)).catch(() => {});
      }
    }
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
