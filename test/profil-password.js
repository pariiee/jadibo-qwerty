'use strict';
/**
 * test/profil-password.js
 * Ganti password: jalur keamanan, jadi harus ada yang ngunci.
 *
 * Yang diuji: password lama WAJIB benar, password baru minimal 6 karakter,
 * nggak boleh sama dengan yang lama, dan UPDATE-nya nulis ke req.user.id —
 * BUKAN ke id yang dikirim body (kalau tidak, siapa pun bisa ganti password
 * akun orang lain dengan menebak id-nya).
 *
 * Pool-nya palsu: tes ini nggak nyentuh DB.
 */
const path = require('path');
const bcrypt = require('bcryptjs');

let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`✅ ${nama}`);
  else { gagal++; console.log(`❌ ${nama}${info ? ' — ' + info : ''}`); }
};

// ── Pool palsu, dipasang SEBELUM authController di-require ───────────────────
const HASH_LAMA = bcrypt.hashSync('lamaAsli123', 4);
const ditulis = [];
const poolPalsu = {
  execute: async (sql, params) => {
    if (/SELECT password FROM users/i.test(sql)) return [[{ password: HASH_LAMA }]];
    if (/UPDATE users SET password/i.test(sql)) { ditulis.push(params); return [{ affectedRows: 1 }]; }
    return [[]];
  },
};
const jalurDb = require.resolve(path.join(__dirname, '..', 'config', 'database.js'));
require.cache[jalurDb] = {
  id: jalurDb, filename: jalurDb, loaded: true, exports: {
    pool: poolPalsu,
    incrementStat: async () => {},
    decrementStat: async () => {},
  },
};
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cek';

const auth = require('../controllers/authController');

/** Panggil handler dengan res palsu; balikin {status, body}. */
async function panggil(body, userId = 7) {
  let keluar = null;
  const res = {
    status(k) { this._k = k; return this; },
    json(d) { keluar = { status: this._k || 200, body: d }; return this; },
  };
  await auth.gantiPassword({ body, user: { id: userId } }, res);
  return keluar;
}

(async () => {
  cek('handler-nya ada', typeof auth.gantiPassword === 'function');

  const kosong = await panggil({});
  cek('tolak kalau kosong', kosong.status === 400, JSON.stringify(kosong.body));

  const pendek = await panggil({ lama: 'lamaAsli123', baru: '123' });
  cek('tolak password baru < 6', pendek.status === 400, JSON.stringify(pendek.body));

  const sama = await panggil({ lama: 'lamaAsli123', baru: 'lamaAsli123' });
  cek('tolak kalau sama dengan lama', sama.status === 400, JSON.stringify(sama.body));

  const salah = await panggil({ lama: 'salahBanget', baru: 'baruBanget123' });
  cek('tolak kalau password lama salah', salah.status === 401, JSON.stringify(salah.body));
  cek('password TIDAK tertulis waktu lama salah', ditulis.length === 0);

  const ok = await panggil({ lama: 'lamaAsli123', baru: 'baruBanget123' });
  cek('terima kalau lama benar', ok.status === 200 && ok.body.ok === true, JSON.stringify(ok.body));

  // Yang paling penting: ke baris SIAPA UPDATE-nya nulis.
  cek('UPDATE nulis ke req.user.id, bukan body.id', ditulis.length === 1 && ditulis[0][1] === 7,
    JSON.stringify(ditulis));

  // Dan yang ditulis harus HASH baru, bukan teks polos.
  const hashBaru = ditulis[0]?.[0];
  cek('yang disimpan hash, bukan teks polos', typeof hashBaru === 'string' && hashBaru.startsWith('$2'),
    String(hashBaru).slice(0, 12));
  cek('hash-nya cocok dengan password baru', await bcrypt.compare('baruBanget123', hashBaru));

  // Body nggak boleh bisa ngatur id tujuan.
  ditulis.length = 0;
  await panggil({ lama: 'lamaAsli123', baru: 'baruBanget123', id: 999, user_id: 999 }, 7);
  cek('id dari body diabaikan', ditulis.length === 1 && ditulis[0][1] === 7, JSON.stringify(ditulis));

  console.log(gagal ? `\n=== GAGAL: ${gagal} masalah ===` : '\n=== SEMUA CEK LULUS ===');
  process.exit(gagal ? 1 : 0);
})();
