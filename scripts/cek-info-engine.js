// Cek cepat: blok `.info` + asal nama engine. Jalankan: node scripts/cek-info-engine.js
const fs = require('fs');
const info = fs.readFileSync('plugins/01-info.js', 'utf8');

// 1. engine WA yang beneran di-require (bukan tebakan)
const eng = fs.readFileSync('engine/whatsappEngine.js', 'utf8');
console.log('whatsappEngine require zapo-js :', /require\('zapo-js'\)/.test(eng));
console.log('whatsappEngine require baileys :', /require\('baileys'\)|require\('@whiskeysockets\/baileys'\)/.test(eng));

// 2. versi yang kebaca = versi node_modules yang ikut ke-deploy
console.log('zapo-js/package.json version   :', require('zapo-js/package.json').version);

// 3. barisnya beneran kepasang di blok .info
const blok = info.match(/INFO BOT[\s\S]{0,800}?╰[^\n]*/);
if (!blok) { console.log('GAGAL: blok INFO BOT nggak ketemu'); process.exit(1); }
console.log('--- yang bakal dikirim ---');
console.log(blok[0].replace(/\\n/g, '\n').replace(/\$\{[^}]+\}/g, '«nilai»'));

const wajib = ['Nama', 'Prefix', 'Uptime', 'Runtime', 'RAM', 'Node', 'OS', 'Engine'];
const hilang = wajib.filter(k => !blok[0].includes('│ ' + k));
if (hilang.length) { console.log('GAGAL: baris hilang →', hilang.join(', ')); process.exit(1); }
if (!blok[0].includes('${infoEngine()}')) { console.log('GAGAL: baris Engine nggak panggil infoEngine()'); process.exit(1); }
console.log('OK: 8 baris lengkap, Engine dari infoEngine()');
