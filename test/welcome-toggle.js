'use strict';
// Sambutan (welcome) & ucapan keluar (left) grup.
//
// Yang dijaga di sini: saklar .on/.off harus beneran mematikan. Dulu kolomnya
// dibaca pakai `||` lalu jatuh balik ke teks default .env, jadi setelah admin
// ngehapus pesannya, salam TETAP kekirim. Nol saklar = nggak ada teks yang
// dikirim, jadi hasil akhirnya pun nggak boleh ada.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const engSrc   = read('engine/whatsappEngine.js');
const proteksi = read('plugins/06-proteksi.js');
const grup     = read('plugins/02-group.js');

// Teks yang bakal dikirim buat satu event. Cerminan blok di whatsappEngine.js.
const pilihTeks = (action, s, def) => {
  const welcomeOn = s.welcome_on !== 0;
  const byeOn     = s.bye_on !== 0;
  return action === 'add'
    ? (welcomeOn ? (s.welcome_msg ?? def.welcome) : null)
    : (byeOn ? (s.bye_msg ?? def.bye) : null);
};
const DEF = { welcome: 'default dari .env', bye: 'default dari .env' };

// 1. Saklar OFF -> nggak ada teks, walau teks default .env ada isinya.
assert.strictEqual(pilihTeks('add',    { welcome_on: 0, welcome_msg: 'hai @user' }, DEF), null);
assert.strictEqual(pilihTeks('remove', { bye_on: 0,     bye_msg: 'bye @user' },     DEF), null);

// 2. Saklar OFF menang walau kolomnya udah NULL (kasus habis .delwelcome).
assert.strictEqual(pilihTeks('add',    { welcome_on: 0, welcome_msg: null }, DEF), null);
assert.strictEqual(pilihTeks('remove', { bye_on: 0,     bye_msg: null },     DEF), null);

// 3. Saklar ON: teks custom dipakai; belum diatur -> default .env.
assert.strictEqual(pilihTeks('add',    { welcome_on: 1, welcome_msg: 'hai' }, DEF), 'hai');
assert.strictEqual(pilihTeks('add',    { welcome_on: 1, welcome_msg: null },  DEF), DEF.welcome);
assert.strictEqual(pilihTeks('remove', { bye_on: 1,     bye_msg: null },      DEF), DEF.bye);

// 4. Grup lama (nggak punya baris group_settings) -> undefined = tetep ON.
assert.strictEqual(pilihTeks('add',    {}, DEF), DEF.welcome);
assert.strictEqual(pilihTeks('remove', {}, DEF), DEF.bye);

// 5. Kode asli beneran pakai `??`, bukan `||` — itu akar bug-nya.
assert.ok(/welcomeOn \? \(settings\.welcome_msg \?\?/.test(engSrc),
  "engine harus (welcomeOn ? (welcome_msg ?? default) : null) — bukan `||`");
assert.ok(!/welcome_msg \|\| mess/.test(engSrc), 'masih ada `welcome_msg || mes*` — OFF bakal bocor ke default');

// 6. Engine baca kolom saklarnya, dan join-request nggak dianggap keluar.
assert.ok(/welcome_on, bye_on/.test(engSrc), 'engine harus SELECT welcome_on & bye_on');
assert.ok(/action === 'request'\) return/.test(engSrc), "'request' jangan lanjut ke teks bye");
assert.ok(/if \(!template\) continue;/.test(engSrc), 'template kosong = nggak kirim apa-apa');

// 7. Saklarnya kecatat di mesin .on/.off, kolomnya ada, dan aliasnya lengkap.
assert.ok(/welcome:.*col: 'welcome_on'/.test(proteksi), '.on welcome -> welcome_on');
assert.ok(/left:.*col: 'bye_on'/.test(proteksi),         '.on left -> bye_on');
assert.ok(/info\.col \|\| fitur/.test(proteksi), 'setDbGroupSetting harus pakai info.col');
// Jebakan halus: `await f()[x]` ngindeks Promise-nya -> hasilnya undefined terus,
// jadi .on welcome bakal ngaku "sudah aktif sejak tadi" padahal belum.
assert.ok(/const dbNow = await getDbGroupSetting/.test(proteksi),
  'hasil getDbGroupSetting harus di-await dulu, baru di-indeks');
assert.ok(/welcome_on, bye_on FROM group_settings/.test(proteksi), 'status .on harus baca kolom saklar');

// 8. .setwelcome / .setleft / .setbye nulis teks DAN nyalain saklarnya.
assert.ok(/case 'setleft':/.test(grup) && /case 'setbye':/.test(grup),
  '.setleft & .setbye harus satu jalur dengan .setwelcome');
assert.ok(/group_jid, \$\{colMsg\}, \$\{colOn\}\)/.test(grup) && /VALUES \(\?, \?, \?, 1\)/.test(grup),
  'setwelcome/setleft harus nulis teks + nyalain saklarnya (= 1)');
assert.ok(/welcome_msg = NULL, welcome_on = 0/.test(grup), '.delwelcome harus matiin saklarnya');
assert.ok(/bye_msg = NULL, bye_on = 0/.test(grup),         '.delbye harus matiin saklarnya');

// 9. DB lama dapet kolomnya otomatis lewat sync-schema.
const sync = read('scripts/sync-schema.js');
assert.ok(/group_settings: \[/.test(sync) && /welcome_on/.test(sync) && /bye_on/.test(sync),
  'sync-schema harus nambahin welcome_on & bye_on');

// 10. Fitur kecatat di .menu.
const info = read('plugins/01-info.js');
assert.ok(/'setleft'/.test(info), '.setleft harus kecatat di daftar command');
assert.ok(/'welcome','left'/.test(info), '.on welcome & .on left harus muncul di kategori proteksi');

console.log('✓ welcome/left: .on/.off beneran matiin, teks nggak bocor ke default .env');
