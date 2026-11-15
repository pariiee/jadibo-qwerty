'use strict';
/**
 * test/order-expire-cron.js — cron penanda order gateway basi (server.js).
 *
 * Kunci yang dicek, murni statis (tidak nyentuh DB):
 *   1. SQL hanya menyentuh status='pending' DAN expired_at IS NOT NULL —
 *      order manual (expired_at selalu NULL, dikonfirmasi admin) tidak
 *      boleh ikut ter-expire oleh cron ini.
 *   2. Syarat waktu pakai expired_at < NOW() (bukan created_at), sesuai
 *      expired_at yang dikirim gateway Alpay saat checkout.
 *   3. Status baru 'expired' — bukan 'rejected'/'cancelled' — supaya
 *      billingController.tandaiLunas (status IN ('pending','expired'))
 *      tetap bisa melunaskannya kalau webhook telat datang.
 *
 * Jalankan: node test/order-expire-cron.js
 */
const fs = require('fs');
const path = require('path');

let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`  ✓ ${nama}`);
  else { gagal++; console.error(`  ✗ ${nama}${info ? ' — ' + info : ''}`); }
};

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const blok = src.slice(
  src.indexOf("// Order gateway (QRIS otomatis)"),
  src.indexOf("cronAman.schedule('0 4 * * *'")
);

cek('blok cron order-expire ditemukan', blok.length > 0);
cek("SQL mensyaratkan status = 'pending'", /status\s*=\s*'pending'/.test(blok));
cek('SQL mensyaratkan expired_at IS NOT NULL (lindungi order manual)', /expired_at IS NOT NULL/.test(blok));
cek('SQL mensyaratkan expired_at < NOW()', /expired_at\s*<\s*NOW\(\)/.test(blok));
cek("status baru 'expired' (tetap bisa dilunaskan webhook susulan)", /SET status = 'expired'/.test(blok));
cek('tidak menyentuh kolom lain (paid_at/note) yang berarti sudah lunas', !/paid_at\s*=\s*NOW\(\)/.test(blok));

console.log(gagal ? `\n❌ ${gagal} gagal` : '\n✅ cron order-expire: syarat SQL aman (order manual tidak kesentuh)');
process.exitCode = gagal ? 1 : 0;
