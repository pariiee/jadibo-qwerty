'use strict';

/**
 * controllers/sistemController.js — tab "Sistem" di /kountole.
 *
 * Isinya hal-hal yang sebelumnya cuma bisa dilihat lewat SSH: kesehatan bot,
 * beban server, jejak aktivitas admin, pendapatan, dan broadcast ke user.
 * Semua endpoint di sini WAJIB admin (dipasang di server.js dengan requireKing).
 *
 * Kenapa dibuat walau datanya masih kecil: halaman ini yang menjawab
 * "server gua sehat nggak?" tanpa buka terminal — dan pertanyaan itu jadi
 * makin sering, bukan makin jarang, begitu user nambah.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');

function sendError(res, status, message) {
  return res.status(status).json({ ok: false, message });
}

// ─── Jejak aktivitas admin ───────────────────────────────────────────────────

/**
 * Catat satu aksi admin. Dipanggil dari SATU middleware di server.js yang
 * menempel ke seluruh `/api/admin/*` — bukan ditempel manual di tiap handler.
 *
 * Dua alasan dipilih middleware:
 *   1. Route admin yang ditambah nanti otomatis ikut terekam; tidak ada yang
 *      bisa lupa mencatat.
 *   2. Tidak ada handler yang bisa "menghindari" pencatatan.
 *
 * Fire-and-forget: jejak audit TIDAK BOLEH menggagalkan aksi admin. Kalau DB
 * sedang sakit, yang gagal cuma pencatatannya — dan itu pun diberitakan.
 */
function catatAudit({ userId, username, method, path: jalur, status, ip }) {
  pool.execute(
    'INSERT INTO admin_log (user_id, username, method, path, status, ip) VALUES (?, ?, ?, ?, ?, ?)',
    [
      userId ?? null,
      username ? String(username).slice(0, 64) : null,
      String(method || '').slice(0, 8),
      String(jalur || '').slice(0, 255),
      Number.isFinite(Number(status)) ? Number(status) : null,
      ip ? String(ip).slice(0, 64) : null,
    ]
  ).catch((e) => {
    // SENGAJA console.error, bukan logBot: logBot menulis ke DB, dan DB-lah
    // yang paling mungkin jadi penyebab gagalnya di titik ini.
    console.error(`[Audit] gagal catat ${method} ${jalur}: ${e.message}`);
  });
}

/** Daftar aksi admin terakhir. */
async function audit(req, res) {
  try {
    const [rows] = await pool.execute(
      `SELECT id, username, method, path, status, ip, created_at
         FROM admin_log ORDER BY id DESC LIMIT 100`
    );
    return res.json({ ok: true, logs: rows });
  } catch (e) {
    // 1146 = tabel belum ada. Deployment yang belum menjalankan sync-schema
    // bukan "error server" — beri tahu apa yang harus dijalankan.
    const belumMigrasi = e?.errno === 1146 || /doesn't exist/i.test(e?.message || '');
    console.error('[Audit] gagal baca:', e.message);
    if (belumMigrasi) {
      return res.json({
        ok: true,
        logs: [],
        catatan: 'Tabel admin_log belum dibuat. Jalankan: node scripts/sync-schema.js',
      });
    }
    return sendError(res, 500, 'Gagal membaca log aktivitas');
  }
}

// ─── Kesehatan + beban server ────────────────────────────────────────────────

/**
 * Ambil angka beban server. Modul `os` bawaan Node, BUKAN /proc — supaya
 * kodenya yang sama jalan di Windows (dev) dan Linux (produksi).
 */
function resource() {
  const totalRam = os.totalmem();
  const bebasRam = os.freemem();
  const cpu = os.cpus() || [];
  const load = typeof os.loadavg === 'function' ? os.loadavg() : [0, 0, 0];

  // Disk: filesystem yang menampung folder aplikasi ini.
  let disk = null;
  try {
    const s = fs.statfsSync(path.resolve(__dirname, '..'));
    const total = Number(s.blocks) * Number(s.bsize);
    const bebas = Number(s.bavail) * Number(s.bsize);
    disk = { total, bebas, terpakai: total - bebas };
  } catch (e) {
    console.warn('[Sistem] statfs gagal:', e.message);
  }

  return {
    ram: { total: totalRam, bebas: bebasRam, terpakai: totalRam - bebasRam },
    disk,
    cpu: {
      inti: cpu.length,
      model: cpu[0]?.model || null,
      load,
      // PENTING dan sudah terbukti di box ini: di LXC/container, loadavg bisa
      // milik HOST, bukan container. Nilainya pernah 320-426 padahal botnya
      // santai. Jangan ditampilkan sebagai "beban bot ini".
      loadCatatan: 'Di LXC/container, loadavg bisa menunjukkan beban HOST, bukan bot ini.',
    },
    uptimeProses: process.uptime(),
    uptimeSistem: os.uptime(),
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
  };
}

/** Kesehatan bot + beban server + versi aplikasi. */
async function status(req, res) {
  let kesehatan = null;
  try {
    kesehatan = await require('../engine/health').cek();
  } catch (e) {
    console.error('[Sistem] health.cek gagal:', e.message);
  }

  let versi = null;
  try {
    versi = require('../package.json').version || null;
  } catch { /* package.json tanpa version — bukan alasan gagal */ }

  return res.json({
    ok: true,
    kesehatan,
    resource: resource(),
    versi,
    waktuServer: new Date().toISOString(),
  });
}

// ─── Pendapatan ──────────────────────────────────────────────────────────────

/**
 * Pendapatan 14 hari terakhir + ringkasan seumur hidup.
 *
 * Sengaja ditulis walau `orders` masih kosong: begitu ada penjualan pertama,
 * angkanya langsung kelihatan tanpa perlu deploy lagi. Yang penting angkanya
 * NYATA — kalau nol, tampil nol.
 *
 * `DATE_FORMAT` dipakai, bukan `DATE()`: kolom DATE dikembalikan driver sebagai
 * objek Date, dan di server ber-TZ Asia/Jakarta itu bisa bergeser sehari.
 * String 'YYYY-MM-DD' bebas dari masalah itu.
 */
async function pendapatan(req, res) {
  try {
    const [harian] = await pool.execute(
      `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS tgl,
              COUNT(*) AS jumlah,
              COALESCE(SUM(amount), 0) AS total
         FROM orders
        WHERE status = 'paid'
          AND created_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY)
        GROUP BY tgl
        ORDER BY tgl`
    );

    const [ringkas] = await pool.execute(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'paid'    THEN amount END), 0) AS total_lunas,
         COUNT(CASE WHEN status = 'paid'    THEN 1 END)                AS jumlah_lunas,
         COUNT(CASE WHEN status = 'pending' THEN 1 END)                AS jumlah_pending`
    );

    // Isi hari yang tidak punya order dengan nol — grafik harus punya 14 batang,
    // bukan cuma hari yang kebetulan ada transaksi.
    const peta = new Map(harian.map((r) => [String(r.tgl), r]));
    const seri = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const kunci = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const r = peta.get(kunci);
      seri.push({ tgl: kunci, jumlah: Number(r?.jumlah || 0), total: Number(r?.total || 0) });
    }

    return res.json({
      ok: true,
      seri,
      ringkas: {
        total_lunas: Number(ringkas[0]?.total_lunas || 0),
        jumlah_lunas: Number(ringkas[0]?.jumlah_lunas || 0),
        jumlah_pending: Number(ringkas[0]?.jumlah_pending || 0),
      },
    });
  } catch (e) {
    console.error('[Sistem] pendapatan gagal:', e.message);
    return sendError(res, 500, 'Gagal memuat pendapatan');
  }
}

// ─── Broadcast ───────────────────────────────────────────────────────────────

/**
 * Kirim satu pesan ke SEMUA user aktif, lewat bot masing-masing.
 *
 * Batasnya nyata dan tidak disembunyikan: `kirimKeOwner` mengirim lewat bot
 * MILIK USER ITU SENDIRI. Kalau botnya sedang mati, pesannya tidak sampai —
 * dan itu dilaporkan ke admin, bukan dibiarkan tampak sukses.
 */
async function broadcast(req, res) {
  const teks = String(req.body?.teks || '').trim();
  if (!teks) return sendError(res, 400, 'Pesan tidak boleh kosong');
  if (teks.length > 2000) return sendError(res, 400, 'Pesan maksimal 2000 karakter');

  let users;
  try {
    [users] = await pool.execute(
      'SELECT id, username FROM users WHERE is_active = 1 ORDER BY id'
    );
  } catch (e) {
    console.error('[Broadcast] gagal ambil user:', e.message);
    return sendError(res, 500, 'Gagal mengambil daftar user');
  }

  const notify = require('../engine/notify');
  const gagal = [];
  let terkirim = 0;

  // ponytail: berurutan, bukan paralel. Satu bot yang mengirim dan WA membatasi
  // laju — paralel di sini cuma bikin pesan ditolak. Ganti ke antrean kalau
  // jumlah user sudah ratusan.
  for (const u of users) {
    try {
      if (await notify.kirimKeOwner(u.id, teks)) terkirim++;
      else gagal.push(u.username || `user#${u.id}`);
    } catch (e) {
      console.error(`[Broadcast] gagal ke ${u.username}: ${e.message}`);
      gagal.push(u.username || `user#${u.id}`);
    }
  }

  // Laporkan APA ADANYA. "Terkirim ke semua" padahal ada yang gagal itu persis
  // jenis kebohongan yang bikin admin tidak pernah tahu ada masalah.
  return res.json({
    ok: true,
    terkirim,
    gagal: gagal.length,
    total: users.length,
    message: gagal.length
      ? `Terkirim ke ${terkirim}/${users.length} user. Tidak sampai: ${gagal.join(', ')} (bot-nya sedang mati).`
      : `Terkirim ke ${terkirim}/${users.length} user.`,
  });
}

module.exports = { status, audit, pendapatan, broadcast, catatAudit };
