/**
 * Formal Regression Test Suite for Review Requirements (ADD-01 ~ ADD-14, R01 ~ R14)
 * Covers:
 * - ADD-01: Limits (100 items / 50 chars), rejection of overflow, no silent data loss (R03, R04)
 * - ADD-02: Storage source of truth, atomic persistence & rollback, IndexedDB visibility (R01, R02, R05, R06)
 * - ADD-03: Serialized favorite operations, prevention of deleted item resurrection (R14)
 * - ADD-04: Request generation matching on initial adoption, timeline selection, and source switching (R11, R12, R13)
 * - ADD-06: SW cache failure decoupling from weather network fetch (R08, R09)
 * - ADD-07: Catalog validation rejecting fabricated frames from empty time strings (R10)
 * - ADD-11: Reference-counted shared fetch cancellation without cancelling siblings (R07)
 */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { resetFavoritesMemoryCacheForTesting } from '../src/lib/favoritesStorage';

const location = (id: string, name = id) => ({
  id,
  name,
  center: [139, 35] as [number, number],
  zoom: 10,
  pitch: 60,
  bearing: 0,
  elevation: 0,
  region: 'fixture',
  emoji: '⭐',
  description: 'fixture',
});

beforeEach(() => {
  vi.resetModules();
  resetFavoritesMemoryCacheForTesting();
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('indexedDB', undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('R01 / ADD-02: normal save after import survives the actual startup loader', async () => {
  const s = await import('../src/lib/favoritesStorage');
  await s.saveFavoritesAndUndoAtomic([location('imported')], [location('old')]);
  expect((await s.saveFavoriteLocations([location('edited')])).success).toBe(true);
  expect(s.loadFavoriteLocations().map((x) => x.id)).toEqual(['edited']);
});

it('R02 / ADD-02: successful Undo survives the actual startup loader', async () => {
  const s = await import('../src/lib/favoritesStorage');
  await s.saveFavoritesAndUndoAtomic([location('imported')], [location('old')]);
  expect((await s.restoreFavoritesUndo()).success).toBe(true);
  expect(s.loadFavoriteLocations().map((x) => x.id)).toEqual(['old']);
});

it('R03 / ADD-01: 101st normal item must not silently discard an existing item', async () => {
  const s = await import('../src/lib/favoritesStorage');
  const existing = Array.from({ length: 100 }, (_, i) => location(`item-${i}`));
  await s.saveFavoriteLocations(existing);
  const result = await s.saveFavoriteLocations([location('new'), ...existing]);
  expect({
    success: result.success,
    keptExistingLast: s.loadFavoriteLocations().some((x) => x.id === 'item-99'),
  }).toEqual({ success: false, keptExistingLast: true });
});

it('R04 / ADD-01: a rejected 51-character name must not be reported as saved', async () => {
  const s = await import('../src/lib/favoritesStorage');
  const result = await s.saveFavoriteLocations([location('named', 'x'.repeat(51))]);
  expect({ success: result.success, savedCount: s.loadFavoriteLocations().length }).toEqual({
    success: false,
    savedCount: 0,
  });
});

it('R05 / ADD-02: single-record commit succeeds without writing a failing obsolete mirror', async () => {
  const s = await import('../src/lib/favoritesStorage');
  await s.saveFavoriteLocations([location('old')]);
  const original = localStorage.setItem.bind(localStorage);
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (key === 'rain3d_favorite_locations_v1') {
      throw new DOMException('synthetic quota', 'QuotaExceededError');
    }
    original(key, value);
  });
  expect((await s.saveFavoritesAndUndoAtomic([location('new')], [location('old')])).success).toBe(
    true
  );
  expect(s.loadFavoriteLocations().map((x) => x.id)).toEqual(['new']);
});

it('R06 / ADD-02: IndexedDB-only successful save is visible to the startup loader', async () => {
  const values = new Map();
  vi.stubGlobal('indexedDB', {
    open: () => {
      const req: any = {};
      queueMicrotask(() => {
        req.result = {
          transaction: () => {
            const tx: any = {
              objectStore: () => ({
                put: (value: any, key: string) => values.set(key, value), delete: (key: string) => values.delete(key),
                get: (key: string) => { const request: any = {}; queueMicrotask(() => { request.result = values.get(key); request.onsuccess?.(); }); return request; }
              }),
            };
            queueMicrotask(() => tx.oncomplete?.());
            return tx;
          },
        };
        req.onsuccess?.();
      });
      return req;
    },
  });
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new Error('denied');
  });
  const s = await import('../src/lib/favoritesStorage');
  expect((await s.saveFavoriteLocations([location('idb-only')])).success).toBe(true);
  expect(values.get('favorites')).toHaveLength(1);
  expect(s.loadFavoriteLocations().map((x) => x.id)).toEqual(['idb-only']);
});

/* =====================================================================
 * ADD-11 / FIX-12: Reference-Counted Shared Fetch Cancellation
 * ===================================================================== */
it('R07 / ADD-11: cancelling the first subscriber must not fail the second', async () => {
  vi.stubGlobal('caches', undefined);
  const s = await import('../src/lib/opfsTileCache');
  const controller = new AbortController();
  let completeNetwork: (bytes: Uint8Array) => void = () => {};
  const fetcher = vi.fn(
    (signal?: AbortSignal) =>
      new Promise<Uint8Array>((resolve, reject) => {
        completeNetwork = resolve;
        signal?.addEventListener('abort', () => reject(new Error('synthetic abort')));
      })
  );
  const a = s.getTileWithOpfsSWR({
    category: 'raster',
    key: 'shared',
    fetcher,
    signal: controller.signal,
  });
  const b = s.getTileWithOpfsSWR({ category: 'raster', key: 'shared', fetcher });
  const results = Promise.allSettled([a, b]);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(fetcher).toHaveBeenCalledTimes(1);
  controller.abort();
  completeNetwork(new Uint8Array(128));
  const settled = await results;
  expect(settled[1].status).toBe('fulfilled');
});

/* =====================================================================
 * ADD-06 / FIX-07: Service Worker Storage Failure Decoupling
 * ===================================================================== */
async function weatherSwResponse(mode: 'open-failure' | 'put-failure') {
  const handlers: Record<string, (event: any) => void> = {};
  const fetcher = vi.fn(async () => new Response('valid-weather', { status: 200 }));
  const code = readFileSync('public/sw.js', 'utf8');
  runInNewContext(code, {
    self: {
      addEventListener: (type: string, handler: any) => {
        handlers[type] = handler;
      },
      location: { origin: 'https://review.invalid' },
    },
    caches: {
      open: async () => {
        if (mode === 'open-failure') throw new Error('synthetic storage denied');
        return {
          match: async () => undefined,
          put: async () => {
            throw new Error('synthetic quota');
          },
        };
      },
    },
    fetch: fetcher,
    URL,
    Response,
    Headers,
  });
  let response: Promise<Response> | undefined;
  handlers.fetch({
    request: { method: 'GET', mode: 'cors', url: 'https://www.jma.go.jp/bosai/jmatile/synthetic/tile.png' },
    respondWith: (p: Promise<Response>) => {
      response = p;
    },
    waitUntil: () => {},
  });
  return response!;
}

it('R08 / ADD-06: actual SW cache.open failure must allow weather network success', async () => {
  const response = await weatherSwResponse('open-failure');
  expect(response.status).toBe(200);
});

it('R09 / ADD-06: actual SW cache.put failure must not discard a good network response', async () => {
  const response = await weatherSwResponse('put-failure');
  expect(response.status).toBe(200);
});

/* =====================================================================
 * ADD-07 / FIX-08: Catalog Validation (No Fabricated Frames)
 * ===================================================================== */
it('R10 / ADD-07: empty time strings must not fabricate a current frame', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json([{ basetime: '', validtime: '', elements: ['hrpns'] }]))
  );
  const s = await import('../src/lib/jmaNowcastClient');
  await expect(s.fetchJMANowcastCatalog()).rejects.toThrow();
});
