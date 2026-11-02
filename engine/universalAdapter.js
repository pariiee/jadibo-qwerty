'use strict';

/**
 * engine/universalAdapter.js
 * Universal message & context adapter untuk Telegram & Discord.
 * Menjembatani kontrak `client.message.send(...)` dan `ctx.reply(...)`
 * yang dipakai oleh seluruh plugins yaparbots.
 */

function extractTextFromPayload(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return (
    content.text ||
    content.caption ||
    content.buttonsMessage?.contentText ||
    content.buttonsMessage?.caption ||
    content.interactiveMessage?.body?.text ||
    content.interactiveMessage?.header?.title ||
    content.templateMessage?.hydratedTemplate?.hydratedContentText ||
    content.extendedTextMessage?.text ||
    content.conversation ||
    ''
  );
}

function createUniversalClient(platform, rawBot, chatId, rawMsg) {
  return {
    platform,
    rawBot,
    message: {
      async send(targetJid, content) {
        const destId = targetJid || chatId;

        // Voice note jingle menu WA jangan dikirim ke Telegram/Discord
        if (content?.ptt && (platform === 'telegram' || platform === 'discord')) {
          return true;
        }

        // 1. Kirim pesan Telegram (node-telegram-bot-api)
        if (platform === 'telegram') {
          const audioBuf = content.audio || (content.type === 'audio' ? content.media : null);
          if (audioBuf) {
            return rawBot.sendAudio(destId, audioBuf, { caption: content.caption || '' }).catch(() => rawBot.sendDocument(destId, audioBuf, {}, { filename: 'audio.mp3' }));
          }
          const imageBuf = content.image || (content.type === 'image' ? content.media : null);
          if (imageBuf) {
            return rawBot.sendPhoto(destId, imageBuf, { caption: content.caption || '' });
          }
          const videoBuf = content.video || (content.type === 'video' ? content.media : null);
          if (videoBuf) {
            return rawBot.sendVideo(destId, videoBuf, { caption: content.caption || '' });
          }
          const docBuf = content.document || (content.type === 'document' ? content.media : null);
          if (docBuf) {
            return rawBot.sendDocument(destId, docBuf, {}, { filename: content.fileName || 'file.bin' });
          }
          if (content.type === 'reaction') {
            return true;
          }

          const textMsg = extractTextFromPayload(content);
          if (textMsg) {
            return rawBot.sendMessage(destId, textMsg, { parse_mode: 'HTML' })
              .catch(() => rawBot.sendMessage(destId, textMsg));
          }
          return rawBot.sendMessage(destId, JSON.stringify(content));
        }

        // 2. Kirim pesan Discord (discord.js)
        if (platform === 'discord') {
          const channel = rawMsg?.channel || (rawBot.channels?.cache?.get ? rawBot.channels.cache.get(destId) : null);
          const isInteraction = !!(rawMsg?.isChatInputCommand && rawMsg.isChatInputCommand());
          if (!channel && !isInteraction) return null;

          const deliver = async (data) => {
            if (isInteraction) {
              if (rawMsg.deferred || rawMsg.replied) return rawMsg.editReply(data);
              return rawMsg.reply(data);
            }
            return channel.send(data);
          };

          const sendSafeText = async (txt) => {
            const str = String(txt || '');
            if (str.length <= 1950) return deliver(str);
            let last;
            for (let i = 0; i < str.length; i += 1900) {
              last = await deliver(str.slice(i, i + 1900));
            }
            return last;
          };

          if (content.embed || content.embeds) {
            const embeds = content.embeds || [content.embed];
            return deliver({ content: content.text ? String(content.text).slice(0, 1950) : undefined, embeds });
          }
          const files = [];
          const img = content.image || (content.type === 'image' ? content.media : null);
          if (img) files.push({ attachment: img, name: 'image.jpg' });
          const vid = content.video || (content.type === 'video' ? content.media : null);
          if (vid) files.push({ attachment: vid, name: 'video.mp4' });
          const aud = content.audio || (content.type === 'audio' ? content.media : null);
          if (aud) files.push({ attachment: aud, name: 'audio.mp3' });
          const doc = content.document || (content.type === 'document' ? content.media : null);
          if (doc) files.push({ attachment: doc, name: content.fileName || 'file.bin' });

          const extractedCaption = extractTextFromPayload(content);
          if (files.length) {
            return deliver({ content: extractedCaption ? String(extractedCaption).slice(0, 1950) : undefined, files });
          }
          if (content.type === 'reaction' && rawMsg?.react) {
            return rawMsg.react(content.emoji).catch(() => {});
          }
          if (extractedCaption) {
            return sendSafeText(extractedCaption);
          }
          return sendSafeText(JSON.stringify(content, null, 2));
        }
      },
      async downloadBytes() {
        return Buffer.alloc(0);
      }
    }
  };
}

function buildUniversalContext({ platform, bot, chatId, senderId, pushName, text, rawMsg, botData }) {
  const universalClient = createUniversalClient(platform, bot, chatId, rawMsg);
  const prefix = botData?.prefix ?? '.';
  const body = String(text || '').trim();

  // Deteksi command: terima prefix bot (.), atau '/' untuk Telegram/Discord
  let isCmd = false;
  let command = '';
  let args = [];

  if (body.startsWith(prefix) && prefix !== '') {
    isCmd = true;
    const parts = body.slice(prefix.length).trim().split(/\s+/);
    command = (parts[0] || '').toLowerCase().replace(/@\w+$/i, '');
    args = parts.slice(1);
  } else if (body.startsWith('/')) {
    isCmd = true;
    const parts = body.slice(1).trim().split(/\s+/);
    command = (parts[0] || '').toLowerCase().replace(/@\w+$/i, '');
    args = parts.slice(1);
  } else if (body.startsWith('.')) {
    isCmd = true;
    const parts = body.slice(1).trim().split(/\s+/);
    command = (parts[0] || '').toLowerCase().replace(/@\w+$/i, '');
    args = parts.slice(1);
  }

  const jid = String(chatId);
  const sender = String(senderId || chatId);

  return {
    sock: universalClient,
    client: universalClient,
    msg: rawMsg,
    botData: botData || {},
    jid,
    sender,
    isGroup: platform === 'telegram' ? (rawMsg?.chat?.type === 'group' || rawMsg?.chat?.type === 'supergroup') : (rawMsg?.guild !== null),
    body,
    prefix,
    isCmd,
    command,
    args,
    mentioned: [],
    pushName: pushName || 'User',
    reply: async (replyText) => {
      const footer = botData?.footer_text ? `\n\n_${botData.footer_text}_` : '';
      return universalClient.message.send(jid, `${replyText}${footer}`.trim());
    },
    replyEmbed: async (embedData) => {
      if (platform === 'discord') {
        return universalClient.message.send(jid, { embed: embedData });
      }
      let txt = '';
      if (embedData.title) txt += `*${embedData.title}*\n`;
      if (embedData.description) txt += `${embedData.description}\n`;
      if (Array.isArray(embedData.fields)) {
        for (const f of embedData.fields) {
          txt += `\n*${f.name}*: ${f.value}`;
        }
      }
      return universalClient.message.send(jid, txt.trim());
    },
    react: async (emoji) => {
      if (platform === 'discord' && rawMsg?.react) {
        return rawMsg.react(emoji).catch(() => {});
      }
      return true;
    }
  };
}

module.exports = {
  createUniversalClient,
  buildUniversalContext
};
