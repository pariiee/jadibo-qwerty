'use strict';
/**
 * test/email-jalur.js
 *
 * Email itu jalur kabar KETIGA, dan satu-satunya yang TIDAK lewat bot milik
 * user. Justru karena itu dia penting: dua jalur sebelumnya (nomor owner &
 * nomor HP) sama-sama dikirim LEWAT BOT ITU SENDIRI, jadi saat botnya yang
 * rusak — kuota habis, bot mati — kabarnya ikut hilang.
 *
 * Yang dikunci di sini:
 *   1. Validasi email: yang jelas salah ditolak, yang wajar diterima.
 *   2. Belum dikonfigurasi = no-op TAPI beri peringatan (bukan gagal senyap).
 *   3. Bentuk POST-nya benar (from/to/subject/text + Authorization).
 *   4. Email dipanggil HANYA setelah WhatsApp gagal — kalau tidak, user yang
 *      botnya normal dapat notif dobel untuk hal yang sama.
 *   5. User tanpa email tidak dianggap "terkirim".
 */

const path = require('path');
const Module = require('module');

let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`✅ ${nama}`);
  else { gagal++; console.log(`❌ ${nama}${info ? ' — ' + info : ''}`); }
};

const ROOT = path.join(__dirname, '..');
const muatUlang = (p) => { delete require.cache[require.resolve(p)]; return require(p); };

// ─── 1. Validasi email (fungsi asli, bukan cocok-cocokan teks) ────────────────
console.log('=== 1. Validasi email ===');
process.env.MAIL_API_URL = ''; process.env.MAIL_API_KEY = ''; process.env.MAIL_FROM = '';
const email = require(path.join(ROOT, 'engine', 'email.js'));
const { emailValid } = email;

for (const [alamat, harus] of [
  ['nama@email.com', true],
  ['a.b-c+tag@sub.domain.co.id', true],
  ['  nama@email.com  ', true],        // di-trim
  ['nama@email', false],               // tanpa titik di domain
  ['namaemail.com', false],            // tanpa @
  ['nama@@email.com', false],
  ['nama @email.com', false],          // ada spasi
  ['@email.com', false],
  ['nama@.com', false],
  ['', false],
  [null, false],
  ['a@b.c', false],                    // terlalu pendek
]) {
  cek(`emailValid(${JSON.stringify(alamat)}) === ${harus}`, emailValid(alamat) === harus,
    `dapat ${emailValid(alamat)}`);
}

// ─── 2. Belum dikonfigurasi: no-op + peringatan, bukan gagal senyap ──────────
console.log('\n=== 2. Belum dikonfigurasi ===');
cek('siap() === false', email.siap() === false);
let peringatan = 0;
const asliWarn = console.warn;
console.warn = (...a) => { if (String(a[0]).includes('[Email]')) peringatan++; };
(async () => {
  cek('kirimEmail balikin false', (await email.kirimEmail('a@b.com', 's', 'i')) === false);
  cek('kirimKeUser balikin false', (await email.kirimKeUser(1, 's', 'i')) === false);
  cek('MENINGGALKAN peringatan (tidak gagal senyap)', peringatan === 1, `dapat ${peringatan}`);
  await email.kirimEmail('a@b.com', 's', 'i');
  cek('peringatan cuma SEKALI per proses (tidak membanjiri log)', peringatan === 1, `dapat ${peringatan}`);
  console.warn = asliWarn;

  // ─── 3. Dikonfigurasi: bentuk POST-nya benar ───────────────────────────────
  console.log('\n=== 3. Dikonfigurasi — bentuk permintaan ke penyedia ===');
  process.env.MAIL_API_URL = 'https://api.contoh.test/emails';
  process.env.MAIL_API_KEY = 'kunci-rahasia';
  process.env.MAIL_FROM = 'YaaParBot <kabar@yapari.web.id>';

  const dikirim = [];
  let axiosPalsuGagal = false;
  const axiosPalsu = {
    post: async (url, body, opts) => {
      if (axiosPalsuGagal) {
        const e = new Error('Request failed with status code 422');
        e.response = { status: 422 };
        throw e;
      }
      dikirim.push({ url, body, opts });
      return { status: 200 };
    },
  };

  // email.js memakai `require('axios')` — intersep di situ.
  const asliRequire = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'axios') return axiosPalsu;
    return asliRequire.apply(this, arguments);
  };

  // Env dibaca SAAT MODULE LOAD, jadi harus di-require ulang setelah di-set.
  const email2 = muatUlang(path.join(ROOT, 'engine', 'email.js'));
  cek('siap() === true setelah tiga env diisi', email2.siap() === true);

  await email2.kirimEmail('user@email.com', 'Kuota habis', 'Isi pesan');
  const k = dikirim[0];
  cek('POST ke MAIL_API_URL', k?.url === 'https://api.contoh.test/emails', String(k?.url));
  cek('Authorization: Bearer <key>', k?.opts?.headers?.Authorization === 'Bearer kunci-rahasia');
  cek('from dari MAIL_FROM', k?.body?.from === 'YaaParBot <kabar@yapari.web.id>');
  cek('to berupa array berisi alamat', Array.isArray(k?.body?.to) && k.body.to[0] === 'user@email.com',
    JSON.stringify(k?.body?.to));
  cek('subject diteruskan', k?.body?.subject === 'Kuota habis');
  cek('isi ada di `text`', k?.body?.text === 'Isi pesan');
  cek('ada timeout (jangan menggantung)', typeof k?.opts?.timeout === 'number');

  cek('email tidak valid TIDAK dikirim',
    (await email2.kirimEmail('bukan-email', 's', 'i')) === false && dikirim.length === 1);

  // Gagal dari penyedia: harus balikin false + meninggalkan jejak, TIDAK melempar.
  axiosPalsuGagal = true;
  let melempar = false;
  let hasil;
  try { hasil = await email2.kirimEmail('user@email.com', 's', 'i'); }
  catch { melempar = true; }
  cek('gagal dari penyedia tidak melempar', !melempar);
  cek('gagal dari penyedia balikin false', hasil === false);
  axiosPalsuGagal = false;
  Module.prototype.require = asliRequire;

  // ─── 4. notify: email HANYA setelah WhatsApp gagal ────────────────────────
  console.log('\n=== 4. notify: email hanya sebagai cadangan ===');
  const notifySrc = require('fs').readFileSync(path.join(ROOT, 'engine', 'notify.js'), 'utf8');
  const kode = notifySrc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  const iEmail = kode.indexOf('kirimKeUser');
  cek('email dipanggil di dalam kirimKeOwner', iEmail > 0);
  // PENTING — dua jebakan di sini, dua-duanya sempat lolos:
  //   1. Membandingkan dengan `return false` terakhir TIDAK cukup: mutasi
  //      "pindahkan blok email ke paling atas" tetap HIJAU, karena indeksnya
  //      kecil sementara `return false` tetap di ekor.
  //   2. `lastIndexOf('kirimLewatBot')` di SELURUH file menemukan DEFINISI
  //      fungsinya (ada di bawah kirimKeOwner), bukan pemanggilannya — jadi
  //      perbandingannya jadi terbalik dan kode yang BENAR malah kelihatan salah.
  // Solusinya: batasi ke badan kirimKeOwner saja.
  const badan = kode.slice(
    kode.indexOf('async function kirimKeOwner'),
    kode.indexOf('async function kirimLewatBot')
  );
  cek('badan kirimKeOwner terpotong benar', badan.includes('kirimKeUser') && badan.includes('kirimLewatBot'));
  const iEmailBadan = badan.indexOf('kirimKeUser');
  const iWaBadan = badan.lastIndexOf('kirimLewatBot');
  cek('email dipanggil SETELAH percobaan WhatsApp terakhir (jadi benar-benar cadangan)',
    iEmailBadan > iWaBadan, `email@${iEmailBadan} vs wa-terakhir@${iWaBadan}`);
  cek('komentar menjelaskan kenapa hanya di sini (biar tidak dobel)',
    /dobel/i.test(notifySrc));

  // ─── 5. emailUser: user tanpa email tidak dianggap terkirim ───────────────
  console.log('\n=== 5. User tanpa email ===');
  const poolPalsu = {
    execute: async (sql) => {
      if (/FROM users/i.test(sql)) return [[{ email: null }]];
      return [[]];
    },
  };
  const asliRequire2 = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === '../config/database') return { pool: poolPalsu };
    return asliRequire2.apply(this, arguments);
  };
  const email3 = muatUlang(path.join(ROOT, 'engine', 'email.js'));
  Module.prototype.require = asliRequire2;
  cek('emailUser("") untuk kolom kosong', (await email3.emailUser(1)) === '');
  cek('kirimKeUser false kalau tidak punya email',
    (await email3.kirimKeUser(1, 's', 'i')) === false);

  console.log('');
  console.log(gagal ? `=== GAGAL: ${gagal} masalah ===` : '=== SEMUA CEK LULUS ===');
  process.exit(gagal ? 1 : 0);
})();
