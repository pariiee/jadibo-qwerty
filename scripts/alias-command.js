'use strict';
/**
 * scripts/alias-command.js — laporan alias tiap command dari grup `case` di
 * plugins/.
 *
 * Grup `case 'a': case 'b': {` bukan otomatis alias: banyak yang berbagi badan
 *
 * Grup `case 'a': case 'b': {` bukan otomatis alias: banyak yang berbagi badan
 * tapi isinya bercabang sendiri (`command === 'setwelcome'` → setleft/setbye
 * beda fitur). Grup begitu BUKAN alias, jadi tiap label dihitung command sendiri.
 *
 * Jalanin manual kalau habis nambah/ngubah command, lalu salin hasilnya ke
 * ALIAS di config/commandInfo.js:
 *
 *   node scripts/alias-command.js
 */
const fs = require('fs');
const path = require('path');

const RE_CASE = /^\s*case\s+'([^']+)'\s*:/;

/** Ambil isi blok `{ ... }` mulai dari baris pembuka — brace-aware. */
function blokDari(baris, i) {
  let dalam = 0, mulai = false, buf = [];
  for (let j = i; j < baris.length && j < i + 400; j++) {
    const b = baris[j];
    for (const ch of b) {
      if (ch === '{') { dalam++; mulai = true; }
      else if (ch === '}') dalam--;
    }
    buf.push(b);
    if (mulai && dalam <= 0) return buf.join('\n');
  }
  return buf.join('\n');
}

function pindai(dir) {
  const aliasKe = {}, aliasDari = {}, grupSemua = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
    const baris = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/);
    let i = 0;
    while (i < baris.length) {
      const m = RE_CASE.exec(baris[i]);
      if (!m) { i++; continue; }
      const label = [m[1]];
      let j = i + 1, buka = /\{\s*$/.test(baris[i]);
      while (!buka && j < baris.length && j < i + 40) {
        const m2 = RE_CASE.exec(baris[j]);
        if (m2) { label.push(m2[1]); if (/\{\s*$/.test(baris[j])) buka = true; j++; continue; }
        const b = baris[j].trim();
        if (b === '' || b.startsWith('//')) { j++; continue; }
        break;
      }
      if (label.length > 1) {
        const badan = blokDari(baris, j - 1);
        // bercabang? ada perbandingan terhadap salah satu label
        const bercabang = label.some((l) =>
          new RegExp("command\\s*===\\s*'" + l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "'").test(badan) ||
          new RegExp("command\\s*\\.startsWith\\('" + l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "'\\)").test(badan));
        grupSemua.push({ file: f, utama: label[0], label, bercabang });
        if (!bercabang) {
          aliasKe[label[0]] = (aliasKe[label[0]] || []).concat(label.slice(1));
          for (const a of label.slice(1)) aliasDari[a] = label[0];
        }
      }
      i = j;
    }
  }
  return { aliasKe, aliasDari, grupSemua };
}

const { aliasKe, aliasDari, grupSemua } = pindai(path.join(__dirname, '..', 'plugins'));
console.log('grup case (multi-label) :', grupSemua.length);
console.log('  bercabang (BUKAN alias):', grupSemua.filter((g) => g.bercabang).length);
console.log('  alias asli             :', grupSemua.filter((g) => !g.bercabang).length);
console.log('label yang jadi alias   :', Object.keys(aliasDari).length);
console.log('\ncontoh BERCABANG (jangan dianggap alias):');
for (const g of grupSemua.filter((x) => x.bercabang).slice(0, 8)) console.log('  ', g.file, g.label.join(' / '));
console.log('\ncontoh ALIAS ASLI:');
for (const g of grupSemua.filter((x) => !x.bercabang).slice(0, 12)) console.log('  ', g.file, g.label[0], '->', g.label.slice(1).join(', '));

const info = require('../plugins/01-info');
const primer = info.ALL_COMMANDS.filter((c) => !aliasDari[c]);
console.log('\nALL_COMMANDS:', info.ALL_COMMANDS.length, '| PRIMER:', primer.length);
