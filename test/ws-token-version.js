const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../server'), 'utf8');
const start = source.indexOf("      if (data.type === 'subscribe_user')");
const end = source.indexOf("      if (data.type === 'subscribe'", start);
async function check(rows, throws = false) {
  const messages = [];
  let closed = false;
  const context = { data: { type: 'subscribe_user' }, ambilToken: () => 'test', process: { env: {} }, subscribedUserId: null, userSubscribers: new Map(), ws: { send: raw => messages.push(JSON.parse(raw)), close: () => { closed = true; } }, require: name => name === 'jsonwebtoken' ? { verify: () => ({ id: 7, tv: 2 }) } : { pool: { execute: async () => { if (throws) throw Error('offline'); return [rows]; } } } };
  await vm.runInNewContext('(async () => {' + source.slice(start, end) + '})()', context);
  return { messages, closed, size: context.userSubscribers.size };
}
(async () => {
  for (const [rows, throws] of [[[{ token_version: 1 }], false], [[], false], [[], true]]) {
    const result = await check(rows, throws);
    assert.equal(result.size, 0);
    assert.equal(result.messages[0].type, 'error');
    assert.equal(result.closed, true);
  }
  const valid = await check([{ token_version: 2 }]);
  assert.equal(valid.messages[0].type, 'subscribed_user');
  assert.equal(valid.size, 1);
  console.log('PASS WS token_version: revoked/missing user/database failure denied; current token accepted');
})().catch(error => { console.error(error); process.exitCode = 1; });
