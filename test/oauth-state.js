const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(require.resolve('../controllers/authController'), 'utf8');
const section = source.slice(source.indexOf('const GOOGLE_CLIENT_ID'), source.indexOf('/**', source.indexOf('async function googleCallback')));
let exchanges = 0;
const context = { process: { env: { GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'test' } }, crypto, Buffer, URLSearchParams, fetch: async () => { exchanges++; return { ok: false, json: async () => ({}) }; }, console: { error() {} } };
vm.createContext(context);
vm.runInContext(section, context);
function response() {
  return { cookies: [], cleared: [], cookie(...args) { this.cookies.push(args); }, clearCookie(...args) { this.cleared.push(args); }, redirect(url) { this.url = url; }, status(code) { this.code = code; return this; }, send(text) { this.text = text; } };
}
(async () => {
  const res = response();
  context.googleRedirect({ protocol: 'https' }, res);
  const state = new URL(res.url).searchParams.get('state');
  assert.match(state || '', /^[a-f0-9]{64}$/);
  assert.equal(res.cookies[0][1], state);
  assert.equal(res.cookies[0][2].httpOnly, true);
  assert.equal(res.cookies[0][2].secure, true);
  assert.equal(res.cookies[0][2].sameSite, 'lax');
  assert.equal(res.cookies[0][2].maxAge, 600000);
  for (const query of [{ code: 'x' }, { code: 'x', state: 'bad' }, { code: 'x', state: [state] }]) {
    const denied = response();
    await context.googleCallback({ query, cookies: { google_oauth_state: state }, protocol: 'https' }, denied);
    assert.equal(exchanges, 0);
    assert.equal(denied.cleared.length, 1);
  }
  await context.googleCallback({ query: { code: 'x', state }, cookies: {}, protocol: 'https' }, response());
  assert.equal(exchanges, 0);
  await context.googleCallback({ query: { code: 'x', state }, cookies: { google_oauth_state: state }, protocol: 'https' }, response());
  assert.equal(exchanges, 1);
  console.log('PASS OAuth state: random cookie, flags, missing/mismatched/array state rejected before exchange, valid state accepted');
})().catch(error => { console.error(error); process.exitCode = 1; });
