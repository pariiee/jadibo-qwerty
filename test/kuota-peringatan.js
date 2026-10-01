'use strict';
/**
 * test/kuota-peringatan.js
 * Peringatan kuota: lubang yang ditambal di sini — begitu kuota habis, pesan
 * ditolak DIAM-DIAM dan botnya dimatikan cron. User nggak dapat kabar apa pun.
 * Yang diuji: peringatan dikirim SEKALI per ambang (bukan tiap pesan), bentuk
 * sisa kuotanya benar, dan gagal kirim TIDAK melempar.
 */
const path = require('path');

let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`✅ ${nama}`);
  else { gagal++; console.log(`❌ ${nama}${info ? ' — ' + info : ''}`); }
};

const besok = new Date(Date.now() + 86400000);
let bot = { id: 4, user_id: 3, receive_limit: 0, received_count: 0, daily_limit: 20 };
let pemilik = { id: 3, role: 'user', plan: 'basic', plan_expired_at: besok };
const kiriman = [];

function palsukan(m, e) {
  const j = require.resolve(path.join(__dirname, '..', m));
  require.cache[j] = { id: j, filename: j, loaded: true, exports: e };
}

palsukan('config/database.js', {
  pool: {
    execute: async (sql) => {
      if (/FROM bots b JOIN users u/i.test(sql)) return [[{ ...pemilik }]];
      if (/FROM bots WHERE id/i.test(sql)) return [[{ ...bot }]];
      if (/FROM users WHERE id/i.test(sql)) return [[{ ...pemilik }]];
      if (/SELECT user_id FROM bots/i.test(sql)) return [[{ user_id: bot.user_id }]];
      return [[]];
    },
  },
  incrementStat: async () => {}, decrementStat: async () => {},
});
palsukan('engine/notify.js', {
  kirimKeOwner: async (uid, teks) => { kiriman.push({ uid, teks }); return true; },
});

const { DEFAULT_PLANS } = require('../config/plan');
palsukan('config/pricingStore.js', { plans: () => DEFAULT_PLANS, getPlan: (id) => DEFAULT_PLANS.find((p) => p.id === id) });

const kuota = require('../engine/kuota');

(async () => {
  // ── sisaKuota: bentuknya benar ─────────────────────────────────────────────
  bot.received_count = 0;
  let s = await kuota.sisaKuota(4);
  cek('Basic: batas dari paket = 10.000', s.batas === 10000, String(s.batas));
  cek('sisa = batas - terpakai', s.sisa === 10000 && s.persen === 0);

  bot.received_count = 9500;
  s = await kuota.sisaKuota(4);
  cek('terpakai 9.500 -> sisa 500 (95%)', s.sisa === 500 && s.persen === 95, `${s.sisa}/${s.persen}`);

  bot.received_count = 10000;
  s = await kuota.sisaKuota(4);
  cek('terpakai = batas -> habis', s.habis === true && s.sisa === 0);

  // admin tanpa batas
  pemilik.role = 'kawula';
  s = await kuota.sisaKuota(4);
  cek('admin -> tanpaBatas', s.tanpaBatas === true && s.habis === false);
  pemilik.role = 'user';

  // paket habis -> habis
  pemilik.plan_expired_at = new Date(Date.now() - 86400000);
  s = await kuota.sisaKuota(4);
  cek('paket habis -> habis', s.habis === true && s.paketAktif === false);
  pemilik.plan_expired_at = besok;

  // ── peringatan: SEKALI per ambang ──────────────────────────────────────────
  kuota.lupakanPeringatan(null);
  kiriman.length = 0;

  bot.received_count = 100; // 1% -> belum lewat ambang mana pun
  cek('1% -> belum ada peringatan', (await kuota.peringatanKuota(4, bot)) === null);
  cek('nol pesan terkirim', kiriman.length === 0, `${kiriman.length}`);

  bot.received_count = 8000; // 80% -> ambang pertama
  cek('80% -> peringatan dikirim', (await kuota.peringatanKuota(4, bot)) === '0.8');
  cek('pesannya menyebut sisa + cara nambah', /tinggal/i.test(kiriman[0]?.teks) && /pricing/i.test(kiriman[0].teks));
  cek('ditujukan ke pemilik bot', kiriman[0]?.uid === 3);

  cek('80% dipanggil LAGI -> tidak dikirim ulang', (await kuota.peringatanKuota(4, bot)) === null);
  cek('tetap satu pesan (anti-banjir)', kiriman.length === 1, `${kiriman.length}`);

  bot.received_count = 9600; // 96% -> ambang kedua
  cek('96% -> peringatan kedua (ambang naik)', (await kuota.peringatanKuota(4, bot)) === '0.95');
  cek('dua pesan total', kiriman.length === 2, `${kiriman.length}`);

  bot.received_count = 10000; // habis
  cek('habis -> tidak dobel (ambang terakhir sudah lewat)', (await kuota.peringatanKuota(4, bot)) === null);

  // ── tanpa batas (admin) juga tidak boleh dianggap "hampir habis" ───────────
  pemilik.role = 'kawula';
  kuota.lupakanPeringatan(null);
  kiriman.length = 0;
  cek('admin -> nol peringatan', (await kuota.peringatanKuota(4, bot)) === null && kiriman.length === 0);
  pemilik.role = 'user';

  // ── gagal kirim jangan melempar ────────────────────────────────────────────
  kuota.lupakanPeringatan(null);
  bot.received_count = 9999;
  palsukan('engine/notify.js', { kirimKeOwner: async () => { throw new Error('WA mati'); } });
  let melempar = false;
  try { await kuota.peringatanKuota(4, bot); } catch { melempar = true; }
  cek('kirim gagal -> tidak melempar', melempar === false);

  console.log(gagal ? `\n=== GAGAL: ${gagal} masalah ===` : '\n=== SEMUA CEK LULUS ===');
  process.exit(gagal ? 1 : 0);
})();
