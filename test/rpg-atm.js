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

// `.money` ada di semua titik registry — kalau salah satu kelewat, command-nya
// ada tapi nggak kepanggil / nggak kepotong limit.
const { ALL_COMMANDS, CATS } = require('../plugins/01-info.js');
const { buildLimitedCmds } = require('../engine/limitedCmds.js');
assert.ok(ALL_COMMANDS.includes('money'), 'money nggak ada di ALL_COMMANDS');
assert.ok(CATS.rpg.includes('money'), 'money nggak ada di CATS.rpg');
assert.ok(buildLimitedCmds().has('money'), 'money nggak ada di limitedCmds');

// `.atm` polos harus tetap 'info' (handler yang nanya nominal, bukan saldo)
assert.deepStrictEqual(bacaAtm([]), { aksi: 'info' });

// Duit ditulis gaya Indonesia: pemisah ribuan titik ("1.000"), bukan "1000",
// dan tanpa embel-embel satuan ("1.000 koin") — referensi pakai Intl.NumberFormat.
const { formatNum } = require('../plugins/03-fun-rpg.js')._uji;
assert.strictEqual(formatNum(1000), '1.000');
assert.strictEqual(formatNum(1234567), '1.234.567');
assert.strictEqual(formatNum(999), '999');
assert.strictEqual(formatNum(0), '0');

// Kata "koin" nggak boleh muncul lagi di PESAN RPG (label uang = "Money").
// Komentar & nama variabel lama (`koin = 0`) nggak dihitung — yang penting
// nggak ada string yang dikirim ke user.
const fs = require('node:fs');
const sumber = fs.readFileSync(require('node:path').join(__dirname, '..', 'plugins', '03-fun-rpg.js'), 'utf8');
const bocor = sumber.split(/\r?\n/)
  .map((l, i) => [i + 1, l.trim()])
  .filter(([, l]) => /\bkoin\b/i.test(l)
    && !l.startsWith('//')
    && !/\bkoin(Get|Dapat)\b/.test(l)     // nama variabel
    && !/koin:\s*\[/.test(l)              // loot table gacha
    && !/topkoin/.test(l)                 // nama command
    && !/^\s*koin\s*=/.test(l));          // variabel lokal
assert.deepStrictEqual(bocor, [], 'masih ada "koin" di pesan: ' + JSON.stringify(bocor));

console.log('rpg-atm: 0 FAIL');
