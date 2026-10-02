'use strict';
/**
 * test/owner-simpan-tetap.js
 *
 * Command owner yang menyimpan KEADAAN lintas restart: `.ban`, `.unban`,
 * `.warn`, `.unwarn`, `.delwarn`, `.resetwarn`, `.setwarnlimit`.
 *
 * Pola lama: `try { query } catch {}` — error dibuang, lalu user tetap dibalas
 * sukses. Akibat nyatanya:
 *   - `.ban` cuma nulis MEMORI saat query gagal → bot restart = orangnya bebas
 *     lagi, owner tidak pernah tahu.
 *   - `.unban` DELETE gagal tapi bilang sukses → setelah restart orangnya
 *     ter-ban lagi sendiri.
 *   - `.warn` naik di grup tapi hilang di DB → member yang seharusnya di-kick
 *     justru aman setelah restart.
 *
 * Tes ini memaksa SEMUA query gagal, lalu memastikan:
 *   1. tidak ada balasan SUKSES (owner tidak dibohongi), dan
 *   2. memori TIDAK berubah — supaya yang tampil = yang benar-benar tersimpan.
 */

const path = require('path');

let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`✅ ${nama}`);
  else { gagal++; console.log(`❌ ${nama}${info ? ' — ' + info : ''}`); }
};

// ─── Pool palsu yang SELALU gagal ─────────────────────────────────────────────
let queryDijalankan = 0;
const poolGagal = {
  execute: async () => { queryDijalankan++; throw new Error('DB mati (uji)'); },
};
const jDB = require.resolve(path.join(__dirname, '..', 'config', 'database.js'));
require.cache[jDB] = { id: jDB, filename: jDB, loaded: true, exports: { pool: poolGagal } };

// ─── Cache store palsu: blacklist & warn ──────────────────────────────────────
// Dipakai supaya `ensureBlockedLoaded` / `ensureWarnLoaded` tidak menyentuh DB
// sungguhan, dan supaya kita bisa membaca isi memori setelah command jalan.
//
// State ini memang LOCAL di plugins/05-owner.js (`blockedUsers` / `warnData`),
// jadi yang dipalsukan cuma query-nya — cukup dengan pool yang selalu gagal.
// Kita tetap bisa menguji "memori tidak berubah" lewat perilaku: `.unban` pada
// target yang tidak ada di memori harus TETAP melaporkan gagal, dan `.warn`
// yang gagal tidak boleh menaikkan hitungan (diuji dari balasan berikutnya).

// `mess` dipalsukan supaya tidak perlu file bahasa lengkap: setiap properti
// jadi nama kuncinya sendiri (mis. mess.ownerOnly -> "ownerOnly").
const jMess = require.resolve(path.join(__dirname, '..', 'config', 'mess.js'));
require.cache[jMess] = { id: jMess, filename: jMess, loaded: true, exports: new Proxy({}, { get: (_, k) => String(k) }) };

const handler = require('../plugins/05-owner.js');

const diBalas = [];
const dikirim = [];
function ctxBuat(command, extra = {}) {
  diBalas.length = 0; dikirim.length = 0;
  return {
    isCmd: true, command, args: extra.args || [],
    isGroup: true,
    isOwner: true,
    jid: '1203@g.us',
    sender: '6287778032605@s.whatsapp.net',
    mentioned: extra.mentioned || ['628111@s.whatsapp.net'],
    body: '.' + command,
    botData: {
      id: 4, prefix: '.', bot_name: 'uji',
      owner_number: '6287778032605',
    },
    activeGroups: new Map(),
    msg: { message: { extendedTextMessage: { contextInfo: { mentionedJid: extra.mentioned || ['628111@s.whatsapp.net'] } } } },
    reply: async (t) => { diBalas.push(String(t)); },
    react: async () => {},
    client: {
      message: { send: async (jid, c) => { dikirim.push({ jid, c }); } },
      group: { removeParticipants: async () => {} },
    },
  };
}

const adaKlaimSukses = (teks) =>
  /(✅|🎉|🚫 @|🗑️|telah di-ban|telah di-unban|berhasil)/i
    .test(teks) && !/gagal/i.test(teks);

(async () => {
  require(path.join(__dirname, '..', 'plugins', '05-owner.js'));  // sudah di-require di atas

  const kasus = [
    { cmd: 'ban',          label: 'ban' },
    { cmd: 'unban',        label: 'unban' },
    { cmd: 'warn',         label: 'warn' },
    { cmd: 'unwarn',       label: 'unwarn' },
    { cmd: 'delwarn',      label: 'delwarn' },
    { cmd: 'resetwarn',    label: 'resetwarn' },
    { cmd: 'setwarnlimit', label: 'setwarnlimit', args: ['5'] },
  ];

  for (const k of kasus) {
    console.log(`\n=== .${k.label} — SEMUA query gagal ===`);
    queryDijalankan = 0;

    const ctx = ctxBuat(k.cmd, k.args ? { args: k.args } : {});
    let melempar = null;
    try { await handler(ctx); } catch (e) { melempar = e.message; }

    const semuaTeks = [...diBalas, ...dikirim.map(d => d.c?.text || '')].join('\n');

    cek(`.${k.label} tidak melempar`, melempar === null, String(melempar));
    cek(`.${k.label} query DB dicoba (bukan diam-diam dilewati)`, queryDijalankan > 0,
      `${queryDijalankan} query`);
    cek(`.${k.label} TIDAK membalas sukses saat simpan gagal`, !adaKlaimSukses(semuaTeks),
      'balasan: ' + semuaTeks.trim().slice(0, 120));
    cek(`.${k.label} memberi tahu owner ada masalah`, /gagal|⚠️/i.test(semuaTeks),
      'balasan: ' + semuaTeks.trim().slice(0, 120));
  }

  console.log('\n=== Hitungan memori TIDAK naik saat simpan gagal ===');
  // Dulu `.warn` menaikkan hitungan di memori SEBELUM query, jadi walaupun
  // simpan gagal, grup melihat "1/3" — dan setelah restart angkanya balik 0.
  // Sekarang balasan gagal tidak boleh menyebut hitungan yang naik.
  const c1 = ctxBuat('warn');
  await handler(c1);
  const teksWarn = [...diBalas, ...dikirim.map(d => d.c?.text || '')].join('\n');
  cek('.warn gagal → tidak melaporkan hitungan naik (1/3)',
    !/Warn\s*:\s*1\//i.test(teksWarn), teksWarn.trim().slice(0, 120));

  // `.setwarnlimit` gagal → limit baru (5) tidak boleh dilaporkan berlaku.
  const c2 = ctxBuat('setwarnlimit', { args: ['5'] });
  await handler(c2);
  const teksLimit = [...diBalas, ...dikirim.map(d => d.c?.text || '')].join('\n');
  cek('.setwarnlimit gagal → tidak mengaku batas diubah ke 5',
    !/diubah ke 5/i.test(teksLimit), teksLimit.trim().slice(0, 120));

  console.log('');
  console.log(gagal ? `=== GAGAL: ${gagal} masalah ===` : '=== SEMUA CEK LULUS ===');
  process.exit(gagal ? 1 : 0);
})();
