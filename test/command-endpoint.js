'use strict';
/**
 * test/command-endpoint.js
 * Cek /api/command nggak ngilangin command & nggak salah map kategori.
 * Nggak nyambung DB dan nggak listen — handler-nya dipanggil pakai res palsu.
 *
 *   node test/command-endpoint.js
 */
const info = require('../plugins/01-info');
const { daftarCommand } = require('../controllers/commandController');

let gagal = 0;
const cek = (nama, syarat, info2 = '') => {
  if (syarat) console.log(`✅ ${nama}`);
  else { gagal++; console.log(`❌ ${nama}${info2 ? ' — ' + info2 : ''}`); }
};

function panggil(query = {}) {
  let keluar = null;
  const res = {
    json: (d) => { keluar = d; },
    status: (k) => { keluar = { httpError: k }; return res; },
  };
  daftarCommand({ query }, res);
  return keluar;
}

const d = panggil();

// 1. Semua command ada, nggak ada yang kepotong.
cek('total = ALL_COMMANDS', d.total === info.ALL_COMMANDS.length, `${d.total} vs ${info.ALL_COMMANDS.length}`);

const nama = d.commands.map((c) => c.nama);
const kurang = info.ALL_COMMANDS.filter((c) => !nama.includes(c));
cek('nggak ada command hilang', kurang.length === 0, kurang.join(' '));
cek('nggak ada duplikat', new Set(nama).size === nama.length);

// 2. Kategori tiap command cocok sama CATS.
const salah = d.commands.filter((c) => {
  const kat = Object.keys(info.CATS).filter((k) => info.CATS[k].includes(c.nama));
  return kat.length && !kat.includes(c.kategori);
});
cek('kategori sesuai CATS', salah.length === 0, salah.map((c) => c.nama).join(' '));

// 3. Command di luar CATS tetap kebawa (kategori 'lain'), bukan dibuang diam-diam.
const lain = d.commands.filter((c) => c.kategori === 'lain');
cek('command tanpa kategori tetap ada', lain.length > 0, `${lain.length} command`);
cek("label 'lain' rapi", lain.every((c) => c.label === 'LAIN'));

// 4. Filter.
const kat = info.CAT_KEYS[0];
const perKat = panggil({ kategori: kat });
cek(`filter kategori=${kat}`, perKat.commands.length > 0 && perKat.commands.every((c) => c.kategori === kat));

const limitOnly = panggil({ limit: '1' });
cek('filter limit', limitOnly.commands.length > 0 && limitOnly.commands.every((c) => c.limit),
  `${limitOnly.commands.length} dari ${d.totalLimit}`);

// 5. Prefix siap pakai.
cek('prefix pakai titik', d.commands.every((c) => c.prefix === '.' + c.nama));

console.log(gagal ? `\n=== GAGAL: ${gagal} masalah ===` : '\n=== SEMUA CEK LULUS ===');
process.exit(gagal ? 1 : 0);
