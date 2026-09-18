'use strict';
/**
 * test/gcutama.js — cek `.gcutama` beneran nulis kolom main_groups
 * (yang kebaca di botdetail/konfigurasi) dan langsung ngubah gate grup di engine.
 *
 * Jalanin: node test/gcutama.js
 */

// ── Stub DB sebelum plugin di-require (pool.execute nggak boleh nyentuh MySQL) ──
const dbPath = require.resolve('../config/database');
const sql = [];
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    pool: { execute: async (q, p = []) => { sql.push([q, p]); return [[], []]; } },
    testConnection: async () => {}, seedDefaults: async () => {},
    incrementStat: async () => {}, decrementStat: async () => {}, getStats: async () => ({}),
  },
};

const handler = require('../plugins/05-owner');
const assert  = require('assert');

const GC = '120363403895277092@g.us';
let out = [];
const ctxOf = (botData, args = []) => ({
  isCmd: true, command: 'gcutama', args,
  body: `.gcutama ${args.join(' ')}`.trim(),
  reply: async (t) => { out.push(t); },
  react: async () => {},
  client: {
    group: {
      queryGroupMetadata: async () => ({ subject: 'TESTER GWEH', participants: [] }),
      queryAllGroups: async () => [],
    },
    message: { send: async () => ({}) },
  },
  jid: GC, sender: '6287778032605@s.whatsapp.net', isGroup: true,
  mentioned: [], botData,
});

(async () => {
  let pass = 0;
  const ok = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

  // 1. mode bebas (main_groups NULL) -> grup ini jadi utama
  let botData = { id: 1, prefix: '.', owner_number: '6287778032605', main_groups: null };
  out = []; sql.length = 0;
  await handler(ctxOf(botData));
  console.log('\n[1] main_groups NULL -> .gcutama');
  console.log(out.map(t => '    ' + t.replace(/\n/g, '\n    ')).join('\n'));
  console.log('    SQL: ' + JSON.stringify(sql.filter(s => /main_groups/.test(s[0]))));
  ok('DB ditulis + objek botData ikut berubah (gate langsung kepake)', () => {
    const w = sql.find(s => /UPDATE bots SET main_groups/.test(s[0]));
    assert.ok(w, 'nggak ada UPDATE main_groups');
    assert.deepStrictEqual(w[1], [GC, 1]);
    assert.strictEqual(botData.main_groups, GC);
  });
  ok('balasannya nyebut ID grup + peringatan keluar dari grup lain', () => {
    assert.ok(out.some(t => t.includes(GC)), 'ID grup nggak muncul');
    assert.ok(out.some(t => /keluar dari grup lain/.test(t)));
  });

  // 2. grup lain ditambahin -> jadi 2 (dedupe)
  const GC2 = '120363111111111111@g.us';
  botData = { ...botData, main_groups: GC2 };
  out = []; sql.length = 0;
  await handler(ctxOf(botData));
  console.log('\n[2] main_groups = grup lain -> .gcutama');
  console.log(out.map(t => '    ' + t.replace(/\n/g, '\n    ')).join('\n'));
  ok('nambah, bukan nimpa', () => {
    assert.strictEqual(botData.main_groups, `${GC2},${GC}`);
  });

  // 3. dijalanin 2x -> nggak dobel
  out = []; sql.length = 0;
  await handler(ctxOf(botData));
  console.log('\n[3] dijalanin lagi -> ' + out.join(' | '));
  ok('idempotent (nggak nulis DB lagi)', () => {
    assert.strictEqual(botData.main_groups, `${GC2},${GC}`);
    assert.strictEqual(sql.filter(s => /UPDATE bots SET main_groups/.test(s[0])).length, 0);
    assert.ok(out[0].includes('sudah jadi grup utama'));
  });

  // 4. off -> dicabut
  out = []; sql.length = 0;
  await handler(ctxOf(botData, ['off']));
  console.log('\n[4] .gcutama off');
  console.log(out.map(t => '    ' + t.replace(/\n/g, '\n    ')).join('\n'));
  ok('dicabut, sisa grup lain masih ada', () => {
    assert.strictEqual(botData.main_groups, GC2);
    assert.strictEqual(sql.find(s => /UPDATE bots SET main_groups/.test(s[0]))[1][0], GC2);
  });

  // 5. off di grup terakhir -> NULL + warning mode bebas
  botData = { ...botData, main_groups: GC };
  out = []; sql.length = 0;
  await handler(ctxOf(botData, ['off']));
  console.log('\n[5] .gcutama off (grup terakhir)');
  console.log(out.map(t => '    ' + t.replace(/\n/g, '\n    ')).join('\n'));
  ok('jadi NULL + warning mode bebas', () => {
    assert.strictEqual(botData.main_groups, null);
    assert.strictEqual(sql.find(s => /UPDATE bots SET main_groups/.test(s[0]))[1][0], null);
    assert.ok(out.some(t => /kosong.*mode bebas/s.test(t)));
  });

  // 6. bukan grup -> ditolak
  out = [];
  const dm = ctxOf({ id: 1, prefix: '.', owner_number: '6287778032605', main_groups: null });
  dm.isGroup = false;
  await handler(dm);
  ok('di DM ditolak (fitur grup doang)', () => assert.ok(out[0].includes('grup')));

  console.log(`\ngcutama: ${pass}/${pass} PASS`);
})().catch(e => { console.error('FAIL: ' + e.message); process.exit(1); });
