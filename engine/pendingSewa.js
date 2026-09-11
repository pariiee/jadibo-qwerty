'use strict';

/**
 * engine/pendingSewa.js
 * Whitelist sementara grup yang sedang dalam proses addsewa.
 * Dipisah dari whatsappEngine.js agar tidak ada circular dependency dengan plugins.
 */

// Key: `${botId}:${groupJid}` → timestamp
// TTL: 2 menit — cukup untuk proses join + insert DB selesai
const pendingSewaGroups = new Map();

function markPendingSewa(botId, groupJid) {
  const key = `${botId}:${groupJid}`;
  pendingSewaGroups.set(key, Date.now());
  setTimeout(() => pendingSewaGroups.delete(key), 2 * 60 * 1000);
}

function isPendingSewa(botId, groupJid) {
  return pendingSewaGroups.has(`${botId}:${groupJid}`);
}

module.exports = { markPendingSewa, isPendingSewa };
