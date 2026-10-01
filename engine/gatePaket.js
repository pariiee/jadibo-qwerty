'use strict';

/**
 * engine/gatePaket.js — penegakan batas paket di jalur pesan masuk.
 *
 * Sebelumnya `receive_limit` dan `max_fitur` cuma jadi ANGKA HIAS: ditulis
 * waktu checkout, dibaca buat ditampilin di /admin, dan tidak pernah
 * dibandingkan dengan apa pun di jalur pesan. Akibatnya `/pricing` menjual
 * Basic 10.000 / Premium 50.000 / Ultra 100.000 pesan yang tidak bisa dibedakan
 * sama sekali oleh bot.
 *
 * Dua penegakan, sengaja di SATU tempat (engine/whatsappEngine.js, tepat sesudah
 * gerbang registrasi) supaya hitungannya tidak meleset antara dua proses:
 *
 *   1. KUOTA PESAN  — tiap pesan yang bot ini TERIMA menambah received_count;
 *                     kalau sudah lewat receive_limit, pesannya diabaikan.
 *   2. JATAH FITUR  — command di luar jatah paket pemilik (`max_fitur`) ditolak.
 *
 * Cache: paket pemilik di-cache 60 detik. Kalau tidak, tiap pesan jadi dua
 * query tambahan (pemilik + `settings`) — jalur terpanas di seluruh sistem.
 * Konsekuensinya: perubahan paket terasa paling lama 60 detik kemudian.
 */
const { pool } = require('../config/database');
const pricingStore = require('../config/pricingStore');
const {
  ADMIN_ROLE, TRIAL, DEFAULT_PLANS, KATEGORI_URUT, SELALU_TERBUKA, LIMIT_DEFAULT,
  aktif, kuotaBot,
} = require('../config/plan');

// ponytail: cache global 60 detik — pakai per-bot + invalidasi kalau paketnya
// berubah lebih sering dari itu (belum perlu: paket cuma diubah admin/admin
// checkout, bukan operasi per-pesan).
const TTL_MS = 60 * 1000;
const cachePemilik = new Map();   // botId -> { nilai, sampai }
const cacheFitur = new Map();     // `${botId}:${plan}` -> Set nama command

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

/** Buang cache bot ini — dipanggil setelah checkout / paket diubah. */
function segarkan(botId) {
  if (botId == null) { cachePemilik.clear(); cacheFitur.clear(); return; }
  cachePemilik.delete(botId);
  for (const k of cacheFitur.keys()) if (k.startsWith(botId + ':')) cacheFitur.delete(k);
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
 * Jatah fitur satu paket. `null` = semua fitur (admin / gagal baca daftar).
 * SELALU_TERBUKA (menu, ping, limit, me, owner) tidak pernah dikunci — paket
 * habis tanpa itu cuma bikin bot bisu tanpa sebab yang kelihatan.
 */
function jatahFitur(planId) {
  const kunci = planId || 'user';
  if (cacheFitur.has(kunci)) return cacheFitur.get(kunci);

  let cats;
  try { cats = require('../plugins/01-info').CATS; } catch { return null; }

  const paket = [...(pricingStore.plans() || DEFAULT_PLANS), TRIAL].find((p) => p.id === kunci);
  const jml = Number(paket?.max_fitur) || 0;

  const out = new Set(SELALU_TERBUKA);
  for (const k of KATEGORI_URUT) {
    for (const c of cats[k] || []) {
      if (out.size >= jml && !out.has(c)) { cacheFitur.set(kunci, out); return out; }
      out.add(c);
    }
  }
  cacheFitur.set(kunci, out);
  return out;
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

  const paket = [...(pricingStore.plans() || DEFAULT_PLANS), TRIAL].find((p) => p.id === pemilik.plan);
  const jatah = Number(paket?.receive_limit) || 0;
  if (jatah <= 0) return 0;

  const sendiri = Number(botData.receive_limit) || 0;
  return sendiri > 0 ? Math.min(sendiri, jatah) : jatah;
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
 * Jatah fitur buat bot ini, dalam bentuk array (buat menu) atau `null` = semua.
 * Dipakai engine buat mengisi `ctx.fitur`, supaya yang DITAMPILKAN di `.menu`
 * sama dengan yang DIIZINKAN gate. Kalau dua tempat ini beda, user melihat
 * daftar fitur lalu ditolak satu-satu.
 */
async function jatahBot(botId) {
  try {
    const pemilik = await pemilikBot(botId);
    if (!pemilik || pemilik.role === ADMIN_ROLE) return null;
    const jatah = jatahFitur(paketPemilik(pemilik) ? pemilik.plan : 'user');
    return jatah ? [...jatah] : null;
  } catch {
    return null; // gagal baca = tampilkan semua, jangan kosongkan menu
  }
}

/**
 * Command ini termasuk paket pemilik bot? `namaPemilik` diisi kalau pengirimnya
 * memang pemilik/admin — mereka selalu lolos. Gagal baca = izinkan.
 */
async function fiturDibolehkan(botId, command, namaPemilik) {
  try {
    if (namaPemilik) return true;
    const jatah = await jatahBot(botId);
    return jatah ? jatah.includes(command) : true;
  } catch {
    return true;
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
 * cron. Tanpa ini, paket lewat cuma nge-drop fitur ke jatah Gratis sementara
 * botnya tetap nyambung ke WhatsApp — bayar atau tidak, nomornya tetap online.
 *
 * `plan_expired_at IS NOT NULL` itu penting: akun yang BELUM PERNAH langganan
 * kolomnya NULL, dan tanpa syarat itu botnya ikut dimatikan.
 */
async function botKedaluwarsa() {
  const [rows] = await pool.execute(
    `SELECT b.id, b.platform, u.username, u.plan_expired_at
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
  pemilikBot, segarkan, jatahFitur, jatahBot, batasKuota, kuotaHabis,
  fiturDibolehkan, kuotaHarian, botKedaluwarsa, TTL_MS,
};
