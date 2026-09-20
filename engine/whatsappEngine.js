'use strict';

/**
 * engine/whatsappEngine.js
 * Multi-session WhatsApp engine — berbasis WhiskeySockets/Baileys v7.
 * Setiap bot mendapat client tersendiri dengan auth state SQLite terpisah.
 */

const path = require('path');
const fs   = require('fs');
require('dotenv').config();

const { pool, incrementStat, decrementStat } = require('../config/database');
const { activeBots, activeGroupsPerBot, activeChannelsPerBot } = require('../controllers/botController');
const { isPendingSewa } = require('./pendingSewa');
const { lidToPn, lidToPnAsync } = require('./jid');
const { renderTemplate } = require('./template');
const mess = require('../config/mess');

// Track grup yang sudah dikirimi pesan "tidak terdaftar" agar tidak spam
// Key: `${botId}:${groupJid}` — hapus otomatis setelah 10 menit
const notifiedUnregistered = new Map();

// Bot yang sedang di-stop / clear-session — auto-reconnect harus skip
const stoppingBots = new Set();

// Bot yang lagi dipairing lewat pairing code. Dipakai auto-reconnect biar
// koneksi baru TETAP di mode pairing — dulu reconnect hardcode `false`, jadi
// jatuh ke mode QR: panel yang lagi nampilin kode pairing ketimpa QR.
const pairingBots = new Set();

// ─── Persist activeGroups per bot ────────────────────────────────────────────
const GROUPS_CACHE_DIR = path.join(__dirname, '../data');
if (!fs.existsSync(GROUPS_CACHE_DIR)) fs.mkdirSync(GROUPS_CACHE_DIR, { recursive: true });

function groupsCacheFile(botId) {
  return path.join(GROUPS_CACHE_DIR, `active-groups-${botId}.json`);
}

function loadGroupsCache(botId) {
  try {
    const file = groupsCacheFile(botId);
    if (!fs.existsSync(file)) return;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!activeGroupsPerBot.has(botId)) activeGroupsPerBot.set(botId, new Map());
    for (const [jid, name] of Object.entries(data)) {
      activeGroupsPerBot.get(botId).set(jid, name);
    }
  } catch { /* file corrupt / missing — skip */ }
}

function saveGroupsCache(botId) {
  try {
    const map = activeGroupsPerBot.get(botId);
    if (!map) return;
    fs.writeFileSync(groupsCacheFile(botId), JSON.stringify(Object.fromEntries(map)), 'utf8');
  } catch { /* skip */ }
}

// ─── Lazy-load Baileys (lewat adapter yg mempertahankan wajah client lama) ────────
let createClient, makeSqliteAuthState;
try {
  ({ createClient } = require('./baileys/client'));
  ({ makeSqliteAuthState } = require('./baileys/auth'));
} catch (e) {
  console.warn('[Engine] baileys tidak terinstall — WhatsApp engine disabled:', e.message);
}

// Logger no-op — supaya log internal Baileys tidak flood console server
const noopLogger = {
  level: 'silent',
  trace: () => {}, debug: () => {}, info: () => {},
  warn:  () => {}, error: () => {}, fatal: () => {},
  child: () => noopLogger,
};

const SESSIONS_DIR = path.resolve(process.env.SESSIONS_DIR || './sessions');

// Global per-bot settings (nyimak, autoread) — dikelola di config/globalSettings.js
const { getBotGlobalSetting, setBotGlobalSetting, getMuteGrup } = require('../config/globalSettings');
// Cooldown balasan tanpa prefix (nyebut "bot") — per bot per grup.
const mentionCooldown = new Map();

// ─── Owner & Developer greeting cooldown store ───────────────────────────────
// key: `${botId}:${groupJid}` → timestamp last greeting
const ownerGreetCooldown = new Map();
const devGreetCooldown   = new Map(); // key: groupJid → timestamp
// Logika LID↔PN dipusatkan di engine/jid.js supaya cache-nya SATU (dulu tiap
// file punya Map sendiri → user bisa tampil beda jid di log yang beda).
const { needsLidResolve, lidToPn: resolveLid, lidToPnAsync: resolveLidAsync, bare } = require('./jid');

// ─── WS broadcast helper ──────────────────────────────────────────────────────
let _wsBroadcast = () => {};
function setWsBroadcast(fn) { _wsBroadcast = fn; }

function broadcast(botId, type, payload) {
  _wsBroadcast({ botId, type, payload, ts: Date.now() });
}

// ─── Log helper ───────────────────────────────────────────────────────────────
async function logBot(botId, level, message) {
  broadcast(botId, 'log', { level, message });
  try {
    await pool.execute(
      'INSERT INTO bot_logs (bot_id, level, message) VALUES (?, ?, ?)',
      [botId, level, String(message).slice(0, 2000)]
    );
  } catch { /* non-critical */ }
}

// ─── Load plugins ─────────────────────────────────────────────────────────────
function loadPlugins() {
  const pluginsDir = path.resolve('./plugins');
  const handlers   = [];
  if (!fs.existsSync(pluginsDir)) return handlers;
  const files = fs.readdirSync(pluginsDir).filter(f => f.endsWith('.js')).sort();
  for (const file of files) {
    try {
      const mod = require(path.join(pluginsDir, file));
      if (typeof mod === 'function') handlers.push(mod);
      else if (typeof mod.handler === 'function') handlers.push(mod.handler);
    } catch (e) {
      console.warn(`[Engine] Failed to load plugin ${file}:`, e.message);
    }
  }
  return handlers;
}

// Kumpulkan semua limitedCmds dari tiap plugin jadi satu Set
function buildLimitedCmds() {
  const pluginsDir = path.resolve('./plugins');
  const result = new Set();
  if (!fs.existsSync(pluginsDir)) return result;
  const files = fs.readdirSync(pluginsDir).filter(f => f.endsWith('.js')).sort();
  for (const file of files) {
    try {
      const mod = require(path.join(pluginsDir, file));
      if (mod.limitedCmds instanceof Set) {
        for (const cmd of mod.limitedCmds) result.add(cmd);
      }
    } catch { /* skip */ }
  }
  return result;
}

const PLUGIN_LIMITED_CMDS = buildLimitedCmds();

// Command yang tetap jalan walau grupnya dibisukan — tanpa ini nggak ada
// jalan keluar dari `.mute` selain restart bot.
const BEBAS_SAAT_MUTE = new Set(['unmute', 'listmute']);

// Nomor developer — peran TERTINGGI di bot ini. Dev bukan pemilik bot, tapi
// yang ngoprek kodenya, jadi dia ada di atas owner. Satu daftar dipakai bareng
// (dulu 3 tempat masing-masing nyalin logika env-nya sendiri):
//   engine dev-greeting, plugins/10-crm.js, plugins/02-group.js (antidelete)
// terima DEVELOPER_NUMBER maupun versi jamak (dipisah koma) biar nggak ada
// nama env yang diabaikan tanpa sengaja.
const DEV_NUMBERS = new Set(
  String(process.env.DEV_NUMBERS || process.env.DEVELOPER_NUMBERS || process.env.DEVELOPER_NUMBER || '')
    .split(',').map((n) => n.replace(/\D/g, '')).filter(Boolean)
);

/**
 * Nomor polos pengirim, '' kalau nggak masuk akal.
 * `ctx.sender` udah di-resolve LID→PN di atas (baris ~579), jadi tinggal `bare`.
 * Pembanding nomor (owner/dev) WAJIB lewat sini: tanpa gerbang ini, nomor yang
 * kosong bisa `'' === ''` dan semua orang jadi owner.
 */
const nomorPengirim = (jid) => {
  const n = bare(jid);
  return /^\d{6,}$/.test(n) ? n : '';
};

// ─── Build message context for plugins ────────────────────────────────────────
function buildContext(client, event, botData) {
  const { key, message, chatJid, pushName } = event;
  const jid      = chatJid || key?.remoteJid || '';
  const isGroup  = jid.endsWith('@g.us');
  const senderRaw = isGroup ? (key?.participant || jid) : jid;
  const sender    = resolveLid(senderRaw);

  const body =
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption || '';

  const prefix = botData.prefix ?? '.';
  const isCmd  = prefix === '' ? body.length > 0 : body.startsWith(prefix);
  const [rawCmd, ...args] = body.slice(isCmd && prefix ? prefix.length : 0).trim().split(/\s+/);
  const command = rawCmd?.toLowerCase() || '';

  // Resolve mentionedJids dari LID ke phone JID
  const rawMentioned = message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  const mentioned = rawMentioned.map(m => resolveLid(m));

  return {
    // client adapter instance (replaces sock)
    sock:     client,
    client,
    msg:      event,
    botData,
    jid,
    sender,
    isGroup,
    body,
    prefix,
    isCmd,
    command,
    args,
    mentioned,
    activeGroups: activeGroupsPerBot.get(botData.id) || new Map(),
    pushName: pushName || 'User',
    // Helper: reply with text + contextInfo (tanpa interactiveMessage —
    // wrapper itu yang bikin WA nampilin chrome "permintaan berhasil / lihat detail")
    reply: async (text) => {
      const full = `${text}\n\n${botData.footer_text || ''}`.trim();
      try {
        return await client.message.send(jid, {
          text: full,
          contextInfo: {
            quotedMessage: {
              groupInviteMessage: {
                caption: 'www.yapari.web.id',
              },
            },
          },
        });
      } catch (e) {
        // Kalau dua-duanya gagal, errornya nggak boleh ilang — kalau nggak, bot
        // kelihatan "diem" padahal kirimannya ditolak WA.
        console.log(`[send] ${jid} tolak quote (${e?.message || e}) — kirim plain`);
        return client.message.send(jid, full);
      }
    },
    // Helper: balas sebagai pesan ber-label AI (messageContextInfo + node bot).
    // Nggak pakai footer biar tetap kelihatan kayak balasan manusia.
    replyAI: (text) => client.message.send(jid, { text: String(text) }, { ai: true }),
    // Helper: react with emoji
    react: (emoji) =>
      client.message.send(jid, {
        type: 'reaction',
        emoji,
        target: key,
      }).catch(() => {}),
  };
}

// ─── Bot yang lagi direstart manual → jangan auto-reconnect ──────────────────
// stopWhatsAppBot() ngehapus IS_RUNNING dari DB (niat user = berhenti), jadi
// restartBot() harus nge-set balik 1 SEBELUM stop dipanggil — kalau nggak,
// auto-start pas boot server nganggap bot ini nggak dimau lagi.
const restartingBots = new Set();

// botId -> resolve() yang dipanggil pas guard 'connection close' nge-hold close-nya.
// Dipakai stopWhatsAppBot() buat nunggu koneksi bener-bener lepas (bukan timer
// nebak-nebak). Kunci: di-release PAS guard, jadi stoppingBots masih ke-set
// waktu guard baca — dulu urutannya kebalik dan guard-nya nggak pernah kejalan.
const stopCloseWaiters = new Map();

// ─── Kapan tiap bot terakhir nyambung ke WA ──────────────────────────────────
// Dipakai .uptime / .runtime / .info. process.uptime() & START_TIME salah buat
// ini: keduanya nempel di PROSES, sementara command .restart cuma mutus koneksi
// satu bot — proses (dan semua bot lain di dalamnya) tetap hidup, jadi
// uptime-nya nggak pernah kek-reset. Map ini set per koneksi 'open'.
const botConnectedAt = new Map();

// ─── Main start function ──────────────────────────────────────────────────────
async function startWhatsAppBot(botData, usePairingCode = false) {
  if (!createClient) throw new Error('baileys tidak terinstall');

  const botId  = botData.id;
  const botDir = path.join(SESSIONS_DIR, `bot_${botId}`);
  fs.mkdirSync(botDir, { recursive: true });

  // Jangan pernah ada DUA soket WA buat nomor yang sama dalam satu proses:
  // soket kedua bikin WA mutus salah satunya -> bot kelihatan online tapi nggak
  // jawab, koneksi drop-terus. Ponytail: stopWhatsAppBot() nunggu close, tapi ini
  // jaring pengaman kalau ada jalur lain manggil start barengan.
  if (activeBots.has(botId)) { throw new Error(`Bot ${botId} sudah berjalan`); }

  // Catat niat pairing SEBELUM apa pun yang bisa gagal — auto-reconnect
  // baca set ini buat milih mode.
  if (usePairingCode) pairingBots.add(botId);
  else pairingBots.delete(botId);

  const dbPath = path.join(botDir, 'session.db');

  await logBot(botId, 'info', `Memulai bot "${botData.bot_name}"...`);
  await pool.execute("UPDATE bots SET status = 'connecting' WHERE id = ?", [botId]);
  broadcast(botId, 'status', { status: 'connecting' });

  const authFull = makeSqliteAuthState(dbPath);
  const auth     = authFull.state;
  const logger   = noopLogger;

  const client = createClient({
    auth,
    saveCreds: authFull.saveCreds,
    logger,
    pairingMode: !!usePairingCode,
  });
  // Ditutup saat stop — biar file SQLite nggak ke-lock (EPERM di Windows).
  client.__closeAuth = authFull.close;

  // Simpan ke activeBots
  activeBots.set(botId, client);

  // Cache nama grup supaya tidak fetch ulang setiap pesan
  const groupNameCache = new Map();
  // Cache daftar grup aktif untuk broadcast — load dari file dulu
  if (!activeGroupsPerBot.has(botId)) activeGroupsPerBot.set(botId, new Map());
  loadGroupsCache(botId);

  const plugins = loadPlugins();

  // ── auth_qr ───────────────────────────────────────────────────────────────
  // Di mode pairing adapter nggak pernah emit 'auth_qr' (lihat client.js), jadi
  // baris ini praktis nggak kepanggil. Dijaga dua lapis biar QR nyasar nggak
  // nendang panel pairing yang lagi nampilin kode.
  client.on('auth_qr', async ({ qr, ttlMs }) => {
    if (usePairingCode) return;
    await logBot(botId, 'info', `QR_DATA:${qr}`);
    broadcast(botId, 'qr', { qr, ttlMs });
    await pool.execute("UPDATE bots SET status = 'qr_pending' WHERE id = ?", [botId]);
    broadcast(botId, 'status', { status: 'qr_pending' });
  });

  // ── auth_paired ───────────────────────────────────────────────────────────
  client.on('auth_paired', async ({ credentials }) => {
    await logBot(botId, 'info', `Paired sebagai: ${credentials.meJid}`);
    await logBot(botId, 'info', 'Sinkronisasi sesi... harap tunggu');
    broadcast(botId, 'status', { status: 'connecting' });
  });

  // ── connection ────────────────────────────────────────────────────────────
  client.on('connection', async (event) => {
    const { status, reason, isLogout } = event;

    if (status === 'open') {
      pairingBots.delete(botId); // pairing selesai — reconnect berikutnya cukup mode normal
      botConnectedAt.set(botId, Date.now()); // dipakai .uptime — umur bot ini, bukan umur proses
      console.log(`[Bot ${botId}] ✅ Terhubung ke WhatsApp`);
      await logBot(botId, 'info', 'Bot terhubung ke WhatsApp');
      // is_running = 1 di sini bukan sekadar penanda status: server.js:242
      // auto-start bot yang is_running=1 pas boot. Jadi begitu pernah
      // connected, bot wajib ikut hidup lagi setelah restart server.
      await pool.execute("UPDATE bots SET status = 'connected', is_running = 1 WHERE id = ?", [botId]);
      await incrementStat('total_bots_online');
      broadcast(botId, 'status', { status: 'connected' });

      // ── Auto-follow developer channel ──────────────────────────────────────
      if (process.env.CH_DEV) {
        setTimeout(async () => {
          try {
            await client.newsletter.follow(process.env.CH_DEV);
            console.log(`[Bot ${botId}] 📢 Auto-follow channel: ${process.env.CH_DEV}`);
          } catch (e) {
            console.log(`[Bot ${botId}] ⚠️ Gagal follow channel: ${e.message}`);
          }
        }, 5000); // delay 5 detik setelah connect
      }

      // ── Sewa expired daemon ─────────────────────────────────────────────
      // Cek setiap 5 menit: warning 1 jam sebelum expired, leave kalau sudah expired
      const sewaTimer = setInterval(async () => {
        try {
          const now = Date.now();
          const [rows] = await pool.execute(
            'SELECT group_jid, group_name, expired_at, warned FROM bot_sewa WHERE bot_id = ? AND expired_at IS NOT NULL',
            [botId]
          );
          for (const row of rows) {
            const exp   = Number(row.expired_at);
            const sisa  = exp - now;
            const gjid  = row.group_jid;
            const gname = row.group_name || gjid.split('@')[0];

            // Expired — bot leave grup
            if (sisa <= 0) {
              try {
                await client.message.send(gjid,
                  `⚠️ *Masa sewa bot di grup ini telah habis!*\n\nBot akan meninggalkan grup. Hubungi owner untuk perpanjang sewa.`
                );
                await new Promise(r => setTimeout(r, 2000));
                await client.group.leaveGroup([gjid]);
              } catch {}
              await pool.execute(
                'DELETE FROM bot_sewa WHERE bot_id = ? AND group_jid = ?',
                [botId, gjid]
              );
              console.log(`[Bot ${botId}] 🚪 Leave grup sewa expired: ${gname}`);
              continue;
            }

            // Warning 1 jam sebelum expired, kirim sekali
            if (sisa <= 3600000 && !row.warned) {
              try {
                const menit = Math.ceil(sisa / 60000);
                await client.message.send(gjid,
                  `⚠️ *Peringatan Sewa Bot!*\n\nMasa sewa di grup ini akan habis dalam *${menit} menit*.\n\nSegera hubungi owner untuk perpanjang sewa agar bot tidak keluar dari grup.`
                );
              } catch {}
              await pool.execute(
                'UPDATE bot_sewa SET warned = 1 WHERE bot_id = ? AND group_jid = ?',
                [botId, gjid]
              );
            }
          }
        } catch (e) {
          console.error(`[Bot ${botId}] Sewa daemon error: ${e.message}`);
        }
      }, 5 * 60 * 1000); // 5 menit

      // Stop daemon kalau bot disconnect
      client.once('connection', (ev) => {
        if (ev.status === 'close') clearInterval(sewaTimer);
      });
    }

    if (status === 'close') {
      console.log(`[Bot ${botId}] ❌ Koneksi terputus: ${reason}`);
      await logBot(botId, 'warn', `Koneksi terputus: ${reason}`);
      // is_running SENGAJA tidak di-nol-in di sini. Kolom itu artinya "user mau
      // bot ini jalan", bukan "socket lagi kebuka" — dipakai server.js:242 buat
      // auto-start pas boot. Dulu di-nol-in tiap disconnect, jadi tiap putus
      // sesaat (WA drop koneksi normal) bot hilang dari daftar auto-start.
      // Yang nol-in cuma aksi eksplisit user: stopBot, deleteBot, clearSession.
      await pool.execute("UPDATE bots SET status = 'disconnected' WHERE id = ?", [botId]);
      broadcast(botId, 'status', { status: 'disconnected', reason });

      if (activeBots.has(botId)) {
        activeBots.delete(botId);
        await decrementStat('total_bots_online');
      }

      // Koneksi udah lepas beneran. stopWhatsAppBot() yang lagi nunggu (kalau ini
      // bagian dari restart) baru boleh lanjut setelah guard di bawah mutusin.
      const releaseStop = stopCloseWaiters.get(botId);
      if (releaseStop) { stopCloseWaiters.delete(botId); releaseStop(); }

      if (stoppingBots.has(botId)) {
        const isRestart = restartingBots.delete(botId);
        console.log(`[Bot ${botId}] ${isRestart ? '🔁 Restart manual — mesin restart yang nge-start' : '🛑 Di-stop manual — tidak reconnect'}`);
        if (!isRestart) {
          // Niat user = berhenti. Ini satu-satunya tempat (selain logout) yang
          // boleh nol-in is_running dari sisi engine.
          await pool.execute("UPDATE bots SET is_running = 0 WHERE id = ?", [botId]);
          return;
        }
        // Restart: stopWhatsAppBot() yang nunggu close ini, dan dia udah
        // nge-return sebelum sampai sini (lihat wasRestarting di sana) — jadi
        // nggak ada yang nge-start dari jalur ini. Jangan diteruskan ke
        // auto-reconnect di bawah.
        return;
      }

      if (isLogout) {
        console.log(`[Bot ${botId}] 🚪 Logout — hapus sesi untuk scan ulang`);
        await logBot(botId, 'warn', 'Sesi logout. Hapus sesi untuk scan ulang.');
        // Sesi mati: reconnect percuma (selalu ditolak). Nol-in is_running biar
        // auto-start boot nggak ngubek-ngubek sesi mati ini tiap restart.
        await pool.execute("UPDATE bots SET is_running = 0 WHERE id = ?", [botId]);
      } else {
        console.log(`[Bot ${botId}] 🔄 Reconnect dalam 5 detik...`);
        await logBot(botId, 'info', 'Reconnect dalam 5 detik...');
        setTimeout(async () => {
          try {
            const [rows] = await pool.execute('SELECT * FROM bots WHERE id = ?', [botId]);
            const freshBotData = rows[0] || botData;
            await startWhatsAppBot(freshBotData, pairingBots.has(botId));
          } catch (e) {
            console.error(`[Bot ${botId}] 💥 Reconnect error: ${e.message}`);
            await logBot(botId, 'error', `Reconnect error: ${e.message}`);
          }
        }, 5000);
      }
    }
  });

  // ── message ───────────────────────────────────────────────────────────────
  client.on('message', async (event) => {
    // Safety net: apa pun yang meledak di handler ini harus kelog, jangan mati diem.
    // Tanpa ini, rejection tanpa catch = proses mati (Node >= 15) -> bot restart dan
    // command yang lagi diproses nggak pernah dibalas ("bot kadang ga respon").
    try {
    const t0 = Date.now(); // buat ngukur command lambat ("bot mesti 2x baru respon")
    const { key, message } = event;

    // Skip pesan tanpa isi
    if (!message) return;

    const msgType = Object.keys(message)[0];
    const isDeleteEvent = msgType === 'protocolMessage' && message.protocolMessage?.type === 0;

    // ── Group event detector ──────────────────────────────────────────────────
    // Tangkap pesan sistem grup (ganti nama, icon, deskripsi, promote, dll)
    // Cek apakah ada setting detect di group_settings
    const stubType = event.messageStubType || event.msg?.messageStubType;
    const stubParams = event.messageStubParameters || event.msg?.messageStubParameters || [];
    const stubJid = event.chatJid || key?.remoteJid || '';
    if (stubType && stubJid.endsWith('@g.us')) {
      try {
        const { proto } = require('baileys');
        const ST = proto.WebMessageInfo.StubType;
        const [gsRows] = await pool.execute(
          'SELECT detect FROM group_settings WHERE bot_id = ? AND group_jid = ? LIMIT 1',
          [botId, stubJid]
        ).catch(() => [[]]);

        if (gsRows[0]?.detect) {
          const actor = key?.participant || '';
          const edtr  = actor ? `@${actor.split('@')[0]}` : 'Seseorang';
          const mentions = actor ? [actor] : [];
          let txt = null;

          switch (stubType) {
            case ST.GROUP_CHANGE_SUBJECT:
              txt = `${edtr} mengubah nama grup menjadi:\n*${stubParams[0] || ''}*`; break;
            case ST.GROUP_CHANGE_ICON:
              txt = `${edtr} telah mengubah icon grup.`; break;
            case ST.GROUP_CHANGE_INVITE_LINK:
              txt = `${edtr} *mereset* link undangan grup!`; break;
            case ST.GROUP_CHANGE_DESCRIPTION:
              txt = `${edtr} mengubah deskripsi grup.\n\n${stubParams[0] || ''}`; break;
            case ST.GROUP_CHANGE_RESTRICT:
              txt = `${edtr} telah mengatur agar *${stubParams[0] === 'on' ? 'hanya admin' : 'semua peserta'}* yang dapat mengedit info grup.`; break;
            case ST.GROUP_CHANGE_ANNOUNCE:
              txt = `${edtr} telah *${stubParams[0] === 'on' ? 'menutup' : 'membuka'}* grup!\nSekarang ${stubParams[0] === 'on' ? 'hanya admin yang' : 'semua peserta'} dapat mengirim pesan.`; break;
            case ST.GROUP_PARTICIPANT_PROMOTE:
              txt = `${edtr} menjadikan @${(stubParams[0] || '').split('@')[0]} sebagai *admin*.`;
              if (stubParams[0]) mentions.push(stubParams[0]); break;
            case ST.GROUP_PARTICIPANT_DEMOTE:
              txt = `${edtr} memberhentikan @${(stubParams[0] || '').split('@')[0]} dari *admin*.`;
              if (stubParams[0]) mentions.push(stubParams[0]); break;
          }

          if (txt) {
            await client.message.send(stubJid, { text: txt, mentions });
          }
        }
      } catch { /* non-critical */ }
    }

    // Skip pesan dari diri sendiri — kecuali delete event (dikirim dengan fromMe=true)
    if (key?.fromMe && !isDeleteEvent) return;

    // Skip pesan sistem (encryption handshake, dll) — bukan pesan user
    // Tapi protocolMessage type 0 (delete) tetap diteruskan untuk antidelete
    const SKIP_TYPES = ['senderKeyDistributionMessage', 'reactionMessage'];
    if (SKIP_TYPES.includes(msgType)) return;
    if (msgType === 'protocolMessage' && !isDeleteEvent) return;

    await incrementStat('total_messages');

    const jid = event.chatJid || key?.remoteJid || '';

    // Label yang lebih bersih untuk log
    const typeLabel = {
      conversation:          'teks',
      extendedTextMessage:   'teks',
      imageMessage:          'gambar',
      videoMessage:          'video',
      audioMessage:          'audio',
      documentMessage:       'dokumen',
      stickerMessage:        'stiker',
      contactMessage:        'kontak',
      locationMessage:       'lokasi',
    }[msgType] || msgType;

    const ctx = buildContext(client, event, botData);

    // Resolusi nama chat — cache grup agar tidak fetch setiap pesan
    let chatName = jid.split('@')[0];
    try {
      if (ctx.isGroup) {
        const nameHit = groupNameCache.get(jid);
        if (nameHit) {
          chatName = nameHit;
          activeGroupsPerBot.get(botId)?.set(jid, chatName);
        }
        // Metadata dibaca kalau nama grup belum ke-cache ATAU masih ada JID LID
        // yang belum ke-map ke nomor. Dari metadata inilah peta LID<->PN diisi
        // (groupMeta() di engine/baileys/client.js) — urutannya SEBELUM
        // ctx.sender/ctx.mentioned di-resolve di bawah. Tanpa ini, pesan pertama
        // tiap grup setelah restart kepakai LID mentah: isOwner meleset (command
        // owner diem) dan @mention jadi teks polos.
        if (!nameHit || needsLidResolve(ctx)) {
          const meta = await client.group.queryGroupMetadata(jid);
          if (meta?.subject && !nameHit) {
            chatName = meta.subject;
            groupNameCache.set(jid, meta.subject);
            activeGroupsPerBot.get(botId)?.set(jid, meta.subject);
            saveGroupsCache(botId); // persist setiap kali ada grup baru
          }
        }
      }
    } catch { /* fallback ke JID pendek */ }

    // Update ctx.sender dengan phone JID setelah LID cache ter-populate
    ctx.sender = await resolveLidAsync(client, ctx.sender);
    // DM dari LID: jid chat juga di-resolve ke PN biar reply/kirim konsisten
    if (!ctx.isGroup && String(ctx.jid).endsWith('@lid')) {
      const pn = await resolveLidAsync(client, ctx.jid);
      if (pn !== ctx.jid) ctx.jid = pn;
    }
    // Resolve mentionedJids di ctx juga setelah cache ter-populate
    if (ctx.mentioned) ctx.mentioned = ctx.mentioned.map(m => resolveLid(m));

    // Nomor asli pengirim. Di grup LID, `ctx.sender` bisa masih `...@lid` —
    // query DB & bandingin ke *_number WAJIB pakai nomor, kalau nggak
    // isPremium/isOwner/isDev meleset (dev/owner kelihatan kayak user biasa).
    // Satu sumber dipakai bareng biar nggak ada yang lupa resolve.
    const senderNum = nomorPengirim(ctx.sender);

    // Inject isPremium — query DB, cek juga premium_expired
    ctx.isPremium = false;
    try {
      const [pmRows] = await pool.execute(
        'SELECT premium, premium_expired FROM rpg_members WHERE bot_id = ? AND jid = ? LIMIT 1',
        [botId, ctx.sender]
      );
      if (pmRows.length > 0 && pmRows[0].premium) {
        const exp = pmRows[0].premium_expired;
        ctx.isPremium = !exp || new Date(exp) > new Date();
      }
    } catch { /* fallback false */ }

    // Inject isAdmin/isOwner ke ctx
    ctx.isOwner = false;
    ctx.isAdmin = false;
    try {
      const ownerNum = botData.owner_number?.replace(/\D/g, '');
      if (senderNum && senderNum === ownerNum) ctx.isOwner = true;
      if (ctx.isGroup) {
        const meta = await client.group.queryGroupMetadata(jid).catch(() => null);
        if (meta?.participants) {
          const p = meta.participants.find(
            p => p.jid === ctx.sender || p.lid === ctx.sender ||
                 (p.phoneNumber && p.phoneNumber.includes(senderNum))
          );
          if (p?.isAdmin || p?.isSuperAdmin) ctx.isAdmin = true;
        }
      }
    } catch { /* fallback false */ }

    // ── Inject isDev — DEVELOPER_NUMBER (boleh >1, dipisah koma) ─────────────
    // Dev itu peran TERTINGGI: bukan pemilik bot, tapi yang ngoprek kodenya.
    // Dihitung di sini juga (bukan cuma di greeting) biar role & gate bisa pakai.
    ctx.isDev = Boolean(senderNum) && DEV_NUMBERS.has(senderNum);

    // ── Role — urutan dari yang paling sakti ─────────────────────────────────
    // dev > owner > premium > admin grup > user.
    // Dev di ATAS owner: owner itu pemilik bot, dev yang ngoprek kodenya.
    // Dihitung SEKALI di sini, jadi semua tampilan & gate baca sumber yang sama
    // (dulu `.limit` cuma lihat kolom `premium` di DB, jadi owner+dev pun
    // kelihatan 'User biasa').
    ctx.role = ctx.isDev     ? 'dev'
      : ctx.isOwner          ? 'owner'
      : ctx.isPremium        ? 'premium'
      : ctx.isAdmin          ? 'admin'
      : 'user';

    // ── Owner greeting ────────────────────────────────────────────────────────
    // Kalau sender adalah owner bot dan pesan di grup, kirim sambutan
    // Cooldown: 1 hari per grup (biar tidak spam setiap chat)
    if (ctx.isGroup && botData.owner_number) {
      try {
        const ownerNum    = botData.owner_number.replace(/\D/g, '');
        const senderNum   = ctx.sender.split('@')[0].split(':')[0];
        const isOwnerMsg  = senderNum === ownerNum;

        if (isOwnerMsg) {
          const cdKey  = `${botId}:${jid}`;
          const last   = ownerGreetCooldown.get(cdKey) || 0;
          const COOLDOWN = 45 * 60 * 1000; // 45 menit
          if (Date.now() - last > COOLDOWN) {
            ownerGreetCooldown.set(cdKey, Date.now());
            const ownerName = botData.owner_name || 'Owner';
            const mention   = ctx.sender.split('@')[0];
            await client.message.send(jid,
              `📣 *Perhatian semua!*\n\n@${mention} — *${ownerName}* telah hadir! Beri hormat! 🫡`,
              { mentions: [ctx.sender] }
            );
          }
        }
      } catch { /* non-critical */ }
    }

    // ── Developer greeting ────────────────────────────────────────────────────
    // Kalau sender adalah developer (dari DEVELOPER_NUMBER env), reply pesannya
    // Cooldown: 1000 detik per grup
    if (ctx.isGroup && ctx.isDev) {
      try {
        if (ctx.isDev) {
          const cdKey = `dev:${botId}:${jid}`;
          const last  = devGreetCooldown.get(cdKey) || 0;
          if (Date.now() - last > 45 * 60 * 1000) { // 45 menit
            devGreetCooldown.set(cdKey, Date.now());
            await client.message.send(jid,
              `yah ada dev, bteh gweh jirrr 😭`,
              { quote: { id: ctx.msg?.key?.id, key: ctx.msg?.key, message: ctx.msg?.message } }
            );
          }
        }
      } catch { /* non-critical */ }
    }
    const senderName     = event.pushName || jid.split('@')[0];
    const senderResolved = resolveLid(ctx.sender);
    const senderPhone = senderResolved.split('@')[0];
    // Replace LID di body untuk log yang lebih readable
    const bodyForLog = ctx.body.replace(/@(\d{15,})/g, (match, lid) => {
      const resolved = resolveLid(`${lid}@lid`);
      return resolved.endsWith('@lid') ? match : `@${resolved.split('@')[0]}`;
    });
    const preview = bodyForLog ? `: ${bodyForLog.slice(0, 80)}` : ` [${typeLabel}]`;
    // Log web terminal pakai nama, log PM2 pakai nomor
    const logLine = ctx.isGroup
      ? `${senderPhone} @ ${chatName}${preview}`
      : `${senderPhone}${preview}`;
    const logLineDisplay = ctx.isGroup
      ? `${senderName} @ ${chatName}${preview}`
      : `${senderName}${preview}`;

    broadcast(botId, 'message', {
      from:     jid,
      pushName: event.pushName,
      type:     typeLabel,
      body:     ctx.body,
    });

    // ── Autoread — centang biru semua pesan ──────────────────────────────────
    if (getBotGlobalSetting(botId, 'autoread')) {
      client.message.read([{ remoteJid: jid, id: key?.id || '', fromMe: false }]).catch(() => {});
    }

    // ── Filter Grup Utama + Grup Sewa ─────────────────────────────────────────
    // Bot hanya respon di: grup utama (main_groups) ATAU grup sewa aktif
    // Kalau main_groups kosong = respon di semua grup (mode bebas)
    // Pesan dari DM selalu diproses
    if (ctx.isGroup && botData.main_groups) {
      try {
        const mainList = botData.main_groups.split(',').map(s => s.trim()).filter(Boolean);
        if (mainList.length > 0) {
          const isMainGroup = mainList.includes(jid);
          // Cek grup sewa aktif
          let isSewaGroup = false;
          if (!isMainGroup) {
            const { pool: dbPool } = require('../config/database');

            // Cek pending sewa (expired_at NULL, pending_ms ada) → aktifkan sekarang
            const [pendingRows] = await dbPool.execute(
              'SELECT id, pending_ms FROM bot_sewa WHERE bot_id = ? AND group_jid = ? AND expired_at IS NULL AND pending_ms IS NOT NULL LIMIT 1',
              [botId, jid]
            );
            if (pendingRows.length > 0) {
              const { id, pending_ms } = pendingRows[0];
              const expiredAt = Date.now() + Number(pending_ms);
              await dbPool.execute(
                'UPDATE bot_sewa SET expired_at = ?, pending_ms = NULL, group_name = COALESCE(NULLIF(group_name, ?), group_name) WHERE id = ?',
                [expiredAt, jid.split('@')[0], id]
              );
              // Coba update nama grup
              try {
                const meta = await client.group.queryGroupMetadata(jid);
                if (meta?.subject) {
                  await dbPool.execute('UPDATE bot_sewa SET group_name = ? WHERE id = ?', [meta.subject, id]);
                }
              } catch {}
              console.log(`[Bot ${botId}] ✅ Sewa pending diaktifkan untuk grup: ${jid}`);
              isSewaGroup = true;
            } else {
              const [sewaRows] = await dbPool.execute(
                'SELECT id FROM bot_sewa WHERE bot_id = ? AND group_jid = ? AND expired_at > (UNIX_TIMESTAMP() * 1000) LIMIT 1',
                [botId, jid]
              );
              isSewaGroup = sewaRows.length > 0;
            }
          }
          if (!isMainGroup && !isSewaGroup) {
            // Cek apakah grup sedang dalam proses addsewa — jangan leave dulu
            if (isPendingSewa(botId, jid)) return;

            // Throttle — kirim pesan + leave hanya sekali per 10 menit per grup
            const throttleKey = `${botId}:${jid}`;
            if (!notifiedUnregistered.has(throttleKey)) {
              notifiedUnregistered.set(throttleKey, Date.now());
              setTimeout(() => notifiedUnregistered.delete(throttleKey), 10 * 60 * 1000);

              try {
                await client.message.send(jid, `grup apa ini anj 😹\n\nBot ini tidak aktif di grup ini. Sewa dulu baru bisa dipakai!\n\nHubungi owner untuk info sewa:`);
                if (botData.owner_number && botData.owner_name) {
                  const ownerPhone = botData.owner_number.replace(/\D/g, '');
                  const vcard =
                    `BEGIN:VCARD\nVERSION:3.0\nFN:${botData.owner_name}\nTEL;type=CELL;type=VOICE;waid=${ownerPhone}:+${ownerPhone}\nEND:VCARD`;
                  await client.message.send(jid, {
                    contactMessage: {
                      displayName: botData.owner_name,
                      vcard,
                    }
                  });
                }
                // Delay lalu leave
                await new Promise(r => setTimeout(r, 3000));
                await client.group.leaveGroup([jid]).catch(() => {});
                console.log(`[Bot ${botId}] 🚪 Leave grup tidak terdaftar: ${jid}`);
              } catch { /* non-critical */ }
            }
            return;
          }
        }
      } catch { /* jika error, lanjut saja */ }
    }

    // ── Nyimak — bot diam total, skip semua command ───────────────────────────
    if (getBotGlobalSetting(botId, 'nyimak') && ctx.isCmd) {
      // log tetap jalan, tapi tidak diproses plugin
      console.log(`[Bot ${botId}] 🤫 nyimak: ${logLine}`);
      return;
    }

    // ── Grup dibisukan (`.mute`) — bot diam total di grup itu ──────────────────
    // Dicek SEBELUM dispatch plugin, jadi kena semua pesan (command maupun
    // obrolan) termasuk antispam/welcome yang jalan sendiri. `.unmute` dan
    // `.listmute` dikecualikan — kalau nggak, nggak ada jalan keluar buat
    // ngebalikin dan bot cuma bisa di-unmute lewat restart.
    if (ctx.jid && !BEBAS_SAAT_MUTE.has(ctx.command) && getMuteGrup(botId, ctx.jid)) {
      console.log(`[Bot ${botId}] 🔇 grup dibisukan, dilewati: ${logLine}`);
      return;
    }

    // ── Balasan tanpa prefix ──────────────────────────────────────────────────
    // Kalau ada kata "bot" di pesan (bukan command, bukan dari bot sendiri),
    // balas "oh iyaa banggg" sebagai pesan ber-label AI. Dicek SEBELUM gerbang
    // registrasi: yang nyebut "bot" harus langsung dibalas, bukan ditawarin
    // daftar dulu. Cooldown biar nggak jadi spam tiap kali ada yang nyebut bot.
    // ponytail: kata tunggal apa aja yang persis "bot" — kalau mau "bot," / "bot!"
    // ikut kebaca, ganti tes-nya jadi /^bot\b/i.
    if (!ctx.isCmd && ctx.jid && ctx.body.trim().toLowerCase() === 'bot') {
      const cdKey = `${botId}:${ctx.jid}`;
      if (Date.now() - (mentionCooldown.get(cdKey) || 0) > 60 * 1000) {
        mentionCooldown.set(cdKey, Date.now());
        await ctx.replyAI('oh iyaa banggg').catch((e) => {
          console.log(`[Bot ${botId}] gagal balas "bot" (label AI): ${e?.message || e}`);
          return ctx.reply('oh iyaa banggg').catch(() => {});
        });
        return;
      }
    }

    // ── Gerbang registrasi — auto-daftar user baru ──────────────────────────
    // User yang belum pernah daftar langsung di-register otomatis begitu
    // kirim command apapun. Nama = pushName WA saat itu (bisa diganti via .uptname).
    if (ctx.isCmd) {
      try {
        const { pool: dbPool } = require('../config/database');
        const [regRows] = await dbPool.execute(
          'SELECT registered FROM rpg_members WHERE bot_id = ? AND jid = ? LIMIT 1',
          [botId, ctx.sender]
        );
        const isRegistered = regRows[0]?.registered === 1;

        if (!isRegistered) {
          // Owner — auto-daftar pakai owner_name, tanpa interrupt apapun
          if (ctx.isOwner) {
            const baseName = (botData.owner_name || ctx.pushName || 'Owner')
              .replace(/[^a-zA-Z0-9 ]/g, '').trim().slice(0, 20);
            const namaOwner = baseName || 'Owner';
            const defaultLim = botData.daily_limit || parseInt(process.env.DEFAULT_LIMIT || '20', 10);
            await dbPool.execute(
              `INSERT INTO rpg_members (bot_id, jid, name, registered, level, xp, money, lim, healt)
               VALUES (?, ?, ?, 1, 1, 0, 0, ?, 100)
               ON DUPLICATE KEY UPDATE name = VALUES(name), registered = 1, level = 1, xp = 0, money = 0, lim = ?, healt = 100`,
              [botId, ctx.sender, namaOwner, defaultLim, defaultLim]
            );
          } else {
            // User biasa — auto-register pakai pushName WA
            const baseName = (ctx.pushName || 'User')
              .replace(/[^a-zA-Z0-9 ]/g, '').trim().slice(0, 20);
            const namaUser = baseName || 'User';
            const defaultLim = botData.daily_limit || parseInt(process.env.DEFAULT_LIMIT || '20', 10);
            await dbPool.execute(
              `INSERT INTO rpg_members (bot_id, jid, name, registered, level, xp, money, lim, healt)
               VALUES (?, ?, ?, 1, 1, 0, 0, ?, 100)
               ON DUPLICATE KEY UPDATE name = IF(name IS NULL, VALUES(name), name), registered = 1`,
              [botId, ctx.sender, namaUser, defaultLim]
            );
            // Kasih tahu sekali aja — user baru auto-register
            const notifKey = `auto:${botId}:${ctx.sender}`;
            if (!notifiedUnregistered.has(notifKey)) {
              notifiedUnregistered.set(notifKey, Date.now());
              setTimeout(() => notifiedUnregistered.delete(notifKey), 24 * 60 * 60 * 1000);
              await client.message.send(ctx.jid,
                `✨ *Kamu otomatis terdaftar!*\n\n` +
                `Halo *${namaUser}*! Akun kamu langsung aktif tanpa daftar.\n\n` +
                `👤 Nama  : *${namaUser}*\n` +
                `⭐ Level : 1\n\n` +
                `Mau ganti nama? Ketik *${botData.prefix || '.'}uptname <nama>*\n` +
                `Cek akun: *${botData.prefix || '.'}profil*`
              ).catch(() => {});
            }
          }
        }
      } catch (regErr) {
        // DB error — jangan blokir, biarkan command jalan (log saja)
        console.error(`[Bot ${botId}] Gerbang registrasi DB error:`, regErr.message);
      }
    }

    // ── Cek & potong limit per command ───────────────────────────────────────
    // Owner dan premium skip sepenuhnya — user biasa kena limit kalau command
    // ada di PLUGIN_LIMITED_CMDS (dikumpulkan dari tiap plugin saat boot)
    if (ctx.isCmd && ctx.role === 'user' && PLUGIN_LIMITED_CMDS.has(ctx.command)) {
      try {
        const { pool: dbPool } = require('../config/database');
        const [limRows] = await dbPool.execute(
          'SELECT lim FROM rpg_members WHERE bot_id = ? AND jid = ? AND registered = 1 LIMIT 1',
          [botId, ctx.sender]
        );
        const curLim = limRows[0]?.lim ?? 0;
        if (curLim <= 0) {
          await client.message.send(ctx.jid,
            `❌ *Limit habis!*\n\nLimit kamu sudah habis hari ini.\n💎 Sisa limit: *0*\n\nTunggu reset harian jam *00:00* atau hubungi owner untuk tambah limit.`
          );
          return;
        }
        // Potong 1 limit
        await dbPool.execute(
          'UPDATE rpg_members SET lim = lim - 1 WHERE bot_id = ? AND jid = ? AND registered = 1',
          [botId, ctx.sender]
        );
      } catch { /* non-critical, lanjut */ }
    }

    // Jalankan semua plugin
    let cmdHandled = false;
    for (const handler of plugins) {
      try {
        const handled = await handler(ctx);
        if (handled) { cmdHandled = true; break; }
      } catch (e) {
        console.error(`[Bot ${botId}] 💥 Plugin error [${ctx.command || '?'}]: ${e.message}`);
        await logBot(botId, 'cmderr', `${ctx.command || '?'}: ${e.message}`);
        // Jangan diem aja: user nunggu balasan, plugin error tanpa pesan kelihatan
        // kayak bot "ga respon" padahal gagal.
        if (ctx.isCmd) {
          await client.message.send(ctx.jid, `⚠️ Error pas jalanin *${ctx.command}*: ${e.message}`).catch(() => {});
        }
        cmdHandled = true;
        break;
      }
    }

    // Log warna sesuai hasil — command dibarengi durasinya biar kelihatan kalau
    // handler-nya lambat (gejala "bot ga respon" / mesti kirim 2x).
    const tookTag = ctx.isCmd ? ` (+${Date.now() - t0}ms)` : '';
    console.log(`[Bot ${botId}] ${logLine}${tookTag}`);
    if (ctx.isCmd) {
      if (!cmdHandled) console.log(`[Bot ${botId}] ❓ Command tidak dikenal: ${logLine}`);
      await logBot(botId, cmdHandled ? 'cmd' : 'cmderr', `${logLineDisplay}${tookTag}`);
    } else {
      await logBot(botId, 'info', logLineDisplay);
    }
    } catch (err) {
      console.error(`[Bot ${botId}] 💬 Handler error: ${err.message}`);
      try { await logBot(botId, 'cmderr', `handler: ${err.message}`); } catch { /* log gagal ya sudah */ }
    }
  });

  // ── Welcome / Bye hook ────────────────────────────────────────────────────
  // adapter emits 'group_participants' when members join/leave
  //
  // Kunci pembanding ban (`.banmember`): nomor/ID tanpa domain & suffix device,
  // LID di-map ke PN pakai cache (sync, nggak nembak network).
  const banKey = (j) => String(lidToPn(j) || '').split('@')[0].split(':')[0];
  client.on('group_participants', async (event) => {
    try {
      const { jid, participants, action } = event;
      if (!jid || !participants?.length) return;
      if (!['add', 'remove', 'request'].includes(action)) return;
      const [settingsRows] = await pool.execute(
        'SELECT welcome_msg, bye_msg, autoacc, welcome_on, bye_on FROM group_settings WHERE bot_id = ? AND group_jid = ? LIMIT 1',
        [botId, jid]
      );
      const settings = settingsRows[0] || {};
      // Saklar per grup (`.on welcome` / `.on left`). Baris belum ada = undefined
      // → dianggap ON, biar grup lama nggak berubah perilakunya.
      const welcomeOn = settings.welcome_on !== 0;
      const byeOn     = settings.bye_on !== 0;
      // ── Autoacc — approve join request ─────────────────────────────────────
      if (settings.autoacc && action === 'request') {
        try {
          await client.group.approveMembershipRequests(jid, participants);
          await logBot(botId, 'info', `Autoacc: ${participants.length} request join disetujui di ${jid}`);
        } catch (e) {
          console.error(`[Bot ${botId}] Autoacc error: ${e.message}`);
        }
        return;
      }

      // 'request' (minta join) bukan masuk/keluar — cuma autoacc yang ngurus.
      // Dulu event ini lolos ke bawah dan kebagian teks *bye*: orang minta
      // gabung grup malah disalami ucapan perpisahan.
      if (action === 'request') return;

      // Perhatian: `??` bukan `||`. Kolom yang di-NULL-kan tetap jatuh ke teks
      // default .env, tapi sekarang itu cuma kalau saklarnya ON — jadi OFF
      // beneran diam, bukan ganti ke teks default.

      let meta = null;
      try { meta = await client.group.queryGroupMetadata(jid); } catch {}
      const groupName = meta?.subject || jid.split('@')[0];
      const groupDesc = meta?.desc || '';

      // ── Ban grup (`.banmember`) ─────────────────────────────────────────────
      // Sekali baca per event, bukan per participant. Set isinya key yang sudah
      // dinormalisasi (PN kalau mapping LID-nya ketemu) supaya ban PN tetap kena
      // walau member masuk lewat LID.
      let banned = null;
      if (action === 'add') {
        try {
          const [rows] = await pool.execute(
            'SELECT jid FROM group_ban WHERE bot_id = ? AND group_jid = ?',
            [botId, jid]
          );
          banned = new Set();
          for (const r of rows) banned.add(banKey(r.jid));
        } catch { /* tabel group_ban belum ada = nggak ada yang di-ban */ }
      }

      for (const participantJid of participants) {
        // Pernah di-`.banmember`: tendang lagi tiap kali dia masuk.
        if (banned?.size && banned.has(banKey(participantJid))) {
          try {
            await client.group.removeParticipants(jid, [participantJid]);
            await logBot(botId, 'info', `Ban grup: ${participantJid} ditolak masuk ${jid}`);
          } catch (e) {
            console.error(`[Bot ${botId}] ban enforce error: ${e.message}`);
          }
          continue;
        }

        const template = action === 'add'
          ? (welcomeOn ? (settings.welcome_msg ?? mess.welcomeDefault) : null)
          : (byeOn ? (settings.bye_msg ?? mess.byeDefault) : null);
        if (!template) continue;

        const { text, mentions } = renderTemplate(template, {
          groupName, groupDesc, target: participantJid,
        });
        await client.message.send(jid, text, { mentions });
      }
    } catch (e) {
      console.error(`[Bot ${botId}] welcome/bye error: ${e.message}`);
    }
  });

  // ── Pairing code mode ─────────────────────────────────────────────────────
  if (usePairingCode && botData.bot_number) {
    const phoneNumber = botData.bot_number.replace(/\D/g, '');

    // Baileys memancarkan QR baru tiap ~20s selama belum di-scan — tiap QR itu
    // momen server siap nerima request. Jadi pairing code diperbarui terus,
    // bukan sekali doang: klien nunggu yg lama, kodenya udah mati di server.
    // 'auth_pairing_required' diemit bareng tiap 'auth_qr', jadi cukup satu listener.
    let pairingBusy = false;
    client.on('auth_pairing_required', async ({ ttlMs } = {}) => {
      if (pairingBusy) return;
      pairingBusy = true;
      try {
        const code = await client.auth.requestPairingCode(phoneNumber);
        const formatted = String(code).match(/.{1,4}/g)?.join('-') || code;
        await logBot(botId, 'info', `Pairing Code: ${formatted}`);
        // ttl ikut umur QR yg barusan diemit (60s utk QR pertama, 20s sisanya)
        broadcast(botId, 'pairing_code', { code: formatted, ttlMs: ttlMs || 20000 });
      } catch (e) {
        await logBot(botId, 'error', `Gagal mendapatkan pairing code: ${e.message}`);
      } finally {
        pairingBusy = false;
      }
    });

    return client.connect().catch(async (e) => {
      await logBot(botId, 'error', `Connect error: ${e.message}`);
    });

  } else {
    // QR mode
    return client.connect().catch(async (e) => {
      await logBot(botId, 'error', `Connect error: ${e.message}`);
    });
  }
}

// ─── Stop bot manual (dipakai clearSession/stop/delete) ─────────────────────
// Set flag stoppingBots DULUAN sebelum disconnect, biar auto-reconnect
// (5 detik di handler connection close) nggak start ulang bot yang lagi
// di-stop — kalau sampai start ulang, session.db ke-lock (EPERM di Windows)
// dan clearSession gagal hapus folder session basi.
async function stopWhatsAppBot(botId) {
  stoppingBots.add(botId);
  botConnectedAt.delete(botId); // bot mati -> umur koneksinya jangan dilaporkan lagi
  const wasRestarting = restartingBots.has(botId);
  // Penanda "close koneksi ini udah dipegang". Guard 'connection close' ngisi ini;
  // stopWhatsAppBot nungguin kalau lagi restart (biar nggak ada dua soket WA).
  let closeWaited = false;
  const closeWait = new Promise(res => stopCloseWaiters.set(botId, () => { closeWaited = true; res(); }));
  const inst = activeBots.get(botId);
  if (inst) {
    try {
      if (typeof inst?.disconnect === 'function') await inst.disconnect();
      else if (typeof inst?.destroy === 'function') await inst.destroy();
      // Tutup handle SQLite — kalau nggak, file session.db tetap ke-lock
      // (EPERM di Windows) dan clearSession gagal hapus folder sesi basi.
      try { inst?.__closeAuth?.(); } catch { /* ignore */ }
    } catch { /* ignore */ }
    // disconnect() nggak dijamin nunggu event 'close'. Tunggu sampai guard
    // beneran nge-hold close-nya, max 3 detik — jangan nyangkut nungguin event
    // yang mungkin nggak pernah dateng (bot udah lepas duluan).
    if (!closeWaited) await Promise.race([closeWait, new Promise(r => setTimeout(r, 3000))]);
    if (activeBots.has(botId)) {
      activeBots.delete(botId);
      await decrementStat('total_bots_online');
    }
  }
  stoppingBots.delete(botId);
  pairingBots.delete(botId); // niat pairing ikut batal pas bot di-stop
  // restartingBots JANGAN dibuang di sini kalau ini bagian dari restart: guard
  // 'close' (baca pointer-nya) yang nentuin log & nyegah auto-reconnect.
  // Dulu dibuang di sini -> restart kebaca "di-stop manual", dan guard-nya nggak
  // pernah kejalan sama sekali (0× di log VPS walau .restart udah dipakai).
  if (!wasRestarting) restartingBots.delete(botId);
}

// ─── Restart satu bot (dipakai command .restart & HTTP /api/bots/:id/restart) ─
// Satu jalur restart. restartWhatsAppBotInBackground() cuma alias tanpa await —
// dulu dia punya logika sendiri (dobel), dan versi dobel itu yang bikin
// restartingBots dihapus sebelum guard sempat baca (lihat catatan di guard).
// JANGAN pakai stopWhatsAppBot() sendirian: dia nge-nol-in is_running di DB
// (niat "stop"), jadi auto-start pas boot server bakal ninggalin bot ini.
// Di sini: tandai restartingBots + is_running=1 DULUAN, baru stop, baru start.
async function restartWhatsAppBot(botId) {
  const [rows] = await pool.execute('SELECT * FROM bots WHERE id = ?', [botId]);
  const botData = rows[0];
  if (!botData) throw new Error('Bot tidak ditemukan');

  // Cuma buat bot yang lagi jalan — yang mati punya tombol start sendiri.
  // (Jangan diubah jadi "diam-diam nyalain": bikin user bingung kenapa bot
  //  nyala sendiri, dan itu keputusan Pak, bukan keputusan engine.)
  if (!activeBots.has(botId)) throw new Error('Bot tidak sedang berjalan');

  // Alasan harus SATU jalur: command WA .restart & tombol restart di web harus
  // punya efek yang sama persis. Dulu dua-duanya punya logika sendiri dan
  // hasilnya beda.
  restartingBots.add(botId);
  try {
    await pool.execute("UPDATE bots SET is_running = 1 WHERE id = ?", [botId]);
    // stopWhatsAppBot() yang nungguin close-nya (lihat wasRestarting di sana) —
    // jadi balik dari sini artinya koneksi lama udah bener-bener lepas, dan
    // nggak ada loop auto-reconnect yang ikut nge-start. Baru start yang baru.
    await stopWhatsAppBot(botId);
    return await startWhatsAppBot(botData, pairingBots.has(botId));
  } catch (e) {
    restartingBots.delete(botId); // gagal -> jangan tinggalin flag nyangkut
    throw e;
  }
}

// Command WA .restart: nggak boleh nunggu handshake (~10 detik) — handler pesan
// jangan ditahan. Cukup jalanin restartWhatsAppBot() tanpa di-await.
// Satu jalur: nggak ada logika restart kembar di sini lagi.
function restartWhatsAppBotInBackground(botId) {
  return restartWhatsAppBot(botId); // caller nggak await -> jalan di background
}

// Kapan bot terakhir nyambung ke WA (ms epoch, 0 kalau belum pernah).
// Dipakai .uptime/.runtime/.info — umur bot, bukan umur proses Node.
function getBotConnectedAt(botId) {
  return botConnectedAt.get(Number(botId)) || 0;
}

module.exports = { startWhatsAppBot, stopWhatsAppBot, restartWhatsAppBot, restartWhatsAppBotInBackground, getBotConnectedAt, setWsBroadcast, getBotGlobalSetting, setBotGlobalSetting };
