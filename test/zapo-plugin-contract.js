'use strict';
/**
 * test/zapo-plugin-contract.js
 * Tiap method yang plugin panggil lewat `sock.*` / `client.*` HARUS ada di
 * adapter zapo. Kalau nggak, plugin-nya load mulus tapi meledak pas dipakai
 * ("sock.message.prepareMedia is not a function") — dan cuma kelihatan di
 * produksi saat user ngetik command-nya.
 *
 * Jalankan: node test/zapo-plugin-contract.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const A = require('../engine/zapo/client');

// ── 1. Kumpulkan tiap `sock.X.Y` / `client.X.Y` yang plugin panggil ──────────
const dir = path.resolve(__dirname, '../plugins');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();

const dipakai = new Map(); // 'message.send' -> [file, ...]
for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  // `sock.` / `client.` / `ctx.sock.` — dua tingkat (namespace.method)
  const re = /\b(?:ctx\.)?(?:sock|client)\.([a-zA-Z_]+)\.([a-zA-Z_]+)/g;
  let m;
  while ((m = re.exec(src))) {
    const k = `${m[1]}.${m[2]}`;
    if (!dipakai.has(k)) dipakai.set(k, new Set());
    dipakai.get(k).add(f);
  }
}

// ── 2. Adapter asli (pakai raw client palsu, cukup buat enumerasi) ───────────
const EventEmitter = require('events');
const fakeEv = new EventEmitter();
const { client: adapt } = A.createClient({
  client: { on: (...a) => fakeEv.on(...a), message: {}, group: {}, stores: {} },
});

const jalur = (obj, p) => p.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

// Namespace yang boleh berbentuk OBJEK (bukan fungsi) — isinya method lebih
// dalam (`stores.contacts.getByJid`), jadi pola `sock.X.Y` di sini bukan method.
const NS_OBJEK = new Set(['stores.contacts', 'stores', 'auth', 'lid', 'raw', 'ev']);

console.log(`── Kontrak plugin -> adapter (${dipakai.size} method unik) ──`);
const hilang = [];
for (const [k, pemakai] of [...dipakai.entries()].sort()) {
  const fn = jalur(adapt, k);
  const ok = typeof fn === 'function' || NS_OBJEK.has(k);
  const label = typeof fn === 'function' ? '' : (NS_OBJEK.has(k) ? ' (namespace)' : '');
  if (!ok) hilang.push(`${k}  (dipakai: ${[...pemakai].join(', ')})`);
  console.log(`  ${ok ? '✓' : '✗'} ${k.padEnd(34)}${label} ${[...pemakai].join(', ')}`);
}

// ── 3. Method yang khusus dibutuhkan (di luar pola sock.X.Y) ─────────────────
// `client.getCurrentCredentials`, `client.authState`, `client.contact` dipakai
// dengan `?.` jadi opsional — tapi kalau ADA, harus jalan.
console.log('\n── Method opsional yang dipakai `?.` ──');
for (const k of ['getCredentials', 'getCurrentCredentials']) {
  const ada = typeof jalur(adapt, k) === 'function';
  console.log(`  ${ada ? '✓' : '·'} client.${k} ${ada ? '' : '(opsional, call-site pakai ?.)'}`);
}

// ── 4. Namespace yang plugin pakai harus lengkap ────────────────────────────
console.log('\n── Namespace adapter ──');
for (const ns of ['message', 'group', 'profile', 'privacy', 'business', 'newsletter', 'status', 'stores', 'auth', 'lid']) {
  const ada = typeof adapt[ns] === 'object' && adapt[ns] !== null;
  console.log(`  ${ada ? '✓' : '✗'} client.${ns}`);
  if (!ada) hilang.push(`namespace ${ns}`);
}

// ── 5. Lifecycle yang engine butuh ──────────────────────────────────────────
console.log('\n── Lifecycle ──');
for (const k of ['on', 'once', 'off', 'connect', 'disconnect', 'logout', 'isConnected']) {
  const ada = typeof adapt[k] === 'function';
  console.log(`  ${ada ? '✓' : '✗'} client.${k}`);
  if (!ada) hilang.push(`lifecycle ${k}`);
}

if (hilang.length) {
  console.error(`\n❌ GAGAL — ${hilang.length} method plugin nggak ada di adapter:`);
  for (const h of hilang) console.error(`   - ${h}`);
  process.exit(1);
}
console.log(`\n✅ ${dipakai.size} method plugin + namespace + lifecycle semua ada di adapter zapo`);
