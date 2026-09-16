/**
 * test/ttsearch.js — self-check pemilihan "3 video terbaik" di .ttsearch.
 * Pakai fungsi asli dari plugin (bukan salinan) supaya tes nggak bisa melenceng
 * dari kode yang jalan: matcher judul desc → durasi asc → peringkat API asc.
 *
 * Jalanin: node test/ttsearch.js
 */
'use strict';
const assert = require('assert');
const { pickTopVideos, keyMatch } = require('../plugins/04-tools');

// duration dari API berformat "79s" — parseInt harus tetap baca angkanya
const pool = [
  { title: 'Tidak nyambung sama sekali',         duration: '12s'  },  // 0 · matcher 0
  { title: 'McQueen kece banget ini mobilnya',   duration: '180s' },  // 1 · 1.0
  { title: 'McQueen',                            duration: '95s'  },  // 2 · 0.5
  { title: 'McQueen kece',                       duration: '230s' },  // 3 · 1.0
  { title: 'McQueen kece tapi videonya panjang', duration: '600s' },  // 4 · 1.0
];

const top = pickTopVideos(pool, 'McQueen kece', 3);
assert.strictEqual(top.length, 3, 'harus kirim 3 video');
assert.deepStrictEqual(
  top.map(v => v.title),
  ['McQueen kece banget ini mobilnya', 'McQueen kece', 'McQueen kece tapi videonya panjang'],
  'urutan: matcher penuh, lalu durasi terpendek'
);
assert.ok(!top.some(v => v.title === 'McQueen'), 'cocok 1 kata (0.5) kalah dari 2 kata');
assert.ok(!top.some(v => v.title.startsWith('Tidak nyambung')), 'nggak nyambung harus tersisih');
assert.strictEqual(pool[0].duration, '12s', 'input asli tidak boleh dimutasi');

// seri matcher + seri durasi → peringkat API yang lebih awal menang
const tie = [{ title: 'Sama', mark: 0 }, { title: 'Sama', mark: 1 }];
assert.strictEqual(pickTopVideos(tie, 'sama', 1)[0].mark, 0, 'seri total: ambil urutan API teratas');

// query kosong / semua kata ≤2 huruf → jangan bagi nol; durasi asc lalu urutan API
assert.strictEqual(pickTopVideos(pool, '', 2).length, 2, 'query kosong tetap jalan');
assert.deepStrictEqual(
  pickTopVideos(pool, 'a', 2).map(v => v.title),
  [pool[0].title, pool[2].title],
  'tanpa kata >2 huruf: durasi terpendek dulu'
);

// hasil kurang dari 3 → kirim apa adanya, jangan error
assert.strictEqual(pickTopVideos([{ title: 'McQueen a', duration: '5s' }], 'McQueen', 3).length, 1, 'hasil 1 video tetap dikirim');

// keyMatch: penentu "ada yang nyambung nggak" — kalau semua meleset, urutan
// API dipakai apa adanya (jangan diacak skor durasi).
assert.strictEqual(keyMatch('McQueen kece banget', 'McQueen kece'), true, 'judul nyambung');
assert.strictEqual(keyMatch('Ya me vetaron #duro #mcqueen', 'McQueen kece'), true, 'kata pertama nyambung');
assert.strictEqual(keyMatch('Tidak nyambung sama sekali', 'McQueen kece'), false, 'judul meleset');
assert.strictEqual(keyMatch('resep rendang', 'a'), false, 'kata kunci ≤2 huruf tidak dianggap cocok');
assert.strictEqual(keyMatch('', 'McQueen'), false, 'judul kosong');

console.log('ttsearch: PASS (3 terbaik · durasi · urutan API · query kosong · hasil <3 · keyMatch)');
