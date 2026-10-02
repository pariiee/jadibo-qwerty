'use strict';
/**
 * test/notify-terpasang.js
 * Modul notify bisa lulus tes sendiri tapi TIDAK PERNAH DIPANGGIL — itu bug
 * yang paling gampang lolos. Tes ini manggil tandaiLunas() (jalur pembayaran
 * asli) dengan pool palsu, lalu memastikan notifikasinya benar-benar keluar
 * DAN tidak menahan pembayaran.
 *
 * Nggak nyentuh DB maupun WhatsApp.
 */
const path = require('path');

let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`✅ ${nama}`);
  else { gagal++; console.log(`❌ ${nama}${info ? ' — ' + info : ''}`); }
};

const dicatat = [];          // query yang lewat
const notif = [];            // notifikasi yang dipanggil
let notifNganggur = false;   // notif yang sengaja lambat

const poolPalsu = {
  execute: async (sql, params = []) => {
    dicatat.push(sql.replace(/\s+/g, ' ').trim().slice(0, 60));
    if (/UPDATE orders SET status = 'paid'/i.test(sql)) return [{ affectedRows: 1 }];
    if (/SELECT user_id, plan FROM orders/i.test(sql)) return [[{ user_id: 42, plan: 'premium' }]];
    if (/SELECT plan_expired_at FROM users/i.test(sql)) return [[{ plan_expired_at: null }]];
    if (/UPDATE bots SET daily_limit/i.test(sql)) return [{ affectedRows: 1 }];
    if (/UPDATE users SET plan/i.test(sql)) return [{ affectedRows: 1 }];
    // Query efek-samping yang ditambahkan `terapkanPaket`: daftar bot milik user
    // (buat melupakan peringatan kuota + menyalakan bot yang mati karena paket).
    // Mock WAJIB ikut bentuk baru ini — mock yang ketinggalan bikin tesnya hijau
    // padahal kodenya sudah beda jalur.
    if (/SELECT id FROM bots WHERE user_id/i.test(sql)) return [[]];
    return [[]];
  },
};

function palsukan(modul, ekspor) {
  const j = require.resolve(path.join(__dirname, '..', modul));
  require.cache[j] = { id: j, filename: j, loaded: true, exports: ekspor };
}

palsukan('config/database.js', { pool: poolPalsu, incrementStat: async () => {}, decrementStat: async () => {} });
palsukan('engine/notify.js', {
  kirimKeOwner: async (userId, teks) => {
    notif.push({ userId, teks });
    if (notifNganggur) await new Promise((r) => setTimeout(r, 5000));
    return true;
  },
});

const billing = require('../controllers/billingController');

(async () => {
  // ── 1. Jalur lunas: notif HARUS keluar ─────────────────────────────────────
  const hasil = await billing.tandaiLunas('ORD-TES-1', { payment_reference_id: 'REF-1' });
  cek('paket diterapkan', hasil?.plan === 'premium', JSON.stringify(hasil));
  cek('notifikasi DIPANGGIL dari jalur lunas', notif.length === 1, `dipanggil ${notif.length}x`);
  cek('notif ditujukan ke pemilik order', notif[0]?.userId === 42, String(notif[0]?.userId));
  cek('notif menyebut nama paket', /Premium/i.test(notif[0]?.teks || ''), notif[0]?.teks?.slice(0, 60));
  cek('notif menyebut tanggal berakhir', /aktif sampai/i.test(notif[0]?.teks || ''));

  // ── 2. Order yang sudah pernah lunas: jangan dobel ─────────────────────────
  poolPalsu.execute = async (sql) => {
    if (/UPDATE orders SET status = 'paid'/i.test(sql)) return [{ affectedRows: 0 }];
    return [[]];
  };
  notif.length = 0;
  const ulang = await billing.tandaiLunas('ORD-TES-1', {});
  cek('order yang sudah lunas tidak dobel', ulang?.sudah === true);
  cek('tidak ada notif kedua', notif.length === 0, `${notif.length}x`);

  // ── 3. Yang paling penting: notif lambat JANGAN nahan pembayaran ───────────
  // Ini yang bikin webhook QRIS timeout -> QRISku kirim ulang -> paket dobel.
  // Pool-nya dibalikin ke versi lengkap dulu (bagian 2 sengaja bikin affectedRows 0).
  notifNganggur = true;
  notif.length = 0;
  poolPalsu.execute = async (sql, params = []) => {
    if (/UPDATE orders SET status = 'paid'/i.test(sql)) return [{ affectedRows: 1 }];
    if (/SELECT user_id, plan FROM orders/i.test(sql)) return [[{ user_id: 42, plan: 'premium' }]];
    if (/SELECT plan_expired_at FROM users/i.test(sql)) return [[{ plan_expired_at: null }]];
    if (/SELECT id FROM bots WHERE user_id/i.test(sql)) return [[]];
    return [{ affectedRows: 1 }];
  };
  const t0 = Date.now();
  const cepat = await billing.tandaiLunas('ORD-TES-2', {});
  const durasi = Date.now() - t0;
  cek('notif lambat tidak menahan tandaiLunas', durasi < 1000, `${durasi} ms`);
  cek('paketnya tetap diterapkan', cepat?.plan === 'premium', JSON.stringify(cepat));

  // Notif yang nganggur tetap diselesaikan (biar nggak jadi unhandled rejection).
  await new Promise((r) => setTimeout(r, 5200));
  cek('notif yang nganggur akhirnya terkirim', notif.length === 1, `${notif.length}x`);

  console.log(gagal ? `\n=== GAGAL: ${gagal} masalah ===` : '\n=== SEMUA CEK LULUS ===');
  process.exit(gagal ? 1 : 0);
})();
