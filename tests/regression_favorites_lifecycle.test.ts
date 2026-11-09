import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  takeFavoritesPayloadFromLocation,
  hasPendingFavoritesPayload,
  clearPendingFavoritesPayload,
  PENDING_FAVORITES_PAYLOAD_KEY,
  decodeFavoritesPayload,
  MAX_FAVORITES,
  FavoritesTransferError,
} from '../src/lib/favoritesTransfer';

describe('Favorites, Sync URL & Lifecycle Regression Suite (T12-T22, T34, T37, T38)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    window.location.hash = '';
  });

  describe('T20, T21, T22: 同期URL保留とSW更新競合保護 (FIX-06)', () => {
    it('T20: 同期URLから開いた場合、sessionStorageに退避されURLハッシュが安全に管理される', () => {
      window.location.hash = '#fav=1jW10=';
      const payload = takeFavoritesPayloadFromLocation();
      expect(payload).toBe('1jW10=');
      expect(hasPendingFavoritesPayload()).toBe(true);

      // 初回controllerchangeが発生しても保留フラグがあればリロードを抑制できる
      expect(sessionStorage.getItem(PENDING_FAVORITES_PAYLOAD_KEY)).toBe('1jW10=');

      // 取り込み完了・キャンセル時にクリアされる
      clearPendingFavoritesPayload();
      expect(hasPendingFavoritesPayload()).toBe(false);
    });

    it('T22: sessionStorage が例外で拒否された場合、URLハッシュを残して救済する', () => {
      window.location.hash = '#fav=1jW10=';
      const origDescriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');

      Object.defineProperty(window, 'sessionStorage', {
        value: {
          getItem: () => null,
          setItem: () => {
            throw new Error('SecurityError: The operation is insecure');
          },
          removeItem: () => {},
        },
        configurable: true,
      });

      try {
        const payload = takeFavoritesPayloadFromLocation();
        expect(payload).toBe('1jW10=');
        // 保存失敗時はハッシュが消去されない (FIX-06, FIX-14)
        expect(window.location.hash).toContain('fav=1jW10=');
      } finally {
        if (origDescriptor) {
          Object.defineProperty(window, 'sessionStorage', origDescriptor);
        }
      }
    });
  });

  describe('T38: 上限強制と無警告欠落防止 (FIX-14)', () => {
    it('上限を超える件数の同期ペイロードはエラーをスローし無警告の欠落を防ぐ', async () => {
      const tooMany: any[] = [];
      for (let i = 0; i < MAX_FAVORITES * 2 + 5; i++) {
        tooMany.push(['spot', 13900000, 3500000, 1000, 0, 0, 0, 0]);
      }
      const rawJson = JSON.stringify(tooMany);
      const b64 = btoa(rawJson).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const payload = `1j${b64}`;

      await expect(decodeFavoritesPayload(payload)).rejects.toThrow(FavoritesTransferError);
    });
  });
});
