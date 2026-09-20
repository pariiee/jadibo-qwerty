'use strict';

/**
 * test/role-order.js
 * Ngunci urutan role di engine: dev > owner > premium > admin > user.
 * Dulu `.cek limit` cuma baca kolom `premium` di DB -> owner + developer
 * kelihatan 'User biasa' dan limitnya kelihatan kepotong 20.
 *
 * Jalankan: node test/role-order.js   (atau lewat `npm test`)
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const root  = path.join(__dirname, '..');
const baca  = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const engine = baca('engine/whatsappEngine.js');
const info   = baca('plugins/01-info.js');
const mess   = require('../config/mess');

let lulus = 0;
function cek(nama, fn) {
  try { fn(); lulus++; console.log(`  ✅ ${nama}`); }
  catch (e) { console.error(`  ❌ ${nama}\n     ${e.message}`); process.exitCode = 1; }
}

console.log('test/role-order.js');

cek('label role lengkap & urutannya dev > owner > premium > admin > user', () => {
  const urut = Object.keys(mess.roleLabel);
  assert.deepStrictEqual(urut, ['dev', 'owner', 'premium', 'admin', 'user'],
    `urutan label salah: ${urut.join(' > ')}`);
});

cek('engine hitung ctx.role, dev menang atas owner', () => {
  assert.ok(/ctx\.role = ctx\.isDev/.test(engine), 'ctx.role nggak dihitung di engine');
  // rantai ternary: isDev dulu, baru isOwner, isPremium, isAdmin — terakhir 'user'
  const blok = engine.slice(engine.indexOf('ctx.role ='));
  const urut = [...blok.slice(0, 400).matchAll(/ctx\.is(Dev|Owner|Premium|Admin)/g)].map((m) => m[1]);
  assert.deepStrictEqual(urut, ['Dev', 'Owner', 'Premium', 'Admin'],
    `urutan pengecekan role salah: ${urut.join(' > ')}`);
});

cek('nomor kosong nggak boleh lolos jadi owner/dev', () => {
  assert.ok(/const nomorPengirim = /.test(engine), 'gerbang nomorPengirim nggak ada');
  // nomorPengirim harus nolak '' dan '0' -> dua nomor kosong nggak bisa `'' === ''`
  assert.ok(/senderNum && senderNum === ownerNum/.test(engine),
    'pembanding owner nggak pakai gerbang senderNum');
  assert.ok(/Boolean\(senderNum\) && DEV_NUMBERS\.has/.test(engine),
    'pembanding dev nggak pakai gerbang senderNum');
});

cek('.limit pakai ctx.role, bukan kolom premium mentah', () => {
  const blok = info.slice(info.indexOf("case 'limit':"), info.indexOf("case 'limit':") + 1600);
  assert.ok(/mess\.roleLabel\[ctx\.role\]/.test(blok), '.limit masih nggak baca ctx.role');
  assert.ok(!/isPrem \? '\*Premium\*/.test(blok), ".limit masih pakai ternary isPrem lama");
  assert.ok(!/const \{ name, lim, premium \}/.test(blok), '.limit masih ambil kolom premium');
  assert.ok(/skipLim \? `\*\$\{lim\}\* \(nggak kepotong\)`/.test(blok),
    'baris Limit nggak ngejelasin limit-nya nggak kepotong');
});

cek('cuma role user yang kena gate limit', () => {
  assert.ok(/ctx\.role === 'user'/.test(engine),
    'gate limit nggak pakai ctx.role — dev/owner/premium/admin bakal kehitung kena limit');
});

cek('.menu & .bot pakai label role yang sama', () => {
  const owner = baca('plugins/05-owner.js');
  for (const [nama, isi] of [['.menu', info], ['.bot', owner]]) {
    assert.ok(/mess\.roleLabel\[ctx\.role\]/.test(isi), `${nama} nggak pakai mess.roleLabel`);
  }
});

cek('gate dev cuma satu sumber (ctx.isDev), bukan baca env sendiri', () => {
  for (const rel of ['plugins/09-jarvis.js', 'plugins/10-crm.js']) {
    assert.ok(!/process\.env\.DEVELOPER_NUMBER/.test(baca(rel)), `${rel} masih baca env sendiri`);
    assert.ok(/ctx\.isDev/.test(baca(rel)), `${rel} nggak pakai ctx.isDev`);
  }
});

console.log(`\n${lulus} lulus${process.exitCode ? ', ADA GAGAL' : ''}`);
