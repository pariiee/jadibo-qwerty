'use strict';

const path   = require('path');
const fs     = require('fs');
const { v4: uuidv4 } = require('uuid');
const { pool, incrementStat, decrementStat } = require('../config/database');

const SESSIONS_DIR = path.resolve(process.env.SESSIONS_DIR || './sessions');
const MAX_SLOTS    = parseInt(process.env.MAX_SLOTS_PER_USER || '2', 10);

// In-memory map of active Zappo instances: botId -> ZappoClient
const activeBots = new Map();

// In-memory map of active groups per bot: botId -> Map<groupJid, groupName>
const activeGroupsPerBot = new Map();

// In-memory map of active channels per bot: botId -> Map<channelJid, channelName>
const activeChannelsPerBot = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendError(res, status, message) {
  return res.status(status).json({ ok: false, message });
}

function getBotDir(botId) {
  return path.join(SESSIONS_DIR, `bot_${botId}`);
}

function getDbPath(botId) {
  return path.join(getBotDir(botId), 'session.db');
}

/**
 * Ensure the user owns this bot (or is king).
 */
async function assertOwnership(req, res, botId) {
  const [rows] = await pool.execute(
    'SELECT id, user_id FROM bots WHERE id = ?',
    [botId]
  );
  if (rows.length === 0) { sendError(res, 404, 'Bot tidak ditemukan'); return null; }
  const bot = rows[0];
  if (req.user.role !== 'king' && bot.user_id !== req.user.id) {
    sendError(res, 403, 'Akses ditolak');
    return null;
  }
  return bot;
}

/**
 * Masking token Telegram: tampilkan hanya 4 digit terakhir.
 * Token asli tetap tersimpan di DB — dipakai engine saat start.
 */
function maskToken(token) {
  if (!token) return null;
  // Format: <bot_id>:<35-char secret>
  const parts = String(token).split(':');
  if (parts.length < 2) return '••••••••';
  const secret = parts[1];
  const masked = secret.length > 4
    ? '•'.repeat(secret.length - 4) + secret.slice(-4)
    : '•'.repeat(secret.length);
  return `${parts[0]}:${masked}`;
}

function publicBot(bot) {
  if (!bot) return bot;
  const { telegram_token, ...rest } = bot;
  return { ...rest, telegram_token: maskToken(telegram_token) };
}

// ─── GET /api/bots ────────────────────────────────────────────────────────────

async function listBots(req, res) {
  try {
    const isKing = req.user.role === 'king';
    const query = isKing
      ? `SELECT b.*, u.username FROM bots b JOIN users u ON u.id = b.user_id ORDER BY b.created_at DESC`
      : `SELECT * FROM bots WHERE user_id = ? ORDER BY created_at DESC`;
    const params = isKing ? [] : [req.user.id];

    const [bots] = await pool.execute(query, params);
    // Enrich with runtime status + mask token telegram
    const enriched = bots.map(b => ({
      ...publicBot(b),
      // is_running harus dari DB (di-update engine pas connected/disconnected),
      // bukan activeBots.has() — Map itu ke-set SEBELUM connect selesai,
      // jadi polling frontend salah anggap 'connected' & nutup QR yang baru muncul.
      is_running: b.is_running === 1,
    }));
    return res.json({ ok: true, bots: enriched });
  } catch (err) {
    console.error('[Bot] listBots error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// ─── GET /api/bots/:id ────────────────────────────────────────────────────────

async function getBot(req, res) {
  try {
    const bot = await assertOwnership(req, res, req.params.id);
    if (!bot) return;

    const [rows] = await pool.execute('SELECT * FROM bots WHERE id = ?', [req.params.id]);
    return res.json({
      ok: true,
      bot: { ...publicBot(rows[0]), is_running: rows[0].is_running === 1 },
    });
  } catch (err) {
    console.error('[Bot] getBot error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// ─── POST /api/bots ───────────────────────────────────────────────────────────

async function createBot(req, res) {
  try {
    // Slot check
    if (req.user.role !== 'king') {
      const [count] = await pool.execute(
        'SELECT COUNT(*) AS c FROM bots WHERE user_id = ?',
        [req.user.id]
      );
      if (count[0].c >= MAX_SLOTS)
        return sendError(res, 400, `Slot penuh. Maksimal ${MAX_SLOTS} bot per akun`);
    }

    const {
      platform = 'whatsapp',
      bot_name,
      bot_number,
      owner_number,
      prefix = '!',
      footer_text = 'Powered by YaaParBot',
      description = '',
      telegram_token = null,
    } = req.body;

    if (!bot_name) return sendError(res, 400, 'Nama bot wajib diisi');
    if (platform === 'telegram' && !telegram_token)
      return sendError(res, 400, 'Token Telegram wajib diisi untuk platform Telegram');

    const [result] = await pool.execute(
      `INSERT INTO bots
         (user_id, platform, bot_name, bot_number, owner_number, prefix, footer_text,
          description, telegram_token, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'disconnected')`,
      [req.user.id, platform, bot_name, bot_number || null, owner_number || null,
       prefix, footer_text, description, telegram_token]
    );

    const botId = result.insertId;
    const dbPath = getDbPath(botId);

    // Create session directory
    fs.mkdirSync(getBotDir(botId), { recursive: true });

    // Save sqlite path
    await pool.execute(
      'UPDATE bots SET sqlite_db_path = ? WHERE id = ?',
      [dbPath, botId]
    );

    return res.status(201).json({
      ok: true,
      message: 'Bot berhasil dibuat',
      bot_id: botId,
    });
  } catch (err) {
    console.error('[Bot] createBot error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// ─── PATCH /api/bots/:id ──────────────────────────────────────────────────────

async function updateBot(req, res) {
  try {
    const bot = await assertOwnership(req, res, req.params.id);
    if (!bot) return;

    const allowed = ['bot_name', 'bot_number', 'owner_number', 'owner_name', 'prefix', 'footer_text', 'description', 'telegram_token', 'channel_id', 'qris_url', 'banner_url', 'main_groups', 'daily_limit'];
    const sets = [];
    const vals = [];

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        // Token masked (•••) dari FE jangan ditimpa ke DB — pertahankan token asli
        if (key === 'telegram_token' && String(req.body[key]).includes('•')) continue;
        sets.push(`${key} = ?`);
        vals.push(req.body[key]);
      }
    }

    if (sets.length === 0) return sendError(res, 400, 'Tidak ada field yang diubah');

    vals.push(req.params.id);
    await pool.execute(`UPDATE bots SET ${sets.join(', ')} WHERE id = ?`, vals);

    return res.json({ ok: true, message: 'Bot diperbarui' });
  } catch (err) {
    console.error('[Bot] updateBot error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// ─── DELETE /api/bots/:id ─────────────────────────────────────────────────────

async function deleteBot(req, res) {
  try {
    const bot = await assertOwnership(req, res, req.params.id);
    if (!bot) return;

    // Stop if running — pakai stopWhatsAppBot biar auto-reconnect nggak start ulang
    if (activeBots.has(bot.id)) {
      const { stopWhatsAppBot } = require('../engine/whatsappEngine');
      await stopWhatsAppBot(bot.id);
    }

    // Remove session folder — retry karena Windows bisa hold file SQLite
    const dir = getBotDir(bot.id);
    if (fs.existsSync(dir)) {
      let deleted = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          deleted = true;
          break;
        } catch (e) {
          if (e.code === 'EPERM' || e.code === 'EBUSY') {
            await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
          } else {
            throw e;
          }
        }
      }
      if (!deleted) console.error(`[Bot] deleteBot: folder ${dir} gagal dihapus setelah 5x retry`);
    }

    await pool.execute('DELETE FROM bots WHERE id = ?', [bot.id]);

    return res.json({ ok: true, message: 'Bot dihapus' });
  } catch (err) {
    console.error('[Bot] deleteBot error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// ─── POST /api/bots/:id/start ─────────────────────────────────────────────────

async function startBot(req, res) {
  try {
    const bot = await assertOwnership(req, res, req.params.id);
    if (!bot) return;

    const [rows] = await pool.execute('SELECT * FROM bots WHERE id = ?', [bot.id]);
    const botData = rows[0];

    if (activeBots.has(bot.id))
      return sendError(res, 400, 'Bot sudah berjalan');

    // Route ke engine yang sesuai berdasarkan platform
    if (botData.platform === 'telegram') {
      const { startTelegramBot } = require('../engine/telegramEngine');
      await startTelegramBot(botData);
      return res.json({ ok: true, message: 'Telegram bot berhasil dimulai.' });
    } else {
      const { startWhatsAppBot } = require('../engine/whatsappEngine');
      const usePairingCode = req.body.use_pairing_code === true;
      await startWhatsAppBot(botData, usePairingCode);
      return res.json({ ok: true, message: 'Bot sedang memulai. Pantau log untuk QR/Pairing Code.' });
    }
  } catch (err) {
    console.error('[Bot] startBot error:', err);
    return sendError(res, 500, err.message || 'Terjadi kesalahan server');
  }
}

// ─── POST /api/bots/:id/stop ──────────────────────────────────────────────────

async function stopBot(req, res) {
  try {
    const bot = await assertOwnership(req, res, req.params.id);
    if (!bot) return;

    if (!activeBots.has(bot.id))
      return sendError(res, 400, 'Bot tidak sedang berjalan');

    try {
      const { stopWhatsAppBot } = require('../engine/whatsappEngine');
      await stopWhatsAppBot(bot.id);
    } catch {}

    await pool.execute("UPDATE bots SET status = 'disconnected', is_running = 0 WHERE id = ?", [bot.id]);
    await decrementStat('total_bots_online');

    return res.json({ ok: true, message: 'Bot dihentikan' });
  } catch (err) {
    console.error('[Bot] stopBot error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// ─── POST /api/bots/:id/restart ───────────────────────────────────────────────

async function restartBot(req, res) {
  try {
    const bot = await assertOwnership(req, res, req.params.id);
    if (!bot) return;

    if (activeBots.has(bot.id)) {
      const { stopWhatsAppBot } = require('../engine/whatsappEngine');
      await stopWhatsAppBot(bot.id);
    }

    const [rows] = await pool.execute('SELECT * FROM bots WHERE id = ?', [bot.id]);
    const botData = rows[0];

    if (botData.platform === 'telegram') {
      const { startTelegramBot } = require('../engine/telegramEngine');
      await startTelegramBot(botData);
    } else {
      const { startWhatsAppBot } = require('../engine/whatsappEngine');
      await startWhatsAppBot(botData, false);
    }

    return res.json({ ok: true, message: 'Bot di-restart' });
  } catch (err) {
    console.error('[Bot] restartBot error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// ─── POST /api/bots/:id/clear-session ────────────────────────────────────────

async function clearSession(req, res) {
  try {
    const bot = await assertOwnership(req, res, req.params.id);
    if (!bot) return;

    if (activeBots.has(bot.id)) {
      const { stopWhatsAppBot } = require('../engine/whatsappEngine');
      await stopWhatsAppBot(bot.id);
    }

    // Hapus sesi — retry karena Windows bisa hold file SQLite walau socket udah tutup
    const dir = getBotDir(bot.id);
    if (fs.existsSync(dir)) {
      let deleted = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          deleted = true;
          break;
        } catch (e) {
          if (e.code === 'EPERM' || e.code === 'EBUSY') {
            // Windows masih hold file — tunggu lalu retry
            await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
          } else {
            throw e; // error lain langsung lempar
          }
        }
      }
      if (!deleted) {
        // Fallback: rename folder lama, buat folder baru bersih
        const oldDir = dir + '_old_' + Date.now();
        fs.renameSync(dir, oldDir);
        console.log(`[Bot] clearSession: folder ${dir} tidak bisa dihapus — direname ke ${oldDir}`);
      }
    }
    fs.mkdirSync(dir, { recursive: true });

    await pool.execute(
      "UPDATE bots SET status = 'disconnected', is_running = 0, sqlite_db_path = ? WHERE id = ?",
      [getDbPath(bot.id), bot.id]
    );

    // Log lama ikut dibuang — kalau nggak, panel nge-replay riwayat sesi
    // sebelumnya pas dibuka, keliatan kayak kejadian baru.
    await pool.execute('DELETE FROM bot_logs WHERE bot_id = ?', [bot.id]);

    return res.json({ ok: true, message: 'Sesi dihapus. Bot perlu scan QR ulang.' });
  } catch (err) {
    console.error('[Bot] clearSession error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// ─── GET /api/bots/:id/logs ───────────────────────────────────────────────────

async function getBotLogs(req, res) {
  try {
    const bot = await assertOwnership(req, res, req.params.id);
    if (!bot) return;

    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const [logs] = await pool.execute(
      'SELECT * FROM bot_logs WHERE bot_id = ? ORDER BY created_at DESC LIMIT ?',
      [bot.id, limit]
    );

    return res.json({ ok: true, logs: logs.reverse() });
  } catch (err) {
    console.error('[Bot] getBotLogs error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// ─── POST /api/bots/:id/resolve-invite ───────────────────────────────────────
// Body: { input: "https://chat.whatsapp.com/XXXX" | "120363xxx@g.us" }
// Returns: { ok: true, jid, name } or { ok: false, message }

async function resolveInvite(req, res) {
  try {
    const bot = await assertOwnership(req, res, req.params.id);
    if (!bot) return;

    const { input } = req.body;
    if (!input || typeof input !== 'string')
      return sendError(res, 400, 'Input tidak boleh kosong');

    const trimmed = input.trim();

    // Sudah JID — validasi format saja
    if (trimmed.endsWith('@g.us')) {
      const valid = /^\d+@g\.us$/.test(trimmed);
      if (!valid) return sendError(res, 400, 'Format JID tidak valid');
      return res.json({ ok: true, jid: trimmed, name: null });
    }

    // Extract invite code dari link WA
    const linkMatch = trimmed.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
    if (!linkMatch)
      return sendError(res, 400, 'Bukan link grup WhatsApp atau JID yang valid');

    const code = linkMatch[1];

    // Butuh bot aktif untuk resolve
    const client = activeBots.get(String(bot.id));
    if (!client)
      return sendError(res, 400, 'Bot harus aktif/terhubung untuk resolve link grup');

    try {
      const info = await client.group.queryGroupInviteInfo(code);
      const jid  = info.id || info.jid;
      const name = info.subject || info.name || null;
      if (!jid) return sendError(res, 400, 'Gagal mendapatkan JID dari link ini');
      return res.json({ ok: true, jid, name });
    } catch (e) {
      return sendError(res, 400, `Gagal resolve link: ${e.message}`);
    }
  } catch (err) {
    console.error('[Bot] resolveInvite error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

module.exports = {
  activeBots,
  activeGroupsPerBot,
  activeChannelsPerBot,
  listBots, getBot, createBot, updateBot, deleteBot,
  startBot, stopBot, restartBot, clearSession, getBotLogs, resolveInvite,
};
