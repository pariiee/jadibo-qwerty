'use strict';

const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const { pool, incrementStat, decrementStat } = require('../config/database');

const JWT_SECRET  = process.env.JWT_SECRET  || 'changeme';
const JWT_EXPIRES = process.env.JWT_EXPIRES_IN || '7d';
const MAX_SLOTS   = parseInt(process.env.MAX_SLOTS_PER_USER || '2', 10);

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

// ─── Middleware: only king ────────────────────────────────────────────────────

function requireKing(req, res, next) {
  if (req.user?.role !== 'king') {
    return sendError(res, 403, 'Akses ditolak: hanya King yang bisa melakukan ini');
  }
  next();
}

// ─── POST /api/auth/register ──────────────────────────────────────────────────

async function register(req, res) {
  try {
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
      'SELECT id, username, role, created_at FROM users WHERE id = ?',
      [req.user.id]
    );
    if (rows.length === 0) return sendError(res, 404, 'User tidak ditemukan');

    // slot usage
    const [bots] = await pool.execute(
      'SELECT COUNT(*) AS count FROM bots WHERE user_id = ?',
      [req.user.id]
    );

    return res.json({
      ok: true,
      user: {
        ...rows[0],
        slots_used: bots[0].count,
        slots_max: req.user.role === 'king' ? 999 : MAX_SLOTS,
      },
    });
  } catch (err) {
    console.error('[Auth] me error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// ─── GET /api/admin/users  (king only) ───────────────────────────────────────

async function listUsers(req, res) {
  try {
    const [users] = await pool.execute(
      `SELECT u.id, u.username, u.role, u.is_active, u.created_at,
              COUNT(b.id) AS bot_count
       FROM users u
       LEFT JOIN bots b ON b.user_id = u.id
       GROUP BY u.id
       ORDER BY u.created_at DESC`
    );
    return res.json({ ok: true, users });
  } catch (err) {
    console.error('[Auth] listUsers error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// ─── PATCH /api/admin/users/:id  (king only) ─────────────────────────────────

async function updateUser(req, res) {
  try {
    const { id } = req.params;
    const { is_active, role, password } = req.body;
    const sets = [];
    const vals = [];

    if (is_active !== undefined) { sets.push('is_active = ?'); vals.push(is_active ? 1 : 0); }
    if (role && ['user', 'king'].includes(role)) { sets.push('role = ?'); vals.push(role); }
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

// ─── DELETE /api/admin/users/:id  (king only) ────────────────────────────────

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
