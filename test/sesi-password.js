'use strict';
/**
 * test/sesi-password.js
 * Ganti password HARUS memutus sesi perangkat lain.
 *
 * Sesi itu JWT stateless: tanpa cek `tv` (token_version), orang yang sudah
 * login di HP lain tetap masuk sampai tokennya kedaluwarsa (7 hari). Tes ini
 * membuktikan token lama benar-benar MATI setelah password diganti.
 *
 * Pool palsu: nggak nyentuh DB.
 */
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`✅ ${nama}`);
  else { gagal++; console.log(`❌ ${nama}${info ? ' — ' + info : ''}`); }
};

process.env.JWT_SECRET = process.env.JWT_SECRET || 'rahasia-tes-panjang-sekali';
const JWT_SECRET = process.env.JWT_SECRET;

const db = { tv: 3, password: bcrypt.hashSync('lamaAsli123', 4), ada: true };
const poolPalsu = {
  execute: async (sql, params = []) => {
    if (/SELECT token_version FROM users WHERE id/i.test(sql)) {
      return [db.ada ? [{ token_version: db.tv }] : []];
    }
    if (/UPDATE users SET password = \?, token_version = token_version \+ 1/i.test(sql)) {
      db.password = params[0];
      db.tv += 1;
      return [{ affectedRows: 1 }];
    }
    if (/SELECT password FROM users/i.test(sql)) return [[{ password: db.password }]];
    return [[]];
  },
};

const jalurDb = require.resolve(path.join(__dirname, '..', 'config', 'database.js'));
require.cache[jalurDb] = {
  id: jalurDb, filename: jalurDb, loaded: true,
  exports: { pool: poolPalsu, incrementStat: async () => {}, decrementStat: async () => {} },
};

const auth = require('../controllers/authController');

function resPalsu() {
  const k = { status: 200, body: null, cookie: null };
  return {
    _k: k,
    status(c) { k.status = c; return this; },
    json(b) { k.body = b; return this; },
    cookie(nama, nilai) { k.cookie = { nama, nilai }; return this; },
    clearCookie() { return this; },
    _hasil() { return k; },
  };
}

/** Jalanin requireAuth dengan token tertentu; balikin {lolos, status}. */
async function lewatAuth(token) {
  const res = resPalsu();
  let lolos = false;
  await auth.requireAuth({ cookies: { token } }, res, () => { lolos = true; });
  return { lolos, status: res._hasil().status };
}

(async () => {
  const tokenLama = jwt.sign({ id: 1, username: 'king', role: 'kawula', tv: 3 }, JWT_SECRET, { expiresIn: '7d' });
  const tokenBasi = jwt.sign({ id: 1, username: 'king', role: 'kawula', tv: 1 }, JWT_SECRET, { expiresIn: '7d' });

  // 1. token yang tv-nya cocok -> lolos
  cek('tv cocok -> lolos', (await lewatAuth(tokenLama)).lolos === true);

  // 2. token lama (tv ketinggalan) -> ditolak, walau tanda tangannya sah
  const basi = await lewatAuth(tokenBasi);
  cek('tv ketinggalan -> ditolak 401', !basi.lolos && basi.status === 401, JSON.stringify(basi));

  // 3. token tanpa tv sama sekali (token dari sebelum fitur ini ada) -> ditolak
  const tanpaTv = jwt.sign({ id: 1, username: 'king', role: 'kawula' }, JWT_SECRET, { expiresIn: '7d' });
  cek('token tanpa tv -> ditolak', !(await lewatAuth(tanpaTv)).lolos);

  // 4. user sudah nggak ada -> ditolak
  db.ada = false;
  cek('user nggak ada -> ditolak', !(await lewatAuth(tokenLama)).lolos);
  db.ada = true;

  // 5. ganti password -> tv naik, token lama MATI, cookie baru hidup
  const res = resPalsu();
  await auth.gantiPassword(
    { user: { id: 1, username: 'king', role: 'kawula', tv: db.tv }, body: { lama: 'lamaAsli123', baru: 'baruBanget123' } },
    res
  );
  const hasil = res._hasil();
  cek('ganti password sukses', hasil.body?.ok === true, JSON.stringify(hasil.body));
  cek('token_version naik', db.tv === 4, String(db.tv));
  cek('cookie baru diset', !!hasil.cookie && hasil.cookie.nama === 'token');

  // 6. INI INTINYA: token dari perangkat lain (yang lama) sudah nggak berlaku
  cek('token lama MATI setelah ganti password', !(await lewatAuth(tokenLama)).lolos);

  // 7. tapi perangkat yang barusan ganti password tetap masuk (cookie baru)
  cek('perangkat yang ganti password tetap masuk', (await lewatAuth(hasil.cookie.nilai)).lolos === true);

  // 8. password barunya benar-benar kepakai
  cek('hash-nya cocok dengan password baru', await bcrypt.compare('baruBanget123', db.password));
  cek('password lama sudah tidak cocok', !(await bcrypt.compare('lamaAsli123', db.password)));

  console.log(gagal ? `\n=== GAGAL: ${gagal} masalah ===` : '\n=== SEMUA CEK LULUS ===');
  process.exit(gagal ? 1 : 0);
})();
