'use strict';

/**
 * config/redisBus.js — Redis Pub/Sub untuk sinkronisasi state multi-browser / multi-server.
 * Otomatis fallback ke memory broadcast jika Redis tidak aktif / gagal terhubung.
 */
const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const CHANNEL = 'qwertygate:bot_events';

let pub = null;
let sub = null;
let isReady = false;
let messageHandler = null;

try {
  const opts = {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => (times > 5 ? null : Math.min(times * 1000, 3000)),
    enableOfflineQueue: false,
  };

  pub = new Redis(REDIS_URL, opts);
  sub = new Redis(REDIS_URL, opts);

  pub.on('error', () => { isReady = false; });
  sub.on('error', () => { isReady = false; });

  pub.connect()
    .then(() => sub.connect())
    .then(() => {
      isReady = true;
      return sub.subscribe(CHANNEL);
    })
    .then(() => {
      console.log('[RedisBus] Connected & subscribed to ' + CHANNEL);
    })
    .catch(() => {
      isReady = false;
      console.log('[RedisBus] Redis offline / tidak aktif, menggunakan fallback lokal.');
    });

  sub.on('message', (chan, msg) => {
    if (chan !== CHANNEL || !messageHandler) return;
    try {
      const data = JSON.parse(msg);
      messageHandler(data);
    } catch {}
  });
} catch {
  isReady = false;
}

function publishEvent(event) {
  if (!isReady || !pub) return false;
  try {
    pub.publish(CHANNEL, JSON.stringify(event)).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

function onEvent(handler) {
  messageHandler = handler;
}

module.exports = {
  publishEvent,
  onEvent,
  isReady: () => isReady,
};
