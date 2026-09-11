'use strict';

/**
 * plugins/06-proteksi.js
 * Unified .on <fitur> / .off <fitur> command untuk semua fitur grup.
 * Fitur group-level: antispam, antitagsw, autosticker, antisticker,
 *   viewonce, detect, welcome, autolevelup, autoacc, document,
 *   antibot, antilink, antilinkv2, antitoxic, antidelete
 * Fitur global (per-bot): nyimak, autoread — dikelola di whatsappEngine.js
 */

const fs   = require('fs');
const path = require('path');
const { pool } = require('../config/database');
const { getBotGlobalSetting, setBotGlobalSetting } = require('../config/globalSettings');

const SETTINGS_FILE = path.join(__dirname, '..', 'sessions', 'proteksi-settings.json');

// ─── Load/Save ke file ────────────────────────────────────────────────────────
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch { /* fallback */ }
  return {};
}

function saveSettings(data) {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[Proteksi] Gagal simpan settings:', e.message);
  }
}

const allSettings = loadSettings();

// Default semua fitur false
const DEFAULTS = {
  antibot: false, antilink: false, antilinkv2: false, antitoxic: false, antidelete: false,
  antispam: false, antitagsw: false, autosticker: false, antisticker: false,
  viewonce: false, autolevelup: false,
};

function getSetting(groupJid) {
  if (!allSettings[groupJid]) allSettings[groupJid] = { ...DEFAULTS };
  // Migrate: tambahkan key baru kalau belum ada
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (allSettings[groupJid][k] === undefined) allSettings[groupJid][k] = v;
  }
  return allSettings[groupJid];
}

function updateSetting(groupJid, key, value) {
  getSetting(groupJid)[key] = value;
  saveSettings(allSettings);
}

// ─── Export getSetting untuk engine ──────────────────────────────────────────
module.exports.getSetting = getSetting;

// ─── Deteksi helpers ──────────────────────────────────────────────────────────
const LINK_REGEX      = /https?:\/\/[^\s]+|www\.[^\s]+/i;
const WA_INVITE_REGEX = /(chat\.whatsapp\.com\/[a-zA-Z0-9]+|wa\.me\/[^\s]+)/i;
const TOXIC_WORDS     = [
  'anjing','bangsat','kontol','memek','ngentot','bajingan',
  'brengsek','keparat','goblok','babi','tolol','idiot',
  'kampret','asu','jancok','dancok','cok','jancuk',
];

function containsWaLink(text)  { return WA_INVITE_REGEX.test(text); }
function containsAnyLink(text) { return LINK_REGEX.test(text) || WA_INVITE_REGEX.test(text); }
function containsToxic(text)   { return TOXIC_WORDS.some(w => text.toLowerCase().includes(w)); }
/**
 * Deteksi nomor yang kemungkinan bot (WA Web / official business API).
 * WA nomor biasa maksimal 15 digit (termasuk country code, tanpa +).
 * JID LID (@lid) punya 16-17 digit → bukan bot, jangan dihitung.
 */
function looksLikeBot(sender) {
  if (!sender) return false;
  const num = sender.split('@')[0];
  // JID LID / newsletter / channel — bukan bot pribadi
  if (sender.includes('@lid') || sender.includes('@newsletter')) return false;
  // Nomor > 15 digit = indikasi akun non-reguler / bot platform
  return num.length > 15;
}

// ─── Helper: cek admin/owner ──────────────────────────────────────────────────
async function isAdminOrOwner(ctx) {
  const { client, jid, sender, botData } = ctx;
  try {
    const meta = await client.group.queryGroupMetadata(jid).catch(() => null);
    if (meta) {
      const p = meta.participants.find(
        p => p.jid === sender || p.lid === sender ||
             (p.phoneNumber && p.phoneNumber.includes(sender.split('@')[0]))
      );
      if (p?.isAdmin || p?.isSuperAdmin) return true;
    }
    const ownerNum = botData.owner_number?.replace(/\D/g, '');
    if (ownerNum && sender.includes(ownerNum)) return true;
  } catch { /* skip */ }
  return false;
}

// ─── Delete pesan ─────────────────────────────────────────────────────────────
async function deleteMsg(ctx) {
  const { client, jid, msg } = ctx;
  await client.message.send(jid, { type: 'revoke', target: msg.key }).catch(() => {});
}

// ─── Antispam store (in-memory, per grup) ────────────────────────────────────
// key: `${groupJid}:${sender}` → { count, firstTime }
const spamStore = new Map();
const SPAM_THRESHOLD = 5;  // pesan
const SPAM_WINDOW    = 3000; // ms

// ─── Daftar fitur + metadata untuk .on/.off ───────────────────────────────────
// scope: 'group' = per-grup, 'global' = per-bot (dikelola engine)
const FITUR_INFO = {
  // Group scope — disimpan di proteksi-settings.json
  antibot:     { emoji: '🤖', label: 'Antibot',     desc: 'Hapus pesan dari bot WA Web',                  scope: 'group' },
  antilink:    { emoji: '🔗', label: 'Antilink',    desc: 'Hapus link WA grup/saluran dari member biasa', scope: 'group' },
  antilinkv2:  { emoji: '🔗', label: 'Antilinkv2',  desc: 'Hapus semua jenis link dari member biasa',     scope: 'group' },
  antitoxic:   { emoji: '🤬', label: 'Antitoxic',   desc: 'Hapus pesan kata-kata kasar',                  scope: 'group' },
  antidelete:  { emoji: '🗑️', label: 'Antidelete',  desc: 'Kirim ulang pesan yang dihapus',               scope: 'group' },
  antispam:    { emoji: '🚫', label: 'Antispam',    desc: `Kick member spam ${SPAM_THRESHOLD} cmd/${SPAM_WINDOW/1000}s`, scope: 'group' },
  antitagsw:   { emoji: '📢', label: 'Antitagsw',   desc: 'Hapus pesan forward dari status WA',           scope: 'group' },
  autosticker: { emoji: '🎭', label: 'Autosticker',  desc: 'Auto convert gambar/video ke stiker',          scope: 'group' },
  antisticker: { emoji: '🚷', label: 'Antisticker',  desc: 'Hapus stiker dari member biasa',               scope: 'group' },
  viewonce:    { emoji: '👁️', label: 'Viewonce',     desc: 'Kirim ulang media viewonce',                   scope: 'group' },
  autolevelup: { emoji: '⬆️', label: 'Autolevelup',  desc: 'Notifikasi level naik RPG di grup',            scope: 'group' },
  // DB scope — disimpan di group_settings (detect, autoacc, document)
  detect:      { emoji: '🔔', label: 'Detect',      desc: 'Notifikasi perubahan grup (nama, icon, dll)',   scope: 'db' },
  autoacc:     { emoji: '✅', label: 'Autoacc',     desc: 'Auto approve join request grup',               scope: 'db' },
  document:    { emoji: '📄', label: 'Document',    desc: 'Kirim ulang dokumen sebagai file biasa',        scope: 'db' },
  // Global scope — dikelola engine, toggle via .on/.off diteruskan ke engine
  nyimak:      { emoji: '🤫', label: 'Nyimak',      desc: 'Bot diam total, tidak balas command',           scope: 'global' },
  autoread:    { emoji: '👀', label: 'Autoread',    desc: 'Centang biru semua pesan otomatis',            scope: 'global' },
  didyoumean:  { emoji: '💡', label: 'Didyoumean',  desc: 'Saran command saat user typo (.meni → .menu)', scope: 'global' },
};

// ─── Helper: get DB group setting ─────────────────────────────────────────────
async function getDbGroupSetting(botId, groupJid) {
  try {
    const [rows] = await pool.execute(
      'SELECT detect, autoacc, document FROM group_settings WHERE bot_id = ? AND group_jid = ? LIMIT 1',
      [botId, groupJid]
    );
    return rows[0] || { detect: 0, autoacc: 0, document: 0 };
  } catch { return { detect: 0, autoacc: 0, document: 0 }; }
}

async function setDbGroupSetting(botId, groupJid, col, val) {
  await pool.execute(
    `INSERT INTO group_settings (bot_id, group_jid, ${col}) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE ${col} = VALUES(${col})`,
    [botId, groupJid, val ? 1 : 0]
  );
}

// ─── Plugin export ────────────────────────────────────────────────────────────
module.exports = async function proteksiHandler(ctx) {
  const { isGroup, jid, sender, body, isCmd, command, args, reply, client, botData, pushName, msg } = ctx;

  if (!isGroup) return false;

  const p   = botData.prefix ?? '.';
  const cfg = getSetting(jid);

  // ── Auto-listener: fitur yang jalan tiap pesan ───────────────────────────
  const skipCmds = new Set([
    'on','off','antibot','antilink','antilinkv2','antitoxic','antidelete',
    'antispam','antitagsw','autosticker','antisticker','viewonce','autolevelup',
    'detect','welcome','autoacc','document','nyimak','autoread','proteksi','fitur','didyoumean',
  ]);

  if (isGroup && (!isCmd || !skipCmds.has(command))) {

    const msgType = msg?.message ? Object.keys(msg.message)[0] : '';

    // ── Antispam ────────────────────────────────────────────────────────────
    if (cfg.antispam && !await isAdminOrOwner(ctx)) {
      const key  = `${jid}:${sender}`;
      const now  = Date.now();
      const prev = spamStore.get(key) || { count: 0, firstTime: now };
      if (now - prev.firstTime > SPAM_WINDOW) {
        spamStore.set(key, { count: 1, firstTime: now });
      } else {
        prev.count++;
        spamStore.set(key, prev);
        if (prev.count >= SPAM_THRESHOLD) {
          spamStore.delete(key);
          await deleteMsg(ctx);
          await client.message.send(jid, { text: `🚫 *Antispam:* @${sender.split('@')[0]} terdeteksi spam dan telah dikick!`, mentions: [sender] });
          await client.group.removeParticipants(jid, [sender]).catch(() => {});
          return false;
        }
      }
    }

    // ── Antitagsw — hapus pesan forward dari status WA ──────────────────────
    if (cfg.antitagsw) {
      const isForwardFromStatus = msg?.message?.extendedTextMessage?.contextInfo?.remoteJid === 'status@broadcast'
        || msg?.message?.imageMessage?.contextInfo?.remoteJid === 'status@broadcast'
        || msg?.message?.videoMessage?.contextInfo?.remoteJid === 'status@broadcast';
      if (isForwardFromStatus && !await isAdminOrOwner(ctx)) {
        await deleteMsg(ctx);
        await client.message.send(jid, { text: `📢 *Antitagsw:* @${sender.split('@')[0]} dilarang forward status WA ke grup ini!`, mentions: [sender] });
        return false;
      }
    }

    // ── Autosticker — auto convert gambar/video ke stiker ───────────────────
    if (cfg.autosticker && (msgType === 'imageMessage' || msgType === 'videoMessage')) {
      try {
        const { downloadMediaMessage } = require('zapo-js');
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        await client.message.send(jid, {
          type: 'sticker',
          media: buffer,
          mimetype: msgType === 'videoMessage' ? 'video/mp4' : 'image/webp',
        });
      } catch { /* skip jika gagal */ }
      return false;
    }

    // ── Antisticker — hapus stiker dari member biasa ─────────────────────────
    if (cfg.antisticker && msgType === 'stickerMessage' && !await isAdminOrOwner(ctx)) {
      await deleteMsg(ctx);
      await client.message.send(jid, { text: `🚷 *Antisticker:* @${sender.split('@')[0]} tidak boleh mengirim stiker!`, mentions: [sender] });
      return false;
    }

    // ── Viewonce — kirim ulang media viewonce ────────────────────────────────
    if (cfg.viewonce) {
      const voType = msgType === 'imageMessage' ? 'imageMessage'
                   : msgType === 'videoMessage' ? 'videoMessage' : null;
      const voMsg  = voType ? msg?.message?.[voType] : null;
      if (voMsg?.viewOnce) {
        try {
          const { downloadMediaMessage } = require('zapo-js');
          const fixed = { ...msg.message };
          fixed[voType] = { ...voMsg, viewOnce: false };
          const buffer = await downloadMediaMessage({ message: fixed }, 'buffer', {});
          await client.message.send(jid, {
            type: voType === 'videoMessage' ? 'video' : 'image',
            media: buffer,
            mimetype: voMsg.mimetype || (voType === 'videoMessage' ? 'video/mp4' : 'image/jpeg'),
          });
        } catch { /* skip */ }
        return false;
      }
    }

    // ── Document — kirim ulang dokumen sebagai file biasa ───────────────────
    // (DB setting, query async)
    if (msgType === 'documentMessage') {
      try {
        const [rows] = await pool.execute(
          'SELECT document FROM group_settings WHERE bot_id = ? AND group_jid = ? LIMIT 1',
          [botData.id, jid]
        );
        if (rows[0]?.document) {
          const { downloadMediaMessage } = require('zapo-js');
          const buffer  = await downloadMediaMessage(msg, 'buffer', {});
          const docMsg  = msg.message.documentMessage;
          await client.message.send(jid, {
            type: 'document',
            media: buffer,
            mimetype: docMsg.mimetype || 'application/octet-stream',
            fileName: docMsg.fileName || 'file',
          });
        }
      } catch { /* skip */ }
    }

    // ── Antitoxic ────────────────────────────────────────────────────────────
    if (body && cfg.antitoxic && containsToxic(body)) {
      if (await isAdminOrOwner(ctx)) {
        await client.message.send(jid, `😂 *${pushName}* mah gapapa, chill aja bro~ 🙏`);
      } else {
        await deleteMsg(ctx);
        await client.message.send(jid, { text: `🤬 *Antitoxic aktif!*\n@${sender.split('@')[0]} pesan kamu mengandung kata-kata tidak sopan dan telah dihapus.`, mentions: [sender] });
      }
      return false;
    }

    // ── Antilink (hanya link WA) ─────────────────────────────────────────────
    if (body && cfg.antilink && containsWaLink(body)) {
      if (await isAdminOrOwner(ctx)) {
        await client.message.send(jid, `🔗 Antilink aktif, tapi kamu admin/owner — aman!`);
        return false;
      }
      try {
        const ownCode = await client.group.queryInviteCode(jid).catch(() => null);
        if (ownCode && body.toLowerCase().includes(ownCode.toLowerCase())) {
          await client.message.send(jid, `✅ Itu link grup ini sendiri — aman!`);
          return false;
        }
      } catch { /* skip */ }
      await deleteMsg(ctx);
      await client.message.send(jid, { text: `🔗 *Antilink aktif!*\n@${sender.split('@')[0]} link WA dihapus.`, mentions: [sender] });
      return false;
    }

    // ── Antilinkv2 (semua link) ──────────────────────────────────────────────
    if (body && cfg.antilinkv2 && containsAnyLink(body)) {
      if (await isAdminOrOwner(ctx)) {
        await client.message.send(jid, `🔗 Antilinkv2 aktif, tapi kamu admin/owner — aman!`);
        return false;
      }
      if (containsWaLink(body)) {
        try {
          const ownCode = await client.group.queryInviteCode(jid).catch(() => null);
          if (ownCode && body.toLowerCase().includes(ownCode.toLowerCase())) {
            await client.message.send(jid, `✅ Itu link grup ini sendiri — aman!`);
            return false;
          }
        } catch { /* skip */ }
      }
      await deleteMsg(ctx);
      await client.message.send(jid, { text: `🔗 *Antilinkv2 aktif!*\n@${sender.split('@')[0]} link dihapus.`, mentions: [sender] });
      return false;
    }

    // ── Antibot ──────────────────────────────────────────────────────────────
    if (cfg.antibot && looksLikeBot(sender)) {
      await deleteMsg(ctx);
      await client.message.send(jid, `🤖 *Antibot aktif!* Pesan bot dihapus.`);
      return false;
    }

    return false;
  }

  // ── Commands ─────────────────────────────────────────────────────────────
  if (!isCmd) return false;

  // ── .on <fitur> / .off <fitur> — unified toggle ──────────────────────────
  if (command === 'on' || command === 'off') {
    const enable  = command === 'on';
    const fitur   = args[0]?.toLowerCase();
    const p       = botData.prefix ?? '.';

    // Tanpa argumen → tampilkan status semua fitur
    if (!fitur) {
      const dbCfg = await getDbGroupSetting(botData.id, jid);
      // Global state dari engine
      const nyimak   = getBotGlobalSetting(botData.id, 'nyimak');
      const autoread = getBotGlobalSetting(botData.id, 'autoread');

      const st = (v) => v ? '✅' : '❌';
      await reply(
        `⚙️ *Status Fitur — ${jid.split('@')[0]}*\n\n` +
        `*── Proteksi ──*\n` +
        `🤖 antibot     : ${st(cfg.antibot)}\n` +
        `🔗 antilink    : ${st(cfg.antilink)}\n` +
        `🔗 antilinkv2  : ${st(cfg.antilinkv2)}\n` +
        `🤬 antitoxic   : ${st(cfg.antitoxic)}\n` +
        `🗑️ antidelete  : ${st(cfg.antidelete)}\n` +
        `🚫 antispam    : ${st(cfg.antispam)}\n` +
        `📢 antitagsw   : ${st(cfg.antitagsw)}\n` +
        `🚷 antisticker : ${st(cfg.antisticker)}\n\n` +
        `*── Otomatis ──*\n` +
        `🎭 autosticker : ${st(cfg.autosticker)}\n` +
        `👁️ viewonce    : ${st(cfg.viewonce)}\n` +
        `⬆️ autolevelup : ${st(cfg.autolevelup)}\n` +
        `🔔 detect      : ${st(dbCfg.detect)}\n` +
        `✅ autoacc     : ${st(dbCfg.autoacc)}\n` +
        `📄 document    : ${st(dbCfg.document)}\n\n` +
        `*── Global (bot) ──*\n` +
        `🤫 nyimak      : ${st(nyimak)}\n` +
        `👀 autoread    : ${st(autoread)}\n` +
        `💡 didyoumean  : ${st(getBotGlobalSetting(botData.id, 'didyoumean'))}\n\n` +
        `_Ketik \`${p}on <fitur>\` atau \`${p}off <fitur>\` untuk toggle._`
      );
      return true;
    }

    // Validasi fitur
    if (!FITUR_INFO[fitur]) {
      const list = Object.keys(FITUR_INFO).join(', ');
      await reply(`❌ Fitur *${fitur}* tidak dikenal.\n\nFitur tersedia:\n${list}`);
      return true;
    }

    const info  = FITUR_INFO[fitur];
    const emoji = info.emoji;
    const label = info.label;

    // Cek permission: fitur global hanya owner bot
    if (info.scope === 'global') {
      const ownerNum  = botData.owner_number?.replace(/\D/g, '');
      const senderNum = sender.split('@')[0].split(':')[0];
      if (senderNum !== ownerNum) {
        await reply(`❌ Fitur *${label}* hanya bisa diubah oleh *owner bot*.`);
        return true;
      }
      // Teruskan ke globalSettings
      const current = getBotGlobalSetting(botData.id, fitur);
      if (enable && current) {
        await reply(`${emoji} *${label}* sudah *aktif* sejak tadi. Gunakan \`${p}off ${fitur}\` untuk mematikan.`);
        return true;
      }
      if (!enable && !current) {
        await reply(`${emoji} *${label}* sudah *mati* sejak tadi. Gunakan \`${p}on ${fitur}\` untuk mengaktifkan.`);
        return true;
      }
      setBotGlobalSetting(botData.id, fitur, enable);
      await reply(`${emoji} *${label}* ${enable ? '✅ Diaktifkan' : '❌ Dinonaktifkan'}\n_${info.desc}_`);
      return true;
    }

    // Cek permission: fitur group hanya admin/owner
    if (!ctx.isAdmin && !ctx.isOwner) {
      await reply(`❌ Hanya admin atau owner yang bisa mengubah fitur ini.`);
      return true;
    }

    // DB scope (detect, autoacc, document, welcome)
    if (info.scope === 'db') {
      await setDbGroupSetting(botData.id, jid, fitur, enable);
      await reply(`${emoji} *${label}* ${enable ? '✅ Diaktifkan' : '❌ Dinonaktifkan'}\n_${info.desc}_`);
      return true;
    }

    // Group scope (proteksi-settings.json)
    updateSetting(jid, fitur, enable);
    await reply(`${emoji} *${label}* ${enable ? '✅ Diaktifkan' : '❌ Dinonaktifkan'}\n_${info.desc}_`);
    return true;
  }

  switch (command) {

    // ── .proteksi — status ringkas ────────────────────────────────────────────
    case 'proteksi': {
      const st = (v) => v ? '✅' : '❌';
      const dym = getBotGlobalSetting(ctx.botData.id, 'didyoumean');
      await reply(
        `🛡️ *Status Proteksi*\n\n` +
        `${st(cfg.antibot)} antibot   ${st(cfg.antilink)} antilink\n` +
        `${st(cfg.antilinkv2)} antilinkv2  ${st(cfg.antitoxic)} antitoxic\n` +
        `${st(cfg.antidelete)} antidelete  ${st(cfg.antispam)} antispam\n` +
        `${st(cfg.antitagsw)} antitagsw  ${st(cfg.antisticker)} antisticker\n` +
        `${st(dym)} didyoumean\n\n` +
        `_Ketik \`${p}on\` untuk lihat semua fitur._`
      );
      return true;
    }

    // ── .fitur — alias .on tanpa argumen ─────────────────────────────────────
    case 'fitur': {
      // Delegate ke .on tanpa argumen
      const fakeCtx = { ...ctx, command: 'on', args: [] };
      return module.exports(fakeCtx);
    }

    // ── legacy individual toggle — tetap support untuk backward compat ────────
    case 'antibot':
    case 'antilink':
    case 'antilinkv2':
    case 'antitoxic':
    case 'antidelete':
    case 'antispam':
    case 'antitagsw':
    case 'autosticker':
    case 'antisticker':
    case 'viewonce':
    case 'autolevelup': {
      if (!ctx.isAdmin && !ctx.isOwner) {
        await reply(`❌ Hanya admin atau owner yang bisa mengubah fitur ini.`);
        return true;
      }
      const action = args[0]?.toLowerCase();
      const info   = FITUR_INFO[command];
      if (action === 'on' || action === 'off') {
        const enable = action === 'on';
        updateSetting(jid, command, enable);
        await reply(`${info.emoji} *${info.label}* ${enable ? '✅ Diaktifkan' : '❌ Dinonaktifkan'}\n_${info.desc}_`);
      } else {
        await reply(
          `${info.emoji} *${info.label}* — ${cfg[command] ? '✅ Aktif' : '❌ Nonaktif'}\n\n` +
          `${info.desc}\n\n` +
          `\`${p}on ${command}\` — aktifkan\n\`${p}off ${command}\` — nonaktifkan`
        );
      }
      return true;
    }

    default:
      return false;
  }
};

// Toggle proteksi — tidak kena limit (admin/owner yang pakai)
module.exports.limitedCmds = new Set([]);
