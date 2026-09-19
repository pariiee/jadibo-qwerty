'use strict';
/**
 * test/nama-file-upload.js — regresi nama file buat upload.
 *
 * Bug nyata: `content.fileName` dari proto WA sudah ter-encode URL
 * ("soal_0020_nasib%20buruk.png"). Host upload (top4top) nolak nama kayak gitu
 * → file user gagal dapet URL. Jadi nama wajib dibersihkan dulu.
 *
 * Pelajaran lama: helper `OK()` WAJIB `await fn()` — kalau nggak, assert async
 * nggak jalan dan tes tetap "hijau" walau kodenya salah.
 */

const assert = require('assert');
const path   = require('path');

const SRC = path.join(__dirname, '..', 'plugins', '04-tools.js');
// File plugin pakai CRLF — dinormalisasi biar regex-nya nggak zonk.
const src = require('fs').readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
async function OK(nama, fn) {
  try { await fn(); console.log(`  ✅ ${nama}`); pass++; }
  catch (e) { console.log(`  ❌ ${nama}\n     ${e.message}`); fail++; }
}

// Ambil fungsi dari sumber (file plugin nggak nge-export helper internal).
const m = src.match(/function mimeToExt[\s\S]*?\n}\n[\s\S]*?function namaFileAman[\s\S]*?\n}/);
assert.ok(m, 'helper mimeToExt/namaFileAman nggak ketemu di 04-tools.js');
const mimeToExt    = eval(`(${m[0].match(/function mimeToExt[\s\S]*?\n}/)[0]})`);
const namaFileAman = eval(`(${m[0].match(/function namaFileAman[\s\S]*?\n}/)[0]})`);

(async () => {
  console.log('🧪 tes nama file upload');

  await OK('nama ter-encode URL di-decode + spasi jadi underscore', () => {
    const r = namaFileAman('soal_0020_nasib%20buruk.png', 'image/png');
    assert.ok(!r.includes('%'), `masih ada % → ${r}`);
    assert.ok(!/\s/.test(r), `masih ada spasi → ${r}`);
    assert.ok(/\.png$/.test(r), `ekstensi salah → ${r}`);
  });

  await OK('ekstensi ngikut mime, bukan nama lama', () => {
    assert.ok(namaFileAman('video.mp4', 'image/jpeg').endsWith('.jpg'));
    assert.ok(namaFileAman('foto.png', 'video/mp4').endsWith('.mp4'));
  });

  await OK('nama kosong/aneh tetap dapet nama valid', () => {
    for (const n of [undefined, null, '', '   ', '???', 'x'.repeat(500)]) {
      const r = namaFileAman(n, 'image/png');
      assert.ok(/^[A-Za-z0-9._-]+\.png$/.test(r), `nama jebol → "${r}"`);
      assert.ok(r.length <= 70, `kepanjangan → ${r.length}`);
    }
  });

  await OK('path di nama dibuang (nggak bikin folder)', () => {
    const r = namaFileAman('../../etc/passwd.png', 'image/png');
    assert.ok(!r.includes('/'), `masih ada slash → ${r}`);
    assert.ok(!r.startsWith('..'), `masih ada .. → ${r}`);
  });

  await OK('handler tourl/upload pakai namaFileAman (bukan fileName mentah)', () => {
    const pakai = (src.match(/namaFileAman\(/g) || []).length;
    assert.ok(pakai >= 5, `cuma kepakai ${pakai}x, harusnya >= 5 (tourl, tourl2, + definisi)`);
    const mentah = src.match(/filename\s*=\s*content\.fileName\s*\|\|/g) || [];
    assert.strictEqual(mentah.length, 0, 'masih ada yang pakai content.fileName mentah');
  });

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} lulus, ${fail} gagal`);
  process.exit(fail === 0 ? 0 : 1);
})();
