'use strict';
// Autolevelup = fitur WAJIB ON, dan daftar .on/.off harus punya dokumentasi fungsi.
//
// Yang dijaga di sini:
//  1. autolevelup nggak bisa dimatiin — walau proteksi-settings.json grup lama
//     masih nyimpen `false`, getSetting() harus balikin true.
//  2. `.on autolevelup` jawabnya "wajib", bukan "Diaktifkan" / "tidak dikenal".
//  3. Nama autolevelup nggak nyempil di daftar toggle: `.menu proteksi`, daftar
//     "Fitur tersedia", dan pesan status.
//  4. Tiap fitur yang MASIH bisa di-toggle punya `desc` — itu dokumentasi fungsi
//     yang tampil di `.on <fitur>` dan di pesan status.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const infoSrc = read('plugins/01-info.js');

const proteksi = require('../plugins/06-proteksi.js');
const getSettingProteksi = proteksi.getSetting;

// ctx palsu — cukup buat jalur .on/.off, nggak nyentuh WA.
const ctxPalsu = (command, args) => ({
  isGroup: true,
  jid: '999999999@g.us',
  sender: '628111222333@s.whatsapp.net',
  body: `.${command} ${args.join(' ')}`,
  isCmd: true,
  command,
  args,
  client: {},
  botData: { id: 1, prefix: '.' },
  pushName: 'Tester',
  msg: {},
});

(async () => {
  // ── 1. Wajib ON walau file setting nyimpen false ──────────────────────────
  assert.strictEqual(getSettingProteksi('999999999@g.us').autolevelup, true,
    'autolevelup harus tetap true walau proteksi-settings.json bilang false');

  // ── 2. .on / .off autolevelup → dikasih tau wajib ─────────────────────────
  for (const cmd of ['on', 'off']) {
    let balas = '';
    const ctx = ctxPalsu(cmd, ['autolevelup']);
    ctx.reply = async (t) => { balas = String(t); };
    await proteksi(ctx);
    assert.ok(/wajib/i.test(balas),
      `.${cmd} autolevelup harus bilang "wajib", dapet: ${balas || '(kosong)'}`);
    assert.ok(!/Diaktifkan|Dinonaktifkan/.test(balas),
      `.${cmd} autolevelup jangan ngaku bisa di-toggle: ${balas}`);
  }

  // ── 3. Nggak nyempil di daftar toggle ─────────────────────────────────────
  const daftarToggle = Object.entries(proteksi.FITUR_INFO).filter(([, i]) => i.scope !== 'wajib');
  assert.ok(!daftarToggle.some(([k]) => k === 'autolevelup'),
    'autolevelup nggak boleh ikut di daftar fitur yang bisa di-toggle');
  assert.ok(daftarToggle.length >= 15,
    `daftar toggle jangan menyusut, dapet ${daftarToggle.length}`);

  // "Fitur tersedia: ..." (pesan saat fitur nggak dikenal) juga harus bersih.
  let balasSalah = '';
  const ctxSalah = ctxPalsu('on', ['fituryangnggakada']);
  ctxSalah.reply = async (t) => { balasSalah = String(t); };
  await proteksi(ctxSalah);
  assert.ok(/Fitur tersedia/.test(balasSalah), 'fitur ngawur harus dapet daftar fitur');
  assert.ok(!/autolevelup/.test(balasSalah),
    'autolevelup nggak boleh ditawarin di daftar fitur tersedia');
  assert.ok(/document/.test(balasSalah), 'document harus tetap ada di daftar (fitur hidup)');

  // Daftar command di .menu juga harus bersih dari autolevelup.
  const barisProteksi = infoSrc.split('\n').find(l => /^\s*proteksi: \[/.test(l)) || '';
  assert.ok(barisProteksi.length > 0, 'kategori proteksi harus ada di 01-info.js');
  assert.ok(!/autolevelup/.test(barisProteksi),
    'autolevelup nggak boleh nyempil di kategori proteksi (.menu proteksi)');

  // ── 4. Dokumentasi fungsi: tiap fitur toggle punya desc, dan desc-nya tampil ─
  for (const [k, i] of daftarToggle) {
    assert.ok(typeof i.desc === 'string' && i.desc.length > 10,
      `fitur "${k}" belum punya desc — fungsi fiturnya nggak bakal kebaca user`);
  }
  assert.ok(proteksi.FITUR_INFO.document.desc.includes('dokumen'),
    'desc document harus jelas: kirim ulang dokumen sebagai file biasa');

  // Pesan status (.on tanpa argumen) nampilin emoji + nama + ✅/❌ + fungsi.
  let status = '';
  const ctxStatus = ctxPalsu('on', []);
  ctxStatus.reply = async (t) => { status = String(t); };
  await proteksi(ctxStatus);
  assert.ok(/📄 Document\s*: [✅❌] — Kirim ulang dokumen/.test(status),
    `baris status harus ada fungsi fiturnya, dapet:\n${status}`);
  assert.ok(/👋 Welcome\s*: [✅❌] — Sambutan otomatis/.test(status),
    'status welcome harus ada fungsinya juga');
  assert.ok(!/⬆️ Autolevelup\s*:/.test(status),
    'autolevelup jangan ikut jadi baris toggle di status');
  assert.ok(/Autolevelup selalu aktif/.test(status),
    'status harus nyebut autolevelup wajib ON');

  console.log('✓ autolevelup: wajib ON, nggak bisa di-off, dan tiap toggle punya dokumentasi fungsi');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
