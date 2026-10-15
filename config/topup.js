'use strict';

/**
 * config/topup.js — aturan nominal top up (murni, tanpa DB).
 *
 * SENGAJA DI SINI, bukan di controller: batas & kelipatan itu keputusan
 * produk yang dibaca dua tempat (endpoint top up dan halaman /saldo), dan
 * menaruhnya di controller membuat halaman harus menebak atau menduplikasi.
 *
 * Nominal TIDAK PERNAH diterima dari klien. Klien cuma mengirim nomor pilihan
 * dari daftar ini, atau angka yang harus lolos `validasiNominal` — harga order
 * selalu diambil ulang dari sini. Kalau klien bisa mengirim nominal bebas,
 * dia bisa top up Rp1 dan menguras gateway.
 */

// Batas & bentuk nominal. Semua kelipatan 1000 supaya tidak ada sisa receh
// yang bikin saldo berakhir .500 dan susah dicocokkan dengan ledger.
const TOPUP_MIN = 5000;
const TOPUP_MAX = 500000;
const TOPUP_KELIPATAN = 1000;

// Pilihan cepat di UI. Bukan sumber kebenaran — cuma pintasan; angkanya tetap
// divalidasi ulang di server seperti nominal yang diketik manual.
const TOPUP_CEPAT = [5000, 10000, 20000, 50000, 100000];

// Batas order top up yang boleh menggantung. Dihitung HANYA dari order yang
// belum lewat masa berlaku QRIS (5 menit — lihat MASA_QRIS_MS dan catatan di
// walletController), jadi user tidak terkunci oleh order yang sudah mati.
const TOPUP_MAKS_PENDING = 3;

// Masa berlaku QRISku. Dari dokumentasi gateway: "Creates a payment valid for
// 5 minutes". Dipakai buat menghitung order pending yang masih "hidup".
// Dipakai sebagai cadangan kalau gateway tidak mengirim `expired_at`.
const MASA_QRIS_MS = 5 * 60 * 1000;

/**
 * Nominal valid? Integer, dalam rentang, kelipatan 1000.
 *
 * Ketat dengan sengaja di semua tepi:
 *   - Number.isInteger menolak 10000.5, NaN, Infinity
 *   - typeof number menolak "10000" (string dari JSON/form)
 *   - tolak 0 dan negatif sebelum cek rentang, biar pesannya jelas
 *   - tolak di atas TOPUP_MAX SEBELUM apa pun, jadi angka 1e21 tidak pernah
 *     sampai ke gateway (gateway juga menolak di atas 1e9, tapi kita tidak
 *     mau bergantung pada penolakan orang lain)
 *
 * @returns {{ok: true, nominal: number} | {ok: false, message: string}}
 */
function validasiNominal(n) {
  if (typeof n !== 'number' || !Number.isInteger(n)) {
    return { ok: false, message: 'Nominal harus bilangan bulat' };
  }
  if (n <= 0) return { ok: false, message: 'Nominal harus lebih dari 0' };
  if (n > TOPUP_MAX) {
    return { ok: false, message: `Nominal maksimal Rp${TOPUP_MAX.toLocaleString('id-ID')}` };
  }
  if (n < TOPUP_MIN) {
    return { ok: false, message: `Nominal minimal Rp${TOPUP_MIN.toLocaleString('id-ID')}` };
  }
  if (n % TOPUP_KELIPATAN !== 0) {
    return { ok: false, message: `Nominal harus kelipatan Rp${TOPUP_KELIPATAN.toLocaleString('id-ID')}` };
  }
  return { ok: true, nominal: n };
}

/** Batas waktu order pending masih dianggap hidup. `expired_at` null = pakai masa QRIS. */
function masihHidup(expiredAt, sekarang = Date.now()) {
  if (!expiredAt) return sekarang - 0 < MASA_QRIS_MS; // tanpa tanggal: anggap baru
  return new Date(expiredAt).getTime() > sekarang;
}

module.exports = {
  TOPUP_MIN, TOPUP_MAX, TOPUP_KELIPATAN, TOPUP_CEPAT, TOPUP_MAKS_PENDING,
  MASA_QRIS_MS, validasiNominal, masihHidup,
};
