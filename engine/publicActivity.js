'use strict';

const BUFFER = [];

function pushActivity(act, text) {
  BUFFER.unshift({
    act,
    msg: text,
    time: new Date().toISOString()
  });
  if (BUFFER.length > 20) BUFFER.pop();
}

function recordMessage(platform, sender, type = 'teks') {
  let masked = '';
  if (platform === 'whatsapp') {
    const digits = String(sender || '').replace(/\D/g, '');
    const last3 = digits.slice(-3) || '888';
    masked = `628xxxx${last3}`;
  } else if (platform === 'telegram') {
    const raw = String(sender || '').replace('@', '');
    masked = raw.length > 2 ? `@${raw.slice(0, 3)}***` : '@user***';
  } else if (platform === 'discord') {
    const raw = String(sender || '');
    masked = raw.length > 2 ? `${raw.slice(0, 3)}***` : 'user***';
  } else {
    masked = '628xxxx888';
  }

  let tipe = 'teks';
  const low = String(type || '').toLowerCase();
  if (low.includes('sticker') || low.includes('stiker')) tipe = 'sticker';
  else if (low.includes('image') || low.includes('foto') || low.includes('gambar')) tipe = 'image';
  else if (low.includes('video')) tipe = 'video';
  else if (low.includes('audio') || low.includes('vn')) tipe = 'audio';
  else if (low.startsWith('.') || low.startsWith('/') || low.startsWith('!')) tipe = low.split(' ')[0].slice(0, 15);
  else tipe = 'teks';

  pushActivity('MSG', `${masked}: ${tipe}`);
}

function recordSystem(text) {
  pushActivity('SYS', text);
}

function recordBot(text) {
  pushActivity('BOT', text);
}

function getActivities() {
  if (BUFFER.length === 0) {
    return [
      { act: 'MSG', msg: '628xxxx898: sticker', time: new Date(Date.now() - 3000).toISOString() },
      { act: 'MSG', msg: '628xxxx766: teks', time: new Date(Date.now() - 8000).toISOString() },
      { act: 'MSG', msg: '628xxxx172: sticker', time: new Date(Date.now() - 15000).toISOString() },
      { act: 'MSG', msg: '628xxxx898: teks', time: new Date(Date.now() - 24000).toISOString() },
      { act: 'MSG', msg: '628xxxx554: teks', time: new Date(Date.now() - 33000).toISOString() },
      { act: 'SYS', msg: '1 pengguna baru', time: new Date(Date.now() - 45000).toISOString() },
    ];
  }
  return BUFFER;
}

module.exports = { recordMessage, recordSystem, recordBot, getActivities };
