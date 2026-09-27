'use strict';

/**
 * engine/runtime.js — state bot yang hidup DI PROSES WORKER.
 *
 * Dulu Map ini tinggal di controllers/botController.js, artinya web dan bot
 * berbagi satu proses. Sekarang worker yang punya, dan web ngelihat cerminnya
 * lewat config/engineBus.js.
 *
 * Satu modul buat tiga Map (bukan tempel di engine masing-masing) supaya
 * arah impornya satu: worker → runtime, plugin → runtime. Nggak ada
 * engine ↔ plugin yang saling require.
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
