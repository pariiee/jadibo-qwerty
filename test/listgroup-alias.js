'use strict';
// `.listgroup` + alias `.listgc` (owner). `.grouplist` (versi admin grup) DICABUT.
//
// Yang dijaga: alias-nya nyambung ke handler yang sama, dan `listgc` tetap
// kena gate owner — kalau nyasar ke handler grup, admin grup bisa lihat daftar
// grup lengkap plus id & status sewa.
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const root  = path.join(__dirname, '..');
const read  = f => fs.readFileSync(path.join(root, f), 'utf8');
const grup  = read('plugins/02-group.js');
const owner = read('plugins/05-owner.js');
const info  = require(path.join(root, 'plugins/01-info.js'));

// 1. `grouplist` dicabut beneran — case + registry, bukan disembunyiin.
assert.ok(!/grouplist/.test(grup), 'case grouplist masih ada di 02-group.js');
assert.ok(!info.ALL_COMMANDS.includes('grouplist'), 'grouplist masih di ALL_COMMANDS');
for (const [cat, cmds] of Object.entries(info.CATS)) {
  assert.ok(!cmds.includes('grouplist'), `grouplist masih dipajang di kategori ${cat}`);
}

// 2. `.listgroup` masih ada, dan `listgc` nempel jadi alias di registry.
assert.ok(info.ALL_COMMANDS.includes('listgroup'), 'listgroup ilang dari ALL_COMMANDS');
assert.ok(info.ALL_COMMANDS.includes('listgc'), 'listgc nggak kedaftar di ALL_COMMANDS');
assert.ok(info.CATS.owner.includes('listgroup') && info.CATS.owner.includes('listgc'),
  'listgroup/listgc nggak nongol di kategori owner');

// 3. Satu case di handler owner: `case 'listgroup':` lalu `case 'listgc': {`,
//    dan gate owner-nya nggak kelepas.
const potong = owner.slice(owner.indexOf("case 'listgroup':"));
assert.ok(owner.split("case 'listgroup':").length === 2, "case 'listgroup' harus tepat satu");
assert.ok(/^case 'listgroup':\r?\n\s*case 'listgc': \{/.test(potong),
  "listgc harus nempel langsung di bawah case 'listgroup': — bukan case terpisah");
assert.ok(/isOwner\(/.test(potong.slice(0, 900)),
  'listgroup/listgc kehilangan gate owner');

console.log('✓ listgroup + alias listgc (gate owner), grouplist udah dicabut');
