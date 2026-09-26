// Beban tinggi harus KETAHUAN, dan cuma dicatat SEKALI per kejadian. Kalau tiap
// menit ditulis, log-nya jadi 1440 baris/hari dan insiden yang penting tenggelam.
// Ambangnya bisa ditimpa lewat LOAD_BATAS, jadi tes ini jalan di laptop mana pun.
process.env.LOAD_BATAS = '10';

const assert = require('assert');
const beban = require('../config/beban');

assert.strictEqual(beban.cek(1), null, 'beban normal nggak boleh nulis apa-apa');

const naik = beban.cek(50);
assert.ok(naik && /NAIK/.test(naik), 'di atas batas harus ditulis NAIK');
assert.ok(/load=50\.0/.test(naik), 'baris log harus bawa angka bebannya');

assert.strictEqual(beban.cek(60), null, 'masih tinggi → jangan nulis lagi (spam)');

const turun = beban.cek(2);
assert.ok(turun && /turun/.test(turun), 'balik normal harus ditulis turun');

assert.strictEqual(beban.cek(3), null, 'masih normal → diam');

// Kejadian kedua tetap kecatat, bukan cuma yang pertama.
assert.ok(/NAIK/.test(beban.cek(99)), 'naik lagi harus kecatat lagi');

console.log('✓ beban: catat naik/turun sekali per kejadian, nggak spam tiap menit');
