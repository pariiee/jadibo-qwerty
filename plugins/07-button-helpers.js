'use strict';
/**
 * plugins/07-button-helpers.js
 * Helper tombol yang dipakai lintas plugin (07-button.js, 05-owner.js).
 * Dipisah biar nggak dua tempat ngopi payload yang sama.
 */

const fs = require('fs');
const path = require('path');
const { genThumbnail } = require('../engine/thumbnail');

/**
 * Kirim daftar kategori sebagai dropdown `single_select`.
 * Header lokasi + thumbnail WAJIB: bubble native-flow tanpa header dirender WA
 * sebagai teks polos, tombolnya ilang (bentuk header ini yang kebukti jalan).
 * Label tombol sengaja cuma `📂` — user nggak mau ada teks "Pilih Kategori".
 */
async function sendCategoryDropdown(ctx) {
  const { client, jid } = ctx;
  const { CATS, CAT_KEYS, catLabel } = require('./01-info');

  let header;
  try {
    const banner = fs.readFileSync(path.resolve(ctx.botData?.banner_url || process.env.BANNER_DEFAULT));
    const thumb = await genThumbnail(banner, 'image/jpeg', 300) || banner;
    header = {
      hasMediaAttachment: true,
      locationMessage: {
        degreesLatitude: 0,
        degreesLongitude: 0,
        name: ctx.botData?.bot_name || 'YaaParBot',
        address: 'yapari.web.id',
        jpegThumbnail: thumb,
      },
    };
  } catch { /* banner nggak kebaca → kirim tanpa header */ }

  await client.message.send(jid, {
    interactiveMessage: {
      ...(header ? { header } : {}),
      body: { text: '📂 *Pilih Kategori*\nKetuk tombol di bawah untuk buka daftar menu.' },
      footer: { text: ctx.botData?.footer_text || 'Powered by YaaParBot' },
      nativeFlowMessage: {
        buttons: [{
          name: 'single_select',
          buttonParamsJson: JSON.stringify({
            title: '📂',
            sections: [{
              title: 'Kategori',
              highlight_label: 'YaaPar Menu',
              rows: CAT_KEYS.map(k => ({
                title: catLabel(k),
                description: `${CATS[k].length} Command`,
                id: `.menu ${k}`,
              })),
            }],
          }),
        }],
        messageParamsJson: '{}',
      },
    },
  });
  return true;
}

module.exports = { sendCategoryDropdown };
