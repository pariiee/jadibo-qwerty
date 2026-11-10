'use strict';

const path   = require('path');
const fs     = require('fs');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../config/database');
const { ADMIN_ROLE, slotsOf, ownerMax, receiveLimit, aktif } = require('../config/plan');
const { resolveBotId, pastikanSlug } = require('../config/botSlug');
const pricingStore = require('../config/pricingStore');

const SESSIONS_DIR = path.resolve(process.env.SESSIONS_DIR || './sessions');

const { activeBots, activeGroupsPerBot, activeChannelsPerBot } = require('../engine/runtime');
const engineBus = require('../config/engineBus');
const redisBus = require('../config/redisBus');

const os = require('os');

function cekKapasitasServer() {
  const freeMemMb = os.freemem() / (1024 * 1024);
  const totalMemMb = os.totalmem() / (1024 * 1024);
  const running = (typeof activeBots !== 'undefined' && activeBots) ? activeBots.size : 0;
  const maxConfig = parseInt(process.env.MAX_RUNNING_BOTS, 10);
  const maxBots = Number.isInteger(maxConfig) && maxConfig > 0
    ? maxConfig
    : Math.max(1, Math.floor((totalMemMb - 300) / 120));

  return {
    cukup: freeMemMb > 200 && running < maxBots,
    freeMemMb: Math.round(freeMemMb),
    totalMemMb: Math.round(totalMemMb),
    running,
    maxBots,
  };
}

async function validasiTokenPlatform(platform, token, ignoreBotId = null) {
  if (!token || typeof token !== 'string') return { ok: true };
  const clean = token.trim();
  if (!clean) return { ok: true };

  const [dup] = await pool.execute(
    `SELECT id, bot_name FROM bots WHERE (telegram_token = ? OR discord_token = ?) ${ignoreBotId ? 'AND id != ?' : ''} LIMIT 1`,
    ignoreBotId ? [clean, clean, ignoreBotId] : [clean, clean]
  );
  if (dup.length > 0) {
    return { ok: false, message: `Token ini sudah dipakai oleh bot "${dup[0].bot_name}". Gunakan bot lain atau token baru.` };
  }

  if (platform === 'telegram') {
    try {
      const meRes = await fetch(`https://api.telegram.org/bot${clean}/getMe`, { signal: AbortSignal.timeout(5000) });
      const meData = await meRes.json().catch(() => ({}));
      if (!meData.ok) {
        return { ok: false, message: `Token Telegram tidak valid: ${meData.description || 'Periksa kembali token bot kamu'}` };
      }

      const whRes = await fetch(`https://api.telegram.org/bot${clean}/getWebhookInfo`, { signal: AbortSignal.timeout(5000) });
      const whData = await whRes.json().catch(() => ({}));
      if (whData.ok && whData.result?.url) {
        await fetch(`https://api.telegram.org/bot${clean}/deleteWebhook?drop_pending_updates=true`, { signal: AbortSignal.timeout(5000) }).catch(() => {});
      }

      const pollRes = await fetch(`https://api.telegram.org/bot${clean}/getUpdates?offset=-1&limit=1&timeout=0`, { signal: AbortSignal.timeout(5000) });
      if (pollRes.status === 409) {
        return { ok: false, message: 'Bot ini sedang aktif berjalan di web/server lain (Conflict 409). Matikan bot lama dulu sebelum memasukkan ke sini.' };
      }
    } catch (e) {
      if (e.name === 'TimeoutError') {
        return { ok: false, message: 'Gagal memverifikasi ke server Telegram (timeout). Coba lagi beberapa saat.' };
      }
    }
  }

  if (platform === 'discord') {
    try {
      const res = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bot ${clean}` },
        signal: AbortSignal.timeout(5000)
      });
      if (res.status === 401) {
        return { ok: false, message: 'Token Bot Discord tidak valid. Salin ulang token dari Discord Developer Portal.' };
      }
      if (!res.ok) {
        return { ok: false, message: `Gagal memverifikasi token Discord (HTTP ${res.status}).` };
      }
    } catch (e) {
      if (e.name === 'TimeoutError') {
        return { ok: false, message: 'Gagal memverifikasi ke server Discord (timeout). Coba lagi beberapa saat.' };
      }
    }
  }

  return { ok: true };
}

function sendError(res, status, message) {
  return res.status(status).json({ ok: false, message });
}

const STATUS_MANUSIA = new Set([400, 403, 404, 409, 503, 504]);
function pesanManusia(e, fallback = 'Terjadi kesalahan server') {
  const st = Number(e?.status) || 0;
  const m = String(e?.message || '');
  return m && STATUS_MANUSIA.has(st) ? m : fallback;
}

function getBotDir(botId) {
  return path.join(SESSIONS_DIR, `bot_${botId}`);
}

function getDbPath(botId) {
  return path.join(getBotDir(botId), 'session.db');
}

async function assertOwnership(req, res, botId) {
  const idAngka = (await resolveBotId(botId)) ?? Number(botId);

  const [rows] = await pool.execute(
    'SELECT id, user_id, public_id, platform, receive_limit, received_count FROM bots WHERE id = ?',
    [idAngka]
  );
  if (rows.length === 0) { sendError(res, 404, 'Bot tidak ditemukan'); return null; }
  const bot = rows[0];
  if (req.user.role !== ADMIN_ROLE && bot.user_id !== req.user.id) {
    sendError(res, 403, 'Akses ditolak');
    return null;
  }
  if (!bot.public_id) bot.public_id = await pastikanSlug(bot.id);
  return bot;
}

function maskToken(token) {
  if (!token) return null;
  const parts = String(token).split(':');
  if (parts.length < 2) return '••••••••';
  const secret = parts[1];
  const masked = secret.length > 4
    ? '•'.repeat(secret.length - 4) + secret.slice(-4)
    : '•'.repeat(secret.length);
  return `${parts[0]}:${masked}`;
}

function getDiscordInviteUrl(token, perms = 'standard') {
  if (!token) return null;
  try {
    const part = String(token).split('.')[0];
    const decoded = Buffer.from(part, 'base64').toString('utf8');
    if (/^\d{16,21}$/.test(decoded)) {
      const p = perms === 'admin' ? '8' : '412317243456';
      return `https://discord.com/oauth2/authorize?client_id=${decoded}&permissions=${p}&scope=bot%20applications.commands`;
    }
  } catch {}
  return null;
}

function publicBot(bot) {
  if (!bot) return bot;
  const { telegram_token, discord_token, ...rest } = bot;
  const rawToken = discord_token || (bot.platform === 'discord' ? telegram_token : null);
  const discord_invite_url = bot.platform === 'discord' ? getDiscordInviteUrl(rawToken, 'standard') : null;
  const discord_invite_admin_url = bot.platform === 'discord' ? getDiscordInviteUrl(rawToken, 'admin') : null;
  const tgUser = bot.bot_number ? String(bot.bot_number).replace(/^@/, '') : null;
  const telegram_bot_url = bot.platform === 'telegram' && tgUser ? `https://t.me/${tgUser}` : null;
  return {
    ...rest,
    telegram_token: maskToken(telegram_token),
    discord_token: maskToken(discord_token),
    discord_invite_url,
    discord_invite_admin_url,
    telegram_bot_url,
  };
}

function denganSlug(bot) {
  if (!bot) return bot;
  const { public_id, ...rest } = publicBot(bot);
  return { ...rest, slug: public_id || null };
}

async function listBots(req, res) {
  try {
    const isKing = req.user.role === ADMIN_ROLE;
    const kolom = `b.*, (SELECT COUNT(*) FROM bot_logs l WHERE l.bot_id = b.id AND l.level = 'cmd') AS cmd_count, (SELECT kt.jumlah FROM kuota_tambahan kt WHERE kt.bot_id = b.id) AS bonus_kuota`;
    const limit = Math.min(parseInt(req.query.limit || '500', 10) || 500, 500);
    const q = String(req.query.q || '').trim().slice(0, 60);

    let where = '';
    const params = [];
    if (q) { where += ' AND (b.bot_name LIKE ? OR u.username LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
    if (!isKing) { where += ' AND b.user_id = ?'; params.push(req.user.id); }

    const query = isKing
      ? `SELECT ${kolom}, u.username FROM bots b JOIN users u ON u.id = b.user_id
         WHERE 1=1${where} ORDER BY b.created_at DESC LIMIT ${limit}`
      : `SELECT ${kolom}, NULL AS username FROM bots b
         WHERE 1=1${where} ORDER BY b.created_at DESC LIMIT ${limit}`;

    const [bots] = await pool.execute(query, params);
    const enriched = bots.map(b => ({
      ...denganSlug(b),
      username: b.username,
      is_running: b.is_running === 1,
    }));
    return res.json({ ok: true, bots: enriched });
  } catch (err) {
    console.error('[Bot] listBots error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

async function getBot(req, res) {
  try {
    const bot = await assertOwnership(req, res, req.params.id);
    if (!bot) return;

    const [rows] = await pool.execute('SELECT * FROM bots WHERE id = ?', [req.params.id]);
    return res.json({
      ok: true,
      bot: { ...denganSlug(rows[0]), is_running: rows[0].is_running === 1 },
    });
  } catch (err) {
    console.error('[Bot] getBot error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

async function createBot(req, res) {
  try {
    const cap = cekKapasitasServer();
    if (!cap.cukup && req.user.role !== ADMIN_ROLE) {
      return sendError(res, 503, `Kapasitas server VPS sedang penuh (RAM sisa ${cap.freeMemMb}MB). Hubungi admin.`);
    }

    const [me] = await pool.execute(
      'SELECT role, plan, plan_expired_at, plan_slots FROM users WHERE id = ?',
      [req.user.id]
    );
    const maks = slotsOf(me[0], pricingStore.plans());
    if (maks < 999) {
      const [count] = await pool.execute(
        'SELECT COUNT(*) AS c FROM bots WHERE user_id = ?',
        [req.user.id]
      );
      if (count[0].c >= maks)
        return sendError(res, 400, maks === 0
          ? 'Akun kamu belum punya slot bot. Klaim Trial gratis atau pilih paket di halaman Pricing.'
          : `Slot penuh. Paket kamu maksimal ${maks} bot — upgrade untuk tambah slot.`);
    }

    const {
      platform = 'whatsapp',
      bot_name,
      bot_number,
      owner_number,
      prefix = '!',
      footer_text = 'Powered by qwertygate',
      description = '',
      telegram_token = null,
      discord_token = null,
    } = req.body;

    if (!bot_name) return sendError(res, 400, 'Nama bot wajib diisi');
    if (!owner_number || !String(owner_number).trim()) {
      const lblOwner = platform === 'discord' ? 'Owner Discord ID' : (platform === 'telegram' ? 'Owner Telegram ID' : 'Nomor owner');
      return sendError(res, 400, `${lblOwner} wajib diisi`);
    }
    if (platform === 'telegram' && !telegram_token)
      return sendError(res, 400, 'Token Telegram wajib diisi untuk platform Telegram');
    if (platform === 'discord' && !discord_token && !telegram_token)
      return sendError(res, 400, 'Token Bot Discord wajib diisi untuk platform Discord');

    const ownerMaxN = ownerMax(me[0], pricingStore.plans());
    const jumlahOwner = String(owner_number || '').split(',').map((s) => s.trim()).filter(Boolean).length;
    if (jumlahOwner > ownerMaxN)
      return sendError(res, 400, ownerMaxN === 0
        ? 'Paket kamu belum bisa pakai Owner Number. Upgrade di halaman Pricing.'
        : `Paket kamu maksimal ${ownerMaxN} Owner Number.`);

    const dcToken = discord_token || (platform === 'discord' ? telegram_token : null);
    const tgToken = platform === 'telegram' ? telegram_token : null;
    const tokenCek = platform === 'telegram' ? tgToken : (platform === 'discord' ? dcToken : null);

    if (tokenCek) {
      const v = await validasiTokenPlatform(platform, tokenCek);
      if (!v.ok) return sendError(res, 400, v.message);
    }

    const isPaid = me[0] && (
      [ADMIN_ROLE, SUBADMIN_ROLE].includes(me[0].role) ||
      (me[0].plan !== 'trial' && !!me[0].plan_expired_at && new Date(me[0].plan_expired_at) > new Date())
    );
    const finalFooter = isPaid && footer_text ? String(footer_text).trim().slice(0, 100) : 'Powered by qwertygate';

    const [result] = await pool.execute(
      `INSERT INTO bots
         (user_id, platform, bot_name, bot_number, owner_number, prefix, footer_text,
          description, telegram_token, discord_token, receive_limit, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'disconnected')`,
      [req.user.id, platform, bot_name, bot_number || null, owner_number || null,
       prefix, finalFooter, description, tgToken, dcToken,
       receiveLimit(me[0], pricingStore.plans())]
    );

    const botId = result.insertId;

    const slug = await pastikanSlug(botId);

    const dbPath = getDbPath(botId);

    fs.mkdirSync(getBotDir(botId), { recursive: true });

    await pool.execute(
      'UPDATE bots SET sqlite_db_path = ? WHERE id = ?',
      [dbPath, botId]
    );

    return res.status(201).json({
      ok: true,
      message: 'Bot berhasil dibuat',
      bot_id: botId,
      slug: slug || null,
    });
  } catch (err) {
    console.error('[Bot] createBot error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

async function updateBot(req, res) {
  try {
    const bot = await assertOwnership(req, res, req.params.id);
    if (!bot) return;

    const allowed = ['bot_name', 'bot_number', 'owner_number', 'owner_name', 'prefix', 'footer_text', 'description', 'telegram_token', 'discord_token', 'channel_id', 'qris_url', 'banner_url', 'main_groups', 'daily_limit'];
    const sets = [];
    const vals = [];

    if (req.body.owner_number !== undefined) {
      const [me] = await pool.execute(
        'SELECT role, plan, plan_expired_at FROM users WHERE id = ?', [req.user.id]);
      const maks = ownerMax(me[0], pricingStore.plans());
      const n = String(req.body.owner_number || '').split(',').map((s) => s.trim()).filter(Boolean).length;
      if (n > maks)
        return sendError(res, 400, maks === 0
          ? 'Paket kamu belum bisa pakai Owner Number. Upgrade di halaman Pricing.'
          : `Paket kamu maksimal ${maks} Owner Number.`);
    }

    if (req.body.footer_text !== undefined) {
      const [me] = await pool.execute('SELECT role, plan, plan_expired_at FROM users WHERE id = ?', [req.user.id]);
      const isPaid = me[0] && (
        [ADMIN_ROLE, SUBADMIN_ROLE].includes(me[0].role) ||
        (me[0].plan !== 'trial' && !!me[0].plan_expired_at && new Date(me[0].plan_expired_at) > new Date())
      );
      if (!isPaid) {
        return sendError(res, 403, 'Fitur custom footer hanya tersedia untuk langganan berbayar (bukan akun Trial).');
      }
    }

    if (req.body.owner_number !== undefined && !String(req.body.owner_number).trim()) {
      const lblOwner = bot.platform === 'discord' ? 'Owner Discord ID' : (bot.platform === 'telegram' ? 'Owner Telegram ID' : 'Nomor owner');
      return sendError(res, 400, `${lblOwner} tidak boleh dikosongkan`);
    }

    const tokenBaru = bot.platform === 'telegram' ? req.body.telegram_token : (bot.platform === 'discord' ? req.body.discord_token : null);
    if (tokenBaru && !String(tokenBaru).includes('•')) {
      const v = await validasiTokenPlatform(bot.platform, tokenBaru, bot.id);
      if (!v.ok) return sendError(res, 400, v.message);
    }

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        if ((key === 'telegram_token' || key === 'discord_token') && String(req.body[key]).includes('•')) continue;
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

async function deleteBot(req, res) {
  try {
    const bot = await assertOwnership(req, res, req.params.id);
    if (!bot) return;

    await engineBus.stopIfRunning(bot.id);

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

async function startBot(req, res) {
  try {
    const cap = cekKapasitasServer();
    if (!cap.cukup && req.user.role !== ADMIN_ROLE) {
      if (cap.freeMemMb <= 200) {
        return sendError(res, 503, `Kapasitas server sedang penuh (RAM sisa ${cap.freeMemMb}MB). Tunggu beberapa saat.`);
      }
      return sendError(res, 503, `Slot bot aktif di server sedang penuh (${cap.running}/${cap.maxBots} bot berjalan). Silakan coba beberapa saat lagi.`);
    }

    const bot = await assertOwnership(req, res, req.params.id);
    if (!bot) return;

    const [rows] = await pool.execute('SELECT * FROM bots WHERE id = ?', [bot.id]);
    const botData = rows[0];

    if (botData && botData.stop_reason === 'expired' && req.user.role !== ADMIN_ROLE) {
      const [u] = await pool.execute(
        'SELECT role, plan_expired_at FROM users WHERE id = ?', [botData.user_id]);
      if (!aktif(u[0])) {
        return sendError(res, 402,
          'Masa paket sudah habis. Perpanjang paket dulu sebelum menyalakan bot.');
      }
    }

    const usePairingCode = req.body.use_pairing_code === true;
    const out = await engineBus.start(bot.id, usePairingCode);
    redisBus.publishEvent({ botId: bot.id, type: 'status', payload: { status: 'connecting' }, ts: Date.now() });
    return res.json({ ok: true, message: out.message });
  } catch (err) {
    console.error('[Bot] startBot error:', err);
    return sendError(res, err.status || 500, pesanManusia(err));
  }
}

async function stopBot(req, res) {
  try {
    const bot = await assertOwnership(req, res, req.params.id);
    if (!bot) return;

    const out = await engineBus.stop(bot.id);
    redisBus.publishEvent({ botId: bot.id, type: 'status', payload: { status: 'disconnected' }, ts: Date.now() });

    return res.json({ ok: true, message: out.message });
  } catch (err) {
    console.error('[Bot] stopBot error:', err);
    return sendError(res, err.status || 500, pesanManusia(err));
  }
}

async function restartBot(req, res) {
  try {
    const bot = await assertOwnership(req, res, req.params.id);
    if (!bot) return;

    await pool.execute('DELETE FROM bot_logs WHERE bot_id = ?', [bot.id]);

    const out = await engineBus.restart(bot.id);
    redisBus.publishEvent({ botId: bot.id, type: 'status', payload: { status: 'connecting' }, ts: Date.now() });
    return res.json({ ok: true, message: out.message });
  } catch (err) {
    console.error('[Bot] restartBot error:', err);
    return sendError(res, err.status || 500, pesanManusia(err));
  }
}

async function clearBotLogs(req, res) {
  try {
    const bot = await assertOwnership(req, res, req.params.id);
    if (!bot) return;

    await pool.execute('DELETE FROM bot_logs WHERE bot_id = ?', [bot.id]);
    return res.json({ ok: true, message: 'Log terminal dibersihkan' });
  } catch (err) {
    console.error('[Bot] clearBotLogs error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

async function clearSession(req, res) {
  try {
    const bot = await assertOwnership(req, res, req.params.id);
    if (!bot) return;

    await engineBus.stopIfRunning(bot.id);
    redisBus.publishEvent({ botId: bot.id, type: 'status', payload: { status: 'disconnected' }, ts: Date.now() });
    redisBus.publishEvent({ botId: bot.id, type: 'clear_terminal', ts: Date.now() });

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
            throw e; // error lain langsung lempar
          }
        }
      }
      if (!deleted) {
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

    await pool.execute('DELETE FROM bot_logs WHERE bot_id = ?', [bot.id]);

    return res.json({ ok: true, message: 'Sesi dihapus. Bot perlu scan QR ulang.' });
  } catch (err) {
    console.error('[Bot] clearSession error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

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

const ADA_AT   = `LOCATE(' @ ', message) > 0`;
const ADA_KOLOM = `LOCATE(': ', message) > 0`;
const AT_DULU  = `(${ADA_AT} AND (NOT ${ADA_KOLOM} OR LOCATE(' @ ', message) < LOCATE(': ', message)))`;
const NAMA = `TRIM(REGEXP_REPLACE(REGEXP_REPLACE(IF(${AT_DULU},
  SUBSTRING_INDEX(message, ' @ ', 1),
  SUBSTRING_INDEX(message, ': ', 1)),
  ' \\\\(\\\\+[0-9]+ms\\\\)$', ''), ' \\\\[[^]]*\\\\]$', ''))`;
const GRUP = `TRIM(IF(${AT_DULU},
  REGEXP_REPLACE(REGEXP_REPLACE(
    SUBSTRING_INDEX(SUBSTRING(message, LOCATE(' @ ', message) + 3), ': ', 1),
    ' \\\\(\\\\+[0-9]+ms\\\\)$', ''), ' \\\\[[^]]*\\\\]$', ''),
  ''))`;
const BODY = `TRIM(REGEXP_REPLACE(SUBSTRING(message, LOCATE(': ', message) + 2), ' \\\\(\\\\+[0-9]+ms\\\\)$', ''))`;
const CMD   = `TRIM(SUBSTRING_INDEX(${BODY}, ' ', 1))`;
const WAKTU = `CAST(REGEXP_SUBSTR(message, '[0-9]+ms') AS UNSIGNED)`;

const BARIS_USER = `(${ADA_KOLOM} OR ${ADA_AT})`;
const CMD_OK = `cmd LIKE '.%' AND TRIM(BOTH '.' FROM cmd) <> ''`;

async function getBotStats(req, res) {
  try {
    const bot = await assertOwnership(req, res, req.params.id);
    if (!bot) return;

    const hari = Math.min(Math.max(parseInt(req.query.hari || '7', 10) || 7, 1), 365);

    const [[ringkas]] = await pool.execute(
      `SELECT
         SUM(level = 'cmd')    AS cmd_total,
         SUM(level = 'cmderr') AS err_total,
         SUM(level = 'limit')  AS limit_total,
         COUNT(*)              AS baris_total,
         COUNT(DISTINCT IF(level IN ('cmd','info') AND ${BARIS_USER}, ${NAMA}, NULL)) AS usr_total,
         COUNT(DISTINCT IF(level = 'cmd' AND ${BARIS_USER}, ${CMD}, NULL))           AS cmd_unik
       FROM bot_logs WHERE bot_id = ?`,
      [bot.id]
    );

    const [cmd] = await pool.execute(
      `SELECT ${CMD} AS cmd, COUNT(*) AS n, AVG(${WAKTU}) AS ms
         FROM bot_logs
        WHERE bot_id = ? AND level = 'cmd' AND ${ADA_KOLOM}
        GROUP BY cmd HAVING ${CMD_OK}
        ORDER BY n DESC, cmd LIMIT 5`,
      [bot.id]
    );

    const [usr] = await pool.execute(
      `SELECT
         ${NAMA} AS nama,
         ${GRUP} AS grup,
         SUM(level = 'cmd') AS ncmd,
         COUNT(*) AS n,
         MAX(created_at) AS terakhir
       FROM bot_logs
      WHERE bot_id = ? AND level IN ('cmd','info') AND ${BARIS_USER}
      GROUP BY nama, grup ORDER BY n DESC LIMIT 15`,
      [bot.id]
    );

    const [harianRaw] = await pool.execute(
      `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS tgl, COUNT(*) AS n
         FROM bot_logs
        WHERE bot_id = ? AND level = 'cmd' AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        GROUP BY tgl ORDER BY tgl`,
      [bot.id, hari]
    );

    const petaHarian = new Map(harianRaw.map(r => [String(r.tgl), Number(r.n || 0)]));
    const harian = [];
    for (let i = hari - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const kunci = `${y}-${m}-${day}`;
      harian.push({ tgl: kunci, n: petaHarian.get(kunci) || 0 });
    }

    const [error] = await pool.execute(
      `SELECT ${CMD} AS cmd, COUNT(*) AS n
         FROM bot_logs
        WHERE bot_id = ? AND level = 'cmderr' AND ${ADA_KOLOM}
        GROUP BY cmd HAVING cmd LIKE '.%'
        ORDER BY n DESC LIMIT 8`,
      [bot.id]
    );

    return res.json({
      ok: true,
      bot: {
        id: bot.id,
        platform: bot.platform,
        receive_limit: Number(bot.receive_limit || 0),
        receive_count: Number(bot.received_count || 0),
      },
      ringkas: {
        cmd_total:   Number(ringkas.cmd_total || 0),
        cmd_unik:    Number(ringkas.cmd_unik || 0),
        user_aktif:  Number(ringkas.usr_total || 0),
        err_total:   Number(ringkas.err_total || 0),
        limit_total: Number(ringkas.limit_total || 0),
        baris_total: Number(ringkas.baris_total || 0),
        hari,
      },
      cmd: cmd.map(c => ({ ...c, n: Number(c.n), ms: c.ms === null ? null : Math.round(Number(c.ms)) })),
      user: usr.map(u => ({ ...u, ncmd: Number(u.ncmd || 0), n: Number(u.n || 0) })),
      error: error.map(e => ({ ...e, n: Number(e.n) })),
      harian,
    });
  } catch (err) {
    console.error('[Bot] getBotStats error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

async function exportConfig(req, res) {
  try {
    const own = await assertOwnership(req, res, req.params.id);
    if (!own) return;
    const [[bot]] = await pool.execute('SELECT * FROM bots WHERE id = ?', [own.id]);
    if (!bot) return sendError(res, 404, 'Bot tidak ditemukan');

    const { id, user_id, is_running, status, sqlite_db_path, created_at, updated_at, ...cfg } = publicBot(bot);
    const nama = String(bot.bot_name || 'bot').replace(/[^\w.-]+/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="config-${bot.id}-${nama}.json"`);
    return res.json({ v: 1, bot: cfg });
  } catch (err) {
    console.error('[Bot] exportConfig error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

async function resolveInvite(req, res) {
  try {
    const bot = await assertOwnership(req, res, req.params.id);
    if (!bot) return;

    const { input } = req.body;
    if (!input || typeof input !== 'string')
      return sendError(res, 400, 'Input tidak boleh kosong');

    const trimmed = input.trim();

    if (trimmed.endsWith('@g.us')) {
      const valid = /^\d+@g\.us$/.test(trimmed);
      if (!valid) return sendError(res, 400, 'Format JID tidak valid');
      return res.json({ ok: true, jid: trimmed, name: null });
    }

    const linkMatch = trimmed.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
    if (!linkMatch)
      return sendError(res, 400, 'Bukan link grup WhatsApp atau JID yang valid');

    const code = linkMatch[1];

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
      console.error('[Bot] resolveInvite gagal:', e.message);
      return sendError(res, 400, 'Link undangan tidak bisa dibaca. Pastikan link masih aktif.');
    }
  } catch (err) {
    console.error('[Bot] resolveInvite error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

async function beliRespon(req, res) {
  const conn = await pool.getConnection();
  try {
    const bot = await assertOwnership(req, res, req.params.id);
    if (!bot) { conn.release(); return; }

    const BIAYA = 500;
    const TAMBAHAN_RESPON = 1000;

    await conn.beginTransaction();
    const [w] = await conn.execute(
      'SELECT saldo FROM wallets WHERE user_id = ? FOR UPDATE',
      [req.user.id]
    );
    const saldo = Number(w[0]?.saldo || 0);
    if (saldo < BIAYA) {
      await conn.rollback();
      conn.release();
      return sendError(res, 400,
        `Saldo tidak cukup (butuh Rp 500, saldo kamu Rp ${saldo.toLocaleString('id-ID')}). Top up saldo dulu.`);
    }

    const saldoBaru = saldo - BIAYA;
    await conn.execute('UPDATE wallets SET saldo = ? WHERE user_id = ?', [saldoBaru, req.user.id]);
    
    const ref = `addon-respon:${req.user.id}:${bot.id}:${Date.now()}`;
    await conn.execute(
      `INSERT INTO wallet_ledger (user_id, tipe, jumlah, saldo_akhir, ref, catatan)
       VALUES (?, 'perpanjang', ?, ?, ?, ?)`,
      [req.user.id, -BIAYA, saldoBaru, ref, `Tambah 1.000 respon bot #${bot.id}`]
    );

    await conn.execute(
      'UPDATE bots SET receive_limit = receive_limit + ? WHERE id = ?',
      [TAMBAHAN_RESPON, bot.id]
    );

    await conn.commit();
    conn.release();

    const [b] = await pool.execute('SELECT receive_limit FROM bots WHERE id = ?', [bot.id]);
    return res.json({
      ok: true,
      message: 'Berhasil menambah 1.000 kuota respon!',
      receive_limit: b[0]?.receive_limit || 0,
      saldo: saldoBaru,
    });
  } catch (err) {
    await conn.rollback();
    conn.release();
    console.error('[Bot] beliRespon error:', err);
    return sendError(res, 500, 'Gagal menambah kuota respon');
  }
}

module.exports = {
  listBots, getBot, createBot, updateBot, deleteBot,
  startBot, stopBot, restartBot, clearSession, getBotLogs, clearBotLogs, getBotStats, exportConfig,
  resolveInvite, beliRespon,
  activeBots, activeGroupsPerBot, activeChannelsPerBot,
};

