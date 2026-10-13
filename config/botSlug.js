'use strict';

/**
 * config/botSlug.js — id publik bot untuk URL halaman.
 *
 * KENAPA ADA: `/bot/4` gampang ditebak bot auto-scanner. Sama alasannya dengan
 * `/kountole` (lihat catatan panjangnya di server.js): nama yang bisa ditebak =
 * satu permintaan gagal, tapi satu permintaan yang BERHASIL sudah cukup fatal.
 * Halaman ini sendiri sudah dijaga sesi login + cek kepemilikan, ini lapisan
 * kedua — bukan penggantinya.
 *
 * Disimpan di kolom `bots.public_id` (UNIQUE), bukan dihitung dari id.
 * Percobaan pertama modul ini menurunkan slug dari SHA256(id), dan itu SALAH:
 * hash satu arah berarti slug→id tidak bisa dibalik, jadi tiap permintaan harus
 * brute-force 100k hash — biaya itu dibayar juga oleh penyerang yang mau
 * mengirim slug sembarangan. Satu lookup berindeks jauh lebih murah.
 *
 * Nomor lama tetap jalan: `/bot/4` masih membuka bot yang sama, jadi bookmark
 * dan riwayat tidak mati. `resolveBotId()` menerima dua-duanya.
 */

const crypto = require('crypto');
const { pool } = require('./database');

// Tanpa 0/1 dan tanpa vokal: tidak ada slug yang terbaca sebagai kata, dan
// tidak ada yang tertukar saat disalin (0 vs O, 1 vs l).
const HURUF = '23456789bcdfghjklmnpqrstvwxyz';
const PANJANG = 12;

/** Slug acak baru. Bentuknya sengaja seragam: huruf kecil + angka. */
function slugBaru() {
  const buf = crypto.randomBytes(PANJANG);
  let out = '';
  for (let i = 0; i < PANJANG; i++) out += HURUF[buf[i] % HURUF.length];
  return out;
}

/**
 * Pastikan bot punya `public_id`; buat kalau belum. Balikin slug-nya.
 *
 * Dipanggil saat bot dibuat, DAN saat bot lama dibuka — jadi bot yang sudah ada
 * tetap dapat slug walau migrasinya belum sempat dijalankan.
 */
async function pastikanSlug(botId) {
  const [[row]] = await pool.execute('SELECT public_id FROM bots WHERE id = ?', [botId]);
  if (!row) return null;
  if (row.public_id) return row.public_id;

  // Tabrakan praktis mustahil (32^12), tapi UNIQUE yang memutuskan — bukan kita.
  for (let coba = 0; coba < 5; coba++) {
    try {
      await pool.execute('UPDATE bots SET public_id = ? WHERE id = ? AND public_id IS NULL',
        [slugBaru(), botId]);
      const [[cek]] = await pool.execute('SELECT public_id FROM bots WHERE id = ?', [botId]);
      if (cek && cek.public_id) return cek.public_id;
    } catch (e) {
      if (e.code !== 'ER_DUP_ENTRY') throw e;
    }
  }
  return null;
}

/**
 * `:id` dari URL → id angka bot. Terima slug MAUPUN nomor lama.
 * Balikin `null` kalau tidak ada yang cocok (pemanggil yang memutuskan 404).
 */
async function resolveBotId(idAtauSlug) {
  const s = String(idAtauSlug || '').trim();
  if (!s) return null;

  // Nomor lama: /bot/4. Teruskan apa adanya — masih ada yang bookmark.
  if (/^\d+$/.test(s)) return Number(s);

  if (!/^[a-z0-9]{4,64}$/.test(s)) return null;
  const [[row]] = await pool.execute('SELECT id FROM bots WHERE public_id = ?', [s]);
  return row ? row.id : null;
}

module.exports = { slugBaru, pastikanSlug, resolveBotId, PANJANG, HURUF };
