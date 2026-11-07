const SHELL_CACHE = 'rain3d-shell-v2';
const RUNTIME_CACHE = 'rain3d-runtime-v2';
const MAX_RUNTIME_ENTRIES = 160;

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

async function trimCache(cacheName, maxItems) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > maxItems) {
    const deleteCount = keys.length - maxItems;
    for (let i = 0; i < deleteCount; i++) {
      await cache.delete(keys[i]);
    }
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 1. ナビゲーションリクエスト (HTML): Network-First + オフライン時はキャッシュされた index.html へフォールバック
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put('/index.html', clone));
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // 2. 同一オリジンの静的アセット (/assets/*, アイコン, manifest): Cache-First
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // 3. 地図タイル・気象庁ナウキャストタイル: Stale-While-Revalidate / Network-First + キャッシュフォールバック
  const isMapOrWeatherTile =
    url.hostname.includes('openstreetmap.org') ||
    url.hostname.includes('gsi.go.jp') ||
    url.hostname.includes('arcgisonline.com') ||
    url.hostname.includes('jma.go.jp');

  if (isMapOrWeatherTile) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(RUNTIME_CACHE).then((cache) => {
              cache.put(request, clone);
              trimCache(RUNTIME_CACHE, MAX_RUNTIME_ENTRIES);
            });
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
  }
});
