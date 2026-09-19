'use strict';

/**
 * test/tebak-gambar-game.js
 * `.tebakgambar` (command bot) — 1 grup 1 soal, gambar dari endpoint
 * /api/game/tebak-gambar, jawaban dicek fuzzy.
 *
 * Yang dijaga tes ini:
 *  - caption TIDAK boleh membocorkan jawaban (game jadi nggak ada artinya);
 *  - cuma 1 bubble gambar (mimetype jpeg) per soal;
 *  - `.clue` nyensor, bukan nge-reveal;
 *  - jawaban benar/hampir/salah beda perlakuan, dan store-nya bersih setelah benar.
 */

const assert = require('assert');
const path   = require('path');
const sharp  = require('sharp');

process.env.BASE_API = 'https://yapari.web.id/';
process.env.KEY_API  = 'kunci-tes';

const axios   = require('axios');
const handler = require(path.resolve(__dirname, '..', 'plugins/00-game.js'));
const store   = require(path.resolve(__dirname, '..', 'engine/gameStore.js'));
const { limitedCmds } = handler;

const JID     = '120363418054099388@g.us';
const SOAL    = 20;
const JAWABAN = 'nasib buruk';
const GAMBAR  = 'https://raw.githubusercontent.com/ghifari909/random-jir/main/image-tebak-gambar/soal_0020_nasib%20buruk.png';

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

// ── Stub jaringan: endpoint soal + unduhan gambar (nggak nunggu internet) ─────
let png;
const hits = { api: 0, img: 0 };
const axiosAsli = axios.get;
axios.get = async (url) => {
  if (String(url).includes('/api/game/tebak-gambar')) {
    hits.api++;
    return { data: { success: true, creator: 'YaPari',
      results: { index: SOAL, image: GAMBAR, answer: JAWABAN, total: 4928 } } };
  }
  if (String(url).includes('raw.githubusercontent.com')) {
    hits.img++;
    return { data: png };
  }
  throw new Error(`URL nggak dikenal tes: ${url}`);
};

// ── ctx palsu ─────────────────────────────────────────────────────────────────
const sent = [], replied = [], reacted = [];
const ctx = (over = {}) => ({
  isCmd: true, command: 'tebakgambar', args: [],
  botData: { id: 1, prefix: '.', bot_name: 'Qwerty', footer_text: '© yaparibotz' },
  client: { message: { send: (...a) => sent.push(a) } },
  sock:   { message: { send: (...a) => sent.push(a) } },
  reply:  async (...a) => { replied.push(a.join(' ')); },
  react:  async (e) => { reacted.push(e); },
  isGroup: true, jid: JID, sender: '6287778032605@s.whatsapp.net', pushName: 'Al',
  isOwner: true, isAdmin: true, isPremium: false,
  msg: { message: { conversation: '' } },
  ...over,
});
const teks = (t) => ctx({ isCmd: false, command: undefined, msg: { message: { conversation: t } } });
const bersih = () => { sent.length = 0; replied.length = 0; reacted.length = 0; };
const balasan = () => replied.join(' | ');
const gambar = () => sent.map(a => a[1]).find(m => m && m.type === 'image');

(async () => {
  png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#c33' } }).png().toBuffer();

  await ok('`.tebakgambar` → 1 bubble gambar (JPEG) + nyebut nomor soal', async () => {
    bersih();
    const handled = await handler(ctx());
    assert.strictEqual(handled, true, 'handler nggak nge-handle .tebakgambar');
    assert.strictEqual(hits.api, 1, 'endpoint nggak dipanggil');
    assert.strictEqual(hits.img, 1, 'gambar nggak diunduh');
    const m = gambar();
    assert.ok(m, 'nggak ada bubble gambar');
    assert.strictEqual(m.mimetype, 'image/jpeg');
    assert.ok(Buffer.isBuffer(m.media) && m.media[0] === 0xff && m.media[1] === 0xd8, 'bukan JPEG valid');
    assert.ok(m.caption.includes('TEBAK GAMBAR'), 'caption kehilangan judul');
    assert.ok(m.caption.includes(`#${SOAL}`), 'caption kehilangan nomor soal');
    assert.match(m.caption, /Timeout: \*\d+ detik\*/, 'caption kehilangan timeout');
  });

  await ok('caption JANGAN bocorin jawaban', () => {
    const c = gambar().caption.toLowerCase();
    assert.ok(!c.includes(JAWABAN), 'jawaban nongol di caption — game-nya jebol');
    assert.ok(!c.includes('nasib'), 'kata jawaban nongol di caption');
  });

  await ok('`.tebakgambar` lagi → nolak, nggak bikin soal tumpuk (1 grup 1 soal)', async () => {
    bersih();
    await handler(ctx());
    assert.strictEqual(hits.api, 1, 'endpoint dipanggil lagi padahal soal masih aktif');
    assert.ok(/Masih ada soal tebak gambar aktif/.test(balasan()), `balasan: ${balasan()}`);
    assert.strictEqual(gambar(), undefined, 'nggak boleh kirim soal kedua');
  });

  await ok('`.clue` nyensor (bukan reveal) + sebut jumlah huruf', async () => {
    bersih();
    await handler(ctx({ command: 'clue' }));
    assert.ok(/Clue Tebak Gambar/.test(balasan()), `balasan: ${balasan()}`);
    assert.ok(balasan().includes('n____ b____'), `pola clue salah: ${balasan()}`);
    assert.match(balasan(), /11 huruf/);
    assert.ok(!balasan().includes(JAWABAN), 'clue bocorin jawaban');
  });

  await ok('jawaban ngawur → react ❌, soal tetap jalan', async () => {
    bersih();
    await handler(teks('xyz qqq'));
    assert.deepStrictEqual(reacted, ['❌']);
    assert.strictEqual(balasan(), '', 'nggak boleh bales apa-apa');
    await handler(ctx());
    assert.ok(/Masih ada soal tebak gambar aktif/.test(balasan()), 'soal hilang padahal belum dijawab');
  });

  await ok('jawaban mirip (typo) → "Hampir tepat", belum dihitung benar', async () => {
    bersih();
    // Dice bigram gampang maafin typo: "nasib buru" = 0.95 (masih dianggap BENAR).
    // Band "hampir tepat" (0.65–0.85) perlu 2 huruf beda → "nasib xuruk" = 0.80.
    await handler(teks('nasib xuruk'));
    assert.ok(/Hampir tepat/.test(sent.map(a => JSON.stringify(a[1])).join(' ')), `yang dikirim: ${JSON.stringify(sent)}`);
    await handler(ctx());
    assert.ok(/Masih ada soal tebak gambar aktif/.test(balasan()), 'soal kelar padahal cuma mirip');
  });

  await ok('jawaban persis → Benar + reveal + store bersih', async () => {
    bersih();
    await handler(teks('NASIB BURUK'));
    assert.ok(/Benar!/.test(balasan()), `balasan: ${balasan()}`);
    assert.ok(balasan().includes(JAWABAN), 'jawaban nggak di-reveal pas benar');
    assert.match(balasan(), /soal #20/);
    // Cek langsung ke store — jangan lewat handler(ctx()), itu malah mulai soal baru.
    assert.strictEqual(store.has(JID), false, 'store masih nyangkut setelah dijawab benar');
  });

  await ok('setelah kelar, pesan biasa lewat (nggak di-handle)', async () => {
    const handled = await handler(teks('halo semua'));
    assert.strictEqual(handled, false, 'handler ngaku nge-handle pesan biasa');
  });

  await ok('`.nyerah` → reveal jawaban + store bersih', async () => {
    bersih();
    await handler(ctx());
    assert.ok(gambar(), 'soal nggak mulai lagi');
    assert.strictEqual(store.has(JID), true, 'soal nggak ke-set di store');
    bersih();
    await handler(ctx({ command: 'nyerah' }));
    assert.ok(/Menyerah!/.test(balasan()), `balasan: ${balasan()}`);
    assert.ok(balasan().includes(JAWABAN), 'jawaban nggak di-reveal pas nyerah');
  });

  await ok('API error → bales gagal, jangan diem-diem "sukses"', async () => {
    bersih();
    axios.get = async () => { throw new Error('Connection refused'); };
    await handler(ctx());
    assert.ok(/Gagal ambil soal/.test(balasan()), `balasan: ${balasan()}`);
    assert.strictEqual(gambar(), undefined, 'nggak boleh nge-frame pesan gagal jadi soal');
    // balikin stub ke versi normal biar tes berikutnya (kalau nambah) tetap jalan
    axios.get = async (url) => String(url).includes('/api/game/tebak-gambar')
      ? { data: { results: { index: SOAL, image: GAMBAR, answer: JAWABAN } } }
      : { data: png };
  });

  await ok('kedaftar: `tebakgambar` masuk limitedCmds + alias `tebak-gambar` ada', () => {
    assert.ok(limitedCmds.has('tebakgambar'), 'tebakgambar nggak kena limit user biasa');
    const src = require('fs').readFileSync(path.resolve(__dirname, '..', 'plugins/00-game.js'), 'utf8');
    assert.ok(/case 'tebakgambar':\s*\n\s*case 'tebak-gambar':/.test(src), 'alias .tebak-gambar nggak kedaftar');
  });

  console.log(`\ntebak-gambar-game: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
