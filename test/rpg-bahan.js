// Tambang/kebon/tebang, `.craft`, `.skill`, penjara & kejahatan.
// Jalur duit + state baru → wajib ada yang ngecek, biar nggak diam-diam rusak.
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const {
  bacaBahan, bacaSkill, sisaPenjara, sisaCdJson, pilihBobot, biayaSkill,
  RESEP, KEJAHATAN, SPOT_BAHAN, STORE_ITEMS, SKILL_MAKS,
  KEY_BAHAN, KEY_SKILL, KEY_JAIL, KEY_CD,
} = require('../plugins/03-fun-rpg.js')._uji;

// ── state kosong: semua default aman, nggak ada yang undefined ───────────────
const kosong = { hewan_json: null };
assert.deepStrictEqual(bacaBahan(kosong), {}, 'bahan kosong harus {}');
assert.deepStrictEqual(bacaSkill(kosong), { atk: 0, def: 0, spd: 0, hp: 0 });
assert.strictEqual(sisaPenjara(kosong), 0, 'default harus bebas');
assert.strictEqual(sisaCdJson(kosong, 'tambang'), 0, 'default cooldown habis');

// hewan_json rusak / array / angka → tetap aman, nggak lempar
for (const rusak of [{ hewan_json: 'bukan json' }, { hewan_json: '[]' }, { hewan_json: '[1,2]' }]) {
  assert.deepStrictEqual(bacaBahan(rusak), {});
  assert.deepStrictEqual(bacaSkill(rusak), { atk: 0, def: 0, spd: 0, hp: 0 });
}

// ── baca state yang ada ──────────────────────────────────────────────────────
const isi = { hewan_json: JSON.stringify({ [KEY_BAHAN]: { Besi: 7 }, [KEY_SKILL]: { atk: 3, def: 2 } }) };
assert.deepStrictEqual(bacaBahan(isi), { Besi: 7 });
assert.deepStrictEqual(bacaSkill(isi), { atk: 3, def: 2, spd: 0, hp: 0 }, 'skill yang belum dibeli = 0');

// skill ngawur (string/negatif) dijepit ke angka wajar
const ngawur = { hewan_json: JSON.stringify({ [KEY_SKILL]: { atk: 'x', def: -9, spd: 4.7 } }) };
assert.deepStrictEqual(bacaSkill(ngawur), { atk: 0, def: 0, spd: 4.7, hp: 0 });

// ── penjara: nol = bebas, masa depan = masih dipenjara ───────────────────────
const sekarang = Date.now();
assert.strictEqual(sisaPenjara({ hewan_json: JSON.stringify({ [KEY_JAIL]: sekarang - 1000 }) }), 0);
assert.ok(sisaPenjara({ hewan_json: JSON.stringify({ [KEY_JAIL]: sekarang + 60_000 }) }) > 0);
// penjara nggak boleh bikin cooldown command lain ketularan
assert.strictEqual(sisaCdJson({ hewan_json: JSON.stringify({ [KEY_CD]: { tambang: sekarang + 60_000 } }) }, 'kebon'), 0);

// ── harga skill naik bertingkat, bukan flat ──────────────────────────────────
assert.strictEqual(biayaSkill(0), 200);
assert.strictEqual(biayaSkill(1), 400);
assert.ok(biayaSkill(SKILL_MAKS - 1) > biayaSkill(0) * 10, 'level tinggi harus jauh lebih mahal');

// ── resep: id harus ada di toko, bahannya harus bisa didapat ─────────────────
const semuaBahan = new Set(Object.values(SPOT_BAHAN).flatMap(s => s.isi.map(b => b.n)));
for (const r of RESEP) {
  assert.ok(STORE_ITEMS.some(i => i.id === r.id), `resep ${r.id} nggak ada di STORE_ITEMS`);
  for (const [n, j] of Object.entries(r.bahan)) {
    assert.ok(semuaBahan.has(n), `bahan "${n}" di resep ${r.id} nggak ada di spot manapun`);
    assert.ok(j > 0, `jumlah bahan "${n}" resep ${r.id} harus > 0`);
  }
}
// tiap spot harus punya minimal satu bahan, dan bobotnya masuk akal
for (const [kunci, s] of Object.entries(SPOT_BAHAN)) {
  assert.ok(s.isi.length > 0, `spot ${kunci} kosong`);
  assert.ok(s.biaya > 0 && s.xp > 0, `spot ${kunci} harus ada biaya energi + xp`);
  for (const b of s.isi) assert.ok(b.min >= 1 && b.max >= b.min && b.w > 0, `bahan ${b.n} di ${kunci} nggak wajar`);
}
// tiap spot harus punya case sendiri di dispatcher
const sumber = fs.readFileSync(path.join(__dirname, '..', 'plugins', '03-fun-rpg.js'), 'utf8');
/** Ambil isi `const CMD_RISIKO = new Set([ ... ]);` dari sumber. */
const blokRisiko = (kode) => {
  const m = kode.match(/CMD_RISIKO\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  return m ? m[1] : '';
};
for (const kunci of Object.keys(SPOT_BAHAN)) {
  assert.ok(new RegExp(`case '${kunci}'`).test(sumber), `case '${kunci}' nggak ada`);
}

// ── kejahatan: peluang gagal & hukuman harus di rentang wajar ────────────────
for (const [nama, k] of Object.entries(KEJAHATAN)) {
  assert.ok(k.gagal > 0 && k.gagal < 1, `${nama}: peluang gagal harus 0..1`);
  assert.ok(k.min > 0 && k.max >= k.min, `${nama}: hadiah nggak wajar`);
  assert.ok(k.hukuman > 0 && k.cooldown > 0, `${nama}: hukuman/cooldown harus > 0`);
  assert.ok(new RegExp(`case '${nama}'`).test(sumber), `case '${nama}' nggak ada`);
  // hadiah harus lebih gede dari kerja biasa, kalau nggak nggak ada yang mau nyopet
  assert.ok(k.max > 100, `${nama}: hadiah kekecilan buat risiko penjara`);
}

// ── pilihBobot: selalu balikin anggota list, bobot gede lebih sering ─────────
const tas = [{ n: 'a', w: 1 }, { n: 'b', w: 99 }];
const hitung = { a: 0, b: 0 };
for (let i = 0; i < 3000; i++) hitung[pilihBobot(tas).n]++;
assert.strictEqual(hitung.a + hitung.b, 3000);
assert.ok(hitung.b > hitung.a * 5, `bobot nggak ngefek: ${JSON.stringify(hitung)}`);
assert.strictEqual(pilihBobot([{ n: 'x', w: 0 }]).n, 'x', 'list bobot nol harus tetap balikin sesuatu');

// ── registry: command baru harus kejangkau di semua titik ───────────────────
// Kalau kelewat salah satu, command-nya ada tapi nggak kepanggil / limitnya nggak kepotong.
const BARU = ['tambang', 'kebon', 'tebang', 'bahan', 'craft', 'skill', 'penjara', 'bebaskan', 'copet', 'rampok'];
const { ALL_COMMANDS, CATS } = require('../plugins/01-info.js');
const { buildLimitedCmds } = require('../engine/limitedCmds.js');
const limited = buildLimitedCmds();
for (const c of BARU) {
  assert.ok(ALL_COMMANDS.includes(c), `${c} nggak ada di ALL_COMMANDS`);
  assert.ok(CATS.rpg.includes(c), `${c} nggak ada di CATS.rpg`);
  assert.ok(limited.has(c), `${c} nggak ada di limitedCmds`);
  assert.ok(new RegExp(`case '${c}'`).test(sumber), `case '${c}' nggak ada di 03-fun-rpg.js`);
}

// ── gerbang penjara: yang dikunci cuma yang ngasih duit/bahan ────────────────
// `.bebaskan` WAJIB lolos, kalau ikut kekunci orang nggak bisa nebus diri.
// `CMD_RISIKO` itu daftar satu-baris — cukup cek nama command-nya nggak ada di situ.
for (const bebas of ['bebaskan', 'penjara', 'money', 'atm', 'inventory', 'profil', 'bahan', 'beli', 'repair']) {
  assert.ok(!new RegExp(`'${bebas}'`).test(blokRisiko(sumber)),
    `'${bebas}' kekunci gerbang penjara — pemain nggak bisa keluar`);
}
// dan yang harus kekunci, tetap kekunci
for (const kunci of ['kerja', 'tambang', 'copet', 'maling', 'rampok']) {
  assert.ok(new RegExp(`'${kunci}'`).test(blokRisiko(sumber)), `'${kunci}' lolos gerbang penjara`);
}

// ── bersih-bersih: kolom zombie nggak boleh ditulis lagi ─────────────────────
// `koin`/`bank`/`sword`/`armor` udah di-drop dari schema; sisa satu penulisan
// = query-nya meledak "Unknown column" di produksi.
const pluginDir = path.join(__dirname, '..', 'plugins');
const SQL_KOLOM = /(?:SET|,)\s*(koin|bank|sword|armor)\s*=\s*(?:\?|0|\d)/i;
const zombie = [];
for (const f of fs.readdirSync(pluginDir).filter(x => x.endsWith('.js'))) {
  fs.readFileSync(path.join(pluginDir, f), 'utf8').split(/\r?\n/).forEach((l, i) => {
    // cuma nangkap penulisan KOLOM DB (SET x = / , x =), bukan variabel biasa
    if (SQL_KOLOM.test(l) && !/bank_money|topkoin/.test(l)) {
      zombie.push(`${f}:${i + 1} ${l.trim()}`);
    }
  });
}
assert.deepStrictEqual(zombie, [], 'masih nulis kolom zombie: ' + JSON.stringify(zombie));

console.log('rpg-bahan: 0 FAIL');
