#!/usr/bin/env node
/**
 * scripts/audit-adapter.js
 * Cari pemanggilan method adapter yang NGGAK ADA di engine/baileys/client.js.
 * Kelas bug ini diam-diam: `ctx.client.group.getMetadata()` nggak ada di adapter
 * (namanya `queryGroupMetadata`) -> tiap `.resetlimit` di grup jatuh ke cabang
 * error dan limit nggak pernah direset, tapi bot tetap bilang selesai.
 *
 * Jalankan: node scripts/audit-adapter.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src  = fs.readFileSync(path.join(root, 'engine/baileys/client.js'), 'utf8');

// Ambil blok `  const client = {` lalu jalanin brace matching, biar objek
// bersarang (mis. message.downloadBytes) nggak bikin blok-nya kepotong.
const start = src.indexOf('const client = {');
if (start < 0) { console.error('blok `const client = {` nggak ketemu'); process.exit(1); }
let i = src.indexOf('{', start), depth = 0, end = -1;
for (let j = i; j < src.length; j++) {
  if (src[j] === '{') depth++;
  else if (src[j] === '}' && --depth === 0) { end = j; break; }
}
const body  = src.slice(i + 1, end).split('\n');
const lines = src.slice(0, i + 1).split('\n').length; // nomor baris 'client = {' -> offset

const ada = new Set();
let grup = null, dalamGrup = 0;
body.forEach((line, n) => {
  const d = (line.match(/^\s*/) || [''])[0].length;
  const isi = line.trim();
  const m = isi.match(/^([\w$]+)\s*:/) || isi.match(/^([\w$]+)\s*,$/); // `send,` = shorthand
  if (!m) return;
  if (/^([\w$]+)\s*:\s*\{/.test(isi) && d === 4) { grup = m[1]; dalamGrup = 1; return; }
  if (d === 6 && grup && dalamGrup) ada.add(`${grup}.${m[1]}`);
  if (d <= 4) { grup = null; dalamGrup = 0; }
});

const pakai = [];
for (const dir of ['plugins', 'engine', 'server.js']) {
  const abs = path.join(root, dir);
  const files = fs.statSync(abs).isDirectory()
    ? fs.readdirSync(abs).filter((f) => f.endsWith('.js')).map((f) => `${dir}/${f}`)
    : [dir];
  for (const rel of files) {
    const s = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const m of s.matchAll(/client\.(\w+)\.(\w+)\s*\(/g)) {
      const kunci = `${m[1]}.${m[2]}`;
      if (!ada.has(kunci)) pakai.push(`${rel}:${s.slice(0, m.index).split('\n').length}  ${kunci}`);
    }
  }
}

console.log(`method adapter: ${ada.size} (${[...ada].slice(0, 6).join(', ')}...)`);
if (pakai.length) {
  console.error(`\u274c ${pakai.length} pemanggilan ke method yang nggak ada:`);
  pakai.forEach((p) => console.error('   ' + p));
  process.exitCode = 1;
} else {
  console.log('\u2705 semua pemanggilan cocok sama adapter');
}
