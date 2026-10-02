'use strict';
/**
 * test/health-alarm.js
 *
 * Alarm kesehatan: satu-satunya cara pemilik tahu ada yang rusak tanpa membuka
 * HP-nya sendiri. Yang diuji di sini bukan "apakah fungsinya jalan", tapi dua
 * hal yang bikin alarm berguna atau justru diabaikan:
 *
 *   1. TOLERANSI — bot butuh ~14 detik connect tiap restart, dan prosesnya
 *      restart tiap deploy. Tanpa toleransi, tiap deploy mengirim alarm palsu.
 *   2. ANTI-SPAM — sekali rusak lalu dibiarkan, alarm tidak boleh dikirim tiap
 *      menit; nomor tujuan akan diblokir dan alarmnya jadi tidak berguna.
 *
 * Plus: pulih = penghitung direset, dan nomor kosong tidak boleh meledak.
 */
const path = require('path');

let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`✅ ${nama}`);
  else { gagal++; console.log(`❌ ${nama}${info ? ' — ' + info : ''}`); }
};

// ── Keadaan palsu ────────────────────────────────────────────────────────────
let dbHidup = true;
let harusJalan = 1;
let online = 1;

function palsukan(modul, ekspor) {
  const j = require.resolve(path.join(__dirname, '..', modul));
  require.cache[j] = { id: j, filename: j, loaded: true, exports: ekspor };
}

palsukan('config/database.js', {
  pool: {
    execute: async (sql) => {
      if (/SELECT 1/i.test(sql)) {
        if (!dbHidup) throw new Error('ECONNREFUSED');
        return [[{ '1': 1 }]];
      }
      if (/FROM bots/i.test(sql)) return [[{ harus: harusJalan, online }]];
      return [[]];
    },
  },
  incrementStat: async () => {}, decrementStat: async () => {},
});

const health = require('../engine/health');

const terkirim = [];
const kirim = async (nomor, teks) => { terkirim.push({ nomor, teks }); return true; };

(async () => {
  // Nomor alarm: di produksi datang dari `.env` (DEVELOPER_NUMBER). Diset di
  // sini supaya tes menguji JALUR ALARM, bukan guard "nomor kosong" — guard itu
  // diuji terpisah di bagian 8.
  process.env.DEVELOPER_NUMBER = '628111222333';

  // ── 1. Semua sehat -> ok, tanpa alarm ──────────────────────────────────────
  health.reset(); terkirim.length = 0;
  let h = await health.cek();
  cek('DB hidup + bot online -> ok', h.ok === true && h.db === true, JSON.stringify(h.alasan));
  let r = await health.periksaDanAlarm(kirim);
  cek('sehat -> tidak ada alarm', terkirim.length === 0 && r.aksi === 'diam', r.aksi);

  // ── 2. TOLERANSI: 1-2 kali gagal belum alarm ───────────────────────────────
  health.reset(); terkirim.length = 0;
  harusJalan = 2; online = 1;          // satu bot belum connect
  await health.periksaDanAlarm(kirim);
  cek('gagal ke-1 -> diam (toleransi)', terkirim.length === 0, `${terkirim.length}`);
  await health.periksaDanAlarm(kirim);
  cek('gagal ke-2 -> diam (toleransi)', terkirim.length === 0, `${terkirim.length}`);

  // ── 3. gagal ke-3 -> BARU alarm ───────────────────────────────────────────
  r = await health.periksaDanAlarm(kirim);
  cek('gagal ke-3 -> alarm dikirim', r.aksi === 'alarm' && terkirim.length === 1, `${r.aksi}/${terkirim.length}`);
  cek('isinya menyebut jumlah bot', /1 dari 2/.test(terkirim[0]?.teks || ''), terkirim[0]?.teks?.slice(0, 80));
  cek('isinya menyebut /kountole', /\/kountole/.test(terkirim[0]?.teks || ''));

  // ── 4. ANTI-SPAM: masih rusak, tidak diulang tiap menit ───────────────────
  await health.periksaDanAlarm(kirim);
  await health.periksaDanAlarm(kirim);
  await health.periksaDanAlarm(kirim);
  cek('masih rusak -> alarm TIDAK diulang (anti-spam)', terkirim.length === 1, `${terkirim.length} kali`);

  // ── 5. pulih -> penghitung reset ──────────────────────────────────────────
  online = 2;
  r = await health.periksaDanAlarm(kirim);
  cek('pulih -> aksi "pulih"', r.aksi === 'pulih', r.aksi);
  cek('pulih -> tidak ada alarm baru', terkirim.length === 1, `${terkirim.length}`);

  // ── 6. rusak LAGI setelah pulih -> alarm baru (bukan tertahan) ────────────
  online = 1;
  await health.periksaDanAlarm(kirim);
  await health.periksaDanAlarm(kirim);
  await health.periksaDanAlarm(kirim);
  cek('rusak lagi setelah pulih -> alarm baru dikirim', terkirim.length === 2, `${terkirim.length}`);

  // ── 7. DB mati -> dilaporkan, bukan melempar ──────────────────────────────
  health.reset(); terkirim.length = 0;
  dbHidup = false;
  h = await health.cek();
  cek('DB mati -> ok false, db false', h.ok === false && h.db === false, JSON.stringify(h));
  cek('DB mati -> alasannya jelas', /database/i.test(h.alasan.join(' ')), h.alasan.join(' '));
  for (let i = 0; i < 3; i++) await health.periksaDanAlarm(kirim);
  cek('DB mati -> alarm tetap bisa dikirim (tanpa DB)', terkirim.length === 1, `${terkirim.length}`);
  dbHidup = true;

  // ── 8. nomor alarm kosong -> tidak melempar ───────────────────────────────
  health.reset(); terkirim.length = 0;
  const nomorAsli = process.env.DEVELOPER_NUMBER;
  delete process.env.DEVELOPER_NUMBER;
  online = 1; harusJalan = 2;
  let melempar = false;
  try { for (let i = 0; i < 3; i++) await health.periksaDanAlarm(kirim); } catch { melempar = true; }
  cek('DEVELOPER_NUMBER kosong -> tidak melempar', melempar === false);
  cek('DEVELOPER_NUMBER kosong -> tidak ada yang dikirim', terkirim.length === 0);
  if (nomorAsli !== undefined) process.env.DEVELOPER_NUMBER = nomorAsli;

  console.log(gagal ? `\n=== GAGAL: ${gagal} masalah ===` : '\n=== SEMUA CEK LULUS ===');
  process.exit(gagal ? 1 : 0);
})();
