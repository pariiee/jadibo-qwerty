'use strict';

/**
 * engine/health.js — kesehatan sistem + alarm WhatsApp.
 *
 * Kenapa ada: waktu notif WA gagal terkirim, satu-satunya cara tahu adalah
 * pemiliknya mengecek HP manual. Hal yang sama berlaku untuk bot yang mati dan
 * pembayaran yang gagal. Tidak ada satu pun alarm. Modul ini menutup itu.
 *
 * Dua aturan yang bikin alarm ini berguna, bukan menjengkelkan:
 *
 *   1. **Toleransi 3 kali berturut-turut.** Bot butuh ~14 detik buat connect
 *      setiap kali restart, dan proses restart sendiri tiap deploy. Tanpa
 *      toleransi, tiap deploy mengirim alarm palsu — dan alarm yang sering
 *      salah akan diabaikan, yang sama saja dengan tidak punya alarm.
 *   2. **Alarm cuma saat BERUBAH, lalu diulang tiap jam.** Sekali rusak lalu
 *      dibiarkan, pengulangan tiap menit bikin nomor tujuan diblokir.
 *
 * Alarm dikirim lewat `engine/notify.kirimKeNomor` — sengaja TIDAK lewat DB,
 * supaya kerusakan database tetap bisa dilaporkan.
 */

const { pool } = require('../config/database');

const GAGAL_BERTURUT = 3;                      // ~3 menit sebelum alarm
const ULANG_ALARM_MS = 60 * 60 * 1000;         // kalau masih rusak, ingatkan tiap jam
const TOLERANSI_BOT = 0;                       // bot harus jalan tapi belum connected

let gagalBerturut = 0;
let terakhirAlarm = 0;
let sedangRusak = false;

/** Cek kesehatan. Tidak pernah melempar — kerusakan dilaporkan sebagai data. */
async function cek() {
  const h = { ok: true, db: false, bots_online: 0, bots_harus_jalan: 0, alasan: [] };

  try {
    await pool.execute('SELECT 1');
    h.db = true;
  } catch (e) {
    h.alasan.push('database tidak bisa dihubungi');
  }

  if (h.db) {
    try {
      const [r] = await pool.execute(
        "SELECT SUM(is_running = 1) AS harus, SUM(status = 'connected') AS online FROM bots"
      );
      h.bots_harus_jalan = Number(r[0]?.harus || 0);
      h.bots_online = Number(r[0]?.online || 0);
      const kurang = h.bots_harus_jalan - h.bots_online;
      if (kurang > TOLERANSI_BOT) {
        h.alasan.push(`${kurang} bot seharusnya jalan tapi belum terhubung`);
      }
    } catch (e) {
      h.alasan.push('daftar bot tidak bisa dibaca');
    }
  }

  h.ok = h.alasan.length === 0;
  return h;
}

/**
 * Dipanggil dari cron yang SUDAH ada (tiap menit). Mengembalikan keputusan
 * yang diambil, supaya bisa diuji tanpa mengirim WhatsApp sungguhan.
 * @returns {Promise<{aksi:'diam'|'alarm'|'pulih', hasil:object}>}
 */
async function periksaDanAlarm(kirim = null) {
  const hasil = await cek();

  if (hasil.ok) {
    const pulih = sedangRusak;
    gagalBerturut = 0;
    sedangRusak = false;
    terakhirAlarm = 0;
    return { aksi: pulih ? 'pulih' : 'diam', hasil };
  }

  gagalBerturut++;
  if (gagalBerturut < GAGAL_BERTURUT) return { aksi: 'diam', hasil };

  const sekarang = Date.now();
  const baruRusak = !sedangRusak;
  sedangRusak = true;

  // Kirim kalau ini kerusakan BARU, atau sudah lewat sejam sejak alarm terakhir.
  if (!baruRusak && sekarang - terakhirAlarm < ULANG_ALARM_MS) {
    return { aksi: 'diam', hasil };
  }
  terakhirAlarm = sekarang;

  const nomor = String(process.env.DEVELOPER_NUMBER || '').replace(/\D/g, '');
  if (!nomor) {
    console.warn('[Health] RUSAK tapi DEVELOPER_NUMBER kosong — alarm tidak bisa dikirim:', hasil.alasan.join('; '));
    return { aksi: 'diam', hasil, sebab: 'nomor-kosong' };
  }

  const teks =
    `🚨 *Ada yang rusak di server bot*\n\n` +
    hasil.alasan.map((a) => `• ${a}`).join('\n') +
    `\n\nBot online: ${hasil.bots_online} dari ${hasil.bots_harus_jalan} yang seharusnya jalan.` +
    `\n\n_Cek: /kountole_`;
  try {
    const fn = kirim || require('./notify').kirimKeNomor;
    await fn(nomor, teks);
  } catch (e) {
    console.error('[Health] alarm gagal dikirim:', e.message);
  }
  return { aksi: 'alarm', hasil };
}

/** Dipakai tes — mengembalikan penghitung ke keadaan awal. */
function reset() {
  gagalBerturut = 0;
  terakhirAlarm = 0;
  sedangRusak = false;
}

module.exports = { cek, periksaDanAlarm, reset, GAGAL_BERTURUT, ULANG_ALARM_MS };
