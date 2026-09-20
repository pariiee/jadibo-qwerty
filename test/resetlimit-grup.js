#!/usr/bin/env node
/**
 * test/resetlimit-grup.js
 * Ngunci janji `.resetlimit`: di grup cuma nge-reset member grup ITU.
 *
 * Dulu perintah ini `UPDATE rpg_members SET lim = ? WHERE bot_id = ?` — semua
 * user se-bot (59 orang, sisa dari grup lain), padahal grup tester isinya ~8.
 * Sekarang: mention -> orangnya, di grup -> anggota grup, di PC -> semua.
 *
 * Jalankan: node test/resetlimit-grup.js
 */
'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const owner = fs.readFileSync(path.join(__dirname, '..', 'plugins/05-owner.js'), 'utf8');
const start = owner.indexOf("case 'resetlimit'");
assert.ok(start >= 0, "case 'resetlimit' nggak ketemu di plugins/05-owner.js");
const blok = owner.slice(start, owner.indexOf("\n    case '", start + 10));

let lulus = 0;
function cek(nama, fn) {
  try { fn(); lulus++; console.log(`  \u2705 ${nama}`); }
  catch (e) { console.error(`  \u274c ${nama}\n     ${e.message}`); process.exitCode = 1; }
}

console.log('test/resetlimit-grup.js');
const { participantPhones } = require('../engine/jid');

cek('nama owner nggak nimpa nama user (pushName dulu, baru owner_name)', () => {
  const eng = fs.readFileSync(path.join(__dirname, '..', 'engine/whatsappEngine.js'), 'utf8');
  const m   = eng.match(/if \(ctx\.isOwner\) \{[\s\S]{0,600}?const baseName = \(([^)]+)\)/);
  assert.ok(m, "blok auto-register owner nggak ketemu");
  assert.ok(m[1].indexOf('ctx.pushName') < m[1].indexOf('owner_name'),
    `urutannya kebalik: ${m[1]} — tiap owner kirim command namanya balik ke owner_name`);
});

cek('di grup, UPDATE-nya dibatasi daftar anggota', () => {
  assert.ok(/ctx\.isGroup/.test(blok), 'nggak cek ctx.isGroup — di grup tetap kena semua user se-bot');
  assert.ok(/anggota\.length/.test(blok), 'nggak ada cabang buat reset per-anggota');
  assert.ok(/IN \(\$\{ph\}\)/.test(blok), 'UPDATE-nya nggak dibatasi daftar anggota');
});

cek('cabang "semua user se-bot" masih ada buat chat pribadi', () => {
  assert.ok(/Chat pribadi/.test(blok), 'cabang PC ilang — owner di PC nggak bisa reset massal');
  assert.ok(/UPDATE rpg_members SET lim = \? WHERE bot_id = \?'/.test(blok),
    'UPDATE reset-semua buat chat pribadi ilang');
});

cek('gagal baca member grup -> nggak ngereset diam-diam', () => {
  assert.ok(/Nggak bisa baca daftar member grup/.test(blok),
    'kalau getMetadata gagal, langsung reset se-bot tanpa bilang apa-apa');
});

cek('participantPhones: {id LID + phoneNumber} -> nomor', () => {
  const out = participantPhones([{ id: '151515151515151@lid', phoneNumber: '628123456789' }]);
  assert.deepStrictEqual(out, ['628123456789@s.whatsapp.net']);
});

cek('participantPhones: LID tanpa pemetaan dibuang, bukan ditebak', () => {
  const out = participantPhones([{ id: '999999999999@lid' }]);
  assert.deepStrictEqual(out, []);
});

cek('participantPhones: buang duplikat', () => {
  const out = participantPhones([
    { id: '628111@s.whatsapp.net' }, { id: '628111@s.whatsapp.net' },
  ]);
  assert.deepStrictEqual(out, ['628111@s.whatsapp.net']);
});

console.log(`\n${lulus} lulus${process.exitCode ? ', ADA GAGAL' : ''}`);
