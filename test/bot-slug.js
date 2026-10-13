'use strict';
/**
 * test/bot-slug.js — kunci alamat publik bot.
 *
 * Kenapa ada: `/bot/4` gampang ditebak bot auto-scanner, jadi URL halaman
 * memakai slug acak dari `bots.public_id`. Yang gampang rusak diam-diam:
 *
 *   1. Nomor lama berhenti jalan → bookmark & riwayat lama mati. Ini yang
 *      paling gampang kelewat, karena yang diuji manual selalu slug baru.
 *   2. Slug balik jadi angka → tujuan keamanannya hilang tanpa ada yang sadar.
 *   3. Rute yang tidak di-resolve → "kok sebagian halaman masih /bot/4".
 *   4. `app.param('id')` kena rute USER juga → id user ditafsirkan id bot.
 *
 * Tes ini statis (baca berkas, panggil fungsi murni) — nol DB, jadi cepat.
 * Jalankan: node test/bot-slug.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const baca = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const botSlug = require('../config/botSlug');

console.log('=== 1. Bentuk slug ===');
for (let i = 0; i < 200; i++) {
  const s = botSlug.slugBaru();
  assert.strictEqual(s.length, botSlug.PANJANG, `panjang slug salah: ${s}`);
  assert.match(s, /^[a-z0-9]+$/, `slug harus huruf kecil+angka: ${s}`);
  // 0/1 dan vokal sengaja dibuang: enak disalin, tidak terbaca sebagai kata.
  assert.ok(!/[01aeiou]/.test(s), `slug memuat huruf terlarang: ${s}`);
}
console.log(`✅ ${botSlug.PANJANG} huruf, alfabet ${botSlug.HURUF.length} karakter, nol huruf terlarang`);

console.log('\n=== 2. Unik (1000 pembuatan) ===');
const set = new Set();
for (let i = 0; i < 1000; i++) set.add(botSlug.slugBaru());
assert.ok(set.size > 990, `terlalu banyak tabrakan: ${1000 - set.size} dari 1000`);
assert.ok(![...set].every((s) => s[0] === [...set][0][0]), 'slug kelihatan tidak acak');
console.log(`✅ ${set.size}/1000 unik, tidak berurutan`);

console.log('\n=== 3. Nomor lama tetap diterima (tanpa DB) ===');
// resolveBotId() untuk input angka tidak menyentuh DB — inilah yang menjaga
// bookmark lama tetap hidup, jadi harus diuji terpisah.
const tanpaDb = async () => {
  for (const [masuk, keluar] of [['4', 4], ['1', 1], ['999', 999]]) {
    assert.strictEqual(await botSlug.resolveBotId(masuk), keluar,
      `resolveBotId(${masuk}) harus ${keluar}`);
  }
  // Input yang bukan angka & bukan bentuk slug → null, bukan lempar.
  for (const jelek of ['', '   ', '!!', 'a b', '../../etc/passwd', 'MHSGSA']) {
    const h = await botSlug.resolveBotId(jelek);
    assert.ok(h === null || Number.isFinite(h), `resolveBotId(${JSON.stringify(jelek)}) aneh: ${h}`);
  }
};
tanpaDb().then(() => {
  console.log('✅ nomor lama diteruskan apa adanya; input aneh ditolak lembut');

  console.log('\n=== 4. Kolom public_id ada di skema & migrasi ===');
  assert.match(baca('scripts/sync-schema.js'), /\['public_id',\s*"VARCHAR\(32\)/,
    'kolom bots.public_id tidak ada di sync-schema.js');
  assert.match(baca('scripts/sync-schema.js'), /uq_bots_public_id/,
    'UNIQUE bots.public_id tidak dipasang — tabrakan slug akan lolos');
  console.log('✅ kolom + UNIQUE terpasang lewat migrasi');

  console.log('\n=== 5. API bot di-resolve, rute user TIDAK ===');
  const server = baca('server.js');
  assert.ok(/app\.param\('id'/.test(server), "app.param('id') hilang — /api/bots/<slug> jadi 404");
  assert.ok(/\\\/api\\\/\(admin\\\/\)\?bots\\\//.test(server) || /api\\\/\(admin/.test(server) || /jalurBot/.test(server),
    'app.param tidak membatasi diri ke jalur /api/bots');
  assert.ok(/req\.params\.id = String\(idAngka\)/.test(server),
    'app.param tidak menulis balik id angka ke req.params.id');
  console.log('✅ app.param membatasi ke /api/bots & /api/admin/bots, menulis balik id angka');

  console.log('\n=== 6. UI memakai slug, bukan id mentah ===');
  for (const f of ['public/js/admin.js', 'public/js/config.js', 'public/js/dashboard.js', 'public/js/bot-stats.js']) {
    const t = baca(f);
    // `/bot/' + x.id` / `/config/' + x.id` = link lama yang bocorin nomor.
    const bocor = t.match(/\/(bot|config)\/'\s*\+\s*([A-Za-z_.]+)\.id\b/g);
    assert.ok(!bocor, `${f} masih menulis link dari .id: ${bocor}`);
  }
  assert.ok(/window\.botHref/.test(baca('public/js/head.js')), 'helper botHref hilang dari head.js');
  console.log('✅ nol link /bot/<angka> atau /config/<angka> di UI');

  console.log('\n=== 7. Slug ikut terkirim ke UI ===');
  const ctrl = baca('controllers/botController.js');
  assert.ok(/denganSlug/.test(ctrl), 'publicBot/denganSlug tidak dipakai — UI tidak akan dapat slug');
  assert.ok(/res\.json\(\{[\s\S]{0,200}slug/.test(ctrl) || /slug:/.test(ctrl),
    'createBot tidak mengembalikan slug');
  assert.ok(/pastikanSlug\(botId\)[\s\S]{0,120}dbPath|pastikanSlug\(botId\)/.test(ctrl),
    'createBot tidak membuat slug untuk bot baru');
  console.log('✅ list/detail/create semuanya membawa slug');

  console.log('\nsemua ok — alamat publik bot terkunci');
}).catch((e) => { console.error('❌', e.message); process.exit(1); });
