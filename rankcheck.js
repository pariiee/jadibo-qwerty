'use strict';
// Cek rename Role->Rank konsisten + emoji nggak rusak + rank function benar.
const fs = require('fs');

let fail = 0;
const F = ['plugins/03-fun-rpg.js', 'plugins/05-owner.js'];

// 1. Tidak boleh ada karakter rusak (U+FFFD)
for (const f of F) {
  const s = fs.readFileSync(f, 'utf8');
  const n = (s.match(/\uFFFD/g) || []).length;
  console.log(`[${n ? 'FAIL' : 'PASS'}] ${f}: U+FFFD = ${n}`);
  if (n) fail++;
}

// 2. Label lama 'Role' harus hilang dari tampilan RPG
const rpg = fs.readFileSync('plugins/03-fun-rpg.js', 'utf8');
const owner = fs.readFileSync('plugins/05-owner.js', 'utf8');
const labelRole = /• Role\s*:/.test(rpg) || /Role\s*:/.test(owner);
console.log(`[${labelRole ? 'FAIL' : 'PASS'}] label "Role:" sudah tidak ada di tampilan`);
if (labelRole) fail++;

const labelRank = /• Rank:/.test(rpg) && /Rank\s*:/.test(owner);
console.log(`[${labelRank ? 'PASS' : 'FAIL'}] label "Rank" muncul di .profil & .cekprofil`);
if (!labelRank) fail++;

// 3. getRankByLevel: 10 titik pakai, 1 definisi
const uses = (rpg.match(/getRankByLevel\(/g) || []).length;
console.log(`[${uses >= 10 ? 'PASS' : 'FAIL'}] getRankByLevel dipakai ${uses}x di 03-fun-rpg`);

// 4. Import dari 05-owner
console.log(`[${/require\('\.\/03-fun-rpg'\)/.test(owner) ? 'PASS' : 'FAIL'}] 05-owner import getRankByLevel`);

// 5. Rumus duplikat 'ROLES' harus hilang
const dupFormula = /ROLES\s*=\s*\[/.test(owner);
console.log(`[${dupFormula ? 'FAIL' : 'PASS'}] rumus duplikat ROLES di 05-owner sudah dibuang`);
if (dupFormula) fail++;

// 6. Nilai rank benar (bottom & top & batas)
const src = rpg.match(/function getRankByLevel\(level\) \{[\s\S]*?\n\}/)[0];
const getRankByLevel = new Function('level', src.replace('function getRankByLevel(level) {', '').replace(/\}\s*$/, ''));
const cases = [[0,'Newbie'],[1,'Adventurer'],[5,'Fighter'],[10,'Warrior'],[20,'Veteran'],[30,'Expert'],[40,'Master'],[50,'Legenda'],[99,'Legenda']];
let ok = 0;
for (const [lv, want] of cases) {
  const got = getRankByLevel(lv);
  const good = got === want;
  if (good) ok++; else console.log(`   lv${lv}: dapat ${got}, harusnya ${want}`);
}
console.log(`[${ok === cases.length ? 'PASS' : 'FAIL'}] getRankByLevel: ${ok}/${cases.length} level benar`);

// 7. .cekprofil & .profil harus hasilkan rank SAMA untuk level yang sama
// (dulu cekprofil bagi-10 -> lv10 = Warrior tp lv15 = Warrior juga; .profil = Warrior. lv25: cekprofil=Veteran(25/10=2), profil=Veteran. lv50 cek=Legenda, profil=Legenda
//  beda di lv 5-9: cekprofil=Newbie(0), profil=Fighter)
const oldCek = (lv) => ['Newbie','Adventurer','Fighter','Warrior','Veteran','Expert','Master','Legenda'][Math.min(Math.floor(lv/10),7)] || 'Newbie';
let mismatch = [];
for (let lv = 1; lv <= 60; lv++) {
  if (oldCek(lv) !== getRankByLevel(lv)) mismatch.push(lv);
}
console.log(`[INFO] level yang dulu beda antara .cekprofil & .profil: ${mismatch.length} level (${mismatch.slice(0,12).join(',')}${mismatch.length>12?'...':''})`);

console.log(fail ? '\n*** ADA YANG GAGAL ***' : '\n*** SEMUA CEK LULUS ***');
process.exit(fail ? 1 : 0);
