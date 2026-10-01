'use strict';
/**
 * test/notify-billing.js
 * Notifikasi pembayaran itu jalur UANG — kalau dia error, jangan sampai
 * bikin pembayarannya gagal. Yang diuji:
 *
 *   1. nggak ada bot online  -> balikin false, TIDAK melempar
 *   2. ada bot online        -> pesan benar-benar dikirim ke owner_number, +62xxx
 *   3. nomor owner berisi koma ('a,b') -> cuma nomor PERTAMA yang dipakai
 *   4. nomor owner diisi format aneh     -> dibersihkan jadi digit saja
 *   5. kirim gagal (socket mati)         -> coba bot berikutnya, jangan melempar
 *
 * Pool & controller dipalsukan: tes ini nggak nyentuh DB maupun WhatsApp.
 */
const path = require('path');

let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`✅ ${nama}`);
  else { gagal++; console.log(`❌ ${nama}${info ? ' — ' + info : ''}`); }
};

const botPalsu = { aktif: [] };
const terkirim = [];

const poolPalsu = {
  execute: async (sql, params) => {
    if (/FROM bots/i.test(sql)) return [botPalsu.aktif];
    return [[]];
  },
};

function palsukan(modul, ekspor) {
  const j = require.resolve(path.join(__dirname, '..', modul));
  require.cache[j] = { id: j, filename: j, loaded: true, exports: ekspor };
}

palsukan('config/database.js', { pool: poolPalsu });
palsukan('controllers/botController.js', {
  activeBots: {
    get: (id) => {
      const b = botPalsu.aktif.find((x) => x.id === id);
      if (!b) return undefined;
      return b.__mati ? undefined : {
        message: { send: async (jid, isi) => { terkirim.push({ jid, isi }); } },
      };
    },
  },
});

const { kirimKeOwner } = require('../engine/notify');

(async () => {
  // 1. nggak ada bot sama sekali
  botPalsu.aktif = [];
  terkirim.length = 0;
  cek('tanpa bot -> false, nggak melempar', (await kirimKeOwner(1, 'hai')) === false);

  // 2. ada bot online
  botPalsu.aktif = [{ id: 8, owner_number: '6287778032605' }];
  terkirim.length = 0;
  cek('ada bot online -> true', (await kirimKeOwner(1, '🎉 lunas')) === true);
  cek('dikirim ke nomor owner + @s.whatsapp.net',
    terkirim[0]?.jid === '6287778032605@s.whatsapp.net', terkirim[0]?.jid);
  cek('isi pesannya yang dikirim', terkirim[0]?.isi?.text === '🎉 lunas');

  // 3. beberapa nomor dipisah koma -> ambil yang pertama
  botPalsu.aktif = [{ id: 8, owner_number: '628111111111, 628222222222' }];
  terkirim.length = 0;
  await kirimKeOwner(1, 'x');
  cek('nomor koma -> cuma yang pertama', terkirim[0]?.jid === '628111111111@s.whatsapp.net', terkirim[0]?.jid);

  // 4. format aneh (+62 812-3456-7890) -> dibersihkan
  botPalsu.aktif = [{ id: 8, owner_number: '+62 812-3456-7890' }];
  terkirim.length = 0;
  await kirimKeOwner(1, 'x');
  cek('nomor kotor -> jadi digit saja', terkirim[0]?.jid === '6281234567890@s.whatsapp.net', terkirim[0]?.jid);

  // 5. bot pertama mati -> coba bot berikutnya
  botPalsu.aktif = [
    { id: 8, owner_number: '628111111111', __mati: true },
    { id: 9, owner_number: '628999999999' },
  ];
  terkirim.length = 0;
  const ok = await kirimKeOwner(1, 'x');
  cek('bot mati -> lanjut ke bot berikutnya', ok === true && terkirim[0]?.jid === '628999999999@s.whatsapp.net',
    JSON.stringify(terkirim));

  // 6. nggak ada nomor owner
  botPalsu.aktif = [{ id: 8, owner_number: null }];
  cek('owner_number kosong -> false', (await kirimKeOwner(1, 'x')) === false);

  // 7. argumen kosong
  cek('userId/teks kosong -> false', (await kirimKeOwner(0, '')) === false);

  console.log(gagal ? `\n=== GAGAL: ${gagal} masalah ===` : '\n=== SEMUA CEK LULUS ===');
  process.exit(gagal ? 1 : 0);
})();
