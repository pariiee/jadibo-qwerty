'use strict';
// ─── Probe tombol — 6 bentuk sekaligus, satu command ──────────────────────────
// WA nggak merender semua bentuk tombol secara seragam. Daripada nebak satu-satu
// (tiap tebakan = 1 siklus deploy), semua bentuk dikirim berurutan dengan label,
// lalu user bilang mana yang muncul di HP.
//
// Cara pakai: `.btnprobe` di chat pribadi (WA nge-drop listMessage di grup).

const { proto } = require('baileys');

const BTN  = proto.Message.ButtonsMessage.Button.Type;
const HDR  = proto.Message.ButtonsMessage.HeaderType;

const MENU_JSON = JSON.stringify({
  title: 'Pilih Menu ▾',
  sections: [{
    title: '🌟 FITUR TOMBOL',
    rows: [
      { title: '1. Ping',       description: 'Cek status bot',       id: 'lst_ping' },
      { title: '2. Menu Utama', description: 'Lihat daftar command', id: 'lst_menu' },
      { title: '3. Info Bot',   description: 'Info bot & owner',     id: 'lst_info' },
    ],
  }],
});

const QR_JSON = (text, id) => JSON.stringify({ display_text: text, id });

module.exports = async function btnProbeHandler(ctx) {
  const { command, jid, client, react, reply, botData } = ctx;

  if (command !== 'btnprobe') return false;

  const footer = botData.footer_text || 'Powered by YaaParBot';

  // 1) interactiveMessage + quick_reply — pakai messageParamsJson (cara LevviCode)
  const A = { interactiveMessage: {
    body:   { text: 'A. interactive + quick_reply (messageParamsJson)' },
    footer: { text: footer },
    nativeFlowMessage: {
      buttons: [{ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '📋 Menu', id: 'btn_test' }) }],
      messageParamsJson: '{"limited_time_offer":{"text":"","expiration_time":""},"bottom_sheet":{"in_thread_buttons_limit":10,"divider_indices":[0],"list_title":""}}',
    },
  } };

  // 2) buttonsMessage legacy — HeaderType TEXT
  const B = { buttonsMessage: {
    contentText: 'B. buttonsMessage (header TEXT)',
    footerText: footer,
    headerType: HDR.TEXT,
    buttons: [
      { buttonId: 'btn_test', buttonText: { displayText: '🏓 Ping' }, type: BTN.RESPONSE },
      { buttonId: 'btn_test', buttonText: { displayText: '📋 Menu' }, type: BTN.RESPONSE },
    ],
  } };

  // 3) buttonsMessage legacy — headerType EMPTY
  const C = { buttonsMessage: {
    contentText: 'C. buttonsMessage (header EMPTY)',
    footerText: footer,
    headerType: HDR.EMPTY,
    buttons: [
      { buttonId: 'btn_test', buttonText: { displayText: '🏓 Ping' }, type: BTN.RESPONSE },
    ],
  } };

  // 4) buttonsMessage + tombol NATIVE_FLOW di dalamnya
  const D = { buttonsMessage: {
    contentText: 'D. buttonsMessage + NATIVE_FLOW',
    footerText: footer,
    headerType: HDR.EMPTY,
    buttons: [{
      buttonId: 'btn_test',
      buttonText: { displayText: '📋 Menu' },
      type: BTN.NATIVE_FLOW,
      nativeFlowInfo: { name: 'quick_reply', paramsJson: QR_JSON('📋 Menu', 'btn_test') },
    }],
  } };

  // 5) interactiveMessage + single_select (dropdown)
  const E = { interactiveMessage: {
    body:   { text: 'E. interactive + single_select (dropdown)' },
    footer: { text: footer },
    nativeFlowMessage: {
      buttons: [{ name: 'single_select', buttonParamsJson: MENU_JSON }],
      messageParamsJson: '{}',
    },
  } };

  // 6) interactiveMessage + single_select + cta_url (campur, gaya .listbtn)
  const F = { interactiveMessage: {
    body:   { text: 'F. single_select + cta_url (campur)' },
    footer: { text: footer },
    nativeFlowMessage: {
      buttons: [
        { name: 'single_select', buttonParamsJson: MENU_JSON },
        { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: '🌐 Website', url: 'https://yapari.web.id', merchant_url: 'https://yapari.web.id' }) },
      ],
    },
  } };

  const variants = [['A', A], ['B', B], ['C', C], ['D', D], ['E', E], ['F', F]];

  await react('⏳');
  for (const [label, payload] of variants) {
    try {
      await client.message.send(jid, payload);
      await reply(`✅ *${label}* terkirim`);
    } catch (e) {
      await reply(`❌ *${label}* GAGAL kirim: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  await react('✅');
  await reply(
    '☝️ 6 bentuk tombol di atas (A–F).\n\n' +
    'Balas huruf mana yang tombolnya KELIHATAN di HP lu (boleh lebih dari satu).\n' +
    'Kalau nggak ada satu pun yang muncul, balas *NGGAK*.'
  );
  return true;
};
