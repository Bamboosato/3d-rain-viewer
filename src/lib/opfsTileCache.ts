/**
 * OPFS (Origin Private File System: navigator.storage.getDirectory()) を活用した
 * 高速3D地図・標高タイルキャッシュエンジン（Stale-While-Revalidate + 通信詰まり自動リトライ対応）
 *
 * - L1: メモリ内LRUキャッシュ（直近タイルを0msで即時返却）
 * - L2: OPFS バイナリファイルストレージ（ブラウザ再起動後も永続化・高速I/O）
 * - L3: OPFS非対応環境（一部のプライベートブラウジング等）向けの Cache Storage フォールバック
 */

export type TileCategory = 'raster' | 'terrain';

interface MemoryCacheEntry {
  bytes: Uint8Array;
  updatedAt: number;
}

const OPFS_ROOT_DIR_NAME = 'rain3d-opfs-tiles-v1';
const FALLBACK_CACHE_NAME = 'rain3d-opfs-fallback-v1';

// L1 メモリキャッシュ上限（MapLibreへ渡す際のArrayBuffer複製元として保持）
const MAX_MEMORY_ENTRIES: Record<TileCategory, number> = {
  raster: 180,
  terrain: 120,
};

// L2 OPFS ディスクキャッシュ上限（従来の160枚から大幅に拡張）
const MAX_OPFS_ENTRIES: Record<TileCategory, number> = {
  raster: 1200, // 背景地図タイル（標準・地理院陰影・航空写真）最大1,200枚
  terrain: 600, // 3D標高Terrain-RGBタイル 最大600枚
};

// Stale-While-Revalidate（キャッシュ即時表示しつつ裏で最新データを取りに行く間隔）
const REVALIDATE_INTERVAL_MS: Record<TileCategory, number> = {
  raster: 1000 * 60 * 5, // 背景地図は5分経過後にバックグラウンドで最新タイルを再検証・更新
  terrain: 1000 * 60 * 60 * 24, // 標高DEMは24時間経過後にバックグラウンド再検証
};

// 遅い回線で一部タイルがハングアップするのを防ぐ1リクエストあたりのタイムアウトとリトライ回数
const TILE_FETCH_TIMEOUT_MS = 5500;
const TILE_FETCH_MAX_RETRIES = 1;

const memoryCaches: Record<TileCategory, Map<string, MemoryCacheEntry>> = {
  raster: new Map(),
  terrain: new Map(),
};

const inFlightRequests = new Map<string, Promise<Uint8Array>>();
const inFlightRevalidations = new Set<string>();
const writeCountByCategory: Record<TileCategory, number> = {
  raster: 0,
  terrain: 0,
};

let opfsRootPromise: Promise<FileSystemDirectoryHandle | null> | null = null;
const categoryDirPromises: Partial<
  Record<TileCategory, Promise<FileSystemDirectoryHandle | null>>
> = {};

/**
 * OPFS のルートディレクトリハンドルを取得（非対応環境やエラー時は null を返して安全にフォールバック）
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
      const root = await navigator.storage.getDirectory();
      return await root.getDirectoryHandle(OPFS_ROOT_DIR_NAME, { create: true });
    } catch {
      return null;
    }
  })();

  return opfsRootPromise;
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
      return await root.getDirectoryHandle(category, { create: true });
    } catch {
      return null;
    }
  })();

  return categoryDirPromises[category]!;
}

/**
 * キー文字列をOPFSで安全なファイル名に変換
 */
function toSafeFileName(key: string): string {
  return `${key.replace(/[^a-zA-Z0-9._-]/g, '_')}.bin`;
}

/**
 * L1 メモリキャッシュへ保存（LRU上限管理付き）
 */
function setMemoryCache(category: TileCategory, key: string, bytes: Uint8Array): void {
  const map = memoryCaches[category];
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, { bytes, updatedAt: Date.now() });

  const maxItems = MAX_MEMORY_ENTRIES[category];
  if (map.size > maxItems) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) {
      map.delete(oldestKey);
    }
  }
}

/**
 * L2 OPFS（またはL3 Cache APIフォールバック）からタイルバイナリと最終更新時刻を読み出す
 */
async function readFromPersistentCache(
  category: TileCategory,
  key: string
): Promise<{ bytes: Uint8Array; updatedAt: number } | null> {
  const fileName = toSafeFileName(key);
  const dir = await getCategoryOpfsDir(category);

  if (dir) {
    try {
      const fileHandle = await dir.getFileHandle(fileName, { create: false });
      const file = await fileHandle.getFile();
      if (file.size > 0) {
        const ab = await file.arrayBuffer();
        const bytes = new Uint8Array(ab);
        setMemoryCache(category, key, bytes);
        return {
          bytes,
          updatedAt: file.lastModified || Date.now(),
        };
      }
    } catch {
      // OPFSに未キャッシュの場合は下位の確認へ
    }
  }

  // OPFSのcreateWritable非対応環境（古いiOS等）向けのCache Storageフォールバック読み出し
  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(FALLBACK_CACHE_NAME);
      const res = await cache.match(`https://opfs-fallback.local/${category}/${fileName}`);
      if (res && res.ok) {
        const updatedAtHeader = res.headers.get('x-cached-at');
        const updatedAt = updatedAtHeader ? Number(updatedAtHeader) : Date.now();
        const ab = await res.arrayBuffer();
        if (ab.byteLength > 0) {
          const bytes = new Uint8Array(ab);
          setMemoryCache(category, key, bytes);
          return { bytes, updatedAt };
        }
      }
    } catch {
      // ignore
    }
  }

  return null;
}

/**
 * OPFS内のタイル数が上限を超えた際、古いファイルから自動削除（LRUクリーンアップ）
 */
async function pruneOpfsDirectoryIfNeeded(category: TileCategory): Promise<void> {
  const dir = await getCategoryOpfsDir(category);
  if (!dir) return;

  try {
    const entries: Array<{ name: string; lastModified: number }> = [];
    const iterableDir = dir as FileSystemDirectoryHandle & {
      entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
    };
    if (typeof iterableDir.entries !== 'function') return;

    for await (const [name, handle] of iterableDir.entries()) {
      if (handle.kind === 'file') {
        try {
          const file = await (handle as FileSystemFileHandle).getFile();
          entries.push({ name, lastModified: file.lastModified || 0 });
        } catch {
          entries.push({ name, lastModified: 0 });
        }
      }
    }

    const maxEntries = MAX_OPFS_ENTRIES[category];
    if (entries.length <= maxEntries) return;

    // 古い順にソートし、上限の85%になるまで古いタイルを一括削除
    entries.sort((a, b) => a.lastModified - b.lastModified);
    const targetCount = Math.floor(maxEntries * 0.85);
    const deleteCount = entries.length - targetCount;

    for (let i = 0; i < deleteCount; i++) {
      await dir.removeEntry(entries[i].name).catch(() => {});
    }
  } catch {
    // クリーンアップ失敗時は無視
  }
}

/**
 * L2 OPFS（またはL3 Cache APIフォールバック）へタイルバイナリを非同期保存
 */
async function writeToPersistentCache(
  category: TileCategory,
  key: string,
  bytes: Uint8Array
): Promise<void> {
  if (bytes.byteLength === 0) return;
  // メモリキャッシュは常に先行更新（iOSのストレージ書込み例外時もメモリヒットを保証）
  setMemoryCache(category, key, bytes);

  const fileName = toSafeFileName(key);

  try {
    const dir = await getCategoryOpfsDir(category);
    if (dir) {
      try {
        const fileHandle = await dir.getFileHandle(fileName, { create: true });
        const writableHandle = fileHandle as FileSystemFileHandle & {
          createWritable?: () => Promise<{
            write: (data: BufferSource) => Promise<void>;
            close: () => Promise<void>;
          }>;
        };

        if (typeof writableHandle.createWritable === 'function') {
          const writable = await writableHandle.createWritable();
          const copy = new Uint8Array(bytes.byteLength);
          copy.set(bytes);
          await writable.write(copy);
          await writable.close();

          writeCountByCategory[category] += 1;
          if (writeCountByCategory[category] % 60 === 0) {
            void pruneOpfsDirectoryIfNeeded(category);
          }
          return;
        }
      } catch {
        // createWritable が失敗（iOS Safariのロック競合等）した場合は Cache Storage フォールバックへ
      }
    }

    if (typeof caches !== 'undefined') {
      try {
        const cache = await caches.open(FALLBACK_CACHE_NAME);
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        const response = new Response(copy.buffer, {
          status: 200,
          headers: {
            'Content-Type': 'application/octet-stream',
            'x-cached-at': String(Date.now()),
          },
        });
        await cache.put(`https://opfs-fallback.local/${category}/${fileName}`, response);
      } catch {
        // ignore
      }
    }
  } catch {
    // 永続ストレージ書き込み失敗時もメモリキャッシュで動作を継続
  }
}

/**
 * タイムアウト＆自動リトライ付きのバイナリ取得ヘルパー（遅い回線でのタイル詰まり防止）
 */
export async function fetchTileBytesWithRetry(
  url: string,
  externalSignal?: AbortSignal
): Promise<Uint8Array> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= TILE_FETCH_MAX_RETRIES; attempt++) {
    if (externalSignal?.aborted) {
      throw new DOMException('Tile request aborted', 'AbortError');
    }

    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), TILE_FETCH_TIMEOUT_MS);
    const onExternalAbort = () => controller.abort();

    if (externalSignal) {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`Tile HTTP ${res.status}`);
      }
      const ab = await res.arrayBuffer();
      if (ab.byteLength === 0) {
        throw new Error('Empty tile payload');
      }
      return new Uint8Array(ab);
    } catch (err) {
      lastError = err;
      if (externalSignal?.aborted) {
        throw err;
      }
      // 1回目のタイムアウト／一時的通信エラー時は少し待って自動リトライ
      if (attempt < TILE_FETCH_MAX_RETRIES) {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 200));
      }
    } finally {
      globalThis.clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  throw lastError ?? new Error(`Failed to fetch tile: ${url}`);
}

/**
 * MapLibre のワーカー転送 (postMessage Transferable) で元のキャッシュバッファが
 * detach されないよう、常に独立した ArrayBuffer コピーを返す
 */
function cloneToTransferableBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * Stale-While-Revalidate 方式でOPFSキャッシュからタイルを取得・自動更新します。
 *
 * 1. L1メモリ または L2 OPFS にキャッシュが存在すれば、ネットワーク待ち時間ゼロで即座に返却します。
 * 2. キャッシュの経過時間が REVALIDATE_INTERVAL_MS を超えていた場合は、裏側（非同期）で最新データを取得してOPFSを更新します。
 * 3. キャッシュに未保存の場合はネットワークから取得し、OPFSに保存してから返却します。
 */
export async function getTileWithOpfsSWR(options: {
  category: TileCategory;
  key: string;
  fetcher: (signal?: AbortSignal) => Promise<Uint8Array>;
  signal?: AbortSignal;
}): Promise<ArrayBuffer> {
  const { category, key, fetcher, signal } = options;
  const compositeKey = `${category}:${key}`;

  const triggerBackgroundRevalidation = () => {
    if (inFlightRevalidations.has(compositeKey)) return;
    inFlightRevalidations.add(compositeKey);

    fetcher()
      .then((freshBytes) => {
        if (freshBytes && freshBytes.byteLength > 0) {
          return writeToPersistentCache(category, key, freshBytes);
        }
      })
      .catch(() => {
        // バックグラウンド更新の通信失敗時は既存のキャッシュを維持
      })
      .finally(() => {
        inFlightRevalidations.delete(compositeKey);
      });
  };

  // 1. L1 メモリキャッシュ確認（最速: 0ms）
  const memHit = memoryCaches[category].get(key);
  if (memHit && memHit.bytes.byteLength > 0) {
    if (Date.now() - memHit.updatedAt > REVALIDATE_INTERVAL_MS[category]) {
      triggerBackgroundRevalidation();
    }
    return cloneToTransferableBuffer(memHit.bytes);
  }

  // 2. L2 OPFS 永続キャッシュ確認（高速: < 1〜2ms）
  const diskHit = await readFromPersistentCache(category, key);
  if (diskHit && diskHit.bytes.byteLength > 0) {
    if (Date.now() - diskHit.updatedAt > REVALIDATE_INTERVAL_MS[category]) {
      triggerBackgroundRevalidation();
    }
    return cloneToTransferableBuffer(diskHit.bytes);
  }

  // 3. キャッシュミス時：同一タイルへの重複リクエストを統合しつつネットワーク取得
  let requestPromise = inFlightRequests.get(compositeKey);
  if (!requestPromise) {
    requestPromise = fetcher(signal)
      .then((bytes) => {
        if (bytes && bytes.byteLength > 0) {
          void writeToPersistentCache(category, key, bytes);
        }
        return bytes;
      })
      .finally(() => {
        inFlightRequests.delete(compositeKey);
      });
    inFlightRequests.set(compositeKey, requestPromise);
  }

  const fetchedBytes = await requestPromise;
  return cloneToTransferableBuffer(fetchedBytes);
}
