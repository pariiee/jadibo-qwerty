'use strict';

/**
 * Kuota pesan bot — sisa hari ini + sisa total, plus peringatan sebelum habis.
 *
 * Kenapa ada: begitu `kuotaHabis()` balik true, pesan berikutnya DITOLAK DIAM-DIAM
 * (`return` polos di jalur dispatch) dan paket habis mematikan botnya lewat cron.
 * User nggak dapat pesan apa pun di dua titik itu — dia cuma lihat botnya berhenti
 * jawab. Dua fungsi di sini yang nutup lubang itu:
 *
 *   sisaKuota()      dipakai halaman web buat nampilin sisa kuota
 *   peringatanKuota() dipanggil di jalur pesan, kirim kabar sekali per ambang
 *
 * Ambang dikirim SEKALI per perubahan ambang, bukan tiap pesan — kalau tidak,
 * nomor owner kebanjiran pesan "kuota hampir habis".
 */
const { pool } = require('../config/database');
const pricingStore = require('../config/pricingStore');
const { ADMIN_ROLE, DEFAULT_PLANS, TRIAL, aktif, kuotaBot } = require('../config/plan');

// Ambang peringatan: 80% dan 95% dari kuota SEUMUR PAKET.
const AMBANG = [0.8, 0.95];

// Sudah kirim peringatan ambang berapa, per bot — di memori, sengaja: kalau
// prosesnya restart dan pesannya terkirim dua kali, itu jauh lebih ringan
// daripada nyimpen kolom baru cuma buat ini.
const sudahKirim = new Map(); // botId -> ambang terakhir yang dikabarkan

/** Paket yang sedang berlaku buat pemilik bot ini (null = habis/tak dikenal). */
async function paketBot(botId) {
  const [rows] = await pool.execute(
    `SELECT u.id, u.role, u.plan, u.plan_expired_at
       FROM bots b JOIN users u ON u.id = b.user_id
      WHERE b.id = ? LIMIT 1`,
    [botId]
  );
  const u = rows[0];
  if (!u || !aktif(u)) return null;
  return { pemilik: u, paket: [...(pricingStore.plans() || DEFAULT_PLANS), TRIAL].find((p) => p.id === u.plan) || null };
}

/**
 * Sisa kuota bot ini. `null` = tanpa batas (admin / paket tanpa `receive_limit`).
 * Bentuknya siap dipakai halaman web, jadi halaman nggak perlu hitung sendiri.
 */
async function sisaKuota(botId) {
  const [botRows] = await pool.execute(
    'SELECT id, user_id, receive_limit, received_count, daily_limit FROM bots WHERE id = ? LIMIT 1',
    [botId]
  );
  const bot = botRows[0];
  if (!bot) return null;

  const [uRows] = await pool.execute(
    'SELECT id, role, plan, plan_expired_at FROM users WHERE id = ? LIMIT 1', [bot.user_id]
  );
  const u = uRows[0];
  if (!u) return null;
  if (u.role === ADMIN_ROLE) return { tanpaBatas: true, paketAktif: true, habis: false };

  const paketAktif = aktif(u);
  const paket = paketAktif
    ? [...(pricingStore.plans() || DEFAULT_PLANS), TRIAL].find((p) => p.id === u.plan) : null;

  const jatahPaket = Number(paket?.receive_limit) || 0;
  const jatahBot = Number(bot.receive_limit) || 0;
  // Kolom bot cuma boleh MENURUNKAN jatah paket — sama seperti `batasKuota()`.
  const dasar = jatahPaket > 0 ? (jatahBot > 0 ? Math.min(jatahBot, jatahPaket) : jatahPaket) : 0;

  // Kuota top-up dari admin DITAMBAHKAN di atas paket. Dihitung lewat fungsi
  // yang sama dengan penegakan (`gatePaket.jatahTambahan`) supaya angka di
  // halaman /kuota tidak pernah berbeda dengan yang benar-benar ditegakkan —
  // dua sumber kebenaran di jalur uang adalah cara paling cepat membuat user
  // protes "kuota saya masih ada tapi bot diam".
  const { jatahTambahan } = require('./gatePaket');
  const bonus = await jatahTambahan(bot.id);

  const batas = dasar + bonus;
  const terpakai = Number(bot.received_count) || 0;

  return {
    paketAktif,
    habis: !paketAktif || (batas > 0 && terpakai >= batas),
    tanpaBatas: batas === 0,
    batas,
    terpakai,
    // Ditampilkan terpisah supaya user tahu berapa dari jatahnya yang bonus —
    // kalau digabung saja, "kok kuota saya nambah?" jadi pertanyaan ke admin.
    bonus,
    sisa: batas > 0 ? Math.max(0, batas - terpakai) : null,
    persen: batas > 0 ? Math.min(100, Math.round((terpakai / batas) * 100)) : 0,
    // Harian cuma buat ditampilin — `rpg_members.lim` direset cron tiap 00:00.
    // `daily_limit` per bot boleh MENURUNKAN jatah paket, dan `kuotaBot` sudah
    // mengurus itu — jangan dihitung ulang di sini.
    harian: kuotaBot(u, bot, pricingStore.plans()),
  };
}

/**
 * Kirim peringatan kalau kuota sudah lewat ambang. Dipanggil dari jalur pesan —
 * TIDAK BOLEH ngeblok pesan, jadi sengaja tidak di-await pemanggilnya.
 * @returns {Promise<string|null>} ambang yang barusan dikabarkan, atau null
 */
async function peringatanKuota(botId, botData) {
  try {
    const s = await sisaKuota(botId);
    if (!s || s.tanpaBatas) return null;

    // `s.persen` = berapa persen yang SUDAH terpakai (80 = hampir habis).
    // Ambang terakhir yang sudah dilewati — dibandingkan dengan angka, bukan
    // float, biar 80 tepat di ambang pertama.
    const lewat = AMBANG.filter((a) => s.persen >= a * 100).pop();
    const sudah = sudahKirim.get(botId);
    if (lewat === undefined || lewat === sudah) return null;
    sudahKirim.set(botId, lewat);

    const { kirimKeOwner } = require('./notify');
    const pesan = s.sisa === 0
      ? `🚫 *Kuota pesan bot kamu sudah habis.*\n\n` +
        `Bot berhenti membalas sampai paket ditambah. Perpanjang di halaman Pricing:\n` +
        `/pricing`
      : `⚠️ *Kuota pesan bot kamu tinggal ${s.sisa.toLocaleString('id-ID')}.*\n\n` +
        `Dari total ${s.batas.toLocaleString('id-ID')} pesan. Kalau habis, bot berhenti ` +
        `membalas sampai paket ditambah.\n\n` +
        `Tambah kuota: /pricing`;

    await kirimKeOwner(botData?.user_id || (await pool.execute(
      'SELECT user_id FROM bots WHERE id = ? LIMIT 1', [botId]
    ))[0][0]?.user_id, pesan);
    return String(lewat);
  } catch {
    return null; // peringatan itu bonus — jangan sampai bikin pesan gagal
  }
}

/** Dipakai tes & reset manual (mis. setelah paket diperpanjang). */
function lupakanPeringatan(botId) {
  if (botId == null) sudahKirim.clear();
  else sudahKirim.delete(botId);
}

module.exports = { sisaKuota, peringatanKuota, lupakanPeringatan, paketBot, AMBANG };
