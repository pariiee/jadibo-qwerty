'use strict';

const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const { pool, incrementStat, decrementStat } = require('../config/database');
const { ADMIN_ROLE, roleOf, slotsOf } = require('../config/plan');
const pricingStore = require('../config/pricingStore');
const billing = require('./billingController');

// Tanpa fallback: kalau .env bolong, server nolak boot (guard di server.js).
// Fallback literal bikin token siapa pun bisa dipalsukan tanpa jejak.
const JWT_SECRET  = process.env.JWT_SECRET;
const JWT_EXPIRES = process.env.JWT_EXPIRES_IN || '7d';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function sendError(res, status, message) {
  return res.status(status).json({ ok: false, message });
}

// ─── Middleware: verify JWT from cookie or Authorization header ───────────────

function requireAuth(req, res, next) {
  try {
    const token =
      req.cookies?.token ||
      (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : null);

    if (!token) return sendError(res, 401, 'Tidak terautentikasi');

    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { id, username, role }
    next();
  } catch {
    return sendError(res, 401, 'Token tidak valid atau sudah kadaluarsa');
  }
}

// ─── Middleware: izin admin tertinggi (role internal `kawula`) ──────────────
// Satu tempat untuk cek izin admin. Kalau nama role berubah, cukup ubah
// ADMIN_ROLE di config/plan.js — jangan sebar string 'kawula' di file lain.
function requireKing(req, res, next) {
  if (req.user?.role !== ADMIN_ROLE) {
    return sendError(res, 403, 'Akses ditolak');
  }
  next();
}

// ─── POST /api/auth/register ──────────────────────────────────────────────────

async function register(req, res) {
  try {
    // Registrasi publik default TUTUP. Buka dengan ALLOW_REGISTER=1 di .env.
    if (process.env.ALLOW_REGISTER !== '1')
      return sendError(res, 403, 'Registrasi ditutup. Hubungi admin.');

    const { username, password } = req.body;

    if (!username || !password)
      return sendError(res, 400, 'Username dan password wajib diisi');

    if (username.length < 3 || username.length > 50)
      return sendError(res, 400, 'Username harus 3-50 karakter');

    if (password.length < 6)
      return sendError(res, 400, 'Password minimal 6 karakter');

    if (!/^[a-zA-Z0-9_]+$/.test(username))
      return sendError(res, 400, 'Username hanya boleh huruf, angka, dan underscore');

    const [existing] = await pool.execute(
      'SELECT id FROM users WHERE username = ?',
      [username]
    );
    if (existing.length > 0)
      return sendError(res, 409, 'Username sudah digunakan');

    const hashed = await bcrypt.hash(password, 12);
    const [result] = await pool.execute(
      'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
      [username, hashed, 'user']
    );

    await incrementStat('total_users');

    // Trial 5 hari otomatis buat akun baru (sekali seumur akun).
    await billing.klaimTrial(result.insertId).catch(() => {});

    const token = signToken({ id: result.insertId, username, role: 'user' });

    res.cookie('token', token, {
      httpOnly: true,
      // req.protocol (bukan NODE_ENV): produksi diakses via HTTPS tunnel DAN
      // HTTP :3000. Cookie Secure di jalur HTTP dibuang browser -> login sukses
      // tapi /dashboard selalu 401 dan balik ke '/'.
      secure: req.protocol === 'https',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.status(201).json({
      ok: true,
      message: 'Registrasi berhasil',
      user: { id: result.insertId, username, role: 'user' },
      token,
    });
  } catch (err) {
    console.error('[Auth] register error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// ─── POST /api/auth/login ─────────────────────────────────────────────────────

async function login(req, res) {
  try {
    const { username, password } = req.body;

    if (!username || !password)
      return sendError(res, 400, 'Username dan password wajib diisi');

    const [rows] = await pool.execute(
      'SELECT id, username, password, role, is_active FROM users WHERE username = ?',
      [username]
    );

    if (rows.length === 0)
      return sendError(res, 401, 'Username atau password salah');

    const user = rows[0];

    if (!user.is_active)
      return sendError(res, 403, 'Akun dinonaktifkan. Hubungi admin');

    const match = await bcrypt.compare(password, user.password);
    if (!match)
      return sendError(res, 401, 'Username atau password salah');

    const token = signToken({ id: user.id, username: user.username, role: user.role });

    res.cookie('token', token, {
      httpOnly: true,
      // req.protocol (bukan NODE_ENV): produksi diakses via HTTPS tunnel DAN
      // HTTP :3000. Cookie Secure di jalur HTTP dibuang browser -> login sukses
      // tapi /dashboard selalu 401 dan balik ke '/'.
      secure: req.protocol === 'https',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.json({
      ok: true,
      message: 'Login berhasil',
      user: { id: user.id, username: user.username, role: user.role },
      token,
    });
  } catch (err) {
    console.error('[Auth] login error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// ─── POST /api/auth/logout ────────────────────────────────────────────────────

function logout(req, res) {
  res.clearCookie('token');
  return res.json({ ok: true, message: 'Logout berhasil' });
}

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────

async function me(req, res) {
  try {
    const [rows] = await pool.execute(
      'SELECT id, username, role, plan, plan_expired_at, plan_slots, trial_used_at, created_at FROM users WHERE id = ?',
      [req.user.id]
    );
    if (rows.length === 0) return sendError(res, 404, 'User tidak ditemukan');

    // Trial 5 hari diklaim di sini, bukan lewat skrip migrasi: akun lama pun
    // kebagian sekali, akun baru langsung dapat. `trial_used_at` penjaganya.
    if (!rows[0].trial_used_at) {
      const trial = await billing.klaimTrial(req.user.id);
      if (trial) {
        const [ulang] = await pool.execute(
          'SELECT id, username, role, plan, plan_expired_at, plan_slots, trial_used_at, created_at FROM users WHERE id = ?',
          [req.user.id]
        );
        rows[0] = ulang[0];
      }
    }

    // slot usage
    const [bots] = await pool.execute(
      'SELECT COUNT(*) AS count FROM bots WHERE user_id = ?',
      [req.user.id]
    );

    const u = rows[0];
    const admin = u.role === ADMIN_ROLE;
    const paketId = admin ? 'ultra' : (roleOf(u) === 'premium' ? u.plan : 'user');
    const plan = pricingStore.getPlan(paketId);

    return res.json({
      ok: true,
      user: {
        id: u.id,
        username: u.username,
        // role EFEKTIF: langganan lewat = otomatis turun, tanpa cron.
        role: roleOf(u),
        // Label untuk tampilan. Dashboard TIDAK boleh menulis nama role mentah,
        // biar nama internal admin tidak muncul di UI.
        role_label: u.role === ADMIN_ROLE ? 'Administrator'
                  : roleOf(u) === 'premium' ? 'Premium' : 'User',
        is_admin: admin,
        plan_id: plan.id,
        plan_name: plan.name,
        plan_expired_at: u.plan_expired_at,
        plan_aktif: !!u.plan_expired_at && new Date(u.plan_expired_at) > new Date(),
        trial_used: !!u.trial_used_at,
        trial_hari: pricingStore.all().trial_days,
        trial_used_at: u.trial_used_at,
        slots_used: bots[0].count,
        slots_max: slotsOf(u, pricingStore.plans()),
        daily_limit: plan.daily_limit,
        created_at: u.created_at,
      },
    });
  } catch (err) {
    console.error('[Auth] me error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// ─── GET /api/admin/users  (admin tertinggi saja) ────────────────────────────

async function listUsers(req, res) {
  try {
    const [users] = await pool.execute(
      `SELECT u.id, u.username, u.role, u.plan, u.plan_expired_at, u.plan_slots,
              u.trial_used_at, u.is_active, u.created_at,
              COUNT(b.id) AS bot_count
       FROM users u
       LEFT JOIN bots b ON b.user_id = u.id
       GROUP BY u.id
       ORDER BY u.created_at DESC`
    );
    // Role efektif + langganan dihitung di sini, bukan di klien: aturan
    // "langganan lewat = turun jadi user" cuma boleh hidup di config/plan.js.
    const paket = pricingStore.plans();
    return res.json({
      ok: true,
      users: users.map((u) => ({
        ...u,
        role_efektif: roleOf(u),
        plan_name: pricingStore.getPlan(u.plan).name,
        langganan_aktif: !!u.plan_expired_at && new Date(u.plan_expired_at) > new Date(),
        slots_max: slotsOf(u, paket),
        bot_count: Number(u.bot_count),
      })),
    });
  } catch (err) {
    console.error('[Auth] listUsers error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// ─── PATCH /api/admin/users/:id  (admin tertinggi saja) ──────────────────────

async function updateUser(req, res) {
  try {
    const { id } = req.params;
    const { is_active, role, password, plan, plan_expired_at, plan_slots } = req.body;
    const sets = [];
    const vals = [];

    // Kolom `role` cuma kenal dua nilai: user biasa atau admin tertinggi.
    // 'premium' BUKAN role tersimpan — dia turunan langganan yang aktif, jadi
    // memberikannya lewat kolom role akan langsung hilang saat roleOf() jalan.
    if (role && ['user', ADMIN_ROLE].includes(role)) {
      // Jangan sampai admin mengunci dirinya sendiri keluar dari dashboard.
      if (Number(id) === Number(req.user.id) && role !== ADMIN_ROLE)
        return sendError(res, 400, 'Tidak bisa menurunkan akun sendiri');
      sets.push('role = ?'); vals.push(role);
    }
    if (is_active !== undefined) {
      if (Number(id) === Number(req.user.id) && !is_active)
        return sendError(res, 400, 'Tidak bisa menonaktifkan akun sendiri');
      sets.push('is_active = ?'); vals.push(is_active ? 1 : 0);
    }
    // Langganan: admin bisa kasih/ubah paket & masa aktif langsung dari dashboard.
    if (plan && pricingStore.getPlan(plan).id === plan) {
      sets.push('plan = ?'); vals.push(plan);
      sets.push('plan_slots = ?'); vals.push(pricingStore.getPlan(plan).slots);
    }
    if (plan_slots !== undefined) { sets.push('plan_slots = ?'); vals.push(parseInt(plan_slots, 10) || 0); }
    if (plan_expired_at !== undefined) {
      sets.push('plan_expired_at = ?');
      vals.push(plan_expired_at ? new Date(plan_expired_at) : null);
    }
    if (password) {
      const hashed = await bcrypt.hash(password, 12);
      sets.push('password = ?');
      vals.push(hashed);
    }

    if (sets.length === 0) return sendError(res, 400, 'Tidak ada field yang diubah');

    vals.push(id);
    await pool.execute(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, vals);

    return res.json({ ok: true, message: 'User diperbarui' });
  } catch (err) {
    console.error('[Auth] updateUser error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// ─── DELETE /api/admin/users/:id  (admin tertinggi saja) ─────────────────────

async function deleteUser(req, res) {
  try {
    const { id } = req.params;
    if (parseInt(id, 10) === req.user.id)
      return sendError(res, 400, 'Tidak bisa menghapus akun sendiri');

    await pool.execute('DELETE FROM users WHERE id = ?', [id]);
    await decrementStat('total_users');

    return res.json({ ok: true, message: 'User dihapus' });
  } catch (err) {
    console.error('[Auth] deleteUser error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

module.exports = {
  register, login, logout, me,
  listUsers, updateUser, deleteUser,
  requireAuth, requireKing,
};
