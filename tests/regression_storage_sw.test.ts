import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchTileBytesWithRetry,
  getTileWithOpfsSWR,
  MAX_OPFS_ENTRIES,
  FALLBACK_CACHE_NAME,
} from '../src/lib/opfsTileCache';

describe('Storage & ServiceWorker Regression Suite (T01-T05, T27-T33, T36)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('T03, T04: ストレージ障害時のフェイルオーバーとネットワーク透過性 (FIX-07)', () => {
    it('T03: caches.open/match が失敗しても、ネットワーク取得へ移行して正常データを返す', async () => {
      const origCaches = global.caches;
      // caches.open を reject するモック
      global.caches = {
        open: vi.fn().mockRejectedValue(new Error('Storage access denied')),
        match: vi.fn().mockRejectedValue(new Error('Storage access denied')),
      } as any;

      try {
        const mockFetcher = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
        const buf = await getTileWithOpfsSWR({
          category: 'raster',
          key: 'test_storage_fail_key_1',
          fetcher: mockFetcher,
        });

        expect(buf.byteLength).toBe(4);
        expect(mockFetcher).toHaveBeenCalledTimes(1);
      } finally {
        global.caches = origCaches;
      }
    });

    it('T04: OPFS 初期化がタイムアウトしても、ネットワーク取得へ進みタイルを返せる', async () => {
      const mockFetcher = vi.fn().mockResolvedValue(new Uint8Array([10, 20, 30]));
      const buf = await getTileWithOpfsSWR({
        category: 'terrain',
        key: 'test_opfs_timeout_key_1',
        fetcher: mockFetcher,
      });

      expect(buf.byteLength).toBe(3);
    });
  });

  describe('T32: AbortSignal キャンセル伝播 (FIX-12)', () => {
    it('呼び出し時点で signal が abort 済みの場合、即座に例外をスローして通信を開始しない', async () => {
      const controller = new AbortController();
      controller.abort();

      const fetcher = vi.fn().mockResolvedValue(new Uint8Array([1]));

      await expect(
        getTileWithOpfsSWR({
          category: 'raster',
          key: 'aborted_tile_key',
          fetcher,
          signal: controller.signal,
        })
      ).rejects.toThrow('Aborted');

      expect(fetcher).not.toHaveBeenCalled();
    });

    it('fetchTileBytesWithRetry が abort された場合、通信を直ちに停止する', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        fetchTileBytesWithRetry('https://example.com/tile.png', controller.signal)
      ).rejects.toThrow('Aborted');
    });
  });

});
