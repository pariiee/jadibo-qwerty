'use strict';

/**
 * engine/gatePaket.js — penegakan batas paket di jalur pesan masuk.
 *
 * Paket TIDAK membatasi fitur. Semua command terbuka untuk semua paket. Yang
 * membedakan paket cuma tiga: KUOTA PESAN (`receive_limit` + `daily_limit`),
 * MASA AKTIF (`plan_expired_at`), dan JUMLAH OWNER NUMBER (`owner_max`).
 *
 * Sebelum ini `receive_limit` cuma ANGKA HIAS: ditulis waktu checkout, dibaca
 * buat ditampilin di /admin, dan tidak pernah dibandingkan dengan apa pun di
 * jalur pesan. Akibatnya `/pricing` menjual Basic 10.000 / Premium 50.000 /
 * Ultra 100.000 pesan yang tidak bisa dibedakan sama sekali oleh bot.
 *
 * Cache: paket pemilik di-cache 60 detik. Kalau tidak, tiap pesan jadi dua
 * query tambahan (pemilik + `settings`) — jalur terpanas di seluruh sistem.
 * Konsekuensinya: perubahan paket terasa paling lama 60 detik kemudian.
 */
const { pool } = require('../config/database');
const pricingStore = require('../config/pricingStore');
const { ADMIN_ROLE, TRIAL, DEFAULT_PLANS, LIMIT_DEFAULT, aktif, kuotaBot } = require('../config/plan');

// ponytail: cache global 60 detik — pakai per-bot + invalidasi kalau paketnya
// berubah lebih sering dari itu (belum perlu: paket cuma diubah admin/checkout,
// bukan operasi per-pesan).
const TTL_MS = 60 * 1000;
const cachePemilik = new Map(); // botId -> { nilai, sampai }

/** Paket pemilik bot ini (dari cache kalau masih segar). */
async function pemilikBot(botId) {
  const kini = Date.now();
  const c = cachePemilik.get(botId);
  if (c && c.sampai > kini) return c.nilai;

  let nilai = null;
  try {
    const [rows] = await pool.execute(
      `SELECT u.id, u.role, u.plan, u.plan_expired_at
         FROM bots b JOIN users u ON u.id = b.user_id
        WHERE b.id = ? LIMIT 1`,
      [botId]
    );
    nilai = rows[0] || null;
  } catch { /* DB error — jangan blokir bot gara-gara ini */ }

  cachePemilik.set(botId, { nilai, sampai: kini + TTL_MS });
  return nilai;
}

/** Buang cache (tanpa botId = semua). Dipanggil setelah checkout. */
function segarkan(botId) {
  if (botId == null) cachePemilik.clear();
  else cachePemilik.delete(botId);
}

/**
 * Paket yang SEDANG berlaku buat pemilik ini. `null` = masa aktifnya habis.
 * Admin tidak lewat sini (dicek pemanggil) karena dia tidak dibatasi.
 */
function paketPemilik(pemilik) {
  if (!pemilik || !aktif(pemilik)) return null;
  return [...(pricingStore.plans() || DEFAULT_PLANS), TRIAL].find((p) => p.id === pemilik.plan) || null;
}

/**
 * Batas kuota pesan efektif buat bot ini.
 *   -1 = paket habis, bot berhenti melayani   0 = tanpa batas   >0 = jatah pesan
 *
 * Dibaca dari paket pemilik yang SEDANG berlaku, bukan dari kolom
 * `bots.receive_limit` yang dibekukan waktu checkout. Kolom itu cuma boleh
 * MENURUNKAN jatah, tidak menaikkan — sama seperti `kuotaBot()`. Kalau kolomnya
 * yang jadi sumber kebenaran, paket yang sudah habis tetap dapat kuota penuh
 * selamanya, dan masa aktif jadi tidak ada artinya.
 */
async function batasKuota(botId, botData) {
  const pemilik = await pemilikBot(botId);
  if (!pemilik) return 0;                    // gagal baca → jangan blokir siapa pun
  if (pemilik.role === ADMIN_ROLE) return 0; // admin tanpa batas
  if (!aktif(pemilik)) return -1;            // paket habis → berhenti melayani

  const paket = paketPemilik(pemilik);
  const jatah = Number(paket?.receive_limit) || 0;
  if (jatah <= 0) return 0;

  const sendiri = Number(botData.receive_limit) || 0;
  const dasar = sendiri > 0 ? Math.min(sendiri, jatah) : jatah;

  // Top-up admin DITAMBAHKAN di atas, bukan menggantikan. Ditaruh paling akhir
  // dengan sengaja: kuota yang sudah dibayar user tidak boleh bisa diperkecil
  // oleh salah tulis di tabel tambahan — kalau tabelnya kosong/gagal dibaca,
  // hasilnya persis seperti sebelum fitur ini ada.
  return dasar + (await jatahTambahan(botId));
}

/**
 * Kuota tambahan yang berlaku untuk bot ini (0 kalau tidak ada).
 *
 * Kegagalan baca mengembalikan 0 — BUKAN melempar. `batasKuota()` dipanggil di
 * jalur setiap pesan masuk; satu error di tabel sampingan tidak boleh membuat
 * bot berhenti melayani. Efek terburuknya: user kehilangan bonus sementara
 * sampai query-nya normal, bukan botnya mati.
 */
async function jatahTambahan(botId) {
  try {
    const [rows] = await pool.execute(
      'SELECT jumlah FROM kuota_tambahan WHERE bot_id = ? LIMIT 1',
      [botId]
    );
    return Math.max(0, Number(rows[0]?.jumlah) || 0);
  } catch {
    // Tabel belum ada (DB lama sebelum sync-schema) → anggap tidak ada top-up.
    return 0;
  }
}

/**
 * Pesan ini masih boleh diproses? Sekalian menambah received_count kalau boleh.
 *
 * Batasnya dibaca dari paket pemilik yang SEDANG berlaku, bukan dari kolom
 * `bots.receive_limit` yang dibekukan waktu checkout. Kolom itu cuma boleh
 * MENURUNKAN jatah, tidak menaikkan — sama seperti `kuotaBot()`. Kalau kolomnya
 * yang jadi sumber kebenaran, paket yang sudah habis tetap dapat kuota penuh
 * selamanya, dan masa aktif yang dijual jadi tidak ada artinya.
 *
 * SATU UPDATE atomik — bukan baca-lalu-tulis. `affectedRows 0` = kuota habis.
 * Kalau hitungannya dibaca dulu dari `botData` lalu ditulis belakangan, dua
 * pesan yang datang bersamaan sama-sama lolos di angka terakhir, dan angka di
 * memori bisa meleset dari barisnya begitu prosesnya restart.
 *
 * Tidak pernah melempar: bot yang mati gara-gara gagal cek paket jauh lebih
 * buruk daripada bot yang kelebihan satu pesan.
 */
async function kuotaHabis(botId, botData) {
  try {
    const batas = await batasKuota(botId, botData);
    if (batas === 0) return false;   // tanpa batas
    if (batas < 0) return true;      // paket habis

    // SATU UPDATE atomik, dan `batas` sudah termasuk kuota tambahan dari
    // `batasKuota()`. Sengaja TIDAK ada penghitungan bonus terpisah di sini:
    // `received_count` sudah menghitung SELURUH pemakaian, jadi menambah
    // pencatat kedua (mis. kolom `terpakai`) berarti dua angka yang bisa
    // berbeda — dan kuota bonus jadi terhitung dua kali.
    const [res] = await pool.execute(
      'UPDATE bots SET received_count = received_count + 1 WHERE id = ? AND received_count < ?',
      [botId, batas]
    );
    return res.affectedRows === 0;
  } catch {
    return false;
  }
}

/**
 * Kuota harian efektif buat bot ini (`rpg_members.lim`, reset tiap hari).
 * Paket habis → 0 (bot berhenti melayani), admin → 99999, sisanya dari paket.
 *
 * Dipakai cron reset harian. Kalau cron-nya pakai `bots.daily_limit` yang beku,
 * trial 5 hari yang sudah lewat tetap dapat limit 20 pesan selamanya.
 */
async function kuotaHarian(botData) {
  try {
    const pemilik = await pemilikBot(botData.id);
    return kuotaBot(pemilik, botData, pricingStore.plans());
  } catch {
    return Number(botData.daily_limit) || LIMIT_DEFAULT;
  }
}

/**
 * Bot yang harus DIMATIKAN karena paket pemiliknya sudah habis.
 *
 * Dipakai cron tiap menit. Sengaja di sini, bukan ditulis inline di `server.js`:
 * syaratnya (jangan sentuh admin, jangan sentuh yang belum pernah langganan)
 * gampang salah dan nggak ada yang ngunci kalau bentuknya SQL mentah di dalam
 * cron. Tanpa ini, paket lewat cuma bikin pesan ditolak sementara botnya tetap
 * nyambung ke WhatsApp — bayar atau tidak, nomornya tetap online.
 *
 * `plan_expired_at IS NOT NULL` itu penting: akun yang BELUM PERNAH langganan
 * kolomnya NULL, dan tanpa syarat itu botnya ikut dimatikan.
 */
async function botKedaluwarsa() {
  const [rows] = await pool.execute(
    `SELECT b.id, b.platform, b.user_id, b.bot_name, u.username, u.plan_expired_at
       FROM bots b JOIN users u ON u.id = b.user_id
      WHERE b.is_running = 1
        AND u.role <> ?
        AND u.plan_expired_at IS NOT NULL
        AND u.plan_expired_at < NOW()`,
    [ADMIN_ROLE]
  );
  return rows;
}

module.exports = {
  pemilikBot, segarkan, batasKuota, kuotaHabis, jatahTambahan, kuotaHarian, botKedaluwarsa, TTL_MS,
};
