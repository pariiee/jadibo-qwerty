'use strict';
// `.link` (dulu `linkgroup`) + alias `.linkgc` — dua-duanya harus nyasar ke
// handler yang SAMA. Kalau redirect-nya balik ke 'link' sendiri, handler
// manggil dirinya sendiri tanpa henti.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const P2 = fs.readFileSync(path.join(__dirname, '..', 'plugins', '02-group.js'), 'utf8');
const P1 = fs.readFileSync(path.join(__dirname, '..', 'plugins', '01-info.js'), 'utf8');

let gagal = 0;
function tes(nama, fn) {
  try { fn(); console.log(`  ok   ${nama}`); }
  catch (e) { gagal++; console.log(`  FAIL ${nama}\n       ${e.message}`); }
}

console.log('link / linkgc');

tes('nama lama `linkgroup` udah nggak ada', () => {
  assert.ok(!/linkgroup/.test(P2), 'masih ada `linkgroup` di 02-group.js');
  assert.ok(!/linkgroup/.test(P1), 'masih ada `linkgroup` di 01-info.js');
});

tes('.linkgc redirect ke handler `link`', () => {
  assert.match(P2, /case 'linkgc':\s*\r?\n\s*return module\.exports\(\{ \.\.\.ctx, command: 'link' \}\);/,
    'linkgc nggak redirect ke link');
});

tes('handler aslinya `case \'link\'` (bukan redirect ke diri sendiri)', () => {
  assert.match(P2, /case 'link': \{/, 'handler link nggak ada');
});

tes('registry: ALL_COMMANDS, CATS.grup, limitedCmds pakai `link`', () => {
  const info = require('../plugins/01-info');
  assert.ok(info.ALL_COMMANDS.includes('link'), 'ALL_COMMANDS belum `link`');
  assert.match(P1, /'linkgc','link','listadmin'/, 'CATS.grup belum `link`');
  assert.match(P2, /'link','groupinfo','idgc'/, 'limitedCmds belum `link`');
});

console.log(gagal ? `\n${gagal} FAIL` : '\n0 FAIL');
process.exit(gagal ? 1 : 0);
