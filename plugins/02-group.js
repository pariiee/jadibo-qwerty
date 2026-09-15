'use strict';

/**
 * plugins/02-group.js
 * Commands: tagall, tagadmin, tagme, hidetag, kick, kickall, promote, demote,
 *           open, close, mute, unmute, slowmode, setname, setdesc, linkgroup,
 *           groupinfo, idgc, grouplist, leavegc, listadmin, getpp, getppgc, totag,
 *           delete, cekasalmember, absen, mulaiabsen, cekabsen, hapusabsen,
 *           afk, listafk, topchat
 */

const mess             = require('../config/mess');
const { lidToPnAsync }   = require('../engine/jid');
const { genThumbnail } = require('../engine/thumbnail');
const { catatan } = require('../engine/template');

// In-memory stores (replace with DB for persistence across restarts)
const absenStore      = new Map(); // groupJid -> { title, members: Set<jid> }
const afkStore        = new Map(); // jid -> { reason, since }
const topchatStore    = new Map(); // groupJid -> Map<jid, count>
const msgStore        = new Map(); // remoteJid|id -> event (untuk antidelete)

const fs   = require('fs');
const path = require('path');

// Baca antidelete status dari proteksi-settings.json (shared dengan 06-proteksi.js)
const PROTEKSI_FILE = path.join(__dirname, '..', 'sessions', 'proteksi-settings.json');
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
        console.log(`[Antidelete] delete event jid=${ctx.jid} active=${isAntideleteActive(ctx.jid)} storeKey=${storeKey} stored=${msgStore.has(storeKey)} msgStoreSize=${msgStore.size}`);
        if (isAntideleteActive(ctx.jid)) {
          const stored     = msgStore.get(storeKey);
          console.log(`[Antidelete] stored keys: ${stored ? JSON.stringify(Object.keys(stored)) : 'null'}, storedMsg keys: ${stored?.message ? JSON.stringify(Object.keys(stored.message)) : 'null'}, deletedKey: ${JSON.stringify(deletedKey)}`);
          if (stored) {
            const storedType    = Object.keys(stored.message)[0];
            const storedContent = stored.message[storedType];
            // Resolve siapa yang hapus pesan (participant di delete event, fallback ke stored sender)
            const deleterJid = rawMsg.key?.participant || rawMsg.key?.remoteJid || '';
            const deleterPhone = deleterJid.split('@')[0];
            try {
              const headerText = `🛡️ *Anti-Delete*\n@${deleterPhone} ngapain di hapus bang 😹`;
              if (storedType === 'stickerMessage') {
                // Stiker: kirim stikernya dulu, lalu teks mention terpisah
                const fixed = Object.assign({}, storedContent);
                for (const f of ['mediaKey','fileSha256','fileEncSha256']) {
                  if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
                }
                const buffer = await ctx.client.message.downloadBytes({ stickerMessage: fixed });
                await ctx.client.message.send(ctx.jid, {
                  type: 'sticker', media: buffer, mimetype: storedContent.mimetype || 'image/webp',
                });
                await ctx.client.message.send(ctx.jid, {
                  type: 'text',
                  text: headerText,
                  mentions: [deleterJid],
                });
              } else if (['imageMessage','videoMessage','audioMessage'].includes(storedType)) {
                const uploadType = storedType === 'imageMessage' ? 'image'
                  : storedType === 'videoMessage' ? 'video'
                  : (storedContent.ptt ? 'ptt' : 'audio');
                const fixed = Object.assign({}, storedContent);
                for (const f of ['mediaKey','fileSha256','fileEncSha256']) {
                  if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
                }
                const buffer = await ctx.client.message.downloadBytes({ [storedType]: fixed });
                const mime   = storedContent.mimetype || 'application/octet-stream';
                // Caption: hanya tampilkan caption asli kalau ada
                const extraCaption = storedContent.caption ? `\n\n${storedContent.caption}` : '';
                await ctx.client.message.send(ctx.jid, {
                  type: uploadType, media: buffer, mimetype: mime,
                  caption: `${headerText}${extraCaption}`,
                  mentions: [deleterJid],
                });
              } else {
                const text = storedContent?.text || storedContent?.caption || storedContent || '';
                await ctx.client.message.send(ctx.jid, {
                  type: 'text',
                  text: `${headerText}\n\n${text}`,
                  mentions: [deleterJid],
                });
              }
            } catch (e) { console.log(`[Antidelete] gagal kirim ulang: ${e.message}`) }
          }
        }
        return false;
      }

      // ── Store pesan untuk antidelete ─────────────────────────────────────────
      if (rawMsg?.key && rawMsg?.message && msgType !== 'protocolMessage') {
        const storeKey = `${rawMsg.key.remoteJid}|${rawMsg.key.id}`;
        msgStore.set(storeKey, rawMsg);
        // Batasi ukuran store agar tidak bocor memory
        if (msgStore.size > 5000) {
          const firstKey = msgStore.keys().next().value;
          msgStore.delete(firstKey);
        }
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
        await reply(`❌ Gagal kick: ${e.message}`);
      }
      return true;
    }

    // ── add (tambah member via nomor) ────────────────────────────────────────
    case 'add': {
      if (!await isBotAdmin()) { await reply(mess.BotAdmin); return true; }
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      const numArg = args[0];
      if (!numArg) {
        await reply(`Penggunaan: ${p}add <nomor>\n\nContoh: ${p}add 6281234567890`);
        return true;
      }
      // Normalisasi nomor: hapus +, spasi, dash
      const normalized = numArg.replace(/[^0-9]/g, '');
      const targetJid  = `${normalized}@s.whatsapp.net`;
      try {
        const results = await client.group.addParticipants(jid, [targetJid]);
        // client adapter return array hasil per-jid: { jid, status: 'ok'|'error', code }
        const res = (Array.isArray(results) ? results : [])[0];
        if (!res) {
          await reply(`⚠️ Tidak ada respon dari WhatsApp saat menambahkan *${normalized}*. Pastikan bot admin grup.`);
        } else if (res.status === 'ok') {
          await reply(`✅ Berhasil menambahkan *${normalized}* ke grup!`);
        } else {
          const reason = {
            403: 'nomor ini belum pernah chat bot / privasi nomor, coba minta dia chat bot dulu',
            404: 'nomor tidak terdaftar di WhatsApp',
            408: 'timeout, coba lagi',
            409: 'sudah menjadi member grup',
            429: 'kecepatan ditahan WhatsApp, coba beberapa menit lagi',
          }[res.code] || `kode error ${res.code}`;
          await reply(`❌ Gagal menambahkan *${normalized}*\nAlasan: ${reason}`);
        }
      } catch (e) {
        await reply(`❌ Gagal menambahkan *${normalized}*\nAlasan: ${e.message}`);
      }
      return true;
    }

    // ── promoteme (hanya ADMIN yang bisa promote member lain — bukan diri sendiri) ──
    case 'promoteme': {
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      const target = (ctx.msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [])[0]
        || ctx.msg.message?.extendedTextMessage?.contextInfo?.participant
        || null;
      if (!target) { await reply(`Penggunaan: ${p}promoteme @mention atau reply pesan member`); return true; }
      if (target === sender) { await reply('Kamu nggak bisa promote diri sendiri.'); return true; }
      try {
        await client.group.promoteParticipants(jid, [target]);
        await client.message.send(jid, {
          type: 'text',
          text: `👑 @${target.split('@')[0]} telah dipromote menjadi admin!`,
          mentions: [target],
        });
      } catch (e) {
        await reply(`❌ Gagal promote: ${e.message}`);
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
        await reply(`❌ Gagal kickall: ${e.message}`);
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

    // ── open / close ─────────────────────────────────────────────────────────
    case 'open': {
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      if (!await isBotAdmin()) { await reply(mess.BotAdmin); return true; }
      await client.group.setSetting(jid, 'announcement', false);
      await reply('🔓 Grup dibuka — semua member bisa kirim pesan');
      return true;
    }
    case 'close': {
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      if (!await isBotAdmin()) { await reply(mess.BotAdmin); return true; }
      await client.group.setSetting(jid, 'announcement', true);
      await reply('🔒 Grup ditutup — hanya admin yang bisa kirim pesan');
      return true;
    }

    // ── mute / unmute ─────────────────────────────────────────────────────────
    case 'mute': {
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      if (!await isBotAdmin()) { await reply(mess.BotAdmin); return true; }
      await client.group.setSetting(jid, 'announcement', true);
      await reply('🔇 Grup di-mute');
      return true;
    }
    case 'unmute': {
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      if (!await isBotAdmin()) { await reply(mess.BotAdmin); return true; }
      await client.group.setSetting(jid, 'announcement', false);
      await reply('🔊 Grup di-unmute');
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

    // ── groupinfo ─────────────────────────────────────────────────────────────
    case 'groupinfo': {
      const meta = await getMeta();
      if (!meta) { await reply('Gagal mengambil data grup'); return true; }
      const admins  = meta.participants.filter(p => p.isAdmin).length;
      const members = meta.participants.length;
      await reply(
        `📊 *Info Grup*\n\n` +
        `Nama    : ${meta.subject}\n` +
        `JID     : ${jid}\n` +
        `Member  : ${members}\n` +
        `Admin   : ${admins}\n` +
        `Dibuat  : ${new Date(meta.creation * 1000).toLocaleDateString('id-ID')}`
      );
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

    // ── grouplist ─────────────────────────────────────────────────────────────
    case 'grouplist': {
      try {
        const groups = await client.group.queryAllGroups();
        const metas  = await Promise.all(
          groups.map(g => client.group.queryGroupMetadata(g.jid).catch(() => null))
        );
        const list = groups.map((g, i) => {
          const size = metas[i]?.participants?.length ?? g.size ?? '?';
          return `${i + 1}. ${g.subject}\n   👥 ${size} member`;
        }).join('\n\n');
        await reply(`📋 *Daftar Grup Bot (${groups.length}):*\n\n${list || 'Tidak ada grup'}`);
      } catch (e) {
        console.error('[grouplist] Error:', e.message);
        await reply('Gagal mengambil daftar grup');
      }
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

    // ── getpp ─────────────────────────────────────────────────────────────────
    case 'getpp': {
      // Coba semua path untuk mentionedJid
      const msgContent = ctx.msg.message;
      const mentioned =
        msgContent?.extendedTextMessage?.contextInfo?.mentionedJid ||
        msgContent?.imageMessage?.contextInfo?.mentionedJid ||
        msgContent?.conversation?.contextInfo?.mentionedJid ||
        [];
      console.log('[getpp] mentioned:', JSON.stringify(mentioned));
      if (!mentioned.length) {
        await reply(`Penggunaan: ${p}getpp @mention`);
        return true;
      }
      let target = mentioned[0];
      let phoneNum = target.split('@')[0];

      // Resolve LID ke phone JID lewat metadata grup
      const meta = await getMeta();
      const participant = meta?.participants?.find(p =>
        p.jid === target || p.lid === target
      );
      if (participant?.phoneNumber) {
        phoneNum = String(participant.phoneNumber).split('@')[0];
        target = phoneNum + '@s.whatsapp.net';
      } else if (target.endsWith('@lid') && participant?.jid && !participant.jid.endsWith('@lid')) {
        target = participant.jid;
        phoneNum = target.split('@')[0];
      }

      const DEFAULT_PP = 'https://cdn.pixabay.com/photo/2015/10/05/22/37/blank-profile-picture-973460_960_720.png';
      let ppUrl = DEFAULT_PP;
      try {
        const pp = await client.profile.getProfilePicture(target, 'image');
        if (pp?.url) ppUrl = pp.url;
      } catch {
        try {
          const pp = await client.profile.getProfilePicture(phoneNum + '@s.whatsapp.net', 'image');
          if (pp?.url) ppUrl = pp.url;
        } catch { /* pakai default */ }
      }

      let imgBuffer = null;
      try {
        const res = await fetch(ppUrl);
        const arrBuf = await res.arrayBuffer();
        imgBuffer = Buffer.from(arrBuf);
      } catch { /* fallback teks */ }

      const mentionTag = mentioned[0].split('@')[0]; // pakai LID number untuk mention tag

      if (imgBuffer) {
        const thumb = await genThumbnail(imgBuffer, 'image/jpeg');
        await client.message.send(jid, {
          type: 'image',
          media: imgBuffer,
          mimetype: 'image/jpeg',
          caption: `📸 Foto profil @${mentioned[0].split('@')[0]}`,
          mentions: [mentioned[0]],
          ...(thumb ? { jpegThumbnail: thumb } : {}),
        });
      } else {
        await reply('❌ Foto profil tidak ditemukan atau private');
      }
      return true;
    }

    // ── getppgc ───────────────────────────────────────────────────────────────
    case 'getppgc':
    case 'ppgc':
    case 'ppgroup':
    case 'ppgrup': {
      const DEFAULT_PP_GC = 'https://cdn.pixabay.com/photo/2015/10/05/22/37/blank-profile-picture-973460_960_720.png';
      let ppGcUrl = DEFAULT_PP_GC;
      try {
        const pp = await client.profile.getProfilePicture(jid, 'image');
        if (pp?.url) ppGcUrl = pp.url;
      } catch { /* pakai default */ }

      let gcImgBuffer = null;
      try {
        const res = await fetch(ppGcUrl);
        gcImgBuffer = Buffer.from(await res.arrayBuffer());
      } catch { /* fallback teks */ }

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
    case 'setwelcome': {
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      const { pool: dbPool } = require('../config/database');
      const teks = args.join(' ').trim();
      if (!teks) {
        await reply(
          `⚠️ *Teks welcome belum dimasukkan!*\n\n` +
          `*Cara Penggunaan:*\n${p}setwelcome <teks>\n\n` +
          `*Contoh:*\n${p}setwelcome Halo @user, selamat datang di @subject!\n\n` +
          `┌─ *VARIABEL TERSEDIA*\n` +
          `▢ *@user* / *@usertag* : Tag member baru\n` +
          `▢ *@subject* / *@groupname* / *@namegc* : Nama grup\n` +
          `▢ *@desc* : Deskripsi grup\n` +
          `▢ *@jam* *@menit* *@detik* *@hari* *@tanggal* *@bulan* *@tahun* *@namabulan*\n` +
          `▢ *@tagdiri* *@tagreply* *@pesanan*\n` +
          `└──────────────\n\n_Daftar lengkap: ${p}catatan_`
        );
        return true;
      }
      await dbPool.execute(
        `INSERT INTO group_settings (bot_id, group_jid, welcome_msg)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE welcome_msg = VALUES(welcome_msg)`,
        [botData.id, jid, teks]
      );
      await reply(`✅ *Pesan Welcome Berhasil Diatur!*\n\nPesan ini akan otomatis dikirim ketika ada anggota baru yang bergabung ke dalam grup.`);
      return true;
    }

    // ── setbye ────────────────────────────────────────────────────────────────
    case 'setbye': {
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      const { pool: dbPool } = require('../config/database');
      const teks = args.join(' ').trim();
      if (!teks) {
        await reply(
          `⚠️ *Teks bye belum dimasukkan!*\n\n` +
          `*Cara Penggunaan:*\n${p}setbye <teks>\n\n` +
          `*Contoh:*\n${p}setbye Selamat tinggal @user, semoga sukses!\n\n` +
          `┌─ *VARIABEL TERSEDIA*\n` +
          `▢ *@user* : Tag member yang keluar\n` +
          `└──────────────`
        );
        return true;
      }
      await dbPool.execute(
        `INSERT INTO group_settings (bot_id, group_jid, bye_msg)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE bye_msg = VALUES(bye_msg)`,
        [botData.id, jid, teks]
      );
      await reply(`✅ *Pesan Bye Berhasil Diatur!*\n\nPesan ini akan otomatis dikirim ketika ada anggota yang keluar dari grup.`);
      return true;
    }

    // ── delwelcome ────────────────────────────────────────────────────────────
    case 'delwelcome': {
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      const { pool: dbPool } = require('../config/database');
      await dbPool.execute(
        'UPDATE group_settings SET welcome_msg = NULL WHERE bot_id = ? AND group_jid = ?',
        [botData.id, jid]
      );
      await reply('✅ Pesan welcome berhasil dihapus.');
      return true;
    }

    // ── delbye ────────────────────────────────────────────────────────────────
    case 'delbye': {
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      const { pool: dbPool } = require('../config/database');
      await dbPool.execute(
        'UPDATE group_settings SET bye_msg = NULL WHERE bot_id = ? AND group_jid = ?',
        [botData.id, jid]
      );
      await reply('✅ Pesan bye berhasil dihapus.');
      return true;
    }

    // ── setdetect ─────────────────────────────────────────────────────────────
    case 'setdetect': {
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      if (!await isBotAdmin()) { await reply(mess.BotAdmin); return true; }
      const { pool: dbPool } = require('../config/database');
      await dbPool.execute(
        `INSERT INTO group_settings (bot_id, group_jid, detect)
         VALUES (?, ?, 1)
         ON DUPLICATE KEY UPDATE detect = 1`,
        [botData.id, jid]
      );
      await reply('✅ *Group Detect aktif!*\nBot akan mengirim notifikasi perubahan grup (ganti nama, icon, deskripsi, promote/demote admin, dll).');
      return true;
    }

    // ── deldetect ─────────────────────────────────────────────────────────────
    case 'deldetect': {
      if (!await isAdmin()) { await reply(mess.GrupAdmin); return true; }
      if (!await isBotAdmin()) { await reply(mess.BotAdmin); return true; }
      const { pool: dbPool } = require('../config/database');
      await dbPool.execute(
        `INSERT INTO group_settings (bot_id, group_jid, detect)
         VALUES (?, ?, 0)
         ON DUPLICATE KEY UPDATE detect = 0`,
        [botData.id, jid]
      );
      await reply('✅ *Group Detect dinonaktifkan.*\nBot tidak akan lagi mengirim notifikasi perubahan grup.');
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
      } catch (e) { await reply(`❌ Gagal ubah foto grup: ${e.message}`); }
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
      //   .setclose Selamat tinggal @user dari @groupname
      const jam  = normalizeJam(args[0]);
      const teks = (jam ? args.slice(1) : args).join(' ').trim();

      if (!jam && !teks) {
        await reply(
          `⚠️ *Teks ${isOpen ? 'BUKA' : 'TUTUP'} grup belum diisi!*\n\n` +
          `*Cara Penggunaan:*\n` +
          `${p}${command} <teks>            → teks pengumuman\n` +
          `${p}${command} <jam> <teks>      → teks + jadwal otomatis\n\n` +
          `*Contoh:*\n` +
          `${p}${command} ${isOpen ? 'Selamat pagi @groupname, grup sudah dibuka!' : 'Selamat tinggal @user dari @groupname'} \n` +
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

    // ── catatan / catatanset — daftar variable template ───────────────────────
    // `.catatanset <topik>` = bentuk pendek, biar nggak perlu spasi.
    case 'catatan':
    case 'catatanset': {
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
      if (!await isBotAdmin()) { await reply(mess.BotAdmin); return true; }

      const caption = args.join(' ').trim();

      // Ambil media dari quoted message atau pesan saat ini
      const quotedMsg = ctx.msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      const imgMsg    = quotedMsg?.imageMessage  || ctx.msg?.message?.imageMessage;
      const vidMsg    = quotedMsg?.videoMessage  || ctx.msg?.message?.videoMessage;
      const audMsg    = quotedMsg?.audioMessage  || ctx.msg?.message?.audioMessage;

      try {
        let content;

        if (imgMsg) {
          const buffer   = await client.message.downloadBytes(quotedMsg ? { imageMessage: imgMsg } : ctx.msg.message);
          const uploaded = await client.message.upload(buffer, { type: 'image', mimetype: imgMsg.mimetype || 'image/jpeg' });
          content = {
            imageMessage: {
              url:               uploaded.url,
              mimetype:          imgMsg.mimetype || 'image/jpeg',
              caption:           caption || '',
              fileSha256:        uploaded.fileSha256,
              fileLength:        uploaded.fileLength,
              height:            uploaded.height  || 512,
              width:             uploaded.width   || 512,
              mediaKey:          uploaded.mediaKey,
              fileEncSha256:     uploaded.fileEncSha256,
              directPath:        uploaded.directPath,
              mediaKeyTimestamp: uploaded.mediaKeyTimestamp,
              jpegThumbnail:     uploaded.jpegThumbnail || undefined,
            },
          };
        } else if (vidMsg) {
          const buffer   = await client.message.downloadBytes(quotedMsg ? { videoMessage: vidMsg } : ctx.msg.message);
          const uploaded = await client.message.upload(buffer, { type: 'video', mimetype: vidMsg.mimetype || 'video/mp4' });
          content = {
            videoMessage: {
              url:               uploaded.url,
              mimetype:          vidMsg.mimetype || 'video/mp4',
              caption:           caption || '',
              fileSha256:        uploaded.fileSha256,
              fileLength:        uploaded.fileLength,
              height:            uploaded.height  || 512,
              width:             uploaded.width   || 512,
              mediaKey:          uploaded.mediaKey,
              fileEncSha256:     uploaded.fileEncSha256,
              directPath:        uploaded.directPath,
              mediaKeyTimestamp: uploaded.mediaKeyTimestamp,
              jpegThumbnail:     uploaded.jpegThumbnail || undefined,
              seconds:           uploaded.seconds || 1,
            },
          };
        } else if (audMsg) {
          const buffer   = await client.message.downloadBytes(quotedMsg ? { audioMessage: audMsg } : ctx.msg.message);
          const uploaded = await client.message.upload(buffer, { type: 'audio', mimetype: audMsg.mimetype || 'audio/mp4' });
          content = {
            audioMessage: {
              url:               uploaded.url,
              mimetype:          audMsg.mimetype || 'audio/mp4',
              fileSha256:        uploaded.fileSha256,
              fileLength:        uploaded.fileLength,
              mediaKey:          uploaded.mediaKey,
              fileEncSha256:     uploaded.fileEncSha256,
              directPath:        uploaded.directPath,
              mediaKeyTimestamp: uploaded.mediaKeyTimestamp,
              seconds:           uploaded.seconds || 1,
              ptt:               false,
            },
          };
        } else if (caption) {
          content = { extendedTextMessage: { text: caption } };
        } else {
          await reply(
            `Cara penggunaan:\n` +
            `• *${p}swgc* <teks> — kirim teks sebagai status grup\n` +
            `• Reply foto/video/audio lalu ketik *${p}swgc* [caption]`
          );
          return true;
        }

        // Kirim sebagai groupStatusMessageV2
        // WA sering balas error 400 meski status berhasil terkirim — tangkap & abaikan
        try {
          await client.message.send(jid, { groupStatusMessageV2: { message: content } });
        } catch (e) {
          if (!e.message?.includes('400') && !e.message?.includes('negative publish ack')) {
            throw e; // lempar ulang kalau bukan error 400 WA
          }
          // error 400 = WA policy, status tetap terkirim, abaikan
        }
        await react('✅');
      } catch (e) {
        await reply(`❌ Gagal kirim status grup: ${e.message}`);
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
  'kick','kickall','promote','demote','add','promoteme',
  'open','close','mute','unmute','slowmode','setname','setdesc',
  'grupopen','grupclose','linkgc','setnamegc',
  'linkgroup','groupinfo','idgc','grouplist','leavegc','listadmin',
  'getpp','totag','delete','cekasalmember',
  'mulaiabsen','absen','cekabsen','hapusabsen',
  'afk','listafk','topchat','swgc','upswgc',
]);
