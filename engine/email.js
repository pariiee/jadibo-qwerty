'use strict';

/**
 * engine/email.js — jalur kabar lewat EMAIL.
 *
 * Kenapa ada: SEMUA peringatan (kuota habis, bot mati, masa aktif habis) dikirim
 * lewat WhatsApp, dan pengirimnya adalah bot MILIK USER ITU SENDIRI
 * (lihat engine/notify.js). Jadi saat botnya yang bermasalah, kabarnya ikut
 * hilang — user menyimpulkan "bot rusak" dan tidak ada satu pun jalur yang
 * membiarkannya memeriksa sendiri. Email tidak bergantung pada bot itu.
 *
 * SENGAJA TANPA DEPENDENSI BARU. Nodemailer itu berat dan repo ini sudah punya
 * `axios` — SMTP HTTP API (Resend/Brevo/Mailgun/SendGrid) cuma butuh satu POST.
 * Jadi ini satu fungsi kecil, bukan pustaka SMTP penuh.
 *
 * Kegagalan kirim TIDAK PERNAH melempar: email itu bonus, sama seperti notif WA.
 * Pemanggilnya tidak boleh gagal gara-gara ini.
 */

const { pool } = require('../config/database');

// Kalau salah satu kosong, email jadi no-op. Ada peringatan sekali per proses
// (lihat ingatkanSekali) supaya tidak gagal senyap.
const API_URL = process.env.MAIL_API_URL || '';   // mis. https://api.resend.com/emails
const API_KEY = process.env.MAIL_API_KEY || '';
const DARI = process.env.MAIL_FROM || '';         // mis. "YaaParBot <kabar@yapari.web.id>"

/** Email dikonfigurasi? Kalau tidak, semua fungsi di sini jadi no-op. */
function siap() {
  return Boolean(API_URL && API_KEY && DARI);
}

// Sudah pernah bilang "belum dikonfigurasi"? Sekali per proses cukup.
// SENGAJA ada: tanpa ini, email yang tidak dikonfigurasi gagal DIAM-DIAM dan
// hilang tanpa jejak — persis pola kegagalan senyap yang sedang diberantas.
let sudahBilang = false;
function ingatkanSekali() {
  if (sudahBilang) return;
  sudahBilang = true;
  console.warn('[Email] MAIL_API_URL / MAIL_API_KEY / MAIL_FROM belum lengkap — email TIDAK akan terkirim (notif cuma lewat WhatsApp)');
}

/**
 * Validasi email yang longgar tapi berguna.
 *
 * ponytail: cukup tolak yang JELAS salah (tanpa @, tanpa titik di domain, ada
 * spasi). Validasi email yang "benar-benar benar" itu regex sepanjang paragraf
 * dan tetap salah — verifikasi sebenarnya cuma lewat kirim + klik tautan.
 */
function emailValid(alamat) {
  const s = String(alamat || '').trim();
  if (s.length < 6 || s.length > 254) return false;
  if (/\s/.test(s)) return false;
  return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(s);
}

/** Ambil email user, kalau ada. */
async function emailUser(userId) {
  try {
    const [r] = await pool.execute('SELECT email FROM users WHERE id = ? LIMIT 1', [userId]);
    const alamat = String(r[0]?.email || '').trim();
    return emailValid(alamat) ? alamat : '';
  } catch {
    // Kolomnya belum ada (DB lama belum `sync-schema`) — bukan alasan gagal.
    return '';
  }
}

/**
 * Kirim satu email.
 * @returns {Promise<boolean>} true kalau penyedia menerimanya
 */
async function kirimEmail(ke, subjek, isi) {
  if (!siap()) { ingatkanSekali(); return false; }
  if (!emailValid(ke) || !subjek || !isi) return false;

  try {
    const axios = require('axios');
    await axios.post(
      API_URL,
      { from: DARI, to: [ke], subject: String(subjek).slice(0, 200), text: String(isi) },
      { headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    console.log(`[Email] terkirim ke ${ke}: ${subjek}`);
    return true;
  } catch (e) {
    // Termasuk 4xx (domain pengirim belum diverifikasi, kuota habis). Jejaknya
    // harus ADA — email yang gagal tanpa log itu cara termahal kehilangan user.
    const detail = e?.response?.status ? `HTTP ${e.response.status}` : e?.message;
    console.error(`[Email] gagal ke ${ke}: ${detail}`);
    return false;
  }
}

/** Ambil email user lalu kirim ke situ. false = user tidak punya email / gagal. */
async function kirimKeUser(userId, subjek, isi) {
  const alamat = await emailUser(userId);
  if (!alamat) return false;
  return kirimEmail(alamat, subjek, isi);
}

module.exports = { kirimEmail, kirimKeUser, emailValid, emailUser, siap };
