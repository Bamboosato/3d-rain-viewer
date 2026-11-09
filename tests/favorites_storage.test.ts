import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  filterAndValidateFavorites,
  isValidFavoriteLocation,
  loadFavoriteLocationsSync,
  loadFavoriteLocationsAsync,
  saveFavoriteLocations,
  saveFavoritesAndUndoAtomic,
  loadFavoritesUndoSnapshot,
  restoreFavoritesUndo,
  clearFavoritesUndoSnapshot,
  resetFavoritesMemoryCacheForTesting,
  safeGetLocalStorage,
  MAX_FAVORITES_COUNT,
} from '../src/lib/favoritesStorage';
import type { PresetLocation } from '../src/types/map';

const validLocation: PresetLocation = {
  id: 'loc-1',
  name: '富士山',
  region: '中部',
  emoji: '🗻',
  elevation: 3776,
  center: [138.7274, 35.3606],
  zoom: 12,
  pitch: 60,
  bearing: 0,
  description: '富士山頂',
};

describe('favoritesStorage & validation (FIX-03, FIX-14)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('indexedDB', undefined);
    localStorage.clear();
    resetFavoritesMemoryCacheForTesting();
  });

  describe('T35: 不正データ・storage getter例外保護 (FIX-14)', () => {
    it('正常な地点データはバリデーションを通過する', () => {
      expect(isValidFavoriteLocation(validLocation)).toBe(true);
    });

    it('不正な座標（NaN, 範囲外）を弾く', () => {
      expect(isValidFavoriteLocation({ ...validLocation, center: [NaN, 35.0] })).toBe(false);
      expect(isValidFavoriteLocation({ ...validLocation, center: [200.0, 35.0] })).toBe(false);
      expect(isValidFavoriteLocation({ ...validLocation, center: [138.0, 95.0] })).toBe(false);
    });

    it('不正なIDや長すぎる名前を弾く', () => {
      expect(isValidFavoriteLocation({ ...validLocation, id: '' })).toBe(false);
      expect(isValidFavoriteLocation({ ...validLocation, name: 'a'.repeat(60) })).toBe(false);
    });

    it('不正項目を除外して有効なもののみ取得し、除外件数を報告する', () => {
      const raw = [
        validLocation,
        { id: 'bad-1', name: '無効', center: [999, 999] },
        { ...validLocation, id: 'loc-2', name: '八ヶ岳' },
      ];
      const res = filterAndValidateFavorites(raw);
      expect(res.valid.length).toBe(2);
      expect(res.rejectedCount).toBe(1);
    });

    it('MAX_FAVORITES_COUNT (100件) 超過分は除外される', () => {
      const many: PresetLocation[] = [];
      for (let i = 0; i < 110; i++) {
        many.push({ ...validLocation, id: `loc-${i}`, name: `地点${i}` });
      }
      const res = filterAndValidateFavorites(many);
      expect(res.valid.length).toBe(MAX_FAVORITES_COUNT);
      expect(res.rejectedCount).toBe(10);
    });
  });

  describe('T16, T17: お気に入り保存の非同期化・原子性と失敗伝達 (FIX-03)', () => {
    it('正常時に非同期保存が成功する', async () => {
      const res = await saveFavoriteLocations([validLocation]);
      expect(res.success).toBe(true);

      const loaded = await loadFavoriteLocationsAsync();
      expect(loaded.length).toBe(1);
      expect(loaded[0].name).toBe('富士山');
    });

    it('QuotaExceeded例外時に保存失敗を呼び出し元へ報告する (T16)', async () => {
      const origSetItem = localStorage.setItem;
      const quotaErr = new Error('Quota exceeded');
      quotaErr.name = 'QuotaExceededError';
      const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
        throw quotaErr;
      });

      try {
        const res = await saveFavoriteLocations([validLocation]);
        // IndexedDBがモック環境で使えない、またはlocalStorage失敗時にQuotaエラーを報告
        expect(res.success).toBe(false);
        expect(res.error).toBe('quota');
      } finally {
        spy.mockRestore();
      }
    });

    it('お気に入りとUndoを原子的に保存・復元できる (T17, T18)', async () => {
      const oldList = [validLocation];
      const newList = [{ ...validLocation, id: 'loc-2', name: '槍ヶ岳' }];

      const res = await saveFavoritesAndUndoAtomic(newList, oldList);
      expect(res.success).toBe(true);

      const undo = await loadFavoritesUndoSnapshot();
      expect(undo).not.toBeNull();
      expect(undo?.items.length).toBe(1);
      expect(undo?.items[0].name).toBe('富士山');

      // Undo復元
      const restoreRes = await restoreFavoritesUndo();
      expect(restoreRes.success).toBe(true);
      expect(restoreRes.restoredItems?.[0].name).toBe('富士山');

      // 復元成功後はUndoがクリアされる
      const cleared = await loadFavoritesUndoSnapshot();
      expect(cleared).toBeNull();
    });
  });
});
