'use strict';
/**
 * test/tanpa-bocor-env.js
 * Kunci: pesan yang DIKIRIM KE USER (chat bot / respons web) tidak boleh
 * membawa nama variabel .env, path server, errno, atau `err.message` mentah.
 *
 * Kenapa ada: `.setopen`/`.setclose` pernah menjawab
 *   "_Tanpa teks = pakai default dari .env (DEFAULT_SETCLOSE)_"
 * dan `.jarvis` pernah bilang "BASE_AI / KEY_AI belum diisi di .env". Dua-duanya
 * bocorin nama variabel konfigurasi ke grup/user — jalan pintas buat orang nyari
 * titik masuk. Aturannya sekarang: pesan ke user pakai kalimat manusia; detail
 * teknis cuma boleh ke `console.*` (log PM2).
 *
 * Tes ini statis (baca file, nggak jalanin bot) supaya cepat & deterministik.
 * Jalankan: node test/tanpa-bocor-env.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LEWATI_DIR = new Set(['node_modules', '.git', 'test', 'sessions']);

// ── 1. Kumpulkan nama variabel .env yang dikenal ─────────────────────────────
function namaEnv() {
  const nama = new Set();
  for (const f of ['.env', '.env.example']) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]{2,})\s*=/);
      if (m) nama.add(m[1]);
    }
  }
  return [...nama];
}

const NAMA_ENV = namaEnv();
assert.ok(NAMA_ENV.length > 5, `nama env kebaca cuma ${NAMA_ENV.length} — .env/.env.example hilang?`);
const RE_ENV = new RegExp('\\b(' + NAMA_ENV.sort((a, b) => b.length - a.length).join('|') + ')\\b');

// ── 2. Baris yang MENGIRIM ke user ───────────────────────────────────────────
const RE_KIRIM = /\b(reply|sendResult|sendError|res\.(json|send|status)|client\.message\.send|sendMessage)\s*\(/;

// ── 3. Token yang haram muncul di pesan user ─────────────────────────────────
const HARAM = {
  'nama variabel .env': RE_ENV,
  'sebut .env':         /\.env\b/,
  'err.message/stack':  /\b(e|err|error)\??\.(message|stack)\b/,
  'path server':        /\/var\/www|\/usr\/local|\/root\/|\/etc\/|__dirname|C:\\\\/,
  'errno':              /\bE[A-Z]{3,}\b/,
};

function filePindai(dir, keluar = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (LEWATI_DIR.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) filePindai(p, keluar);
    else if (e.name.endsWith('.js') || e.name.endsWith('.html')) keluar.push(p);
  }
  return keluar;
}

// ── 4. Pindai ────────────────────────────────────────────────────────────────
const pelanggaran = [];
for (const p of filePindai(ROOT)) {
  const baris = fs.readFileSync(p, 'utf8').split('\n');
  baris.forEach((isi, i) => {
    const s = isi.trim();
    // Komentar & log PM2 justru TEMPATNYA detail teknis — bukan pelanggaran.
    if (s.startsWith('//') || s.startsWith('*') || s.startsWith('/*') || s.startsWith('#')) return;
    if (s.includes('console.')) return;
    if (!RE_KIRIM.test(s)) return;
    const kode = s.split('//')[0];           // buang komentar ekor
    for (const [label, re] of Object.entries(HARAM)) {
      const m = kode.match(re);
      if (m) {
        pelanggaran.push(`${path.relative(ROOT, p)}:${i + 1} [${label}] ${m[0]}`);
        break;
      }
    }
  });
}

assert.strictEqual(pelanggaran.length, 0,
  'Pesan ke user membocorkan detail internal:\n  ' + pelanggaran.join('\n  '));

console.log(`semua ok — ${NAMA_ENV.length} nama env dijaga, nol bocoran di pesan user`);
