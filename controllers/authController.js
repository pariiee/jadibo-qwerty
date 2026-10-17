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

    const { username, password, phone, email } = req.body;

    if (!username || !password)
      return sendError(res, 400, 'Username dan password wajib diisi');

    if (!phone)
      return sendError(res, 400, 'Nomor WhatsApp wajib diisi');

    if (!email)
      return sendError(res, 400, 'Alamat email Gmail wajib diisi');

    if (username.length < 3 || username.length > 50)
      return sendError(res, 400, 'Username harus 3-50 karakter');

    if (password.length < 8)
      return sendError(res, 400, 'Password minimal 8 karakter');

    if (!/^[a-zA-Z0-9_]+$/.test(username))
      return sendError(res, 400, 'Username hanya boleh huruf, angka, dan underscore');

    // Bersihkan & validasi nomor WhatsApp
    const bersihPhone = String(phone).replace(/[^0-9]/g, '');
    if (bersihPhone.length < 9 || bersihPhone.length > 16) {
      return sendError(res, 400, 'Nomor WhatsApp tidak valid (minimal 9 digit)');
    }

    // Bersihkan & validasi email: WAJIB @gmail.com
    const { emailValid, kirimEmail } = require('../engine/email');
    const bersihEmail = String(email).trim().toLowerCase();
    if (!emailValid(bersihEmail)) {
      return sendError(res, 400, 'Format email tidak valid');
    }
    if (!/@gmail\.com$/i.test(bersihEmail) && !/@googlemail\.com$/i.test(bersihEmail)) {
      return sendError(res, 400, 'Pendaftaran akun wajib menggunakan email @gmail.com');
    }

    // Cek username
    const [existing] = await pool.execute(
      'SELECT id, is_active FROM users WHERE username = ?',
      [username]
    );
    if (existing.length > 0) {
      if (existing[0].is_active) {
        return sendError(res, 409, 'Username sudah digunakan');
      }
    }

    // Cek email
    const [existingEmail] = await pool.execute(
      'SELECT id, is_active FROM users WHERE email = ?',
      [bersihEmail]
    );
    if (existingEmail.length > 0) {
      if (existingEmail[0].is_active) {
        return sendError(res, 409, 'Email Gmail ini sudah terdaftar. Silakan login atau gunakan fitur Lupa Password.');
      } else {
        // Hapus akun belum aktif lama agar bisa daftar ulang
        await pool.execute('DELETE FROM users WHERE id = ?', [existingEmail[0].id]);
      }
    }

    if (existing.length > 0 && !existing[0].is_active) {
      await pool.execute('DELETE FROM users WHERE id = ?', [existing[0].id]);
    }

    const hashed = await bcrypt.hash(password, 12);
    // User dibuat dengan is_active = 0 sampai verifikasi email diklik
    const [result] = await pool.execute(
      'INSERT INTO users (username, phone, email, password, role, is_active) VALUES (?, ?, ?, ?, ?, 0)',
      [username, bersihPhone, bersihEmail, hashed, 'user']
    );

    const userId = result.insertId;

    // Pastikan tabel email_verifications ada
    await pool.query(`
      CREATE TABLE IF NOT EXISTS email_verifications (
        id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id    INT UNSIGNED NOT NULL,
        token      VARCHAR(128) NOT NULL,
        expires_at DATETIME NOT NULL,
        used_at    DATETIME DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_token (token),
        INDEX idx_user (user_id),
        INDEX idx_expires (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `).catch(() => {});

    // Buat token verifikasi 32 bytes (5 jam)
    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    await pool.execute(
      'INSERT INTO email_verifications (user_id, token, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 5 HOUR))',
      [userId, token]
    );

    const baseUrl = process.env.BASE_URL || (req.protocol + '://' + req.get('host'));
    const verifyUrl = `${baseUrl}/register/verify?token=${token}`;
    const subjek = 'Verifikasi Email Akun Yapari Bots';
    const teks = `Halo ${username},\n\nTerima kasih telah mendaftar di Yapari Bots.\n\nKlik tautan berikut untuk memverifikasi email kamu dan mengaktifkan akun (berlaku 5 jam):\n${verifyUrl}\n\nJika kamu tidak merasa mendaftar di Yapari Bots, abaikan email ini.\n\nSalam,\nTim Yapari Bots`;
    const html = `
      <div style="font-family:'Plus Jakarta Sans',sans-serif,Arial,sans-serif;max-width:540px;margin:0 auto;padding:28px 24px;background:#ffffff;border:1px solid #e2e8f0;border-radius:20px;">
        <h2 style="color:#0f172a;margin-top:0;font-size:20px;font-weight:800;">Verifikasi Alamat Email</h2>
        <p style="color:#475569;font-size:14px;line-height:1.6;">Halo <strong>${username}</strong>,</p>
        <p style="color:#475569;font-size:14px;line-height:1.6;">Terima kasih sudah mendaftar di <strong>Yapari Bots</strong>. Klik tombol di bawah ini untuk mengaktifkan akunmu:</p>
        <div style="margin:26px 0;text-align:center;">
          <a href="${verifyUrl}" style="display:inline-block;padding:12px 30px;background:#0f172a;color:#ffffff;text-decoration:none;font-weight:700;border-radius:999px;font-size:14px;">Aktifkan Akun Saya</a>
        </div>
        <p style="color:#64748b;font-size:12.5px;line-height:1.5;">Atau salin tautan berikut ke browser:<br><a href="${verifyUrl}" style="color:#2563eb;word-break:break-all;">${verifyUrl}</a></p>
        <hr style="border:none;border-top:1px solid #f1f5f9;margin:22px 0;">
        <p style="color:#94a3b8;font-size:11.5px;margin:0;">Tautan ini berlaku selama 5 jam. Jika kamu tidak merasa mendaftar, abaikan email ini.</p>
      </div>
    `;

    kirimEmail(bersihEmail, subjek, teks, html).catch(e => console.error('[Auth] Gagal kirim email verifikasi:', e));

    // Simpan email pending di cookie httpOnly sementara (2 jam) — anti-tampering attacker
    res.cookie('pending_reg_email', bersihEmail, {
      httpOnly: true,
      secure: req.protocol === 'https',
      sameSite: 'lax',
      maxAge: 2 * 60 * 60 * 1000,
    });

    return res.status(201).json({
      ok: true,
      message: 'Pendaftaran berhasil! Tautan verifikasi telah dikirimkan ke Gmail (' + bersihEmail + ').',
      email: bersihEmail,
      need_verification: true,
      redirect: '/login?registered=1'
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
      'SELECT id, username, password, role, is_active, token_version FROM users WHERE username = ? OR email = ?',
      [username, username]
    );

    if (rows.length === 0)
      return sendError(res, 401, 'Username atau password salah');

    const user = rows[0];

    const match = await bcrypt.compare(password, user.password);
    if (!match)
      return sendError(res, 401, 'Username atau password salah');

    if (!user.is_active) {
      // Cek apakah ada token pending verifikasi email
      const [verRows] = await pool.execute(
        'SELECT id FROM email_verifications WHERE user_id = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1',
        [user.id]
      ).catch(() => [[]]);
      if (verRows.length > 0) {
        return sendError(res, 403, 'Akun kamu belum aktif. Silakan buka Gmail kamu dan klik link verifikasi yang telah kami kirimkan.');
      }
      return sendError(res, 403, 'Akun dinonaktifkan. Hubungi admin');
    }

    const token = signToken({ id: user.id, username: user.username, role: user.role, tv: Number(user.token_version || 0) });

    res.cookie('token', token, {
      httpOnly: true,
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

// ─── GET /verify-email (backward compat) ──────────────────────────────────────
async function verifyEmail(req, res) {
  const { token } = req.query;
  if (!token) return res.redirect('/login');
  return res.redirect('/register/verify?token=' + encodeURIComponent(token));
}

// ─── GET /api/auth/verify-info ────────────────────────────────────────────────
async function getVerifyInfo(req, res) {
  try {
    const { token } = req.query;
    if (!token) return sendError(res, 400, 'Token verifikasi tidak ditemukan');

    const [rows] = await pool.execute(
      `SELECT ev.id, ev.expires_at, ev.used_at, u.username, u.email, u.is_active
       FROM email_verifications ev
       JOIN users u ON u.id = ev.user_id
       WHERE ev.token = ? LIMIT 1`,
      [token]
    );

    if (rows.length === 0) {
      return sendError(res, 404, 'Link verifikasi tidak valid atau sudah tidak tersedia');
    }

    const item = rows[0];
    if (item.used_at || item.is_active) {
      return res.json({ ok: true, already_active: true, username: item.username, email: item.email });
    }

    if (new Date(item.expires_at) < new Date()) {
      return sendError(res, 410, 'Link verifikasi sudah kedaluwarsa. Silakan daftar ulang atau minta tautan baru.');
    }

    return res.json({
      ok: true,
      username: item.username,
      email: item.email
    });
  } catch (err) {
    console.error('[Auth] getVerifyInfo error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// ─── POST /api/auth/verify-confirm ───────────────────────────────────────────
async function verifyConfirm(req, res) {
  try {
    const { token } = req.body;
    if (!token) return sendError(res, 400, 'Token verifikasi tidak ditemukan');

    const [rows] = await pool.execute(
      `SELECT ev.id, ev.user_id, ev.expires_at, ev.used_at, u.username, u.email, u.role, u.token_version, u.is_active
       FROM email_verifications ev
       JOIN users u ON u.id = ev.user_id
       WHERE ev.token = ? LIMIT 1`,
      [token]
    );

    if (rows.length === 0) {
      return sendError(res, 404, 'Link verifikasi tidak valid atau tidak ditemukan');
    }

    const item = rows[0];
    if (new Date(item.expires_at) < new Date()) {
      return sendError(res, 410, 'Link verifikasi sudah kedaluwarsa. Silakan daftar ulang.');
    }

    // Aktifkan user dan tandai token terpakai
    await pool.execute('UPDATE users SET is_active = 1 WHERE id = ?', [item.user_id]);
    await pool.execute('UPDATE email_verifications SET used_at = NOW() WHERE id = ?', [item.id]);

    // Otomatis login (set cookie JWT)
    const tokenJwt = signToken({
      id: item.user_id,
      username: item.username,
      role: item.role,
      tv: Number(item.token_version || 0)
    });

    res.cookie('token', tokenJwt, {
      httpOnly: true,
      secure: req.protocol === 'https',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.clearCookie('pending_reg_email');

    return res.json({
      ok: true,
      message: 'Akun berhasil diverifikasi!',
      user: { id: item.user_id, username: item.username, email: item.email },
      redirect: '/register/success'
    });
  } catch (err) {
    console.error('[Auth] verifyConfirm error:', err);
    return sendError(res, 500, 'Terjadi kesalahan saat memverifikasi akun');
  }
}

// ─── GET /api/auth/pending-info ───────────────────────────────────────────────
async function getPendingInfo(req, res) {
  const email = req.cookies?.pending_reg_email;
  if (!email) {
    return sendError(res, 404, 'Sesi pendaftaran tidak ditemukan');
  }
  return res.json({ ok: true, email });
}

// ─── POST /api/auth/resend-verification ──────────────────────────────────────

async function resendVerification(req, res) {
  try {
    const email = req.cookies?.pending_reg_email || req.body?.email;
    if (!email) return sendError(res, 400, 'Sesi pendaftaran tidak ditemukan. Silakan daftar ulang.');

    const bersihEmail = String(email).trim().toLowerCase();
    const [rows] = await pool.execute(
      'SELECT id, username, is_active FROM users WHERE email = ? LIMIT 1',
      [bersihEmail]
    );

    if (rows.length === 0 || rows[0].is_active) {
      return res.json({ ok: true, message: 'Jika email terdaftar dan belum aktif, tautan verifikasi baru telah dikirimkan ke Gmail kamu.' });
    }

    const user = rows[0];
    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');

    await pool.execute(
      'UPDATE email_verifications SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL',
      [user.id]
    );
    await pool.execute(
      'INSERT INTO email_verifications (user_id, token, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 5 HOUR))',
      [user.id, token]
    );

    const baseUrl = process.env.BASE_URL || (req.protocol + '://' + req.get('host'));
    const verifyUrl = `${baseUrl}/register/verify?token=${token}`;
    const { kirimEmail } = require('../engine/email');
    const subjek = 'Kirim Ulang Verifikasi Email Akun Yapari Bots';
    const teks = `Halo ${user.username},\n\nBerikut tautan verifikasi baru untuk akun Yapari Bots kamu (berlaku 5 jam):\n${verifyUrl}\n\nSalam,\nTim Yapari Bots`;
    const html = `
      <div style="font-family:'Plus Jakarta Sans',sans-serif,Arial;max-width:540px;margin:0 auto;padding:28px 24px;background:#ffffff;border:1px solid #e2e8f0;border-radius:20px;">
        <h2 style="color:#0f172a;margin-top:0;font-size:20px;font-weight:800;">Verifikasi Alamat Email</h2>
        <p style="color:#475569;font-size:14px;line-height:1.6;">Halo <strong>${user.username}</strong>,</p>
        <p style="color:#475569;font-size:14px;line-height:1.6;">Berikut tautan verifikasi baru untuk mengaktifkan akunmu di <strong>Yapari Bots</strong>:</p>
        <div style="margin:26px 0;text-align:center;">
          <a href="${verifyUrl}" style="display:inline-block;padding:12px 30px;background:#0f172a;color:#ffffff;text-decoration:none;font-weight:700;border-radius:999px;font-size:14px;">Aktifkan Akun Saya</a>
        </div>
        <p style="color:#64748b;font-size:12.5px;line-height:1.5;">Atau salin tautan berikut ke browser:<br><a href="${verifyUrl}" style="color:#2563eb;word-break:break-all;">${verifyUrl}</a></p>
        <hr style="border:none;border-top:1px solid #f1f5f9;margin:22px 0;">
        <p style="color:#94a3b8;font-size:11.5px;margin:0;">Tautan berlaku selama 5 jam.</p>
      </div>
    `;

    kirimEmail(bersihEmail, subjek, teks, html).catch(e => console.error('[Auth] Gagal kirim email resend:', e));

    return res.json({
      ok: true,
      message: 'Jika email terdaftar dan belum aktif, tautan verifikasi baru telah dikirimkan ke Gmail kamu.'
    });
  } catch (err) {
    console.error('[Auth] resendVerification error:', err);
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
      'SELECT id, username, role, plan, plan_expired_at, plan_slots, trial_used_at, phone, email, saldo, auto_renew, auto_renew_status, created_at FROM users WHERE id = ?',
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
        email: u.email || '',
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
        saldo: Number(u.saldo || 0),
        auto_renew: !!u.auto_renew,
        auto_renew_status: u.auto_renew_status || null,
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
    return res.status(503).send('Google OAuth belum dikonfigurasi. Hubungi admin.');
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

/**
 * POST /api/auth/forgot-password
 * Body: { email }
 */
async function forgotPassword(req, res) {
  try {
    const crypto = require('crypto');
    const { emailValid, kirimEmail, siap } = require('../engine/email');
    const email = String(req.body?.email || '').trim().toLowerCase();

    if (!email || !emailValid(email)) {
      return sendError(res, 400, 'Format email tidak valid');
    }

    const [rows] = await pool.execute(
      'SELECT id, username, email FROM users WHERE email = ? LIMIT 1',
      [email]
    );

    const pesanAman = 'Jika email terdaftar, instruksi reset password telah dikirim.';
    if (!rows.length) {
      return res.json({ ok: true, message: pesanAman });
    }

    const user = rows[0];
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 menit

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id    INT UNSIGNED NOT NULL,
        token      VARCHAR(128) NOT NULL,
        expires_at DATETIME NOT NULL,
        used_at    DATETIME DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_token (token),
        INDEX idx_user (user_id),
        INDEX idx_expires (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.execute(
      'UPDATE password_resets SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL',
      [user.id]
    );

    await pool.execute(
      'INSERT INTO password_resets (user_id, token, expires_at) VALUES (?, ?, ?)',
      [user.id, token, expiresAt]
    );

    const baseUrl = process.env.BASE_URL || (req.protocol + '://' + req.get('host'));
    const resetUrl = `${baseUrl}/reset-password?token=${token}`;

    const subjek = 'Reset Password Akun qwertygate';
    const teks = `Halo ${user.username},\n\nKami menerima permintaan untuk mereset password akun qwertygate kamu.\n\nKlik tautan berikut untuk membuat password baru (berlaku 15 menit, 1x pakai):\n${resetUrl}\n\nJika kamu tidak meminta reset password, abaikan pesan ini.\n\nSalam,\nTim qwertygate`;

    if (siap()) {
      await kirimEmail(user.email, subjek, teks);
    } else {
      console.log(`[Reset Password] Link untuk ${user.username} (${user.email}): ${resetUrl}`);
    }

    return res.json({ ok: true, message: pesanAman });
  } catch (err) {
    console.error('[Auth] forgotPassword error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

/**
 * POST /api/auth/reset-password
 * Body: { token, password }
 */
async function resetPassword(req, res) {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) {
      return sendError(res, 400, 'Token dan password baru wajib diisi');
    }
    if (String(password).length < 6) {
      return sendError(res, 400, 'Password minimal 6 karakter');
    }

    const [rows] = await pool.execute(
      'SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token = ? LIMIT 1',
      [String(token).trim()]
    );

    if (!rows.length) {
      return sendError(res, 400, 'Tautan reset tidak valid atau sudah kedaluwarsa');
    }

    const resetItem = rows[0];
    if (resetItem.used_at) {
      return sendError(res, 400, 'Tautan reset ini sudah pernah digunakan');
    }

    if (new Date(resetItem.expires_at) < new Date()) {
      return sendError(res, 400, 'Tautan reset sudah kedaluwarsa (berlaku 15 menit). Silakan minta tautan baru.');
    }

    const hashed = await bcrypt.hash(password, 10);

    await pool.execute(
      'UPDATE users SET password = ?, token_version = COALESCE(token_version, 0) + 1 WHERE id = ?',
      [hashed, resetItem.user_id]
    );

    await pool.execute(
      'UPDATE password_resets SET used_at = NOW() WHERE id = ?',
      [resetItem.id]
    );

    return res.json({ ok: true, message: 'Password berhasil diubah. Silakan masuk dengan password baru kamu.' });
  } catch (err) {
    console.error('[Auth] resetPassword error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

module.exports = {
  register, login, logout, me, gantiPassword, simpanPhone, simpanEmail,
  verifyEmail, resendVerification, getVerifyInfo, verifyConfirm, getPendingInfo,
  forgotPassword, resetPassword,
  googleRedirect, googleCallback,
  listUsers, updateUser, deleteUser,
  requireAuth, requireKing,
};
