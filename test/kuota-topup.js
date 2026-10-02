'use strict';
/**
 * test/kuota-topup.js
 *
 * Jalur uang: admin menambah kuota pesan manual (top-up) dan melepas pemakaian
 * (reset). Dua jebakan yang pernah hampir masuk ke kode, keduanya SENYAP:
 *
 *  1. Top-up ditulis ke `bots.receive_limit`. Kolom itu sengaja cuma boleh
 *     MENURUNKAN jatah paket (lihat `batasKuota()`), jadi menaikkannya tidak
 *     berpengaruh — dan menulis 0 di situ artinya TANPA BATAS, bukan habis.
 *     Akibatnya admin "menghabiskan kuota" user justru membuka kuota tak terbatas.
 *  2. Hitungan bonus dua kali: `batasKuota()` sudah menambahkan bonus, lalu
 *     `kuotaHabis()` menghabiskan bonus lagi lewat pencatat terpisah.
 *
 * Tes ini memanggil `batasKuota()` langsung dengan pool palsu, jadi ketahuan
 * tanpa DB.
 */

const path = require('path');

let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`✅ ${nama}`);
  else { gagal++; console.log(`❌ ${nama}${info ? ' — ' + info : ''}`); }
};

// ─── Data palsu yang bisa diubah tiap skenario ────────────────────────────────
const DB = {
  bonus: null,          // isi tabel kuota_tambahan: { jumlah }
  role: 'user',
  plan: 'basic',        // receive_limit 25000 (lihat DEFAULT_PLANS)
  planExpired: '2099-01-01 00:00:00',
  botReceiveLimit: 0,
  receivedCount: 0,
  tabelAda: true,
};

const poolPalsu = {
  execute: async (sql) => {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (/FROM kuota_tambahan/i.test(q)) {
      if (!DB.tabelAda) throw new Error('ER_NO_SUCH_TABLE');
      return [[DB.bonus].filter(Boolean)];
    }
    // JOIN bots+users (pemilikBot) — dicek SEBELUM pola users, karena query ini
    // juga mengandung `FROM bots b JOIN users u`. Urutan pola menentukan.
    if (/JOIN users/i.test(q)) {
      return [[{
        id: 1, role: DB.role, plan: DB.plan,
        plan_expired_at: DB.planExpired,   // string 'YYYY-MM-DD HH:MM:SS' — `aktif()` pakai new Date()
      }]];
    }
    if (/FROM bots/i.test(q)) {
      return [[{ id: 4, receive_limit: DB.botReceiveLimit, received_count: DB.receivedCount }]];
    }
    return [[]];
  },
};
const j = require.resolve(path.join(__dirname, '..', 'config', 'database.js'));
require.cache[j] = { id: j, filename: j, loaded: true, exports: { pool: poolPalsu } };

const { batasKuota, jatahTambahan, segarkan } = require('../engine/gatePaket');

// WAJIB dibersihkan tiap skenario: `pemilikBot()` menyimpan hasilnya selama 60
// detik, jadi tanpa ini skenario kedua membaca data skenario pertama dan
// tesnya lulus/merah karena urutan, bukan karena kode.
const segarkanSemua = () => segarkan(null);

const BOT = { receive_limit: 0 };

(async () => {
  const PAKET_BASIC = 10000;   // DEFAULT_PLANS.basic.receive_limit

  console.log('=== 1. Tanpa top-up: batas = jatah paket (tidak berubah) ===');
  segarkanSemua();
  DB.bonus = null;
  cek('batasKuota = jatah paket', (await batasKuota(4, BOT)) === PAKET_BASIC,
    String(await batasKuota(4, BOT)));
  cek('jatahTambahan = 0', (await jatahTambahan(4)) === 0);

  console.log('');
  console.log('=== 2. Top-up MENAMBAH, bukan menggantikan ===');
  segarkanSemua();
  DB.bonus = { jumlah: 5000 };
  const b = await batasKuota(4, BOT);
  cek('batas = paket + bonus', b === PAKET_BASIC + 5000, String(b));
  cek('batas > jatah paket (top-up benar-benar berpengaruh)', b > PAKET_BASIC);

  console.log('');
  console.log('=== 3. JEBAKAN: bonus 0 tidak boleh jadi "tanpa batas" ===');
  // `0` di `bots.receive_limit` artinya TANPA BATAS. Kalau top-up ditulis ke
  // sana, "menghabiskan kuota" justru membukanya. Di tabel tambahan, 0 = nol.
  segarkanSemua();
  DB.bonus = { jumlah: 0 };
  const nol = await batasKuota(4, BOT);
  cek('bonus 0 → batas tetap jatah paket (bukan 0/tanpa batas)',
    nol === PAKET_BASIC, String(nol));
  cek('bonus 0 → jatahTambahan 0', (await jatahTambahan(4)) === 0);

  console.log('');
  console.log('=== 4. Bonus tidak boleh mengecilkan kuota yang sudah dibayar ===');
  segarkanSemua();
  DB.bonus = { jumlah: -9999 };   // salah input / data rusak
  const negatif = await batasKuota(4, BOT);
  cek('bonus negatif → tidak mengurangi jatah paket', negatif >= PAKET_BASIC, String(negatif));

  console.log('');
  console.log('=== 5. Tabel belum ada (DB lama) → tetap jalan seperti sebelumnya ===');
  segarkanSemua();
  DB.bonus = { jumlah: 5000 };
  DB.tabelAda = false;
  cek('tabel hilang → jatahTambahan 0', (await jatahTambahan(4)) === 0);
  cek('tabel hilang → batas = jatah paket (tidak melempar)',
    (await batasKuota(4, BOT)) === PAKET_BASIC);
  DB.tabelAda = true;

  console.log('');
  console.log('=== 6. Kolom bot cuma boleh MENURUNKAN, bonus tetap ditambahkan ===');
  segarkanSemua();
  DB.bonus = { jumlah: 1000 };
  DB.botReceiveLimit = 100;
  const turun = await batasKuota(4, { receive_limit: 100 });
  cek('kolom bot 100 < paket → dasar 100, bonus ditambahkan', turun === 100 + 1000, String(turun));
  segarkanSemua();
  cek('kolom bot tidak bisa MENAIKKAN di atas paket',
    (await batasKuota(4, { receive_limit: 999999 })) === PAKET_BASIC + 1000);

  console.log('');
  console.log('=== 7. Admin & paket habis tidak tersentuh bonus ===');
  DB.botReceiveLimit = 0;
  segarkanSemua();
  DB.role = 'kawula';   // ADMIN_ROLE
  cek('admin → 0 (tanpa batas), bonus diabaikan', (await batasKuota(4, BOT)) === 0);
  DB.role = 'user';
  segarkanSemua();
  DB.planExpired = '2000-01-01 00:00:00';
  cek('paket habis → -1 (berhenti melayani)', (await batasKuota(4, BOT)) === -1);

  console.log('');
  console.log(gagal ? `=== GAGAL: ${gagal} masalah ===` : '=== SEMUA CEK LULUS ===');
  process.exit(gagal ? 1 : 0);
})();
