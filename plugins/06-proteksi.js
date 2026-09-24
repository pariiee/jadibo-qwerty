'use strict';

/**
 * plugins/06-proteksi.js
 * Unified .on <fitur> / .off <fitur> command untuk semua fitur grup.
 * Fitur group-level: antispam, antitagsw, autosticker, antisticker,
 *   viewonce, detect, welcome, autoacc, document,
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
  viewonce: false,
};
// Catatan: autolevelup SENGAJA nggak ada di sini — di kode ini dia nggak dipakai
// sama sekali, dan di kode ini kunci yang ada cuma yang di-ON-kan, jadi absen =
// ON. Dipaksa ON di rung 1 supaya maksud "fitur wajib" kebaca walau key-nya
// masih nyangkut di proteksi-settings.json grup lama.
const WAJIB_ON = { autolevelup: true };

function getSetting(groupJid) {
  if (!allSettings[groupJid]) allSettings[groupJid] = { ...DEFAULTS, ...WAJIB_ON };
  // Migrate: tambahkan key baru kalau belum ada
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (allSettings[groupJid][k] === undefined) allSettings[groupJid][k] = v;
  }
  // Fitur wajib nggak bisa dimatikan — paksa ON terus, walau file setting masih
  // nyimpen `false` dari grup yang dulu pernah di-off.
  Object.assign(allSettings[groupJid], WAJIB_ON);
  return allSettings[groupJid];
}

function updateSetting(groupJid, key, value) {
  getSetting(groupJid)[key] = value;
  saveSettings(allSettings);
}

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

// ─── Fakemsg (.on fakemsg) ────────────────────────────────────────────────────
// Config-nya SENGAJA nempel di sini, bukan di config/mess.js — cuma fitur ini
// yang pakai, jadi nggak ada gunanya diangkat ke file config.
// Cara kerja: owner react pesan orang pakai emoji di bawah → bubble pesan itu
// DIEDIT jadi teks promosi (trik temp-message: kirim bubble kosong dulu, baru
// edit pakai id pesan target), lalu bubble kosong + reaksi + stanza-nya dibersihin.
const fakemsgEmoji = '😁';
const fakemsgPesan =
`Mau jadi bot? Langsung aja ke https://yapari.web.id 🔥

Jadibot & akses API dalam satu tempat!

Satu API untuk AI, downloader, maker, search, dan berbagai kebutuhan developer lainnya.

🌐 Website: yapari.web.id
🧪 Labs: labs.yapari.id`;

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
  viewonce:    { emoji: '👁️', label: 'Viewonce',     desc: 'Kirim ulang media sekali lihat biar bisa dibuka lagi', scope: 'group' },
  // autolevelup nggak ada di sini — fitur wajib, nggak bisa di-off. Lihat WAJIB_ON.
  // DB scope — disimpan di group_settings (detect, autoacc, document)
  detect:      { emoji: '🔔', label: 'Detect',      desc: 'Notifikasi perubahan grup (nama, icon, dll)',   scope: 'db' },
  autoacc:     { emoji: '✅', label: 'Autoacc',     desc: 'Auto approve join request grup',               scope: 'db' },
  document:    { emoji: '📄', label: 'Document',    desc: 'Kirim ulang dokumen sebagai file biasa',        scope: 'db' },
  // welcome/bye: saklar disimpan di kolom sendiri (welcome_on/bye_on), teksnya
  // nggak kesentuh — jadi off/on bolak-balik nggak ngehapus teks custom.
  welcome:     { emoji: '👋', label: 'Welcome',     desc: 'Sambutan otomatis saat member masuk grup',      scope: 'db', col: 'welcome_on' },
  left:        { emoji: '🚪', label: 'Left',        desc: 'Ucapan otomatis saat member keluar grup',       scope: 'db', col: 'bye_on' },
  bye:         { emoji: '🚪', label: 'Left',        desc: 'Ucapan otomatis saat member keluar grup',       scope: 'db', col: 'bye_on' },
  // Global scope — dikelola engine, toggle via .on/.off diteruskan ke engine
  nyimak:      { emoji: '🤫', label: 'Nyimak',      desc: 'Bot diam total, tidak balas command',           scope: 'global' },
  autoread:    { emoji: '👀', label: 'Autoread',    desc: 'Centang biru semua pesan otomatis',            scope: 'global' },
  didyoumean:  { emoji: '💡', label: 'Didyoumean',  desc: 'Saran command saat user typo (.meni → .menu)', scope: 'global' },
  fakemsg:     { emoji: '😁', label: 'Fakemsg',     desc: 'Owner react pesan pakai 😁 → pesan itu berubah jadi promosi', scope: 'global' },
  // Fitur wajib ON — cuma buat kenal nama & kasih pesan yang ngerti, TIDAK
  // ditawarkan di daftar toggle dan TIDAK punya saklar (lihat WAJIB_ON).
  autolevelup: { emoji: '⬆️', label: 'Autolevelup', desc: 'Fitur wajib — selalu aktif, nggak bisa di-off',  scope: 'wajib' },
};

// ─── Helper: get DB group setting ─────────────────────────────────────────────
async function getDbGroupSetting(botId, groupJid) {
  const kosong = { detect: 0, autoacc: 0, document: 0, welcome_on: 1, bye_on: 1 };
  try {
    const [rows] = await pool.execute(
      'SELECT detect, autoacc, document, welcome_on, bye_on FROM group_settings WHERE bot_id = ? AND group_jid = ? LIMIT 1',
      [botId, groupJid]
    );
    return rows[0] || kosong;
  } catch { return kosong; }
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

  // ── Fakemsg — owner react pakai emoji fakemsg → pesan itu jadi promosi ─────
  const reaksiFake = msg?.message?.reactionMessage;
  if (ctx.isOwner && reaksiFake?.text === fakemsgEmoji
      && getBotGlobalSetting(botData.id, 'fakemsg')) {
    const target = reaksiFake.key;
    try {
      const temp = await client.message.send(jid, { text: '', contextInfo: { isGroupStatus: true } }, { quoted: msg });
      await client.message.send(jid, { text: fakemsgPesan, edit: { id: temp.key.id } }, { messageId: target.id });
      await Promise.allSettled([
        client.message.send(jid, { delete: { remoteJid: jid, id: temp.key.id, fromMe: true } }),
        client.message.send(jid, { delete: { ...target, remoteJid: jid } }),
        client.message.send(jid, { delete: { ...msg.key, remoteJid: jid } }),
      ]);
    } catch (e) {
      console.error('[fakemsg]', e?.message || e);
      await reply('❌ Fakemsg gagal, coba lagi ya.').catch(() => {});
    }
    return true;
  }

  if (!isGroup) return false;

  const p   = botData.prefix ?? '.';
  const cfg = getSetting(jid);

  // ── Auto-listener: fitur yang jalan tiap pesan ───────────────────────────
  const skipCmds = new Set([
    'on','off','antibot','antilink','antilinkv2','antitoxic','antidelete',
    'antispam','antitagsw','autosticker','antisticker','viewonce',
    'detect','welcome','left','bye','autoacc','document','nyimak','autoread','proteksi','didyoumean',
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
        // Adapter: client.message.downloadBytes(msg) -> Buffer langsung
        const buffer = await client.message.downloadBytes(msg);
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
          // Adapter: source boleh { message } -> Buffer langsung
          const fixed = { ...msg.message };
          fixed[voType] = { ...voMsg, viewOnce: false };
          const buffer = await client.message.downloadBytes({ message: fixed });
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
          const buffer  = await client.message.downloadBytes(msg);
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
      await reply(
        `⚙️ *Status Fitur — ${jid.split('@')[0]}*\n\n` +
        await proteksi.statusFitur(botData.id, jid) +
        `\n_Ketik \`${p}on <fitur>\` atau \`${p}off <fitur>\` untuk toggle._`
      );
      return true;
    }

    // Validasi fitur
    if (!FITUR_INFO[fitur]) {
      // Fitur wajib nggak ditawarin di daftar — dia emang nggak bisa di-toggle.
      const list = Object.keys(FITUR_INFO).filter(k => FITUR_INFO[k].scope !== 'wajib').join(', ');
      await reply(`❌ Fitur *${fitur}* tidak dikenal.\n\nFitur tersedia:\n${list}`);
      return true;
    }

    const info  = FITUR_INFO[fitur];
    const emoji = info.emoji;
    const label = info.label;

    // Fitur wajib — nggak punya saklar. Dikasih tau, bukan dijualin.
    if (info.scope === 'wajib') {
      await reply(`${emoji} *${label}* itu fitur *wajib* — selalu aktif dan nggak bisa di-off.`);
      return true;
    }

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

    // DB scope (detect, autoacc, document, welcome, left)
    if (info.scope === 'db') {
      const dbNow = await getDbGroupSetting(botData.id, jid);
      const current = dbNow[info.col || fitur];
      if (enable && current) {
        await reply(`${emoji} *${label}* sudah *aktif* sejak tadi. Gunakan \`${p}off ${fitur}\` untuk mematikan.`);
        return true;
      }
      if (!enable && !current) {
        await reply(`${emoji} *${label}* sudah *mati* sejak tadi. Gunakan \`${p}on ${fitur}\` untuk mengaktifkan.`);
        return true;
      }
      await setDbGroupSetting(botData.id, jid, info.col || fitur, enable);
      // Saklar OFF di atas teks: teks custom-nya tetap tersimpan, cuma didiemin.
      const jejak = (fitur === 'welcome' || fitur === 'left')
        ? (enable ? '\n_Sambutan pakai teks yang tersimpan (kalau belum pernah diatur: teks default)._'
                  : '\n_Teks custom tetap tersimpan — tinggal `.on` lagi kalau mau dipakai._')
        : '';
      await reply(`${emoji} *${label}* ${enable ? '✅ Diaktifkan' : '❌ Dinonaktifkan'}\n_${info.desc}_${jejak}`);
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
    case 'viewonce': {
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

// Diekspor SETELAH `module.exports = handler` — kalau ditaruh di atas, dua baris
// ini kehapus dan yang baca `.getSetting` / `.FITUR_INFO` dapet undefined.
module.exports.getSetting = getSetting;   // dibaca engine & tes
module.exports.fakemsgEmoji = fakemsgEmoji; // gate reaksi di engine
module.exports.FITUR_INFO = FITUR_INFO;   // daftar fitur + desc buat `.on`/`.off`

// Blok status semua fitur — dipakai `.on` polos DAN `.groupinfo`, biar dua
// tempat itu nggak bisa beda isi.
module.exports.statusFitur = async function statusFitur(botId, jid) {
  const dbCfg    = await getDbGroupSetting(botId, jid);
  const cfg      = getSetting(jid);
  const nyimak   = getBotGlobalSetting(botId, 'nyimak');
  const autoread = getBotGlobalSetting(botId, 'autoread');
  const st    = (v) => v ? '✅' : '❌';
  const baris = (k, on) => {
    const i = FITUR_INFO[k];
    return `${i.emoji} ${i.label.padEnd(11)}: ${st(on)} — ${i.desc}\n`;
  };
  return (
    `*── Teks ──*\n` +
    `👋 Welcome   : ${dbCfg.welcome_msg ? `"${dbCfg.welcome_msg}"` : '_belum diatur_'}\n` +
    `🚪 Leave     : ${dbCfg.bye_msg ? `"${dbCfg.bye_msg}"` : '_belum diatur_'}\n` +
    `\n*── Proteksi ──*\n` +
    baris('antibot',     cfg.antibot) +
    baris('antilink',    cfg.antilink) +
    baris('antilinkv2',  cfg.antilinkv2) +
    baris('antitoxic',   cfg.antitoxic) +
    baris('antidelete',  cfg.antidelete) +
    baris('antispam',    cfg.antispam) +
    baris('antitagsw',   cfg.antitagsw) +
    baris('antisticker', cfg.antisticker) +
    `\n*── Otomatis ──*\n` +
    baris('autosticker', cfg.autosticker) +
    baris('viewonce',    cfg.viewonce) +
    baris('detect',      dbCfg.detect) +
    baris('autoacc',     dbCfg.autoacc) +
    baris('document',    dbCfg.document) +
    baris('welcome',     dbCfg.welcome_on) +
    baris('left',        dbCfg.bye_on) +
    `\n*── Global (bot) ──*\n` +
    baris('nyimak',      nyimak) +
    baris('autoread',    autoread) +
    baris('didyoumean',  getBotGlobalSetting(botId, 'didyoumean')) +
    baris('fakemsg',     getBotGlobalSetting(botId, 'fakemsg'))
  );
};

// Baris teks + status fitur buat `.groupinfo` (dipakai bareng blok di atas).
// Status grup: utama / sewa / biasa — sumbernya sama kayak `.listgroup`
// (botData.main_groups + tabel bot_sewa), biar nggak bisa beda jawaban.
module.exports.statusGrup = async function statusGrup(botId, jid, mainGroupsRaw) {
  const mainGroups = new Set(
    String(mainGroupsRaw || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean)
  );
  if (mainGroups.has(jid)) return '🏠 utama';
  try {
    const [rows] = await pool.execute(
      'SELECT expired_at FROM bot_sewa WHERE bot_id = ? AND group_jid = ? LIMIT 1',
      [botId, jid]
    );
    const exp = rows[0]?.expired_at;
    if (exp != null) {
      const sisa = Number(exp) - Date.now();
      if (sisa <= 0) return '⛔ sewa expired';
      const d = Math.floor(sisa / 86400000);
      const h = Math.floor((sisa % 86400000) / 3600000);
      return `💰 sewa (sisa ${d > 0 ? d + 'h ' : ''}${h}j)`;
    }
  } catch { /* bot_sewa nggak ada / DB error → anggap biasa */ }
  return '👥 biasa';
};
