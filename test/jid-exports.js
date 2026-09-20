#!/usr/bin/env node
/**
 * test/jid-exports.js
 * Ngunci janji `engine/jid.js`: fungsi yang dipakai plugin HARUS ke-export.
 *
 * Kenapa: `getOrCreateMember()` di 03-fun-rpg.js manggil `isJlidUser`, tapi
 * `module.exports` di engine/jid.js nggak nyebutin — hasilnya `undefined`, dan
 * `.me` + semua command RPG mati dengan "Gagal load profil: ada gangguan
 * teknis di sisi server" (kata-kata rapi, akarnya fungsi nggak ke-export).
 *
 * Jalankan: node test/jid-exports.js
 */
'use strict';
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const root = path.join(__dirname, '..');
const jid  = require(path.join(root, 'engine/jid'));

// Nama yang wajib ada di exports (dipakai lintas plugin).
for (const n of ['isJlidUser', 'isPn', 'isLid', 'bare', 'toPn', 'participantPhones']) {
  assert.strictEqual(typeof jid[n], 'function', `engine/jid.js nggak nge-export '${n}'`);
}

// Sweep: apa pun yang di-destructure dari engine/jid harus ada isinya.
const berkas = ['plugins/02-group.js', 'plugins/03-fun-rpg.js', 'plugins/05-owner.js',
                'engine/whatsappEngine.js'];
for (const rel of berkas) {
  const src = fs.readFileSync(path.join(root, rel), 'utf8');
  for (const m of src.matchAll(/const\s*\{([^}]+)\}\s*=\s*require\([^)]*jit?\b[^)]*\)/g)) {
    for (const bagian of m[1].split(',')) {
      const nama = bagian.split(':')[0].trim();
      if (!nama) continue;
      assert.ok(nama in jid, `${rel}: nyomot '${nama}' dari engine/jid.js — nggak ada di exports`);
    }
  }
}

console.log('\u2705 jid-exports: semua yang disomot dari engine/jid.js ada');
