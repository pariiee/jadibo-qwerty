'use strict';

const crypto    = require('crypto');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const { pool } = require('../config/database');
const { ADMIN_ROLE, roleOf, slotsOf, paketOf } = require('../config/plan');
const pricingStore = require('../config/pricingStore');

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

async function requireAuth(req, res, next) {
  let decoded;
  try {
    const token =
      req.cookies?.token ||
      (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : null);

    if (!token) return sendError(res, 401, 'Tidak terautentikasi');

    decoded = jwt.verify(token, JWT_SECRET);
  } catch {
    return sendError(res, 401, 'Token tidak valid atau sudah kadaluarsa');
  }

  // Sesi itu stateless: tanpa cek ini, ganti password TIDAK memutus sesi mana
  // pun — orang yang sudah login di perangkat lain masih masuk sampai tokennya
  // kedaluwarsa (7 hari). `token_version` di token harus sama dengan di DB;
  // ganti password menaikkannya, jadi semua token lama langsung mati.
  //
  // Satu query PK per request ber-auth. Duit & keamanan bukan tempat ngirit.
  try {
    const [rows] = await pool.execute('SELECT token_version FROM users WHERE id = ?', [decoded.id]);
    if (!rows.length) return sendError(res, 401, 'User tidak ditemukan');
    if (Number(rows[0].token_version || 0) !== Number(decoded.tv || 0)) {
      return sendError(res, 401, 'Sesi sudah tidak berlaku, silakan masuk lagi');
    }
  } catch (err) {
    console.error('[Auth] cek token_version error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }

  req.user = decoded; // { id, username, role, tv }
  next();
}

// ─── Middleware: izin admin tertinggi (role internal `kawula`) ──────────────
// Satu tempat untuk cek izin admin. Kalau nama role berubah, cukup ubah
// ADMIN_ROLE di config/plan.js — jangan sebar string 'kawula' di file lain.
//
// Role dibaca dari DB, BUKAN dari `req.user.role`. Token nyimpen role pas login;
// kalau role diubah setelah itu, token lama tetap bilang yang lama — admin yang
// sah ditolak 403 ("balik ke dashboard") sampai dia login ulang. Sekalian nutup
// lubang `is_active`: akun yang dinonaktifkan tetap bisa nembus kalau cuma
// percaya token.
async function requireKing(req, res, next) {
  try {
    const [rows] = await pool.execute(
      'SELECT role, is_active FROM users WHERE id = ?',
      [req.user?.id]
    );
    const u = rows[0];
    if (!u || !u.is_active || u.role !== ADMIN_ROLE)
      return sendError(res, 403, 'Akses ditolak — akun ini bukan administrator');

    req.user.role = u.role;
    next();
  } catch (err) {
    console.error('[Auth] requireKing error:', err);
    return sendError(res, 403, 'Akses ditolak');
  }
}

// ─── POST /api/auth/register ──────────────────────────────────────────────────

async function register(req, res) {
  try {
    // Registrasi publik default TUTUP. Buka dengan ALLOW_REGISTER=1 di .env.
    if (process.env.ALLOW_REGISTER !== '1')
      return sendError(res, 403, 'Registrasi ditutup. Hubungi admin.');

    const { username, password, email } = req.body;

    if (!username || !password)
      return sendError(res, 400, 'Username dan password wajib diisi');

    if (username.length < 3 || username.length > 50)
      return sendError(res, 400, 'Username harus 3-50 karakter');

    if (password.length < 8)
      return sendError(res, 400, 'Password minimal 8 karakter');

    if (!/^[a-zA-Z0-9_]+$/.test(username))
      return sendError(res, 400, 'Username hanya boleh huruf, angka, dan underscore');

    let bersihEmail = null;
    if (email) {
      const { emailValid } = require('../engine/email');
      bersihEmail = String(email).trim().toLowerCase();
      if (!emailValid(bersihEmail))
        return sendError(res, 400, 'Format email tidak valid');
    }

    const [existing] = await pool.execute(
      'SELECT id FROM users WHERE username = ?',
      [username]
    );
    if (existing.length > 0)
      return sendError(res, 409, 'Username sudah digunakan');

    const hashed = await bcrypt.hash(password, 12);
    const [result] = await pool.execute(
      'INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, ?)',
      [username, bersihEmail, hashed, 'user']
    );


    // Trial TIDAK auto-aktif — user harus buka /pricing dan klik klaim sendiri
    // (POST /api/billing/trial). Auto-di sini bikin akun baru langsung nyala
    // tanpa diminta dan bikin tombol klaimnya jadi mubazir.

    const token = signToken({ id: result.insertId, username, role: 'user', tv: 0 });

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
      'SELECT id, username, password, role, is_active, token_version FROM users WHERE username = ?',
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

    const token = signToken({ id: user.id, username: user.username, role: user.role, tv: Number(user.token_version || 0) });

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
      'SELECT id, username, role, plan, plan_expired_at, plan_slots, trial_used_at, phone, email, created_at FROM users WHERE id = ?',
      [req.user.id]
    );
    if (rows.length === 0) return sendError(res, 404, 'User tidak ditemukan');

    // JANGAN klaim trial di sini. Dulu iya ("akun baru langsung dapat"), tapi
    // efeknya SETIAP halaman yang manggil /api/auth/me ngeklaim trial tanpa
    // user minta — role langsung Unreal, langganan lompat 5 hari, dan tombol
    // "Klaim Trial" di /pricing jadi mubazir. Sekarang cuma POST
    // /api/billing/trial (klaimTrialSendiri) yang boleh nyalain.

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
                  : roleOf(u) === 'premium' ? 'Unreal' : 'Basic',
        is_admin: admin,
        plan_id: plan.id,
        plan_name: plan.name,
        phone: u.phone || '',
        plan_expired_at: u.plan_expired_at,
        plan_aktif: !!u.plan_expired_at && new Date(u.plan_expired_at) > new Date(),
        trial_used: !!u.trial_used_at,
        trial_hari: pricingStore.all().trial_days,
        trial_used_at: u.trial_used_at,
        slots_used: bots[0].count,
        slots_max: slotsOf(u, pricingStore.plans()),
        // Kartu dashboard mau "slot yang dibeli", dan itu BUKAN `slotsOf()` —
        // yang itu jatah OPERASIONAL (admin 999, plus kolom `plan_slots` yang
        // menang atas paket). Urutannya: jatah paket dulu, baru override admin.
        slots_beli: (paketOf(u.plan, pricingStore.plans())?.slots ?? Number(u.plan_slots)) || 0,
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
    // `total_users` dihitung dari tabel users saat dibaca (getStats) —
    // counter-nya dulu sempat tampil 5 padahal usernya 2.

    return res.json({ ok: true, message: 'User dihapus' });
  } catch (err) {
    console.error('[Auth] deleteUser error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// ─── POST /api/auth/password  (user ganti password sendiri) ──────────────────
// Wajib sebut password LAMA. Sesi itu stateless (JWT), jadi siapa pun yang
// pegang cookie bisa ganti password kalau nggak dicek — dan pemiliknya
// terkunci di luar akunnya sendiri.
async function gantiPassword(req, res) {
  try {
    const lama = String(req.body?.lama || '');
    const baru = String(req.body?.baru || '');
    if (!lama || !baru)   return sendError(res, 400, 'Password lama dan baru wajib diisi');
    if (baru.length < 6)  return sendError(res, 400, 'Password baru minimal 6 karakter');
    if (baru === lama)    return sendError(res, 400, 'Password baru sama dengan yang lama');

    const [rows] = await pool.execute('SELECT password FROM users WHERE id = ?', [req.user.id]);
    if (rows.length === 0) return sendError(res, 404, 'User tidak ditemukan');
    if (!await bcrypt.compare(lama, rows[0].password))
      return sendError(res, 401, 'Password lama salah');

    // `token_version + 1` sekaligus jadi penanda: SEMUA token lama (termasuk
    // yang dipakai perangkat lain) langsung ditolak requireAuth.
    await pool.execute(
      'UPDATE users SET password = ?, token_version = token_version + 1 WHERE id = ?',
      [await bcrypt.hash(baru, 12), req.user.id]
    );

    // Perangkat yang barusan ganti password jangan ikut ke-logout — dia sudah
    // membuktikan tahu password lamanya. Set cookie baru dengan tv terbaru.
    const [tvRows] = await pool.execute('SELECT token_version FROM users WHERE id = ?', [req.user.id]);
    const tv = Number(tvRows[0]?.token_version || 0);
    const token = signToken({ id: req.user.id, username: req.user.username, role: req.user.role, tv });
    res.cookie('token', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 86400000,
    });

    return res.json({
      ok: true,
      message: 'Password diganti. Perangkat lain harus masuk ulang dengan password baru.',
    });
  } catch (err) {
    console.error('[Auth] gantiPassword error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

/**
 * POST /api/auth/phone — simpan nomor HP (jalur notif kedua).
 *
 * Notif WA cuma lewat nomor bot. Kalau botnya putus tepat waktu user bayar,
 * notifnya nggak masuk — justru di momen dia paling butuh. Nomor HP dikirim
 * dari bot mana pun yang sedang online, jadi nggak bergantung bot user sendiri.
 */
async function simpanPhone(req, res) {
  try {
    const nomor = String(req.body?.phone || '').replace(/\D/g, '');
    if (!nomor) {
      await pool.execute('UPDATE users SET phone = NULL WHERE id = ?', [req.user.id]);
      return res.json({ ok: true, message: 'Nomor HP dihapus.' });
    }

    // Terima 08xx / +628xx / 628xx — disimpan sebagai 628xx biar konsisten
    // dengan `owner_number`, jadi konversi ke JID nggak perlu mikir lagi.
    const normal = nomor.startsWith('0') ? '62' + nomor.slice(1)
      : nomor.startsWith('62') ? nomor
      : '62' + nomor;
    if (normal.length < 10 || normal.length > 15) {
      return sendError(res, 400, 'Nomor HP tidak valid. Contoh: 08123456789');
    }

    await pool.execute('UPDATE users SET phone = ? WHERE id = ?', [normal, req.user.id]);
    return res.json({ ok: true, message: 'Nomor HP disimpan.', phone: normal });
  } catch (err) {
    console.error('[Auth] simpanPhone error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

/**
 * POST /api/auth/email — simpan email (jalur notif KETIGA).
 *
 * Dua jalur lain (nomor bot & nomor HP) sama-sama dikirim LEWAT BOT MILIK USER.
 * Jadi saat botnya yang rusak — persis kondisi yang paling butuh kabar —
 * keduanya ikut mati. Email tidak lewat bot.
 *
 * Kosong = hapus. TIDAK unique: satu email boleh dipakai beberapa akun.
 */
async function simpanEmail(req, res) {
  try {
    const { emailValid } = require('../engine/email');
    const alamat = String(req.body?.email || '').trim();

    if (!alamat) {
      await pool.execute('UPDATE users SET email = NULL WHERE id = ?', [req.user.id]);
      return res.json({ ok: true, message: 'Email dihapus.' });
    }
    if (!emailValid(alamat)) {
      return sendError(res, 400, 'Email tidak valid. Contoh: nama@email.com');
    }

    await pool.execute('UPDATE users SET email = ? WHERE id = ?', [alamat, req.user.id]);
    return res.json({ ok: true, message: 'Email disimpan.', email: alamat });
  } catch (err) {
    console.error('[Auth] simpanEmail error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// ─── Google OAuth 2.0 ────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID     = () => process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = () => process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI  = () => process.env.GOOGLE_REDIRECT_URI || 'https://labs.yapari.web.id/api/auth/google/callback';

function googleRedirect(req, res) {
  const clientId = GOOGLE_CLIENT_ID();
  if (!clientId) {
    return res.status(503).send('Google OAuth belum dikonfigurasi (GOOGLE_CLIENT_ID belum diisi di .env).');
  }
  const redirectUri = encodeURIComponent(GOOGLE_REDIRECT_URI());
  const scope = encodeURIComponent('openid email profile');
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&prompt=select_account`;
  return res.redirect(url);
}

async function googleCallback(req, res) {
  const { code, error } = req.query;
  if (error || !code) {
    return res.redirect('/login?err=' + encodeURIComponent(error || 'Login Google dibatalkan'));
  }

  const clientId = GOOGLE_CLIENT_ID();
  const clientSecret = GOOGLE_CLIENT_SECRET();
  if (!clientId || !clientSecret) {
    return res.status(503).send('Google OAuth belum dikonfigurasi.');
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: GOOGLE_REDIRECT_URI(),
        grant_type: 'authorization_code'
      })
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('[Google OAuth] Token error:', tokenData);
      return res.redirect('/login?err=' + encodeURIComponent('Gagal verifikasi dengan Google'));
    }

    const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const profile = await userRes.json();
    if (!profile || !profile.email) {
      return res.redirect('/login?err=' + encodeURIComponent('Email Google tidak ditemukan'));
    }

    const email = profile.email.toLowerCase().trim();

    const [rows] = await pool.execute(
      'SELECT id, username, role, token_version FROM users WHERE email = ? LIMIT 1',
      [email]
    );

    let user;
    if (rows.length > 0) {
      user = rows[0];
    } else {
      let baseUser = (profile.name || email.split('@')[0])
        .replace(/[^a-zA-Z0-9_]/g, '')
        .slice(0, 30);
      if (baseUser.length < 3) baseUser = 'user_' + Math.floor(Math.random() * 10000);

      let candidate = baseUser;
      const [uRows] = await pool.execute('SELECT id FROM users WHERE username = ?', [candidate]);
      if (uRows.length > 0) candidate = `${baseUser}_${Math.floor(1000 + Math.random() * 9000)}`;

      const randomPass = crypto.randomBytes(24).toString('hex');
      const hashed = await bcrypt.hash(randomPass, 12);

      const [ins] = await pool.execute(
        'INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, ?)',
        [candidate, email, hashed, 'user']
      );

      user = { id: ins.insertId, username: candidate, role: 'user', token_version: 0 };
    }

    const token = signToken({ id: user.id, username: user.username, role: user.role, tv: user.token_version || 0 });

    res.cookie('token', token, {
      httpOnly: true,
      secure: req.protocol === 'https',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.redirect('/dashboard');
  } catch (err) {
    console.error('[Google OAuth] Error:', err);
    return res.redirect('/login?err=' + encodeURIComponent('Terjadi kesalahan saat login Google'));
  }
}

module.exports = {
  register, login, logout, me, gantiPassword, simpanPhone, simpanEmail,
  googleRedirect, googleCallback,
  listUsers, updateUser, deleteUser,
  requireAuth, requireKing,
};
