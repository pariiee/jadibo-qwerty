// Cek blok `.info` + asal nama/versi engine. Jalankan: node test/info-engine.js
// Jalan di dua branch: main (baileys) & zapo-deploy (zapo-js).
const fs = require('fs');

let gagal = 0;
const cek = (nama, ok) => { console.log((ok ? '[OK]   ' : '[FAIL] ') + nama); if (!ok) gagal++; };

// 1. engine WA yang beneran di-require di file ini — bukan tebakan
const info = fs.readFileSync('plugins/01-info.js', 'utf8');
const paketEngine = (info.match(/require\('(baileys|zapo-js)'\)/) || [])[1];
cek('plugins/01-info.js require engine: ' + paketEngine, !!paketEngine);

// 2. helper infoEngine() ada & kandidatnya nyakup engine yang kepakai di branch ini
cek('ada function infoEngine()', /function infoEngine\(\)/.test(info));
cek('kandidat infoEngine nyakup ' + paketEngine, info.includes(`['${paketEngine}',`));

// 3. paket engine itu beneran dependency repo ini (versi runtime = saat verifikasi VPS)
//    cek ke package.json; versi runtime-nya dibuktikan saat verifikasi di VPS)
const deps = require('../package.json').dependencies;
cek(`${paketEngine} ada di dependencies (${deps[paketEngine]})`, !!deps[paketEngine]);

// 4. barisnya kepasang di blok .info, dan semua baris lama masih ada
const blok = info.match(/INFO BOT[\s\S]{0,800}?╰[^\n]*/);
cek('blok INFO BOT ketemu', !!blok);
if (blok) {
  const wajib = ['Nama', 'Prefix', 'Uptime', 'Runtime', 'RAM', 'Node', 'OS', 'Engine'];
  const hilang = wajib.filter(k => !blok[0].includes('│ ' + k));
  cek('8 baris lengkap' + (hilang.length ? ' — hilang: ' + hilang.join(',') : ''), !hilang.length);
  cek('baris Engine panggil infoEngine()', blok[0].includes('${infoEngine()}'));
}

console.log(gagal ? `\n${gagal} gagal` : '\nsemua ok');
process.exit(gagal ? 1 : 0);
