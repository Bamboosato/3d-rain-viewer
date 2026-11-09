// Review-only probes: assertions express required behavior, not current bugs.
// Functional/data: save -> reload, undo, atomic failure (FIX-03/14).
// Boundaries: 101 items, 51-character names, malformed catalog (FIX-08/14).
// Nonfunctional/transitions: one shared consumer cancels, storage rejects (FIX-07/12).
// Synthetic fixtures only. Isolate storage, modules and global mocks for each probe.
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const location = (id: string, name = id) => ({
  id, name, center: [139, 35] as [number, number], zoom: 10, pitch: 60,
  bearing: 0, elevation: 0, region: 'fixture', emoji: '*', description: 'fixture',
});
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('indexedDB', undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('R01 FIX-03: normal save after import survives the actual startup loader', async () => {
  const s = await import('../../src/lib/favoritesStorage');
  await s.saveFavoritesAndUndoAtomic([location('imported')], [location('old')]);
  expect((await s.saveFavoriteLocations([location('edited')])).success).toBe(true);
  expect(s.loadFavoriteLocations().map(x => x.id)).toEqual(['edited']);
});

it('R02 FIX-03: successful Undo survives the actual startup loader', async () => {
  const s = await import('../../src/lib/favoritesStorage');
  await s.saveFavoritesAndUndoAtomic([location('imported')], [location('old')]);
  expect((await s.restoreFavoritesUndo()).success).toBe(true);
  expect(s.loadFavoriteLocations().map(x => x.id)).toEqual(['old']);
});

it('R03 FIX-14: 101st normal item must not silently discard an existing item', async () => {
  const s = await import('../../src/lib/favoritesStorage');
  const existing = Array.from({ length: 100 }, (_, i) => location(`item-${i}`));
  await s.saveFavoriteLocations(existing);
  const result = await s.saveFavoriteLocations([location('new'), ...existing]);
  expect({ success: result.success, keptExistingLast: s.loadFavoriteLocations().some(x => x.id === 'item-99') })
    .toEqual({ success: false, keptExistingLast: true });
});

it('R04 FIX-14: a rejected 51-character name must not be reported as saved', async () => {
  const s = await import('../../src/lib/favoritesStorage');
  const result = await s.saveFavoriteLocations([location('named', 'x'.repeat(51))]);
  expect({ success: result.success, savedCount: s.loadFavoriteLocations().length })
    .toEqual({ success: false, savedCount: 0 });
});

it('R05 FIX-03: failure reported as rollback must retain the old startup state', async () => {
  const s = await import('../../src/lib/favoritesStorage');
  await s.saveFavoriteLocations([location('old')]);
  const original = localStorage.setItem.bind(localStorage);
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (key === 'rain3d_favorite_locations_v1') {
      throw new DOMException('synthetic quota', 'QuotaExceededError');
    }
    original(key, value);
  });
  expect((await s.saveFavoritesAndUndoAtomic([location('new')], [location('old')])).success).toBe(false);
  expect(s.loadFavoriteLocations().map(x => x.id)).toEqual(['old']);
});

it('R06 FIX-03: IndexedDB-only successful save is visible to the startup loader', async () => {
  const values = new Map();
  vi.stubGlobal('indexedDB', { open: () => {
    const req: any = {};
    queueMicrotask(() => {
      req.result = { transaction: () => {
        const tx: any = { objectStore: () => ({ put: (value: any, key: string) => values.set(key, value) }) };
        queueMicrotask(() => tx.oncomplete?.());
        return tx;
      } };
      req.onsuccess?.();
    });
    return req;
  } });
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('denied'); });
  const s = await import('../../src/lib/favoritesStorage');
  expect((await s.saveFavoriteLocations([location('idb-only')])).success).toBe(true);
  expect(values.get('favorites')).toHaveLength(1);
  expect(s.loadFavoriteLocations().map(x => x.id)).toEqual(['idb-only']);
});

it('R07 FIX-12/T12: cancelling the first subscriber must not fail the second', async () => {
  vi.stubGlobal('caches', undefined);
  const s = await import('../../src/lib/opfsTileCache');
  const controller = new AbortController();
  let completeNetwork: (bytes: Uint8Array) => void = () => {};
  const fetcher = vi.fn((signal?: AbortSignal) => new Promise<Uint8Array>((resolve, reject) => {
    completeNetwork = resolve;
    signal?.addEventListener('abort', () => reject(new Error('synthetic abort')));
  }));
  const a = s.getTileWithOpfsSWR({ category: 'raster', key: 'shared', fetcher, signal: controller.signal });
  const b = s.getTileWithOpfsSWR({ category: 'raster', key: 'shared', fetcher });
  const results = Promise.allSettled([a, b]);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(fetcher).toHaveBeenCalledTimes(1);
  controller.abort();
  completeNetwork(new Uint8Array(128));
  const settled = await results;
  expect(settled[1].status).toBe('fulfilled');
});

async function weatherSwResponse(mode: 'open-failure' | 'put-failure') {
  const handlers: Record<string, (event: any) => void> = {};
  const fetcher = vi.fn(async () => new Response('valid-weather', { status: 200 }));
  const code = readFileSync('public/sw.js', 'utf8');
  runInNewContext(code, {
    self: { addEventListener: (type: string, handler: any) => { handlers[type] = handler; },
      location: { origin: 'https://review.invalid' } },
    caches: { open: async () => {
      if (mode === 'open-failure') throw new Error('synthetic storage denied');
      return { match: async () => undefined, put: async () => { throw new Error('synthetic quota'); } };
    } },
    fetch: fetcher, URL, Response,
  });
  let response: Promise<Response> | undefined;
  handlers.fetch({ request: { method: 'GET', mode: 'cors', url: 'https://www.jma.go.jp/synthetic/tile.png' },
    respondWith: (p: Promise<Response>) => { response = p; }, waitUntil: () => {} });
  return response!;
}

it('R08 FIX-07: actual SW cache.open failure must allow weather network success', async () => {
  const response = await weatherSwResponse('open-failure');
  expect(response.status).toBe(200);
});

it('R09 FIX-07/09: actual SW cache.put failure must not discard a good network response', async () => {
  const response = await weatherSwResponse('put-failure');
  expect(response.status).toBe(200);
});

it('R10 FIX-08/T25: empty time strings must not fabricate a current frame', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [{ basetime: '', validtime: '', elements: ['hrpns'] }] })));
  const s = await import('../../src/lib/jmaNowcastClient');
  await expect(s.fetchJMANowcastCatalog()).rejects.toThrow();
});
