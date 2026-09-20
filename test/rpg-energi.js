const assert = require('node:assert');
const { _uji: u } = require('../plugins/03-fun-rpg.js');

// ── Energi: regen 1 poin / 2 menit, plafon 100 ───────────────────────────────
const MENIT = 60 * 1000;
const now   = Date.now();
const jamMundur = (menit) => new Date(now - menit * MENIT);

assert.strictEqual(u.energiSekarang({ energi: 50 }), 100,
  'user lama (last_energi kosong) → full, jangan dihukum');
assert.strictEqual(u.energiSekarang({ energi: 50, last_energi: new Date(now) }), 50,
  'tanpa waktu lewat, energi ga nambah');
assert.strictEqual(u.energiSekarang({ energi: 50, last_energi: jamMundur(2) }), 51,
  '2 menit lewat = +1 poin');
assert.strictEqual(u.energiSekarang({ energi: 50, last_energi: jamMundur(3) }), 51,
  'sisa 1 menit (belum genap interval) → tetap +1, bukan +1.5');
assert.strictEqual(u.energiSekarang({ energi: 50, last_energi: jamMundur(999) }), 100,
  'regen mentok di ENERGI_MAKS, bukan lewat');
assert.strictEqual(u.energiSekarang({ energi: 0, last_energi: new Date(now) }), 0,
  'energi 0 tetap 0');
assert.strictEqual(u.energiSekarang({ energi: null, last_energi: new Date(now) }), 0,
  'kolom energi NULL → 0, bukan NaN');

// ── Pesan kurang energi nyebut angka & lama nunggu ───────────────────────────
const pesan = u.pesanEnergiKurang(5, 25);
assert.ok(pesan.includes('5/100'), 'pesan harus tampilkan energi sekarang');
assert.ok(pesan.includes('25'), 'pesan harus tampilkan biaya');
assert.ok(pesan.includes(String((25 - 5) * u.ENERGI_REGEN_MENIT)),
  'pesan harus sebut menit tunggu = kurang × interval regen');

// ── Gear: level + durability ────────────────────────────────────────────────
assert.strictEqual(u.gearLevel({}, 'weapon'), 0, 'tanpa gear, level 0');
assert.strictEqual(u.gearDur({}, 'weapon'), 0, 'tanpa gear, durability 0');
assert.strictEqual(u.gearAktif({}, 'weapon'), false, 'tanpa gear, ga aktif');

let data = u.bacaJson({});
u.pasangGear(data, 'weapon', 2, u.DUR_MAKS);
let m = { hewan_json: JSON.stringify(data) };
assert.strictEqual(u.gearLevel(m, 'weapon'), 2, 'pasang gear nulis level');
assert.strictEqual(u.gearDur(m, 'weapon'), 100, 'gear baru durability penuh');
assert.ok(u.gearAktif(m, 'weapon'), 'gear baru harus aktif');
assert.strictEqual(u.gearDipakai(m, 'weapon'), 2, 'gear aktif → levelnya dipakai di battle');
assert.strictEqual(u.gearDipakai(m, 'armor'), 0, 'slot kosong → 0, ga nyasar ke slot lain');

// durability 0 = rusak, bonusnya ilang
data = u.bacaJson(m);
u.kurangiDur(data, 'weapon', 999);
m = { hewan_json: JSON.stringify(data) };
assert.strictEqual(u.gearDur(m, 'weapon'), 0, 'durability ga boleh negatif');
assert.strictEqual(u.gearAktif(m, 'weapon'), false, 'gear rusak ga dihitung di battle');
assert.strictEqual(u.gearDipakai(m, 'weapon'), 0, 'gear rusak → ATK dasar, bukan bonus Lv.2');
assert.strictEqual(u.gearLevel(m, 'weapon'), 2, 'level gear tetap kesimpan walau rusak');

// ── Teks gear buat profil ───────────────────────────────────────────────────
assert.strictEqual(u.statGear({}, 'weapon'), 'Belum punya', 'tanpa gear');
assert.strictEqual(u.statGear(m, 'weapon'), 'Lv.2 — 💥 RUSAK', 'gear rusak keliatan di profil');
assert.strictEqual(u.statGear({ hewan_json: JSON.stringify({ gear: { armor: { lv: 1, dur: 40 } } }) }, 'armor'),
  'Lv.1 (dur 40%)', 'gear aktif tampil level + dur');

// ── Biaya repair: proporsional durability, gratis kalau udah penuh ──────────
const pedangKayu = u.STORE_ITEMS.find(i => i.type === 'weapon' && i.lv === 1).price;
assert.strictEqual(u.biayaRepair('weapon', 1), Math.ceil(pedangKayu * 0.10),
  'biaya repair = 10% harga item di level itu');
assert.ok(u.biayaRepair('weapon', 4) > u.biayaRepair('weapon', 1),
  'gear tier tinggi lebih mahal di-repair');
assert.strictEqual(u.biayaRepair('weapon', 99), 0, 'level gear tak dikenal → 0, jangan NaN');

// ── Inventory: item & hasil buruan nyampur di 1 kolom tanpa saling hapus ────
const inv = u.bacaItem({ hewan_json: JSON.stringify({ item: { '3': 2 }, banteng: 5 }) });
inv['1'] = (inv['1'] || 0) + 1;
const campur = { hewan_json: JSON.stringify({ item: inv, banteng: 5 }) };
assert.strictEqual(u.bacaItem(campur)['3'], 2, 'item lama ga boleh kehapus');
assert.strictEqual(u.bacaItem(campur)['1'], 1, 'item baru kesimpen');
assert.strictEqual(u.bacaJson(campur).banteng, 5, 'hasil buruan ga boleh kehapus pas nulis item');
assert.strictEqual(u.bacaJson({ hewan_json: JSON.stringify({ item: inv }) }).banteng, undefined,
  'nyampur gear & item ga bikin key aneh');

assert.deepStrictEqual(u.bacaJson({ hewan_json: 'bukan json' }), {}, 'json rusak → {}, jangan crash');
assert.deepStrictEqual(u.bacaJson({ hewan_json: null }), {}, 'kolom null → {}');
assert.deepStrictEqual(u.bacaJson({}), {}, 'kolom ga ada → {}');
assert.deepStrictEqual(u.bacaJson({ hewan_json: '[1,2,3]' }), {}, 'array → {}, bukan array bocor');

// ── Pesan yang dibaca user ga boleh ada backslash literal (bug escape ganda) ─
assert.ok(!u.pesanEnergiKurang(5, 25).includes('\\'), 'pesan energi bocor backslash');
assert.ok(u.pesanEnergiKurang(5, 25).includes('\n'), 'pesan energi harus pakai newline asli');
assert.strictEqual(u.statGear({ hewan_json: JSON.stringify({ gear: { weapon: { lv: 2, dur: 60 } } }) }, 'weapon'),
  'Lv.2 (dur 60%)', 'statGear rakit kalimat tanpa backslash');

console.log('rpg-energi: 0 FAIL');