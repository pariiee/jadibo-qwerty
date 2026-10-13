'use strict';
/**
 * test/halaman-bot-slug.js — halaman /bot/:id & /config/:id harus hidup di URL slug.
 *
 * KENAPA ADA: perubahan slug pernah lolos ke produksi dengan regex botId lama
 * (`\/(\d+)\/?$`) yang hanya cocok ANGKA. Akibatnya `/bot/<slug>` langsung
 * mental ke /dashboard tanpa pesan — satu baris, nol error di log, dan nol tes
 * yang menangkapnya. Tes lama semua statis; yang ini MENJALANKAN halamannya.
 *
 * Yang diuji, di DOM asli (jsdom kalau ada, kalau tidak pakai DOM mini):
 *   1. `botIdDariPath()` menerima slug DAN nomor lama.
 *   2. `/bot/<slug>` TIDAK mengalihkan ke /dashboard.
 *   3. `/bot/<slug>` benar-benar memanggil `/api/bots/<slug>`.
 *   4. `/dashboard` tidak disalahartikan sebagai bot bernama "dashboard".
 *
 * jsdom tidak dipasang di proyek ini, jadi DOM-nya kecil dan buatan sendiri —
 * cukup untuk halaman ini (getElementById, fetch, location, alert, innerHTML).
 *
 * Jalankan: node test/halaman-bot-slug.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const baca = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');


/** Dokumen minimal supaya head.js bisa dimuat di luar browser. */
function docStub() {
  return {
    addEventListener() {}, removeEventListener() {},
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {} }),
    documentElement: { setAttribute() {}, removeAttribute() {}, dataset: {}, classList: { add() {}, remove() {} } },
    head: { appendChild() {} }, body: { appendChild() {} }, title: '',
  };
}

// ── 1. Kontrak helper (murni, tanpa DOM) ─────────────────────────────────────
console.log('=== 1. botIdDariPath() menerima slug & nomor lama ===');
const headJs = baca('public/js/head.js');
// Jalankan hanya bagian helper-nya di konteks bersih.
const sandbox = { window: {}, location: { pathname: '/' }, matchMedia: () => ({ matches: false, addEventListener() {} }) };
new Function('window', 'location', 'matchMedia', 'document', headJs)(sandbox.window, sandbox.location, sandbox.matchMedia, docStub());
const f = sandbox.window.botIdDariPath;
assert.strictEqual(typeof f, 'function', 'botIdDariPath tidak ter-export ke window');

const HARUS_JADI = [
  ['/bot/49q3733pfk75',   '49q3733pfk75'],   // slug — kasus yang dulu mental
  ['/bot/49q3733pfk75/',  '49q3733pfk75'],   // trailing slash
  ['/bot/4',              '4'],              // nomor lama
  ['/config/49q3733pfk75','49q3733pfk75'],
  ['/config/4',           '4'],
];
for (const [masuk, keluar] of HARUS_JADI) {
  assert.strictEqual(f(masuk), keluar, `botIdDariPath(${masuk}) harus ${keluar}`);
}

// Halaman lain TIDAK boleh dianggap bot — dulu `/dashboard` bisa lolos jadi
// "slug" dan halaman menembak /api/bots/dashboard.
const HARUS_NULL = ['/dashboard', '/', '/kuota', '/billing', '/bot', '/bot/', '/admin',
                    '/bot/x/y', '/konfigurasi/4', '/api/bots/4'];
for (const p of HARUS_NULL) {
  assert.strictEqual(f(p), null, `botIdDariPath(${p}) harus null, bukan id bot`);
}
console.log(`✅ ${HARUS_JADI.length} bentuk diterima, ${HARUS_NULL.length} halaman lain ditolak`);

// ── 2. Halaman benar-benar jalan (DOM mini) ──────────────────────────────────
console.log('\n=== 2. /bot/<slug> tidak mental ke /dashboard ===');

/** DOM mini: cukup untuk bot-stats.js. */
function domMini(idYangAda) {
  const dibuat = new Map();
  const el = (id) => {
    if (!dibuat.has(id)) {
      dibuat.set(id, {
        id, _html: '', textContent: '', value: '', href: '',
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener() {}, getAttribute: () => null, setAttribute() {},
        querySelector: () => null, querySelectorAll: () => [],
        get innerHTML() { return this._html; }, set innerHTML(v) { this._html = v; },
        get clientWidth() { return 900; }, get clientHeight() { return 360; },
        style: {}, getBoundingClientRect: () => ({ width: 900, height: 360, top: 0, left: 0 }),
      });
    }
    return dibuat.get(id);
  };
  idYangAda.forEach(id => dibuat.set(id, el(id)));
  return { el, list: dibuat };
}

function jalankanHalaman(berkas, pathname, idYangAda, responsApi) {
  const dom = domMini(idYangAda);
  const dipanggil = [];
  const pindah = [];

  const doc = {
    getElementById: (id) => (dom.list.has(id) ? dom.list.get(id) : null),
    // '#tbl-cmd tbody' dsb. → elemen permisif; yang diuji bukan isi tabelnya.
    querySelector: (s) => dom.list.get(s.replace(/^[#.]/, '').split(' ')[0]) || elPermisif(),
    querySelectorAll: () => [],
    addEventListener() {}, createElement: () => el(),
    documentElement: { setAttribute() {}, removeAttribute() {}, dataset: {}, classList: { add() {}, remove() {} } },
    head: { appendChild() {} }, title: '', body: {},
  };
  function el() { return { style: {}, classList: { add() {}, remove() {} }, appendChild() {}, setAttribute() {} }; }
  function elPermisif() {
    return {
      innerHTML: '', textContent: '', value: '', href: '', style: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      addEventListener() {}, appendChild() {}, setAttribute() {}, getAttribute: () => null,
      querySelector: () => elPermisif(), querySelectorAll: () => [],
      getBoundingClientRect: () => ({ width: 900, height: 360, top: 0, left: 0 }),
    };
  }

  const loc = { pathname, href: pathname };
  Object.defineProperty(loc, 'href', {
    get: () => loc._h || pathname,
    set: (v) => { pindah.push(v); loc._h = v; },
  });

  const win = {
    addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
    botHref: (b) => b?.slug || b?.id, botIdDariPath: null, platIcon: () => '<svg></svg>',
    setTimeout, clearTimeout, location: loc,
  };

  const fetchStub = (url) => {
    dipanggil.push(String(url));
    for (const [cocok, hasil] of Object.entries(responsApi)) {
      if (String(url).includes(cocok)) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(hasil) });
      }
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: false }) });
  };

  const kode = baca(berkas);
  // Helper head.js dipanggil sebagai GLOBAL oleh halaman (botIdDariPath(...)),
  // bukan lewat window. — jadi harus jadi parameter, bukan cuma properti window.
  const fn = new Function('window', 'document', 'location', 'fetch', 'alert', 'setTimeout', 'clearTimeout',
    'requestAnimationFrame', 'botIdDariPath', 'botHref', 'platIcon', kode);
  // head.js dulu: menyediakan botIdDariPath & botHref.
  const headSandbox = { window: {}, location: { pathname }, matchMedia: win.matchMedia };
  new Function('window', 'location', 'matchMedia', 'document', headJs)(headSandbox.window, headSandbox.location, headSandbox.matchMedia, docStub());
  win.botIdDariPath = headSandbox.window.botIdDariPath;
  win.botHref = headSandbox.window.botHref;
  win.platIcon = headSandbox.window.platIcon;

  doc.defaultView = win;
  fn(win, doc, loc, fetchStub, () => {}, setTimeout, clearTimeout, (cb) => setTimeout(cb, 0),
     win.botIdDariPath, win.botHref, win.platIcon);

  return new Promise((res) => setTimeout(() => res({ dipanggil, pindah }), 30));
}

const SLUG = '49q3733pfk75';
const ID_ADA = ['hdr-name', 'hdr-icon', 'hdr-dot', 'hdr-status', 'btn-config', 'chart',
                'chart-sum', 'st-cmd', 'st-usr', 'st-err', 'st-lim', 'tbl-cmd', 'tbl-usr'];
const BOT_RESP = { ok: true, bot: { id: 4, slug: SLUG, bot_name: 'zapo BOT', platform: 'whatsapp', is_running: 1, status: 'connected' } };
const STATS_RESP = { ok: true, ringkas: { cmd_total: 10, user_aktif: 2, err_total: 0, limit_total: 0, hari: 7 }, cmd: [], user: [], error: [], harian: [] };
// Urutan penting: URL stats JUGA memuat '/api/bots/<slug>/stats', jadi '/stats'
// harus dicek DULU — kalau tidak, respons bot yang dipakai untuk permintaan stats.
const RESP = {
  '/stats': STATS_RESP,
  ['/api/bots/' + SLUG]: BOT_RESP,
};

(async () => {
  const slugRun = await jalankanHalaman('public/js/bot-stats.js', `/bot/${SLUG}`, ID_ADA, RESP);
  assert.ok(!slugRun.pindah.includes('/dashboard'),
    `halaman /bot/${SLUG} mental ke /dashboard — penyebab paling umum: regex botId cuma cocok angka`);
  assert.ok(slugRun.dipanggil.some((u) => u === '/api/bots/' + SLUG),
    `tidak memanggil /api/bots/${SLUG}; yang dipanggil: ${slugRun.dipanggil.join(', ')}`);
  console.log(`✅ /bot/${SLUG} → tanpa alih-alih, memanggil ${slugRun.dipanggil.filter(u=>u.startsWith('/api')).join(', ')}`);

  // Nomor lama harus tetap jalan juga.
  const nomorRun = await jalankanHalaman('public/js/bot-stats.js', '/bot/4', ID_ADA,
    { '/stats': STATS_RESP, '/api/bots/4': BOT_RESP });
  assert.ok(!nomorRun.pindah.includes('/dashboard'), 'halaman /bot/4 mental ke /dashboard');
  assert.ok(nomorRun.dipanggil.some((u) => u === '/api/bots/4'), 'halaman /bot/4 tidak memanggil bota');
  console.log('✅ /bot/4 (nomor lama) tetap jalan');

  // ── 3. Tidak ada halaman yang menulis regex botId sendiri ─────────────────
  console.log('\n=== 3. Tidak ada regex botId lokal yang tertinggal ===');
  for (const berkas of ['public/js/bot-stats.js', 'public/js/bot-detail.js', 'public/js/config.js']) {
    const t = baca(berkas);
    assert.ok(!/pathname\.match/.test(t),
      `${berkas} masih menulis regex pathname sendiri — pakai botIdDariPath()`);
    assert.ok(/botIdDariPath\(/.test(t), `${berkas} tidak memakai botIdDariPath()`);
  }
  console.log('✅ 3 halaman memakai helper bersama');

  console.log('\nsemua ok — halaman bot hidup di URL slug maupun nomor lama');
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
