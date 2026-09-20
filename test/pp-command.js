'use strict';
/**
 * test/pp-command.js — kunci `.pp` (alias `.getpp`):
 *   1. handler punya `case 'pp'` — ini akar masalahnya: dulu cuma `case 'getpp'`,
 *      jadi `.pp` diem total (nggak ada yang nangani, bukan error)
 *   2. `pp` kedaftar di registry tampilan (ALL_COMMANDS, CATS.grup, limitedCmds)
 *      biar nongol di `.menu grup` + kena limit harian sama kayak `.getpp`
 *   3. target dibaca dari mention > reply SEMUA jenis pesan > diri sendiri
 *      (dulu cuma extendedText/image/conversation → reply video/stiker = "nggak ada target")
 *   4. pesan "Penggunaan:" yang nggak pernah kesampaian itu nggak balik
 *
 * Jalanin: node test/pp-command.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const info = require('../plugins/01-info');
const { limitedCmds } = require('../plugins/02-group');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const grup = read('plugins/02-group.js');

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

ok('`pp` kedaftar di ALL_COMMANDS', () => {
  assert.ok(info.ALL_COMMANDS.includes('pp'), 'pp nggak ada di ALL_COMMANDS → command nggak pernah di-dispatch');
});

ok('`.pp` masuk kategori grup', () => {
  assert.ok(info.CATS.grup.includes('pp'), '.pp nggak nongol di menu grup');
});

ok('`.pp` ikut aturan limit harian (sama kayak `.getpp`)', () => {
  assert.ok([...limitedCmds].includes('pp'), '.pp nggak kena limit padahal .getpp kena');
  assert.ok([...limitedCmds].includes('getpp'), 'getpp hilang dari limitedCmds');
});

ok('handler: satu blok nangani `getpp` + `pp`', () => {
  assert.match(grup, /case 'getpp':\s*\n\s*case 'pp':\s*\{/, 'alias .pp nggak nempel di handler getpp');
});

ok('handler: reply dibaca dari SEMUA jenis pesan', () => {
  for (const t of ['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage', 'stickerMessage']) {
    assert.ok(new RegExp(`${t}\\?\\.contextInfo`).test(grup), `${t} nggak dibaca → reply ke ${t} dianggap nggak ada target`);
  }
});

ok('handler: target WAJIB eksplisit (tag/reply/nomor) — `.pp` polos nggak jatuh ke PP sendiri', () => {
  assert.match(grup, /let target = mentioned\[0\] \|\| ci\.participant\s*\n?\s*\|\| \(nomorArg/,
    'urutan target berubah — `.pp` polos harus balas instruksi, bukan PP pengirim');
  assert.match(grup, /if \(!dariNomor\) target = await lidToPnAsync\(client, target\);/,
    'target dari reply (masih LID) nggak di-resolve → caption `@628xx` nggak match mentionedJid → WA nampilin angka polos, bukan mention');
  assert.match(grup, /Tag orangnya, reply pesannya, atau tulis nomornya/,
    'teks instruksi buat `.pp` polos hilang');
});

ok('handler: pesan "Penggunaan:" yang nyangkut udah nggak ada', () => {
  assert.ok(!/Penggunaan: \$\{p\}getpp/.test(grup), 'teks "Penggunaan: .getpp @mention" nyangkut lagi');
});

// Alias `ppgrup` dicabut (duplikat `ppgroup`). Dijaga di sini biar nggak
// nyempil balik lewat copy-paste, di handler MAUPUN di registry menu.
ok('alias `ppgrup` beneran dicabut (handler + registry)', () => {
  assert.ok(!/case 'ppgrup'/.test(grup), "case 'ppgrup' muncul lagi di 02-group.js");
  assert.ok(!info.ALL_COMMANDS.includes('ppgrup'), 'ppgrup nangkring lagi di ALL_COMMANDS');
  assert.ok(!info.CATS.grup.includes('ppgrup'), 'ppgrup nongol lagi di menu grup');
  // `ppgroup` sendiri harus tetap hidup — yang dicabut cuma aliasnya.
  assert.ok(/case 'ppgroup':/.test(grup), "case 'ppgroup' ikut kehapus");
  assert.ok(info.CATS.grup.includes('ppgroup'), 'ppgroup ikut hilang dari menu');
});

ok('handler: nggak ada console.log sisa debug', () => {
  assert.ok(!/\[getpp\] mentioned:/.test(grup), 'debug log getpp muncul lagi');
});

console.log(`\npp-command: ${pass}/${pass} PASS`);
