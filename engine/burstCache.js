'use strict';

/**
 * engine/burstCache.js
 * Cache sementara untuk burst image (multi-sticker).
 * Dipisah dari whatsappEngine.js agar tidak ada circular dependency dengan plugins.
 */

// Key: `${botId}:${jid}:${sender}` → array of { content, msgType, ts }
const burstImageCache = new Map();
const BURST_TTL = 5 * 60 * 1000; // 5 menit

function _normalizeJid(jid) {
  // Normalize ke format nomor saja, strip device suffix (:0, :1, dll)
  return (jid || '').split('@')[0].split(':')[0];
}

function cacheBurstImage(botId, jid, sender, content, msgType) {
  const key = `${botId}:${jid}:${_normalizeJid(sender)}`;
  const now = Date.now();
  const existing = (burstImageCache.get(key) || []).filter(e => now - e.ts < BURST_TTL);
  existing.push({ content, msgType, ts: now });
  burstImageCache.set(key, existing);
}

function popBurstImages(botId, jid, sender) {
  const key = `${botId}:${jid}:${_normalizeJid(sender)}`;
  const now = Date.now();
  const items = (burstImageCache.get(key) || []).filter(e => now - e.ts < BURST_TTL);
  burstImageCache.delete(key);
  return items;
}

module.exports = { cacheBurstImage, popBurstImages };
