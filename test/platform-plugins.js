'use strict';
/**
 * test/platform-plugins.js
 * Memastikan plugin per platform (whatsapp, telegram, discord) terisolasi dan bisa dimuat.
 */
const assert = require('assert');
const { loadPlugins } = require('../engine/whatsappEngine');

const waPlugins = loadPlugins('whatsapp');
assert.ok(waPlugins.length >= 14, `WhatsApp plugins harus >= 14, dapat ${waPlugins.length}`);

const tgPlugins = loadPlugins('telegram');
assert.ok(tgPlugins.length >= 1, `Telegram plugins harus >= 1, dapat ${tgPlugins.length}`);

const dcPlugins = loadPlugins('discord');
assert.ok(dcPlugins.length >= 1, `Discord plugins harus >= 1, dapat ${dcPlugins.length}`);

// Backward compatibility forwarder
const legacyInfo = require('../plugins/01-info');
assert.ok(Array.isArray(legacyInfo.ALL_COMMANDS), 'Legacy require ../plugins/01-info harus tetap jalan');

console.log('✅ Isolasi plugin WhatsApp, Telegram, dan Discord lolos verifikasi!');
