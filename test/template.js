'use strict';

/**
 * test/template.js
 * Renderer teks template (engine/template.js) — dipakai .setwelcome / .setbye /
 * .setopen / .setclose. Yang dikunci di sini:
 *   - alias name (@user vs @usertag) nggak saling makan — @usertag cuma alias
 *     lama yang masih dirender, yang didokumentasiin cuma @user
 *   - waktu WIB (jam/menit/detik/hari/tanggal/bulan/tahun/namabulan)
 *   - mention cuma sekali walau variable-nya dipakai berkali-kali
 *   - variable asing dibiarin apa adanya (bukan dihapus diem-diem)
 */

const assert = require('assert');

const { renderTemplate, catatan } = require('../engine/template');

// Selasa, 15 September 2026 10:05:07 WIB
const NOW = new Date('2026-09-15T10:05:07+07:00');

let pass = 0, fail = 0;

function ok(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); fail++; }
}

console.log('template:');

ok('@user / @usertag -> tag member, mentions nggak dobel', () => {
  const r = renderTemplate('Halo @user | @usertag | halo lagi @user!', {
    target: '628111222333@s.whatsapp.net',
  });
  assert.strictEqual(r.text, 'Halo @628111222333 | @628111222333 | halo lagi @628111222333!');
  assert.deepStrictEqual(r.mentions, ['628111222333@s.whatsapp.net']);
});

ok('@usertag nggak kepotong jadi @<tag>tag (alias name lebih panjang diduluin)', () => {
  const r = renderTemplate('@usertag', { target: '628111222333@s.whatsapp.net' });
  assert.strictEqual(r.text, '@628111222333');
});

ok('nama grup: @subject / @groupname / @namegc + @desc', () => {
  const r = renderTemplate('@subject|@groupname|@namegc|@desc', {
    groupName: 'Tester YaPari',
    groupDesc: 'grup uji',
  });
  assert.strictEqual(r.text, 'Tester YaPari|Tester YaPari|Tester YaPari|grup uji');
});

ok('waktu WIB lengkap', () => {
  const r = renderTemplate(
    '@jam:@menit:@detik @hari @tanggal @bulan @tahun @namabulan',
    { now: NOW }
  );
  assert.strictEqual(r.text, '10:05:07 Selasa 15 9 2026 September');
});

ok('@tagdiri / @tagreply -> mention sender & yang di-reply', () => {
  const r = renderTemplate('@tagdiri nge-tag @tagreply', {
    sender: '628999888777@s.whatsapp.net',
    replyTo: '628555444333@s.whatsapp.net',
  });
  assert.strictEqual(r.text, '@628999888777 nge-tag @628555444333');
  assert.deepStrictEqual(r.mentions, ['628999888777@s.whatsapp.net', '628555444333@s.whatsapp.net']);
});

ok('@pesanan diisi, variable asing dibiarin', () => {
  const r = renderTemplate('Pesanan: @pesanan @ngawur', { pesanan: 'Nasi Goreng x2' });
  assert.strictEqual(r.text, 'Pesanan: Nasi Goreng x2 @ngawur');
});

ok('template kosong -> teks kosong, nggak nge-crash', () => {
  assert.deepStrictEqual(renderTemplate('', {}), { text: '', mentions: [] });
  assert.deepStrictEqual(renderTemplate(undefined, {}), { text: '', mentions: [] });
});

ok('tanpa target -> mention kosong (bukan string "undefined")', () => {
  const r = renderTemplate('hai @user dari @groupname', { groupName: 'Grup' });
  assert.strictEqual(r.text, 'hai  dari Grup');
  assert.deepStrictEqual(r.mentions, []);
});

ok('catatan() nyebut semua variable yang didukung', () => {
  const c = catatan('setclose');
  assert.strictEqual(typeof c, 'string');
  for (const v of ['@groupname', '@user', '@tagdiri', '@tagreply', '@jam', '@namabulan', '@pesanan']) {
    assert.ok(c.includes(v), `catatan nggak nyebut ${v}`);
  }
});

console.log(`\ntemplate: ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
