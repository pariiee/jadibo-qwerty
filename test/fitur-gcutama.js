'use strict';
/**
 * test/fitur-gcutama.js — kunci 3 hal:
 *   1. `.fitur` sudah nggak didaftarin & nggak ditangani (duplikat `.on` doang)
 *   2. `.gcutama` (nama baru, dulu `.setgcutama`) masih nulis kolom main_groups
 *   3. panel web cuma nerima ID grup — link undangan ditolak di FE & endpoint
 *      resolve-nya udah dibuang
 *
 * Jalanin: node test/fitur-gcutama.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

const info = read('plugins/01-info.js');
const proteksi = read('plugins/06-proteksi.js');
const owner = read('plugins/05-owner.js');
const html = read('public/bot-detail.html');
const ctrl = read('controllers/botController.js');
const server = read('server.js');

ok(".fitur nggak ada di ALL_COMMANDS maupun CATS", () => {
  assert.ok(!/'fitur'/.test(info), "'fitur' masih nyempil di plugins/01-info.js");
});
ok(".fitur nggak ada case handler-nya lagi", () => {
  assert.ok(!/case 'fitur'/.test(proteksi), "case 'fitur' masih ada");
  assert.ok(!/'proteksi','fitur'/.test(proteksi), "'fitur' masih di skipCmds");
});
ok(".gcutama yang ditangani (bukan .setgcutama)", () => {
  assert.ok(/case 'gcutama': \{/.test(owner));
  assert.ok(!/setgcutama/.test(owner), 'masih ada sisa .setgcutama');
  assert.ok(/'setlimitgc','gcutama'/.test(info), 'gcutama nggak ada di daftar command');
});
ok('panel web: placeholder cuma ID grup + hint baru', () => {
  assert.ok(/120363xxxxxxxxxx@g\.us"><\/textarea>/.test(html), 'placeholder masih ada baris link');
  assert.ok(!/chat\.whatsapp\.com\/XXXXXX/.test(html), 'placeholder masih nyontohin link');
  assert.ok(/Masukan id grup \/ <code>\.gcutama<\/code> untuk meng set gc utama anda\./.test(html));
});
ok('panel web: tombol Resolve + UI errornya dibuang', () => {
  assert.ok(!/btn-resolve|resolve-errors|resolve-status|addResolveError/.test(html));
});
ok('panel web: submit nolak non-ID-grup', () => {
  assert.ok(/const bad = mgList\.find\(s => !\/\^\\d\+@g\\\.us\$\/\.test\(s\)\);/.test(html),
    'validasi ID grup di submit nggak ketemu');
});
ok('endpoint resolve-invite + adapter groupGetInviteInfo sudah hilang', () => {
  assert.ok(!/resolveInvite|resolve-invite/.test(ctrl), 'masih ada resolveInvite di controller');
  assert.ok(!/resolve-invite/.test(server), 'route resolve-invite masih kedaftar di server.js');
  assert.ok(!/queryGroupInviteInfo/.test(read('engine/baileys/client.js')));
});

console.log(`\nfitur-gcutama: ${pass}/${pass} PASS`);
