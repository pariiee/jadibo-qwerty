'use strict';
/**
 * test/run-all.js
 * Jalanin semua tes zapo-*.js + engine-scope.js. Tiap tes itu proses sendiri
 * (biar satu yang gagal nggak ngerusak yang lain) dan exit code-nya digabung.
 *
 * Jalankan: npm test
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const files = fs.readdirSync(dir)
  .filter((f) => f.endsWith('.js') && f !== 'run-all.js')
  .sort();

let gagal = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' });
  if (r.status !== 0) { gagal++; console.error(`\n❌ ${f} GAGAL (exit ${r.status})\n`); }
}

console.log(`\n${'─'.repeat(50)}`);
if (gagal) {
  console.error(`❌ ${gagal} dari ${files.length} file tes GAGAL`);
  process.exit(1);
}
console.log(`✅ ${files.length} file tes lolos`);
