'use strict';
/**
 * test/watchdog-bot-mati.js
 * Bot reconnect TIAP 5 DETIK. Kalau handler `close` langsung kirim WA, nomor
 * owner kebanjiran puluhan pesan "bot mati" dalam semenit tiap WhatsApp
 * bermasalah. Yang diuji:
 *
 *   1. jadwalkan -> TIDAK langsung kirim
 *   2. bot sembuh sebelum tenggang -> nol pesan
 *   3. tetap mati sampai tenggang -> kirim TEPAT satu
 *   4. dijadwalkan dua kali -> tetap satu timer
 *   5. status di DB 'connected' -> nggak dikirimi (penjagaan kedua)
 */
const path = require('path');

let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`✅ ${nama}`);
  else { gagal++; console.log(`❌ ${nama}${info ? ' — ' + info : ''}`); }
};

const kiriman = [];
let statusDb = 'disconnected';

function palsukan(modul, ekspor) {
  const j = require.resolve(path.join(__dirname, '..', modul));
  require.cache[j] = { id: j, filename: j, loaded: true, exports: ekspor };
}

palsukan('config/database.js', {
  pool: {
    execute: async (sql) => {
      if (/SELECT status FROM bots/i.test(sql)) return [[{ status: statusDb }]];
      if (/SELECT id, user_id, owner_number FROM bots/i.test(sql))
        return [[{ id: 8, user_id: 1, owner_number: '6287778032605' }]];
      return [[]];
    },
  },
  incrementStat: async () => {}, decrementStat: async () => {},
});
palsukan('engine/notify.js', {
  kirimKeOwner: async (userId, teks) => { kiriman.push({ userId, teks }); return true; },
});

const wd = require('../engine/watchdog');

(async () => {
  // 1 + 3. tetap mati sampai tenggang -> kirim tepat satu
  statusDb = 'disconnected';
  kiriman.length = 0;
  await wd.jadwalkanNotifMati(8, { tenggang: 120 });
  cek('belum langsung kirim', kiriman.length === 0, `${kiriman.length}x`);
  await new Promise((r) => setTimeout(r, 400));
  cek('tetap mati -> kirim TEPAT satu', kiriman.length === 1, `${kiriman.length}x`);
  cek('isinya kasih tahu cara perbaiki', /dashboard/i.test(kiriman[0]?.teks || ''));
  cek('ditujukan ke pemilik bot', kiriman[0]?.userId === 1);

  // 2. sembuh sebelum tenggang -> nol pesan
  kiriman.length = 0;
  await wd.jadwalkanNotifMati(8, { tenggang: 200 });
  cek('timer dibatalkan', wd.batalkanNotifMati(8) === true);
  await new Promise((r) => setTimeout(r, 400));
  cek('sembuh cepat -> NOL pesan (anti-banjir)', kiriman.length === 0, `${kiriman.length}x`);

  // 4. dijadwalkan dua kali -> satu timer
  kiriman.length = 0;
  await wd.jadwalkanNotifMati(8, { tenggang: 100 });
  const dobel = await wd.jadwalkanNotifMati(8, { tenggang: 100 });
  cek('jadwal dobel ditolak', dobel === false);
  await new Promise((r) => setTimeout(r, 350));
  cek('tetap cuma satu pesan', kiriman.length === 1, `${kiriman.length}x`);

  // 5. penjagaan kedua: status di DB ternyata sudah connected
  statusDb = 'connected';
  kiriman.length = 0;
  await wd.jadwalkanNotifMati(8, { tenggang: 100 });
  await new Promise((r) => setTimeout(r, 350));
  cek("status DB 'connected' -> nggak dikirimi", kiriman.length === 0, `${kiriman.length}x`);

  // 6. batalkan yang nggak ada -> false, nggak melempar
  cek('batalkan yang nggak ada -> false', wd.batalkanNotifMati(999) === false);

  console.log(gagal ? `\n=== GAGAL: ${gagal} masalah ===` : '\n=== SEMUA CEK LULUS ===');
  process.exit(gagal ? 1 : 0);
})();
