const SHELL_CACHE = 'rain3d-shell-v7';
const RUNTIME_CACHE = 'rain3d-runtime-v7';
const MAX_RUNTIME_ENTRIES = 800;

const PRECACHE_URLS = [
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

  // ローカル開発環境 (localhost / 127.0.0.1) や Vite HMR モジュールはキャッシュせず常にネットワーク直通
  if (
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.pathname.startsWith('/src/') ||
    url.pathname.startsWith('/@') ||
    url.pathname.startsWith('/node_modules/')
  ) {
    return;
  }

  // 1. ナビゲーションリクエスト (HTML): HTTPキャッシュをバイパスして最新 index.html を取得 + オフライン時のみフォールバック
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request, { cache: 'no-store' })
        .then((response) => {
          const clone = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put('/index.html', clone));
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // 2. 同一オリジンの静的アセット (/assets/*, アイコン, manifest): Network-First (オフライン時キャッシュフォールバック)
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // 3. 気象庁ナウキャストの時刻一覧JSON (targetTimes_*.json) は常に最新を取得 (Network-First)
  if (url.hostname.includes('jma.go.jp') && url.pathname.endsWith('.json')) {
    event.respondWith(
      fetch(request).catch(async () => {
        const cached = await caches.match(request);
        return cached || Response.error();
      })
    );
    return;
  }

  // 4. 地図タイル・気象庁ナウキャスト画像タイル: Stale-While-Revalidate (キャッシュ即時表示 + 裏で最新へ更新)
  const isMapOrWeatherTile =
    url.hostname === 'tile.openstreetmap.org' ||
    url.hostname === 'cyberjapandata.gsi.go.jp' ||
    url.hostname.includes('arcgisonline.com') ||
    url.hostname.includes('jma.go.jp');

  if (isMapOrWeatherTile) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const networkPromise = fetch(request)
          .then((response) => {
            if (response && response.status === 200) {
              cache.put(request, response.clone());
              trimCache(RUNTIME_CACHE, MAX_RUNTIME_ENTRIES);
            }
            return response;
          })
          .catch(() => cached || Response.error());

        return cached || networkPromise;
      })
    );
  }
});
