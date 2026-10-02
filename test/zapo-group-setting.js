'use strict';
/**
 * test/zapo-group-setting.js
 * REGRESI: `.open` / `.close` (dan alias `.grupopen` / `.grupclose`) mati dengan
 * "Cannot read properties of undefined (reading 'off')".
 *
 * Akar: zapo `group.setSetting(groupJid, setting, enabled)` cuma kenal setting
 * `announcement|restrict|ephemeral|...`; plugin (warisan Baileys) manggil
 * `'open'`/`'close'`. `SETTING_TAGS['open']` = undefined -> `tags.off` meledak.
 * Adapter yang harus nerjemahin — bukan tiap call-site.
 *
 * Jalankan: node test/zapo-group-setting.js
 */
const assert = require('assert');
const A = require('../engine/zapo/client');

// Tiruan SETIA `WaGroupCoordinator.setSetting` zapo (3 baris yang meledak).
const SETTING_TAGS = {
  announcement: { on: 'announcement', off: 'not_announcement' },
  restrict:     { on: 'locked',       off: 'unlocked' },
};
const dipanggil = [];
const clientPalsu = {
  on: () => {},
  message: {},
  stores: {},
  group: {
    setSetting: async (groupJid, setting, enabled) => {
      const tags = SETTING_TAGS[setting];
      const tag = enabled ? tags.on : tags.off;   // <-- baris yang meledak
      dipanggil.push({ groupJid, setting, enabled, tag });
    },
  },
};

const { client: adapt } = A.createClient({ client: clientPalsu });
const GRUP = '628123456789-1612345678@g.us';

(async () => {
  // `.open` = grup dibuka = announce OFF
  await adapt.group.setSetting(GRUP, 'open');
  assert.deepStrictEqual(
    { s: dipanggil.at(-1).setting, e: dipanggil.at(-1).enabled },
    { s: 'announcement', e: false },
    '.open harus jadi announcement=false'
  );

  // `.close` = grup ditutup = announce ON
  await adapt.group.setSetting(GRUP, 'close');
  assert.deepStrictEqual(
    { s: dipanggil.at(-1).setting, e: dipanggil.at(-1).enabled },
    { s: 'announcement', e: true },
    '.close harus jadi announcement=true'
  );

  // nama setting zapo asli tetap diteruskan apa adanya
  await adapt.group.setSetting(GRUP, 'restrict', true);
  assert.strictEqual(dipanggil.at(-1).setting, 'restrict');
  assert.strictEqual(dipanggil.at(-1).enabled, true);

  // device suffix dibuang (perilaku lama, jangan sampai ikut rusak)
  assert.strictEqual(dipanggil.at(-1).groupJid, GRUP);

  console.log(`✅ zapo group.setSetting: ${dipanggil.length} panggilan, terjemahan benar`);
})();
