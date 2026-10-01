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

// 1. Nggak ada command yang kepotong: yang tampil + alias = SELURUH registry.
const { DESKRIPSI, ALIAS } = require('../config/commandInfo');
const nama = d.commands.map((c) => c.nama);
const aliasSemua = new Set(Object.values(ALIAS).flat());
cek('yang tampil + alias = ALL_COMMANDS',
  nama.length + aliasSemua.size === info.ALL_COMMANDS.length,
  `${nama.length} + ${aliasSemua.size} vs ${info.ALL_COMMANDS.length}`);
cek('total = jumlah yang tampil', d.total === nama.length, `${d.total} vs ${nama.length}`);
const kurang = info.ALL_COMMANDS.filter((c) => !nama.includes(c) && !aliasSemua.has(c));
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

// 4. Filter kategori.
const kat = info.CAT_KEYS[0];
const perKat = panggil({ kategori: kat });
cek(`filter kategori=${kat}`, perKat.commands.length > 0 && perKat.commands.every((c) => c.kategori === kat));

// 5. Prefix siap pakai.
cek('prefix pakai titik', d.commands.every((c) => c.prefix === '.' + c.nama));

// 6. DESKRIPSI + ALIAS (config/commandInfo.js).
const tanpaDesk = d.commands.filter((c) => !DESKRIPSI[c.nama]);
cek('tiap command punya deskripsi', tanpaDesk.length === 0, tanpaDesk.map((c) => c.nama).join(' '));
const aliasNempel = d.commands.filter((c) => (c.alias || []).length);
cek('ada command yang punya alias', aliasNempel.length > 0, `${aliasNempel.length} command`);
// alias harus nunjuk ke command yang ADA, dan nggak boleh tampil jadi baris sendiri
const namaTampil = new Set(nama);
const aliasLiar = [...new Set(Object.values(ALIAS).flat())].filter((a) => !info.ALL_COMMANDS.includes(a));
cek('alias semuanya command beneran', aliasLiar.length === 0, aliasLiar.join(' '));
cek('alias nggak jadi baris sendiri', namaTampil.size + aliasNempel.reduce((n, c) => n + c.alias.length, 0) >= d.totalSemua - 1);
cek('yang tampil cuma primer', d.commands.every((c) => !Object.values(ALIAS).flat().includes(c.nama)));

console.log(gagal ? `\n=== GAGAL: ${gagal} masalah ===` : '\n=== SEMUA CEK LULUS ===');
process.exit(gagal ? 1 : 0);
