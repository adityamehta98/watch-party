'use strict';

const CACHE = 'watch-party-shell-v3';
const SHELL = new Set([
  '/favicon.svg', '/icon-192.png', '/icon-512.png', '/css/app.css',
  '/js/app.js', '/js/capabilities.js', '/js/file-playback.js', '/js/media.js', '/js/net.js',
  '/js/platform.js', '/js/player.js', '/js/rtc.js', '/js/sync.js', '/js/visuals.js',
  '/vendor/hls.min.js',
]);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll([...SHELL])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('watch-party-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !SHELL.has(url.pathname)) return;
  event.respondWith(caches.open(CACHE).then(async cache => {
    const cacheKey = url.pathname;
    // Network first: after an update every device gets the new page code at once; the cache is only an offline fallback.
    try {
      const response = await fetch(request, { cache: 'no-store' });
      if (response.ok) cache.put(cacheKey, response.clone());
      return response;
    } catch (error) {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
      throw error;
    }
  }));
});
