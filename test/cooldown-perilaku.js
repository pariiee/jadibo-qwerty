'use strict';
/**
 * test/cooldown-perilaku.js — tes PERILAKU cooldownGuard (bukan kontrak statis).
 *
 * Kenapa perlu: test/cooldown-tersentral.js hanya mengunci "kodenya ada".
 * Yang harus dibuktikan sebenarnya adalah PERILAKU:
 *   a. Pesan non-command (tanpa prefix) TIDAK diblokir — listener seperti
 *      antilink/afk/jawaban game harus tetap sampai ke plugin.
 *   b. Command kedua di dalam jendela cooldown DIBLOKIR.
 *   c. Owner & developer LOLOS dari kelompok 'umum'.
 *   d. Balasan "⏳ Tunggu" hanya SEKALI per jendela.
 *
 * Tes ini memanggil cooldownGuard() sungguhan dengan ctx tiruan. Tidak butuh
 * DB, tidak butuh bot online — modul cooldown murni in-memory.
 *
 * Jalankan: node test/cooldown-perilaku.js
 */
const assert = require('assert');

const { cooldownGuard, lastHit, lastBalas } = require('../engine/cooldown');
const { TABEL } = require('../config/cooldown');

// Bersihkan state supaya tes deterministik (modul ini singleton per proses).
function reset() { lastHit.clear(); lastBalas.clear(); }

/** ctx tiruan. balasan direkam ke array. */
function ctx({ isCmd = true, command = 'menu', sender = '628111@s.whatsapp.net',
              isOwner = false, isDev = false, balasan = [] } = {}) {
  return {
    isCmd, command, sender, isOwner, isDev,
    reply: async (teks) => { balasan.push(teks); },
  };
}

const tunggu = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ── a. Pesan non-command tidak diblokir ────────────────────────────────────
  console.log('=== a. Non-command TIDAK diblokir ===');
  reset();
  for (let i = 0; i < 5; i++) {
    const c = ctx({ isCmd: false, command: '' });
    const r = await cooldownGuard(c);
    assert.strictEqual(r.ok, true, `non-command ke-${i + 1} diblokir — listener akan mati`);
  }
  // 5 pemanggilan tanpa jeda, semuanya harus lolos.
  console.log('✅ 5 pesan non-command berturut-turut: semua lolos');

  // ── b. Command kedua di jendela cooldown diblokir ──────────────────────────
  console.log('\n=== b. Command kedua dalam jendela diblokir ===');
  reset();
  // 'menu' masuk kelompok 'umum' (500ms, diam).
  const c1 = ctx({ command: 'menu' });
  const r1 = await cooldownGuard(c1);
  assert.strictEqual(r1.ok, true, 'command pertama harus lolos');

  const c2 = ctx({ command: 'menu' });
  const r2 = await cooldownGuard(c2);
  assert.strictEqual(r2.ok, false, 'command kedua dalam 500ms harus diblokir');
  assert.strictEqual(r2.dilanggar, 'umum', `kelompok salah: ${r2.dilanggar}`);
  assert.strictEqual(r2.diam, true, 'kelompok umum harus diam (tidak balas)');
  console.log('✅ command ke-2 diblokir, kelompok "umum", diam');

  // Setelah jendela lewat → lolos lagi.
  await tunggu(TABEL.umum.ms + 120);
  const c3 = ctx({ command: 'menu' });
  const r3 = await cooldownGuard(c3);
  assert.strictEqual(r3.ok, true, 'setelah jendela lewat harus lolos lagi');
  console.log(`✅ setelah ${TABEL.umum.ms}ms lewat: lolos lagi`);

  // ── c. Owner & developer lolos dari 'umum' ─────────────────────────────────
  console.log('\n=== c. Owner & developer lolos dari "umum" ===');
  reset();
  const co = ctx({ command: 'menu', isOwner: true });
  assert.strictEqual((await cooldownGuard(co)).ok, true, 'owner harus lolos');
  assert.strictEqual((await cooldownGuard(ctx({ command: 'menu', isOwner: true }))).ok, true,
    'owner spam kedua juga lolos');
  console.log('✅ owner: 2 command berturut-turut lolos');

  reset();
  assert.strictEqual((await cooldownGuard(ctx({ command: 'menu', isDev: true }))).ok, true,
    'dev harus lolos di "umum"');
  assert.strictEqual((await cooldownGuard(ctx({ command: 'menu', isDev: true }))).ok, true,
    'dev spam kedua lolos di "umum"');
  console.log('✅ dev: 2 command berturut-turut lolos di "umum"');

  // KEPUTUSAN: pengecualian owner/dev hanya berlaku untuk kelompok yang
  // MENDEFINISIKAN `pengecualian` — saat ini HANYA 'umum'. Kelompok 'berat'
  // dkk SENGAJA tidak mengecualikan siapa pun. Kalau nanti owner/dev mau
  // dibebaskan dari 'berat' juga, tambahkan `pengecualian` di config/cooldown.js
  // DAN ubah assert di bawah ini.
  console.log('\n=== c2. Owner/dev TETAP kena kelompok "berat" (sesuai config) ===');
  reset();
  await cooldownGuard(ctx({ command: 'play', isDev: true }));
  assert.strictEqual((await cooldownGuard(ctx({ command: 'play', isDev: true }))).ok, false,
    'dev kedua di "berat" harus DIBLOKIR — kelompok berat tidak mengecualikan siapa pun');
  console.log('✅ dev kena cooldown "berat" (perilaku yang dikonfigurasi)');

  // ── d. Balasan "⏳ Tunggu" sekali per jendela ───────────────────────────────
  console.log('\n=== d. Balasan sekali per jendela ===');
  reset();
  // 'play' ada di kelompok 'berat' (3s, balasan:true).
  const balasan = [];
  const p1 = ctx({ command: 'play', balasan });
  assert.strictEqual((await cooldownGuard(p1)).ok, true, 'play pertama lolos');

  // Spam 5x dalam jendela — hanya 1 balasan.
  for (let i = 0; i < 5; i++) {
    await cooldownGuard(ctx({ command: 'play', balasan }));
  }
  assert.strictEqual(balasan.length, 1,
    `balasan harus 1, dapat ${balasan.length} — user spam dibanjiri pesan`);
  assert.match(balasan[0], /Tunggu/ && /detik/, `isi balasan aneh: ${balasan[0]}`);
  console.log(`✅ 5 pelanggaran → ${balasan.length} balasan ("${balasan[0].slice(0, 30)}...")`);

  // ── e. Bot berbeda tidak saling mengganggu (key termasuk sender) ───────────
  console.log('\n=== e. Sender berbeda tidak saling blokir ===');
  reset();
  const A = ctx({ command: 'play', sender: '628111@s.whatsapp.net' });
  const B = ctx({ command: 'play', sender: '628222@s.whatsapp.net' });
  assert.strictEqual((await cooldownGuard(A)).ok, true, 'A lolos');
  assert.strictEqual((await cooldownGuard(B)).ok, true, 'B harus lolos (sender beda)');
  assert.strictEqual((await cooldownGuard(ctx({ command: 'play', sender: '628111@s.whatsapp.net' }))).ok,
    false, 'A kedua harus diblokir');
  console.log('✅ sender A diblokir, sender B tidak terpengaruh');

  // ── f. Command berbeda = jendela berbeda ───────────────────────────────────
  console.log('\n=== f. Command berbeda, jendela terpisah ===');
  reset();
  assert.strictEqual((await cooldownGuard(ctx({ command: 'play' }))).ok, true, 'play lolos');
  // 'tiktok' juga di 'berat' → kena kelompok sama, jadi DIBLOKIR.
  // Ini memang perilaku yang diinginkan: 'berat' = satu ember per user.
  const rTt = await cooldownGuard(ctx({ command: 'tiktok' }));
  assert.strictEqual(rTt.ok, false, 'tiktok harus kena cooldown "berat" yang sama');
  assert.strictEqual(rTt.dilanggar, 'berat', `kelompok salah: ${rTt.dilanggar}`);
  console.log('✅ satu ember per kelompok ("berat"): play lalu tiktok tetap diblokir');

  // Tapi 'menu' (kelompok umum) tidak terpengaruh cooldown 'berat'.
  reset();
  await cooldownGuard(ctx({ command: 'play' }));
  assert.strictEqual((await cooldownGuard(ctx({ command: 'menu' }))).ok, true,
    'menu harus lolos walau baru main play — kelompok beda');
  console.log('✅ kelompok beda tidak saling blokir (play lalu menu lolos)');

  console.log('\nsemua ok — perilaku cooldownGuard benar');
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
