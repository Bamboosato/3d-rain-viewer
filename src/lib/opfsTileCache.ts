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
const deferredWrites: Record<TileCategory, Map<string, number>> = { raster: new Map(), terrain: new Map() };
const pendingWrites: Record<TileCategory, number> = { raster: 0, terrain: 0 };
// A navigation must not drain the old document's write queue into its replacement.
let cacheClosed = false;
if (typeof window !== 'undefined') window.addEventListener('pagehide', event => {
  if (event.persisted) return; // A back/forward-cache document can resume.
  cacheClosed = true;
  deferredWrites.raster.clear(); deferredWrites.terrain.clear();
  for (const request of inFlightMap.values()) request.abortController.abort();
});
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

// One shared inventory per backend/category, rather than one directory scan per tile.
// New entries carry size in their name/header. Legacy sizes are audited in small batches.
interface DiskEntry { name: string; base: string; updatedAt: number; size?: number }
interface DiskIndex { entries: Map<string, DiskEntry>; byKey: Map<string, DiskEntry[]>; bytes: number }
const indexes: Record<'opfs' | 'cache', Partial<Record<TileCategory, Promise<DiskIndex>>>> = { opfs: {}, cache: {} };
const emptyIndex = (): DiskIndex => ({ entries: new Map(), byKey: new Map(), bytes: 0 });
function addEntry(index: DiskIndex, entry: DiskEntry) {
  removeEntry(index, entry.name);
  index.entries.set(entry.name, entry); index.bytes += entry.size ?? 0;
  const versions = index.byKey.get(entry.base) ?? [];
  versions.push(entry); versions.sort((a, b) => b.updatedAt - a.updatedAt);
  index.byKey.set(entry.base, versions);
}
function removeEntry(index: DiskIndex, name: string) {
  const old = index.entries.get(name); if (!old) return;
  index.bytes -= old.size ?? 0; index.entries.delete(name);
  const versions = index.byKey.get(old.base)?.filter(e => e.name !== name) ?? [];
  if (versions.length) index.byKey.set(old.base, versions); else index.byKey.delete(old.base);
}
function setEntrySize(index: DiskIndex, entry: DiskEntry, size: number) {
  index.bytes += size - (entry.size ?? 0); entry.size = size;
}
function diskEntry(name: string): DiskEntry | null {
  const match = /^(.*\.bin)(?:\.(\d+)(?:-(\d+))?)?$/.exec(name);
  if (!match) return null;
  return { name, base: match[1], updatedAt: Number(match[2]) || 0, size: match[3] === undefined ? undefined : Number(match[3]) };
}
function getDiskIndex(backend: 'opfs' | 'cache', category: TileCategory): Promise<DiskIndex> {
  const existing = indexes[backend][category]; if (existing) return existing;
  const task = (async () => {
    const index = emptyIndex();
    if (backend === 'opfs') {
      const dir = await getCategoryOpfsDir(category); if (!dir) throw new Error('OPFS unavailable');
      const iterator = (dir as any).entries?.()[Symbol.asyncIterator]() as AsyncIterator<[string, FileSystemHandle]> | undefined;
      if (!iterator) return index; // Direct legacy lookup also supports older implementations.
      const deadline = performance.now() + OPFS_OP_TIMEOUT_MS;
      while (performance.now() < deadline) {
        const item = await bounded(iterator.next(), Math.max(1, deadline - performance.now()));
        if (item.done) return index;
        const entry = diskEntry(item.value[0]); if (entry) addEntry(index, entry);
      }
      throw new Error('Inventory deadline');
    }
    if (typeof caches === 'undefined') throw new Error('Cache unavailable');
    const cache = await bounded(caches.open(FALLBACK_CACHE_NAME), OPFS_OP_TIMEOUT_MS);
    const keys = await bounded(cache.keys(), OPFS_OP_TIMEOUT_MS);
    const prefix = `https://opfs-fallback.local/${category}/`;
    for (const request of keys) if (request.url.startsWith(prefix)) {
      const entry = diskEntry(request.url.slice(prefix.length)); if (entry) addEntry(index, entry);
    }
    return index;
  })();
  indexes[backend][category] = task;
  void task.catch(() => { if (indexes[backend][category] === task) delete indexes[backend][category]; });
  return task;
}
async function readDisk(backend: 'opfs' | 'cache', category: TileCategory, key: string, signal?: AbortSignal): Promise<MemoryCacheEntry | null> {
  try {
    const index = await bounded(getDiskIndex(backend, category), OPFS_OP_TIMEOUT_MS, signal).catch(error => {
      if (signal?.aborted) throw error;
      // Inventory failure does not invalidate a directly addressable legacy tile.
      return emptyIndex();
    });
    const base = toSafeFileName(key);
    const versions = index.byKey.get(base) ?? [{ name: base, base, updatedAt: 0 }];
    for (const entry of [...versions]) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      try {
        let bytes: Uint8Array; let updatedAt: number;
        if (backend === 'opfs') {
          const dir = await bounded(getCategoryOpfsDir(category), OPFS_OP_TIMEOUT_MS, signal); if (!dir) return null;
          const handle = await bounded(dir.getFileHandle(entry.name), OPFS_OP_TIMEOUT_MS, signal);
          const file = await bounded(handle.getFile(), OPFS_OP_TIMEOUT_MS, signal);
          if (file.size <= 100) continue;
          bytes = new Uint8Array(await bounded(file.arrayBuffer(), OPFS_OP_TIMEOUT_MS, signal));
          updatedAt = entry.updatedAt || file.lastModified || 0;
        } else {
          const cache = await bounded(caches.open(FALLBACK_CACHE_NAME), OPFS_OP_TIMEOUT_MS, signal);
          const response = await bounded(cache.match(`https://opfs-fallback.local/${category}/${entry.name}`), OPFS_OP_TIMEOUT_MS, signal);
          if (!response?.ok) continue;
          bytes = new Uint8Array(await bounded(response.arrayBuffer(), OPFS_OP_TIMEOUT_MS, signal));
          updatedAt = Number(response.headers.get('x-cached-at')) || entry.updatedAt;
        }
        if (bytes.byteLength <= 100 || signal?.aborted) continue;
        if (!index.entries.has(entry.name)) addEntry(index, entry);
        setEntrySize(index, entry, bytes.byteLength);
        diagnostic({ operation: 'tile-read', backend, outcome: 'hit', bytes: bytes.byteLength });
        return { bytes, updatedAt };
      } catch { if (signal?.aborted) return null; }
    }
  } catch { /* A missing or unavailable store must not prevent another store from responding. */ }
  return null;
}
async function readFromPersistentCache(category: TileCategory, key: string, signal?: AbortSignal): Promise<MemoryCacheEntry | null> {
  const started = performance.now();
  const copies: MemoryCacheEntry[] = [];
  let finish!: (value: MemoryCacheEntry | null) => void; let remaining = 2;
  const available = new Promise<MemoryCacheEntry | null>(resolve => finish = resolve);
  const reads = (['opfs', 'cache'] as const).map(backend => readDisk(backend, category, key, signal).then(copy => {
    if (copy) { copies.push(copy); finish(copy); }
    if (--remaining === 0) finish(null);
  }));
  const first = await bounded(available, OPFS_OP_TIMEOUT_MS + 100, signal).catch(error => {
    if (signal?.aborted) throw error; return null;
  });
  if (!first) return null;
  // Compare responsive stores, but never hold a usable tile behind a stalled secondary store.
  await bounded(Promise.all(reads), 25, signal).catch(error => { if (signal?.aborted) throw error; });
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const chosen = copies.reduce((best, copy) => copy.updatedAt > best.updatedAt ? copy : best);
  lastGeneration = Math.max(lastGeneration, chosen.updatedAt);
  setMemoryCache(category, key, chosen.bytes, chosen.updatedAt);
  diagnostic({ operation: 'tile-read', backend: 'memory', outcome: 'success', durationMs: performance.now() - started });
  // A late newer copy may improve the next read, but cannot overwrite a later network result.
  void Promise.all(reads).then(() => {
    if (signal?.aborted) return;
    const newest = copies.reduce((best, copy) => copy.updatedAt > best.updatedAt ? copy : best, chosen);
    const mem = memoryCaches[category].get(key);
    if (mem && newest.updatedAt > mem.updatedAt) setMemoryCache(category, key, newest.bytes, newest.updatedAt);
  });
  return chosen;
}
async function prunePersistent(category: TileCategory, backend: 'opfs' | 'cache', force = false): Promise<void> {
  const index = await getDiskIndex(backend, category);
  const dir = backend === 'opfs' ? await getCategoryOpfsDir(category) : null;
  const cache = backend === 'cache' ? await bounded(caches.open(FALLBACK_CACHE_NAME), OPFS_OP_TIMEOUT_MS) : null;
  const prefix = `https://opfs-fallback.local/${category}/`;
  const deadline = performance.now() + 20;
  // At most four unknown legacy sizes per save; never fan out over all stored bodies.
  let audited = 0;
  for (const entry of index.entries.values()) {
    if (entry.size !== undefined) continue;
    if (audited++ >= 4 || performance.now() >= deadline) break;
    try {
      if (dir) {
        const file = await bounded((await bounded(dir.getFileHandle(entry.name), OPFS_OP_TIMEOUT_MS)).getFile(), OPFS_OP_TIMEOUT_MS);
        setEntrySize(index, entry, file.size);
      } else if (cache) {
        const response = await bounded(cache.match(prefix + entry.name), OPFS_OP_TIMEOUT_MS);
        const header = response?.headers?.get('x-rain3d-bytes');
        const size = header ? Number(header) : response ? (await bounded(response.arrayBuffer(), OPFS_OP_TIMEOUT_MS)).byteLength : 0;
        if (Number.isFinite(size)) setEntrySize(index, entry, size);
      }
    } catch { break; }
  }
  let count = index.entries.size;
  const countLimit = force ? Math.floor(count * 0.8) : MAX_OPFS_ENTRIES[category];
  const byteLimit = MAX_PERSISTENT_BYTES[category] * (force ? 0.8 : 1);
  if (count <= countLimit && index.bytes <= byteLimit) return;
  // Sorting is only needed when over budget (or for a quota retry), not on every tile.
  const entries = [...index.entries.values()].sort((a, b) => a.updatedAt - b.updatedAt);
  const deletionDeadline = performance.now() + OPFS_OP_TIMEOUT_MS;
  for (const entry of entries) {
    if (count <= countLimit && index.bytes <= byteLimit) break;
    if (performance.now() >= deletionDeadline) break;
    if (dir) await bounded(dir.removeEntry(entry.name), Math.max(1, deletionDeadline - performance.now()));
    else if (cache) await bounded(cache.delete(prefix + entry.name), Math.max(1, deletionDeadline - performance.now()));
    removeEntry(index, entry.name); count--;
  }
}
const pruneOpfsDirectoryIfNeeded = (category: TileCategory, force = false) => prunePersistent(category, 'opfs', force);
const pruneFallbackCacheIfNeeded = (category: TileCategory, force = false) => prunePersistent(category, 'cache', force);
async function recordWrite(backend: 'opfs' | 'cache', category: TileCategory, name: string, base: string, size: number, updatedAt: number) {
  try { addEntry(await getDiskIndex(backend, category), { name, base, size, updatedAt }); } catch { /* rebuild on next access */ }
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
  if (cacheClosed) return;
  let storageError: 'quota' | 'timeout' | 'storage-unavailable' = 'storage-unavailable';
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
          dir.getFileHandle(`${fileName}.${now}-${bytes.byteLength}`, { create: true }),
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
          await dir.removeEntry(`${fileName}.${now}-${bytes.byteLength}`).catch(() => {});
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
            if (cacheClosed) return;
            await recordWrite('opfs', category, `${fileName}.${now}-${bytes.byteLength}`, fileName, bytes.byteLength, now);
            await bounded(pruneOpfsDirectoryIfNeeded(category), OPFS_OP_TIMEOUT_MS).catch(() => {});
            diagnostic({ operation: 'tile-write', backend: 'opfs', outcome: 'success', bytes: bytes.byteLength });
            return;
          }
        }
      } catch (err: unknown) {
        storageError = err instanceof Error && err.name === 'QuotaExceededError' ? 'quota' : err instanceof Error && /timed out/i.test(err.message) ? 'timeout' : 'storage-unavailable';
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
            'x-rain3d-bytes': String(bytes.byteLength),
          },
        });
        await bounded(cache.put(`https://opfs-fallback.local/${category}/${fileName}.${now}-${bytes.byteLength}`, response), OPFS_OP_TIMEOUT_MS);
        if (cacheClosed) return;
        await recordWrite('cache', category, `${fileName}.${now}-${bytes.byteLength}`, fileName, bytes.byteLength, now);
        await bounded(pruneFallbackCacheIfNeeded(category), OPFS_OP_TIMEOUT_MS).catch(() => {});
        diagnostic({ operation: 'tile-write', backend: 'cache', outcome: 'success', bytes: bytes.byteLength });
        return;
      } catch (err: unknown) {
        storageError = err instanceof Error && err.name === 'QuotaExceededError' ? 'quota' : err instanceof Error && /timed out/i.test(err.message) ? 'timeout' : 'storage-unavailable';
        if (!isRetry && err instanceof Error && err.name === 'QuotaExceededError') {
          await bounded(pruneFallbackCacheIfNeeded(category, true), OPFS_OP_TIMEOUT_MS);
          return persistTile(category, key, bytes, true, now);
        }
      }
    }
  } catch {
    // 永続保存失敗時もメモリキャッシュで動作を継続 (FIX-07)
  }
  if (!cacheClosed) diagnostic({ operation: 'tile-write', backend: 'memory', outcome: 'memory-only', bytes: bytes.byteLength, error: storageError });
}

function enqueueWrite(category: TileCategory, key: string, bytes: Uint8Array, generation: number): Promise<void> {
  pendingWrites[category]++;
  const task = persistentQueues[category].then(() => persistTile(category, key, bytes, false, generation)).catch(() => {}).finally(() => {
    pendingWrites[category]--;
    if (generations.get(`${category}:${key}`) === generation) generations.delete(`${category}:${key}`);
    // Deferred jobs retain keys only. Their bytes stay within the existing memory LRU budget.
    while (!cacheClosed && pendingWrites[category] < 32 && deferredWrites[category].size) {
      const [nextKey, nextGeneration] = deferredWrites[category].entries().next().value!;
      deferredWrites[category].delete(nextKey);
      const memory = memoryCaches[category].get(nextKey);
      if (memory?.updatedAt === nextGeneration) void enqueueWrite(category, nextKey, memory.bytes, nextGeneration);
      else if (generations.get(`${category}:${nextKey}`) === nextGeneration) generations.delete(`${category}:${nextKey}`);
    }
  });
  persistentQueues[category] = task;
  return task;
}
function writeToPersistentCache(category: TileCategory, key: string, bytes: Uint8Array): Promise<void> {
  if (cacheClosed) return Promise.resolve();
  const generation = lastGeneration = Math.max(lastGeneration + 1, Date.now());
  setMemoryCache(category, key, bytes, generation);
  generations.set(`${category}:${key}`, generation);
  if (pendingWrites[category] >= 32) {
    deferredWrites[category].set(key, generation);
    for (const [deferredKey, oldGeneration] of deferredWrites[category]) {
      if (!memoryCaches[category].has(deferredKey)) {
        deferredWrites[category].delete(deferredKey);
        if (generations.get(`${category}:${deferredKey}`) === oldGeneration) generations.delete(`${category}:${deferredKey}`);
      }
    }
    diagnostic({ operation: 'tile-write', backend: 'memory', outcome: 'deferred', bytes: bytes.byteLength, count: deferredWrites[category].size });
    return Promise.resolve();
  }
  return enqueueWrite(category, key, bytes, generation);
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
  const persistent = await readFromPersistentCache(category, key, signal);
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
