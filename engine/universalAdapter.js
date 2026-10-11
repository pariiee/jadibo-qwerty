'use strict';

/**
 * engine/universalAdapter.js
 * Universal message & context adapter untuk Telegram & Discord.
 * Menjembatani kontrak `client.message.send(...)` dan `ctx.reply(...)`
 * yang dipakai oleh seluruh plugins yaparbots.
 */

function createUniversalClient(platform, rawBot, chatId, rawMsg) {
  return {
    platform,
    rawBot,
    message: {
      async send(targetJid, content) {
        const destId = targetJid || chatId;

        // 1. Kirim pesan Telegram (node-telegram-bot-api)
        if (platform === 'telegram') {
          if (typeof content === 'string') {
            return rawBot.sendMessage(destId, content, { parse_mode: 'HTML' })
              .catch(() => rawBot.sendMessage(destId, content));
          }
          if (content.interactiveMessage?.body?.text) {
            return rawBot.sendMessage(destId, content.interactiveMessage.body.text, { parse_mode: 'HTML' })
              .catch(() => rawBot.sendMessage(destId, content.interactiveMessage.body.text));
          }
          if (content.text) {
            return rawBot.sendMessage(destId, content.text, { parse_mode: 'HTML' })
              .catch(() => rawBot.sendMessage(destId, content.text));
          }
          if (content.image) {
            return rawBot.sendPhoto(destId, content.image, { caption: content.caption || '' });
          }
          if (content.video) {
            return rawBot.sendVideo(destId, content.video, { caption: content.caption || '' });
          }
          if (content.audio) {
            return rawBot.sendAudio(destId, content.audio);
          }
          if (content.document) {
            return rawBot.sendDocument(destId, content.document, {}, { filename: content.fileName || 'file.bin' });
          }
          if (content.type === 'reaction') {
            return true;
          }
          return rawBot.sendMessage(destId, JSON.stringify(content));
        }

        // 2. Kirim pesan Discord (discord.js)
        if (platform === 'discord') {
          const channel = rawMsg?.channel || (rawBot.channels?.cache?.get ? rawBot.channels.cache.get(destId) : null);
          if (!channel) return null;

          if (typeof content === 'string') {
            return channel.send(content);
          }
          if (content.interactiveMessage?.body?.text) {
            return channel.send(content.interactiveMessage.body.text);
          }
          if (content.text) {
            return channel.send(content.text);
          }
          const files = [];
          if (content.image) files.push({ attachment: content.image, name: 'image.jpg' });
          if (content.video) files.push({ attachment: content.video, name: 'video.mp4' });
          if (content.audio) files.push({ attachment: content.audio, name: 'audio.mp3' });
          if (content.document) files.push({ attachment: content.document, name: content.fileName || 'file.bin' });

          if (files.length) {
            return channel.send({ content: content.caption || content.text || '', files });
          }
          if (content.type === 'reaction' && rawMsg?.react) {
            return rawMsg.react(content.emoji).catch(() => {});
          }
          return channel.send(String(content));
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
    command = (parts[0] || '').toLowerCase();
    args = parts.slice(1);
  } else if (body.startsWith('/')) {
    isCmd = true;
    const parts = body.slice(1).trim().split(/\s+/);
    command = (parts[0] || '').toLowerCase();
    args = parts.slice(1);
  } else if (body.startsWith('.')) {
    isCmd = true;
    const parts = body.slice(1).trim().split(/\s+/);
    command = (parts[0] || '').toLowerCase();
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
