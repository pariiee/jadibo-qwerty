// Uji parser getBotStats TANPA DB: format baris `bot_logs` itu teks, dan
// statistiknya dibaca pakai SUBSTRING/LOCATE. Ekspresi itu wajib diuji ke baris
// NYATA, bukan baris bikinan sendiri.
//
// Format asli (dicek ke 25 baris produksi VPS B, engine/whatsappEngine.js:1066):
//   grup  : "Lis @ ? QWERTY ?: .tt https://... (+4983ms)"
//   DM    : "Budi: .sticker (+45ms)"
//   media : "Rifqi A, F. 191C35 @ Grup X [stiker] (+12ms)"   ← nggak ada ": "
//
// Di sini gua tiru ulang ekspresi SQL-nya di JS (biar bisa diuji tanpa MySQL),
// plus pengaman yang berhenti kalau ekspresi controller-nya berubah dan file ini
// nggak ikut berubah — kalau nggak, test ini bakal bohong.
//
// Jalankan: node test/stats-parse.js
'use strict';

const fs   = require('fs');
const path = require('path');

let gagal = 0;
const cek = (nama, dapat, mau) => {
  // Boolean dibandingin pakai ===, bukan JSON.stringify ('true' !== true).
  const ok = (typeof dapat === 'boolean' || typeof mau === 'boolean')
    ? dapat === mau
    : JSON.stringify(dapat) === JSON.stringify(mau);
  if (!ok) gagal++;
  console.log(`${ok ? '[OK]  ' : '[GAGAL]'} ${nama}` +
    (ok ? '' : `\n         dapat: ${JSON.stringify(dapat)}\n         mau  : ${JSON.stringify(mau)}`));
};

// ── Cermin ekspresi controllers/botController.js ──────────────────────────────
const adaAt    = (m) => m.indexOf(' @ ') > 0;
const adaKolom = (m) => m.indexOf(': ') > 0;
const atDulu   = (m) => adaAt(m) && (!adaKolom(m) || m.indexOf(' @ ') < m.indexOf(': '));
const potong   = (m, sep) => { const i = m.indexOf(sep); return i < 0 ? m : m.slice(0, i); };

const namaDari = (m) => (atDulu(m) ? potong(m, ' @ ') : potong(m, ': '))
  .replace(/ \(\+\d+ms\)$/, '').replace(/ \[[^\]]*\]$/, '').trim();
const grupDari = (m) => {
  if (!atDulu(m)) return '';
  return potong(m.slice(m.indexOf(' @ ') + 3), ': ')
    .replace(/ \(\+\d+ms\)$/, '').replace(/ \[[^\]]*\]$/, '').trim();
};
const bodyDari = (m) => {
  if (!adaKolom(m)) return '';
  return m.slice(m.indexOf(': ') + 2).replace(/ \(\+\d+ms\)$/, '').trim();
};
const cmdDari = (m) => { const b = bodyDari(m); return potong(b, ' ').trim(); };

// ── Pengaman: ekspresi controller masih sejalan ───────────────────────────────
const SRC  = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'botController.js'), 'utf8');
const blok = SRC.slice(SRC.indexOf('const ADA_AT'), SRC.indexOf('async function getBotStats'));
cek('controller masih punya konstanta parser',
    ['ADA_AT', 'ADA_KOLOM', 'AT_DULU', 'NAMA', 'GRUP', 'BODY', 'CMD', 'WAKTU'].every(k => blok.includes('const ' + k)), true);
cek('" @ " dibandingkan ke posisi ": "', blok.includes("LOCATE(' @ ', message) < LOCATE(': ', message)"), true);
cek('ekor " (+Nms)" dibuang', blok.includes('+[0-9]+ms'), true);
cek('ekor " [tipe]" dibuang', blok.includes('[^]]*'), true);
cek('token pertama, bukan terakhir',     blok.includes("SUBSTRING_INDEX(${BODY}, ' ', 1)"), true);

// ── Baris sintetis: bentuk yang sudah dikonfirmasi di produksi ────────────────
cek('grup + argumen',
    [cmdDari('Lis @ ? QWERTY ?: .tt https://vt.tiktok.com/ZSbjGhj8m/ (+4983ms)'),
     namaDari('Lis @ ? QWERTY ?: .tt https://vt.tiktok.com/ZSbjGhj8m/ (+4983ms)'),
     grupDari('Lis @ ? QWERTY ?: .tt https://vt.tiktok.com/ZSbjGhj8m/ (+4983ms)')],
    ['.tt', 'Lis', '? QWERTY ?']);

cek('grup tanpa argumen',
    [cmdDari('Lis @ ? QWERTY ?: .tt (+814ms)'), namaDari('Lis @ ? QWERTY ?: .tt (+814ms)')],
    ['.tt', 'Lis']);

cek('DM tanpa grup',
    [cmdDari('Budi: .sticker (+45ms)'), namaDari('Budi: .sticker (+45ms)'), grupDari('Budi: .sticker (+45ms)')],
    ['.sticker', 'Budi', '']);

cek('nama ada koma + titik',
    [namaDari('Rifqi A, F. 191C35 @ Grup X: .menu (+9ms)'), cmdDari('Rifqi A, F. 191C35 @ Grup X: .menu (+9ms)')],
    ['Rifqi A, F. 191C35', '.menu']);

cek('media: nggak ada ": "',
    [namaDari('Rifqi A, F. 191C35 @ Grup X [stiker] (+12ms)'),
     grupDari('Rifqi A, F. 191C35 @ Grup X [stiker] (+12ms)'),
     cmdDari('Rifqi A, F. 191C35 @ Grup X [stiker] (+12ms)')],
    ['Rifqi A, F. 191C35', 'Grup X', '']);

// DM/media TANPA ": " → nama = seluruh baris minus ekor "(+Nms)"/"[tipe]".
cek('media DM tanpa ": "',
    [namaDari('Kii_ [protocolMessage] (+3ms)'), grupDari('Kii_ [protocolMessage] (+3ms)')],
    ['Kii_', '']);

cek('media masuk ke nama',
    namaDari('Rifqi A, F. 191C35 @ Grup X [stiker] (+12ms)'), 'Rifqi A, F. 191C35');

cek('chat biasa (bukan command)',
    [cmdDari('Heisenberg @ ? QWERTY ?: naon (+40ms)'), namaDari('Heisenberg @ ? QWERTY ?: naon (+40ms)')],
    ['naon', 'Heisenberg']);

cek('command gagal (cmderr)',
    cmdDari('Lis @ ? QWERTY ?: .tt (+4983ms)'), '.tt');

cek('grup namanya ada " @ "',
    grupDari('Budi @ Grup @ Kantor: .menu (+1ms)'), 'Grup @ Kantor');

cek('body-nya ada " @ "',
    [cmdDari('Budi @ Grup: .tt a @ b (+1ms)'), grupDari('Budi @ Grup: .tt a @ b (+1ms)')],
    ['.tt', 'Grup']);

// ── Data produksi: 25 baris terakhir bot_logs (VPS B) ─────────────────────────
// Taruh di .bot_logs_sample.txt, format: <level>\t<message> per baris.
const samplePath = path.join(__dirname, '..', '.bot_logs_sample.txt');
if (fs.existsSync(samplePath)) {
  const rows = fs.readFileSync(samplePath, 'utf8').split('\n')
    .map(l => l.trim()).filter(Boolean)
    .map(l => { const i = l.indexOf('\t'); return i < 0 ? ['', l] : [l.slice(0, i), l.slice(i + 1)]; });

  const nama = rows.map(([, m]) => namaDari(m));
  const kosong = nama.filter(n => !n).length;
  const bawaAt = nama.filter(n => n.includes(' @ ')).length;
  const cmdRows = rows.filter(([lv]) => lv === 'cmd');
  const cmdJanggal = cmdRows.map(([, m]) => cmdDari(m)).filter(c => !c.startsWith('.'));

  console.log(`[sample] ${rows.length} baris produksi: ${cmdRows.length} cmd, ${kosong} nama kosong, ${bawaAt} nama masih bawa "@"`);
  cek('sample: tiap baris punya nama',   kosong, 0);
  cek('sample: nama bersih dari grup',   bawaAt, 0);
  cek('sample: tiap baris cmd ada command-nya', cmdJanggal, []);
  for (const [lv, m] of rows.slice(0, 5)) {
    console.log(`   ${lv.padEnd(5)} → nama=${JSON.stringify(namaDari(m))} grup=${JSON.stringify(grupDari(m))} cmd=${JSON.stringify(cmdDari(m))}`);
  }
} else {
  console.log('[skip] .bot_logs_sample.txt nggak ada — cuma diuji ke baris sintetis');
}

console.log(gagal === 0 ? '\nsemua ok' : `\n${gagal} GAGAL`);
process.exit(gagal === 0 ? 0 : 1);
