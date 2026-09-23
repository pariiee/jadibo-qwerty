'use strict';

/**
 * Cek cepat aturan slot. Jalankan: node scripts/check-plan.js
 *
 * Inti aturan: akun gratis TIDAK dapat slot. Slot cuma dari Trial atau paket
 * berbayar yang masih berlaku. Kalau file ini gagal, jangan deploy.
 */
const assert = require('assert');
const { slotsOf, roleOf, TRIAL, kuotaBot } = require('../config/plan');

const besok = new Date(Date.now() + 86400000);
const kemarin = new Date(Date.now() - 86400000);
const plans = require('../config/plan').DEFAULT_PLANS;

const kasus = [
  ['akun baru tanpa langganan',      { role: 'user', plan: 'user', plan_expired_at: null }, 0],
  ['trial masih jalan',              { role: 'user', plan: 'trial', plan_expired_at: besok }, 1],
  ['trial sudah lewat',              { role: 'user', plan: 'trial', plan_expired_at: kemarin, plan_slots: 1 }, 0],
  ['paket premium aktif',            { role: 'user', plan: 'premium', plan_expired_at: besok }, 1],
  ['premium kadaluarsa',             { role: 'user', plan: 'premium', plan_expired_at: kemarin }, 0],
  ['admin selalu penuh',             { role: 'kawula', plan: 'user', plan_expired_at: null }, 999],
  ['jatah khusus admin menang',      { role: 'user', plan: 'basic', plan_expired_at: besok, plan_slots: 7 }, 7],
  ['jatah khusus 0 = dikunci',       { role: 'user', plan: 'premium', plan_expired_at: besok, plan_slots: 0 }, 0],
];

for (const [nama, user, harap] of kasus) {
  const dapat = slotsOf(user, plans);
  assert.strictEqual(dapat, harap, `${nama}: harap ${harap}, dapat ${dapat}`);
  console.log(`  ok  ${nama} → ${dapat}`);
}

// Role efektif ikut langganan, bukan kolom terpisah.
assert.strictEqual(roleOf({ role: 'user', plan: 'premium', plan_expired_at: besok }), 'premium');
assert.strictEqual(roleOf({ role: 'user', plan: 'premium', plan_expired_at: kemarin }), 'user');
assert.strictEqual(roleOf({ role: 'kawula', plan: 'user', plan_expired_at: null }), 'kawula');
console.log('  ok  role efektif');

// Paket Gratis wajib 0 slot — ini janji ke user, bukan angka bebas.
assert.strictEqual(plans.find((p) => p.id === 'user').slots, 0);
console.log('  ok  paket Gratis = 0 slot');

// Kuota pesan bot: paket pemilik yang menetapkan, kolom bot cuma bisa menurunkan.
const k = (pemilik, botLimit) => kuotaBot(pemilik, { daily_limit: botLimit }, plans);
assert.strictEqual(k({ role: 'user', plan: 'ultra', plan_expired_at: besok }, 20), 20, 'kolom bot lebih kecil → pakai kolom');
assert.strictEqual(k({ role: 'user', plan: 'ultra', plan_expired_at: besok }, 5000), 100, 'kolom bot lebih besar → tetap dibatasi paket');
assert.strictEqual(k({ role: 'user', plan: 'ultra', plan_expired_at: besok }, null), 100, 'kolom kosong → pakai paket');
assert.strictEqual(k({ role: 'user', plan: 'ultra', plan_expired_at: kemarin }, 100), 0, 'langganan habis → kuota 0');
assert.strictEqual(k({ role: 'kawula', plan: 'user', plan_expired_at: null }, null), 99999, 'admin tanpa batas');
console.log('  ok  kuota pesan bot');

// Paket dibedakan katalog fitur + durasi + kuota, BUKAN jumlah slot.
const berbayar = plans.filter((p) => p.price > 0);
assert.ok(berbayar.every((p) => p.slots === 1), 'semua paket berbayar wajib 1 slot');
assert.deepStrictEqual(berbayar.map((p) => p.days), [30, 30, 30], 'masa aktif 30 hari (per bulan)');
assert.deepStrictEqual(berbayar.map((p) => p.max_fitur), [100, 250, 400], 'jumlah fitur naik seiring harga');
assert.deepStrictEqual(berbayar.map((p) => p.receive_limit), [10000, 50000, 100000], 'received limit naik seiring harga');
assert.deepStrictEqual(berbayar.map((p) => p.owner_max), [1, 3, 5], 'owner number naik seiring harga');
assert.ok(berbayar.every((p) => p.daily_limit > 0 && p.days > 0), 'tiap paket punya masa aktif + kuota');
console.log('  ok  paket: 1 slot, yang beda fitur/durasi/kuota');

// Gerbang fitur: akun gratis tidak dapat apa-apa, paket kecil dapat lebih
// sedikit dari paket besar, dan admin tidak dibatasi (null = semua).
const { fiturBot, receiveLimit, ownerMax } = require('../config/plan');
const gratis = fiturBot({ role: 'user', plan: 'user', plan_expired_at: null }, plans);
assert.ok(Array.isArray(gratis) && gratis.includes('menu') && !gratis.includes('sticker'),
  'akun gratis: perintah inti tetap jalan, fitur berbayar tidak');
const b = fiturBot({ role: 'user', plan: 'basic', plan_expired_at: besok }, plans);
const u = fiturBot({ role: 'user', plan: 'ultra', plan_expired_at: besok }, plans);
assert.ok(b.includes('menu'), 'perintah inti selalu terbuka');
assert.ok(b.length < u.length, `paket naik harus dapat fitur lebih banyak (${b.length} < ${u.length})`);
assert.ok(u.length <= 426, `ultra jangan lewat 426 fitur (dapat ${u.length})`);
assert.strictEqual(fiturBot({ role: 'kawula' }, plans), null, 'admin tanpa batas fitur');
const habis = fiturBot({ role: 'user', plan: 'basic', plan_expired_at: kemarin }, plans);
assert.ok(habis.includes('menu') && !habis.includes('sticker'), 'langganan habis → fitur berbayar ditutup');
const tr = fiturBot({ role: 'user', plan: 'trial', plan_expired_at: besok }, plans);
assert.ok(tr.length > gratis.length, 'trial dapat lebih dari akun gratis');
console.log(`  ok  gerbang fitur (gratis ${gratis.length} / trial ${tr.length} / basic ${b.length} / ultra ${u.length})`);

// Received limit & owner number ikut masa aktif.
assert.strictEqual(receiveLimit({ role: 'user', plan: 'ultra', plan_expired_at: besok }, plans), 100000);
assert.strictEqual(receiveLimit({ role: 'user', plan: 'ultra', plan_expired_at: kemarin }, plans), 0);
assert.strictEqual(receiveLimit({ role: 'kawula' }, plans), 0, 'admin tidak dibatasi (0 = tanpa batas)');
assert.strictEqual(ownerMax({ role: 'user', plan: 'ultra', plan_expired_at: besok }, plans), 5);
assert.strictEqual(ownerMax({ role: 'user', plan: 'ultra', plan_expired_at: kemarin }, plans), 0);
console.log('  ok  received limit + owner number');

// Fitur yang dikirim worker harus yang benar-benar ada sebagai command.
const { CATS } = require('../plugins/01-info');
const dikenal = new Set(Object.values(CATS).flat());
for (const c of u) assert.ok(dikenal.has(c), `fitur tidak dikenal di CATS: ${c}`);
// Kategori yang tidak masuk KATEGORI_URUT = fiturnya tidak pernah masuk paket
// mana pun. Cek ini yang menangkap kategori baru yang lupa didaftarkan.
const { KATEGORI_URUT } = require('../config/plan');
assert.deepStrictEqual(Object.keys(CATS).filter((k) => !KATEGORI_URUT.includes(k)), [],
  'ada kategori CATS yang belum masuk KATEGORI_URUT');
console.log('  ok  semua fitur paket ada di CATS + kategori lengkap');

console.log('\nSemua aturan slot lolos.');
