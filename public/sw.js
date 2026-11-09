const SHELL_CACHE = 'rain3d-shell-v13';
const PREVIOUS_SHELL_CACHE = 'rain3d-shell-v12';
const RUNTIME_CACHE = 'rain3d-runtime-v13';
const MAX_RUNTIME_ENTRIES = 400;
const MAX_SHELL_ENTRIES = 100;
const MAX_RUNTIME_BYTES = 40 * 1024 * 1024;
const PRECACHE_URLS = ['/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/icon.svg', /*BUILD_ASSETS*/];
const queues = new Map();

self.addEventListener('message', event => {
  if (event.data?.type === 'RAIN3D_APPLY_UPDATE') event.waitUntil(self.skipWaiting());
});

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key =>
    (key.startsWith('rain3d-shell-') || key.startsWith('rain3d-runtime-')) &&
    key !== SHELL_CACHE && key !== PREVIOUS_SHELL_CACHE && key !== RUNTIME_CACHE
  ).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
async function trimCache(cache, maxItems, maxBytes, force = false) {
  const keys = await cache.keys();
  const entries = [];
  let bytes = 0;
  for (const request of keys) {
    const response = await cache.match(request);
    const size = response ? (await response.arrayBuffer()).byteLength : 0;
    bytes += size; entries.push({ request, size });
  }
  let count = entries.length;
  const target = force ? Math.floor(count * 0.8) : maxItems;
  for (const entry of entries) {
    if (count <= target && bytes <= maxBytes * (force ? 0.8 : 1)) break;
    await cache.delete(entry.request); count--; bytes -= entry.size;
  }
}
function persist(name, request, response) {
  if (!response || response.status !== 200) return Promise.resolve();
  const task = (queues.get(name) || Promise.resolve()).then(async () => {
    const cache = await caches.open(name);
    const count = name === SHELL_CACHE ? MAX_SHELL_ENTRIES : MAX_RUNTIME_ENTRIES;
    const bytes = name === SHELL_CACHE ? 40 * 1024 * 1024 : MAX_RUNTIME_BYTES;
    try { await cache.put(request, response.clone()); }
    catch (error) {
      if (error?.name !== 'QuotaExceededError') throw error;
      await trimCache(cache, count, bytes, true);
      await cache.put(request, response.clone());
    }
    await trimCache(cache, count, bytes);
  }).catch(() => {});
  queues.set(name, task);
  return task;
}
async function match(name, request) {
  try { return await (await caches.open(name)).match(request); } catch { return undefined; }
}
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.pathname.startsWith('/src/') || url.pathname.startsWith('/@') || url.pathname.startsWith('/node_modules/')) return;
  const sameOrigin = url.origin === self.location.origin;
  const jma = url.hostname === 'www.jma.go.jp' && url.pathname.startsWith('/bosai/jmatile/');
  if (!sameOrigin && !jma) return;
  const name = sameOrigin ? SHELL_CACHE : RUNTIME_CACHE;
  const key = request.mode === 'navigate' ? '/index.html' : request;
  const writes = [];
  const network = async () => {
    const response = await fetch(request, request.mode === 'navigate' ? { cache: 'no-store' } : undefined);
    writes.push(persist(name, key, response.clone()));
    return response;
  };
  const response = (async () => {
    const cached = await match(name, key) || (sameOrigin ? await match(PREVIOUS_SHELL_CACHE, key) : undefined);
    if (jma && !url.pathname.endsWith('.json') && cached) {
      writes.push(network().catch(() => undefined));
      return cached;
    }
    try { return await network(); }
    catch { return cached || Response.error(); }
  })();
  event.respondWith(response);
  // Register lifetime synchronously; catch storage failures without replacing a good response.
  event.waitUntil(response.then(async () => {
    for (let i = 0; i < writes.length; i++) await writes[i];
  }).catch(() => {}));
});
