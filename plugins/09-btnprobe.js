'use strict';
// ─── Probe tombol — 6 bentuk sekaligus, satu command ──────────────────────────
// WA nggak merender semua bentuk tombol secara seragam. Daripada nebak satu-satu
// (tiap tebakan = 1 siklus deploy), semua bentuk dikirim berurutan dengan label,
// lalu user bilang mana yang muncul di HP.
//
// Cara pakai: `.btnprobe` di chat pribadi (WA nge-drop listMessage di grup).

const { proto } = require('baileys');
const fs   = require('fs');
const path = require('path');
const { genThumbnail } = require('../engine/thumbnail');

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

  // ── G–J: kartu "verif" (contextInfo.externalAdReply) ────────────────────────
  // .test mati total begitu externalAdReply ditempel di interactiveMessage-nya
  // (cuma reaksi ✅ yg nongol). Empat bentuk ini buat nyari batasnya:
  // G = bentuk .test persis, H = tanpa header lokasi, I = tanpa thumbnail,
  // J = teks polos (baseline yg paling sering jalan di bot lain).
  let thumb = null;
  try {
    const banner = fs.readFileSync(path.resolve(botData.banner_url || process.env.BANNER_DEFAULT));
    thumb = await genThumbnail(banner, 'image/jpeg', 300) || banner;
  } catch { /* banner nggak kebaca -> varian thumbnail di-skip */ }

  const adReply = (pakaiThumb) => ({
    title: 'YaaParBot',
    body: 'yapari.web.id',
    mediaType: 1, // IMAGE
    ...(pakaiThumb && thumb ? { thumbnail: thumb } : {}),
    sourceUrl: 'https://yapari.web.id',
    renderLargerThumbnail: false,
    showAdAttribution: false,
  });

  const WEB_JSON = JSON.stringify({
    display_text: '🌐 Website', url: 'https://yapari.web.id', merchant_url: 'https://yapari.web.id',
  });

  // 7) bentuk .test persis: header lokasi + tombol + externalAdReply
  const G = { interactiveMessage: {
    header: {
      hasMediaAttachment: true,
      locationMessage: {
        degreesLatitude: 0, degreesLongitude: 0,
        name: 'YaaParBot', address: 'yapari.web.id', jpegThumbnail: thumb,
      },
    },
    body:   { text: 'G. interactive + header lokasi + externalAdReply (bentuk .test)' },
    footer: { text: footer },
    nativeFlowMessage: { buttons: [{ name: 'cta_url', buttonParamsJson: WEB_JSON }], messageParamsJson: '{}' },
    contextInfo: { externalAdReply: adReply(true) },
  } };

  // 8) interactive tanpa header lokasi + externalAdReply
  const H = { interactiveMessage: {
    body:   { text: 'H. interactive TANPA header + externalAdReply (pakai thumbnail)' },
    footer: { text: footer },
    nativeFlowMessage: { buttons: [{ name: 'cta_url', buttonParamsJson: WEB_JSON }], messageParamsJson: '{}' },
    contextInfo: { externalAdReply: adReply(true) },
  } };

  // 9) interactive + externalAdReply tanpa thumbnail (biar ketahuan thumbnail-nya yg ditolak atau bukan)
  const I = { interactiveMessage: {
    body:   { text: 'I. interactive + externalAdReply TANPA thumbnail' },
    footer: { text: footer },
    nativeFlowMessage: { buttons: [{ name: 'cta_url', buttonParamsJson: WEB_JSON }], messageParamsJson: '{}' },
    contextInfo: { externalAdReply: adReply(false) },
  } };

  // 10) teks polos + externalAdReply — baseline
  const J = {
    text: 'J. teks polos + externalAdReply (baseline)',
    contextInfo: { externalAdReply: adReply(true) },
  };

  const variants = [['A', A], ['B', B], ['C', C], ['D', D], ['E', E], ['F', F],
                    ['G', G], ['H', H], ['I', I], ['J', J]];

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
    '☝️ 10 bentuk di atas (A–J).\n\n' +
    'Balas huruf mana yang KELIHATAN di HP lu (boleh lebih dari satu).\n' +
    'Kalau nggak ada satu pun yang muncul, balas *NGGAK*.\n\n' +
    'Catatan: G–J itu percobaan kartu "verif" (yapari.web.id) — G = bentuk .test persis.'
  );
  return true;
};
