// sw.js — Service Worker untuk Riksa Uji PJK3 PWA
// Strategi: Cache-First untuk asset UI, bypass untuk API calls & uploads
'use strict';

const CACHE_NAME = 'riksauji-v17';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/app.js?v=17',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// ─── INSTALL: Pre-cache semua static assets ───
self.addEventListener('install', (event) => {
  console.log('[SW] Install: Pre-caching static assets...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => {
        console.log('[SW] All assets cached successfully.');
        return self.skipWaiting(); // Aktifkan SW baru segera
      })
      .catch((err) => {
        console.error('[SW] Pre-cache failed:', err);
      })
  );
});

// ─── ACTIVATE: Hapus cache lama ───
self.addEventListener('activate', (event) => {
  console.log('[SW] Activate: Cleaning up old caches...');
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME)
            .map((name) => {
              console.log('[SW] Deleting old cache:', name);
              return caches.delete(name);
            })
        );
      })
      .then(() => {
        console.log('[SW] Old caches cleaned. Taking control of all clients.');
        return self.clients.claim(); // Ambil alih klien tanpa reload
      })
  );
});

// ─── FETCH: Cache-First strategy ───
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Jangan intercept:
  // 1. Request non-GET (POST, dll.)
  // 2. API calls ke /api/* dan file hasil sync /uploads/*
  // 3. Request ke domain lain (external resources seperti Google Fonts)
  if (
    request.method !== 'GET' ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/uploads/') ||
    url.origin !== self.location.origin
  ) {
    // Biarkan network handle request ini langsung
    return;
  }

  const isNavigation =
    request.mode === 'navigate' ||
    (request.headers.get('accept') || '').includes('text/html');

  event.respondWith(
    caches.match(request)
      .then((exactMatch) => {
        if (exactMatch) return exactMatch;
        // Fallback ignoreSearch agar /?key=... atau /app.js?v=... tetap kena cache saat offline
        return caches.match(request, { ignoreSearch: true });
      })
      .then((cachedResponse) => {
        // Cache-HIT: kembalikan dari cache, lalu perbarui cache di background
        if (cachedResponse) {
          fetch(request)
            .then((networkResponse) => {
              if (networkResponse && networkResponse.status === 200 && networkResponse.type !== 'opaque') {
                // Untuk navigasi dengan ?key=..., simpan sebagai /index.html agar bersih
                const cacheKey = isNavigation ? '/index.html' : request;
                caches.open(CACHE_NAME).then((cache) => cache.put(cacheKey, networkResponse.clone()));
              }
            })
            .catch(() => {/* abaikan error network saat offline */});

          return cachedResponse;
        }

        // Cache-MISS: ambil dari network, simpan ke cache
        return fetch(request)
          .then((networkResponse) => {
            if (!networkResponse || networkResponse.status !== 200 || networkResponse.type === 'opaque') {
              return networkResponse;
            }

            const responseToCache = networkResponse.clone();
            const cacheKey = isNavigation ? '/index.html' : request;
            caches.open(CACHE_NAME)
              .then((cache) => cache.put(cacheKey, responseToCache))
              .catch((err) => console.warn('[SW] Cache put failed:', err));

            return networkResponse;
          })
          .catch(() => {
            // Network gagal & tidak ada cache:
            // Untuk navigasi (HTML request), kembalikan index.html dari cache
            if (isNavigation) {
              console.log('[SW] Offline fallback: serving cached index.html');
              return caches.match('/index.html');
            }
            // Untuk aset lain, return response kosong daripada error
            return new Response('', {
              status: 503,
              statusText: 'Service Unavailable (Offline)'
            });
          });
      })
  );
});

// ─── MESSAGE: Handle pesan dari app ───
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports[0].postMessage({ version: CACHE_NAME });
  }
});
