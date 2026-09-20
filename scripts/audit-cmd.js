#!/usr/bin/env node
/**
 * scripts/audit-cmd.js
 * Cari command yang "hantu": terdaftar di limitedCmds (limit kepotong) tapi
 * nggak punya `case` di plugin mana pun -> user ngetik, limit kebuang, bot diam.
 * Juga cek sebaliknya: `case` yang nggak pernah bisa dipanggil (nggak ada di
 * ALL_COMMANDS) supaya keliatan command yang "nggak pernah jalan".
 *
 * Jalankan: node scripts/audit-cmd.js
 */
'use strict';
const fs = require('fs'), path = require('path');
const dir = path.resolve(__dirname, '../plugins');

const files = fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort();
const cases = new Map();      // command -> [file]
const limited = new Map();    // command -> [file]
const allCommands = new Set();

for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  for (const m of src.matchAll(/case\s+'([a-z0-9_]+)'/g)) {
    if (!cases.has(m[1])) cases.set(m[1], []);
    cases.get(m[1]).push(f);
  }
  let mod; try { mod = require(path.join(dir, f)); } catch { continue; }
  if (mod.limitedCmds instanceof Set) for (const c of mod.limitedCmds) {
    if (!limited.has(c)) limited.set(c, []);
    limited.get(c).push(f);
  }
  // ALL_COMMANDS biasanya array; ambil dari modul yang punya
  if (Array.isArray(mod.ALL_COMMANDS)) for (const c of mod.ALL_COMMANDS) allCommands.add(c);
}

const hantu = [...limited.keys()].filter(c => !cases.has(c)).sort();
const tanpaLimit = [...cases.keys()].filter(c => !limited.has(c)).length;

console.log(`plugins: ${files.length} | case unik: ${cases.size} | limitedCmds unik: ${limited.size} | ALL_COMMANDS: ${allCommands.size}`);
console.log(`\n== KEPOTONG TAPI NGGAK ADA HANDLER (${hantu.length}) ==`);
for (const c of hantu) console.log(`  ${c}  <- ${limited.get(c).join(', ')}`);
console.log(`\n== HANDLER TANPA LIMIT (${tanpaLimit}) ==  <- bukan bug, cuma info`);
console.log(`\n== CASE YANG NGGAK ADA DI ALL_COMMANDS ==`);
const tak = [...cases.keys()].filter(c => allCommands.size && !allCommands.has(c)).sort();
console.log(tak.length ? '  ' + tak.join(' ') : '  (semua kecatat)');
process.exitCode = hantu.length ? 1 : 0;
