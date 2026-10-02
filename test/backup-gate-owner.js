'use strict';
/**
 * test/backup-gate-owner.js
 *
 * Gerbang owner `.backup` dilindungi data SELURUH member satu bot. Dua cara
 * gate ini bisa bocor, keduanya pernah ada di kode dan keduanya tidak
 * memunculkan error apa pun:
 *
 *  1. Handler tidak diekspor dengan bentuk yang diterima loader
 *     -> command masuk, bot DIAM (dibuktikan dari log produksi: '.backup'
 *        tercatat 2 kali, tapi nol log [Backup] dan nol file dibuat).
 *  2. "Simpulkan owner dari TIDAK ADANYA balasan" (trik panggil handler
 *     05-owner dengan ctx tiruan). 05-owner membalas `return true` tanpa pesan
 *     untuk pengirim yang di-BLACKLIST -> orang yang di-ban justru LOLOS dan
 *     bisa mengunduh data member.
 *
 * Tes ini memanggil handler-nya langsung dengan ctx tiruan, jadi kedua lubang
 * itu ketahuan tanpa perlu mengirim WhatsApp sungguhan.
 */

const path = require('path');

let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`✅ ${nama}`);
  else { gagal++; console.log(`❌ ${nama}${info ? ' — ' + info : ''}`); }
};

// ─── Tiruan ctx: cukup buat semua query DB gagal TANPA melempar ───────────────
// Tujuannya menguji GERBANG, bukan pengumpulan data. Kalau gerbangnya bocor,
// `kumpulkan()` jalan dan query-nya ikut — makanya pool dibuat palsu.
const jalurDB = require.resolve(path.join(__dirname, '..', 'config', 'database.js'));
let queryDijalankan = 0;
require.cache[jalurDB] = {
  id: jalurDB, filename: jalurDB, loaded: true,
  exports: {
    pool: {
      execute: async () => { queryDijalankan++; return [[]]; },
      query:   async () => { queryDijalankan++; return [[]]; },
    },
    incrementStat: async () => {}, decrementStat: async () => {},
  },
};

const handler = require('../plugins/11-backup.js');

/** Bikin ctx tiruan. `isOwner` adalah satu-satunya sinyal izin. */
function buatCtx({ isOwner, command = 'backup' }) {
  const balasan = [];
  return {
    ctx: {
      isCmd: true, command, args: [], body: '.backup',
      isOwner,
      botData: { id: 4, bot_name: 'uji', prefix: '.', owner_number: '6287778032605' },
      jid: '6287778032605@s.whatsapp.net',
      sender: '6287778032605@s.whatsapp.net',
      isGroup: false,
      mentioned: [],
      reply: async (t) => { balasan.push(String(t)); },
      react: async () => {},
      client: { message: { send: async () => ({}) } },
    },
    balasan,
  };
}

(async () => {
  console.log('=== 1. BENTUK EKSPOR: loader harus menerima handler-nya ===');
  cek('11-backup.js diekspor sebagai function (loader: typeof mod === "function")',
    typeof handler === 'function', `typeof = ${typeof handler}`);
  cek('masih punya limitedCmds (kontrak engine/limitedCmds.js)',
    handler.limitedCmds instanceof Set);

  console.log('');
  console.log('=== 2. BUKAN owner -> DITOLAK, nol query DB ===');
  queryDijalankan = 0;
  const bukan = buatCtx({ isOwner: false });
  const hasilBukan = await handler(bukan.ctx);
  cek('handler mengembalikan true (command diakui, tidak dilempar ke handler lain)',
    hasilBukan === true, String(hasilBukan));
  cek('ada balasan penolakan',
    bukan.balasan.some((t) => /khusus owner/i.test(t)), JSON.stringify(bukan.balasan));
  cek('NOL query DB dijalankan (data tidak disentuh)',
    queryDijalankan === 0, `${queryDijalankan} query`);

  console.log('');
  console.log('=== 3. LUBANG BLACKLIST: "tidak ada balasan" BUKAN bukti owner ===');
  // Kalau gerbangnya kembali ke trik lama, ctx tiruan 05-owner untuk pengirim
  // yang di-blacklist akan membalas return true TANPA pesan -> disimpulkan
  // owner -> LOLOS. Isi `isOwner:false` harus tetap ditolak meski apa pun
  // yang dilakukan handler lain.
  queryDijalankan = 0;
  const diban = buatCtx({ isOwner: false });
  await handler(diban.ctx);
  cek('pengirim isOwner=false TIDAK memicu pengumpulan data (anti-lubang blacklist)',
    queryDijalankan === 0, `${queryDijalankan} query dijalankan = data member bisa bocor`);

  console.log('');
  console.log('=== 4. OWNER asli -> LANJUT (gerbangnya tidak terlalu ketat) ===');
  queryDijalankan = 0;
  const owner = buatCtx({ isOwner: true });
  let melempar = null;
  try { await handler(owner.ctx); } catch (e) { melempar = e.message; }
  cek('owner LOLOS gerbang (tidak diblokir)',
    !owner.balasan.some((t) => /khusus owner/i.test(t)),
    `balasan: ${JSON.stringify(owner.balasan)}`);
  cek('query DB benar-benar dijalankan untuk owner (bukti gerbang dilewati)',
    queryDijalankan > 0, `${queryDijalankan} query`);
  cek('owner tidak melempar exception', melempar === null, String(melempar));

  console.log('');
  console.log('=== 5. Command LAIN tidak ditelan ===');
  const lain = buatCtx({ isOwner: true, command: 'menu' });
  const hasilLain = await handler(lain.ctx);
  cek('command bukan .backup -> return false (dilempar ke plugin lain)',
    hasilLain === false, String(hasilLain));

  console.log('');
  console.log(gagal ? `=== GAGAL: ${gagal} masalah ===` : '=== SEMUA CEK LULUS ===');
  process.exit(gagal ? 1 : 0);
})();
