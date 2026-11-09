import { diagnostic } from './diagnostics';
import { bounded, abortableDelay } from './asyncLifecycle';
/**
 * OPFS (Origin Private File System) および Cache Storage フォールバックによる
 * 高速3D地図・標高タイルキャッシュエンジン (Stale-While-Revalidate + 通信詰まり自動リトライ対応)
 *
 * 指示書 FIX-07, FIX-10, FIX-11, FIX-12 準拠
 */

export type TileCategory = 'raster' | 'terrain';

interface MemoryCacheEntry {
  bytes: Uint8Array;
  updatedAt: number;
}

const OPFS_ROOT_DIR_NAME = 'rain3d-opfs-tiles-v1';
export const FALLBACK_CACHE_NAME = 'rain3d-opfs-fallback-v1';

// L1 メモリキャッシュ上限
const MAX_MEMORY_ENTRIES: Record<TileCategory, number> = {
  raster: 180,
  terrain: 120,
};

// L2 OPFS / L3 Cache Storage 上限
export const MAX_OPFS_ENTRIES: Record<TileCategory, number> = {
  raster: 1200,
  terrain: 600,
};

// Stale-While-Revalidate 間隔
const REVALIDATE_INTERVAL_MS: Record<TileCategory, number> = {
  raster: 1000 * 60 * 5, // 5分
  terrain: 1000 * 60 * 60 * 24, // 24時間
};

// タイムアウト設定
const OPFS_OP_TIMEOUT_MS = 2500;
const TILE_FETCH_TIMEOUT_MS = 5500;
const TILE_FETCH_MAX_RETRIES = 1;

const memoryCaches: Record<TileCategory, Map<string, MemoryCacheEntry>> = {
  raster: new Map(),
  terrain: new Map(),
};

interface InFlightSubscriber {
  resolve: (data: Uint8Array) => void;
  reject: (err: any) => void;
  signal?: AbortSignal;
  cleanup?: () => void;
}

interface InFlightEntry {
  abortController: AbortController;
  subscribers: Set<InFlightSubscriber>;
}

const inFlightMap = new Map<string, InFlightEntry>();
const inFlightRevalidations = new Set<string>();
export const MAX_PERSISTENT_BYTES: Record<TileCategory, number> = { raster: 80 * 1024 * 1024, terrain: 40 * 1024 * 1024 };
const persistentQueues: Record<TileCategory, Promise<unknown>> = { raster: Promise.resolve(), terrain: Promise.resolve() };
const pendingWrites: Record<TileCategory, number> = { raster: 0, terrain: 0 };
let opfsWritableSupported = typeof FileSystemFileHandle === 'undefined' || typeof FileSystemFileHandle.prototype.createWritable === 'function';
let lastGeneration = 0;
const generations = new Map<string, number>();
let opfsRootPromise: Promise<FileSystemDirectoryHandle | null> | null = null;
const categoryDirPromises: Partial<
  Record<TileCategory, Promise<FileSystemDirectoryHandle | null>>
> = {};

/**
 * 有限の待機時間でPromiseを実行するヘルパー (FIX-07)
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: any = null;
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * OPFS のルートディレクトリハンドルを取得（タイムアウト保護付き）
 */
function getOpfsRootDir(): Promise<FileSystemDirectoryHandle | null> {
  if (opfsRootPromise) return opfsRootPromise;

  opfsRootPromise = (async () => {
    try {
      if (
        typeof navigator === 'undefined' ||
        !navigator.storage ||
        typeof navigator.storage.getDirectory !== 'function'
      ) {
        return null;
      }
      const rootRes = await withTimeout(navigator.storage.getDirectory(), OPFS_OP_TIMEOUT_MS);
      if (!rootRes) return null;
      return await withTimeout(
        rootRes.getDirectoryHandle(OPFS_ROOT_DIR_NAME, { create: true }),
        OPFS_OP_TIMEOUT_MS
      );
    } catch {
      opfsRootPromise = null;
      return null;
    }
  })();

  const pending = opfsRootPromise;
  void pending.then(value => { if (!value && opfsRootPromise === pending) opfsRootPromise = null; });
  return pending;
}

function getCategoryOpfsDir(
  category: TileCategory
): Promise<FileSystemDirectoryHandle | null> {
  if (categoryDirPromises[category]) {
    return categoryDirPromises[category]!;
  }

  categoryDirPromises[category] = (async () => {
    const root = await getOpfsRootDir();
    if (!root) return null;
    try {
      return await withTimeout(
        root.getDirectoryHandle(category, { create: true }),
        OPFS_OP_TIMEOUT_MS
      );
    } catch {
      categoryDirPromises[category] = undefined;
      return null;
    }
  })();

  const pending = categoryDirPromises[category]!;
  void pending.then(value => { if (!value && categoryDirPromises[category] === pending) delete categoryDirPromises[category]; });
  return pending;
}

function toSafeFileName(key: string): string {
  return `${key.replace(/[^a-zA-Z0-9._-]/g, '_')}.bin`;
}

function setMemoryCache(
  category: TileCategory,
  key: string,
  bytes: Uint8Array,
  updatedAt = Date.now()
): void {
  const map = memoryCaches[category];
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, { bytes, updatedAt });

  const maxItems = MAX_MEMORY_ENTRIES[category];
  while (map.size > maxItems || [...map.values()].reduce((sum, entry) => sum + entry.bytes.byteLength, 0) > 16 * 1024 * 1024) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) {
      map.delete(oldestKey);
    }
  }
}

/**
 * OPFSおよび代替Cache Storageから読み出し。
 * 両方にデータがある場合は最新の更新日時を持つものを優先採用する (FIX-11)。
 */
async function readFromPersistentCache(
  category: TileCategory,
  key: string
): Promise<{ bytes: Uint8Array; updatedAt: number } | null> {
  const fileName = toSafeFileName(key);

  let opfsData: { bytes: Uint8Array; updatedAt: number } | null = null;
  let fallbackData: { bytes: Uint8Array; updatedAt: number } | null = null;

  // 1. OPFS 読み出し
  try {
    const dir = await getCategoryOpfsDir(category);
    if (dir) {
      let selected = fileName;
      let storedAt = 0;
      const entries = (dir as FileSystemDirectoryHandle & { entries?: () => AsyncIterableIterator<[string, FileSystemHandle]> }).entries;
      if (entries) await bounded((async () => {
        for await (const [name] of entries.call(dir)) {
          if (name.startsWith(fileName + '.')) {
            const generation = Number(name.slice(fileName.length + 1));
            const candidate = await (await dir.getFileHandle(name)).getFile();
            if (candidate.size > 100 && Number.isFinite(generation) && generation > storedAt) { selected = name; storedAt = generation; }
          }
        }
      })(), OPFS_OP_TIMEOUT_MS);
      const fileHandle = await withTimeout(
        dir.getFileHandle(selected, { create: false }),
        OPFS_OP_TIMEOUT_MS
      );
      if (fileHandle) {
        const file = await withTimeout(fileHandle.getFile(), OPFS_OP_TIMEOUT_MS);
        if (file && file.size > 100) {
          const ab = await withTimeout(file.arrayBuffer(), OPFS_OP_TIMEOUT_MS);
          if (ab) {
            opfsData = {
              bytes: new Uint8Array(ab),
              updatedAt: storedAt || file.lastModified || 0,
            };
          }
        }
      }
    }
  } catch {
    // キャッシュミスとして扱う
  }

  // 2. Cache Storage フォールバック読み出し
  if (typeof caches !== 'undefined') {
    try {
      const cache = await bounded(caches.open(FALLBACK_CACHE_NAME), OPFS_OP_TIMEOUT_MS);
      const baseUrl = `https://opfs-fallback.local/${category}/${fileName}`;
      const keys = await bounded(cache.keys(), OPFS_OP_TIMEOUT_MS);
      const versions = keys.filter(request => request.url.startsWith(baseUrl + '.')).sort((a,b) => Number(b.url.slice(baseUrl.length+1)) - Number(a.url.slice(baseUrl.length+1)));
      const res = await bounded(cache.match(versions[0] ?? baseUrl), OPFS_OP_TIMEOUT_MS);
      if (res && res.ok) {
        const ab = await bounded(res.arrayBuffer(), OPFS_OP_TIMEOUT_MS);
        if (ab.byteLength > 100) {
          const updatedAtHeader = res.headers.get('x-cached-at');
          const updatedAt = updatedAtHeader ? Number(updatedAtHeader) : 0;
          fallbackData = {
            bytes: new Uint8Array(ab),
            updatedAt: updatedAt || 0,
          };
        }
      }
    } catch {
      // ignore
    }
  }

  // 3. 最新のコピーを選択 (FIX-11)
  let chosen: { bytes: Uint8Array; updatedAt: number } | null = null;
  if (opfsData && fallbackData) {
    chosen = fallbackData.updatedAt > opfsData.updatedAt ? fallbackData : opfsData;
  } else {
    chosen = opfsData || fallbackData;
  }

  if (chosen) {
    lastGeneration = Math.max(lastGeneration, chosen.updatedAt);
    setMemoryCache(category, key, chosen.bytes, chosen.updatedAt);
  }

  return chosen;
}

/**
 * OPFSディレクトリ内の上限整理 (LRU)
 */
async function pruneOpfsDirectoryIfNeeded(category: TileCategory, force = false): Promise<void> {
  const deadline = performance.now() + OPFS_OP_TIMEOUT_MS;
  const dir = await getCategoryOpfsDir(category);
  if (!dir) return;

  try {
    const entries: Array<{ name: string; lastModified: number; size: number }> = [];
    const iterableDir = dir as FileSystemDirectoryHandle & {
      entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
    };
    if (typeof iterableDir.entries !== 'function') return;

    for await (const [name, handle] of iterableDir.entries()) {
      if (handle.kind === 'file') {
        try {
          const file = await (handle as FileSystemFileHandle).getFile();
          entries.push({ name, lastModified: Number(name.split(".bin.")[1]) || file.lastModified || 0, size: file.size });
        } catch {
          entries.push({ name, lastModified: 0, size: 0 });
        }
      }
    }

    const maxEntries = MAX_OPFS_ENTRIES[category];
    let total = entries.reduce((n, entry) => n + entry.size, 0);
    entries.sort((a, b) => a.lastModified - b.lastModified);
    let remaining = entries.length;
    const targetBytes = MAX_PERSISTENT_BYTES[category] * (force ? 0.8 : 1);
    const targetCount = force ? Math.max(0, Math.floor(remaining * 0.8)) : maxEntries;
    for (const entry of entries) {
      if (entry.size > 0 && remaining <= targetCount && total <= targetBytes) continue;
      if (performance.now() >= deadline) return;
      await bounded(dir.removeEntry(entry.name), OPFS_OP_TIMEOUT_MS);
      remaining--; total -= entry.size;
    }
  } catch {
    // ignore
  }
}

/**
 * 代替 Cache Storage の上限整理 (FIX-10)
 */
async function pruneFallbackCacheIfNeeded(category: TileCategory, force = false): Promise<void> {
  const deadline = performance.now() + OPFS_OP_TIMEOUT_MS;
  if (typeof caches === 'undefined') return;
  try {
    const cache = await bounded(caches.open(FALLBACK_CACHE_NAME), OPFS_OP_TIMEOUT_MS);
    const keys = await cache.keys();
    const prefix = `https://opfs-fallback.local/${category}/`;
    const catKeys = keys.filter((req) => req.url.startsWith(prefix));

    const entries = await Promise.all(catKeys.map(async request => {
      const response = await cache.match(request);
      return { request, size: response ? (await response.arrayBuffer()).byteLength : 0 };
    }));
    let total = entries.reduce((n, entry) => n + entry.size, 0);
    let remaining = entries.length;
    const countLimit = force ? Math.floor(remaining * 0.8) : MAX_OPFS_ENTRIES[category];
    const byteLimit = MAX_PERSISTENT_BYTES[category] * (force ? 0.8 : 1);
    for (const entry of entries) {
      if (remaining <= countLimit && total <= byteLimit) break;
      if (performance.now() >= deadline) return;
      await cache.delete(entry.request); total -= entry.size; remaining--;
    }
  } catch {
    // ignore
  }
}

/**
 * L2 OPFS または L3 Cache Storage へ非同期保存
 * QuotaExceededError発生時は古いキャッシュを整理して限定再試行 (FIX-10)
 */
async function persistTile(
  category: TileCategory,
  key: string,
  bytes: Uint8Array,
  isRetry = false,
  now = ++lastGeneration
): Promise<void> {
  if (bytes.byteLength <= 67 || bytes.byteLength > MAX_PERSISTENT_BYTES[category]) {
    diagnostic({ operation: 'tile-write', backend: 'memory', outcome: 'memory-only', bytes: bytes.byteLength });
    return;
  }
  const fileName = toSafeFileName(key);
  if (generations.get(`${category}:${key}`) !== now) return;

  try {
    const dir = await getCategoryOpfsDir(category);
    if (dir && opfsWritableSupported) {
      try {
        const fileHandle = await withTimeout(
          dir.getFileHandle(`${fileName}.${now}`, { create: true }),
          OPFS_OP_TIMEOUT_MS
        );
        const writableHandle = fileHandle as (FileSystemFileHandle & {
          createWritable?: () => Promise<{
            write: (data: BufferSource) => Promise<void>;
            close: () => Promise<void>;
            abort?: () => Promise<void>;
          }>;
        }) | null;

        if (!writableHandle || typeof writableHandle.createWritable !== 'function') {
          opfsWritableSupported = false;
          await dir.removeEntry(`${fileName}.${now}`).catch(() => {});
        }
        if (writableHandle && typeof writableHandle.createWritable === 'function') {
          const opening = writableHandle.createWritable();
          const writable = await withTimeout(opening, OPFS_OP_TIMEOUT_MS);
          if (!writable) void opening.then(handle => handle.abort?.()).catch(() => {});
          if (writable) {
            const copy = new Uint8Array(bytes.byteLength);
            copy.set(bytes);
            try {
              await bounded(writable.write(copy), OPFS_OP_TIMEOUT_MS);
              if (generations.get(`${category}:${key}`) !== now) { await writable.abort?.(); return; }
              await bounded(writable.close(), OPFS_OP_TIMEOUT_MS);
            } catch (error) {
              void writable.abort?.().catch(() => {});
              throw error;
            }
            await bounded(pruneOpfsDirectoryIfNeeded(category), OPFS_OP_TIMEOUT_MS).catch(() => {});
            diagnostic({ operation: 'tile-write', backend: 'opfs', outcome: 'success', bytes: bytes.byteLength });
            return;
          }
        }
      } catch (err: unknown) {
        if (!isRetry && err instanceof Error && err.name === 'QuotaExceededError') {
          await bounded(pruneOpfsDirectoryIfNeeded(category, true), OPFS_OP_TIMEOUT_MS);
          return persistTile(category, key, bytes, true, now);
        }
      }
    }

    // Cache Storage フォールバック
    if (typeof caches !== 'undefined') {
      try {
        const cache = await bounded(caches.open(FALLBACK_CACHE_NAME), OPFS_OP_TIMEOUT_MS);
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        const response = new Response(copy.buffer, {
          status: 200,
          headers: {
            'Content-Type': 'application/octet-stream',
            'x-cached-at': String(now),
          },
        });
        await bounded(cache.put(`https://opfs-fallback.local/${category}/${fileName}.${now}`, response), OPFS_OP_TIMEOUT_MS);
        await bounded(pruneFallbackCacheIfNeeded(category), OPFS_OP_TIMEOUT_MS).catch(() => {});
        diagnostic({ operation: 'tile-write', backend: 'cache', outcome: 'success', bytes: bytes.byteLength });
        return;
      } catch (err: unknown) {
        if (!isRetry && err instanceof Error && err.name === 'QuotaExceededError') {
          await bounded(pruneFallbackCacheIfNeeded(category, true), OPFS_OP_TIMEOUT_MS);
          return persistTile(category, key, bytes, true, now);
        }
      }
    }
  } catch {
    // 永続保存失敗時もメモリキャッシュで動作を継続 (FIX-07)
  }
  diagnostic({ operation: 'tile-write', backend: 'memory', outcome: 'memory-only', bytes: bytes.byteLength });
}

function writeToPersistentCache(category: TileCategory, key: string, bytes: Uint8Array): Promise<void> {
  const generation = lastGeneration = Math.max(lastGeneration + 1, Date.now());
  setMemoryCache(category, key, bytes, generation);
  if (pendingWrites[category] >= 32) {
    diagnostic({ operation: 'tile-write', backend: 'memory', outcome: 'memory-only', bytes: bytes.byteLength });
    return Promise.resolve();
  }
  pendingWrites[category]++;
  generations.set(`${category}:${key}`, generation);
  const task = persistentQueues[category].then(() => persistTile(category, key, bytes, false, generation)).catch(() => {}).finally(() => {
    pendingWrites[category]--;
    if (generations.get(`${category}:${key}`) === generation) generations.delete(`${category}:${key}`);
  });
  persistentQueues[category] = task;
  return task;
}

/**
 * ネットワークからタイルを取得（リトライ＆タイムアウト＆キャンセル対応） (FIX-12)
 */
export async function fetchTileBytesWithRetry(
  url: string,
  signal?: AbortSignal,
  timeoutMs = TILE_FETCH_TIMEOUT_MS,
  maxRetries = TILE_FETCH_MAX_RETRIES
): Promise<Uint8Array> {
  if (signal?.aborted) {
    throw new Error('Aborted');
  }

  let lastError: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      throw new Error('Aborted');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const onAbort = () => controller.abort();
    if (signal) {
      signal.addEventListener('abort', onAbort);
    }

    let retryAfter = 200 * (attempt + 1);
    let retryable = true;
    try {
      const response = await bounded(fetch(url, {
        signal: controller.signal,
      }), timeoutMs, controller.signal);

      if (!response.ok) {
        retryable = response.status === 429 || response.status >= 500;
        const header = response.headers.get('Retry-After');
        if (header) retryAfter = Math.max(0, Number.isFinite(Number(header)) ? Number(header) * 1000 : Date.parse(header) - Date.now());
        throw new Error(`Tile HTTP error: ${response.status}`);
      }

      const ab = await bounded(response.arrayBuffer(), timeoutMs, controller.signal);
      const bytes = new Uint8Array(ab);
      return bytes;
    } catch (err) {
      lastError = err;
      if (signal?.aborted) {
        throw new Error('Aborted');
      }
      if (!retryable) throw err;
      if (attempt < maxRetries) await abortableDelay(retryAfter, signal);
    } finally {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    }
  }

  throw lastError || new Error(`Failed to fetch tile: ${url}`);
}

/**
 * Stale-While-Revalidate キャッシュからタイルを取得
 * キャンセル伝播・ArrayBuffer複製対応 (FIX-12, T36)
 */
export async function getTileWithOpfsSWR(options: {
  category: TileCategory;
  key: string;
  fetcher: (signal?: AbortSignal) => Promise<Uint8Array>;
  signal?: AbortSignal;
}): Promise<ArrayBuffer> {
  const { category, key, fetcher, signal } = options;

  if (signal?.aborted) {
    throw new Error('Aborted');
  }

  const now = Date.now();

  // 1. L1 メモリキャッシュ即時返却
  const mem = memoryCaches[category].get(key);
  if (mem) {
    memoryCaches[category].delete(key); memoryCaches[category].set(key, mem);
    diagnostic({ operation: 'tile-read', backend: 'memory', outcome: 'hit', bytes: mem.bytes.byteLength });
    // SWR バックグラウンド再検証
    if (now - mem.updatedAt > REVALIDATE_INTERVAL_MS[category]) {
      triggerBackgroundRevalidate(category, key, fetcher);
    }
    // MapLibreへ渡す前にArrayBufferを複製し、Worker転送によるdetachを防止 (T36)
    return mem.bytes.slice(0).buffer;
  }

  // 2. L2 OPFS / L3 Cache Storage 読み出し
  const persistent = await readFromPersistentCache(category, key);
  if (persistent) {
    if (now - persistent.updatedAt > REVALIDATE_INTERVAL_MS[category]) {
      triggerBackgroundRevalidate(category, key, fetcher);
    }
    return persistent.bytes.slice(0).buffer;
  }

  if (signal?.aborted) {
    throw new Error('Aborted');
  }

  // 3. ネットワーク取得（同一キーの重複リクエストは統合しつつ、各呼び出し元のキャンセルを独立管理・ADD-11, R07）
  const inFlightKey = `${category}:${key}`;
  let entry = inFlightMap.get(inFlightKey);

  if (!entry) {
    const abortController = new AbortController();
    const subscribers = new Set<InFlightSubscriber>();

    entry = { abortController, subscribers };
    inFlightMap.set(inFlightKey, entry);

    // バックグラウンドで実際の fetcher を実行
    void (async () => {
      try {
        const bytes = await bounded(fetcher(abortController.signal), 20000, abortController.signal);
        if (abortController.signal.aborted) return;
        void writeToPersistentCache(category, key, bytes);
        for (const sub of subscribers) {
          sub.cleanup?.(); sub.resolve(bytes);
        }
      } catch (err) {
        for (const sub of subscribers) {
          sub.cleanup?.(); sub.reject(err);
        }
      } finally {
        subscribers.clear();
        if (inFlightMap.get(inFlightKey)?.abortController === abortController) inFlightMap.delete(inFlightKey);
      }
    })();
  }

  const currentEntry = entry;
  const bytes = await new Promise<Uint8Array>((resolve, reject) => {
    const subscriber: InFlightSubscriber = { resolve, reject, signal };
    currentEntry.subscribers.add(subscriber);

    if (signal) {
      if (signal.aborted) {
        currentEntry.subscribers.delete(subscriber);
        reject(new Error('Aborted'));
        if (currentEntry.subscribers.size === 0) {
          currentEntry.abortController.abort();
          if (inFlightMap.get(inFlightKey) === currentEntry) inFlightMap.delete(inFlightKey);
        }
        return;
      }

      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        currentEntry.subscribers.delete(subscriber);
        reject(new Error('Aborted'));
        if (currentEntry.subscribers.size === 0) {
          currentEntry.abortController.abort();
          if (inFlightMap.get(inFlightKey) === currentEntry) inFlightMap.delete(inFlightKey);
        }
      };

      subscriber.cleanup = () => signal.removeEventListener('abort', onAbort);
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  return bytes.slice(0).buffer;
}

function triggerBackgroundRevalidate(
  category: TileCategory,
  key: string,
  fetcher: (signal?: AbortSignal) => Promise<Uint8Array>
): void {
  const revalKey = `${category}:${key}`;
  if (inFlightRevalidations.has(revalKey)) return;
  inFlightRevalidations.add(revalKey);

  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') { inFlightRevalidations.delete(revalKey); return; }
  const controller = new AbortController();
  const hide = () => { if (document.visibilityState === 'hidden') controller.abort(); };
  document.addEventListener('visibilitychange', hide);
  void bounded(fetcher(controller.signal), 20000, controller.signal)
    .then((bytes) => writeToPersistentCache(category, key, bytes))
    .catch(() => {})
    .finally(() => { controller.abort(); document.removeEventListener('visibilitychange', hide); inFlightRevalidations.delete(revalKey); });
}
