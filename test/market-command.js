'use strict';
/**
 * test/market-command.js
 * `.market` (alias `.saham`/`.crypto`/`.koin`/`.forex`/`.kurs`/`.emas`/`.gold`/`.xau`/`.silver`):
 * satu command buat semua kelas aset — yang nentuin jenisnya endpoint
 * `api/tools/harga-saham`, bukan nama command.
 *
 * Yang dijaga di sini:
 *   - simbol polos 4 huruf yang DITOLAK (400) dicoba ulang sebagai `.JK`,
 *     tapi simbol yang jalan di percobaan pertama nggak di-retry (biar `AAPL`
 *     nggak pernah berubah jadi `AAPL.JK`);
 *   - pesan 400 dari API dipakai apa adanya, bukan "Request failed with status code 400".
 *
 * Handler dijalankan beneran dengan ctx palsu; engine/api di-stub.
 */
const assert = require('assert');
const path   = require('path');
const Module = require('module');

const BE = path.join(__dirname, '..');

// ── Stub engine/api ─────────────────────────────────────────────────────────
const panggilan = [];   // [{ symbol }]
let jawab = () => ({ data: {} });
const apiPath = require.resolve(path.join(BE, 'engine', 'api.js'));
const apiStub = {
  base: () => 'https://yapari.web.id',
  url: (p) => `https://yapari.web.id/${String(p).replace(/^\/+/, '')}`,
  auth: () => ({ 'X-API-Key': 'uji' }),
  upload: async () => 'https://d.uguu.se/uji.jpg',
  uploadInfo: async () => ({ url: 'https://d.uguu.se/uji.jpg' }),
  apiGet: async (p, opts) => {
    panggilan.push({ path: p, symbol: opts?.params?.symbol });
    return jawab(opts?.params?.symbol);
  },
  apiPost: async () => ({ data: {} }),
};

const asli = Module._load;
Module._load = function (req, parent) {
  if (req === 'axios') return { create: () => apiStub, get: async () => ({ data: {} }) };
  const resolved = (() => { try { return Module._resolveFilename(req, parent); } catch { return null; } })();
  if (resolved === apiPath) return apiStub;
  return asli.apply(this, arguments);
};

const handler = require('../plugins/04-tools');
const { ALL_COMMANDS, CATS } = require('../plugins/01-info');
const { limitedCmds } = require('../plugins/04-tools');

const NAMA = ['market', 'saham', 'crypto', 'koin', 'forex', 'kurs', 'emas', 'gold', 'xau', 'silver'];

// ── 1. Kecatat di menu + kena limit ─────────────────────────────────────────
for (const c of NAMA) {
  assert.ok(ALL_COMMANDS.includes(c), `\`${c}\` harus ada di ALL_COMMANDS`);
  assert.ok(CATS.tools.includes(c), `\`${c}\` harus ada di kategori tools`);
  assert.ok(limitedCmds.has(c), `\`${c}\` harus kena limit`);
}
console.log('✓ 1. market + 9 aliasnya kecatat di menu tools & kena limit');

// ── Harness ────────────────────────────────────────────────────────────────
const ok = (symbol, extra = {}) => ({ data: { results: { symbol, jenis: 'EQUITY', nama: 'PT Contoh Tbk', bursa: 'Jakarta', mata_uang: 'IDR', harga: 6225, harga_format: 'Rp6.225', perubahan: -1.19, perubahan_persen: '-1.19%', waktu: '2026-09-24T09:14:40.000Z', zona_waktu: 'Asia/Jakarta', ...extra } } });
const tolak = () => { const e = new Error('Request failed with status code 400'); e.response = { status: 400, data: { message: "Simbol 'ZZZ' tidak ditemukan." } }; throw e; };

const ctxHarga = (command, args) => {
  const balasan = [], reacts = [];
  return {
    balasan, reacts,
    ctx: {
      isCmd: true, isGroup: false, command, args,
      jid: '6287778032605@s.whatsapp.net', sender: '6287778032605@s.whatsapp.net',
      botData: { prefix: '.', bot_number: '628123456789', owner_number: '6287778032605' },
      reply: async (t) => balasan.push(String(t)),
      react: async (e) => reacts.push(e),
      sock: {}, msg: { conversation: `.${command} ${args.join(' ')}` }, client: { message: {} },
    },
  };
};

(async () => {
  // ── 2. Alias semuanya nembak endpoint yang sama ───────────────────────────
  for (const c of NAMA) {
    panggilan.length = 0;
    jawab = () => ok('BBCA.JK');
    const h = ctxHarga(c, ['BBCA.JK']);
    assert.strictEqual(await handler(h.ctx), true, `.${c} harus ditangani plugin tools`);
    assert.strictEqual(panggilan.length, 1, `.${c} cukup 1 request`);
    assert.strictEqual(panggilan[0].path, 'api/tools/harga-saham', `.${c} nembak endpoint harga-saham`);
    assert.strictEqual(panggilan[0].symbol, 'BBCA.JK', `.${c} simbol di-uppercase`);
    assert.ok(/PT Contoh Tbk/.test(h.balasan[0]) && /Rp6\.225/.test(h.balasan[0]), `.${c} harus nampilin nama + harga`);
    assert.ok(/🔴 1\.19%/.test(h.balasan[0]), `.${c} harus nampilin turun 1.19% tanpa minus dobel: ${h.balasan[0]}`);
    assert.ok(h.reacts.includes('✅') && h.balasan.length === 1, `.${c} sukses = react ✅ + 1 balasan`);
  }
  console.log('✓ 2. 10 alias -> 1 request ke api/tools/harga-saham, balasan seragam');

  // ── 3. Simbol polos yang ditolak → dicoba ulang sebagai saham IDX ─────────
  panggilan.length = 0;
  jawab = (s) => (s === 'BBCA.JK' ? ok('BBCA.JK') : tolak());
  const polos = ctxHarga('saham', ['bbca']);
  await handler(polos.ctx);
  assert.deepStrictEqual(panggilan.map((p) => p.symbol), ['BBCA', 'BBCA.JK'], `polos harus dicoba apa adanya dulu, baru .JK — dapet: ${panggilan.map((p) => p.symbol)}`);
  assert.ok(/Rp6\.225/.test(polos.balasan[0]), 'retry .JK harus balikin harganya');
  console.log('✓ 3. `.saham bbca` -> BBCA gagal -> BBCA.JK berhasil');

  // ── 4. Yang jalan di percobaan pertama TIDAK di-retry ─────────────────────
  panggilan.length = 0;
  jawab = () => ok('AAPL', { mata_uang: 'USD', harga_format: '$336,75' });
  const aapl = ctxHarga('market', ['aapl']);
  await handler(aapl.ctx);
  assert.deepStrictEqual(panggilan.map((p) => p.symbol), ['AAPL'], `AAPL nggak boleh diubah jadi AAPL.JK — dapet: ${panggilan.map((p) => p.symbol)}`);
  assert.ok(/\$336,75/.test(aapl.balasan[0]), 'harga AAPL harus tampil');
  console.log('✓ 4. `.market aapl` -> langsung AAPL, tanpa retry .JK');

  // ── 5. Logam mulia: tampil harga USD + rupiah ─────────────────────────────
  panggilan.length = 0;
  jawab = () => ok('XAUUSD', { jenis: 'LOGAM_MULIA', nama: 'Gold', bursa: 'Spot', mata_uang: 'USD', harga: 4257.1, harga_format: '$4.257,10', harga_idr: 76172292, perubahan: null, perubahan_persen: null, waktu: null, updated_at: '2026-09-24T16:01:26Z', zona_waktu: null });
  const emas = ctxHarga('emas', ['xauusd']);
  await handler(emas.ctx);
  assert.ok(/🥇/.test(emas.balasan[0]), 'logam harus pakai ikon 🥇');
  assert.ok(/\$4\.257,10/.test(emas.balasan[0]), 'harga USD logam harus tampil');
  assert.ok(/Rp76\.172\.292/.test(emas.balasan[0]), 'harga rupiah logam harus tampil');
  assert.ok(!/dari penutupan/.test(emas.balasan[0]), 'logam nggak punya penutupan sebelumnya — jangan ngarang baris persen');
  console.log('✓ 5. `.emas xauusd` -> USD + rupiah, tanpa baris persen palsu');

  // ── 6. Tanpa argumen → SEMUA kelas aset sekaligus (1 request, tanpa symbol) ─
  panggilan.length = 0;
  const ln = (symbol, harga_format, perubahan_persen = '1,10%') => ({ symbol, nama: symbol, jenis: 'EQUITY', harga_format, perubahan_persen });
  jawab = () => ({ data: { results: {
    mode: 'ringkasan',
    logam_mulia: [{ ...ln('XAUUSD', '$4.257,10'), jenis: 'LOGAM_MULIA', harga_idr: 76172292, updated_at: '2026-09-24T16:01:26Z' }],
    indeks: [ln('^JKSE', '7.123,45', '-0,30%')],
    forex: [ln('USDIDR=X', 'Rp16.150'), ln('EURUSD=X', '$1,1374', '-0,20%')],
    crypto: [ln('BTC-USD', '$110.000')],
    saham: [ln('BBCA.JK', 'Rp6.225', '-1,19%'), ln('AAPL', '$336,75')],
    gagal: [{ symbol: 'ETH-USD', error: 'Ada gangguan di server.' }],
  } } });
  const semua = ctxHarga('market', []);
  assert.strictEqual(await handler(semua.ctx), true, '.harga tanpa argumen tetap ditangani');
  assert.strictEqual(panggilan.length, 1, 'tanpa argumen cukup 1 request');
  assert.strictEqual(panggilan[0].path, 'api/tools/harga-saham', 'tanpa argumen nembak endpoint harga-saham');
  assert.strictEqual(panggilan[0].symbol, undefined, 'tanpa argumen JANGAN kirim symbol — biar API balikin ringkasan');
  const t = semua.balasan[0];
  for (const isi of ['Harga Terkini', '$4.257,10', '7.123,45', 'Rp16.150', '1,1374', '$110.000', 'Rp6.225', '$336,75']) {
    assert.ok(t.includes(isi), `ringkasan harus memuat ${isi}:\n${t}`);
  }
  assert.ok(/Logam Mulia/.test(t) && /Indeks/.test(t) && /Forex/.test(t) && /Crypto/.test(t) && /Saham/.test(t), 'kelima kelompok harus ada judulnya');
  assert.ok(!/=X|\.JK\b/.test(t.split('\n\nKetik')[0]), `daftar harga harus bersih dari akhiran simbol:\n${t}`);
  assert.ok(/🔴 -?0,30%|🔴 0,30%/.test(t) && /🟢 1,10%/.test(t), `arah naik/turun harus kelihatan:\n${t}`);
  assert.ok(/ETH-USD lagi nggak kebaca/.test(t), 'baris yang gagal harus disebut, bukan disembunyikan');
  assert.ok(/Ketik \.market/.test(t), 'harus ngarahin ke .market <simbol> buat detail');
  assert.strictEqual(t, t.trim(), 'pesan nggak boleh diawali/diakhiri spasi');
  assert.strictEqual(semua.balasan.length, 1, 'ringkasan = 1 balasan');
  assert.ok(semua.reacts.includes('✅'), 'ringkasan sukses = react ✅');
  console.log('✓ 6. `.market` tanpa argumen -> 5 kelompok aset (USD/IDR, logam, indeks, forex, crypto, saham)');

  // ── 6b. API nggak balikin hasil → jangan kirim pesan kosong ────────────────
  panggilan.length = 0;
  jawab = () => ({ data: {} });
  const blm = ctxHarga('market', []);
  await handler(blm.ctx);
  assert.ok(/nggak tersedia|nggak bisa/i.test(blm.balasan[0]), `hasil kosong harus jadi pesan jelas: ${blm.balasan[0]}`);
  assert.ok(blm.reacts.includes('❌'), 'hasil kosong = react ❌');
  console.log('✓ 6b. hasil ringkasan kosong -> pesan jelas, bukan balasan kosong');

  // ── 7. Simbol ngawur → pesan manusia dari API, bukan pesan axios ───────────
  panggilan.length = 0;
  jawab = () => tolak();
  const hantu = ctxHarga('market', ['zzzznope']);
  await handler(hantu.ctx);
  assert.ok(/tidak ditemukan/i.test(hantu.balasan[0]), `pesan API harus dipakai: ${hantu.balasan[0]}`);
  assert.ok(!/status code|errno|ECONN|ENOTFOUND|\/api\//i.test(hantu.balasan[0]), `jangan bocorin detail mentah: ${hantu.balasan[0]}`);
  assert.ok(hantu.reacts.includes('❌'), 'gagal harus react ❌');
  console.log('✓ 7. simbol ngawur -> pesan manusia, tanpa detail teknis');

  console.log('\nSemua tes market lewat.');
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
