'use strict';
/**
 * `.listtotalpesan` / `.topchat` / `.sider` — statistik pesan per member.
 *
 * Kenapa ada: angkanya dulu kelihatan "sedikit" karena tiga hal numpuk —
 *   (a) store-nya RAM doang, tiap restart (di VPS udah 185x) balik ke nol;
 *   (b) command nggak ikut kehitung, padahal itu aktivitas paling rame;
 *   (c) kuncinya JID apa adanya, jadi satu orang bisa kepecah jadi dua baris
 *       (`628xx:12@s.whatsapp.net` vs `628xx@s.whatsapp.net`) — dan di grup LID
 *       `@123…` yang ditulis itu LID, bukan nomor, jadi tag-nya nggak nyantol.
 *
 * Tes ini ngunci keempatnya: hitung semua pesan, normalkan ke nomor polos,
 * simpan ke disk, dan tag pakai mentionsForChat.
 */
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const root = path.join(__dirname, '..');
const grup = fs.readFileSync(path.join(root, 'plugins/02-group.js'), 'utf8');

// 1. Hitungan jalan untuk SEMUA pesan grup, bukan cuma yang bukan command.
assert.ok(/topchatCount\(ctx\.jid,\s*bare\(ctx\.sender\)\)/.test(grup),
  'hitungan statistik harus dipanggil untuk semua pesan grup');
assert.ok(/if \(ctx\.isGroup\) topchatCount\(ctx\.jid, bare\(ctx\.sender\)\)/.test(grup),
  'command nggak ikut kehitung — jalur non-command aja yang ada');

// 2. Kunci peta = nomor polos, bukan JID apa adanya.
assert.ok(/const sorted = \[\.\.\.tc\.entries\(\)\]/.test(grup), 'listtotalpesan kehilangan pembacaan peta');
assert.ok(!/tc\.set\(ctx\.sender,/.test(grup), 'kunci peta masih pakai ctx.sender mentah (bisa ada :device)');
assert.ok(/mentionsForChat\(jid, potong\.map\(\(\[num\]\) => toPn\(num\)\)\)/.test(grup),
  'listtotalpesan harus tag lewat mentionsForChat (biar nyantol di grup LID)');
assert.ok(grup.includes('Angka ini dihitung SEJAK BOT NYALA'),
  'header harus jujur bilang dihitung sejak bot nyala');

// 3. Statistik disimpan ke disk — restart nggak bikin angka balik ke nol.
assert.ok(/TOPCHAT_FILE\s*=\s*path\.join\([^)]*'data',\s*'topchat-store\.json'\)/.test(grup),
  'belum ada berkas penyimpanan statistik');
assert.ok(/JSON\.stringify\(out\)/.test(grup) && /topchatLoad\(\)/.test(grup),
  'simpan + muat statistik harus ada dua-duanya');

// 4. `.sider` bandingin di ruang yang sama (nomor polos).
//    bare(LID) = angka LID, bukan nomor — wajib lewat lidToPnAsync dulu, kalau
//    nggak semua member kebaca pasif.
assert.ok(/peserta\.map\(l => lidToPnAsync\(sock, l\)\)/.test(grup),
  '.sider nggak nukar LID ke nomor — semua member bakal kelihatan pasif');
assert.ok(/mentionsForChat\(jid, pasif\.slice\(i, i \+ CHUNK\)\.map\(toPn\)\)/.test(grup),
  '.sider tag pakai angka mentah — nggak nyantol di grup LID');

// 5. Registry masih lengkap.
const info = require(path.join(root, 'plugins/01-info.js'));
for (const c of ['topchat', 'sider', 'listtotalpesan']) {
  assert.ok(info.ALL_COMMANDS.includes(c), `${c} ilang dari ALL_COMMANDS`);
}

// ─── Uji perilakunya, bukan cuma teksnya ──────────────────────────────────────
// Jalankan blok statistik SUNGGUHAN (diambil apa adanya dari plugin) dengan
// topchatStore palsu: harus kehitung, harus bertahan lewat "restart".
const os   = require('os');
const tmp  = fs.mkdtempSync(path.join(os.tmpdir(), 'topchat-'));
fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
const srcBlok = grup.slice(grup.indexOf('const TOPCHAT_FILE'), grup.indexOf('topchatLoad();') + 13);

const harness = `
  const topchatStore = new Map();
  const __dirname = ${JSON.stringify(path.join(tmp, 'nested'))};
  ${srcBlok}
  topchatCount('g@g.us', '628111');   // pesan biasa
  topchatCount('g@g.us', '628111');   // command dari orang yang sama
  topchatCount('g@g.us', '628999');
  topchatSave();                      // flush manual (timer di-unref, jangan nunggu 5s)

  topchatStore.clear();               // == restart bot
  topchatLoad();
  const m = topchatStore.get('g@g.us');
  if (!m) throw new Error('statistik hilang setelah restart — persistensi nggak jalan');
  if (m.get('628111') !== 2) throw new Error('hitungan per member salah: ' + m.get('628111'));
  if (m.size !== 2) throw new Error('jumlah member salah: ' + m.size);
`;
new Function('require', 'path', 'fs', harness)(require, path, fs);
fs.rmSync(tmp, { recursive: true, force: true });

console.log('✓ listtotalpesan: hitung semua pesan, nomor polos, persist ke disk, tag nyantol');
