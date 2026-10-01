'use strict';

/**
 * engine/runtime.js — state bot yang hidup di proses yang menjalankan engine.
 *
 * Map ini sempat tinggal di controllers/botController.js (dulu web dan bot satu
 * proses). Sekarang di sini supaya arah impornya satu: engine → runtime, plugin →
 * runtime. Nggak ada engine ↔ plugin yang saling require.
 */
const activeBots = new Map();            // botId -> client WA/Telegram
const activeGroupsPerBot = new Map();    // botId -> Map<jid, nama>
const activeChannelsPerBot = new Map();  // botId -> Map<jid, nama>

// activeBots itu Map id→client, tapi plugin nulisnya pakai chatId WhatsApp
// (mis. '62812...@s.whatsapp.net') di jalur kirim pesan — lihat komentar asli
// di whatsappEngine. Satu pintu biar tahu aturannya, bukan nebak.
const { activeBots: _legacy } = { activeBots };
function getClient(id) { return activeBots.get(id); }

module.exports = { activeBots, activeGroupsPerBot, activeChannelsPerBot, getClient };
