'use strict';

/**
 * plugins/03-sticker.js
 * Commands: tomp4, topng
 * Convert sticker webp → mp4 atau png via YaPari API
 */

const axios              = require('axios');
const FormData           = require('form-data');
const mess               = require('../config/mess');
const { genThumbnail }   = require('../engine/thumbnail');

module.exports = async function stickerConvertHandler(ctx) {
  if (!ctx.isCmd) return false;

  const { command, reply, react, client, jid, msg, botData, isGroup } = ctx;

  if (command !== 'tomp4' && command !== 'topng') return false;

  const rawMsg     = msg.message || {};
  const msgType    = Object.keys(rawMsg)[0] || '';
  const quoted     = rawMsg?.extendedTextMessage?.contextInfo?.quotedMessage;
  const quotedType = quoted ? Object.keys(quoted)[0] : null;

  const isDirectSticker = msgType === 'stickerMessage';
  const isQuotedSticker = quotedType === 'stickerMessage';

  if (!isDirectSticker && !isQuotedSticker) {
    await reply(`Reply stiker dengan ${botData.prefix}${command} untuk mengkonversi`);
    return true;
  }

  try {
    await react(mess.reactLoading);

    // ── Download buffer stiker ───────────────────────────────────────────────
    let buffer;
    if (isDirectSticker) {
      const content = rawMsg.stickerMessage;
      const fixed   = Object.assign({}, content);
      for (const f of ['mediaKey', 'fileSha256', 'fileEncSha256']) {
        if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
      }
      buffer = Buffer.from(await client.message.downloadBytes({ stickerMessage: fixed }));
    } else {
      const content = quoted.stickerMessage;
      const fixed   = Object.assign({}, content);
      for (const f of ['mediaKey', 'fileSha256', 'fileEncSha256']) {
        if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
      }
      buffer = Buffer.from(await client.message.downloadBytes({ stickerMessage: fixed }));
    }

    // ── Upload via YaPari untuk dapat URL publik ────────────────────────────
    const form = new FormData();
    form.append('file', buffer, { filename: `sticker_${Date.now()}.webp`, contentType: 'image/webp' });
    const uploadRes = await axios.post(`${process.env.BASE_API}api/tools/upload`, form, {
      headers: {
        ...form.getHeaders(),
        'X-API-Key': process.env.KEY_API,
      },
      timeout: 20000,
    });

    const fileUrl = uploadRes.data?.results?.file_url;
    console.log(`[TOMP4/TOPNG] fileUrl: ${fileUrl}`);
    if (!fileUrl) {
      await react(mess.reactError);
      await reply(mess.error);
      return true;
    }

    // ── Hit YaPari API convert ───────────────────────────────────────────────
    const endpoint = command === 'tomp4' ? 'api/tools/webptomp4' : 'api/tools/webptopng';
    const convertRes = await axios.get(`${process.env.BASE_API}${endpoint}`, {
      params: { url: fileUrl },
      headers: { 'X-API-Key': process.env.KEY_API },
      responseType: 'arraybuffer',
      timeout: 30000,
    });

    const resultBuffer = Buffer.from(convertRes.data);

    // ── Generate thumbnail untuk preview ────────────────────────────────────
    const mime         = command === 'tomp4' ? 'video/mp4' : 'image/png';
    const jpegThumbnail = await genThumbnail(resultBuffer, mime);

    if (command === 'tomp4') {
      await client.message.send(jid, {
        type: 'video',
        media: resultBuffer,
        mimetype: 'video/mp4',
        caption: '',
        ...(jpegThumbnail ? { jpegThumbnail } : {}),
      });
    } else {
      await client.message.send(jid, {
        type: 'image',
        media: resultBuffer,
        mimetype: 'image/png',
        caption: '',
        ...(jpegThumbnail ? { jpegThumbnail } : {}),
      });
    }

    await react(mess.reactSuccess);
  } catch (e) {
    await react(mess.reactError);
    await reply(`${mess.error}\n${e.message}`);
  }

  return true;
};
