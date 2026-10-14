'use strict';
/**
 * test/plugin-references-check.js
 * Memeriksa bahwa plugin yang mengekspor helper internal
 * tidak memanggil nama namespace dirinya sendiri secara salah (ReferenceError).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const baseDir = path.join(__dirname, '..', 'plugins');
const pluginsDir = fs.existsSync(path.join(baseDir, 'whatsapp')) ? path.join(baseDir, 'whatsapp') : baseDir;
const files = fs.readdirSync(pluginsDir).filter(f => f.endsWith('.js'));

files.forEach(f => {
  const code = fs.readFileSync(path.join(pluginsDir, f), 'utf8');
  
  // Ambil nama file tanpa nomor awal & ekstensi, misal '06-proteksi.js' -> 'proteksi'
  const match = f.match(/^\d+-(.+)\.js$/);
  if (!match) return;
  const baseName = match[1];

  // Jika file memanggil standalone `baseName.xxx(...)` (bukan `client.group.xxx`), pastikan dideklarasikan
  const callRegex = new RegExp(`(?<!\\.)\\b${baseName}\\.[a-zA-Z0-9_]+\\(`, 'g');
  const calls = code.match(callRegex);
  if (calls) {
    const hasDecl = new RegExp(`\\b(const|let|var)\\s+${baseName}\\b`).test(code);
    assert.ok(
      hasDecl,
      `File ${f} memanggil namespace dirinya sendiri '${baseName}.' tapi tidak mendeklarasikannya: ${calls.join(', ')}`
    );
  }
});

console.log('✓ Seluruh plugin lolos uji referensi namespace internal!');
