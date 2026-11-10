// Review probes: old-data compatibility, restart/rollback, denied reads, malformed time.
// Expectations express required behavior. All data are synthetic; no external network.
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const loc = (id: string, name = id) => ({ id, name, center: [139, 35] as [number, number], zoom: 10, pitch: 60, bearing: 0, elevation: 1, region: 'fixture', description: 'fixture', emoji: '*' });
beforeEach(() => { vi.resetModules(); vi.stubGlobal('indexedDB', undefined); localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('S01 ADD-01: editing old 101-item data must not permanently erase item 101', async () => {
  const s = await import('../../src/lib/favoritesStorage');
  const old = Array.from({ length: 101 }, (_, i) => loc(`old-${i}`));
  localStorage.setItem('rain3d_favorite_locations_v1', JSON.stringify(old));
  const loaded = s.loadFavoriteLocations();
  loaded[0] = { ...loaded[0], name: 'edited' };
  await s.saveFavoriteLocations(loaded);
  const persisted = JSON.parse(localStorage.getItem('rain3d_favorite_locations_v1')!);
  expect(persisted.some((f: any) => f.id === 'old-100')).toBe(true);
  s.resetFavoritesMemoryCacheForTesting();
  expect(s.loadFavoriteLocations()).toHaveLength(101);
  expect(s.loadFavoriteLocations()[0].name).toBe('edited');
});

it('S02 ADD-01: editing another item must not erase a legacy 60-character name', async () => {
  const s = await import('../../src/lib/favoritesStorage');
  localStorage.setItem('rain3d_favorite_locations_v1', JSON.stringify([loc('long', 'x'.repeat(60)), loc('short')]));
  const loaded = s.loadFavoriteLocations();
  loaded[1] = { ...loaded[1], name: 'edited' };
  expect((await s.saveFavoriteLocations(loaded)).success).toBe(true);
  s.resetFavoritesMemoryCacheForTesting();
  expect(s.loadFavoriteLocations().find(f => f.id === 'long')?.name).toHaveLength(60);
});

it('S03 ADD-02: single commit reports success and reloads new state without a second write', async () => {
  const s = await import('../../src/lib/favoritesStorage');
  await s.saveFavoriteLocations([loc('old')]);
  const write = localStorage.setItem.bind(localStorage);
  let writes = 0;
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (++writes > 1) throw new DOMException('fixture denied', 'QuotaExceededError');
    write(key, value);
  });
  const result = await s.saveFavoritesAndUndoAtomic([loc('new')], [loc('old')]);
  expect(result.success).toBe(true);
  s.resetFavoritesMemoryCacheForTesting(); // actual restart semantics, not same-session cache
  expect(s.loadFavoriteLocations().map(f => f.id)).toEqual(['new']);
});

it('S04 ADD-02: denied localStorage reads must return a failure result, not reject', async () => {
  const s = await import('../../src/lib/favoritesStorage');
  vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new DOMException('fixture denied', 'SecurityError'); });
  await expect(s.saveFavoriteLocations([loc('new')])).resolves.toMatchObject({ success: false });
});

it('S05 ADD-01: backup restore must not silently shorten a legacy name', async () => {
  const s = await import('../../src/lib/favoritesTransfer');
  // Either explicit rejection or lossless import is acceptable; silent transformation is not.
  let restored;
  try { restored = s.parseBackupJson(JSON.stringify([loc('long', 'x'.repeat(60))])); }
  catch { return; }
  expect(restored[0].name).toHaveLength(60);
});

it('S06 ADD-07: February 31 must not create a March observation', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('N1') ? [{ basetime: '20260231060000', validtime: '20260231060000', elements: ['hrpns'] }] : [])));
  const s = await import('../../src/lib/jmaNowcastClient');
  await expect(s.fetchJMANowcastCatalog()).rejects.toThrow();
});

it('S07 ADD-09: OPFS initialization can recover after a transient timeout', async () => {
  vi.useFakeTimers(); vi.stubGlobal('caches', undefined);
  const getDirectory = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockRejectedValue(new Error('fixture recovered API invoked'));
  vi.stubGlobal('navigator', { storage: { getDirectory } });
  const s = await import('../../src/lib/opfsTileCache');
  const first = s.getTileWithOpfsSWR({ category: 'raster', key: 'one', fetcher: async () => new Uint8Array(128) });
  await vi.advanceTimersByTimeAsync(10000); await first;
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // allow a temporary backend cooldown
  await s.getTileWithOpfsSWR({ category: 'raster', key: 'two', fetcher: async () => new Uint8Array(128) });
  expect(getDirectory.mock.calls.length).toBeGreaterThan(1);
});
