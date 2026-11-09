import type { PresetLocation } from '../types/map';

const FAVORITES_STORAGE_KEY = 'rain3d_favorite_locations_v1';

export const FAVORITE_AREA_GROUP = '⭐ お気に入り地点';

/**
 * ローカルストレージから登録済みのお気に入り地点一覧を読み込みます。
 */
export function loadFavoriteLocations(): PresetLocation[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is PresetLocation =>
        item &&
        typeof item.id === 'string' &&
        typeof item.name === 'string' &&
        Array.isArray(item.center) &&
        item.center.length === 2 &&
        typeof item.zoom === 'number' &&
        typeof item.pitch === 'number' &&
        typeof item.bearing === 'number'
    );
  } catch (err) {
    console.warn('Failed to load favorite locations from localStorage:', err);
    return [];
  }
}

/**
 * お気に入り地点一覧をローカルストレージに永続保存します。
 */
export function saveFavoriteLocations(favorites: PresetLocation[]): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(favorites));
  } catch (err) {
    console.warn('Failed to save favorite locations to localStorage:', err);
  }
}

const FAVORITES_UNDO_KEY = 'rain3d_favorite_locations_undo_v1';
const FAVORITES_LAST_BACKUP_KEY = 'rain3d_favorite_last_backup_at_v1';

/**
 * 取り込み（追加／置き換え）直前のお気に入り一覧を1世代だけ退避します。
 */
export function saveFavoritesUndoSnapshot(favorites: PresetLocation[]): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(
      FAVORITES_UNDO_KEY,
      JSON.stringify({ savedAt: new Date().toISOString(), items: favorites })
    );
  } catch (err) {
    console.warn('Failed to save favorites undo snapshot:', err);
  }
}

/**
 * 退避済みのお気に入り一覧（取り込み前の状態）を読み込みます。存在しなければ null。
 */
export function loadFavoritesUndoSnapshot(): { savedAt: string; items: PresetLocation[] } | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(FAVORITES_UNDO_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.items)) return null;
    return { savedAt: String(parsed.savedAt ?? ''), items: parsed.items as PresetLocation[] };
  } catch {
    return null;
  }
}

export function clearFavoritesUndoSnapshot(): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.removeItem(FAVORITES_UNDO_KEY);
  } catch {
    // noop
  }
}

/** 最後にJSONバックアップを書き出した日時（ISO 8601）を取得します。 */
export function loadLastBackupAt(): string | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    return window.localStorage.getItem(FAVORITES_LAST_BACKUP_KEY);
  } catch {
    return null;
  }
}

export function saveLastBackupAt(iso: string): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(FAVORITES_LAST_BACKUP_KEY, iso);
  } catch {
    // noop
  }
}

/**
 * ブラウザにストレージの永続化を要求し、容量逼迫時やSafari ITPによる自動削除を受けにくくします。
 * 許可されなくても動作に影響はありません。
 */
export function requestPersistentStorage(): void {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return;
    void navigator.storage
      .persisted()
      .then((already) => (already ? true : navigator.storage.persist()))
      .catch(() => undefined);
  } catch {
    // noop
  }
}

/**
 * 2つの経緯度座標が同一地点（約50m以内）かどうかを判定します。
 */
export function isSameCoordinate(
  lng1: number,
  lat1: number,
  lng2: number,
  lat2: number,
  tolerance = 0.0005
): boolean {
  return Math.abs(lng1 - lng2) <= tolerance && Math.abs(lat1 - lat2) <= tolerance;
}
