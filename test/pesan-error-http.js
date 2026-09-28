'use strict';
/**
 * test/pesan-error-http.js
 * Kunci perilaku `rapikanError` buat error HTTP mentah (error axios asli).
 *
 * Kenapa ada: satu laporan `.tt` dijawab "link-nya nggak valid" TIGA kali padahal
 * linknya jalan — ternyata HTTP 429 (kena limit) & 408 (server ngadat) ketangkep
 * aturan umum `status code 4\d\d`. Member jadi ngira linknya rusak, padahal
 * servernya yang rewel. Status harus dibaca per-kode.
 *
 * Jalankan: node test/pesan-error-http.js
 */
const assert = require('assert');
const { rapikanError } = require('../engine/pesanError');

// Error axios asli: message-nya `Request failed with status code N`, data dari BE.
const ax = (status, pesanBe) => Object.assign(
  new Error(`Request failed with status code ${status}`),
  { response: { status, data: pesanBe === undefined ? {} : { message: pesanBe } } },
);

const LINK_RUSAK = 'link-nya nggak valid atau udah nggak bisa diakses';

// ── 1. Jangan pernah bilang "link nggak valid" kalau linknya nggak salah ──────
for (const s of [401, 403, 408, 429]) {
  assert.notStrictEqual(rapikanError(ax(s)), LINK_RUSAK,
    `HTTP ${s} harusnya BUKAN "link nggak valid" (linknya sah)`);
}
for (const s of [500, 502, 503, 504]) {
  assert.strictEqual(rapikanError(ax(s)), 'server sumbernya lagi error',
    `HTTP ${s} = server sumber yang error`);
}

// ── 2. Yang memang salah link tetap dibilang link ────────────────────────────
assert.strictEqual(rapikanError(ax(400)), LINK_RUSAK);
assert.strictEqual(rapikanError(ax(404)), LINK_RUSAK);

// ── 3. Bedanya kelihatan buat member (inilah gunanya perbaikan ini) ──────────
assert.notStrictEqual(rapikanError(ax(429)), rapikanError(ax(404)),
  '429 (kena limit) harus beda kalimatnya dari 404 (link nggak ada)');

// ── 4. Pesan ramah dari BE tetap dipakai apa adanya ─────────────────────────
assert.strictEqual(rapikanError(ax(422, 'Video bersifat private.')), 'Video bersifat private.');
// Tapi pesan BE yang masih mentah JANGAN dibocorin; status yang ngomong.
assert.notStrictEqual(rapikanError(ax(500, 'connect ETIMEDOUT 172.64.80.1:443')), '[object Object]');

// ── 5. Error non-HTTP tetap seperti sebelumnya ───────────────────────────────
assert.strictEqual(rapikanError({ code: 'ECONNABORTED', message: 'timeout of 13000ms exceeded' }),
  'koneksi ke servernya timeout');
assert.strictEqual(rapikanError(new Error('Video TikTok ini tidak tersedia (dihapus/privat/region terkunci).')),
  'Video TikTok ini tidak tersedia (dihapus/privat/region terkunci).');

// ── 6. Nilai balik SELALU string & nggak pernah kosong ───────────────────────
const semuaObjek = [ax(400), ax(500), ax(429), ax(503, 'x'), { message: '' }, {}, null, undefined, 'ETIMEDOUT x'];
for (const e of semuaObjek) {
  const hasil = rapikanError(e);
  assert.strictEqual(typeof hasil, 'string', `rapikanError(${JSON.stringify(e)}) bukan string: ${hasil}`);
  assert.ok(hasil.trim().length > 0, 'rapikanError nggak boleh balikin string kosong');
}
assert.notStrictEqual(rapikanError(ax(500, 'connect ETIMEDOUT 1.2.3.4:443')), '[object Object]');

console.log('semua ok — pesan error HTTP kebaca per-kode');
