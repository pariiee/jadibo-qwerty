// Routing `.atm` / `.bank` — duit itu jalur uang, wajib ada yang ngecek.
const assert = require('node:assert');
const { bacaAtm } = require('../plugins/03-fun-rpg.js')._uji;

// setor: angka polos
assert.deepStrictEqual(bacaAtm(['100']), { aksi: 'setor', jumlah: 100 });
assert.deepStrictEqual(bacaAtm(['10']),  { aksi: 'setor', jumlah: 10 });

// setor: kata kunci + semua
assert.deepStrictEqual(bacaAtm(['simpan', '100']), { aksi: 'setor', jumlah: 100 });
assert.deepStrictEqual(bacaAtm(['setor', '50']),   { aksi: 'setor', jumlah: 50 });
assert.deepStrictEqual(bacaAtm(['taro', '50']),    { aksi: 'setor', jumlah: 50 });
assert.deepStrictEqual(bacaAtm(['all']),           { aksi: 'setor', semua: true });
assert.deepStrictEqual(bacaAtm(['semua']),         { aksi: 'setor', semua: true });
assert.deepStrictEqual(bacaAtm(['simpan', 'all']), { aksi: 'setor', semua: true });

// tarik
assert.deepStrictEqual(bacaAtm(['pull', '100']), { aksi: 'tarik', jumlah: 100 });
assert.deepStrictEqual(bacaAtm(['tarik', '100']),{ aksi: 'tarik', jumlah: 100 });
assert.deepStrictEqual(bacaAtm(['ambil', '100']),{ aksi: 'tarik', jumlah: 100 });
assert.deepStrictEqual(bacaAtm(['pull', 'all']), { aksi: 'tarik', semua: true });
assert.deepStrictEqual(bacaAtm(['pull', 'ALL']), { aksi: 'tarik', semua: true }); // case-insensitive

// info + bantuan
assert.deepStrictEqual(bacaAtm([]),        { aksi: 'info' });
assert.deepStrictEqual(bacaAtm(['saldo']), { aksi: 'info' });
assert.deepStrictEqual(bacaAtm(['info']),  { aksi: 'info' });
assert.deepStrictEqual(bacaAtm(['apaan']), { aksi: 'bantuan' });

// `pull` tanpa jumlah → NaN, handler yang nolak (bukan dianggap 0/nol)
assert.ok(Number.isNaN(bacaAtm(['pull']).jumlah));
assert.ok(Number.isNaN(bacaAtm(['simpan']).jumlah));
assert.ok(Number.isNaN(bacaAtm(['simpan', 'abc']).jumlah));

// angka nol / minus nggak boleh lolos jadi setor sah
assert.deepStrictEqual(bacaAtm(['0']), { aksi: 'setor', jumlah: 0 });
assert.deepStrictEqual(bacaAtm(['-5']), { aksi: 'bantuan' }); // minus bukan \d → bantuan

// `.atm all` di kantong kosong: jumlah = 0 → handler bilang kantong kosong, bukan error aneh
const dompetKosong = 0;
const p = bacaAtm(['all']);
assert.strictEqual(p.semua ? dompetKosong : p.jumlah, 0);

console.log('rpg-atm: 0 FAIL');
