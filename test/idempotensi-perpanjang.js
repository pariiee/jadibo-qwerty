'use strict';
/**
 * test/idempotensi-perpanjang.js — dua klik beruntun tidak boleh memotong saldo 2x.
 *
 * Skenario nyatanya: user menekan "Perpanjang" dua kali dalam 200 ms (dobel-klik,
 * atau klik pertama timeout lalu diulang). Saldo cukup untuk DUA kali, jadi tidak
 * ada penjaga "saldo kurang" yang menyelamatkan — satu-satunya yang menahan
 * adalah idempotensi.
 *
 * Diuji di level yang benar-benar memutuskan (bukan mock handler HTTP):
 *   - `perpanjang()` membaca idempotency_key klien, memvalidasi bentuknya, dan
 *     merakit `ref` yang dipakai ledger.
 *   - `perpanjangDariSaldo()` memakai ref itu apa adanya.
 *
 * Yang dikunci:
 *   1. Kunci SAMA -> ref SAMA -> yang kedua ditolak (ER_DUP_ENTRY), saldo sekali
 *   2. Kunci BEDA -> ref BEDA -> dua-duanya sah (itu memang dua pembelian)
 *   3. Tanpa kunci -> ref turunan (user, paket, milidetik)
 *   4. Kunci yang bentuknya aneh DITOLAK sebelum menyentuh DB
 *   5. `sudah_diperpanjang` dibalas 200 + ok:true (bukan error — bukan kegagalan)
 *   6. UI menonaktifkan tombol selama request + mengirim kunci per klik
 *
 * Pool ditiru: ER_DUP_ENTRY dipicu kalau `ref` sudah pernah dilihat. Jadi tes ini
 * membuktikan RANTAI PEMBENTUKAN REF-nya benar tanpa menyentuh MySQL.
 *
 * Jalankan: node test/idempotensi-perpanjang.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..');
let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`  ✓ ${nama}`);
  else { gagal++; console.error(`  ✗ ${nama}${info ? ' — ' + info : ''}`); }
};

// ── Tiruan pool: menolak `ref` yang sudah pernah dilihat ─────────────────────
//
// Tiruan ini WAJIB benar-benar membatalkan perubahan saat rollback. Versi
// pertama tes ini tidak, dan itu menyamarkan dua hal sekaligus: saldo yang
// "tidak dikembalikan" dan urutan tulis yang salah. Mock yang tidak setia pada
// kontrak DB = tes yang berbohong, ke arah mana pun.
const refTerlihat = new Set();
const catat = { ref: [], insert: 0, dipotong: 0, sentuhPaket: 0 };
let saldo = 0;
let planExpired = null;

function buatConn(point) {
  // Jejak perubahan + cadangan, supaya rollback bisa mengembalikan apa adanya.
  let jejak = [];
  return {
    async beginTransaction() { jejak = []; },
    async execute(sql, params = []) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      // `point` = tabel yang boleh gagal (simulasi error di langkah tertentu).
      if (point && s.toLowerCase().startsWith(point.tabel) && new RegExp(point.pola, 'i').test(s)) {
        throw new Error(point.pesan || 'gagal disimulasikan');
      }
      if (/^SELECT saldo FROM users/i.test(s)) return [[{ saldo }]];
      if (/^SELECT plan_expired_at FROM users/i.test(s)) return [[{ plan_expired_at: planExpired }]];
      if (/^UPDATE users SET saldo/i.test(s)) {
        jejak.push({ apa: 'saldo', lama: saldo });
        saldo = Number(params[0]);
        return [{ affectedRows: 1 }];
      }
      if (/^INSERT INTO wallet_ledger/i.test(s)) {
        const ref = params[4];
        catat.ref.push(ref);
        if (refTerlihat.has(ref)) {
          const e = new Error('Duplicate entry'); e.code = 'ER_DUP_ENTRY'; throw e;
        }
        refTerlihat.add(ref);
        jejak.push({ apa: 'ref', ref });
        catat.insert++;
        catat.dipotong += Math.abs(Number(params[2]));
        return [{ affectedRows: 1 }];
      }
      if (/^UPDATE bots SET/i.test(s)) return [{ affectedRows: 1 }];
      if (/^UPDATE users SET plan/i.test(s)) {
        jejak.push({ apa: 'expired', lama: planExpired });
        planExpired = params[1];
        catat.sentuhPaket++;
        return [{ affectedRows: 1 }];
      }
      if (/FROM bots WHERE user_id/i.test(s)) return [[]];
      return [[]];
    },
    async commit() { jejak = []; },
    async rollback() {
      // Batalkan SEMUA perubahan, dalam urutan terbalik.
      for (let i = jejak.length - 1; i >= 0; i--) {
        const j = jejak[i];
        if (j.apa === 'saldo') saldo = j.lama;
        else if (j.apa === 'expired') planExpired = j.lama;
        else if (j.apa === 'ref') { refTerlihat.delete(j.ref); catat.insert--; }
      }
      jejak = [];
    },
    release() {},
  };
}

function palsukan(modul, ekspor) {
  const j = require.resolve(path.join(R, modul));
  require.cache[j] = { id: j, filename: j, loaded: true, exports: ekspor };
}

const PAKET = [
  { id: 'user', name: 'Gratis', price: 0, days: 0, daily_limit: 10, receive_limit: 0 },
  { id: 'basic', name: 'Basic', price: 25000, days: 30, daily_limit: 30, receive_limit: 10000 },
];
let titikGagal = null;
palsukan('config/database.js', {
  pool: { execute: async () => [[]], getConnection: async () => buatConn(titikGagal), query: async () => [[]] },
  incrementStat: async () => {},
});
palsukan('config/pricingStore.js', { plans: () => PAKET, getPlan: (id) => PAKET.find((p) => p.id === id) || PAKET[0] });
palsukan('config/alpay.js', {});
palsukan('engine/gatePaket.js', { segarkan: () => {} });
palsukan('engine/kuota.js', { lupakanPeringatan: () => {}, sisaKuota: async () => 0 });
palsukan('config/engineBus.js', { start: async () => {} });
palsukan('engine/notify.js', { kirimKeOwner: async () => true });

const wallet = require('../controllers/walletController');

/** Tiruan req/res, cukup buat `perpanjang()`. */
function reqRes(body, userId = 42) {
  let status = 200; let json = null;
  return {
    req: { user: { id: userId }, body },
    res: {
      status(c) { status = c; return this; },
      json(b) { json = b; return this; },
    },
    hasil: () => ({ status, json }),
  };
}

(async () => {
  console.log('=== 1. Kunci SAMA (dua request 200 ms) -> SALDO SEKALI ===');
  saldo = 100000; // cukup untuk DUA kali (2 x 25000) — jadi "saldo kurang" TIDAK menahan
  refTerlihat.clear(); catat.ref = []; catat.insert = 0; catat.dipotong = 0;

  const kunciSama = 'a1b2c3d4-1111-2222-3333-444455556666';

  const r1 = reqRes({ plan: 'basic', idempotency_key: kunciSama });
  await wallet.perpanjang(r1.req, r1.res);
  const saldoSetelah1 = saldo;

  // 200 ms terpisah — lebih lambat dari dobel-klik, tetap harus tertahan karena
  // kuncinya sama (bukan karena waktunya berdekatan).
  await new Promise((r) => setTimeout(r, 200));

  const r2 = reqRes({ plan: 'basic', idempotency_key: kunciSama });
  await wallet.perpanjang(r2.req, r2.res);

  console.log(`   saldo: 100000 -> ${saldoSetelah1} -> ${saldo}`);
  console.log(`   respons-2: ${JSON.stringify(r2.hasil().json)} (HTTP ${r2.hasil().status})`);
  cek('permintaan-1 sukses', r1.hasil().json?.ok === true, JSON.stringify(r1.hasil().json));
  cek('saldo terpotong SEKALI (25000)', saldoSetelah1 === 75000, `jadi ${saldoSetelah1}`);
  cek('permintaan-2 TIDAK memotong lagi', saldo === 75000, `jadi ${saldo}`);
  cek('permintaan-2 dibalas 200 + ok:true (bukan error)', r2.hasil().status === 200 && r2.hasil().json?.ok === true,
    `HTTP ${r2.hasil().status} ${JSON.stringify(r2.hasil().json)}`);
  cek('permintaan-2 ditandai sudah diproses', r2.hasil().json?.sudah === true, JSON.stringify(r2.hasil().json));
  cek('cuma 1 baris ledger yang masuk', catat.insert === 1, `${catat.insert} baris`);
  cek('kedua request memakai ref yang SAMA',
    catat.ref.length === 2 && catat.ref[0] === catat.ref[1], JSON.stringify(catat.ref));

  console.log('\n=== 2. Kunci BEDA -> dua-duanya sah (memang dua pembelian) ===');
  saldo = 100000;
  refTerlihat.clear(); catat.ref = []; catat.insert = 0;

  const ra = reqRes({ plan: 'basic', idempotency_key: 'kkkkkkkk-0001-0000-0000-000000000001' });
  await wallet.perpanjang(ra.req, ra.res);
  await new Promise((r) => setTimeout(r, 200));
  const rb = reqRes({ plan: 'basic', idempotency_key: 'kkkkkkkk-0002-0000-0000-000000000002' });
  await wallet.perpanjang(rb.req, rb.res);

  console.log(`   saldo: 100000 -> ${saldo}, baris ledger: ${catat.insert}`);
  cek('dua kunci berbeda -> saldo terpotong DUA kali', saldo === 50000, `jadi ${saldo}`);
  cek('dua baris ledger', catat.insert === 2, `${catat.insert} baris`);
  cek('ref-nya berbeda', catat.ref[0] !== catat.ref[1], JSON.stringify(catat.ref));

  console.log('\n=== 3. Tanpa kunci -> ref turunan (user, paket, milidetik) ===');
  saldo = 100000;
  refTerlihat.clear(); catat.ref = []; catat.insert = 0;

  const rn = reqRes({ plan: 'basic' });
  await wallet.perpanjang(rn.req, rn.res);
  console.log(`   ref: ${catat.ref[0]}`);
  cek('ref memuat id user', /perpanjang:42:/.test(catat.ref[0] || ''), catat.ref[0]);
  cek('ref memuat id paket', /:basic:/.test(catat.ref[0] || ''), catat.ref[0]);
  cek('ref memuat angka milidetik', /:\d{13}$/.test(catat.ref[0] || ''), catat.ref[0]);

  // Dua request tanpa kunci pada milidetik yang sama (dobel-klik sungguhan):
  // dipaksa sama dengan membekukan Date.now.
  //
  // Jeda 30 detik (lapis 1) harus dimatikan lebih dulu: kalau tidak, dia yang
  // menahan request kedua — dan tesnya jadi hijau/merah karena jeda, bukan
  // karena `ref`. Yang ingin dibuktikan di sini justru penjaga `ref`-nya,
  // jadi jedanya di-akali supaya tidak berperan.
  const nowAsli = Date.now;
  wallet.mapJedaInternal().clear();
  Date.now = () => 1700000000000;
  saldo = 100000; refTerlihat.clear(); catat.ref = []; catat.insert = 0;
  const rd1 = reqRes({ plan: 'basic' });
  await wallet.perpanjang(rd1.req, rd1.res);
  const rd2 = reqRes({ plan: 'basic' });
  await wallet.perpanjang(rd2.req, rd2.res);
  Date.now = nowAsli;
  console.log(`   dobel-klik milidetik sama: saldo 100000 -> ${saldo}, baris: ${catat.insert}`);
  cek('dobel-klik di milidetik yang sama hanya terpotong SEKALI', saldo === 75000, `jadi ${saldo}`);
  cek('cuma 1 baris ledger', catat.insert === 1, `${catat.insert} baris`);

  console.log('\n=== 3b. Jeda 30 detik: dua klik beruntun TANPA kunci ===');
  // Lapis 1, dan ini yang menangkap dobel-klik NYATA: dua request berjarak 200 ms
  // dengan ref BERBEDA (karena milidetiknya beda) — penjaga `ref` tidak bisa
  // menangkap ini, jeda yang menangkap.
  wallet.mapJedaInternal().clear();
  saldo = 100000; refTerlihat.clear(); catat.ref = []; catat.insert = 0;

  const j1 = reqRes({ plan: 'basic' });           // tanpa idempotency_key
  await wallet.perpanjang(j1.req, j1.res);
  const saldoSetelahJ1 = saldo;

  await new Promise((r) => setTimeout(r, 200));   // 200 ms — milidetik BEDA

  const j2 = reqRes({ plan: 'basic' });
  await wallet.perpanjang(j2.req, j2.res);
  const hj = j2.hasil();

  console.log(`   saldo: 100000 -> ${saldoSetelahJ1} -> ${saldo}`);
  console.log(`   respons-2: HTTP ${hj.status} ${JSON.stringify(hj.json)}`);
  cek('klik-1 memotong sekali', saldoSetelahJ1 === 75000, `${saldoSetelahJ1}`);
  cek('klik-2 (200 ms, ref beda) DITOLAK oleh jeda', saldo === 75000, `jadi ${saldo}`);
  cek('klik-2 dibalas 429 + reason terlalu_cepat',
    hj.status === 429 && hj.json?.reason === 'terlalu_cepat', `HTTP ${hj.status} ${JSON.stringify(hj.json)}`);
  cek('klik-2 TIDAK meninggalkan baris ledger', catat.insert === 1, `${catat.insert} baris`);

  console.log('\n=== 3c. Dengan idempotency_key, pembelian beruntun DIIZINKAN ===');
  // User yang sengaja membeli dua kali (mis. memperpanjang 2 tahun) harus bisa —
  // kuncinya berbeda, jadi memang dua pembelian sah.
  wallet.mapJedaInternal().clear();
  saldo = 100000; refTerlihat.clear(); catat.ref = []; catat.insert = 0;
  const b1 = reqRes({ plan: 'basic', idempotency_key: 'beli2x0001-1111-2222-3333-444455556666' });
  await wallet.perpanjang(b1.req, b1.res);
  await new Promise((r) => setTimeout(r, 200));
  const b2 = reqRes({ plan: 'basic', idempotency_key: 'beli2x0002-1111-2222-3333-444455556666' });
  await wallet.perpanjang(b2.req, b2.res);
  console.log(`   saldo: 100000 -> ${saldo}, baris ledger: ${catat.insert}`);
  cek('dua kunci berbeda dalam 200 ms -> dua-duanya sah (bukan 429)', saldo === 50000, `jadi ${saldo}`);
  cek('dua baris ledger', catat.insert === 2, `${catat.insert} baris`);

  console.log('\n=== 4. Kunci yang bentuknya aneh DITOLAK sebelum menyentuh DB ===');
  for (const jelek of ['x', 'a b c', 'a'.repeat(200), 'a;DROP TABLE users', {}, ['a'], 12345]) {
    saldo = 100000; refTerlihat.clear(); catat.insert = 0;
    const rj = reqRes({ plan: 'basic', idempotency_key: jelek });
    await wallet.perpanjang(rj.req, rj.res);
    const h = rj.hasil();
    cek(`kunci ${JSON.stringify(jelek).slice(0, 24)} -> 400, nol perubahan`,
      h.status === 400 && catat.insert === 0 && saldo === 100000,
      `HTTP ${h.status}, insert ${catat.insert}, saldo ${saldo}`);
  }

  console.log('\n=== 5. Kunci sah panjang & karakternya ===');
  for (const bagus of ['a1b2c3d4-1111-2222-3333-444455556666', 'perpanjang_2026-10-14_abc', 'x'.repeat(64)]) {
    saldo = 100000; refTerlihat.clear(); catat.insert = 0;
    const rg = reqRes({ plan: 'basic', idempotency_key: bagus });
    await wallet.perpanjang(rg.req, rg.res);
    cek(`kunci sah diterima (${bagus.slice(0, 18)}…)`, catat.insert === 1 && saldo === 75000,
      `insert ${catat.insert}, saldo ${saldo}`);
  }

  console.log('\n=== 6. LEDGER DULU: percobaan duplikat tidak menambah masa aktif ===');
  // Ini bug yang ditemukan tes ini: `terapkanPaket` sempat dipanggil SEBELUM
  // baris ledger ditulis, jadi percobaan kedua (ref sama) sudah menaikkan
  // plan_expired_at +30 hari sebelum barisnya ditolak ER_DUP_ENTRY. Saldo utuh
  // (transaksi rollback), tapi paketnya bertambah gratis.
  saldo = 100000; planExpired = null; catat.sentuhPaket = 0;
  refTerlihat.clear(); catat.ref = []; catat.insert = 0;

  const kk = 'dupdupdup-1111-2222-3333-444455556666';
  const d1 = reqRes({ plan: 'basic', idempotency_key: kk });
  await wallet.perpanjang(d1.req, d1.res);
  const expiredSetelah1 = planExpired;
  const sentuhSetelah1 = catat.sentuhPaket;

  await new Promise((r) => setTimeout(r, 200));
  const d2 = reqRes({ plan: 'basic', idempotency_key: kk });
  await wallet.perpanjang(d2.req, d2.res);

  console.log(`   plan_expired_at: ${String(expiredSetelah1).slice(0, 24)} -> ${String(planExpired).slice(0, 24)}`);
  console.log(`   jumlah UPDATE users SET plan: ${sentuhSetelah1} -> ${catat.sentuhPaket}`);
  cek('percobaan-1 menambah masa aktif sekali', sentuhSetelah1 === 1, `${sentuhSetelah1}x`);
  cek('percobaan-2 TIDAK menambah masa aktif lagi', catat.sentuhPaket === 1,
    `${catat.sentuhPaket}x — paket bertambah gratis!`);
  cek('plan_expired_at tidak berubah di percobaan-2',
    String(planExpired) === String(expiredSetelah1),
    `${expiredSetelah1} -> ${planExpired}`);
  cek('saldo tetap terpotong sekali', saldo === 75000, `${saldo}`);

  console.log('\n=== 7. Kalau terapkanPaket gagal, saldo & ledger IKUT batal ===');
  saldo = 100000; planExpired = null; refTerlihat.clear(); catat.ref = []; catat.insert = 0;
  titikGagal = { tabel: 'update users set plan', pola: 'UPDATE users SET plan', pesan: 'simulasi gagal paket' };
  const g1 = reqRes({ plan: 'basic', idempotency_key: 'gagalgagal-1111-2222-3333-444455556666' });
  await wallet.perpanjang(g1.req, g1.res);
  titikGagal = null;
  const hg = g1.hasil();
  console.log(`   HTTP ${hg.status}, saldo ${saldo}, baris ledger ${catat.insert}, ref terpakai ${catat.ref.length}`);
  cek('dibalas gagal (bukan ok:true)', hg.json?.ok !== true, JSON.stringify(hg.json));
  cek('SALDO TIDAK terpotong (rollback ikut)', saldo === 100000, `${saldo}`);
  cek('baris ledger DIBATALKAN', catat.insert === 0, `${catat.insert} baris`);
  cek('ref-nya dibebaskan (bisa dicoba lagi dengan kunci sama)', !refTerlihat.has(catat.ref[0]),
    catat.ref[0]);

  console.log('\n=== 8. UI: tombol mati saat request + kunci per klik ===');
  const ui = fs.readFileSync(path.join(R, 'public/js/saldo.js'), 'utf8');
  cek('UI mengirim idempotency_key', /idempotency_key/.test(ui));
  cek('UI membuat kunci per klik (crypto.randomUUID)', /crypto\.randomUUID/.test(ui));
  cek('UI punya penjaga sedangKirim (tombol dinonaktifkan)', /sedangKirim/.test(ui));
  cek('UI menonaktifkan tombol selama request', /tombol\.disabled\s*=\s*true/.test(ui));
  cek('UI menampilkan tombol "Saldo kurang" (tidak bisa diklik)', /Saldo kurang/.test(ui) && /disabled/.test(ui));

  console.log(`\n${'─'.repeat(50)}`);
  if (gagal) { console.error(`❌ ${gagal} pemeriksaan GAGAL`); process.exit(1); }
  console.log('✅ Idempotensi perpanjang: kunci sama = sekali potong, kunci beda = dua pembelian');
})().catch((e) => { console.error('\n❌ GAGAL:', e.message, e.stack); process.exit(1); });
