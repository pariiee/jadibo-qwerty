'use strict';

/**
 * config/redisBus.js — Sharded Redis Pub/Sub channel `bot:<id>`.
 * Hanya subscribe ke channel bot yang aktif ditonton klien lokal.
 * Nol overhead untuk bot yang tidak ditonton di server ini.
 */
const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const GLOBAL_CHANNEL = 'bot:all';

let pub = null;
let sub = null;
let isReady = false;
let messageHandler = null;
const subscribedBots = new Set();

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
      return sub.subscribe(GLOBAL_CHANNEL);
    })
    .then(() => {
      console.log('[RedisBus] Sharded Redis ready. Subscribed to', GLOBAL_CHANNEL);
      for (const botId of subscribedBots) {
        sub.subscribe(`bot:${botId}`).catch(() => {});
      }
    })
    .catch(() => {
      isReady = false;
      console.log('[RedisBus] Redis offline, fallback lokal memory.');
    });

  sub.on('message', (_chan, msg) => {
    if (!messageHandler) return;
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
    const channel = event.botId ? `bot:${event.botId}` : GLOBAL_CHANNEL;
    pub.publish(channel, JSON.stringify(event)).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

function subscribeBot(botId) {
  const id = String(botId);
  subscribedBots.add(id);
  if (isReady && sub) {
    sub.subscribe(`bot:${id}`).catch(() => {});
  }
}

function unsubscribeBot(botId) {
  const id = String(botId);
  subscribedBots.delete(id);
  if (isReady && sub) {
    sub.unsubscribe(`bot:${id}`).catch(() => {});
  }
}

function onEvent(handler) {
  messageHandler = handler;
}

module.exports = {
  publishEvent,
  subscribeBot,
  unsubscribeBot,
  onEvent,
  isReady: () => isReady,
};
