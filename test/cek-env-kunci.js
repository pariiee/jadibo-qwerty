const fs = require('fs');
if (!fs.existsSync('.env')) { console.log('⏭️  .env nggak ada — lewat (cek manual, bukan gerbang)'); process.exit(0); }
const env = fs.readFileSync('.env', 'utf8');
const ada = (k) => new RegExp('^' + k + '=', 'm').test(env);
for (const k of ['JWT_SECRET', 'INTERNAL_KEY', 'PORT', 'ENGINE_BOT_ID', 'BRIDGE_PLATFORM', 'ENGINE_WEB_URL', 'DB_HOST', 'DB_NAME', 'ADMIN_ROLE']) {
  console.log((ada(k) ? '✅ ADA   ' : '❌ KOSONG') + ' ' + k);
}
// nilai jangan dicetak: cuma panjangnya, buat mastiin keisi
for (const k of ['JWT_SECRET', 'INTERNAL_KEY']) {
  const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
  if (m) console.log(`   ${k} panjang=${m[1].trim().length}`);
}
