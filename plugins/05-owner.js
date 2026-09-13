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
const { proto } = require('zapo-js');
const { getRankByLevel } = require('./03-fun-rpg');

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

    // ── test — ButtonV2 proto (location header + legacy buttons) ────────
    // Kode dari Pak, dijalankan apa adanya — TAPI customNodes/additionalAttributes
    // dibuang: zapo sudah men-generate <biz> yang identik sendiri (diverifikasi
    // buildButtonAddonNode('interactive') == node manual), jadi menambahkannya
    // lagi = <biz> DOBEL -> server tolak (479).
    case 'test': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      try {
        await react(mess.reactLoading);
        await sock.message.send(jid, {
          buttonsMessage: {
            buttons: [
              {
                buttonId: "btnv2_1",
                buttonText: {
                  displayText: "Tombol 1"
                },
                type: 1
              },
              {
                buttonId: "btnv2_2",
                buttonText: {
                  displayText: "Tombol 2"
                },
                type: 1
              }
            ],
            locationMessage: {
              degreesLatitude: -6.2,
              degreesLongitude: 106.816666,
              name: "Moszy AI MD • Button V2",
              address: "Testing custom thumbnail di location header",
              jpegThumbnail: Buffer.from('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', 'base64')
            },
            contentText: "Testing ButtonV2 — location header + legacy buttons",
            footerText: "Moszy Button V2 Test",
            headerType: 6
          }
        });
        // customNodes + additionalAttributes DIBUANG: zapo auto-generate <biz> identik
        await react(mess.reactSuccess);
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal: ${e.message}`);
      }
      return true;
    }

    // ── test2 — coba: thumbnail GEDE (bukan 72px) di location header ──────
    // `genThumbnail` bawaan ngecilin ke 72x72; di sini ukurannya dari arg supaya
    // kelihatan WA mau nampilin sebesar apa. Pakai: .test2 300
    // Ukuran di-cache per proses — ganti angka = resize ulang, sama = pakai cache.
    case 'test2': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      try {
        await react(mess.reactLoading);
        const size = Math.min(Math.max(parseInt(args[0], 10) || 300, 72), 640);
        const src  = botData.banner_url || process.env.BANNER_DEFAULT;
        let thumb  = null;
        if (src) {
          const fs   = require('fs');
          const path = require('path');
          const file = path.resolve(src);
          if (fs.existsSync(file)) {
            const sharp = require('sharp');
            thumb = await sharp(fs.readFileSync(file))
              .resize(size, size, { fit: 'inside' })
              .jpeg({ quality: 60 })
              .toBuffer();
          }
        }
        await reply(
          `🧪 *TEST2* — thumbnail ${size}px\n` +
          `sumber : ${src || '(kosong)'}\n` +
          `bytes  : ${thumb ? thumb.length : 0}\n\n` +
          `Cek: gambarnya sebesar apa di bubble tombol ini?`
        );
        await sock.message.send(jid, {
          buttonsMessage: {
            buttons: [
              { buttonId: 'test2_a', buttonText: { displayText: 'Tombol 1' }, type: 1 },
              { buttonId: 'test2_b', buttonText: { displayText: 'Tombol 2' }, type: 1 },
            ],
            locationMessage: {
              degreesLatitude:  -6.2,
              degreesLongitude: 106.816666,
              name:    `Thumbnail ${size}px`,
              address: 'Header location — cek besar gambarnya',
              ...(thumb ? { jpegThumbnail: thumb } : {}),
            },
            contentText: 'Bandingkan dengan `.btntest` (thumbnail 72px).',
            footerText:  botData.footer_text || 'Powered by YaaParBot',
            headerType:  6, // LOCATION
          },
        });
        await react(mess.reactSuccess);
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal: ${e.message}`);
      }
      return true;
    }

    // ── test3 — Button V2: location header (thumb 300px) + 1 tombol dropdown ─
    // Salinan kepunyaan Pak: jimp diganti sharp (sudah terpasang, gak usah nambah
    // dependensi), tombol " MENU" type NATIVE_FLOW pakai nativeFlowInfo
    // single_select berisi 3 baris (All Menu / Script / Donate).
    case 'test3': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      try {
        await react(mess.reactLoading);
        const src = botData.banner_url || process.env.BANNER_DEFAULT;
        let thumb = null;
        if (src) {
          const fs   = require('fs');
          const path = require('path');
          const file = path.resolve(src);
          if (fs.existsSync(file)) {
            thumb = await require('sharp')(fs.readFileSync(file))
              .resize(300, 300)
              .jpeg({ quality: 80 })
              .toBuffer();
          }
        }
        await sock.message.send(jid, {
          buttonsMessage: {
            locationMessage: {
              degreesLatitude:  0,
              degreesLongitude: 0,
              name:    botData.bot_name || 'YaaParBot',
              address: 'LevviCode',
              ...(thumb ? { jpegThumbnail: thumb } : {}),
            },
            contentText:
              `乂 *BOT INFORMATION*\n\n` +
              `*Name* : ${botData.bot_name || 'YaaParBot'}\n` +
              `*Type* : CJS - Plugin\n` +
              `*Dev*  : ${botData.owner_name || '-'}\n` +
              `*Uptime* : ${Math.floor(process.uptime() / 60)} Minute\n\n` +
              `乂 *USER INFORMATION*\n\n` +
              `*Name* : ${ctx.pushName || '-'}\n` +
              `*Number* : +${String(sender).split('@')[0].split(':')[0]}\n` +
              `*Status* : ${await isOwner(ctx) ? 'Owner' : ctx.isPremium ? 'Premium' : 'Free'}`,
            footerText: botData.footer_text || 'Powered by YaaParBot',
            buttons: [
              {
                buttonId:   'test3_menu',
                buttonText: { displayText: ' MENU' },
                type:       2, // NATIVE_FLOW
                nativeFlowInfo: {
                  name: 'single_select',
                  paramsJson: JSON.stringify({
                    title: 'Pilih Menu',
                    sections: [{
                      title: 'Main Menu',
                      highlight_label: 'LevviCode',
                      rows: [
                        { header: '', title: 'All Menu', description: 'Semua Fitur',      id: '.menu',    highlight_label: 'POPULAR' },
                        { header: '', title: 'Script',   description: 'Informasi Script', id: '.script',  highlight_label: 'INFO'    },
                        { header: '', title: 'Donate',   description: 'Support Developer', id: '.donate', highlight_label: 'SUPPORT' },
                      ],
                    }],
                  }),
                },
              },
              { buttonId: 'test3_owner', buttonText: { displayText: ' OWNER' }, type: 1 },
            ],
            headerType: 6, // LOCATION
          },
        });
        await react(mess.reactSuccess);
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal: ${e.message}`);
      }
      return true;
    }

    // ── test4 — banner dari assets/banner.jpg ────────────────────────────────
    // Kesimpulan probe jpegThumbnail non-location (diuji Pak 2026-09-13):
    // header interactiveMessage & buttonsMessage headerType IMAGE dua-duanya
    // NGGAK nge-render gambarnya. `jpegThumbnail` itu frame preview (notifikasi /
    // tombol download), BUKAN media yang ditampilkan. Yang render cuma:
    //   • image message beneran (upload)            → mode default di bawah
    //   • ContextInfo.externalAdReply (kartu link)  → di-drop di interactiveMessage
    //   .test4    → 1 bubble: teks + tombol + PREVIEW gambar (nggak bisa diklik/dibuka)
    //   .test4 ad → sama dengan default (arg diabaikan)
    // Cara preview: content `{type:'text', text, linkPreview:{...}}` → zapo masuk
    // jalur buildExtendedTextWithPreview() → extendedTextMessage.jegThumbnail +
    // title/description/matchedText. Gambarnya thumbnail inline, jadi WA nggak
    // nyimpen file penuh — nggak bisa di-tap buat dibuka gede. Ini API resmi
    // (bukan raw proto hack). Butuh `matchedText` = URL di dalam teks.
    case 'test4': {
      if (!await isOwner(ctx)) { await reply(mess.ownerOnly); return true; }
      try {
        await react(mess.reactLoading);
        const src  = path.resolve('assets/banner.jpg'); // Pak: ambil dari assets/banner.jpg
        const raw  = fs.readFileSync(src);
        const kb   = Math.round(raw.length / 1024);

        await client.message.send(jid, {
          type: 'text',
          text: `📋 *Menu ${botData.bot_name || 'Bot'}*\n\n`
              + `Preview banner di atas — tap nggak bisa kebuka, cuma tampilan.\n\n`
              + `https://yapari.web.id/`,
          linkPreview: {
            matchedText: 'https://yapari.web.id/',
            previewType: proto.Message.ExtendedTextMessage.PreviewType.IMAGE,
            title:       `assets/banner.jpg — ${kb}KB`,
            description: 'Preview banner YaaParBot',
            thumbnail:   { bytes: raw, contentLength: raw.length }, // inline, 56KB < 64KB
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
