'use strict';
/**
 * test/gate-paket.js
 * Batas paket = jalur UANG. Yang dijual cuma KUOTA PESAN, MASA AKTIF, dan
 * JUMLAH OWNER NUMBER. FITUR TIDAK DIJUAL — semua command terbuka untuk semua
 * paket, jadi tidak ada satu pun cek "command X ditolak di paket Y" di sini.
 * Kalau suatu saat muncul lagi, itu regresi.
 *
 * Yang diuji:
 *   1. admin          -> tanpa batas
 *   2. paket aktif    -> kuota dari PAKET (bukan kolom beku), hitungan naik
 *   3. kuota habis    -> pesan ditolak, hitungan tidak naik
 *   4. paket habis    -> pesan ditolak (-1)
 *   5. DB error       -> JANGAN blokir apa pun (bot bisu lebih buruk)
 *   6. kuota harian   -> paket yang berlaku, bukan `bots.daily_limit` beku
 *   7. botKedaluwarsa -> syarat cron auto-stop
 *
 * Pool & pricingStore dipalsukan: tes ini nggak nyentuh DB.
 */
const path = require('path');

let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`✅ ${nama}`);
  else { gagal++; console.log(`❌ ${nama}${info ? ' — ' + info : ''}`); }
};

const besok = new Date(Date.now() + 86400000);
const kemarin = new Date(Date.now() - 86400000);

let pemilik = null;      // baris yang dikembalikan JOIN bots->users
let poolError = false;
const ditulis = [];
// Simulasi baris `bots` — mock MENERAPKAN syarat WHERE-nya, bukan cuma
// membalas angka. Kalau mock-nya selalu bilang "berhasil", tesnya lolos
// walau query-nya salah.
let barisBot = { received_count: 0 };

function palsukan(modul, ekspor) {
  const j = require.resolve(path.join(__dirname, '..', modul));
  require.cache[j] = { id: j, filename: j, loaded: true, exports: ekspor };
}

palsukan('config/database.js', {
  pool: {
    execute: async (sql, params = []) => {
      if (poolError) throw new Error('DB mati');
      ditulis.push(sql.replace(/\s+/g, ' ').trim());
      if (/FROM bots b JOIN users u/i.test(sql)) return [pemilik ? [pemilik] : []];
      // UPDATE bots SET received_count = received_count + 1 WHERE id = ? AND received_count < ?
      if (/received_count = received_count \+ 1/i.test(sql)) {
        const batas = params[1];
        if (barisBot.received_count < batas) { barisBot.received_count += 1; return [{ affectedRows: 1 }]; }
        return [{ affectedRows: 0 }];
      }
      return [{ affectedRows: 1 }];
    },
  },
  incrementStat: async () => {}, decrementStat: async () => {},
});

const { DEFAULT_PLANS } = require('../config/plan');
palsukan('config/pricingStore.js', { plans: () => DEFAULT_PLANS, getPlan: (id) => DEFAULT_PLANS.find((p) => p.id === id) });

const gate = require('../engine/gatePaket');

(async () => {
  const bot = () => ({ id: 4, receive_limit: 0, received_count: 0 });

  // ── 0. Paket TIDAK membatasi fitur ─────────────────────────────────────────
  // Gerbang fitur pernah ada di sini dan sudah dicabut: paket cuma menjual
  // kuota pesan, masa aktif, dan jumlah owner number.
  cek('fitur tidak dibatasi paket: fiturDibolehkan() sudah tidak ada', gate.fiturDibolehkan === undefined);
  cek('fitur tidak dibatasi paket: jatahFitur() sudah tidak ada', gate.jatahFitur === undefined);
  cek('fitur tidak dibatasi paket: jatahBot() sudah tidak ada', gate.jatahBot === undefined);

  // ── 1. Admin tanpa batas ────────────────────────────────────────────────────
  pemilik = { id: 1, role: 'kawula', plan: 'user', plan_expired_at: null };
  gate.segarkan(null);
  cek('admin -> kuota tanpa batas', (await gate.kuotaHabis(4, bot())) === false);
  cek('admin -> batasKuota 0 (tanpa batas)', (await gate.batasKuota(4, bot())) === 0);

  // ── 2. Paket aktif: kuota dari paket, bukan kolom beku ──────────────────────
  pemilik = { id: 3, role: 'user', plan: 'basic', plan_expired_at: besok };
  gate.segarkan(null);
  let b = bot();
  barisBot.received_count = 0;
  cek('basic aktif -> belum habis', (await gate.kuotaHabis(4, b)) === false);
  cek('hitungan naik DI BARISNYA, bukan di memori', barisBot.received_count === 1, String(barisBot.received_count));
  cek('hitungan ditulis lewat satu UPDATE atomik',
    ditulis.some((q) => /received_count = received_count \+ 1.*received_count < \?/i.test(q)),
    ditulis.filter((q) => /received_count/i.test(q)).join(' | '));
  cek('batas dibaca dari PAKET (10.000), bukan kolom bot (0)',
    (await gate.batasKuota(4, b)) === 10000, String(await gate.batasKuota(4, b)));

  // ── 3. Kuota habis ─────────────────────────────────────────────────────────
  // Mock menerapkan syarat `received_count < batas`, jadi yang diuji benar-benar
  // perilaku query-nya — bukan sekadar "fungsi balikin nilai yang diharapkan".
  barisBot.received_count = 10000;
  cek('sudah 10.000 -> habis', (await gate.kuotaHabis(4, b)) === true);
  cek('hitungan TIDAK naik waktu ditolak', barisBot.received_count === 10000, String(barisBot.received_count));
  barisBot.received_count = 9999;
  cek('baru 9.999 -> masih boleh', (await gate.kuotaHabis(4, b)) === false);
  cek('yang ke-10.000 kepakai', barisBot.received_count === 10000, String(barisBot.received_count));
  cek('yang ke-10.001 ditolak', (await gate.kuotaHabis(4, b)) === true);

  // kolom bot boleh MENURUNKAN jatah, tidak menaikkan
  b = bot(); b.receive_limit = 500;
  cek('kolom bot nurunin jatah (500 < 10.000)', (await gate.batasKuota(4, b)) === 500);
  b.receive_limit = 999999;
  cek('kolom bot TIDAK bisa naikin jatah', (await gate.batasKuota(4, b)) === 10000);

  // ── 4. Paket habis -> berhenti melayani ────────────────────────────────────
  pemilik = { id: 3, role: 'user', plan: 'basic', plan_expired_at: kemarin };
  gate.segarkan(null);
  cek('paket habis -> -1 (berhenti melayani)', (await gate.batasKuota(4, bot())) === -1);
  cek('paket habis -> pesan ditolak', (await gate.kuotaHabis(4, bot())) === true);

  // ── 5. DB error -> jangan blokir ───────────────────────────────────────────
  poolError = true;
  gate.segarkan(null);
  cek('DB error -> kuota jangan ngeblok', (await gate.kuotaHabis(4, bot())) === false);

  // ── 6. Kuota HARIAN (cron reset jam 00:00) ─────────────────────────────────
  // Ini yang bikin masa aktif ngefek: kalau cron-nya pakai `bots.daily_limit`
  // yang beku, trial 5 hari yang sudah lewat tetap dapat limit 20 selamanya.
  poolError = false;
  const bd0 = { id: 4, daily_limit: 0 };
  const bd = { id: 4, daily_limit: 20 };
  pemilik = { id: 3, role: 'user', plan: 'basic', plan_expired_at: besok };
  gate.segarkan(null);
  cek('harian paket aktif -> dari paket (Basic 30), bukan kolom beku',
    (await gate.kuotaHarian(bd0)) === 30, String(await gate.kuotaHarian(bd0)));
  cek('harian: kolom bot menurunkan jatah paket (20 < 30)', (await gate.kuotaHarian(bd)) === 20);
  cek('harian: kolom bot TIDAK bisa menaikkan (9999 -> tetap 30)',
    (await gate.kuotaHarian({ id: 4, daily_limit: 9999 })) === 30);

  pemilik = { id: 3, role: 'user', plan: 'basic', plan_expired_at: kemarin };
  gate.segarkan(null);
  cek('harian paket habis -> 0 (bot berhenti melayani)', (await gate.kuotaHarian(bd)) === 0);

  pemilik = { id: 1, role: 'kawula', plan: 'user', plan_expired_at: null };
  gate.segarkan(null);
  cek('harian admin -> tanpa batas (99999)', (await gate.kuotaHarian(bd)) === 99999);

  // ── 7. Bot yang harus DIMATIKAN (paket habis) ──────────────────────────────
  // Syaratnya diperiksa dari SQL-nya, karena pool palsu nggak menerapkan WHERE.
  await gate.botKedaluwarsa().catch(() => {});
  const q = ditulis.find((s) => /plan_expired_at < NOW/i.test(s)) || '';
  cek('botKedaluwarsa: cuma yang paketnya lewat', /plan_expired_at < NOW/i.test(q));
  cek('botKedaluwarsa: jangan sentuh yang belum pernah langganan', /plan_expired_at IS NOT NULL/i.test(q));
  cek('botKedaluwarsa: jangan sentuh admin', /role <> \?/i.test(q));
  cek('botKedaluwarsa: cuma yang sedang jalan', /is_running = 1/i.test(q));

  console.log(gagal ? `\n=== GAGAL: ${gagal} masalah ===` : '\n=== SEMUA CEK LULUS ===');
  process.exit(gagal ? 1 : 0);
})();
