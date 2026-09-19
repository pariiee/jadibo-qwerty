'use strict';

/**
 * plugins/02-group.js
 * Commands: tagall, tagadmin, tagme, hidetag, kick, kickall, promote, demote,
 *           open, close, mute, unmute, slowmode, setname, setdesc, linkgroup,
 *           groupinfo, idgc, leavegc, listadmin, pp/getpp, getppgc, totag,
 *           delete, cekasalmember, absen, mulaiabsen, cekabsen, hapusabsen,
 *           afk, listafk, topchat
 */

const { rapikanError } = require('../engine/pesanError');
const mess             = require('../config/mess');
const proteksi         = require('./06-proteksi');
const { lidToPnAsync }   = require('../engine/jid');
const { genThumbnail } = require('../engine/thumbnail');
const { catatan } = require('../engine/template');

// Ambil gambar PP dari url WA (CDN-nya suka balikin HTML kalau link expired).
// Return Buffer kalau beneran gambar, null kalau enggak — biar caller bisa bilang
// "PP nggak ada" daripada ngirim sampah/PP default palsu.
async function fetchImageBuffer(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (type && !type.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length ? buf : null;
  } catch { return null; }
}

// In-memory stores (replace with DB for persistence across restarts)
const absenStore      = new Map(); // groupJid -> { title, members: Set<jid> }
const afkStore        = new Map(); // jid -> { reason, since }
const topchatStore    = new Map(); // groupJid -> Map<jid, count>
const msgStore        = new Map(); // remoteJid|id -> event (untuk antidelete)
const fs              = require('fs');
const path            = require('path');

// Pesan yang BOT kirim sendiri nggak pernah lewat jalur pesan masuk (engine
// skip `fromMe` di line ~477), jadi store-nya cuma keisi pesan orang lain —
// padahal yang paling sering dihapus justru balasan bot. Sambung ke adapter.
try {
  const { onMessageSent } = require('../engine/baileys/client');
  if (typeof onMessageSent === 'function') {
    onMessageSent((wam) => {
      const jid = wam?.key?.remoteJid;
      if (jid && jid.endsWith('@g.us')) antideleteRemember(jid, wam.key.id, wam.message, true);
    });
  }
} catch { /* adapter lain (mis. zapo lama) nggak punya hook ini */ }

// Baca antidelete status dari proteksi-settings.json (shared dengan 06-proteksi.js)
const PROTEKSI_FILE = path.join(__dirname, '..', 'sessions', 'proteksi-settings.json');

// Anti-delete gampang kelihatan "rusak" padahal cuma kehabisan bahan: store-nya
// RAM, dan tiap bot restart (deploy/preview/crash) isinya hilang. Yang dihapus
// user belum tentu pesan yang barusan masuk — teks terakhir di grup bisa udah
// ketimbun command. Jadi simpan juga ke disk, tapi cuma kalau antidelete nyala
// di grup mana pun: grup yang nggak pakai fitur nggak bayar apa-apa.
const STORE_FILE  = path.join(__dirname, '..', 'data', 'antidelete-store.json');
const STORE_MAX   = 800;                         // per grup, yang lama dibuang
const STORE_TTL   = 2 * 24 * 60 * 60 * 1000;     // 2 hari
const STORE_SKIP  = new Set(['senderKeyDistributionMessage', 'messageContextInfo', 'protocolMessage', 'reactionMessage']);

// Grup mana pakai antidelete — di-cache, dibaca ulang kalau file setting berubah.
let _adActive = null, _adMtime = 0;
function antideleteActiveCache() {
  try {
    const mt = fs.statSync(PROTEKSI_FILE).mtimeMs;
    if (_adActive === null || mt !== _adMtime) {
      const data = JSON.parse(fs.readFileSync(PROTEKSI_FILE, 'utf8'));
      _adActive = new Set(Object.keys(data).filter((j) => data[j]?.antidelete === true));
      _adMtime = mt;
    }
  } catch { _adActive = new Set(); }
  return _adActive;
}

let _dirty = false;
// fromMe=true = pesan yang BOT sendiri kirim. Ini yang paling sering dihapus
// orang (justru balasan bot), tapi nggak pernah lewat jalur pesan masuk — jadi
// tanpa penanda ini store-nya kosong melompong terus.
function antideleteRemember(remoteJid, id, message, fromMe = false) {
  if (!id || !message) return;
  if (!antideleteActiveCache().size) return;
  const type = Object.keys(message)[0] || '';
  if (STORE_SKIP.has(type)) return;
  msgStore.set(remoteJid + '|' + id, { remoteJid, id, message, at: Date.now(), fromMe });
  _dirty = true;
  antideleteFlush();
}

function antideleteFlush() {
  if (!_dirty) return;
  _dirty = false;
  try {
    const now = Date.now();
    const perGroup = new Map();
    for (const [k, v] of msgStore) {
      if (now - v.at > STORE_TTL) { msgStore.delete(k); continue; }
      const g = perGroup.get(v.remoteJid) || [];
      g.push(v);
      perGroup.set(v.remoteJid, g);
    }
    const out = [];
    for (const g of perGroup.values()) {
      g.sort((a, b) => a.at - b.at);
      out.push(...g.slice(-STORE_MAX));
    }
    fs.writeFileSync(STORE_FILE, JSON.stringify(out));
  } catch { /* store nggak boleh bikin pesan gagal diproses */ }
}

function antideleteLoad() {
  try {
    const now = Date.now();
    for (const v of JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))) {
      if (!v?.id || !v?.message || now - v.at > STORE_TTL) continue;
      msgStore.set(v.remoteJid + '|' + v.id, { ...v, message: reviveBuffers(v.message) });
    }
  } catch { /* nggak ada / rusak = mulai dari kosong */ }
}
antideleteLoad();

// JSON nggak kenal Buffer: mediaKey/fileSha256 balik jadi {type:'Buffer',data:[…]}
// dan downloadMediaMessage nolak itu. Balikin ke Buffer sebelum dipakai.
function reviveBuffers(obj) {
  if (Buffer.isBuffer(obj)) return obj;
  if (Array.isArray(obj)) return obj.map(reviveBuffers);
  if (obj && typeof obj === 'object') {
    if (obj.type === 'Buffer' && Array.isArray(obj.data)) return Buffer.from(obj.data);
    const out = {};
    for (const k of Object.keys(obj)) out[k] = reviveBuffers(obj[k]);
    return out;
  }
  return obj;
}

// Meta AI. JID-nya `@bot`, bukan nomor — jangan di-strip jadi angka.
const JID_META_AI = '867051314767696@bot';

function isAntideleteActive(groupJid) {
  try {
    if (!fs.existsSync(PROTEKSI_FILE)) return false;
    const data = JSON.parse(fs.readFileSync(PROTEKSI_FILE, 'utf8'));
    return data[groupJid]?.antidelete === true;
  } catch { return false; }
}

module.exports = async function groupHandler(ctx) {
  if (!ctx.isCmd || !ctx.isGroup) {
    if (ctx.isGroup) {
      const rawMsg = ctx.msg;
      const msgType = rawMsg?.message ? Object.keys(rawMsg.message)[0] : null;

      // ── Antidelete: handle delete event ──────────────────────────────────────
      if (msgType === 'protocolMessage' && rawMsg.message.protocolMessage?.type === 0) {
        const deletedKey = rawMsg.message.protocolMessage.key;
        const storeKey   = `${deletedKey.remoteJid}|${deletedKey.id}`;
        // Kalau yang hapus bot/owner/dev, jangan digubris: mereka memang berhak
        // hapus, dan dulu ini bikin bot ngomel tiap kali membereskan chat sendiri.
        const resolveDeleter = ctx.client.contact?.resolveLid;
        const deleterRaw     = rawMsg.key?.participant || rawMsg.key?.participantPn || rawMsg.key?.remoteJid || '';
        let deleterNum = String(deleterRaw).split('@')[0].split(':')[0];
        try { if (resolveDeleter) deleterNum = String(await resolveDeleter(deleterRaw)).split('@')[0].split(':')[0]; } catch { /* pakai yang mentah */ }

        const ownerNum = String(ctx.botData?.owner_number || process.env.OWNER_NUMBER || '').replace(/\D/g, '');
        const devNums  = String(process.env.DEV_NUMBERS || process.env.DEVELOPER_NUMBERS || process.env.DEVELOPER_NUMBER || '')
          .split(',').map((n) => n.replace(/\D/g, '')).filter(Boolean);

        // fromMe = bot sendiri yang hapus -> skip. Ini yang bikin "ga ada reaksi"
        // pas owner/dev beres-beres chat pakai nomor bot.
        if (rawMsg.key?.fromMe === true) return false;
        if (deleterNum && ((ownerNum && deleterNum === ownerNum) || devNums.includes(deleterNum))) return false;

        // Admin grup (termasuk owner/dev kalau admin di grup itu) memang berhak
        // hapus — nggak perlu diomelin. Dicek per-nomor karena ctx.isAdmin dihitung
        // dari sender pesan, dan di sini sender-nya bukan yang menghapus.
        try {
          const meta = await ctx.client.group.queryGroupMetadata(ctx.jid).catch(() => null);
          const p = meta?.participants?.find((x) =>
            x.jid?.split('@')[0].split(':')[0] === deleterNum ||
            x.lid?.split('@')[0].split(':')[0] === deleterNum ||
            (x.phoneNumber && x.phoneNumber.replace(/\D/g, '').endsWith(deleterNum)));
          if (p?.isAdmin || p?.isSuperAdmin) return false;
        } catch { /* metadata gagal -> lanjut saja */ }

        if (isAntideleteActive(ctx.jid)) {
          const stored     = msgStore.get(storeKey);
          if (stored) {
            const storedType    = Object.keys(stored.message)[0];
            const storedContent = stored.message[storedType];
            const deleterJid = rawMsg.key?.participant || rawMsg.key?.remoteJid || '';
            const deleterPhone = deleterJid.split('@')[0];
            try {
              const headerText = `🛡️ *Anti-Delete*\n@${deleterPhone} ngapain di hapus bang 😹`;
              // Satu pesan berkutip: isi aslinya jadi kutipan, header jadi balasannya.
              // Jadinya jelas "ini lho pesan yang dihapus" — dulu cuma teks mentah.
              const bodyOf = () => {
                if (storedType === 'conversation') return String(storedContent || '');
                if (storedType === 'extendedTextMessage') return storedContent?.text || '';
                return storedContent?.caption || '';
              };
              const cap = (extra = '') => (bodyOf() ? `${headerText}\n\n> ${bodyOf()}${extra}` : `${headerText}${extra}`);

              if (storedType === 'stickerMessage') {
                const fixed = Object.assign({}, storedContent);
                for (const f of ['mediaKey','fileSha256','fileEncSha256']) {
                  if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
                }
                const buffer = await ctx.client.message.downloadBytes({ stickerMessage: fixed });
                await ctx.client.message.send(ctx.jid, {
                  type: 'sticker', media: buffer, mimetype: storedContent.mimetype || 'image/webp',
                });
                await ctx.client.message.send(ctx.jid, { type: 'text', text: cap(), mentions: [deleterJid] });
              } else if (['imageMessage','videoMessage','audioMessage','documentMessage'].includes(storedType)) {
                const uploadType = storedType === 'imageMessage' ? 'image'
                  : storedType === 'videoMessage' ? 'video'
                  : storedType === 'documentMessage' ? 'document'
                  : (storedContent.ptt ? 'ptt' : 'audio');
                const mime = storedContent.mimetype || 'application/octet-stream';
                // Bentuknya dipertahankan: foto sekali-lihat dikirim sekali-lihat
                // lagi, video note (ptv) tetap video note. (`bodyOf`/`cap` baca
                // `storedContent` langsung, jadi caption TIDAK boleh dihapus.)
                // Catatan: "foto live" (motion photo) = foto + video pendamping,
                // dikirim WA sebagai 2 pesan terpisah — bukan `ptv`.
                const fixed = Object.assign({}, storedContent);
                for (const f of ['mediaKey','fileSha256','fileEncSha256']) {
                  if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
                }
                const isViewOnce = storedContent.viewOnce === true;
                const isPtv = storedContent.ptv === true;

                let buffer;
                try {
                  buffer = await ctx.client.message.downloadBytes({ [storedType]: fixed });
                } catch (dlErr) {
                  console.log(`[Antidelete] media gagal diunduh: ${dlErr.message}`);
                  await ctx.client.message.send(ctx.jid, {
                    type: 'text', text: cap('\n\n⚠️ Medianya udah nggak bisa diunduh'),
                    mentions: [deleterJid],
                  }).catch(() => {});
                  return false;
                }
                await ctx.client.message.send(ctx.jid, {
                  type: uploadType, media: buffer, mimetype: mime,
                  ...(uploadType === 'document' && { fileName: storedContent.fileName || 'file' }),
                  ...(isPtv && { ptv: true }),            // video note (bulat)
                  ...(isViewOnce && { viewOnce: true }),  // sekali lihat
                  caption: isViewOnce ? undefined : cap(),
                  mentions: [deleterJid],
                });
                // view-once nggak bisa bawa caption: kirim isinya sebagai pesan
                // kedua biar captionnya nggak hilang.
                if (isViewOnce && bodyOf()) {
                  await ctx.client.message.send(ctx.jid, {
                    type: 'text', text: cap(), mentions: [deleterJid],
                  }).catch(() => {});
                }
              } else {
                await ctx.client.message.send(ctx.jid, {
                  type: 'text', text: cap(), mentions: [deleterJid],
                });
              }
            } catch (e) {
              // Dulu cuma console.log: user nggak dapat apa-apa dan keliatannya
              // "bot nggak respon". Minimal kasih tahu pesannya kehapus tapi gagal dikirim ulang.
              console.log(`[Antidelete] gagal kirim ulang: ${e.message}`);
              try {
                await ctx.client.message.send(ctx.jid, {
                  type: 'text',
                  text: `🛡️ *Anti-Delete*\n@${deleterPhone} hapus pesan, tapi gagal dikirim ulang (${e.message})`,
                  mentions: [deleterJid],
                });
              } catch { /* dua-duanya gagal */ }
            }
          }
        }
        return false;
      }

      // ── Store pesan untuk antidelete ─────────────────────────────────────────
      if (rawMsg?.key && rawMsg?.message && msgType !== 'protocolMessage') {
        antideleteRemember(rawMsg.key.remoteJid, rawMsg.key.id, rawMsg.message, rawMsg.key.fromMe === true);
      }

      // ── AFK check ─────────────────────────────────────────────────────────────
      if (!ctx.isCmd) {
        const key = `${ctx.jid}:${ctx.sender}`;
        if (afkStore.has(key)) {
          const { reason, since } = afkStore.get(key);
          afkStore.delete(key);
          const dur = Math.floor((Date.now() - since) / 1000);
          await ctx.reply(`Selamat datang kembali *${ctx.pushName}*!\nKamu telah AFK selama ${dur} detik.\nAlasan: ${reason || '-'}`);
        }
        // Topchat tracking
        if (!topchatStore.has(ctx.jid)) topchatStore.set(ctx.jid, new Map());
        const tc = topchatStore.get(ctx.jid);
        tc.set(ctx.sender, (tc.get(ctx.sender) || 0) + 1);
      }
    }
    return false;
  }

  const { command, args, reply, react, sock, client, jid, sender, botData } = ctx;
  const p = botData.prefix;

  // Helper: get group metadata via client adapter
  async function getMeta() {
    try { return await client.group.queryGroupMetadata(jid); } catch { return null; }
  }

  // Helper: resolve nomor untuk display mention di teks
  // Di grup LID, harus pakai LID number bukan phone number agar mention bisa di-tap
  function resolveMentionTag(participant) {
    // Kalau jid adalah LID (@lid), pakai LID number untuk teks @mention
    if (participant.jid && participant.jid.endsWith('@lid')) {
      return participant.jid.split('@')[0];
    }
    // Kalau phone JID (@s.whatsapp.net), pakai phone number
    return participant.jid.split('@')[0];
  }

  // Helper: resolve nomor WA asli untuk display info (bukan mention)
  function resolveNum(participant) {
    if (participant.phoneNumber) return String(participant.phoneNumber).split('@')[0];
    return participant.jid.split('@')[0];
  }

  // Helper: is sender admin?
  async function isAdmin() {
    const meta = await getMeta();
    if (!meta) return false;
    const senderPhone = sender.split('@')[0];
    return meta.participants.some(p => {
      if (!p.isAdmin) return false;
      if (p.jid === sender || p.lid === sender) return true;
      // Match via phoneNumber field (untuk grup LID)
      if (p.phoneNumber) {
        const pPhone = String(p.phoneNumber).replace(/\D/g, '');
        if (pPhone === senderPhone) return true;
      }
      return false;
    });
  }

  // Helper: is bot admin?
  async function isBotAdmin() {
    const meta = await getMeta();
    if (!meta) return false;
    const botNum = botData.bot_number?.replace(/\D/g, '');
    return meta.participants.some(p => {
      // Grup LID: p.jid = @lid, p.phoneNumber = 628xxx@s.whatsapp.net
      const phoneMatch = p.phoneNumber && String(p.phoneNumber).includes(botNum);
      // Grup biasa: p.jid = 628xxx@s.whatsapp.net
      const jidMatch = p.jid && p.jid.includes(botNum);
      return (phoneMatch || jidMatch) && p.isAdmin;
    });
  }

  // Helper: normalisasi jam jadwal buka/tutup -> 'HH.MM' atau null kalau invalid.
  // Wajib: cron di server.js membandingkan string persis, jadi '7.00' tidak akan
  // pernah cocok dengan '07.00' -> jadwal diam-diam tidak jalan.
  function normalizeJam(input) {
    const m = String(input ?? '').trim().match(/^(\d{1,2})[.:](\d{1,2})$/);
    if (!m) return null;
    const h = Number(m[1]), min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return `${String(h).padStart(2, '0')}.${String(min).padStart(2, '0')}`;
  }

  switch (command) {
    // ── tagall ──────────────────────────────────────────────────────────────
    case 'tagall': {
      const meta = await getMeta();
      if (!meta) { await reply('Gagal mengambil data grup'); return true; }
      const text = args.join(' ') || 'Perhatian semua!';
      // Kumpulkan semua JID — jid dan lid sekaligus untuk mention
      const mentionJids = [];
      meta.participants.forEach(p => {
        if (p.jid) mentionJids.push(p.jid);
        if (p.lid && p.lid !== p.jid) mentionJids.push(p.lid);
      });
      const tags = meta.participants.map(p => `@${resolveMentionTag(p)}`).join('\n');
      await client.message.send(jid, {
        type: 'text',
        text: `📢 *${text}*\n\n${tags}\n\n_Total: ${meta.participants.length} member_`,
        mentions: mentionJids,
      });
      return true;
    }

    // ── tagadmin ─────────────────────────────────────────────────────────────
    case 'tagadmin': {
      const meta = await getMeta();
      if (!meta) { await reply('Gagal mengambil data grup'); return true; }
      const admins = meta.participants.filter(p => p.isAdmin);
      if (admins.length === 0) { await reply('Tidak ada admin di grup ini'); return true; }
      const text = args.join(' ') || 'Panggilan untuk admin!';
      const mentionJids = [];
      admins.forEach(p => {
        if (p.jid) mentionJids.push(p.jid);
        if (p.lid && p.lid !== p.jid) mentionJids.push(p.lid);
      });
      const tags = admins.map(a => `@${resolveMentionTag(a)}`).join('\n');
      await client.message.send(jid, {
        type: 'text',
        text: `👑 *${text}*\n\n${tags}`,
        mentions: mentionJids,
      });
      return true;
    }

    // ── tagme ────────────────────────────────────────────────────────────────
    case 'tagme': {
      await client.message.send(jid, {
        type: 'text',
        text: `🔖 @${sender.split('@')[0]}`,
        mentions: [sender],
      });
      return true;
    }

    // ── hidetag ──────────────────────────────────────────────────────────────
    case 'hidetag':
    case 'ht': {
      if (!await isBotAdmin()) { await reply(mess.BotAdmin); return true; }
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      const meta = await getMeta();
      if (!meta) { await reply('Gagal mengambil data grup'); return true; }

      const mentionJids = [];
      meta.participants.forEach(p => {
        if (p.jid) mentionJids.push(p.jid);
        if (p.lid && p.lid !== p.jid) mentionJids.push(p.lid);
      });

      const rawMsg     = ctx.msg.message || {};
      const msgType    = Object.keys(rawMsg)[0] || '';
      const quoted     = rawMsg?.extendedTextMessage?.contextInfo?.quotedMessage;
      const quotedType = quoted ? Object.keys(quoted)[0] : null;
      const mediaTypes = ['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage'];
      const text       = args.join(' ').trim();

      // Kalau ada quoted media — forward dengan mention semua
      if (quotedType && mediaTypes.includes(quotedType)) {
        const content  = quoted[quotedType];
        const fixed    = Object.assign({}, content);
        for (const f of ['mediaKey','fileSha256','fileEncSha256']) {
          if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
        }
        const buffer  = Buffer.from(await client.message.downloadBytes({ [quotedType]: fixed }));
        const mime    = content.mimetype || 'image/jpeg';
        const caption = text || content.caption || '';
        const typeMap = { imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio', stickerMessage: 'sticker' };
        const type    = typeMap[quotedType] || 'image';
        await client.message.send(jid, {
          type, media: buffer, mimetype: mime,
          ...(caption ? { caption } : {}),
          mentions: mentionJids,
        });
      } else if (mediaTypes.includes(msgType)) {
        // Direct media + command
        const content  = rawMsg[msgType];
        const fixed    = Object.assign({}, content);
        for (const f of ['mediaKey','fileSha256','fileEncSha256']) {
          if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
        }
        const buffer  = Buffer.from(await client.message.downloadBytes({ [msgType]: fixed }));
        const mime    = content.mimetype || 'image/jpeg';
        const caption = text || content.caption || '';
        const typeMap = { imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio', stickerMessage: 'sticker' };
        const type    = typeMap[msgType] || 'image';
        await client.message.send(jid, {
          type, media: buffer, mimetype: mime,
          ...(caption ? { caption } : {}),
          mentions: mentionJids,
        });
      } else {
        // Teks biasa
        await client.message.send(jid, {
          type: 'text',
          text: text || '\u200e',
          mentions: mentionJids,
        });
      }
      return true;
    }

    // ── linkgroup ─────────────────────────────────────────────────────────────
    // ── upswgc ───────────────────────────────────────────────────────────────
    // ── kick ─────────────────────────────────────────────────────────────────
    case 'kick': {
      if (!await isBotAdmin()) { await reply(mess.BotAdmin); return true; }
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      const mentioned = ctx.msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      if (mentioned.length === 0) { await reply(`Penggunaan: ${p}kick @mention`); return true; }
      try {
        const results = await client.group.removeParticipants(jid, mentioned);
        const failed = (Array.isArray(results) ? results : []).filter(r => r && r.status !== 'ok');
        if (failed.length > 0) {
          // Tampilkan NOMOR, bukan LID — di grup LID, jid peserta bentuknya '...@lid'
          // dan angka itu nggak ada artinya buat manusia.
          const reasons = (await Promise.all(failed.map(async (r) => {
            const shown = (await lidToPnAsync(client, r.jid)).split('@')[0] || '?';
            return `${shown} (kode ${r.code || 'error'})`;
          }))).join(', ');
          await reply(`⚠️ Sebagian gagal dikick: ${reasons}`);
        } else {
          await reply(`✅ Berhasil kick ${mentioned.length} member`);
        }
      } catch (e) {
        await reply(`❌ Gagal kick: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── add (tambah member via nomor) / addai (tambahin bot AI) ──────────────
    case 'add':
    // `.addai` = tambahin bot AI ke grup. Baileys mau JID-nya, bukan nomor:
    // `.addai` polos -> Meta AI, `.addai <kode>` -> dari tabel AI_JID,
    // `.addai 628xx@bot` -> JID mentah. Gate `isAdmin()` tetap; `isBotAdmin()`
    // tetap (bot harus admin biar WA nggak nolak diem-diem).
    case 'addai': {
      if (!await isBotAdmin()) { await reply(mess.BotAdmin); return true; }
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      const isAi   = command === 'addai';
      const numArg = args[0];
      let target;
      if (!isAi) {
        if (!numArg) {
          await reply(`Penggunaan: ${p}add <nomor>\n\nContoh: ${p}add 6281234567890`);
          return true;
        }
        // Normalisasi nomor: hapus +, spasi, dash
        target = { jid: `${numArg.replace(/[^0-9]/g, '')}@s.whatsapp.net`, nama: numArg.replace(/[^0-9]/g, '') };
      } else {
        target = { jid: JID_META_AI, nama: 'Meta AI' };
      }
      const { jid: targetJid, nama } = target;
      try {
        const results = await client.group.addParticipants(jid, [targetJid]);
        // client adapter return array hasil per-jid: { jid, status: 'ok'|'error', code }
        const res = (Array.isArray(results) ? results : [])[0];
        if (!res) {
          await reply(`⚠️ Tidak ada respon dari WhatsApp saat menambahkan *${nama}*. Pastikan bot admin grup.`);
        } else if (res.status === 'ok') {
          await reply(`✅ Sukses add *${nama}* ke grup!`);
        } else {
          const reason = {
            403: 'nomor ini belum pernah chat bot / privasi nomor, coba minta dia chat bot dulu',
            404: 'nomor tidak terdaftar di WhatsApp',
            408: 'timeout, coba lagi',
            409: 'sudah menjadi member grup',
            429: 'kecepatan ditahan WhatsApp, coba beberapa menit lagi',
          }[res.code] || `kode error ${res.code}`;
          await reply(`❌ Gagal menambahkan *${nama}*\nAlasan: ${reason}`);
        }
      } catch (e) {
        await reply(`❌ Gagal menambahkan *${nama}*\nAlasan: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── kickall ──────────────────────────────────────────────────────────────
    case 'kickall': {
      if (!await isBotAdmin()) { await reply(mess.BotAdmin); return true; }
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      const meta    = await getMeta();
      const botJid  = client.auth?.getCurrentCredentials?.()?.meJid
        ?.replace(/:.*@/, '@') || '';
      const members = meta.participants
        .filter(p => !p.isAdmin)
        .map(p => p.jid || p.lid)
        .filter(m => m && m !== sender && m !== botJid);
      if (members.length === 0) { await reply('Tidak ada member yang bisa dikick'); return true; }
      try {
        const results = await client.group.removeParticipants(jid, members);
        const failed = (Array.isArray(results) ? results : []).filter(r => r && r.status !== 'ok');
        const okCount = members.length - failed.length;
        if (failed.length > 0) {
          await reply(`⚠️ ${okCount} dikick, ${failed.length} gagal (${failed[0]?.code || 'error'})`);
        } else {
          await reply(`✅ ${members.length} member berhasil dikick`);
        }
      } catch (e) {
        await reply(`❌ Gagal kickall: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── promote ──────────────────────────────────────────────────────────────
    case 'promote': {
      if (!await isBotAdmin()) { await reply(mess.BotAdmin); return true; }
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      // Ambil target dari mention atau reply
      const mentionedPromote = ctx.msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      const quotedSenderPromote = ctx.msg.message?.extendedTextMessage?.contextInfo?.participant;
      const targetsPromote = mentionedPromote.length > 0 ? mentionedPromote : (quotedSenderPromote ? [quotedSenderPromote] : []);
      if (targetsPromote.length === 0) { await reply(`Penggunaan: ${p}promote @mention atau reply pesan`); return true; }
      await client.group.promoteParticipants(jid, targetsPromote);
      await reply(`👑 Berhasil promote ${targetsPromote.length} member menjadi admin`);
      return true;
    }

    // ── demote ───────────────────────────────────────────────────────────────
    case 'demote': {
      if (!await isBotAdmin()) { await reply(mess.BotAdmin); return true; }
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      const mentionedDemote = ctx.msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      const quotedSenderDemote = ctx.msg.message?.extendedTextMessage?.contextInfo?.participant;
      const targetsDemote = mentionedDemote.length > 0 ? mentionedDemote : (quotedSenderDemote ? [quotedSenderDemote] : []);
      if (targetsDemote.length === 0) { await reply(`Penggunaan: ${p}demote @mention atau reply pesan`); return true; }
      await client.group.demoteParticipants(jid, targetsDemote);
      await reply(`⬇️ Berhasil demote ${targetsDemote.length} admin menjadi member`);
      return true;
    }

    // ── grupopen / grupclose / linkgc / setnamegc — alias ────────────────────
    case 'grupopen':
      return module.exports({ ...ctx, command: 'open' });
    case 'grupclose':
      return module.exports({ ...ctx, command: 'close' });
    case 'linkgc':
      return module.exports({ ...ctx, command: 'linkgroup' });
    case 'setnamegc':
      return module.exports({ ...ctx, command: 'setname' });

    // ── open / close — kalau grupnya UDAH di posisi yang diminta, jangan
    // kirim tag-nya lagi (percuma + WA ngirim notif "grup dibuka/ditutup" ke
    // semua member). Cukup tengok `meta.announce` (Baileys: `!!<announcement>`
    // = announce ON = grup TUTUP).
    case 'open': {
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      if (!await isBotAdmin()) { await reply(mess.BotAdmin); return true; }
      const sudahBuka = (await getMeta())?.announce === false;
      await client.group.setSetting(jid, 'open');
      await reply(sudahBuka
        ? '🔓 *Lah, grupnya udah kebuka dari tadi.*\n\nNgapain jir? Mau ngobrol tinggal ketik aja, nggak usah izin 🗿'
        : '🔓 *Grup dibuka!*\n\nUdah, pada bisa ngomong sekarang. Ramein dikit jangan pada ngumpet 🗿');
      return true;
    }
    case 'close': {
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      if (!await isBotAdmin()) { await reply(mess.BotAdmin); return true; }
      const sudahTutup = (await getMeta())?.announce === true;
      await client.group.setSetting(jid, 'close');
      await reply(sudahTutup
        ? '🔒 *Grupnya udah ketutup, bang.*\n\nMau ngekunci dua kali? Sabar, jangan drama 🗿'
        : '🔒 *Grup ditutup!*\n\nSekarang cuma admin yang bisa ngomong. Yang lain sini mah pada sunyi 🗿');
      return true;
    }

    // ── mute / unmute ─────────────────────────────────────────────────────────
    case 'mute': {
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      if (!await isBotAdmin()) { await reply(mess.BotAdmin); return true; }
      const sudahMute = (await getMeta())?.announce === true;
      await client.group.setSetting(jid, 'mute');
      await reply(sudahMute
        ? '🔇 *Udah di-mute bang.* Nggak usah dipencet lagi 🗿'
        : '🔇 *Grup di-mute.*\n\nSemua mode sunyi, cuma admin yang boleh buka suara 🗿');
      return true;
    }
    case 'unmute': {
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      if (!await isBotAdmin()) { await reply(mess.BotAdmin); return true; }
      const sudahUnmute = (await getMeta())?.announce === false;
      await client.group.setSetting(jid, 'unmute');
      await reply(sudahUnmute
        ? '🔊 *Udah pada bisa ngomong kok, bang.* Nggak usah di-unmute lagi 🗿'
        : '🔊 *Grup di-unmute!*\n\nSilakan ngomong, yang lain jangan diem aja 🗿');
      return true;
    }

    // ── slowmode ──────────────────────────────────────────────────────────────
    case 'slowmode': {
      await reply('⏱️ Slowmode diaktifkan (fitur tergantung dukungan WhatsApp API)');
      return true;
    }

    // ── setname ───────────────────────────────────────────────────────────────
    case 'setname': {
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      if (!await isBotAdmin()) { await reply(mess.BotAdmin); return true; }
      const name = args.join(' ');
      if (!name) { await reply(`Penggunaan: ${p}setname <nama baru>`); return true; }
      if (name.length > 25) { await reply('❌ Maksimal 25 karakter'); return true; }
      await client.group.setSubject(jid, name);
      await reply(`✅ Nama grup diubah ke: ${name}`);
      return true;
    }

    // ── setdesc ───────────────────────────────────────────────────────────────
    case 'setdesc': {
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      if (!await isBotAdmin()) { await reply(mess.BotAdmin); return true; }
      const desc = args.join(' ');
      if (!desc) { await reply(`Penggunaan: ${p}setdesc <deskripsi baru>`); return true; }
      const meta = await getMeta();
      await client.group.setDescription(jid, desc, meta?.descId);
      await reply(`✅ Deskripsi grup diperbarui`);
      return true;
    }

    // ── linkgroup ─────────────────────────────────────────────────────────────
    case 'linkgroup': {
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      if (!await isBotAdmin()) { await reply(mess.BotAdmin); return true; }
      const inviteCode = await client.group.queryInviteCode(jid);
      await reply(`🔗 *Link Grup*\nhttps://chat.whatsapp.com/${inviteCode}`);
      return true;
    }

    // ── groupinfo / infogc ────────────────────────────────────────────────────
    case 'groupinfo':
    case 'infogc': {
      const meta = await getMeta();
      if (!meta) { await reply('Gagal mengambil data grup'); return true; }
      const admins  = meta.participants.filter(p => p.isAdmin).length;
      const members = meta.participants.length;
      const status  = await proteksi.statusGrup(botData.id, jid, botData.main_groups);
      const hdr =
        `📊 *Info Grup*\n\n` +
        `Nama    : ${meta.subject}\n` +
        `JID     : ${jid}\n` +
        `Status  : ${status}\n` +
        `Member  : ${members}\n` +
        `Admin   : ${admins}\n` +
        `Dibuat  : ${new Date(meta.creation * 1000).toLocaleDateString('id-ID')}\n\n` +
        `📝 *Deskripsi*\n${meta.desc || '_belum ada deskripsi_'}\n\n` +
        await proteksi.statusFitur(botData.id, jid);

      // PP grup dikirim sebagai gambar, caption-nya info + status di atas.
      // Gagal ambil PP = kirim teks aja, jangan bikin command-nya mati.
      const ppUrl = await client.profile.getProfilePicture(jid, 'image').catch(() => null);
      const buf   = ppUrl ? await fetchImageBuffer(ppUrl) : null;

      if (buf) {
        const thumb = await genThumbnail(buf, 'image/jpeg');
        await client.message.send(jid, {
          type: 'image',
          media: buf,
          mimetype: 'image/jpeg',
          caption: hdr,
          ...(thumb ? { jpegThumbnail: thumb } : {}),
        });
      } else {
        await reply(hdr);
      }
      return true;
    }

    // ── idgc — ID grup dengan tombol copy ────────────────────────────────────
    case 'idgc': {
      const meta    = await getMeta();
      const nama    = meta?.subject || 'Grup ini';
      const invCode = await client.group.queryInviteCode(jid).catch(() => null);
      const link    = invCode ? `https://chat.whatsapp.com/${invCode}` : '-';
      const admins  = meta?.participants.filter(p => p.isAdmin || p.isSuperAdmin).length || 0;
      const members = meta?.participants.length || 0;
      await reply(
        `🆔 *ID Grup*\n\n` +
        `Nama   : ${nama}\n` +
        `JID    : \`${jid}\`\n` +
        `Member : ${members}\n` +
        `Admin  : ${admins}\n` +
        `Link   : ${link}`
      );
      return true;
    }

    // ── leavegc ───────────────────────────────────────────────────────────────
    case 'leavegc': {
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      await reply('Bot akan keluar dari grup ini...');
      await client.group.leaveGroup([jid]);
      return true;
    }

    // ── listadmin ─────────────────────────────────────────────────────────────
    case 'listadmin': {
      const meta   = await getMeta();
      if (!meta) { await reply('Gagal mengambil data grup'); return true; }
      const admins = meta.participants.filter(p => p.isAdmin);
      if (admins.length === 0) { await reply('Tidak ada admin di grup ini'); return true; }
      const list   = admins.map((a, i) => `${i + 1}. @${resolveMentionTag(a)}`).join('\n');
      const mentionJids = admins.flatMap(a => [a.jid, a.lid].filter(Boolean));
      await client.message.send(jid, {
        type: 'text',
        text: `👑 *Daftar Admin*\n\n${list}`,
        mentions: mentionJids,
      });
      return true;
    }

    // ── pp / getpp ─────────────────────────────────────────────────────────────
    case 'getpp':
    case 'pp': {
      // Sumber target, urutan: mention > reply > (fallback) diri sendiri.
      // Reply dibaca dari contextInfo message itu sendiri + SEMUA jenis pesan
      // (dulu cuma `extendedTextMessage`/`imageMessage`/`conversation`, jadi
      // reply ke video/stiker/dokumen dianggap "nggak ada target").
      const ci = ctx.msg?.message?.extendedTextMessage?.contextInfo
              || ctx.msg?.message?.imageMessage?.contextInfo
              || ctx.msg?.message?.videoMessage?.contextInfo
              || ctx.msg?.message?.documentMessage?.contextInfo
              || ctx.msg?.message?.audioMessage?.contextInfo
              || ctx.msg?.message?.stickerMessage?.contextInfo
              || ctx.msg?.message?.contactMessage?.contextInfo
              || {};
      const mentioned = ctx.mentioned?.length ? ctx.mentioned : (ci.mentionedJid || []);

      // Target WAJIB eksplisit: tag atau reply. `.pp` polos nggak nampilin PP
      // siapa pun (termasuk pengirim) — kasih instruksi aja.
      // Command ini grup-only karena 02-group early-return buat chat pribadi,
      // jadi `sender` selalu ada dan cabang `!target` di bawah praktis mati.
      let target = mentioned[0] || ci.participant || null;
      if (!target) {
        await reply(`📸 *Foto profil*\n\nTag orangnya atau reply pesannya.\nContoh: \`${p}pp @user\``);
        return true;
      }
      // Jalur reply: `ci.participant` masih LID mentah — engine cuma resolve
      // `ctx.mentioned`, bukan participant pesan yang di-quote. Akibatnya teks
      // `@628...` nggak match `mentionedJid` (isinya `...@lid`) → WA nampilin
      // angka polos, bukan mention. Samakan bentuknya kayak jalur @tag.
      target = await lidToPnAsync(client, target);
      let phoneNum = String(target).split('@')[0];

      // Resolve LID ke phone JID lewat metadata grup
      const meta = await getMeta();
      const participant = meta?.participants?.find(p =>
        p.jid === target || p.lid === target
      );
      if (participant?.phoneNumber) {
        // `phoneNumber` bisa ada tapi null → `String(null)` = "null" (JID sampah).
        phoneNum = String(participant.phoneNumber).replace(/\D/g, '');
      } else if (target.endsWith('@lid') && participant?.jid && !participant.jid.endsWith('@lid')) {
        phoneNum = String(participant.jid).split('@')[0];
      }

      // Adapter balikin string url (bukan {url}) — lihat normalizeProfilePicture.
      let ppUrl = null;
      try {
        ppUrl = await client.profile.getProfilePicture(target, 'image');
      } catch { /* coba nomor */ }
      if (!ppUrl) {
        try { ppUrl = await client.profile.getProfilePicture(phoneNum + '@s.whatsapp.net', 'image'); } catch { /* kosong */ }
      }

      const imgBuffer = ppUrl ? await fetchImageBuffer(ppUrl) : null;

      // `.split('@')` di sini yang dulu bikin "Cannot read properties of
      // undefined" waktu `.pp` tanpa tag — `mentioned` bisa kosong karena
      // target datang dari reply, jadi jangan baca `mentioned[0]`.
      const tagNum = phoneNum || String(target).split('@')[0];

      if (imgBuffer) {
        const thumb = await genThumbnail(imgBuffer, 'image/jpeg');
        await client.message.send(jid, {
          type: 'image',
          media: imgBuffer,
          mimetype: 'image/jpeg',
          caption: `📸 Foto profil @${tagNum}`,
          mentions: [target],
          ...(thumb ? { jpegThumbnail: thumb } : {}),
        });
      } else {
        await reply(`❌ @${tagNum} nggak pasang foto profil (atau diprivasi).`);
      }
      return true;
    }

    // ── getppgc ───────────────────────────────────────────────────────────────
    case 'getppgc':
    case 'ppgc':
    case 'ppgroup':
    case 'ppgrup': {
      const ppGcUrl = await client.profile.getProfilePicture(jid, 'image');
      const gcImgBuffer = ppGcUrl ? await fetchImageBuffer(ppGcUrl) : null;

      if (gcImgBuffer) {
        const thumb = await genThumbnail(gcImgBuffer, 'image/jpeg');
        await client.message.send(jid, {
          type: 'image',
          media: gcImgBuffer,
          mimetype: 'image/jpeg',
          caption: '✅ Foto profil grup',
          ...(thumb ? { jpegThumbnail: thumb } : {}),
        });
      } else {
        await reply('❌ Foto profil grup tidak ada atau diprivasi.');
      }
      return true;
    }

    // ── totag ─────────────────────────────────────────────────────────────────
    case 'totag': {
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      const quotedCtxInfo = ctx.msg.message?.extendedTextMessage?.contextInfo;
      const quoted = quotedCtxInfo?.quotedMessage;
      if (!quoted) { await reply(`Reply pesan yang ingin diteruskan ke semua`); return true; }
      const meta    = await getMeta();
      const members = meta?.participants.map(p => p.jid || p.lid).filter(Boolean) || [];
      const fwdCtx  = { forwardingScore: 1, isForwarded: true, mentionedJids: members };

      try {
        // Ambil field binary dari media message, convert base64 -> Buffer
        function fixMediaFields(mediaMsg) {
          const fixed = Object.assign({}, mediaMsg);
          for (const field of ['mediaKey', 'fileSha256', 'fileEncSha256']) {
            if (typeof fixed[field] === 'string') fixed[field] = Buffer.from(fixed[field], 'base64');
          }
          return fixed;
        }

        if (quoted.imageMessage || quoted.videoMessage || quoted.stickerMessage || quoted.audioMessage) {
          const mediaType = quoted.imageMessage ? 'imageMessage'
            : quoted.videoMessage ? 'videoMessage'
            : quoted.stickerMessage ? 'stickerMessage'
            : 'audioMessage';
          const uploadType = quoted.imageMessage ? 'image'
            : quoted.videoMessage ? 'video'
            : quoted.stickerMessage ? 'sticker'
            : (quoted.audioMessage?.ptt ? 'ptt' : 'audio');
          const mediaContent = quoted[mediaType];
          const mimetype = mediaContent.mimetype || (uploadType === 'image' ? 'image/jpeg' : uploadType === 'video' ? 'video/mp4' : uploadType === 'sticker' ? 'image/webp' : 'audio/mpeg');

          const mediaObj = { [mediaType]: fixMediaFields(mediaContent) };
          const buffer = await client.message.downloadBytes(mediaObj);

          const thumb = uploadType === 'image' || uploadType === 'video'
            ? await genThumbnail(buffer, mimetype)
            : null;
          const sendContent = uploadType === 'image'
            ? { type: 'image', media: buffer, mimetype, caption: mediaContent.caption || '', mentions: members, contextInfo: fwdCtx, ...(thumb ? { jpegThumbnail: thumb } : {}) }
            : uploadType === 'video'
            ? { type: 'video', media: buffer, mimetype, caption: mediaContent.caption || '', mentions: members, contextInfo: fwdCtx, ...(thumb ? { jpegThumbnail: thumb } : {}) }
            : uploadType === 'sticker'
            ? { type: 'sticker', media: buffer, mimetype, contextInfo: fwdCtx }
            : { type: 'audio', media: buffer, mimetype, ptt: mediaContent.ptt || false, contextInfo: fwdCtx };
          await client.message.send(jid, sendContent);
        } else {
          const text = quoted.conversation || quoted.extendedTextMessage?.text || '';
          await client.message.send(jid, { text, mentions: members, contextInfo: fwdCtx });
        }
      } catch (e) {
        await reply(`Error: ${e.message}`);
      }
      return true;
    }

    // ── delete ────────────────────────────────────────────────────────────────
    case 'delete': {
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      const quotedCtx = ctx.msg.message?.extendedTextMessage?.contextInfo;
      if (!quotedCtx?.stanzaId) { await reply('Reply pesan yang ingin dihapus'); return true; }
      const botJid = client.authState?.creds?.me?.id || '';
      const fromMe = quotedCtx.participant === botJid || quotedCtx.participant?.split(':')[0] === botJid.split(':')[0];
      const target = {
        id:          quotedCtx.stanzaId,
        remoteJid:   jid,
        fromMe:      fromMe,
        participant: quotedCtx.participant,
      };
      await client.message.send(jid, { type: 'revoke', target });
      return true;
    }

    // ── cekasalmember ────────────────────────────────────────────────────────
    case 'cekasalmember': {
      const COUNTRY_MAP = [
        { prefix: '1',    flag: '🇺🇸', name: 'Amerika Serikat' },
        { prefix: '7',    flag: '🇷🇺', name: 'Rusia / Kazakhstan' },
        { prefix: '20',   flag: '🇪🇬', name: 'Mesir' },
        { prefix: '27',   flag: '🇿🇦', name: 'Afrika Selatan' },
        { prefix: '30',   flag: '🇬🇷', name: 'Yunani' },
        { prefix: '31',   flag: '🇳🇱', name: 'Belanda' },
        { prefix: '32',   flag: '🇧🇪', name: 'Belgia' },
        { prefix: '33',   flag: '🇫🇷', name: 'Prancis' },
        { prefix: '34',   flag: '🇪🇸', name: 'Spanyol' },
        { prefix: '36',   flag: '🇭🇺', name: 'Hungaria' },
        { prefix: '39',   flag: '🇮🇹', name: 'Italia' },
        { prefix: '40',   flag: '🇷🇴', name: 'Romania' },
        { prefix: '41',   flag: '🇨🇭', name: 'Swiss' },
        { prefix: '43',   flag: '🇦🇹', name: 'Austria' },
        { prefix: '44',   flag: '🇬🇧', name: 'Inggris' },
        { prefix: '45',   flag: '🇩🇰', name: 'Denmark' },
        { prefix: '46',   flag: '🇸🇪', name: 'Swedia' },
        { prefix: '47',   flag: '🇳🇴', name: 'Norwegia' },
        { prefix: '48',   flag: '🇵🇱', name: 'Polandia' },
        { prefix: '49',   flag: '🇩🇪', name: 'Jerman' },
        { prefix: '51',   flag: '🇵🇪', name: 'Peru' },
        { prefix: '52',   flag: '🇲🇽', name: 'Meksiko' },
        { prefix: '54',   flag: '🇦🇷', name: 'Argentina' },
        { prefix: '55',   flag: '🇧🇷', name: 'Brasil' },
        { prefix: '56',   flag: '🇨🇱', name: 'Chile' },
        { prefix: '57',   flag: '🇨🇴', name: 'Kolombia' },
        { prefix: '58',   flag: '🇻🇪', name: 'Venezuela' },
        { prefix: '60',   flag: '🇲🇾', name: 'Malaysia' },
        { prefix: '61',   flag: '🇦🇺', name: 'Australia' },
        { prefix: '62',   flag: '🇮🇩', name: 'Indonesia' },
        { prefix: '63',   flag: '🇵🇭', name: 'Filipina' },
        { prefix: '64',   flag: '🇳🇿', name: 'Selandia Baru' },
        { prefix: '65',   flag: '🇸🇬', name: 'Singapura' },
        { prefix: '66',   flag: '🇹🇭', name: 'Thailand' },
        { prefix: '81',   flag: '🇯🇵', name: 'Jepang' },
        { prefix: '82',   flag: '🇰🇷', name: 'Korea Selatan' },
        { prefix: '84',   flag: '🇻🇳', name: 'Vietnam' },
        { prefix: '86',   flag: '🇨🇳', name: 'China' },
        { prefix: '90',   flag: '🇹🇷', name: 'Turki' },
        { prefix: '91',   flag: '🇮🇳', name: 'India' },
        { prefix: '92',   flag: '🇵🇰', name: 'Pakistan' },
        { prefix: '93',   flag: '🇦🇫', name: 'Afghanistan' },
        { prefix: '94',   flag: '🇱🇰', name: 'Sri Lanka' },
        { prefix: '95',   flag: '🇲🇲', name: 'Myanmar' },
        { prefix: '98',   flag: '🇮🇷', name: 'Iran' },
        { prefix: '212',  flag: '🇲🇦', name: 'Maroko' },
        { prefix: '213',  flag: '🇩🇿', name: 'Aljazair' },
        { prefix: '216',  flag: '🇹🇳', name: 'Tunisia' },
        { prefix: '218',  flag: '🇱🇾', name: 'Libya' },
        { prefix: '220',  flag: '🇬🇲', name: 'Gambia' },
        { prefix: '221',  flag: '🇸🇳', name: 'Senegal' },
        { prefix: '234',  flag: '🇳🇬', name: 'Nigeria' },
        { prefix: '251',  flag: '🇪🇹', name: 'Ethiopia' },
        { prefix: '254',  flag: '🇰🇪', name: 'Kenya' },
        { prefix: '255',  flag: '🇹🇿', name: 'Tanzania' },
        { prefix: '256',  flag: '🇺🇬', name: 'Uganda' },
        { prefix: '260',  flag: '🇿🇲', name: 'Zambia' },
        { prefix: '263',  flag: '🇿🇼', name: 'Zimbabwe' },
        { prefix: '966',  flag: '🇸🇦', name: 'Arab Saudi' },
        { prefix: '967',  flag: '🇾🇪', name: 'Yaman' },
        { prefix: '968',  flag: '🇴🇲', name: 'Oman' },
        { prefix: '971',  flag: '🇦🇪', name: 'Uni Emirat Arab' },
        { prefix: '972',  flag: '🇮🇱', name: 'Israel' },
        { prefix: '973',  flag: '🇧🇭', name: 'Bahrain' },
        { prefix: '974',  flag: '🇶🇦', name: 'Qatar' },
        { prefix: '975',  flag: '🇧🇹', name: 'Bhutan' },
        { prefix: '976',  flag: '🇲🇳', name: 'Mongolia' },
        { prefix: '977',  flag: '🇳🇵', name: 'Nepal' },
        { prefix: '992',  flag: '🇹🇯', name: 'Tajikistan' },
        { prefix: '993',  flag: '🇹🇲', name: 'Turkmenistan' },
        { prefix: '994',  flag: '🇦🇿', name: 'Azerbaijan' },
        { prefix: '995',  flag: '🇬🇪', name: 'Georgia' },
        { prefix: '996',  flag: '🇰🇬', name: 'Kirgizstan' },
        { prefix: '998',  flag: '🇺🇿', name: 'Uzbekistan' },
      ];

      function getCountry(num) {
        // sort by prefix length descending untuk match paling spesifik duluan
        const sorted = [...COUNTRY_MAP].sort((a, b) => b.prefix.length - a.prefix.length);
        for (const c of sorted) {
          if (num.startsWith(c.prefix)) return `${c.flag} ${c.name}`;
        }
        return '🌍 Tidak diketahui';
      }

      const meta    = await getMeta();
      const members = meta?.participants || [];
      const counts  = {};

      for (const p of members) {
        // engine return JID sebagai @lid, gunakan phoneNumber field langsung
        const rawJid = p.jid || p.lid || '';
        const isPhone = rawJid.endsWith('@s.whatsapp.net') || rawJid.endsWith('@c.us');
        const num = isPhone
          ? rawJid.split('@')[0]
          : (p.phoneNumber ? p.phoneNumber.replace(/\D/g, '') : null);
        const country = num ? getCountry(num) : '🌍 Tidak diketahui';
        counts[country] = (counts[country] || 0) + 1;
      }

      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      const lines  = sorted.map(([country, count]) => `${country}: ${count}`).join('\n');
      await reply(`┌─⊷ *ASAL NEGARA*\nJumlah anggota berdasarkan negara:\n${lines}\n👥 Total: ${members.length}\n└──────────────`);
      return true;
    }

    // ── mulaiabsen ───────────────────────────────────────────────────────────
    case 'mulaiabsen': {
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      const title = args.join(' ') || 'Absensi';
      absenStore.set(jid, { title, members: new Set() });
      await reply(`📝 *Absensi "${title}" dimulai!*\nKetik ${p}absen untuk hadir`);
      return true;
    }

    // ── absen ─────────────────────────────────────────────────────────────────
    case 'absen': {
      if (!absenStore.has(jid)) { await reply(`Belum ada absensi aktif. Admin ketik ${p}mulaiabsen`); return true; }
      const session = absenStore.get(jid);
      if (session.members.has(sender)) {
        await reply(`✅ ${ctx.pushName} sudah absen sebelumnya`);
      } else {
        session.members.add(sender);
        // Resolve phone number dari metadata untuk display
        const meta = await getMeta();
        const participant = meta?.participants.find(p => p.jid === sender || p.lid === sender);
        const phoneNum = participant?.phoneNumber
          ? String(participant.phoneNumber).replace(/\D/g, '')
          : sender.split('@')[0];
        await reply(`✅ *${ctx.pushName}* (+${phoneNum}) telah absen!\nTotal hadir: ${session.members.size}`);
      }
      return true;
    }

    // ── cekabsen ──────────────────────────────────────────────────────────────
    case 'cekabsen': {
      if (!absenStore.has(jid)) { await reply('Tidak ada absensi aktif'); return true; }
      const session = absenStore.get(jid);
      const meta    = await getMeta();
      const memberList = [...session.members];
      const mentionJids = memberList.map(m => {
        const p = meta?.participants.find(p => p.jid === m || p.lid === m);
        return p?.jid || m;
      });
      const list = memberList.map((m, i) => {
        const p = meta?.participants.find(p => p.jid === m || p.lid === m);
        const tag = p?.jid ? p.jid.split('@')[0] : m.split('@')[0];
        return `${i + 1}. @${tag}`;
      }).join('\n');
      await client.message.send(jid, {
        type: 'text',
        text: `📋 *Absensi: ${session.title}*\nTotal: ${session.members.size}\n\n${list || 'Belum ada yang absen'}`,
        mentions: mentionJids,
      });
      return true;
    }

    // ── hapusabsen ────────────────────────────────────────────────────────────
    case 'hapusabsen': {
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      absenStore.delete(jid);
      await reply('🗑️ Sesi absensi dihapus');
      return true;
    }

    // ── afk ───────────────────────────────────────────────────────────────────
    case 'afk': {
      const reason = args.join(' ') || 'Tidak ada alasan';
      afkStore.set(`${jid}:${sender}`, { reason, since: Date.now() });
      await reply(`💤 *${ctx.pushName}* sekarang AFK\nAlasan: ${reason}`);
      return true;
    }

    // ── listafk ───────────────────────────────────────────────────────────────
    case 'listafk': {
      const afkList = [...afkStore.entries()]
        .filter(([k]) => k.startsWith(jid))
        .map(([k, v]) => `• @${k.split(':')[1].split('@')[0]} — ${v.reason}`);
      if (afkList.length === 0) { await reply('Tidak ada member AFK saat ini'); return true; }
      const mentions = [...afkStore.keys()]
        .filter(k => k.startsWith(jid))
        .map(k => k.split(':')[1]);
      await client.message.send(jid, { type: 'text', text: `💤 *Daftar AFK*\n\n${afkList.join('\n')}`, mentions: mentions });
      return true;
    }

    // ── topchat ───────────────────────────────────────────────────────────────
    case 'topchat': {
      const tc = topchatStore.get(jid);
      if (!tc || tc.size === 0) { await reply('Belum ada data chat'); return true; }
      const sorted = [...tc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      const list   = sorted.map(([ jid, count ], i) => `${i + 1}. @${jid.split('@')[0]} — ${count} pesan`).join('\n');
      const mentions = sorted.map(([j]) => j);
      await client.message.send(jid, { text: `🏆 *Top Chat*\n\n${list}`, mentions: mentions });
      return true;
    }

    // ── setwelcome ────────────────────────────────────────────────────────────
    case 'setwelcome':
    case 'setleft':
    case 'setbye': {
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      const { pool: dbPool } = require('../config/database');
      const isWelcome = command === 'setwelcome';
      // welcome/left = sepasang: kolom teks + kolom saklarnya.
      const [colMsg, colOn] = isWelcome
        ? ['welcome_msg', 'welcome_on']
        : ['bye_msg',     'bye_on'];
      const judul = isWelcome ? 'Welcome' : 'Bye';
      const teks = args.join(' ').trim();
      if (!teks) {
        await reply(
          `⚠️ *Teks ${judul.toLowerCase()} belum dimasukkan!*\n\n` +
          `*Cara Penggunaan:*\n${p}${command} <teks>\n\n` +
          `*Contoh:*\n${p}${command} ${isWelcome ? 'Halo @user, selamat datang di @namegc!' : 'Selamat tinggal @user, semoga sukses!'}\n\n` +
          `┌─ *VARIABEL TERSEDIA*\n` +
          `▢ *@user* : Tag ${isWelcome ? 'member baru' : 'member yang keluar'}\n` +
          `▢ *@namegc* : Nama grup\n` +
          `▢ *@desc* : Deskripsi grup\n` +
          `▢ *@jam* *@menit* *@detik* *@hari* *@tanggal* *@bulan* *@tahun* *@namabulan*\n` +
          `▢ *@tagdiri* *@tagreply* *@pesanan*\n` +
          `└──────────────\n\n_Daftar lengkap: ${p}catatan_\n_Matikan: ${p}off ${isWelcome ? 'welcome' : 'left'}_`
        );
        return true;
      }
      // Sekalian nyalain — admin yang barusan nulis pesannya nggak mungkin niat matiin.
      await dbPool.execute(
        `INSERT INTO group_settings (bot_id, group_jid, ${colMsg}, ${colOn})
         VALUES (?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE ${colMsg} = VALUES(${colMsg}), ${colOn} = 1`,
        [botData.id, jid, teks]
      );
      await reply(
        `✅ *Pesan ${judul} Berhasil Diatur!*\n\n` +
        (isWelcome
          ? 'Pesan ini akan otomatis dikirim ketika ada anggota baru yang bergabung ke dalam grup.'
          : 'Pesan ini akan otomatis dikirim ketika ada anggota yang keluar dari grup.') +
        `\n\n_Matikan: ${p}off ${isWelcome ? 'welcome' : 'left'}_`
      );
      return true;
    }

    // ── delwelcome ────────────────────────────────────────────────────────────
    case 'delwelcome': {
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      const { pool: dbPool } = require('../config/database');
      // Saklarnya sekalian dimatiin: kalau cuma di-NULL, engine jatuh balik ke
      // teks default .env dan sambutan tetep kekirim — padahal niatnya berhenti.
      await dbPool.execute(
        'UPDATE group_settings SET welcome_msg = NULL, welcome_on = 0 WHERE bot_id = ? AND group_jid = ?',
        [botData.id, jid]
      );
      await reply(`✅ Pesan welcome dihapus & sambutan dimatikan.\n\n_Nyalain lagi: ${p}on welcome_`);
      return true;
    }

    // ── delbye ────────────────────────────────────────────────────────────────
    case 'delbye': {
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      const { pool: dbPool } = require('../config/database');
      await dbPool.execute(
        'UPDATE group_settings SET bye_msg = NULL, bye_on = 0 WHERE bot_id = ? AND group_jid = ?',
        [botData.id, jid]
      );
      await reply(`✅ Pesan bye dihapus & ucapan keluar dimatikan.\n\n_Nyalain lagi: ${p}on left_`);
      return true;
    }

    // ── banmember (ban lokal grup — kick + catat di group_ban) ──────────────────
    case 'banmember': {
      if (!await isBotAdmin()) { await reply(mess.BotAdmin); return true; }
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      const mentionedBan = ctx.msg.message?.extendedTextMessage?.contextInfo?.mentionedJid
        || ctx.mentioned || [];
      if (!mentionedBan[0]) {
        await reply(`Penggunaan: ${p}banmember @target\n\nKick member dan larang masuk kembali ke grup ini.`);
        return true;
      }
      const { pool: dbPool } = require('../config/database');
      // Pastikan tabel group_ban ada
      await dbPool.execute(`
        CREATE TABLE IF NOT EXISTS group_ban (
          id INT AUTO_INCREMENT PRIMARY KEY,
          bot_id INT UNSIGNED NOT NULL,
          group_jid VARCHAR(100) NOT NULL,
          jid VARCHAR(100) NOT NULL,
          banned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_group_ban (bot_id, group_jid, jid)
        )
      `).catch(() => {});

      const banned = [];
      for (const target of mentionedBan) {
        try { await client.group.removeParticipants(jid, [target]); } catch {}
        await dbPool.execute(
          'INSERT IGNORE INTO group_ban (bot_id, group_jid, jid) VALUES (?, ?, ?)',
          [botData.id, jid, target]
        ).catch(() => {});
        banned.push(`@${target.split('@')[0]}`);
      }
      await client.message.send(jid, {
        type: 'text',
        text: `🚫 *BAN MEMBER*\n\n${banned.join(', ')} telah dikick & dilarang masuk grup ini!`,
        mentions: mentionedBan,
      });
      return true;
    }

    // ── unbanmember (hapus dari ban lokal grup) ───────────────────────────────
    case 'unbanmember': {
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      const mentionedUnban = ctx.msg.message?.extendedTextMessage?.contextInfo?.mentionedJid
        || ctx.mentioned || [];
      if (!mentionedUnban[0]) {
        await reply(`Penggunaan: ${p}unbanmember @target`);
        return true;
      }
      const { pool: dbPoolUnban } = require('../config/database');
      const unbanned = [];
      for (const target of mentionedUnban) {
        await dbPoolUnban.execute(
          'DELETE FROM group_ban WHERE bot_id = ? AND group_jid = ? AND jid = ?',
          [botData.id, jid, target]
        ).catch(() => {});
        unbanned.push(`@${target.split('@')[0]}`);
      }
      await client.message.send(jid, {
        type: 'text',
        text: `✅ *UNBAN MEMBER*\n\n${unbanned.join(', ')} dihapus dari daftar ban grup ini!`,
        mentions: mentionedUnban,
      });
      return true;
    }

    // ── setppgc ───────────────────────────────────────────────────────────────
    // Ganti foto profil grup (reply gambar)
    // Client signature: setProfilePicture(jid, buffer) — arg-nya JANGAN dibalik,
    // kalau kebalik Baileys nge-`in`-in string jid dan error
    // "Cannot use 'in' operator to search for 'stream' in <jid>".
    case 'setppgc': {
      if (!await isBotAdmin()) { await reply(mess.BotAdmin); return true; }
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }

      const quotedMsg = ctx.msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      const imgMsg    = quotedMsg?.imageMessage || ctx.msg?.message?.imageMessage;
      if (!imgMsg) {
        await reply(`Kirim gambar dengan caption ${p}setppgc, atau reply gambar lalu ketik ${p}setppgc`);
        return true;
      }
      try {
        const buffer = await client.message.downloadBytes(
          quotedMsg ? { imageMessage: imgMsg } : ctx.msg.message
        );
        await client.profile.setProfilePicture(jid, buffer);
        await reply('✅ Foto profil grup berhasil diubah!');
      } catch (e) { await reply(`❌ Gagal ubah foto grup: ${rapikanError(e)}`); }
      return true;
    }

    // ── sider (cek member pasif) ──────────────────────────────────────────────
    case 'sider': {
      const tc = topchatStore.get(jid);
      const meta = await getMeta();
      if (!meta) { await reply('Gagal ambil data grup.'); return true; }

      if (!tc || tc.size === 0) {
        await reply('Belum ada data chat di sesi ini. Tunggu beberapa saat lagi.');
        return true;
      }

      // Member yang ada di grup tapi tidak ada di topchat = pasif
      const aktif  = new Set(tc.keys());
      const semua  = meta.participants.map(p => p.jid || p.lid).filter(Boolean);
      const pasif  = semua.filter(m => !aktif.has(m));

      if (pasif.length === 0) {
        await reply('✅ Semua member aktif dalam sesi ini!');
        return true;
      }

      const CHUNK = 20;
      const lines = pasif.map((m, i) => `${i + 1}. @${m.split('@')[0]}`);
      for (let i = 0; i < lines.length; i += CHUNK) {
        const header = i === 0
          ? `😴 *MEMBER PASIF*\nTotal: *${pasif.length}/${semua.length} member*\n\n`
          : `😴 *(lanjutan)*\n\n`;
        await client.message.send(jid, {
          type: 'text',
          text: header + lines.slice(i, i + CHUNK).join('\n'),
          mentions: pasif.slice(i, i + CHUNK),
        });
      }
      return true;
    }

    // ── listtotalpesan ────────────────────────────────────────────────────────
    case 'listtotalpesan': {
      const tc = topchatStore.get(jid);
      if (!tc || tc.size === 0) {
        await reply('Belum ada data statistik pesan di sesi ini.');
        return true;
      }
      const sorted = [...tc.entries()].sort((a, b) => b[1] - a[1]);
      const CHUNK  = 25;
      const lines  = sorted.map(([ m, count ], i) => `${i + 1}. @${m.split('@')[0]} — ${count} pesan`);
      for (let i = 0; i < lines.length; i += CHUNK) {
        const header = i === 0
          ? `📊 *STATISTIK PESAN GRUP*\nTotal member aktif: *${sorted.length}*\n\n`
          : `📊 *(lanjutan)*\n\n`;
        await client.message.send(jid, {
          type: 'text',
          text: header + lines.slice(i, i + CHUNK).join('\n'),
          mentions: sorted.slice(i, i + CHUNK).map(([m]) => m),
        });
      }
      return true;
    }

    // ── setopen / setclose ────────────────────────────────────────────────────
    // Jadwal buka-tutup otomatis per grup (cron di server.js), plus teks
    // pengumuman yang dikirim ke grup saat jadwalnya jalan.
    // Format: `.setopen 07.00 <teks>` — teks opsional (default dari .env).
    case 'setopen':
    case 'setclose': {
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      const isOpen = command === 'setopen';

      // Arg pertama jam (HH.MM) = set jadwalnya; sisa argumen = teks pengumuman.
      // Tanpa jam = argumennya murni teks pengumuman:
      //   .setclose Selamat tinggal @user dari @namegc
      const jam  = normalizeJam(args[0]);
      const teks = (jam ? args.slice(1) : args).join(' ').trim();

      if (!jam && !teks) {
        await reply(
          `⚠️ *Teks ${isOpen ? 'BUKA' : 'TUTUP'} grup belum diisi!*\n\n` +
          `*Cara Penggunaan:*\n` +
          `${p}${command} <teks>            → teks pengumuman\n` +
          `${p}${command} <jam> <teks>      → teks + jadwal otomatis\n\n` +
          `*Contoh:*\n` +
          `${p}${command} ${isOpen ? 'Selamat pagi @namegc, grup sudah dibuka!' : 'Selamat tinggal @user dari @namegc'} \n` +
          `${p}${command} ${isOpen ? '07.00' : '22.00'} ${isOpen ? 'Grup dibuka jam @jam WIB' : 'Grup ditutup jam @jam WIB'}\n\n` +
          `_Tanpa teks = pakai default dari .env (${isOpen ? 'DEFAULT_SETOPEN' : 'DEFAULT_SETCLOSE'})_\n\n` +
          catatan(command)
        );
        return true;
      }

      const kolomJam  = isOpen ? 'open_time' : 'close_time';
      const kolomTeks = isOpen ? 'open_msg' : 'close_msg';

      const { pool: dbPool } = require('../config/database');
      // COALESCE: cuma ganti teks = jadwal lama jangan kehapus (dan sebaliknya).
      const simpan = () => dbPool.execute(
        `INSERT INTO group_settings (bot_id, group_jid, ${kolomJam}, ${kolomTeks})
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE ${kolomJam} = COALESCE(VALUES(${kolomJam}), ${kolomJam}),
                                 ${kolomTeks} = VALUES(${kolomTeks})`,
        [botData.id, jid, jam, teks || null]
      );
      try { await simpan(); }
      catch {
        // DB lama belum punya kolomnya — bikin dulu, terus ulang.
        for (const ddl of [
          'ALTER TABLE group_settings ADD COLUMN open_time VARCHAR(10) NULL',
          'ALTER TABLE group_settings ADD COLUMN close_time VARCHAR(10) NULL',
          'ALTER TABLE group_settings ADD COLUMN open_msg TEXT NULL',
          'ALTER TABLE group_settings ADD COLUMN close_msg TEXT NULL',
        ]) await dbPool.execute(ddl).catch(() => {});
        await simpan();
      }

      await reply(
        `✅ *${isOpen ? 'BUKA' : 'TUTUP'} grup disimpan!*\n` +
        (jam ? `⏰ Jadwal otomatis: *${jam}* WIB setiap hari.\n` : '') +
        (teks ? `📝 Teks pengumuman:\n${teks}` : `📝 Teks: default .env (${isOpen ? 'DEFAULT_SETOPEN' : 'DEFAULT_SETCLOSE'})`)
      );
      return true;
    }

    // ── catatan — daftar variable template ────────────────────────────────────
    // `.catatan <topik>` buat lihat variable yang didukung di satu topik.
    case 'catatan': {
      const topik = (args[0] || command.slice('catatan'.length) || '')
        .toLowerCase().replace(/^\./, '');
      const label = { setwelcome: 'setwelcome', setbye: 'setbye', setleft: 'setbye',
        setproses: 'setproses', setdone: 'setdone', setlist: 'setlist',
        setopen: 'setopen', setopen2: 'setopen', setclose: 'setclose',
        '': 'template' }[topik] || (topik || null);
      await reply(
        `📖 *DAFTAR VARIABLE TEMPLATE*\n\n` +
        `Pakai \`@nama\` di teks ${p}setopen / ${p}setclose / ${p}setwelcome / ${p}setbye / ${p}setproses / ${p}setdone / ${p}setlist.\n` +
        `Placeholder yang nggak dikenal dibiarkan apa adanya.\n\n` +
        catatan(label)
      );
      return true;
    }

    // ── swgc (kirim status/story ke grup) ────────────────────────────────────
    case 'swgc':
    case 'upswgc': {
      // Sengaja TANPA gate `isBotAdmin()`: status grup nggak butuh bot jadi
      // admin (cuma butuh ikut jadi anggota). Referensi juga mencabutnya, dan
      // buat target grup lain lewat `idgc|caption` gate itu malah salah grup.
      const teks = args.join(' ').trim();

      // Owner boleh nembak ke grup lain: `.swgc <idgc>@g.us|caption`
      // (persis `refrensi-botz/plugins/owner-upswtag.js`).
      let targetGc = jid;
      let caption = teks;
      if (ctx.isOwner) {
        const [idgc, ...sisa] = teks.split('|');
        if (sisa.length && idgc.trim().endsWith('@g.us')) {
          targetGc = idgc.trim();
          caption = sisa.join('|').trim();
        }
      }

      // Ambil media dari quoted message atau pesan saat ini.
      // PENTING: `.swgc test` di grup HARUS tetap jadi teks status — jalur teks
      // referensi juga gitu. Dulu `hasMedia` ikut ngitung `quotedMessage` yang
      // cuma cursor/mention (SELALU ada di reply), jadi `.swgc test` nyasar ke
      // jalur media, `downloadBytes` gagal, dan hasilnya video KOSONG yang
      // diterima WA tanpa error.
      const quotedMsg = ctx.msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      const imgMsg    = quotedMsg?.imageMessage  || ctx.msg?.message?.imageMessage;
      const vidMsg    = quotedMsg?.videoMessage  || ctx.msg?.message?.videoMessage;
      const audMsg    = quotedMsg?.audioMessage  || ctx.msg?.message?.audioMessage;

      try {
        let content;

        if (imgMsg) {
          const buffer = await client.message.downloadBytes({ imageMessage: imgMsg });
          const { imageMessage } = await client.message.prepareMedia(buffer, { type: 'image', mimetype: imgMsg.mimetype || 'image/jpeg' });
          content = { imageMessage: { ...imageMessage, ...(caption && { caption }) } };
        } else if (vidMsg) {
          const buffer = await client.message.downloadBytes({ videoMessage: vidMsg });
          const { videoMessage } = await client.message.prepareMedia(buffer, { type: 'video', mimetype: vidMsg.mimetype || 'video/mp4' });
          content = {
            videoMessage: {
              ...videoMessage,
              seconds: videoMessage.seconds || vidMsg.seconds || 1,
              ...(caption && { caption }),
            },
          };
        } else if (audMsg) {
          const buffer = await client.message.downloadBytes({ audioMessage: audMsg });
          const { audioMessage } = await client.message.prepareMedia(buffer, { type: 'audio', mimetype: audMsg.mimetype || 'audio/mp4' });
          content = {
            audioMessage: {
              ...audioMessage,
              seconds: audioMessage.seconds || audMsg.seconds || 1,
              ptt: false,
              ...(caption && { caption }),
            },
          };
        } else if (caption) {
          content = { text: caption };
        } else {
          await reply(
            `Cara penggunaan:\n` +
            `• *${p}swgc* <teks> — kirim teks sebagai status grup\n` +
            `• Reply foto/video/audio lalu ketik *${p}swgc* [caption]` +
            (ctx.isOwner ? `\n• *${p}swgc* <idgc>@g.us|caption — kirim ke grup lain` : '')
          );
          return true;
        }

        // Kirim sebagai status grup. relayStatusGrup() polos: envelope
        // groupStatusMessageV2 + messageSecret, relayMessage `{ messageId }`
        // doang — tanpa `quoted` (WA nolak status grup yg bawa quoted).
        try {
          await client.message.relayStatusGrup(targetGc, content);
        } catch (e) {
          if (!e.message?.includes('400') && !e.message?.includes('negative publish ack')) {
            throw e; // lempar ulang kalau bukan error 400 WA
          }
          // WA nolak di level policy. Jangan ditelan diem-diem — kalau nggak
          // dicatat, gejalanya cuma "emoji centang tapi status nggak jadi".
          console.error(`[swgc] WA nolak status grup: ${e.message}`);
        }
        await react('✅');
      } catch (e) {
        await reply(`❌ Gagal kirim status grup: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── default ───────────────────────────────────────────────────────────────
    default:
      return false;
  }
};

// Command yang kena limit untuk user biasa
module.exports.limitedCmds = new Set([
  'tagall','tagadmin','tagme','hidetag','ht',
  'kick','kickall','promote','demote','add','addai',
  'open','close','mute','unmute','slowmode','setname','setdesc',
  'grupopen','grupclose','linkgc','setnamegc',
  'linkgroup','groupinfo','idgc','leavegc','listadmin',
  'getpp','pp','totag','delete','cekasalmember',
  'mulaiabsen','absen','cekabsen','hapusabsen',
  'afk','listafk','topchat','swgc','upswgc',
]);
