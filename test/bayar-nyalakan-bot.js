'use strict';
/**
 * test/bayar-nyalakan-bot.js
 *
 * Lubang yang ditambal di sini: bot dimatikan cron karena paket habis
 * (`stop_reason='expired'`), lalu user BAYAR — dan botnya tetap mati. Dia baru
 * bayar, tapi yang dia lihat cuma WA "pembayaran diterima" sementara botnya
 * diam, sampai dia sadar sendiri dan klik Start.
 *
 * Yang diuji, semuanya di `terapkanPaket` (satu-satunya jalur "paket jadi
 * aktif": webhook QRIS, tombol Cek Status, konfirmasi admin):
 *
 *   1. bot ber-stop_reason='expired' -> engineBus.start dipanggil
 *   2. bot yang mati NORMAL (user klik Stop) -> TIDAK dinyalakan
 *   3. bot milik user lain -> TIDAK ikut dinyalakan (bahaya paling nyata)
 *   4. peringatan kuota dilupakan per bot milik user itu (langganan ke-2 harus
 *      dapat peringatan 80% lagi)
 *   5. kirim notif WA gagal -> terapkanPaket tetap sukses
 *   6. start WA gagal -> terapkanPaket tetap sukses (user sudah bayar!)
 *
 * Pool, engineBus, notify, gatePaket, dan kuota dipalsukan: nol DB, nol WA.
 */
const path = require('path');

let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`✅ ${nama}`);
  else { gagal++; console.log(`❌ ${nama}${info ? ' — ' + info : ''}`); }
};

// ── Keadaan palsu ────────────────────────────────────────────────────────────
const USER_ID = 7;
let baris = {
  // bot milik user ini
  bots: [
    { id: 41, is_running: 0, stop_reason: 'expired' },   // dimatikan sistem
    { id: 42, is_running: 0, stop_reason: null },        // distop user sendiri
  ],
  // bot milik ORANG LAIN yang kebetulan juga 'expired'
  punyaOrangLain: [{ id: 99 }],
};

const dijalankan = [];   // id bot yang di-start
const dilupakan = [];    // id bot yang peringatan kuotanya dihapus
const notif = [];        // pesan ke owner
let notifMelempar = false;
let startGagal = false;
let poolRusak = false;   // query efek-samping melempar (DB hiccup)

function palsukan(modul, ekspor) {
  const j = require.resolve(path.join(__dirname, '..', modul));
  require.cache[j] = { id: j, filename: j, loaded: true, exports: ekspor };
}

const poolPalsu = {
  execute: async (sql, params) => {
    const p = params || [];
    // Hanya query efek-samping yang dirusak — query inti (paket diberikan) tetap
    // jalan, supaya yang diuji benar-benar "efek samping gagal", bukan "semua gagal".
    if (poolRusak && /SELECT id FROM bots/i.test(sql)) throw new Error('DB hiccup');
    // SELECT id FROM bots WHERE user_id = ? AND is_running = 0 AND stop_reason = 'expired'
    if (/is_running = 0 AND stop_reason/i.test(sql)) {
      return [baris.bots.filter((b) => b.is_running === 0 && b.stop_reason === 'expired').map((b) => ({ id: b.id }))];
    }
    // SELECT id FROM bots WHERE user_id = ?   (buat lupakanPeringatan per bot)
    if (/SELECT id FROM bots/i.test(sql)) {
      return [p[0] === USER_ID ? baris.bots.map((b) => ({ id: b.id })) : baris.punyaOrangLain];
    }
    if (/plan_expired_at/i.test(sql) && /SELECT/i.test(sql)) return [[{ plan_expired_at: null }]];
    return [[]];
  },
};

palsukan('config/database.js', { pool: poolPalsu, incrementStat: async () => {}, decrementStat: async () => {} });
palsukan('config/pricingStore.js', { getPlan: (id) => ({ id, name: 'Basic', price: 25000, days: 30, daily_limit: 30, receive_limit: 10000 }), plans: () => [] });
palsukan('config/qrisku.js', {});
palsukan('engine/gatePaket.js', { segarkan: () => {}, kuotaHarian: () => 30, kuotaHabis: async () => false });
palsukan('engine/kuota.js', {
  lupakanPeringatan: (id) => dilupakan.push(id),
  sisaKuota: async () => null,
  peringatanKuota: async () => null,
});
palsukan('engine/notify.js', {
  kirimKeOwner: async (uid, teks) => { if (notifMelempar) throw new Error('WA mati'); notif.push({ uid, teks }); return true; },
});
palsukan('config/engineBus.js', {
  start: async (id) => { if (startGagal) throw new Error('zapo mati'); dijalankan.push(id); return { ok: true }; },
  stop: async () => ({ ok: true }), restart: async () => ({ ok: true }), stopIfRunning: async () => ({ ok: true }),
});

const { terapkanPaket } = require('../controllers/billingController');

// start() sengaja TIDAK di-await pemanggilnya (webhook jangan lambat) — kasih
// satu putaran event loop supaya promise-nya sempat jalan sebelum diperiksa.
const tunggu = () => new Promise((r) => setTimeout(r, 40));

(async () => {
  // ── 1..3 ────────────────────────────────────────────────────────────────────
  const hasil = await terapkanPaket(USER_ID, 'basic');
  await tunggu();

  cek('paket benar-benar diterapkan', hasil?.plan === 'basic' && !!hasil?.sampai);
  cek('bot ber-stop_reason=expired dinyalakan kembali', dijalankan.includes(41), JSON.stringify(dijalankan));
  cek('bot yang distop USER tidak ikut dinyalakan', !dijalankan.includes(42), JSON.stringify(dijalankan));
  cek('bot milik user LAIN tidak disentuh', !dijalankan.includes(99), JSON.stringify(dijalankan));
  cek('cuma SATU bot dinyalakan', dijalankan.length === 1, `${dijalankan.length}`);

  // ── 4. peringatan kuota dilupakan per bot ──────────────────────────────────
  cek('peringatan bot 41 dilupakan (langganan ke-2 dapat peringatan lagi)', dilupakan.includes(41), JSON.stringify(dilupakan));
  cek('peringatan bot 42 juga dilupakan', dilupakan.includes(42));
  cek('peringatan bot user lain TIDAK dilupakan', !dilupakan.includes(99), JSON.stringify(dilupakan));

  // ── 5. notif WA melempar -> paket tetap aktif ──────────────────────────────
  const cekPaket = async (nama, siapkan) => {
    dijalankan.length = 0; notif.length = 0; dilupakan.length = 0;
    siapkan();
    let melempar = false;
    try { await terapkanPaket(USER_ID, 'basic'); } catch { melempar = true; }
    await tunggu();
    return { melempar, nama };
  };

  let r = await cekPaket('notif', () => { notifMelempar = true; });
  cek('notif WA gagal -> terapkanPaket TIDAK melempar', r.melempar === false);
  notifMelempar = false;

  // ── 6. start WA gagal -> paket tetap aktif ─────────────────────────────────
  r = await cekPaket('start', () => { startGagal = true; });
  cek('start WA gagal -> terapkanPaket TIDAK melempar', r.melempar === false);
  startGagal = false;

  // ── 7. QUERY efek samping gagal -> paket tetap aktif ──────────────────────
  // Ini yang ditangkap tes lama: `botKu is not iterable` di tengah terapkanPaket
  // = pembayaran yang sudah masuk dilaporkan GAGAL. Efek samping sesudah paket
  // diberikan tidak boleh punya kuasa membatalkan apa pun.
  r = await cekPaket('query', () => { poolRusak = true; });
  cek('query efek samping gagal -> terapkanPaket TIDAK melempar', r.melempar === false);
  poolRusak = false;

  console.log(gagal ? `\n=== GAGAL: ${gagal} masalah ===` : '\n=== SEMUA CEK LULUS ===');
  process.exit(gagal ? 1 : 0);
})();
