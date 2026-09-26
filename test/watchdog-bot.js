// Watchdog anti-zombie: "bot harusnya jalan tapi engine-nya nggak nyambung?"
//
// Ini gate buat keluhan asli: bot abis kerjaan berat tiba-tiba diem dan user
// harus spam command baru nyala. Watchdog harus NGGAK salah tuduh waktu bot
// sedang pairing / di-stop / di-restart, karena kalau salah tuduh dia malah
// mutus koneksi yang sehat.
process.env.INTERNAL_KEY = process.env.INTERNAL_KEY || 'tes';

const assert = require('assert');
const wa = require('../engine/whatsappEngine');
const { activeBots } = require('../engine/runtime');

assert.strictEqual(typeof wa.botNyangkut, 'function', 'botNyangkut harus diekspor');

// 1. is_running=1 tapi nggak ada client sama sekali -> nyangkut.
activeBots.delete(1);
assert.strictEqual(wa.botNyangkut(1), true, 'nggak ada client padahal harus jalan = nyangkut');

// 2. Ada client dan socketnya hidup -> SEHAT, jangan diganggu.
const sehat = { isConnected: true, async disconnect() {} };
activeBots.set(2, sehat);
assert.strictEqual(wa.botNyangkut(2), false, 'socket hidup jangan dituduh nyangkut');

// 3. Ada client tapi socketnya mati -> NYANGKUT (ini kasus zombie-nya).
activeBots.set(3, { isConnected: false, async disconnect() {} });
assert.strictEqual(wa.botNyangkut(3), true, 'client ada tapi socket mati = nyangkut');

// 4. Client Telegram nggak punya isConnected -> jangan dianggap nyangkut.
activeBots.set(4, { destroy: async () => {} });
assert.strictEqual(wa.botNyangkut(4), false, 'client non-WA jangan dituduh nyangkut');

// 5. Kontrol: bot lain tanpa client tetap kedetek nyangkut.
activeBots.delete(5);
assert.strictEqual(wa.botNyangkut(5), true, 'kontrol: tanpa client tetap nyangkut');

console.log('✓ watchdog: zombie kedetek, bot sehat/Telegram nggak diganggu');
