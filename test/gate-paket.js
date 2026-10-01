'use strict';
/**
 * test/gate-paket.js
 * Penegakan batas paket = jalur UANG: kalau salah, pelanggan Ultra dapat
 * layanan Basic, atau user gratis dapat semua fitur. Yang diuji:
 *
 *   1. admin        -> tanpa batas, semua fitur
 *   2. paket aktif  -> kuota dari PAKET (bukan kolom beku), hitungan naik
 *   3. kuota habis  -> pesan ditolak
 *   4. paket habis  -> bot berhenti melayani + fitur turun ke jatah 'user'
 *   5. jatah fitur  -> Basic dapat 100, Ultra dapat 400, Gratis cuma inti
 *   6. DB error     -> JANGAN blokir apa pun (bot bisu lebih buruk)
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

function palsukan(modul, ekspor) {
  const j = require.resolve(path.join(__dirname, '..', modul));
  require.cache[j] = { id: j, filename: j, loaded: true, exports: ekspor };
}

palsukan('config/database.js', {
  pool: {
    execute: async (sql) => {
      if (poolError) throw new Error('DB mati');
      if (/FROM bots b JOIN users u/i.test(sql)) return [pemilik ? [pemilik] : []];
      ditulis.push(sql.replace(/\s+/g, ' ').trim());
      return [{ affectedRows: 1 }];
    },
  },
  incrementStat: async () => {}, decrementStat: async () => {},
});

const { DEFAULT_PLANS } = require('../config/plan');
palsukan('config/pricingStore.js', { plans: () => DEFAULT_PLANS, getPlan: (id) => DEFAULT_PLANS.find((p) => p.id === id) });

const gate = require('../engine/gatePaket');
const { CATS } = require('../plugins/01-info');

(async () => {
  const bot = () => ({ id: 4, receive_limit: 0, received_count: 0 });

  // ── 1. Admin tanpa batas ────────────────────────────────────────────────────
  pemilik = { id: 1, role: 'kawula', plan: 'user', plan_expired_at: null };
  gate.segarkan(null);
  cek('admin -> kuota tanpa batas', (await gate.kuotaHabis(4, bot())) === false);
  cek('admin -> semua fitur boleh', (await gate.fiturDibolehkan(4, 'apapun', false)) === true);

  // ── 2. Paket aktif: kuota dari paket, bukan kolom beku ──────────────────────
  pemilik = { id: 3, role: 'user', plan: 'basic', plan_expired_at: besok };
  gate.segarkan(null);
  let b = bot();
  cek('basic aktif -> belum habis', (await gate.kuotaHabis(4, b)) === false);
  cek('hitungan naik di memori', b.received_count === 1, String(b.received_count));
  cek('hitungan ditulis ke DB', ditulis.some((q) => /received_count = received_count \+ 1/i.test(q)));
  cek('batas dibaca dari PAKET (10.000), bukan kolom bot (0)',
    (await gate.batasKuota(4, b)) === 10000, String(await gate.batasKuota(4, b)));

  // ── 3. Kuota habis ─────────────────────────────────────────────────────────
  b = bot();
  b.received_count = 10000;
  cek('sudah 10.000 -> habis', (await gate.kuotaHabis(4, b)) === true);
  b.received_count = 9999;
  cek('baru 9.999 -> masih boleh', (await gate.kuotaHabis(4, b)) === false);

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
  cek('paket habis -> fitur turun ke jatah user', (await gate.fiturDibolehkan(4, CATS.owner[CATS.owner.length - 1], false)) === false);
  cek('paket habis -> perintah inti TETAP boleh', (await gate.fiturDibolehkan(4, 'menu', false)) === true);

  // ── 5. Jatah fitur per paket ───────────────────────────────────────────────
  // Kategori terakhir = 'owner' (sampai 428 command, jatah Ultra cuma 400).
  // Jadi patokan "paling ujung" harus diambil dari irisan yang MEMANG dibuka,
  // bukan `owner[terakhir]` — itu di luar jatah bahkan buat Ultra.
  const irisanBasic = [...gate.jatahFitur('basic')];
  const palingUjungBasic = irisanBasic[irisanBasic.length - 1];
  const irisanUltra = [...gate.jatahFitur('ultra')];
  const palingUjungUltra = irisanUltra[irisanUltra.length - 1];
  // Perintah pertama yang di luar jatah Basic, urut KATEGORI_URUT — batasnya.
  const semuaUrut = require('../config/plan').KATEGORI_URUT.flatMap((k) => CATS[k] || []);
  const sisaBasic = [...new Set(semuaUrut)].filter((c) => !gate.jatahFitur('basic').has(c));
  const sisaUltra = Object.values(CATS).flat().filter((c) => !gate.jatahFitur('ultra').has(c));

  cek('Gratis -> cuma perintah inti (5)', gate.jatahFitur('user').size === 5, String(gate.jatahFitur('user').size));
  cek('Basic -> 100 fitur', gate.jatahFitur('basic').size === 100, String(gate.jatahFitur('basic').size));
  cek('Premium -> 250 fitur', gate.jatahFitur('premium').size === 250, String(gate.jatahFitur('premium').size));
  cek('Ultra -> 400 fitur', gate.jatahFitur('ultra').size === 400, String(gate.jatahFitur('ultra').size));
  cek('Ultra lebih luas dari Basic', gate.jatahFitur('ultra').size > gate.jatahFitur('basic').size);
  cek('Basic adalah subset Ultra', irisanBasic.every((c) => gate.jatahFitur('ultra').has(c)));
  cek('perintah tepat sesudah batas Basic DITOLAK',
    (await gate.fiturDibolehkan(4, sisaBasic[0], false)) === false, sisaBasic[0]);
  cek('Ultra dapat fitur paling ujung jatahnya', gate.jatahFitur('ultra').has(palingUjungUltra), palingUjungUltra);
  cek('Ultra belum dapat sisanya (21 command)', sisaUltra.length === 21, String(sisaUltra.length));
  cek('sisa itu kategori owner (paling akhir)', sisaUltra.every((c) => CATS.owner.includes(c)));
  cek('Trial dapat 100 fitur', gate.jatahFitur('trial').size === 100, String(gate.jatahFitur('trial').size));
  cek('paket tak dikenal -> jatah Gratis', gate.jatahFitur('entah').size === 5);
  cek('setiap paket dapat perintah inti', ['user', 'basic', 'premium', 'ultra', 'trial']
    .every((p) => ['menu', 'ping', 'limit', 'me', 'owner'].every((c) => gate.jatahFitur(p).has(c))));

  // paket aktif -> fitur sesuai paket, bukan jatah 'user'
  pemilik = { id: 3, role: 'user', plan: 'ultra', plan_expired_at: besok };
  gate.segarkan(null);
  cek('Ultra aktif -> dapat fitur paling ujung jatahnya', (await gate.fiturDibolehkan(4, palingUjungUltra, false)) === true);
  cek('Ultra aktif -> belum dapat sisa kategori owner', (await gate.fiturDibolehkan(4, sisaUltra[0], false)) === false);

  // Basic aktif -> fitur di luar jatah Basic ditolak
  pemilik = { id: 3, role: 'user', plan: 'basic', plan_expired_at: besok };
  gate.segarkan(null);
  cek('Basic aktif -> fitur rpg terakhir DITOLAK', (await gate.fiturDibolehkan(4, CATS.rpg[CATS.rpg.length - 1], false)) === false);

  // ── 6. DB error -> jangan blokir ───────────────────────────────────────────
  poolError = true;
  gate.segarkan(null);
  cek('DB error -> kuota jangan ngeblok', (await gate.kuotaHabis(4, bot())) === false);
  cek('DB error -> fitur jangan ngeblok', (await gate.fiturDibolehkan(4, sisaBasic[0], false)) === true);

  // ── 7. Pemilik bot selalu lolos ────────────────────────────────────────────
  poolError = false;
  pemilik = { id: 3, role: 'user', plan: 'user', plan_expired_at: null };
  gate.segarkan(null);
  cek('pemilik lolos walau paketnya Gratis', (await gate.fiturDibolehkan(4, sisaBasic[0], true)) === true);

  console.log(gagal ? `\n=== GAGAL: ${gagal} masalah ===` : '\n=== SEMUA CEK LULUS ===');
  process.exit(gagal ? 1 : 0);
})();
