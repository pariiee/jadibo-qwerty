'use strict';
/**
 * test/gerbang-topup.js — order SALDO tidak boleh diperlakukan sebagai paket.
 *
 * Kenapa ada: `pricingStore.getPlan()` fallback ke DEFAULT_PLANS[0], dan itu
 * paket **Gratis** (`{ id:'user', price:0, days:0, daily_limit:10 }`). Jadi id
 * paket yang salah — atau plan='topup' — TIDAK melempar, tapi dijalankan
 * dengan paket Gratis:
 *
 *   - `days || plan.days` jadi 0 -> plan_expired_at di-set ke SEKARANG
 *     (paket user HABIS, padahal dia baru saja bayar)
 *   - daily_limit bot turun ke 10 (kuota user dirampas)
 *   - stop_reason dibersihkan -> bot dinyalakan dengan paket Gratis
 *
 * Nol baris error, nol log. User top up Rp50.000 lalu paketnya hilang.
 *
 * Yang dikunci di sini:
 *   1. order plan='topup' TIDAK PERNAH memanggil terapkanPaket
 *   2. order plan='topup' TIDAK menyentuh plan/plan_expired_at/daily_limit user
 *   3. order dengan paket tak dikenal TIDAK ditandai lunas (biar bisa ditangani)
 *   4. terapkanPaket menolak plan tak dikenal & days<=0 (gagal berisik)
 *   5. plan='topup' dirutekan ke walletController.terapkanTopup
 *
 * Nggak nyentuh DB: pool palsu + walletController palsu.
 *
 * Jalankan: node test/gerbang-topup.js
 */
const assert = require('assert');
const path = require('path');

let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`  ✓ ${nama}`);
  else { gagal++; console.error(`  ✗ ${nama}${info ? ' — ' + info : ''}`); }
};

// ── Catatan query + penyadapan efek samping ──────────────────────────────────
const query = [];
let topupDipanggil = 0;
let topupArg = null;
let efekSamping = { segarkan: 0, notifKirim: 0 };

function poolPalsu(order) {
  return {
    execute: async (sql, params = []) => {
      // Disimpan UTUH (untuk diperiksa) + versi pendek (untuk dibaca manusia).
      // Memotong di sini pernah bikin tes lolos padahal salah: `status IN
      // ('pending','expired')` ada di luar 70 karakter pertama.
      query.push({ penuh: sql.replace(/\s+/g, ' ').trim(), pendek: sql.replace(/\s+/g, ' ').trim().slice(0, 70) });
      if (/SELECT user_id, plan, amount, order_id, status FROM orders/i.test(sql)) {
        return [[{ ...order, amount: order.amount ?? 50000 }]];
      }
      if (/UPDATE orders SET status = 'paid'/i.test(sql)) return [{ affectedRows: 1 }];
      if (/SELECT plan_expired_at FROM users/i.test(sql)) return [[{ plan_expired_at: null }]];
      if (/UPDATE bots SET daily_limit/i.test(sql)) return [{ affectedRows: 1 }];
      if (/UPDATE users SET plan/i.test(sql)) return [{ affectedRows: 1 }];
      if (/SELECT id FROM bots WHERE user_id/i.test(sql)) return [[]];
      return [[]];
    },
  };
}
// Pencocokan memakai SQL penuh; laporan memakai versi pendek.
const cari = (pola) => query.filter((q) => pola.test(q.penuh));
const ringkas = (arr) => arr.map((q) => q.pendek).join(' | ');

function palsukan(modul, ekspor) {
  const j = require.resolve(path.join(__dirname, '..', modul));
  require.cache[j] = { id: j, filename: j, loaded: true, exports: ekspor };
}

function siapkan(order) {
  query.length = 0;
  efekSamping = { segarkan: 0, notifKirim: 0 };
  palsukan('config/database.js', { pool: poolPalsu(order), incrementStat: async () => {} });
  palsukan('engine/notify.js', {
    kirimKeOwner: async () => { efekSamping.notifKirim++; return true; },
  });
  palsukan('engine/gatePaket.js', { segarkan: () => { efekSamping.segarkan++; }, });
  palsukan('engine/kuota.js', { lupakanPeringatan: () => {}, sisaKuota: async () => 0 });
  palsukan('config/engineBus.js', { start: async () => {} });
  // walletController dipalsukan supaya tes ini fokus pada GERBANG, bukan isi
  // wallet. Isi terapkanTopup diuji di test/dompet-topup.js.
  palsukan('controllers/walletController.js', {
    terapkanTopup: async (o, d) => { topupDipanggil++; topupArg = { order: o, data: d }; return { status: 'paid', saldo: 50000 }; },
  });
  delete require.cache[require.resolve('../controllers/billingController')];
  return require('../controllers/billingController');
}

console.log('=== 1. order plan=\'topup\' dirutekan ke terapkanTopup, BUKAN ke terapkanPaket ===');
(async () => {
  topupDipanggil = 0;
  let billing = siapkan({ user_id: 42, plan: 'topup', order_id: 'ORD-TOPUP-1', status: 'pending' });
  const hasil = await billing.tandaiLunas('ORD-TOPUP-1', { payment_reference_id: 'REF-1' });

  cek('terapkanTopup dipanggil tepat 1x', topupDipanggil === 1, `dipanggil ${topupDipanggil}x`);
  cek('hasilnya dari terapkanTopup', hasil?.saldo === 50000, JSON.stringify(hasil));
  cek('order diteruskan apa adanya (user_id & plan utuh)',
    topupArg?.order?.user_id === 42 && topupArg?.order?.plan === 'topup',
    JSON.stringify(topupArg?.order));
  cek('data gateway diteruskan (payment_reference_id)',
    topupArg?.data?.payment_reference_id === 'REF-1',
    JSON.stringify(topupArg?.data));

  console.log('\n=== 2. order topup TIDAK menyentuh paket/kuota user ===');
  const sentuhUsers = cari(/UPDATE users SET plan/i);
  const sentuhBots = cari(/UPDATE bots SET daily_limit/i);
  const bacaPaket = cari(/SELECT plan_expired_at/i);
  cek('TIDAK ada UPDATE users SET plan', sentuhUsers.length === 0, ringkas(sentuhUsers));
  cek('TIDAK ada UPDATE bots SET daily_limit', sentuhBots.length === 0, ringkas(sentuhBots));
  cek('TIDAK baca plan_expired_at (terapkanPaket tidak jalan)', bacaPaket.length === 0, ringkas(bacaPaket));
  cek('TIDAK ada notifikasi paket', efekSamping.notifKirim === 0, `${efekSamping.notifKirim}x`);
  cek('TIDAK segarkan cache paket', efekSamping.segarkan === 0, `${efekSamping.segarkan}x`);

  console.log('\n=== 3. order paket tak dikenal: TIDAK ditandai lunas ===');
  billing = siapkan({ user_id: 42, plan: 'paket-hantu', order_id: 'ORD-HANTU', status: 'pending' });
  const hantu = await billing.tandaiLunas('ORD-HANTU', {});
  const updHantu = cari(/UPDATE orders SET status = 'paid'/i);
  const updUsersHantu = cari(/UPDATE users SET plan/i);
  cek('ada error yang menyebut paketnya', /paket-hantu/.test(hantu?.error || ''), JSON.stringify(hantu));
  cek('TIDAK ditandai lunas (bisa ditangani admin)', updHantu.length === 0, ringkas(updHantu));
  cek('TIDAK ada UPDATE users SET plan', updUsersHantu.length === 0, ringkas(updUsersHantu));
  cek('terapkanTopup tidak dipanggil', topupDipanggil === 1, `${topupDipanggil}x (harus tetap 1 dari blok 1)`);

  console.log('\n=== 4. terapkanPaket menolak plan tak dikenal & masa 0 (gagal berisik) ===');
  billing = siapkan({ user_id: 42, plan: 'topup', order_id: 'X', status: 'pending' });
  // Panggil terapkanPaket langsung — dia diekspor, dan inilah kontraknya.
  let errTakDikenal = null;
  try { await billing.terapkanPaket(42, 'paket-hantu'); }
  catch (e) { errTakDikenal = e; }
  cek('plan tak dikenal MELEMPAR (bukan fallback ke Gratis)', !!errTakDikenal, 'tidak melempar!');
  cek('kode errornya PAKET_TIDAK_DIKENAL', errTakDikenal?.kode === 'PAKET_TIDAK_DIKENAL', errTakDikenal?.message);

  let errMasaNol = null;
  try { await billing.terapkanPaket(42, 'premium', 0); }
  catch (e) { errMasaNol = e; }
  cek('days=0 MELEMPAR (tidak bikin paket habis sekarang)', !!errMasaNol, 'tidak melempar!');
  cek('kode errornya PAKET_MASA_NOL', errMasaNol?.kode === 'PAKET_MASA_NOL', errMasaNol?.message);

  let errPlanGratis = null;
  try { await billing.terapkanPaket(42, 'user'); }
  catch (e) { errPlanGratis = e; }
  cek('paket Gratis (days 0) juga MELEMPAR', !!errPlanGratis, 'tidak melempar!');

  console.log('\n=== 5. jalur normal tetap jalan: paket asli diterapkan ===');
  billing = siapkan({ user_id: 42, plan: 'premium', order_id: 'ORD-BIASa', status: 'pending' });
  const normal = await billing.tandaiLunas('ORD-BIASA', {});
  const updNormal = cari(/UPDATE orders SET status = 'paid'/i);
  const usersNormal = cari(/UPDATE users SET plan/i);
  cek('order paket asli DITANDAI lunas', updNormal.length === 1, ringkas(updNormal));
  cek('paket diterapkan ke user', usersNormal.length === 1, ringkas(usersNormal));
  cek('hasilnya punya nama paket', normal?.plan === 'premium', JSON.stringify(normal));
  cek('penjaga dobel pakai status pending AND expired',
    /status IN \('pending', ?'expired'\)/i.test(updNormal[0]?.penuh || ''),
    updNormal[0]?.penuh);

  console.log(`\n${'─'.repeat(50)}`);
  if (gagal) { console.error(`❌ ${gagal} pemeriksaan GAGAL`); process.exit(1); }
  console.log('✅ Gerbang topup: order saldo tidak pernah menyentuh paket user');
})().catch((e) => { console.error('\n❌ GAGAL:', e.message, e.stack); process.exit(1); });
