'use strict';

const CACHE_NAME = 'qwertygate-pwa-v102';
const PRECACHE_ASSETS = [
  '/offline.html',
  '/manifest.json',
  '/privacy',
  '/terms',
  '/assets/parigate.svg',
  '/assets/theme.css',
  '/assets/page.css',
  '/assets/palette.css',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Jangan pernah cache request POST, API, socket, atau auth
  if (req.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws') || url.pathname.includes('auth') || url.pathname === '/login' || url.pathname === '/register') {
    return;
  }

  // 1. Navigasi HTML: Network First -> Fallback Offline Page
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/offline.html'))
    );
    return;
  }

  // Khusus asset auth: selalu Network First
  if (url.pathname.includes('auth.css') || url.pathname.includes('auth-page.js')) {
    event.respondWith(
      fetch(req).catch(() => caches.match(req))
    );
    return;
  }

  // 2. Static Asset (CSS, JS, Fonts, Images): Stale-While-Revalidate
  if (url.origin === self.origin && (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/js/'))) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const networkFetch = fetch(req).then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, clone));
          }
          return res;
        }).catch(() => cached);
        return cached || networkFetch;
      })
    );
  }
});
