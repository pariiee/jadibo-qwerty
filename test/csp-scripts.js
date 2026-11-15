'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
function walk(dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
}
const server = read('server.js');
assert(!/scriptSrc:\s*\[[^\]]*unsafe-inline/.test(server));
assert(/scriptSrcAttr:\s*\["'none'"\]/.test(server));
assert(!/javascript:/i.test(server));
for (const f of walk('public').filter(f => /\.(html|js)$/.test(f) && !f.includes('/vendor/'))) {
  const text = read(f);
  assert(!/javascript:/i.test(text), f);
  if (f.endsWith('.html')) {
    assert(!/\son\w+\s*=/i.test(text), f);
    for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      assert(/\bsrc\s*=/.test(m[1]) && !m[2].trim(), f);
      const src = /src="([^"?]+)/.exec(m[1])?.[1];
      if (src?.startsWith('/')) assert(fs.existsSync(path.join(root, 'public', src)), `${f}: ${src}`);
    }
  } else {
    assert(!/\son\w+\s*=\s*["']/.test(text.replace(/^\s*\/\/.*$/gm, '')), f);
    new vm.Script(text, { filename: f });
  }
}
assert(read('public/admin.html').includes('<script src="/js/admin-init.js"></script>'));
let written = '';
const title = {}, desc = {};
vm.runInNewContext(read('public/js/admin-init.js'), {
  location: { pathname: '/admin/bots', hash: '' },
  document: { getElementById: id => id === 'admin-page-title' ? title : desc, write: s => { written += s; } }
});
assert.equal(title.textContent, 'Manajemen Bot');
assert(written.includes('#pane-bot'));
let click, reloads = 0;
const context = { window: {}, document: { addEventListener: (_, fn) => { click = fn; } }, location: { reload: () => reloads++ }, console };
vm.runInNewContext(read('public/js/act.js'), context);
let prevented = false;
click({ target: { closest: () => ({ dataset: { act: 'muatUlang' } }) }, preventDefault: () => { prevented = true; } });
assert(prevented && reloads === 1);
let retry;
vm.runInNewContext(read('public/assets/offline.js'), {
  document: { getElementById: id => { assert.equal(id, 'btn-retry'); return { addEventListener: (_, fn) => { retry = fn; } }; } },
  location: { reload: () => reloads++ }
});
retry();
assert.equal(reloads, 2);
(async () => {
  const listeners = {};
  const cached = new Map();
  const sw = {
    self: { origin: 'https://test.invalid', addEventListener: (type, fn) => { listeners[type] = fn; }, skipWaiting() {}, clients: { claim() {} } },
    URL,
    caches: { open: async () => ({ addAll: async files => { for (const f of files) cached.set(f, read('public' + (f === '/privacy' || f === '/terms' ? f + '.html' : f))); } }), match: async req => cached.get(typeof req === 'string' ? req : new URL(req.url).pathname) },
    fetch: async () => { throw new Error('offline'); }
  };
  vm.runInNewContext(read('public/sw.js'), sw);
  let pending;
  listeners.install({ waitUntil: p => { pending = p; } });
  await pending;
  assert(cached.has('/assets/offline.js'));
  let response;
  listeners.fetch({ request: { url: 'https://test.invalid/dashboard', method: 'GET', mode: 'navigate' }, respondWith: p => { response = p; } });
  assert((await response).includes('/assets/offline.js'));
  listeners.fetch({ request: { url: 'https://test.invalid/assets/offline.js', method: 'GET', mode: 'no-cors' }, respondWith: p => { response = p; } });
  assert.equal(await response, read('public/assets/offline.js'));
  console.log('CSP scans, admin synchronous initialization, delegated reload, offline retry and service-worker fallback PASS');
})().catch(err => { console.error(err); process.exitCode = 1; });
