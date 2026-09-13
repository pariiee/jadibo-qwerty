'use strict';

/**
 * engine/whatsappEngine.js
 * Multi-session WhatsApp engine menggunakan zapo-js API yang benar.
 * Setiap bot mendapat WaClient instance tersendiri dengan SQLite store terpisah.
 */

const path = require('path');
const fs   = require('fs');
require('dotenv').config();

const { pool, incrementStat, decrementStat } = require('../config/database');
const { activeBots, activeGroupsPerBot, activeChannelsPerBot } = require('../controllers/botController');
const { isPendingSewa } = require('./pendingSewa');

// Track grup yang sudah dikirimi pesan "tidak terdaftar" agar tidak spam
// Key: `${botId}:${groupJid}` — hapus otomatis setelah 10 menit
const notifiedUnregistered = new Map();

// Bot yang sedang di-stop / clear-session — auto-reconnect harus skip
const stoppingBots = new Set();

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

// ─── Lazy-load zapo-js ────────────────────────────────────────────────────────
let WaClient, createStore;
try {
  ({ WaClient, createStore } = require('zapo-js'));
} catch {
  console.warn('[Engine] zapo-js tidak terinstall — WhatsApp engine disabled');
}

// Logger no-op — supaya log internal zapo-js tidak flood console server
const noopLogger = {
  level: 'silent',
  trace: () => {}, debug: () => {}, info: () => {},
  warn:  () => {}, error: () => {}, fatal: () => {},
  child: () => noopLogger,
};

let createSqliteStore;
try {
  ({ createSqliteStore } = require('@zapo-js/store-sqlite'));
} catch {
  console.warn('[Engine] @zapo-js/store-sqlite tidak terinstall');
}

const SESSIONS_DIR = path.resolve(process.env.SESSIONS_DIR || './sessions');

// Global per-bot settings (nyimak, autoread) — dikelola di config/globalSettings.js
const { getBotGlobalSetting, setBotGlobalSetting } = require('../config/globalSettings');

// ─── Owner & Developer greeting cooldown store ───────────────────────────────
// key: `${botId}:${groupJid}` → timestamp last greeting
const ownerGreetCooldown = new Map();
const devGreetCooldown   = new Map(); // key: groupJid → timestamp
// Logika LID↔PN dipusatkan di engine/jid.js supaya cache-nya SATU (dulu tiap
// file punya Map sendiri → user bisa tampil beda jid di log yang beda).
const { cacheLidFromMeta, lidToPn: resolveLid, lidToPnAsync: resolveLidAsync } = require('./jid');

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

// ─── Build zapo-js store ──────────────────────────────────────────────────────
function buildStore(dbPath) {
  return createStore({
    backends: {
      sqlite: createSqliteStore({ path: dbPath }),
    },
    providers: {
      auth:         'sqlite',
      signal:       'sqlite',
      preKey:       'sqlite',
      session:      'sqlite',
      identity:     'sqlite',
      senderKey:    'sqlite',
      appState:     'sqlite',
      privacyToken: 'sqlite',
      messages:     'sqlite',
      threads:      'none',
      contacts:     'sqlite',
    },
  });
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
    // zapo-js client instance (replaces sock)
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
      } catch {
        return client.message.send(jid, full);
      }
    },
    // Helper: react with emoji
    react: (emoji) =>
      client.message.send(jid, {
        type: 'reaction',
        emoji,
        target: key,
      }).catch(() => {}),
  };
}

// ─── Main start function ──────────────────────────────────────────────────────
async function startWhatsAppBot(botData, usePairingCode = false) {
  if (!WaClient) throw new Error('zapo-js tidak terinstall');
  if (!createSqliteStore) throw new Error('@zapo-js/store-sqlite tidak terinstall');

  const botId  = botData.id;
  const botDir = path.join(SESSIONS_DIR, `bot_${botId}`);
  fs.mkdirSync(botDir, { recursive: true });

  const dbPath = path.join(botDir, 'session.db');

  await logBot(botId, 'info', `Memulai bot "${botData.bot_name}"...`);
  await pool.execute("UPDATE bots SET status = 'connecting' WHERE id = ?", [botId]);
  broadcast(botId, 'status', { status: 'connecting' });

  const store  = buildStore(dbPath);
  const logger = noopLogger;

  const client = new WaClient(
    { store, sessionId: `bot_${botId}` },
    logger
  );

  // Simpan ke activeBots
  activeBots.set(botId, client);

  // Cache nama grup supaya tidak fetch ulang setiap pesan
  const groupNameCache = new Map();
  // Cache daftar grup aktif untuk broadcast — load dari file dulu
  if (!activeGroupsPerBot.has(botId)) activeGroupsPerBot.set(botId, new Map());
  loadGroupsCache(botId);

  const plugins = loadPlugins();

  // ── auth_qr ───────────────────────────────────────────────────────────────
  client.on('auth_qr', async ({ qr, ttlMs }) => {
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
      console.log(`[Bot ${botId}] ✅ Terhubung ke WhatsApp`);
      await logBot(botId, 'info', 'Bot terhubung ke WhatsApp');
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
      await pool.execute("UPDATE bots SET status = 'disconnected', is_running = 0 WHERE id = ?", [botId]);
      broadcast(botId, 'status', { status: 'disconnected', reason });

      if (activeBots.has(botId)) {
        activeBots.delete(botId);
        await decrementStat('total_bots_online');
      }

      if (stoppingBots.has(botId)) {
        console.log(`[Bot ${botId}] 🛑 Di-stop manual — tidak reconnect`);
        stoppingBots.delete(botId);
        return;
      }

      if (isLogout) {
        console.log(`[Bot ${botId}] 🚪 Logout — hapus sesi untuk scan ulang`);
        await logBot(botId, 'warn', 'Sesi logout. Hapus sesi untuk scan ulang.');
      } else {
        console.log(`[Bot ${botId}] 🔄 Reconnect dalam 5 detik...`);
        await logBot(botId, 'info', 'Reconnect dalam 5 detik...');
        setTimeout(async () => {
          try {
            const [rows] = await pool.execute('SELECT * FROM bots WHERE id = ?', [botId]);
            const freshBotData = rows[0] || botData;
            await startWhatsAppBot(freshBotData, false);
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
        const { proto } = require('zapo-js');
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
        if (groupNameCache.has(jid)) {
          chatName = groupNameCache.get(jid);
          activeGroupsPerBot.get(botId)?.set(jid, chatName);
        } else {
          const meta = await client.group.queryGroupMetadata(jid);
          if (meta?.subject) {
            chatName = meta.subject;
            groupNameCache.set(jid, meta.subject);
            activeGroupsPerBot.get(botId)?.set(jid, meta.subject);
            saveGroupsCache(botId); // persist setiap kali ada grup baru
          }
          // Populate LID → phone cache dari participant list
          if (meta?.participants) cacheLidFromMeta(meta.participants);
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
      const senderNum = ctx.sender.split('@')[0].split(':')[0];
      if (ownerNum && senderNum === ownerNum) ctx.isOwner = true;
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
    if (ctx.isGroup && process.env.DEVELOPER_NUMBER) {
      try {
        const devNum    = process.env.DEVELOPER_NUMBER.replace(/\D/g, '');
        const senderNum = ctx.sender.split('@')[0].split(':')[0];
        if (senderNum === devNum) {
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
    if (ctx.isCmd && !ctx.isOwner && !ctx.isPremium && PLUGIN_LIMITED_CMDS.has(ctx.command)) {
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
        cmdHandled = true;
        break;
      }
    }

    // Log warna sesuai hasil
    console.log(`[Bot ${botId}] ${logLine}`);
    if (ctx.isCmd) {
      if (!cmdHandled) console.log(`[Bot ${botId}] ❓ Command tidak dikenal: ${logLine}`);
      await logBot(botId, cmdHandled ? 'cmd' : 'cmderr', logLineDisplay);
    } else {
      await logBot(botId, 'info', logLineDisplay);
    }
  });

  // ── Welcome / Bye hook ────────────────────────────────────────────────────
  // zapo-js emits 'group_participants' when members join/leave
  client.on('group_participants', async (event) => {
    try {
      const { jid, participants, action } = event;
      if (!jid || !participants?.length) return;
      if (!['add', 'remove', 'request'].includes(action)) return;

      const [settingsRows] = await pool.execute(
        'SELECT welcome_msg, bye_msg, autoacc FROM group_settings WHERE bot_id = ? AND group_jid = ? LIMIT 1',
        [botId, jid]
      );
      const settings = settingsRows[0];

      // ── Autoacc — approve join request ─────────────────────────────────────
      if (settings?.autoacc && action === 'request') {
        try {
          await client.group.approveMembershipRequests(jid, participants);
          await logBot(botId, 'info', `Autoacc: ${participants.length} request join disetujui di ${jid}`);
        } catch (e) {
          console.error(`[Bot ${botId}] Autoacc error: ${e.message}`);
        }
        return;
      }

      if (!settings) return;

      let meta = null;
      try { meta = await client.group.queryGroupMetadata(jid); } catch {}
      const groupName = meta?.subject || jid.split('@')[0];
      const groupDesc = meta?.desc || '';

      for (const participantJid of participants) {
        const mention = participantJid.split('@')[0];

        if (action === 'add' && settings.welcome_msg) {
          const teks = settings.welcome_msg
            .replace(/@user/g, `@${mention}`)
            .replace(/@subject/g, groupName)
            .replace(/@desc/g, groupDesc);
          await client.message.send(jid, teks, {
            mentions: [participantJid],
          });
        }

        if (action === 'remove' && settings.bye_msg) {
          const teks = settings.bye_msg
            .replace(/@user/g, `@${mention}`)
            .replace(/@subject/g, groupName);
          await client.message.send(jid, teks, {
            mentions: [participantJid],
          });
        }
      }
    } catch (e) {
      console.error(`[Bot ${botId}] welcome/bye error: ${e.message}`);
    }
  });

  // ── Pairing code mode ─────────────────────────────────────────────────────
  if (usePairingCode && botData.bot_number) {
    const phoneNumber = botData.bot_number.replace(/\D/g, '');

    // Docs zapo-js: "wait for auth_pairing_required OR any QR" — keduanya
    // menandakan server sudah siap menerima pairing code request
    const serverReadyPromise = new Promise((resolve) => {
      client.once('auth_qr', resolve);
      client.once('auth_pairing_required', resolve);
    });

    // Pasang listener SEBELUM connect()
    const connectPromise = client.connect();

    // Tunggu server siap
    serverReadyPromise.then(async () => {
      try {
        await logBot(botId, 'info', 'Server siap, meminta pairing code...');
        const code = await client.auth.requestPairingCode(phoneNumber);
        const formatted = String(code).match(/.{1,4}/g)?.join('-') || code;
        await logBot(botId, 'info', `Pairing Code: ${formatted}`);
        broadcast(botId, 'pairing_code', { code: formatted });
      } catch (e) {
        await logBot(botId, 'error', `Gagal mendapatkan pairing code: ${e.message}`);
      }
    });

    return connectPromise.catch(async (e) => {
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
  const inst = activeBots.get(botId);
  if (inst) {
    try {
      if (typeof inst?.disconnect === 'function') await inst.disconnect();
      else if (typeof inst?.destroy === 'function') await inst.destroy();
    } catch { /* ignore */ }
    // disconnect() kadang resolve sebelum event 'close' kebawa — kasih
    // waktu event loop buat proses close + bersihin file handle SQLite
    await new Promise(r => setTimeout(r, 1500));
    if (activeBots.has(botId)) {
      activeBots.delete(botId);
      await decrementStat('total_bots_online');
    }
  }
  stoppingBots.delete(botId);
}

module.exports = { startWhatsAppBot, stopWhatsAppBot, setWsBroadcast, getBotGlobalSetting, setBotGlobalSetting };
