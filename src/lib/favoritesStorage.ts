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
