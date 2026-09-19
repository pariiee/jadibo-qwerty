'use strict';
// `.getpp 6285876902820` — target dari NOMOR HP, bukan cuma tag/reply.
//
// Dua hal yang gampang rusak: nomor di-resolve jadi LID (gagal buat non-member),
// dan mention dipasang ke JID non-member (WA nolak / nampilin sampah).

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const P2 = fs.readFileSync(path.join(__dirname, '..', 'plugins', '02-group.js'), 'utf8');

let gagal = 0;
function tes(nama, fn) {
  try { fn(); console.log(`  ok   ${nama}`); }
  catch (e) { gagal++; console.log(`  FAIL ${nama}\n       ${e.message}`); }
}

console.log('getpp lewat nomor');

tes('nomor HP diterima sebagai target (setelah tag & reply)', () => {
  assert(P2.includes('const nomorArg = args.find(a =>'), 'deteksi nomor ilang');
  assert(/mentioned\[0\] \|\| ci\.participant\s*\r?\n?\s*\|\| \(nomorArg/.test(P2), 'nomor nggak jadi fallback target');
});

tes('nomor dibentuk jadi JID @s.whatsapp.net, tanda + dibuang', () => {
  assert(/replace\(\/\^\\\+\//.test(P2), 'tanda + nggak dibuang');
  assert(/'@s\.whatsapp\.net' : null\)/.test(P2), 'JID nomor nggak dibentuk');
});

tes('target dari nomor TIDAK di-resolve LID', () => {
  assert(/if \(!dariNomor\) target = await lidToPnAsync/.test(P2), 'nomor masih lewat lidToPnAsync');
});

tes('nomor tidak diubah pakai data participants grup', () => {
  assert(/if \(!dariNomor && participant\?\.phoneNumber\)/.test(P2), 'phoneNum masih ditimpa dari metadata');
});

tes('non-member nggak di-mention (nomor ditulis polos)', () => {
  assert(/dariNomor \? `📸 Foto profil \$\{tagNum\}`/.test(P2), 'caption masih @mention');
  assert(/\.\.\.\(dariNomor \? \{\} : \{ mentions: \[target\] \}\)/.test(P2), 'mentions masih dipasang');
});

tes('pesan bantuan nyebut contoh nomor', () => {
  assert(/6285876902820/.test(P2), 'contoh nomor nggak ada di pesan bantuan');
});

console.log(gagal ? `\n${gagal} FAIL` : '\n0 FAIL');
process.exit(gagal ? 1 : 0);
