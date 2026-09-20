'use strict';
/**
 * Kumpulan command yang kepotong limit, diambil dari `module.exports.limitedCmds`
 * tiap plugin.
 *
 * Kenapa baca FILE, bukan require():
 *   `plugins/01-info.js` nulis `module.exports.limitedCmds` di BARIS TERAKHIR,
 *   sementara `plugins/05-owner.js` nge-`require('./01-info')` di baris atas buat
 *   ngambil ALL_COMMANDS. Jadi begitu ada yang require 01-info duluan, objek yang
 *   di-cache di require.cache BELUM punya `limitedCmds` — dan referensi basi itu
 *   yang dipakai selamanya. Hasilnya set-nya isi `menu`+`react` doang, dan
 *   custom command (ai, sticker, hd, play, ...) nggak pernah kepotong limit.
 *
 * Baca teks = nggak peduli urutan `module.exports`, nggak nge-load modul plugin
 * (yang punya efek samping), dan tetap kebaca walau plugin error saat di-require.
 */

const fs   = require('fs');
const path = require('path');

const POLA = /(?:^|\n)[ \t]*(?:module\.)?exports\.limitedCmds\s*=\s*new\s+Set\(\s*\[([\s\S]*?)\]/g;

/** Ambil semua nama command dari isi satu file plugin. */
function ambilLimitedCmds(kode) {
  const out = [];
  for (const m of String(kode).matchAll(POLA)) {
    for (const s of m[1].matchAll(/'([^']*)'|"([^"]*)"/g)) out.push(s[1] ?? s[2]);
  }
  return out;
}

/** Gabungan semua plugin jadi satu Set. */
function buildLimitedCmds(pluginsDir = path.resolve('./plugins')) {
  const result = new Set();
  if (!fs.existsSync(pluginsDir)) return result;
  const files = fs.readdirSync(pluginsDir).filter((f) => f.endsWith('.js')).sort();
  for (const file of files) {
    try {
      for (const cmd of ambilLimitedCmds(fs.readFileSync(path.join(pluginsDir, file), 'utf8'))) {
        result.add(cmd);
      }
    } catch { /* file nggak kebaca — lewat */ }
  }
  return result;
}

module.exports = { ambilLimitedCmds, buildLimitedCmds };
