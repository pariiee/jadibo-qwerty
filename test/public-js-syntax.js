'use strict';
/**
 * test/public-js-syntax.js
 * Memeriksa sintaks seluruh berkas JS di public/js/ menggunakan vm.Script
 * Memastikan tidak ada kesalahan sintaks, template string liar, atau typo.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const dir = path.join(__dirname, '..', 'public', 'js');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));

assert.ok(files.length > 0, 'Tidak ada file JS di public/js');

let okCount = 0;
for (const file of files) {
  const filePath = path.join(dir, file);
  const code = fs.readFileSync(filePath, 'utf8');
  try {
    new vm.Script(code, { filename: file });
    okCount++;
    console.log(`  ✓ ${file} sintaks valid`);
  } catch (err) {
    console.error(`  ❌ ${file} ERROR SINTAKS:`, err.message);
    throw err;
  }
}

console.log(`\n✅ Seluruh ${okCount} file public/js/*.js sintaks valid tanpa error.`);
