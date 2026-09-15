'use strict';

/**
 * plugins/05-owner.js
 * Commands: ban, unban, block, unblock, broadcast, bcgc, on, off,
 *           backup, restore, clearsession, cleartmp, listblacklist, listblock,
 *           warn, unwarn, delwarn, resetwarn, setwarnlimit
 *
 * Owner-only commands require the sender to be the bot owner number.
 */

const path = require('path');
const fs   = require('fs');
const { pool } = require('../config/database');
const mess = require('../config/mess');
const { addStickerExif } = require('../engine/sticker');
const { markPendingSewa } = require('../engine/pendingSewa');
const { uploadInfo } = require('../engine/api');
const { genThumbnail } = require('../engine/thumbnail');
const { proto } = require('baileys');
const { getRankByLevel } = require('./03-fun-rpg');
const { ALL_COMMANDS, CATS } = require('./01-info');

// In-memory stores
const blockedUsers  = new Map(); // botId -> Set<jid>
const blockedLoaded = new Set(); // botId yang sudah di-load dari DB
const warnData      = new Map(); // `${botId}:${groupJid}:${jid}` -> { count, limit }
const warnLoaded    = new Set(); // botId yang warnData-nya sudah di-load dari DB
const sewaIndexMap  = new Map(); // `${botId}` -> [groupJid, ...] — index dari .listsewa terakhir

function getMentionedFromCtx(ctx) {
  return ctx.msg?.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
}

// ─── Helper: parse durasi string ke milliseconds ──────────────────────────────
// Format: 1d, 7d, 1mo, 3mo, 1y, 2y
function parseDurasi(str) {
  if (!str) return null;
  const match = str.toLowerCase().match(/^(\d+)(d|mo|y)$/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  switch (match[2]) {
    case 'd':  return n * 86400000;
    case 'mo': return n * 30 * 86400000;
    case 'y':  return n * 365 * 86400000;
    default:   return null;
  }
}

// ─── Helper: format sisa waktu ────────────────────────────────────────────────
function formatSisa(ms) {
  if (ms <= 0) return 'Habis';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return `${d} hari ${h} jam`;
  if (h > 0) return `${h} jam ${m} menit`;
  return `${m} menit`;
}

async function isOwner(ctx) {
  if (!ctx.botData.owner_number) return false;
  const ownerNum = ctx.botData.owner_number.replace(/\D/g, '');
  const senderRaw = ctx.sender.split('@')[0].split(':')[0];

  // Grup biasa: sender = 628xxx@s.whatsapp.net → langsung cocok
  if (senderRaw === ownerNum) return true;

  // Grup LID: sender = 238xxx@lid → resolve via participants
  if (ctx.isGroup && ctx.client) {
    try {
      const meta = await ctx.client.group.queryGroupMetadata(ctx.jid).catch(() => null);
      if (meta) {
        const p = meta.participants.find(
          pt => pt.jid === ctx.sender || pt.lid === ctx.sender
        );
        if (p?.phoneNumber) {
          const pNum = String(p.phoneNumber).replace(/\D/g, '');
          if (pNum === ownerNum) return true;
        }
      }
    } catch { /* skip */ }
  }
  return false;
}

function getBotId(ctx) {
  return ctx.botData.id;
}

function getBlockedSet(botId) {
  if (!blockedUsers.has(botId)) blockedUsers.set(botId, new Set());
  return blockedUsers.get(botId);
}

// Load blacklist dari DB saat pertama kali dibutuhkan per botId
async function ensureBlockedLoaded(botId) {
  if (blockedLoaded.has(botId)) return;
  blockedLoaded.add(botId);
  try {
    const [rows] = await pool.execute('SELECT jid FROM blacklist WHERE bot_id = ?', [botId]);
    const set = getBlockedSet(botId);
    for (const row of rows) set.add(row.jid);
  } catch { /* non-critical */ }
}

// Load warn dari DB saat pertama kali dibutuhkan per botId.
// Tanpa ini, warnData selalu mulai dari 0 tiap restart -> member yang sudah
// dikumpulin warn-nya lolos begitu bot restart.
// ponytail: muat semua grup sekaligus (bukan per-grup); pecah per-grup kalau
// warn_records sudah puluhan ribu baris.
async function ensureWarnLoaded(botId) {
  if (warnLoaded.has(botId)) return;
  warnLoaded.add(botId);
  try {
    const [rows] = await pool.execute(
      'SELECT group_jid, member_jid, warn_count, warn_limit FROM warn_records WHERE bot_id = ?',
      [botId]
    );
    for (const r of rows) {
      warnData.set(getWarnKey(botId, r.group_jid, r.member_jid), {
        count: Number(r.warn_count) || 0,
        limit: Number(r.warn_limit) || 3,
      });
    }
  } catch { /* non-critical */ }
}

function getWarnKey(botId, groupJid, memberJid) {
  return `${botId}:${groupJid}:${memberJid}`;
}

function getWarn(botId, groupJid, memberJid) {
  const key = getWarnKey(botId, groupJid, memberJid);
  if (!warnData.has(key)) warnData.set(key, { count: 0, limit: 3 });
  return warnData.get(key);
}

module.exports = async function ownerHandler(ctx) {
  if (!ctx.isCmd) return false;

  const { command, args, reply, react, sock, client, jid, sender, botData, isGroup } = ctx;
  const botId = getBotId(ctx);
  const p     = botData.prefix;

  // ── Load blacklist dari DB kalau belum (lazy, sekali per botId per session) ─
  await ensureBlockedLoaded(botId);
  await ensureWarnLoaded(botId);

  // ── Blacklist / block gate on every message ─────────────────────────────
  const blocked = getBlockedSet(botId);
  if (blocked.has(sender) && command !== 'unban') {
    return true; // silently ignore
  }

  switch (command) {

    // ─── BAN / UNBAN (blacklist from using bot) ─────────────────────────
    case 'ban': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      const mentioned = ctx.mentioned || [];
      if (!mentioned[0]) { await reply(`Penggunaan: ${p}ban @target [alasan]`); return true; }
      const target = mentioned[0];
      // Ambil alasan dari teks setelah mention (strip bagian @mention dari body)
      const reasonRaw = ctx.body.replace(/^\.ban\s*/i, '').replace(/@\S+/g, '').trim();
      const reason = reasonRaw || 'Banned by owner';
      const alreadyBanned = getBlockedSet(botId).has(target);
      if (alreadyBanned) {
        await client.message.send(jid, {
          type: 'text',
          text: `🐛 @${target.split('@')[0]} memang hama`,
          mentions: [target],
        });
        return true;
      }
      try {
        await pool.execute(
          'INSERT IGNORE INTO blacklist (bot_id, jid, reason) VALUES (?, ?, ?)',
          [botId, target, reason]
        );
      } catch { /* non-critical */ }
      getBlockedSet(botId).add(target);
      await client.message.send(jid, {
        type: 'text',
        text: `🚫 @${target.split('@')[0]} telah di-ban\n_Alasan: ${reason}_`,
        mentions: [target],
      });
      return true;
    }

    case 'unban': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      const mentioned = ctx.mentioned || [];
      if (!mentioned[0]) { await reply(`Penggunaan: ${p}unban @target`); return true; }
      const target = mentioned[0];
      try {
        await pool.execute('DELETE FROM blacklist WHERE bot_id = ? AND jid = ?', [botId, target]);
      } catch { /* non-critical */ }
      getBlockedSet(botId).delete(target);
      await client.message.send(jid, {
        type: 'text',
        text: `✅ @${target.split('@')[0]} telah di-unban.`,
        mentions: [target],
      });
      return true;
    }

    case 'listban':
    case 'listblacklist': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      try {
        const [rows] = await pool.execute('SELECT jid, reason FROM blacklist WHERE bot_id = ?', [botId]);
        if (rows.length === 0) { await reply('Daftar ban kosong'); return true; }
        const mentions = rows.map(r => r.jid);
        const list = rows.map((r, i) => `${i + 1}. @${r.jid.split('@')[0]} — ${r.reason}`).join('\n');
        await client.message.send(jid, {
          type: 'text',
          text: `🚫 *Daftar Ban*\n\n${list}`,
          mentions: mentions,
        });
      } catch {
        await reply('Gagal mengambil daftar ban');
      }
      return true;
    }

    // ─── BLOCK / UNBLOCK (WhatsApp native block) ────────────────────────
    case 'block': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      const mentioned = ctx.mentioned || [];
      if (!mentioned[0]) { await reply(`Penggunaan: ${p}block @target`); return true; }
      try {
        await client.privacy.blockUser(mentioned[0]);
        await client.message.send(jid, {
          type: 'text',
          text: `🔒 @${mentioned[0].split('@')[0]} berhasil di-block`,
          mentions: [mentioned[0]],
        });
      } catch {
        await reply('Gagal mem-block pengguna');
      }
      return true;
    }

    case 'unblock': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      const mentioned = ctx.mentioned || [];
      if (!mentioned[0]) { await reply(`Penggunaan: ${p}unblock @target`); return true; }
      try {
        await client.privacy.unblockUser(mentioned[0]);
        await client.message.send(jid, {
          type: 'text',
          text: `🔓 @${mentioned[0].split('@')[0]} berhasil di-unblock`,
          mentions: [mentioned[0]],
        });
      } catch {
        await reply('Gagal meng-unblock pengguna');
      }
      return true;
    }

    case 'listblock': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      const list = [...getBlockedSet(botId)];
      if (list.length === 0) { await reply('Tidak ada yang di-block'); return true; }
      await reply(`🔒 *Daftar Block*\n\n${list.map((j, i) => `${i + 1}. ${j.split('@')[0]}`).join('\n')}`);
      return true;
    }

    // ─── BROADCAST ──────────────────────────────────────────────────────
    case 'broadcast':
    case 'bc': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      const activeGroups = ctx.activeGroups || new Map();
      const channelJid   = botData.channel_id?.trim() || null;
      const totalTargets = activeGroups.size + (channelJid ? 1 : 0);
      if (totalTargets === 0) { await reply('Belum ada grup aktif dan channel ID belum diset'); return true; }

      const text = args.join(' ');
      const footer = botData.footer_text ? `\n\n${botData.footer_text}` : '';

      // Detect media — bisa dari pesan langsung (kirim gambar + caption .broadcast)
      // atau dari quoted message (reply ke gambar + .broadcast)
      const rawMsg   = ctx.msg?.message || {};
      const msgType  = Object.keys(rawMsg)[0] || '';
      const quotedCtx = rawMsg?.extendedTextMessage?.contextInfo?.quotedMessage;
      const quotedType = quotedCtx ? Object.keys(quotedCtx)[0] : null;

      const mediaTypes = ['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage'];
      const isDirectMedia  = mediaTypes.includes(msgType);
      const isQuotedMedia  = quotedType && mediaTypes.includes(quotedType);

      const groupLabel   = activeGroups.size > 0 ? `${activeGroups.size} grup` : '';
      const channelLabel = channelJid ? 'channel' : '';
      const targetLabel  = [groupLabel, channelLabel].filter(Boolean).join(' + ');
      await reply(`📡 Memulai broadcast ke ${targetLabel}...`);
      let sent = 0;
      const sentList = []; // untuk laporan

      // Gabung target: semua grup aktif + channel jika ada
      const targets = [
        ...activeGroups.entries(),
        ...(channelJid ? [[channelJid, 'Channel']] : [])
      ];

      for (const [cJid, cName] of targets) {
        try {
          if (isDirectMedia) {
            const content = rawMsg[msgType];
            const fixed   = Object.assign({}, content);
            for (const f of ['mediaKey','fileSha256','fileEncSha256']) {
              if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
            }
            const buffer   = await client.message.downloadBytes({ [msgType]: fixed });
            const mime     = content.mimetype || 'application/octet-stream';
            const uploadType = msgType === 'imageMessage' ? 'image'
              : msgType === 'videoMessage' ? 'video'
              : msgType === 'stickerMessage' ? 'sticker'
              : (content.ptt ? 'ptt' : 'audio');
            const caption = `📢 *Broadcast*\n\n${text || content.caption || ''}${footer}`.trim();
            await client.message.send(cJid, { type: uploadType, media: buffer, mimetype: mime, caption });
          } else if (isQuotedMedia) {
            const content = quotedCtx[quotedType];
            const fixed   = Object.assign({}, content);
            for (const f of ['mediaKey','fileSha256','fileEncSha256']) {
              if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
            }
            const buffer   = await client.message.downloadBytes({ [quotedType]: fixed });
            const mime     = content.mimetype || 'application/octet-stream';
            const uploadType = quotedType === 'imageMessage' ? 'image'
              : quotedType === 'videoMessage' ? 'video'
              : quotedType === 'stickerMessage' ? 'sticker'
              : (content.ptt ? 'ptt' : 'audio');
            const caption = `📢 *Broadcast*\n\n${text || content.caption || ''}${footer}`.trim();
            await client.message.send(cJid, { type: uploadType, media: buffer, mimetype: mime, caption });
          } else {
            if (!text) { await reply(`Penggunaan: ${p}bc <pesan> — atau kirim/reply gambar dengan caption ${p}bc`); return true; }
            await client.message.send(cJid, {
              type: 'text',
              text: `📢 *Broadcast*\n\n${text}${footer}`.trim(),
            });
          }
          sent++;
          sentList.push(`• ${cName} : ${cJid}`);
          await new Promise(r => setTimeout(r, 1500));
        } catch { /* skip failed */ }
      }
      const report = sentList.length > 0 ? `\n${sentList.join('\n')}` : '';
      await reply(`✅ Broadcast selesai: ${sent}/${totalTargets} target${report}`);
      return true;
    }

    case 'bcgc': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      const text = args.join(' ');
      if (!text) { await reply(`Penggunaan: ${p}bcgc <pesan>`); return true; }
      const activeGroups = ctx.activeGroups || new Map();
      if (activeGroups.size === 0) { await reply('Belum ada grup aktif — kirim pesan di grup dulu agar bot mengenali grup tersebut'); return true; }
      const footer = botData.footer_text ? `\n\n${botData.footer_text}` : '';
      let sent = 0;
      for (const [gJid] of activeGroups) {
        try {
          await client.message.send(gJid, { type: 'text', text: `📢 *Broadcast Grup*\n\n${text}${footer}`.trim() });
          sent++;
          await new Promise(r => setTimeout(r, 1200));
        } catch { /* skip */ }
      }
      await reply(`✅ Broadcast ke ${sent}/${activeGroups.size} grup selesai`);
      return true;
    }

    // ─── BCGCHT — Broadcast semua grup + hidetag semua member ────────────────
    case 'bcgcht': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      const text = args.join(' ');
      if (!text) { await reply(`Penggunaan: ${p}bcgcht <pesan>`); return true; }
      const activeGroups = ctx.activeGroups || new Map();
      if (activeGroups.size === 0) { await reply('Belum ada grup aktif — kirim pesan di grup dulu agar bot mengenali grup tersebut'); return true; }
      const footer = botData.footer_text ? `\n\n${botData.footer_text}` : '';
      let sent = 0;
      for (const [gJid] of activeGroups) {
        try {
          // Ambil metadata grup untuk dapat daftar member
          const meta = await client.group.queryGroupMetadata(gJid).catch(() => null);
          const mentionJids = [];
          if (meta?.participants) {
            meta.participants.forEach(p => {
              if (p.jid) mentionJids.push(p.jid);
              if (p.lid && p.lid !== p.jid) mentionJids.push(p.lid);
            });
          }
          await client.message.send(gJid, {
            text: `📢 *Broadcast Grup*\n\n${text}${footer}`.trim(),
            mentions: mentionJids,
          });
          sent++;
          await new Promise(r => setTimeout(r, 1500));
        } catch { /* skip */ }
      }
      await reply(`✅ Broadcast+hidetag ke ${sent}/${activeGroups.size} grup selesai`);
      return true;
    }

    // ─── BACKUP / RESTORE ────────────────────────────────────────────────
    case 'backup': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      const dbPath = botData.sqlite_db_path;
      if (!dbPath || !fs.existsSync(dbPath)) {
        await reply('File database tidak ditemukan');
        return true;
      }
      try {
        const backupPath = dbPath.replace('.db', `_backup_${Date.now()}.db`);
        fs.copyFileSync(dbPath, backupPath);
        await reply(`✅ Backup berhasil: ${path.basename(backupPath)}`);
      } catch (e) {
        await reply(`Gagal backup: ${e.message}`);
      }
      return true;
    }

    case 'restore': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      await reply('ℹ️ Restore: Upload file backup .db dan bot akan direstart');
      return true;
    }

    // ─── CLEARSESSION / CLEARTMP ─────────────────────────────────────────
    case 'clearsession': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      await reply('⚠️ Gunakan tombol "Hapus Sesi" di panel dashboard untuk keamanan');
      return true;
    }

    case 'cleartmp': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      const tmpDir = path.join(process.cwd(), 'tmp');
      if (fs.existsSync(tmpDir)) {
        const files = fs.readdirSync(tmpDir);
        files.forEach(f => {
          try { fs.unlinkSync(path.join(tmpDir, f)); } catch {}
        });
        await reply(`🗑️ Berhasil menghapus ${files.length} file tmp`);
      } else {
        await reply('Folder tmp tidak ada');
      }
      return true;
    }

    // ─── WARN SYSTEM ─────────────────────────────────────────────────────
    case 'warn': {
      if (!isGroup) { await reply('Hanya untuk grup'); return true; }
      const mentioned = ctx.msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      if (!mentioned[0]) { await reply(`Penggunaan: ${p}warn @target <alasan>`); return true; }
      const target  = mentioned[0];
      const reason  = args.filter(a => !a.startsWith('@')).join(' ') || 'Melanggar aturan';
      const warnObj = getWarn(botId, jid, target);
      warnObj.count++;

      // Persist to DB
      try {
        await pool.execute(
          `INSERT INTO warn_records (bot_id, group_jid, member_jid, warn_count, warn_limit)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE warn_count = ?, updated_at = NOW()`,
          [botId, jid, target, warnObj.count, warnObj.limit, warnObj.count]
        );
      } catch { /* non-critical */ }

      const msg = `⚠️ *Warning* @${target.split('@')[0]}\nAlasan : ${reason}\nWarn   : ${warnObj.count}/${warnObj.limit}`;

      if (warnObj.count >= warnObj.limit) {
        await client.message.send(jid, { text: msg + '\n\n🚫 Batas warn tercapai! Member di-kick.', mentions: [target] });
        // Notif DM ke target
        try { await client.message.send(target, `🚫 Kamu telah di-kick dari grup karena mencapai batas warn!\n\nAlasan terakhir: ${reason}`); } catch {}
        try { await client.group.removeParticipants(jid, [target]); } catch {}
        warnObj.count = 0;
      } else {
        await client.message.send(jid, { text: msg, mentions: [target] });
        // Notif DM ke target
        try { await client.message.send(target, `⚠️ *Kamu mendapat peringatan (warn) di grup!*\n\nAlasan : ${reason}\nWarn   : ${warnObj.count}/${warnObj.limit}\n\n_Jika mencapai batas, kamu akan di-kick._`); } catch {}
      }
      return true;
    }

    case 'unwarn': {
      if (!isGroup) { await reply('Hanya untuk grup'); return true; }
      const mentioned = ctx.msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      if (!mentioned[0]) { await reply(`Penggunaan: ${p}unwarn @target`); return true; }
      const target  = mentioned[0];
      const warnObj = getWarn(botId, jid, target);
      if (warnObj.count > 0) warnObj.count--;
      try {
        await pool.execute(
          'UPDATE warn_records SET warn_count = ? WHERE bot_id = ? AND group_jid = ? AND member_jid = ?',
          [warnObj.count, botId, jid, target]
        );
      } catch {}
      await client.message.send(jid, {
        text: `✅ Warn @${target.split('@')[0]} dikurangi. Sisa: ${warnObj.count}/${warnObj.limit}`,
        mentions: [target],
      });
      return true;
    }

    case 'delwarn': {
      if (!isGroup) { await reply('Hanya untuk grup'); return true; }
      const mentioned = ctx.msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      if (!mentioned[0]) { await reply(`Penggunaan: ${p}delwarn @target`); return true; }
      const target = mentioned[0];
      const key    = getWarnKey(botId, jid, target);
      warnData.delete(key);
      try {
        await pool.execute(
          'DELETE FROM warn_records WHERE bot_id = ? AND group_jid = ? AND member_jid = ?',
          [botId, jid, target]
        );
      } catch {}
      await client.message.send(jid, {
        text: `🗑️ Warn @${target.split('@')[0]} dihapus`,
        mentions: [target],
      });
      return true;
    }

    case 'resetwarn': {
      if (!isGroup) { await reply('Hanya untuk grup'); return true; }
      // Reset semua warn di grup ini
      const keysToDelete = [...warnData.keys()].filter(k => k.startsWith(`${botId}:${jid}:`));
      keysToDelete.forEach(k => warnData.delete(k));
      try {
        await pool.execute(
          'DELETE FROM warn_records WHERE bot_id = ? AND group_jid = ?',
          [botId, jid]
        );
      } catch {}
      await reply('✅ Semua warn di grup ini direset');
      return true;
    }

    case 'setwarnlimit': {
      if (!isGroup) { await reply('Hanya untuk grup'); return true; }
      const limit = parseInt(args[0], 10);
      if (!limit || limit < 1 || limit > 10) {
        await reply(`Penggunaan: ${p}setwarnlimit <1-10>`);
        return true;
      }
      // Update all existing warn entries for this group
      const prefix = `${botId}:${jid}:`;
      for (const [key, val] of warnData.entries()) {
        if (key.startsWith(prefix)) val.limit = limit;
      }
      // Persist limit ke DB, kalau tidak tiap restart balik ke default 3
      try {
        await pool.execute(
          'UPDATE warn_records SET warn_limit = ? WHERE bot_id = ? AND group_jid = ?',
          [limit, botId, jid]
        );
      } catch {}
      await reply(`✅ Batas warn diubah ke ${limit}`);
      return true;
    }

    // ── listwarn ──────────────────────────────────────────────────────────────
    case 'listwarn': {
      if (!isGroup) { await reply('Hanya untuk grup'); return true; }

      // Kumpulkan dari in-memory dulu
      const prefix  = `${botId}:${jid}:`;
      const entries = [...warnData.entries()]
        .filter(([k, v]) => k.startsWith(prefix) && v.count > 0)
        .map(([k, v]) => ({ jid: k.replace(prefix, ''), count: v.count, limit: v.limit }));

      // Fallback ke DB kalau memory kosong
      let rows = entries;
      if (!rows.length) {
        try {
          const [dbRows] = await pool.execute(
            'SELECT member_jid, warn_count, warn_limit FROM warn_records WHERE bot_id = ? AND group_jid = ? AND warn_count > 0 ORDER BY warn_count DESC',
            [botId, jid]
          );
          rows = dbRows.map(r => ({ jid: r.member_jid, count: r.warn_count, limit: r.warn_limit }));
        } catch {}
      }

      if (!rows.length) {
        await reply(`✅ Tidak ada member yang punya warn di grup ini.`);
        return true;
      }

      const mentionedJids = rows.map(r => r.jid);
      let txt = `⚠️ *DAFTAR WARN*\n\nTotal: ${rows.length} member\n\n`;
      rows.forEach((r, i) => {
        txt += `${i + 1}. @${r.jid.split('@')[0]} — ${r.count}/${r.limit} warn\n`;
      });

      await client.message.send(jid, { text: txt, mentions: mentionedJids });
      return true;
    }

    // ── addprem ──────────────────────────────────────────────────────────
    case 'addprem': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      const mentioned = ctx.mentioned?.length ? ctx.mentioned : getMentionedFromCtx(ctx);
      const target = mentioned[0] || (args[0] ? args[0].replace(/\D/g, '') + '@s.whatsapp.net' : null);
      if (!target) { await reply(`Penggunaan: ${p}addprem @target [hari]\nContoh: ${p}addprem @628xxx 30`); return true; }

      // Cek apakah target sudah daftar
      const [regCheck] = await pool.execute(
        'SELECT registered, name FROM rpg_members WHERE bot_id = ? AND jid = ? LIMIT 1',
        [botId, target]
      );
      if (!regCheck[0] || regCheck[0].registered !== 1) {
        await ctx.client.message.send(ctx.jid,
          `❌ @${target.split('@')[0]} belum terdaftar di bot ini!\n\nSuruh dia ketik *${p}uptname <nama>* dulu.`,
          { mentions: [target] }
        );
        return true;
      }

      // Hari opsional (default: permanent)
      const days = parseInt(args[args.length - 1], 10);
      const expired = (!isNaN(days) && days > 0)
        ? new Date(Date.now() + days * 86400000)
        : null;

      try {
        await pool.execute(
          `UPDATE rpg_members SET premium = 1, premium_expired = ? WHERE bot_id = ? AND jid = ?`,
          [expired, botId, target]
        );
        const expStr = expired ? expired.toLocaleDateString('id-ID') : 'Permanen';
        const nama   = regCheck[0].name || target.split('@')[0];
        await ctx.client.message.send(ctx.jid,
          `✅ *Premium aktif!*\n@${target.split('@')[0]} (${nama})\nExpired: ${expStr}`,
          { mentions: [target] }
        );
      } catch (e) { await reply(`Gagal: ${e.message}`); }
      return true;
    }

    // ── delprem ──────────────────────────────────────────────────────────
    case 'delprem': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      const mentioned = ctx.mentioned?.length ? ctx.mentioned : getMentionedFromCtx(ctx);
      const target = mentioned[0] || (args[0] ? args[0].replace(/\D/g, '') + '@s.whatsapp.net' : null);
      if (!target) { await reply(`Penggunaan: ${p}delprem @target`); return true; }

      try {
        const [checkRows] = await pool.execute(
          'SELECT name, registered FROM rpg_members WHERE bot_id = ? AND jid = ? LIMIT 1',
          [botId, target]
        );
        if (!checkRows[0] || checkRows[0].registered !== 1) {
          await ctx.client.message.send(ctx.jid,
            `❌ @${target.split('@')[0]} belum terdaftar di bot ini!`,
            { mentions: [target] }
          );
          return true;
        }
        const nama = checkRows[0].name || target.split('@')[0];
        await pool.execute(
          'UPDATE rpg_members SET premium = 0, premium_expired = NULL WHERE bot_id = ? AND jid = ?',
          [botId, target]
        );
        await ctx.client.message.send(ctx.jid,
          `✅ Premium @${target.split('@')[0]} (${nama}) dicabut`,
          { mentions: [target] }
        );
      } catch (e) { await reply(`Gagal: ${e.message}`); }
      return true;
    }

    // ── listprem ─────────────────────────────────────────────────────────
    case 'listprem': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      try {
        const [rows] = await pool.execute(
          `SELECT jid, premium_expired FROM rpg_members
           WHERE bot_id = ? AND premium = 1
           ORDER BY premium_expired ASC`,
          [botId]
        );
        if (rows.length === 0) { await reply('Tidak ada member premium'); return true; }
        const fmtDate = (d) => d ? new Date(d).toLocaleDateString('id-ID') : 'Permanen';
        const list = rows.map((r, i) =>
          `${i + 1}. @${r.jid.split('@')[0]} — ${fmtDate(r.premium_expired)}`
        ).join('\n');
        const mentions = rows.map(r => r.jid);
        await client.message.send(jid,
          `⭐ *Daftar Member Premium*\n\n${list}\n\nTotal: ${rows.length}`,
          { mentions: mentions }
        );
      } catch (e) { await reply(`Gagal: ${e.message}`); }
      return true;
    }

    // ── addsewa ──────────────────────────────────────────────────────────
    // addsewa <durasi>          → aktifkan sewa di grup saat ini
    // addsewa <link_wa> <durasi> → bot join via link lalu aktifkan sewa
    case 'addsewa': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }

      // Parse args: cek apakah arg[0] adalah link WA atau group JID
      let linkArg  = null;
      let jidArg   = null;
      let durStr   = null;
      const waLinkRegex = /https?:\/\/chat\.whatsapp\.com\/([A-Za-z0-9]+)/;
      const groupJidRegex = /^\d+@g\.us$/;

      for (const arg of args) {
        const m = arg.match(waLinkRegex);
        if (m) linkArg = m[1]; // invite code
        else if (groupJidRegex.test(arg)) jidArg = arg; // group JID langsung
        else if (!durStr) durStr = arg;
      }

      // Mode 3: input group JID langsung → simpan pending sewa
      if (jidArg) {
        if (!durStr) {
          await reply(
            `📋 *Penggunaan dengan Group JID:*\n${p}addsewa <group_jid> <durasi>\n\n` +
            `Contoh:\n${p}addsewa 120363404780376428@g.us 7d\n\n` +
            `_Sewa akan mulai dihitung saat bot pertama kali terdeteksi aktif di grup._`
          );
          return true;
        }
        const ms = parseDurasi(durStr);
        if (!ms) { await reply('❌ Format durasi tidak valid. Gunakan: 1d, 7d, 1mo, 1y'); return true; }

        try {
          await pool.execute(
            `INSERT INTO bot_sewa (bot_id, group_jid, group_name, expired_at, pending_ms, warned)
             VALUES (?, ?, ?, NULL, ?, 0)
             ON DUPLICATE KEY UPDATE
               pending_ms = ?,
               expired_at = NULL,
               warned = 0`,
            [botId, jidArg, jidArg.split('@')[0], ms, ms]
          );
          await reply(
            `✅ *Sewa Pending Disimpan!*\n\n` +
            `🆔 Group JID: ${jidArg}\n` +
            `⏳ Durasi: ${durStr}\n\n` +
            `_Waktu sewa akan mulai dihitung saat bot pertama kali menerima pesan dari grup tersebut._`
          );
        } catch (e) {
          await reply(`❌ Gagal simpan sewa: ${e.message}`);
        }
        return true;
      }

      // Mode 1: ada link → bot join dulu
      if (linkArg) {
        if (!durStr) {
          await reply(
            `📋 *Penggunaan dengan link:*\n${p}addsewa <link_grup> <durasi>\n\n` +
            `Contoh:\n${p}addsewa https://chat.whatsapp.com/xxx 7d`
          );
          return true;
        }
        const ms = parseDurasi(durStr);
        if (!ms) { await reply('❌ Format durasi tidak valid. Gunakan: 1d, 7d, 1mo, 1y'); return true; }

        try {
          await reply(`⏳ Mencoba join grup...`);

          // Join via invite code
          const joinResult = await client.group.joinGroupViaInvite(linkArg);

          // joinGroupViaInvite biasanya return object dengan gid/jid
          const groupJid = joinResult?.gid || joinResult?.jid || joinResult;
          if (!groupJid || typeof groupJid !== 'string') {
            await reply('❌ Gagal mendapatkan JID grup setelah join. Coba gunakan command di dalam grup langsung.');
            return true;
          }

          // Mark sebagai pending sewa SEGERA setelah dapat JID
          // Ini cegah engine leave grup sebelum DB sempat diupdate
          markPendingSewa(botId, groupJid);

          // Tunggu sebentar agar metadata tersedia
          await new Promise(r => setTimeout(r, 3000));

          // Ambil nama grup
          let groupName = groupJid.split('@')[0];
          try {
            const meta = await client.group.queryGroupMetadata(groupJid);
            if (meta?.subject) groupName = meta.subject;
          } catch {}

          const expiredAt = Date.now() + ms;
          await pool.execute(
            `INSERT INTO bot_sewa (bot_id, group_jid, group_name, expired_at, warned)
             VALUES (?, ?, ?, ?, 0)
             ON DUPLICATE KEY UPDATE
               expired_at = IF(expired_at > UNIX_TIMESTAMP()*1000, expired_at + ?, ?),
               group_name = VALUES(group_name),
               warned = 0`,
            [botId, groupJid, groupName, expiredAt, ms, expiredAt]
          );

          const [[row]] = await pool.execute(
            'SELECT expired_at FROM bot_sewa WHERE bot_id = ? AND group_jid = ?',
            [botId, groupJid]
          );
          const expDate = new Date(Number(row.expired_at));

          // Kirim pesan selamat datang ke grup
          await client.message.send(groupJid,
            `👋 *Bot telah bergabung!*\n\n` +
            `📌 Grup: *${groupName}*\n` +
            `✅ *Sewa Bot Aktif*\n\n` +
            `⏳ Durasi: *${durStr}*\n` +
            `📅 Expired: *${expDate.toLocaleString('id-ID')}*\n\n` +
            `Gunakan ${p}ceksewa untuk cek status sewa kapan saja.`
          );

          await reply(
            `✅ *Bot berhasil join & sewa aktif!*\n\n` +
            `📌 Grup: ${groupName}\n` +
            `⏳ Durasi: ${durStr}\n` +
            `📅 Expired: ${expDate.toLocaleString('id-ID')}`
          );
        } catch (e) {
          await reply(`❌ Gagal join grup: ${e.message}\n\nPastikan link valid dan bot belum ada di grup.`);
        }
        return true;
      }

      // Mode 2: tidak ada link → aktifkan sewa di grup saat ini
      if (!isGroup) {
        await reply(
          `📋 *Penggunaan:*\n` +
          `• Di dalam grup: ${p}addsewa <durasi>\n` +
          `• Dengan link: ${p}addsewa <link_grup> <durasi>\n\n` +
          `Contoh durasi: 1d, 7d, 1mo, 1y`
        );
        return true;
      }

      if (!durStr) {
        await reply(`Penggunaan: ${p}addsewa <durasi>\nContoh: ${p}addsewa 7d`);
        return true;
      }
      const ms = parseDurasi(durStr);
      if (!ms) { await reply('❌ Format durasi tidak valid. Gunakan: 1d, 7d, 1mo, 1y'); return true; }

      try {
        let groupName = jid.split('@')[0];
        try {
          const meta = await client.group.queryGroupMetadata(jid);
          if (meta?.subject) groupName = meta.subject;
        } catch {}

        const expiredAt = Date.now() + ms;
        await pool.execute(
          `INSERT INTO bot_sewa (bot_id, group_jid, group_name, expired_at, warned)
           VALUES (?, ?, ?, ?, 0)
           ON DUPLICATE KEY UPDATE
             expired_at = IF(expired_at > UNIX_TIMESTAMP()*1000, expired_at + ?, ?),
             group_name = VALUES(group_name),
             warned = 0`,
          [botId, jid, groupName, expiredAt, ms, expiredAt]
        );

        const [[row]] = await pool.execute(
          'SELECT expired_at FROM bot_sewa WHERE bot_id = ? AND group_jid = ?',
          [botId, jid]
        );
        const expDate = new Date(Number(row.expired_at));
        await reply(
          `✅ *Sewa Bot Aktif!*\n\n` +
          `📌 Grup: ${groupName}\n` +
          `⏳ Durasi: ${durStr}\n` +
          `📅 Expired: ${expDate.toLocaleString('id-ID')}`
        );
      } catch (e) { await reply(`Gagal: ${e.message}`); }
      return true;
    }

    // ── delsewa ──────────────────────────────────────────────────────────
    case 'delsewa': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }

      // Bisa dari dalam grup (tanpa arg) atau dari DM/grup lain (dengan arg JID/nomor index)
      let targetJid = isGroup ? jid : null;

      if (args[0]) {
        const arg = args[0];
        // Cek apakah arg adalah nomor index dari .listsewa
        const idx = parseInt(arg);
        if (!isNaN(idx) && idx > 0) {
          const indexList = sewaIndexMap.get(botId);
          if (!indexList || !indexList[idx - 1]) {
            await reply(`❌ Nomor tidak valid. Ketik ${p}listsewa dulu untuk lihat daftar.`);
            return true;
          }
          targetJid = indexList[idx - 1];
        } else {
          // Interpret sebagai JID langsung
          targetJid = arg.includes('@') ? arg : `${arg}@g.us`;
        }
      }

      if (!targetJid) {
        await reply(`❌ Gunakan di dalam grup sewa, atau ketik:\n${p}delsewa <nomor>\n\nContoh setelah ${p}listsewa:\n${p}delsewa 1`);
        return true;
      }

      try {
        const [res] = await pool.execute(
          'DELETE FROM bot_sewa WHERE bot_id = ? AND group_jid = ?',
          [botId, targetJid]
        );
        if (res.affectedRows === 0) {
          await reply('❌ Grup ini tidak terdaftar sewa');
        } else {
          await reply(`✅ Sewa bot di grup *${targetJid}* telah dihapus`);
          // Bot leave grup setelah sewa dihapus
          try {
            await client.message.send(targetJid,
              `⚠️ *Sewa bot telah berakhir.*\n\nBot akan meninggalkan grup ini.\nHubungi owner untuk memperpanjang sewa.`
            );
            await new Promise(r => setTimeout(r, 2000));
            await client.group.leaveGroup([targetJid]);
          } catch { /* non-critical */ }
        }
      } catch (e) { await reply(`Gagal: ${e.message}`); }
      return true;
    }

    // ── setsewa ──────────────────────────────────────────────────────────
    // Set ulang expired date (override, bukan extend)
    case 'setsewa': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      if (!isGroup) { await reply('❌ Command ini hanya untuk grup'); return true; }

      const durStr = args[0];
      if (!durStr) {
        await reply(`Penggunaan: ${p}setsewa <durasi>\nContoh: ${p}setsewa 30d`);
        return true;
      }
      const ms = parseDurasi(durStr);
      if (!ms) { await reply('❌ Format durasi tidak valid'); return true; }

      try {
        let groupName = jid.split('@')[0];
        try {
          const meta = await client.group.queryGroupMetadata(jid);
          if (meta?.subject) groupName = meta.subject;
        } catch {}

        const expiredAt = Date.now() + ms;
        await pool.execute(
          `INSERT INTO bot_sewa (bot_id, group_jid, group_name, expired_at, warned)
           VALUES (?, ?, ?, ?, 0)
           ON DUPLICATE KEY UPDATE expired_at = ?, group_name = ?, warned = 0`,
          [botId, jid, groupName, expiredAt, expiredAt, groupName]
        );
        const expDate = new Date(expiredAt);
        await reply(
          `✅ *Sewa di-reset!*\n\n📅 Expired baru: ${expDate.toLocaleString('id-ID')}`
        );
      } catch (e) { await reply(`Gagal: ${e.message}`); }
      return true;
    }

    // ── ceksewa ──────────────────────────────────────────────────────────
    case 'ceksewa': {
      if (!isGroup) { await reply('❌ Command ini hanya untuk grup'); return true; }
      try {
        const [[row]] = await pool.execute(
          'SELECT group_name, expired_at FROM bot_sewa WHERE bot_id = ? AND group_jid = ?',
          [botId, jid]
        );
        if (!row) {
          await reply('❌ Grup ini belum terdaftar sewa bot');
          return true;
        }
        const now       = Date.now();
        const expiredAt = Number(row.expired_at);
        const sisa      = expiredAt - now;
        const expDate   = new Date(expiredAt);
        const status    = sisa > 0 ? '✅ Aktif' : '❌ Expired';
        const sisaStr   = sisa > 0 ? formatSisa(sisa) : 'Sudah habis';
        await reply(
          `📋 *Info Sewa Bot*\n\n` +
          `📌 Grup: ${row.group_name || jid.split('@')[0]}\n` +
          `📊 Status: ${status}\n` +
          `📅 Expired: ${expDate.toLocaleString('id-ID')}\n` +
          `⏳ Sisa: ${sisaStr}`
        );
      } catch (e) { await reply(`Gagal: ${e.message}`); }
      return true;
    }

    // ── listsewa ─────────────────────────────────────────────────────────
    case 'listsewa': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      try {
        const [rows] = await pool.execute(
          'SELECT group_jid, group_name, expired_at, pending_ms FROM bot_sewa WHERE bot_id = ? ORDER BY expired_at IS NULL DESC, expired_at ASC',
          [botId]
        );
        if (rows.length === 0) { await reply('Belum ada grup yang sewa bot'); return true; }

        // Simpan index → JID untuk .delsewa <nomor>
        sewaIndexMap.set(botId, rows.map(r => r.group_jid));

        const now  = Date.now();
        const list = rows.map((r, i) => {
          // Row pending: expired_at NULL, belum dimulai
          if (r.expired_at === null) {
            return `${i + 1}. ⏸ *${r.group_name || r.group_jid.split('@')[0]}*\n   Sisa: Menunggu bot aktif di grup`;
          }
          const exp    = Number(r.expired_at);
          const status = exp > now ? '✅' : '❌';
          const sisa   = exp > now ? formatSisa(exp - now) : 'Expired';
          return `${i + 1}. ${status} *${r.group_name || r.group_jid.split('@')[0]}*\n   Sisa: ${sisa}`;
        }).join('\n');
        await reply(`📋 *Daftar Sewa Bot*\n\nTotal: ${rows.length}\n\n${list}\n\n_Ketik ${p}delsewa <nomor> untuk hapus sewa_`);
      } catch (e) { await reply(`Gagal: ${e.message}`); }
      return true;
    }

    // ── get — Fetch URL & kirim ke WA ────────────────────────────────────────
    case 'get': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      const fetchUrl = args[0];
      if (!fetchUrl) {
        await reply(`Penggunaan: *${p}get* <url>\n\nContoh:\n• ${p}get https://example.com/image.jpg\n• ${p}get https://api.example.com/data`);
        return true;
      }
      try {
        const axios = require('axios');
        await react(mess.reactLoading);

        const res = await axios.get(fetchUrl, {
          responseType: 'arraybuffer',
          timeout:      30000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
          maxContentLength: 50 * 1024 * 1024,
        });

        const contentType = res.headers['content-type'] || '';
        const buf         = Buffer.from(res.data);

        await react(mess.reactSuccess);

        if (contentType.includes('image/webp')) {
          // Stiker WA (webp statis/animasi) — dikirim sebagai imageMessage = cuma kebaca di desktop.
          // Kirim type 'sticker' biar tampil di mobile juga, packname/author dari .env.
          await client.message.send(jid, {
            type:     'sticker',
            media:    await addStickerExif(buf, mess.packname, mess.author),
            mimetype: 'image/webp',
          });
        } else if (contentType.includes('image/')) {
          // Gambar
          await client.message.send(jid, {
            type:     'image',
            media:    buf,
            mimetype: contentType.split(';')[0].trim(),
            caption:  `📎 ${fetchUrl}`,
          });
        } else if (contentType.includes('video/')) {
          // Video
          await client.message.send(jid, {
            type:     'video',
            media:    buf,
            mimetype: contentType.split(';')[0].trim(),
            caption:  `📎 ${fetchUrl}`,
          });
        } else if (contentType.includes('audio/')) {
          // Audio
          await client.message.send(jid, {
            type:     'audio',
            media:    buf,
            mimetype: contentType.split(';')[0].trim(),
          });
        } else if (contentType.includes('application/json') || contentType.includes('text/')) {
          // JSON / teks
          const text = buf.toString('utf-8');
          let display = text;
          // Format JSON kalau bisa
          try {
            const parsed = JSON.parse(text);
            display = JSON.stringify(parsed, null, 2);
          } catch {}
          // Potong kalau terlalu panjang
          if (display.length > 3000) display = display.slice(0, 3000) + '\n...[terpotong]';
          await reply(`📎 *${fetchUrl}*\n\n\`\`\`\n${display}\n\`\`\``);
        } else {
          // File lain — kirim sebagai dokumen
          const ext      = fetchUrl.split('.').pop()?.split('?')[0] || 'bin';
          const filename = `file.${ext}`;
          await client.message.send(jid, {
            type:     'document',
            media:    buf,
            mimetype: contentType.split(';')[0].trim() || 'application/octet-stream',
            fileName: filename,
          });
        }
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal fetch: ${e.message}`);
      }
      return true;
    }

    // ── test — versi vellzy: SATU bubble interactiveMessage, header lokasi ────
    // customNodes <biz>/<interactive> dari kode aslinya NGGAK perlu ditulis di
    // sini — adapter (engine/baileys/client.js sendRaw) udah nambahin otomatis.
    case 'test': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      try {
        await react(mess.reactLoading);

        const banner = fs.readFileSync(
          path.resolve(botData.banner_url || process.env.BANNER_DEFAULT),
        );
        // Header lokasi cuma bisa nampilin thumbnail (WA nggak nyimpen gambar
        // utuh di sana). 640px nggak dirender WA, 300px dirender — balik ke 300.
        // Mau tajam beneran = gambar harus bubble sendiri.
        const thumb = await genThumbnail(banner, 'image/jpeg', 300) || banner;

        const runtime = process.uptime();
        const uh = Math.floor(runtime / 3600);
        const um = Math.floor((runtime % 3600) / 60);
        const us = Math.floor(runtime % 60);
        const pnJid = String(sender).split(':')[0].split('@')[0];

        const body = [
          '╭─── • *「 INFO USER 」*',
          `│ ◦ User : @${pnJid}`,
          `│ ◦ Status : *${await isOwner(ctx) ? 'Owner' : ctx.isPremium ? 'Premium' : 'Free'}*`,
          `│ ◦ Uptime : *${uh}h ${um}m ${us}s*`,
          `│ ◦ Mode : *Public*`,
          `│ ◦ Prefix : *[${p || '.'}]*`,
          '╰───────────────────•',
          '',
          '*CATEGORY COMMANDS*',
          `Total: ${ALL_COMMANDS.length} fitur / ${Object.keys(CATS).length} kategori`,
          '',
          '╭─── • *「 KATEGORI 」*',
          ...Object.entries(CATS).map(([k, v]) => `│ ◦ ${k.toUpperCase()} (${v.length} Fitur)`),
          '╰───────────────────•',
        ].join('\n');

        const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

        await sock.message.send(jid, {
          interactiveMessage: {
            header: {
              hasMediaAttachment: true,
              locationMessage: {
                degreesLatitude: 0,
                degreesLongitude: 0,
                name: botData.bot_name || 'YaaParBot',
                address: 'YaaParBot — yapari.web.id',
                jpegThumbnail: thumb,
              },
            },
            body:   { text: body },
            footer: { text: `*${botData.bot_name || 'YaaParBot'}*\n*${now}*` },
            nativeFlowMessage: {
              buttons: [
                {
                  name: 'single_select',
                  buttonParamsJson: JSON.stringify({
                    title: 'Pilih Kategori',
                    sections: [{
                      title: 'Kategori',
                      highlight_label: 'YaaPar Menu',
                      rows: Object.entries(CATS).map(([k, v]) => ({
                        title: k.toUpperCase(),
                        description: `${v.length} Command`,
                        id: `.menu ${k}`,
                      })),
                    }],
                  }),
                },
                {
                  name: 'single_select',
                  buttonParamsJson: JSON.stringify({
                    title: 'Informasi',
                    sections: [{
                      title: 'Informasi',
                      highlight_label: 'Informasi',
                      rows: [
                        { title: 'Ping',   id: '.ping' },
                        { title: 'Owner',  id: '.owner' },
                      ],
                    }],
                  }),
                },
                {
                  name: 'cta_url',
                  buttonParamsJson: JSON.stringify({
                    display_text: '🌐 Website',
                    url: 'https://yapari.web.id',
                    merchant_url: 'https://yapari.web.id',
                  }),
                },
              ],
              messageParamsJson: '{}',
            },
            contextInfo: {
              mentionedJid: [pnJid + '@s.whatsapp.net'],
              // Kartu "verif" di bawah bubble: thumbnail + title + body + sumber klik.
              externalAdReply: {
                title: botData.bot_name || 'YaaParBot',
                body: 'yapari.web.id',
                mediaType: 1, // IMAGE
                thumbnail: thumb,
                sourceUrl: 'https://yapari.web.id',
                renderLargerThumbnail: false,
                showAdAttribution: false,
              },
            },
          },
        });
        await react(mess.reactSuccess);
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal: ${e.message}`);
      }
      return true;
    }

    case 'setqris': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }

      const rawMsg     = ctx.msg.message || {};
      const msgType    = Object.keys(rawMsg)[0] || '';
      const quoted     = rawMsg?.extendedTextMessage?.contextInfo?.quotedMessage;
      const quotedType = quoted ? Object.keys(quoted)[0] : null;
      const imgTypes   = ['imageMessage'];

      const isDirectImg = imgTypes.includes(msgType);
      const isQuotedImg = quotedType && imgTypes.includes(quotedType);

      // Mode 1: reply/kirim gambar → upload
      if (isDirectImg || isQuotedImg) {
        try {
          await react(mess.reactLoading);

          let buffer, mime, filename;
          if (isDirectImg) {
            const content = rawMsg[msgType];
            const fixed   = Object.assign({}, content);
            for (const f of ['mediaKey','fileSha256','fileEncSha256']) {
              if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
            }
            buffer   = Buffer.from(await client.message.downloadBytes({ [msgType]: fixed }));
            mime     = content.mimetype || 'image/png';
          } else {
            const content = quoted[quotedType];
            const fixed   = Object.assign({}, content);
            for (const f of ['mediaKey','fileSha256','fileEncSha256']) {
              if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
            }
            buffer   = Buffer.from(await client.message.downloadBytes({ [quotedType]: fixed }));
            mime     = content.mimetype || 'image/png';
          }

          // Deteksi ekstensi dari mimetype
          const extMap = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
          const ext      = extMap[mime] || 'png';
          filename       = `qris_${botId}_${Date.now()}.${ext}`;

          // v2 = URL PERMANEN — wajib, karena URL-nya disimpan di DB & dipakai terus
          // oleh .pay dan halaman web (URL v1 cuma hidup 24 jam).
          const { url, expires } = await uploadInfo(buffer, filename, mime, { v2: true, timeout: 30000 });

          // Simpan ke DB dan update botData
          await pool.execute('UPDATE bots SET qris_url = ? WHERE id = ?', [url, botId]);
          botData.qris_url = url;

          await reply(`✅ *QRIS berhasil diupload & disimpan!*\n\n🔗 URL: ${url}\n⏳ Expired: ${expires || 'Permanen'}\n\nKetik ${p}pay untuk test.`);
        } catch (e) {
          await reply(`❌ Gagal upload QRIS: ${e.message}`);
        }
        return true;
      }

      // Mode 2: .setqris <url> langsung
      const url = args[0];
      if (url && url.startsWith('http')) {
        try {
          await pool.execute('UPDATE bots SET qris_url = ? WHERE id = ?', [url, botId]);
          botData.qris_url = url;
          await reply(`✅ QRIS berhasil disimpan!\n\n🔗 URL: ${url}\n\nKetik ${p}pay untuk test.`);
        } catch (e) { await reply(`Gagal: ${e.message}`); }
        return true;
      }

      // Tidak ada gambar dan tidak ada URL
      await reply(
        `📋 *Cara set QRIS:*\n\n` +
        `1️⃣ Reply/kirim gambar QRIS lalu ketik *${p}setqris*\n` +
        `2️⃣ Atau langsung: *${p}setqris <url_gambar>*\n\n` +
        `Contoh: ${p}setqris https://i.imgur.com/xxx.png`
      );
      return true;
    }

    // ── addxp ─────────────────────────────────────────────────────────────────
    case 'addxp': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      const botId     = ctx.botData.id;
      const mentioned = getMentionedFromCtx(ctx);
      const target    = mentioned[0];
      const jumlah    = parseInt(ctx.args.filter(a => !a.startsWith('@')).join(''), 10);

      if (!target || !jumlah || isNaN(jumlah)) {
        await reply(`Penggunaan: ${p}addxp @user <jumlah>\n\nContoh: ${p}addxp @John 500`);
        return true;
      }

      const [rows] = await pool.execute(
        'SELECT xp, level, registered FROM rpg_members WHERE bot_id = ? AND jid = ? LIMIT 1',
        [botId, target]
      );
      if (!rows[0] || rows[0].registered !== 1) {
        await ctx.client.message.send(ctx.jid,
          `❌ @${target.split('@')[0]} belum terdaftar di bot ini!`,
          { mentions: [target] }
        );
        return true;
      }

      let newXp    = (Number(rows[0].xp) || 0) + jumlah;
      let newLevel = rows[0].level || 1;

      // Inline xpForLevel since it's in 03-fun-rpg.js
      const xpForLvl = (lv) => lv <= 0 ? 1 : lv * 100;
      while (newXp >= xpForLvl(newLevel)) {
        newXp   -= xpForLvl(newLevel);
        newLevel++;
      }

      await pool.execute(
        'UPDATE rpg_members SET xp = ?, level = ? WHERE bot_id = ? AND jid = ?',
        [newXp, newLevel, botId, target]
      );

      const mention = target.split('@')[0];
      await ctx.client.message.send(ctx.jid,
        `✨ *ADD XP*\n\n@${mention} mendapat *+${jumlah} XP*\nLevel sekarang: *${newLevel}*\nXP: *${newXp}*`,
        { mentions: [target] }
      );
      return true;
    }

    // ── addmoney ──────────────────────────────────────────────────────────────
    case 'addmoney': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      const botId     = ctx.botData.id;
      const mentioned = getMentionedFromCtx(ctx);
      const target    = mentioned[0];
      const jumlah    = parseInt(ctx.args.filter(a => !a.startsWith('@')).join(''), 10);

      if (!target || !jumlah || isNaN(jumlah)) {
        await reply(`Penggunaan: ${p}addmoney @user <jumlah>\n\nContoh: ${p}addmoney @John 1000`);
        return true;
      }

      const [rows] = await pool.execute(
        'SELECT money, registered FROM rpg_members WHERE bot_id = ? AND jid = ? LIMIT 1',
        [botId, target]
      );
      if (!rows[0] || rows[0].registered !== 1) {
        await ctx.client.message.send(ctx.jid,
          `❌ @${target.split('@')[0]} belum terdaftar di bot ini!`,
          { mentions: [target] }
        );
        return true;
      }

      const newMoney = (Number(rows[0].money) || 0) + jumlah;
      await pool.execute(
        'UPDATE rpg_members SET money = ? WHERE bot_id = ? AND jid = ?',
        [newMoney, botId, target]
      );

      const mention = target.split('@')[0];
      await ctx.client.message.send(ctx.jid,
        `💰 *ADD MONEY*\n\n@${mention} mendapat *+${Number(jumlah).toLocaleString('id-ID')} koin*\nTotal koin: *${newMoney.toLocaleString('id-ID')}*`,
        { mentions: [target] }
      );
      return true;
    }

    // ── addlimit ──────────────────────────────────────────────────────────────
    case 'addlimit': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      const botId     = ctx.botData.id;
      const mentioned = getMentionedFromCtx(ctx);
      const target    = mentioned[0];
      const jumlah    = parseInt(ctx.args.filter(a => !a.startsWith('@')).join(''), 10);

      if (!target || !jumlah || isNaN(jumlah)) {
        await reply(`Penggunaan: ${p}addlimit @user <jumlah>\n\nContoh: ${p}addlimit @John 10`);
        return true;
      }

      const [rows] = await pool.execute(
        'SELECT lim, registered FROM rpg_members WHERE bot_id = ? AND jid = ? LIMIT 1',
        [botId, target]
      );
      if (!rows[0] || rows[0].registered !== 1) {
        await ctx.client.message.send(ctx.jid,
          `❌ @${target.split('@')[0]} belum terdaftar di bot ini!`,
          { mentions: [target] }
        );
        return true;
      }

      const newLim = (Number(rows[0].lim) || 0) + jumlah;
      await pool.execute(
        'UPDATE rpg_members SET lim = ? WHERE bot_id = ? AND jid = ?',
        [newLim, botId, target]
      );

      await ctx.client.message.send(ctx.jid,
        `💎 *ADD LIMIT*\n\n@${target.split('@')[0]} mendapat *+${jumlah} limit*\nTotal limit: *${newLim}*`,
        { mentions: [target] }
      );
      return true;
    }

    // ── addhp ─────────────────────────────────────────────────────────────────
    case 'addhp': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      const botId     = ctx.botData.id;
      const mentioned = getMentionedFromCtx(ctx);
      const target    = mentioned[0];
      const jumlah    = parseInt(ctx.args.filter(a => !a.startsWith('@')).join(''), 10);

      if (!target || !jumlah || isNaN(jumlah)) {
        await reply(`Penggunaan: ${p}addhp @user <jumlah>\n\nContoh: ${p}addhp @John 50`);
        return true;
      }

      const [rows] = await pool.execute(
        'SELECT healt, registered FROM rpg_members WHERE bot_id = ? AND jid = ? LIMIT 1',
        [botId, target]
      );
      if (!rows[0] || rows[0].registered !== 1) {
        await ctx.client.message.send(ctx.jid,
          `❌ @${target.split('@')[0]} belum terdaftar di bot ini!`,
          { mentions: [target] }
        );
        return true;
      }

      const newHp = (Number(rows[0].healt) || 0) + jumlah;
      await pool.execute(
        'UPDATE rpg_members SET healt = ? WHERE bot_id = ? AND jid = ?',
        [newHp, botId, target]
      );

      await ctx.client.message.send(ctx.jid,
        `❤️ *ADD HEALTH*\n\n@${target.split('@')[0]} mendapat *+${jumlah} Health*\nTotal Health: *${newHp}*`,
        { mentions: [target] }
      );
      return true;
    }

    // ── resetlimit ────────────────────────────────────────────────────────────
    case 'resetlimit': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      const botId    = ctx.botData.id;
      const defLimit = parseInt(process.env.DEFAULT_LIMIT || '20', 10);

      // Opsional: reset user tertentu atau semua
      const mentioned = getMentionedFromCtx(ctx);
      if (mentioned.length > 0) {
        // Reset limit user tertentu
        const results = [];
        for (const t of mentioned) {
          await pool.execute(
            'UPDATE rpg_members SET lim = ? WHERE bot_id = ? AND jid = ?',
            [defLimit, botId, t]
          );
          results.push(`@${t.split('@')[0]}`);
        }
        await ctx.client.message.send(ctx.jid,
          `✅ *RESET LIMIT*\n\nLimit direset ke *${defLimit}* untuk:\n${results.join('\n')}`,
          { mentions: mentioned }
        );
      } else {
        // Reset semua user di bot ini
        const [res] = await pool.execute(
          'UPDATE rpg_members SET lim = ? WHERE bot_id = ?',
          [defLimit, botId]
        );
        await reply(`✅ *RESET LIMIT*\n\nLimit semua member direset ke *${defLimit}*!\nTotal: *${res.affectedRows} user*`);
      }
      return true;
    }

    // ── listuser ──────────────────────────────────────────────────────────────
    case 'listuser': {
      if (!ctx.isOwner) { await reply(mess.onlyOwner); return true; }

      const [rows] = await pool.execute(
        'SELECT name, jid, premium, premium_expired FROM rpg_members WHERE bot_id = ? AND registered = 1 ORDER BY name ASC',
        [botId]
      );

      if (!rows.length) {
        await reply(`📋 *LIST USER*\n\nBelum ada user yang terdaftar.`);
        return true;
      }

      const ownerNum = (botData.owner_number || '').replace(/\D/g, '');
      const lines = rows.map((r, i) => {
        const phone  = r.jid.split('@')[0];
        const isOwner = ownerNum && phone === ownerNum;
        const isPrem  = r.premium === 1 && (!r.premium_expired || new Date(r.premium_expired) > new Date());
        const badge   = isOwner ? ' (owner)' : isPrem ? ' (premium)' : ' (user)';
        return `${i + 1}. ${r.name || phone}${badge}`;
      });

      // Kirim per 50 baris kalau banyak
      const CHUNK = 50;
      for (let i = 0; i < lines.length; i += CHUNK) {
        const chunk = lines.slice(i, i + CHUNK);
        const header = i === 0 ? `📋 *LIST USER BOT*\nTotal: *${rows.length} user*\n\n` : `📋 *(lanjutan)*\n\n`;
        await reply(header + chunk.join('\n'));
      }
      return true;
    }

    // ── dellevel ─────────────────────────────────────────────────────────────
    case 'dellevel': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      const mentioned = getMentionedFromCtx(ctx);
      const target    = mentioned[0];
      const jumlah    = parseInt(ctx.args.filter(a => !a.startsWith('@')).join(''), 10);
      if (!target || !jumlah || isNaN(jumlah) || jumlah <= 0) {
        await reply(`Penggunaan: ${p}dellevel @user <jumlah>\n\nContoh: ${p}dellevel @John 5`);
        return true;
      }
      const [rows] = await pool.execute(
        'SELECT level, registered FROM rpg_members WHERE bot_id = ? AND jid = ? LIMIT 1',
        [botId, target]
      );
      if (!rows[0] || rows[0].registered !== 1) {
        await ctx.client.message.send(ctx.jid,
          `❌ @${target.split('@')[0]} belum terdaftar!`, { mentions: [target] }
        );
        return true;
      }
      const newLevel = Math.max(1, (Number(rows[0].level) || 1) - jumlah);
      await pool.execute('UPDATE rpg_members SET level = ? WHERE bot_id = ? AND jid = ?', [newLevel, botId, target]);
      await ctx.client.message.send(ctx.jid,
        `📉 *DEL LEVEL*\n\n@${target.split('@')[0]} level dikurangi *-${jumlah}*\nLevel sekarang: *${newLevel}*`,
        { mentions: [target] }
      );
      return true;
    }

    // ── addlevel ──────────────────────────────────────────────────────────────
    case 'addlevel': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      const mentioned = getMentionedFromCtx(ctx);
      const target    = mentioned[0];
      const jumlah    = parseInt(ctx.args.filter(a => !a.startsWith('@')).join(''), 10);
      if (!target || !jumlah || isNaN(jumlah) || jumlah <= 0) {
        await reply(`Penggunaan: ${p}addlevel @user <jumlah>\n\nContoh: ${p}addlevel @John 5`);
        return true;
      }
      const [rows] = await pool.execute(
        'SELECT xp, level, registered FROM rpg_members WHERE bot_id = ? AND jid = ? LIMIT 1',
        [botId, target]
      );
      if (!rows[0] || rows[0].registered !== 1) {
        await ctx.client.message.send(ctx.jid,
          `❌ @${target.split('@')[0]} belum terdaftar!`, { mentions: [target] }
        );
        return true;
      }
      let newLevel = (Number(rows[0].level) || 1) + jumlah;
      // Naikin level tanpa nyisa XP di bawah threshold — kalau XP sudah lewat
      // batas level baru, buang kelebihannya (pakai helper level-loop engine).
      let newXp = Number(rows[0].xp) || 0;
      const xpForLvl = (lv) => lv <= 0 ? 1 : lv * 100;
      while (newXp >= xpForLvl(newLevel)) newXp -= xpForLvl(newLevel);

      await pool.execute(
        'UPDATE rpg_members SET xp = ?, level = ? WHERE bot_id = ? AND jid = ?',
        [newXp, newLevel, botId, target]
      );
      await ctx.client.message.send(ctx.jid,
        `✨ *ADD LEVEL*\n\n@${target.split('@')[0]} naik *+${jumlah} level*\nLevel sekarang: *${newLevel}*\nXP: *${newXp}*`,
        { mentions: [target] }
      );
      return true;
    }

    // ── delmoney ─────────────────────────────────────────────────────────────
    case 'delmoney': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      const mentioned = getMentionedFromCtx(ctx);
      const target    = mentioned[0];
      const jumlah    = parseInt(ctx.args.filter(a => !a.startsWith('@')).join(''), 10);
      if (!target || !jumlah || isNaN(jumlah) || jumlah <= 0) {
        await reply(`Penggunaan: ${p}delmoney @user <jumlah>\n\nContoh: ${p}delmoney @John 1000`);
        return true;
      }
      const [rows] = await pool.execute(
        'SELECT money, registered FROM rpg_members WHERE bot_id = ? AND jid = ? LIMIT 1',
        [botId, target]
      );
      if (!rows[0] || rows[0].registered !== 1) {
        await ctx.client.message.send(ctx.jid,
          `❌ @${target.split('@')[0]} belum terdaftar!`, { mentions: [target] }
        );
        return true;
      }
      const newMoney = Math.max(0, (Number(rows[0].money) || 0) - jumlah);
      await pool.execute('UPDATE rpg_members SET money = ? WHERE bot_id = ? AND jid = ?', [newMoney, botId, target]);
      await ctx.client.message.send(ctx.jid,
        `💸 *DEL MONEY*\n\n@${target.split('@')[0]} uang dikurangi *-${jumlah.toLocaleString('id-ID')}*\nUang tersisa: *${newMoney.toLocaleString('id-ID')}*`,
        { mentions: [target] }
      );
      return true;
    }

    // ── delxp ─────────────────────────────────────────────────────────────────
    case 'delxp': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      const mentioned = getMentionedFromCtx(ctx);
      const target    = mentioned[0];
      const jumlah    = parseInt(ctx.args.filter(a => !a.startsWith('@')).join(''), 10);
      if (!target || !jumlah || isNaN(jumlah) || jumlah <= 0) {
        await reply(`Penggunaan: ${p}delxp @user <jumlah>\n\nContoh: ${p}delxp @John 500`);
        return true;
      }
      const [rows] = await pool.execute(
        'SELECT xp, registered FROM rpg_members WHERE bot_id = ? AND jid = ? LIMIT 1',
        [botId, target]
      );
      if (!rows[0] || rows[0].registered !== 1) {
        await ctx.client.message.send(ctx.jid,
          `❌ @${target.split('@')[0]} belum terdaftar!`, { mentions: [target] }
        );
        return true;
      }
      const newXp = Math.max(0, (Number(rows[0].xp) || 0) - jumlah);
      await pool.execute('UPDATE rpg_members SET xp = ? WHERE bot_id = ? AND jid = ?', [newXp, botId, target]);
      await ctx.client.message.send(ctx.jid,
        `📉 *DEL XP*\n\n@${target.split('@')[0]} XP dikurangi *-${jumlah}*\nXP tersisa: *${newXp}*`,
        { mentions: [target] }
      );
      return true;
    }

    // ── dellimit ─────────────────────────────────────────────────────────────
    case 'dellimit': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      const mentioned = getMentionedFromCtx(ctx);
      const target    = mentioned[0];
      const jumlah    = parseInt(ctx.args.filter(a => !a.startsWith('@')).join(''), 10);
      if (!target || !jumlah || isNaN(jumlah) || jumlah <= 0) {
        await reply(`Penggunaan: ${p}dellimit @user <jumlah>\n\nContoh: ${p}dellimit @John 5`);
        return true;
      }
      const [rows] = await pool.execute(
        'SELECT lim, registered FROM rpg_members WHERE bot_id = ? AND jid = ? LIMIT 1',
        [botId, target]
      );
      if (!rows[0] || rows[0].registered !== 1) {
        await ctx.client.message.send(ctx.jid,
          `❌ @${target.split('@')[0]} belum terdaftar!`, { mentions: [target] }
        );
        return true;
      }
      const newLim = Math.max(0, (Number(rows[0].lim) || 0) - jumlah);
      await pool.execute('UPDATE rpg_members SET lim = ? WHERE bot_id = ? AND jid = ?', [newLim, botId, target]);
      await ctx.client.message.send(ctx.jid,
        `💎 *DEL LIMIT*\n\n@${target.split('@')[0]} limit dikurangi *-${jumlah}*\nLimit tersisa: *${newLim}*`,
        { mentions: [target] }
      );
      return true;
    }


    // ── cekprofil (owner lihat profil user lain) ──────────────────────────────
    case 'cekprofil': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      const mentioned = getMentionedFromCtx(ctx);
      const target    = mentioned[0];
      if (!target) {
        await reply(`Penggunaan: ${p}cekprofil @user`);
        return true;
      }
      const [rows] = await pool.execute(
        'SELECT * FROM rpg_members WHERE bot_id = ? AND jid = ? LIMIT 1',
        [botId, target]
      );
      if (!rows[0] || rows[0].registered !== 1) {
        await ctx.client.message.send(ctx.jid,
          `❌ @${target.split('@')[0]} belum terdaftar!`, { mentions: [target] }
        );
        return true;
      }
      const r = rows[0];
      const rank = getRankByLevel(Number(r.level) || 1);
      const isPrem = r.premium === 1;
      const premExp = r.premium_expired ? new Date(r.premium_expired).toLocaleDateString('id-ID') : '-';
      await ctx.client.message.send(ctx.jid,
        `👤 *PROFIL — @${target.split('@')[0]}*\n\n` +
        `📛 Nama   : ${r.name || '-'}\n` +
        `🏅 Rank   : ${rank}\n` +
        `⭐ Level  : ${r.level || 1}\n` +
        `✨ XP     : ${r.xp || 0}\n` +
        `💰 Uang   : ${(r.money || 0).toLocaleString('id-ID')}\n` +
        `🏦 Bank   : ${(r.bank_money || 0).toLocaleString('id-ID')}\n` +
        `❤️ Health : ${r.healt || 0}\n` +
        `💎 Limit  : ${r.lim || 0}\n` +
        `👑 Premium: ${isPrem ? `✅ (exp: ${premExp})` : '❌'}\n` +
        `💼 Job    : ${r.job || '-'}`,
        { mentions: [target] }
      );
      return true;
    }

    // ── resetprofil ───────────────────────────────────────────────────────────
    case 'resetprofil': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      const mentioned = getMentionedFromCtx(ctx);
      const target    = mentioned[0];
      if (!target) {
        await reply(`Penggunaan: ${p}resetprofil @user\n\n⚠️ Ini akan mereset semua stat RPG user ke default!`);
        return true;
      }
      const [rows] = await pool.execute(
        'SELECT registered FROM rpg_members WHERE bot_id = ? AND jid = ? LIMIT 1',
        [botId, target]
      );
      if (!rows[0] || rows[0].registered !== 1) {
        await ctx.client.message.send(ctx.jid,
          `❌ @${target.split('@')[0]} belum terdaftar!`, { mentions: [target] }
        );
        return true;
      }
      const defLim = parseInt(process.env.DEFAULT_LIMIT || '20', 10);
      await pool.execute(
        `UPDATE rpg_members SET level=1, xp=0, money=0, bank_money=0, healt=100,
         sword=0, armor=0, job=NULL, jobexp=0, lim=?, hewan_json=NULL
         WHERE bot_id = ? AND jid = ?`,
        [defLim, botId, target]
      );
      await ctx.client.message.send(ctx.jid,
        `🔄 *RESET PROFIL*\n\n@${target.split('@')[0]} stat RPG telah direset ke default!`,
        { mentions: [target] }
      );
      return true;
    }

    // ── listrank ─────────────────────────────────────────────────────────────
    case 'listrank': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      const [rows] = await pool.execute(
        `SELECT name, jid, level, xp FROM rpg_members
         WHERE bot_id = ? AND registered = 1
         ORDER BY level DESC, xp DESC LIMIT 20`,
        [botId]
      );
      if (!rows.length) { await reply('Belum ada user terdaftar.'); return true; }
      const lines = rows.map((r, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        return `${medal} ${r.name || r.jid.split('@')[0]} — Lv.${r.level} (${r.xp} XP)`;
      });
      await reply(`🏆 *TOP RANK RPG*\n\n${lines.join('\n')}`);
      return true;
    }

    // ── leaveall ─────────────────────────────────────────────────────────────
    case 'leaveall': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      try {
        const groups = await ctx.client.group.queryAllGroups().catch(() => null);
        if (!groups || !groups.length) { await reply('Bot tidak ada di grup mana pun.'); return true; }
        await reply(`⏳ Keluar dari *${groups.length} grup*...`);
        let sukses = 0;
        for (const g of groups) {
          const gJid = g.jid || g.id;
          if (!gJid) continue;
          try { await ctx.client.group.leaveGroup([gJid]); sukses++; } catch {}
          await new Promise(r => setTimeout(r, 1000));
        }
        await reply(`✅ Berhasil keluar dari *${sukses}/${groups.length} grup*.`);
      } catch (e) {
        await reply(`❌ Gagal leaveall: ${e.message}`);
      }
      return true;
    }

    // ── listgroup ─────────────────────────────────────────────────────────────
    case 'listgroup': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      try {
        const groups = await ctx.client.group.queryAllGroups().catch(() => null);
        if (!groups || !groups.length) { await reply('Bot tidak ada di grup mana pun.'); return true; }

        // Ambil data sewa dan main_groups
        const [sewaRows] = await pool.execute(
          'SELECT group_jid, expired_at FROM bot_sewa WHERE bot_id = ?', [botId]
        );
        const sewaMap = new Map(sewaRows.map(r => [r.group_jid, r.expired_at]));

        const mainGroupsRaw = ctx.botData.main_groups || '';
        const mainGroups = new Set(
          mainGroupsRaw.split(/[,\n]/).map(s => s.trim()).filter(Boolean)
        );

        const now = Date.now();
        const CHUNK = 25;
        const lines = groups.map((g, i) => {
          const gJid = g.jid || g.id || '';
          const nama  = g.subject || g.name || '-';
          const short = gJid.split('@')[0];

          let status = '👥 biasa';
          if (mainGroups.has(gJid)) {
            status = '🏠 utama';
          } else if (sewaMap.has(gJid)) {
            const exp = Number(sewaMap.get(gJid));
            const sisa = exp - now;
            if (sisa > 0) {
              const d = Math.floor(sisa / 86400000);
              const h = Math.floor((sisa % 86400000) / 3600000);
              status = `💰 sewa (sisa ${d > 0 ? d + 'h ' : ''}${h}j)`;
            } else {
              status = '⛔ sewa expired';
            }
          }

          return `${i + 1}. *${nama}*\n    ${short} — ${status}`;
        });

        for (let i = 0; i < lines.length; i += CHUNK) {
          const header = i === 0
            ? `📋 *LIST GRUP BOT*\nTotal: *${groups.length} grup*\n\n`
            : `📋 *(lanjutan)*\n\n`;
          await reply(header + lines.slice(i, i + CHUNK).join('\n'));
        }
      } catch (e) {
        await reply(`❌ Gagal ambil list grup: ${e.message}`);
      }
      return true;
    }

    // ── setlimitgc ────────────────────────────────────────────────────────────
    // Set daily limit khusus untuk grup ini (override daily_limit bot)
    case 'setlimitgc': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      if (!ctx.isGroup) { await reply(mess.OnlyGroup); return true; }
      const jumlah = parseInt(args[0], 10);
      if (isNaN(jumlah) || jumlah < 0) {
        await reply(`Penggunaan: ${p}setlimitgc <jumlah>\n\nContoh: ${p}setlimitgc 30\nAtur 0 untuk tidak ada limit.`);
        return true;
      }
      // Simpan ke group_settings — tambahkan kolom limit_daily jika belum ada
      await pool.execute(
        `INSERT INTO group_settings (bot_id, group_jid)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE bot_id = bot_id`,
        [botId, jid]
      );
      // Coba update kolom limit_daily (kalau belum ada kolom ini, akan error)
      try {
        await pool.execute(
          'UPDATE group_settings SET limit_daily = ? WHERE bot_id = ? AND group_jid = ?',
          [jumlah, botId, jid]
        );
        await reply(jumlah === 0
          ? `✅ Limit harian di grup ini dihapus (pakai setting bot default).`
          : `✅ Limit harian di grup ini diset *${jumlah}* per hari.`
        );
      } catch {
        // Kolom belum ada, buat dulu
        await pool.execute('ALTER TABLE group_settings ADD COLUMN IF NOT EXISTS limit_daily INT DEFAULT NULL');
        await pool.execute(
          'UPDATE group_settings SET limit_daily = ? WHERE bot_id = ? AND group_jid = ?',
          [jumlah, botId, jid]
        );
        await reply(jumlah === 0
          ? `✅ Limit harian di grup ini dihapus (pakai setting bot default).`
          : `✅ Limit harian di grup ini diset *${jumlah}* per hari.`
        );
      }
      return true;
    }

    // ── addpremgrup ───────────────────────────────────────────────────────────
    // Aktifkan premium untuk semua member di grup ini
    case 'addpremgrup': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      if (!ctx.isGroup) { await reply(mess.OnlyGroup); return true; }
      const durStr = args[0];
      if (!durStr) {
        await reply(`Penggunaan: ${p}addpremgrup <durasi>\n\nContoh: ${p}addpremgrup 30d`);
        return true;
      }
      const ms = parseDurasi(durStr);
      if (!ms) { await reply('❌ Format durasi tidak valid. Gunakan: 1d, 7d, 1mo, 1y'); return true; }
      const expiredAt = new Date(Date.now() + ms).toISOString().slice(0, 19).replace('T', ' ');
      const [res] = await pool.execute(
        `UPDATE rpg_members SET premium = 1, premium_expired = ?
         WHERE bot_id = ? AND jid IN (
           SELECT jid FROM (
             SELECT DISTINCT jid FROM rpg_members WHERE bot_id = ? AND registered = 1
           ) AS sub
         )`,
        [expiredAt, botId, botId]
      );
      // Cara aman tanpa subquery: update langsung
      const [res2] = await pool.execute(
        'UPDATE rpg_members SET premium = 1, premium_expired = ? WHERE bot_id = ? AND registered = 1',
        [expiredAt, botId]
      );
      await reply(
        `✅ *PREMIUM GRUP*\n\nSemua member terdaftar di bot ini mendapat premium!\n` +
        `👥 Total: *${res2.affectedRows} user*\n⏳ Durasi: *${durStr}*\n📅 Expired: *${expiredAt}*`
      );
      return true;
    }

    // ── delpremgrup ───────────────────────────────────────────────────────────
    // Cabut premium semua member di grup ini
    case 'delpremgrup': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      if (!ctx.isGroup) { await reply(mess.OnlyGroup); return true; }
      const [res] = await pool.execute(
        'UPDATE rpg_members SET premium = 0, premium_expired = NULL WHERE bot_id = ? AND registered = 1',
        [botId]
      );
      await reply(
        `✅ *DEL PREMIUM GRUP*\n\nPremium semua member dicabut!\nTotal: *${res.affectedRows} user*`
      );
      return true;
    }

    // ── tambahsewa ────────────────────────────────────────────────────────────
    // Extend durasi sewa grup saat ini (hanya grup sewa, bukan grup utama)
    case 'tambahsewa': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      if (!ctx.isGroup) { await reply('❌ Command ini hanya bisa digunakan di dalam grup sewa.'); return true; }

      const durStr = args[0];
      if (!durStr) {
        await reply(`Penggunaan: ${p}tambahsewa <durasi>\n\nContoh: ${p}tambahsewa 5d\nFormat: 1d, 7d, 1mo, 1y`);
        return true;
      }
      const ms = parseDurasi(durStr);
      if (!ms) { await reply('❌ Format durasi tidak valid. Gunakan: 1d, 7d, 1mo, 1y'); return true; }

      try {
        // Cek apakah grup ini adalah grup sewa (bukan grup utama)
        const [sewaRows] = await pool.execute(
          'SELECT expired_at FROM bot_sewa WHERE bot_id = ? AND group_jid = ? LIMIT 1',
          [botId, jid]
        );
        if (!sewaRows[0]) {
          await reply('❌ Grup ini bukan grup sewa. Gunakan perintah ini hanya di grup sewa aktif.');
          return true;
        }

        // Extend: jika masih aktif, tambah dari expired_at; jika sudah habis, tambah dari sekarang
        const now = Date.now();
        const currentExp = Number(sewaRows[0].expired_at);
        const baseTime   = currentExp > now ? currentExp : now;
        const newExpired = baseTime + ms;

        await pool.execute(
          'UPDATE bot_sewa SET expired_at = ?, warned = 0 WHERE bot_id = ? AND group_jid = ?',
          [newExpired, botId, jid]
        );

        const expDate = new Date(newExpired);
        const sisaLama = currentExp > now ? `(sebelumnya: ${new Date(currentExp).toLocaleDateString('id-ID')})` : '(sudah habis)';

        await reply(
          `✅ *DURASI SEWA DIPERPANJANG*\n\n` +
          `📌 Grup: *${jid.split('@')[0]}*\n` +
          `⏳ Ditambah: *${durStr}*\n` +
          `📅 Expired baru: *${expDate.toLocaleString('id-ID')}*\n` +
          `📎 ${sisaLama}`
        );
      } catch (e) { await reply(`❌ Gagal perpanjang sewa: ${e.message}`); }
      return true;
    }

    // ── addrespon ─────────────────────────────────────────────────────────────
    // Format: .addrespon key|respon
    case 'addrespon': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }

      // Cek tabel auto_respon ada, buat kalau belum
      await pool.execute(`
        CREATE TABLE IF NOT EXISTS auto_respon (
          id INT AUTO_INCREMENT PRIMARY KEY,
          bot_id INT UNSIGNED NOT NULL,
          trigger_key VARCHAR(255) NOT NULL,
          response TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_bot_key (bot_id, trigger_key)
        )
      `).catch(() => {});

      const rawText = ctx.args.join(' ').trim();
      const sepIdx  = rawText.indexOf('|');
      if (sepIdx === -1) {
        await reply(`Penggunaan: ${p}addrespon key|respon\n\nContoh: ${p}addrespon halo|Halo juga kak! 👋`);
        return true;
      }
      const triggerKey = rawText.slice(0, sepIdx).trim().toLowerCase();
      const response   = rawText.slice(sepIdx + 1).trim();
      if (!triggerKey || !response) {
        await reply(`❌ Key dan respon tidak boleh kosong.\nContoh: ${p}addrespon halo|Halo juga kak!`);
        return true;
      }

      try {
        await pool.execute(
          'INSERT INTO auto_respon (bot_id, trigger_key, response) VALUES (?, ?, ?)',
          [botId, triggerKey, response]
        );
        await reply(`✅ *Auto Respon Ditambahkan!*\n\n🔑 Key: *${triggerKey}*\n💬 Respon: ${response}`);
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') {
          await reply(`❌ Key *${triggerKey}* sudah ada. Gunakan ${p}uprespon untuk update.`);
        } else {
          await reply(`❌ Gagal: ${e.message}`);
        }
      }
      return true;
    }

    // ── uprespon ──────────────────────────────────────────────────────────────
    case 'uprespon': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }

      const rawText = ctx.args.join(' ').trim();
      const sepIdx  = rawText.indexOf('|');
      if (sepIdx === -1) {
        await reply(`Penggunaan: ${p}uprespon key|respon_baru\n\nContoh: ${p}uprespon halo|Hai juga! 😊`);
        return true;
      }
      const triggerKey = rawText.slice(0, sepIdx).trim().toLowerCase();
      const response   = rawText.slice(sepIdx + 1).trim();
      if (!triggerKey || !response) {
        await reply(`❌ Key dan respon tidak boleh kosong.`);
        return true;
      }

      try {
        const [res] = await pool.execute(
          'UPDATE auto_respon SET response = ? WHERE bot_id = ? AND trigger_key = ?',
          [response, botId, triggerKey]
        );
        if (res.affectedRows === 0) {
          await reply(`❌ Key *${triggerKey}* tidak ditemukan. Gunakan ${p}addrespon untuk menambahkan.`);
        } else {
          await reply(`✅ *Auto Respon Diupdate!*\n\n🔑 Key: *${triggerKey}*\n💬 Respon baru: ${response}`);
        }
      } catch (e) { await reply(`❌ Gagal: ${e.message}`); }
      return true;
    }

    // ── delrespon ─────────────────────────────────────────────────────────────
    case 'delrespon': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }

      const triggerKey = ctx.args[0]?.toLowerCase();
      if (!triggerKey) {
        await reply(`Penggunaan: ${p}delrespon <key>\n\nContoh: ${p}delrespon halo`);
        return true;
      }

      try {
        const [res] = await pool.execute(
          'DELETE FROM auto_respon WHERE bot_id = ? AND trigger_key = ?',
          [botId, triggerKey]
        );
        if (res.affectedRows === 0) {
          await reply(`❌ Key *${triggerKey}* tidak ditemukan.`);
        } else {
          await reply(`✅ Auto respon *${triggerKey}* berhasil dihapus.`);
        }
      } catch (e) { await reply(`❌ Gagal: ${e.message}`); }
      return true;
    }

    // ── listrespon ────────────────────────────────────────────────────────────
    case 'listrespon': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }

      try {
        const [rows] = await pool.execute(
          'SELECT trigger_key, response FROM auto_respon WHERE bot_id = ? ORDER BY trigger_key ASC',
          [botId]
        );
        if (!rows.length) { await reply('Belum ada auto respon yang terdaftar.'); return true; }

        const CHUNK = 20;
        const lines = rows.map((r, i) => `${i + 1}. *${r.trigger_key}* → ${r.response.slice(0, 50)}${r.response.length > 50 ? '...' : ''}`);
        for (let i = 0; i < lines.length; i += CHUNK) {
          const header = i === 0 ? `📋 *LIST AUTO RESPON*\nTotal: *${rows.length}*\n\n` : `📋 *(lanjutan)*\n\n`;
          await reply(header + lines.slice(i, i + CHUNK).join('\n'));
        }
      } catch (e) { await reply(`❌ Gagal: ${e.message}`); }
      return true;
    }

    // ── addlist ───────────────────────────────────────────────────────────────
    // Format: .addlist key|deskripsi (bisa juga reply pesan)
    case 'addlist': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }

      // Buat tabel gudang_list jika belum ada
      await pool.execute(`
        CREATE TABLE IF NOT EXISTS gudang_list (
          id INT AUTO_INCREMENT PRIMARY KEY,
          bot_id INT UNSIGNED NOT NULL,
          list_key VARCHAR(255) NOT NULL,
          description TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_bot_listkey (bot_id, list_key)
        )
      `).catch(() => {});

      const rawText = ctx.args.join(' ').trim();
      const sepIdx  = rawText.indexOf('|');
      if (sepIdx === -1) {
        await reply(`Penggunaan: ${p}addlist key|deskripsi\n\nContoh: ${p}addlist harga|Harga paket bot:\n• Basic: 50k/bln\n• Pro: 100k/bln`);
        return true;
      }
      const listKey   = rawText.slice(0, sepIdx).trim().toLowerCase();
      const listDesc  = rawText.slice(sepIdx + 1).trim();
      if (!listKey || !listDesc) {
        await reply(`❌ Key dan deskripsi tidak boleh kosong.`);
        return true;
      }

      try {
        await pool.execute(
          'INSERT INTO gudang_list (bot_id, list_key, description) VALUES (?, ?, ?)',
          [botId, listKey, listDesc]
        );
        await reply(`✅ *List Ditambahkan!*\n\n🔑 Key: *${listKey}*\n📝 Deskripsi:\n${listDesc}`);
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') {
          await reply(`❌ Key *${listKey}* sudah ada. Gunakan ${p}updatelist untuk update.`);
        } else {
          await reply(`❌ Gagal: ${e.message}`);
        }
      }
      return true;
    }

    // ── updatelist ────────────────────────────────────────────────────────────
    case 'updatelist': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }

      const rawText = ctx.args.join(' ').trim();
      const sepIdx  = rawText.indexOf('|');
      if (sepIdx === -1) {
        await reply(`Penggunaan: ${p}updatelist key|deskripsi_baru\n\nContoh: ${p}updatelist harga|Harga terbaru: 75k/bln`);
        return true;
      }
      const listKey  = rawText.slice(0, sepIdx).trim().toLowerCase();
      const listDesc = rawText.slice(sepIdx + 1).trim();
      if (!listKey || !listDesc) {
        await reply(`❌ Key dan deskripsi tidak boleh kosong.`);
        return true;
      }

      try {
        const [res] = await pool.execute(
          'UPDATE gudang_list SET description = ? WHERE bot_id = ? AND list_key = ?',
          [listDesc, botId, listKey]
        );
        if (res.affectedRows === 0) {
          await reply(`❌ Key *${listKey}* tidak ditemukan. Gunakan ${p}addlist untuk menambahkan.`);
        } else {
          await reply(`✅ *List Diupdate!*\n\n🔑 Key: *${listKey}*\n📝 Deskripsi baru:\n${listDesc}`);
        }
      } catch (e) { await reply(`❌ Gagal: ${e.message}`); }
      return true;
    }

    // ── reset ─────────────────────────────────────────────────────────────────
    // Reset data RPG semua user di bot ini
    case 'reset': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }

      const target = args[0]?.toLowerCase();
      if (!target) {
        await reply(
          `Penggunaan: ${p}reset <target>\n\n` +
          `Target tersedia:\n` +
          `• *all* — reset semua stat RPG semua user\n` +
          `• *limit* — reset limit semua user ke default\n` +
          `• *xp* — reset XP semua user ke 0\n` +
          `• *money* — reset uang semua user ke 0`
        );
        return true;
      }

      try {
        const defLim = parseInt(process.env.DEFAULT_LIMIT || '20', 10);
        let msg = '';
        if (target === 'all') {
          await pool.execute(
            'UPDATE rpg_members SET level=1, xp=0, money=0, bank_money=0, healt=100, sword=0, armor=0, job=NULL, jobexp=0, lim=? WHERE bot_id=? AND registered=1',
            [defLim, botId]
          );
          msg = '✅ *RESET ALL* — semua stat RPG user direset ke default!';
        } else if (target === 'limit') {
          await pool.execute('UPDATE rpg_members SET lim=? WHERE bot_id=? AND registered=1', [defLim, botId]);
          msg = `✅ *RESET LIMIT* — semua limit user direset ke *${defLim}*!`;
        } else if (target === 'xp') {
          await pool.execute('UPDATE rpg_members SET xp=0 WHERE bot_id=? AND registered=1', [botId]);
          msg = '✅ *RESET XP* — semua XP user direset ke 0!';
        } else if (target === 'money') {
          await pool.execute('UPDATE rpg_members SET money=0, bank_money=0 WHERE bot_id=? AND registered=1', [botId]);
          msg = '✅ *RESET MONEY* — semua uang user direset ke 0!';
        } else {
          await reply(`❌ Target tidak dikenal: *${target}*`); return true;
        }
        await reply(msg);
      } catch (e) { await reply(`❌ Gagal reset: ${e.message}`); }
      return true;
    }

    // ── setbio ────────────────────────────────────────────────────────────────
    // Ubah bio/about bot
    case 'setbio': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      const bio = ctx.args.join(' ').trim();
      if (!bio) {
        await reply(`Penggunaan: ${p}setbio <teks bio>\n\nContoh: ${p}setbio Bot WhatsApp serba bisa 🤖`);
        return true;
      }
      try {
        await ctx.client.profile.setStatus(bio);
        await reply(`✅ Bio bot berhasil diubah:\n_${bio}_`);
      } catch (e) { await reply(`❌ Gagal ubah bio: ${e.message}`); }
      return true;
    }

    // ── setpp ─────────────────────────────────────────────────────────────────
    // Ubah foto profil bot (reply gambar)
    case 'setpp': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }

      // Ambil gambar dari quoted/replied message atau pesan saat ini
      const quotedMsg = ctx.msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      const imgMsg    = quotedMsg?.imageMessage || ctx.msg?.message?.imageMessage;

      if (!imgMsg) {
        await reply(`Kirim gambar dengan caption ${p}setpp, atau reply gambar lalu ketik ${p}setpp`);
        return true;
      }

      try {
        const buffer = await ctx.client.message.downloadBytes(
          quotedMsg ? { imageMessage: imgMsg } : ctx.msg.message
        );
        await ctx.client.profile.setProfilePicture(buffer);
        await reply('✅ Foto profil bot berhasil diubah!');
      } catch (e) { await reply(`❌ Gagal ubah foto profil: ${e.message}`); }
      return true;
    }

    default:
      return false;
  }
};

// Owner command — tidak ada yang kena limit (owner skip sepenuhnya di engine)
module.exports.limitedCmds = new Set([]);
