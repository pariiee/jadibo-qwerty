'use strict';
// `.groupinfo/.infogc` + `.on` polos harus nampilin blok status yang SAMA.
//
// Yang dijaga: blok status cuma ditulis sekali (06-proteksi.statusFitur) dan
// dipakai dua tempat. Kalau ada yang nyalin balik jadi hardcode, tes ini gagal.

const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');

const P6 = fs.readFileSync(path.join(__dirname, '..', 'plugins', '06-proteksi.js'), 'utf8');
const P2 = fs.readFileSync(path.join(__dirname, '..', 'plugins', '02-group.js'), 'utf8');
const P1 = fs.readFileSync(path.join(__dirname, '..', 'plugins', '01-info.js'), 'utf8');

let gagal = 0;
function tes(nama, fn) {
  try { fn(); console.log(`  ok   ${nama}`); }
  catch (e) { gagal++; console.log(`  FAIL ${nama}\n       ${e.message}`); }
}

console.log('groupinfo + status fitur');

tes('statusFitur diekspor dari 06-proteksi (setelah module.exports = handler)', () => {
  assert(/^module\.exports\.statusFitur = /m.test(P6), 'statusFitur nggak diekspor');
});

tes('baris status cuma ada di SATU tempat (nggak di-hardcode di 02-group)', () => {
  assert(!/── Proteksi ──/.test(P2), 'blok status di-hardcode di 02-group lagi');
  assert(/── Proteksi ──/.test(P6), 'blok status ilang dari 06-proteksi');
});

tes('.on polos manggil statusFitur', () => {
  assert(/proteksi\.statusFitur\(botData\.id, jid\)/.test(P6), '.on polos nggak manggil statusFitur');
});

tes('.groupinfo manggil statusFitur', () => {
  assert(/proteksi\.statusFitur\(botData\.id, jid\)/.test(P2), '.groupinfo nggak manggil statusFitur');
});

tes('02-group ngambil proteksi lewat require', () => {
  assert(/require\('\.\/06-proteksi'\)/.test(P2), 'require 06-proteksi nggak ada');
});

tes('alias infogc sebaris sama groupinfo', () => {
  assert(/case 'groupinfo':\s*\r?\n\s*case 'infogc': \{/.test(P2), 'alias infogc nggak nyambung');
  assert(/'groupinfo',[^\n]*'infogc'|'infogc',/.test(P1), 'infogc nggak ada di ALL_COMMANDS');
});

tes('FITUR_INFO + pool ada (dasar statusFitur jalan)', async () => {
  const p = require(path.join(__dirname, '..', 'plugins', '06-proteksi.js'));
  assert(p.FITUR_INFO && p.FITUR_INFO.detect, 'FITUR_INFO ilang');
  assert(typeof p.statusFitur === 'function', 'statusFitur bukan fungsi');
});

console.log(gagal ? `\n${gagal} FAIL` : '\n0 FAIL');
process.exit(gagal ? 1 : 0);
