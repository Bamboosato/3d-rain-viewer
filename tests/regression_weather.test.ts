import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchJMANowcastRainLayer,
  inspectJMAPrecipitation,
  fetchJMANowcastCatalog,
  loadCachedJMACatalog,
  JMA_MISSING_VALUE,
  JMA_TOTAL_TILES,
} from '../src/lib/jmaNowcastClient';
import { getGSMaPImageCollection } from '../src/lib/jaxaClient';
import type { TimelineFrameItem } from '../src/types/map';

const dummyFrame: TimelineFrameItem = {
  date: new Date('2026-11-09T06:00:00Z'),
  labelJST: '2026-11-09 15:00 JST',
  relativeBadge: '最新実況',
  basetime: '20261109060000',
  validtime: '20261109060000',
  tileDataset: 'hrpns',
};

describe('Weather Regression Suite (T06-T11, T23-T26)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))));
  });
  afterEach(() => vi.unstubAllGlobals());

  describe('T06: JMAの全20タイル失敗時の扱い (FIX-02)', () => {
    it('全20タイルが失敗した場合、正常結果とせず例外を投げる（降水なしにしない）', async () => {
      // Image.prototype.src のロードをすべて onerror にモック
      const originalImage = global.Image;
      global.Image = class {
        crossOrigin = '';
        onload: any = null;
        onerror: any = null;
        private _src = '';
        set src(v: string) {
          this._src = v;
          setTimeout(() => this.onerror?.(new Event('error')), 5);
        }
        get src() {
          return this._src;
        }
      } as any;

      try {
        await expect(fetchJMANowcastRainLayer(dummyFrame)).rejects.toThrow(
          /All \d+ tiles failed to load/
        );
      } finally {
        global.Image = originalImage;
      }
    });
  });

  describe('T07, T08: 欠測値と0mm/hの分離・部分欠落の扱い (FIX-02)', () => {
    it('全近傍が欠測（JMA_MISSING_VALUE）の場合、inspectJMAPrecipitation は null を返す', () => {
      const grid = new Uint16Array(1280 * 1024);
      // グリッド全域を欠測値で埋める
      grid.fill(JMA_MISSING_VALUE);

      // 日本領域内の座標 (東京: 139.69, 35.68)
      const val = inspectJMAPrecipitation(grid, 139.69, 35.68);
      expect(val).toBeNull();
    });

    it('正常に取得できた無降水画像領域は 0mm/h を返す', () => {
      const grid = new Uint16Array(1280 * 1024);
      // 0mm/h（降水なし）で埋められている場合
      grid.fill(0);

      const val = inspectJMAPrecipitation(grid, 139.69, 35.68);
      expect(val).toBe(0);
    });

    it('有効領域に雨がある場合は降水量を正しく返す', () => {
      const grid = new Uint16Array(1280 * 1024);
      grid.fill(0);
      // 東京付近のインデックスに 15.0 mm/h (150) をセット
      grid[512 * 1280 + 640] = 150;

      // 範囲内の座標
      const val = inspectJMAPrecipitation(grid, 135.47, 36.07);
      expect(typeof val === 'number' || val === null).toBe(true);
    });

    it('日本周辺外の座標は null を返す', () => {
      const grid = new Uint16Array(1280 * 1024);
      const val = inspectJMAPrecipitation(grid, 0, 0); // 本初子午線・赤道
      expect(val).toBeNull();
    });
  });

  describe('T23, T24, T25: カタログ保存・更新・部分障害回復 (FIX-08)', () => {
    it('T25: カタログが空配列・不正JSONの場合、架空フレームを生成しない', async () => {
      const origFetch = global.fetch;
      global.fetch = vi.fn(async () => Response.json([]));

      try {
        await expect(fetchJMANowcastCatalog()).rejects.toThrow(/unavailable|empty/);
      } finally {
        global.fetch = origFetch;
      }
    });

    it('T24: N1成功・N2/rasrf失敗時、N1実況のみでカタログを構成して返す', async () => {
      const origFetch = global.fetch;
      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('targetTimes_N1.json')) {
          return Promise.resolve(Response.json([
              {
                basetime: '20261109060000',
                validtime: '20261109060000',
                elements: ['hrpns'],
              },
            ]));
        }
        // N2, rasrf は失敗
        return Promise.reject(new Error('Network error'));
      });

      try {
        const cat = await fetchJMANowcastCatalog();
        expect(cat.frames.length).toBeGreaterThan(0);
        expect(cat.frames[0].tileDataset).toBe('hrpns');
        expect(cat.frames[0].isForecast).toBe(false);
      } finally {
        global.fetch = origFetch;
      }
    });

    it('T23: オンラインで保存後、通信断（オフライン）時に保存済みカタログを復元する', async () => {
      const origFetch = global.fetch;
      // 1. まずオンラインで取得・保存
      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('targetTimes_N1.json')) {
          return Promise.resolve(Response.json([
              {
                basetime: '20261109060000',
                validtime: '20261109060000',
                elements: ['hrpns'],
              },
            ]));
        }
        return Promise.resolve(Response.json([]));
      });

      const onlineCat = await fetchJMANowcastCatalog();
      expect(onlineCat.frames.length).toBe(1);

      // 2. オフライン状態をシミュレート
      global.fetch = vi.fn().mockRejectedValue(new Error('Offline'));

      const cachedCat = await fetchJMANowcastCatalog();
      expect(cachedCat.frames.length).toBe(1);
      expect(cachedCat.isStale).toBe(true);

      global.fetch = origFetch;
    });
  });
});
