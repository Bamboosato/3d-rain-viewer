import { diagnostic } from './diagnostics';
import type { PresetLocation } from '../types/map';
import type { ErrorKind } from '../types/status';
import { isFavoriteCategory } from './favoriteCategories';

export const FAVORITE_AREA_GROUP = '⭐ お気に入り地点';
export const MAX_FAVORITES_COUNT = 100;
export const MAX_NAME_LENGTH = 50;

const DB_NAME = 'rain3d_db';
const DB_VERSION = 1;
const STORE_NAME = 'kv_store';

const FAVORITES_STORAGE_KEY = 'rain3d_favorite_locations_v1';
const FAVORITES_UNDO_KEY = 'rain3d_favorite_locations_undo_v1';
const FAVORITES_LAST_BACKUP_KEY = 'rain3d_favorite_last_backup_at_v1';
const FAVORITES_ATOMIC_KEY = 'rain3d_favorite_atomic_state_v1';

let memoryFavoritesCache: PresetLocation[] | null = null;

export interface StorageOperationResult {
  success: boolean;
  error?: ErrorKind;
  message?: string;
}

export interface FavoritesUndoData {
  savedAt: string;
  items: PresetLocation[];
}

/**
 * テスト用キャッシュクリア関数
 */
export function resetFavoritesMemoryCacheForTesting(): void {
  memoryFavoritesCache = null;
  currentState = null;
  storageWarning = null;
  storageBlocked = false;
}

/**
 * window.localStorage を安全に取得（SecurityErrorなどの例外を捕捉）
 */
export function safeGetLocalStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * 地点データの型・座標範囲・有限性を厳格に検証 (FIX-14, ADD-01)
 */
export function isValidFavoriteLocation(item: unknown): item is PresetLocation {
  if (!item || typeof item !== 'object') return false;
  const loc = item as Partial<PresetLocation>;

  if (typeof loc.id !== 'string' || !/^[\w.-]{1,64}$/.test(loc.id)) return false;
  if (typeof loc.name !== 'string' || loc.name.trim().length === 0) return false;
  if (loc.name.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(loc.name)) return false;
  for (const date of [loc.createdAt, loc.updatedAt]) if (date !== undefined && (typeof date !== 'string' || !Number.isFinite(Date.parse(date)))) return false;
  if (loc.isPinned !== undefined && typeof loc.isPinned !== 'boolean') return false;
  if (loc.category !== undefined && !isFavoriteCategory(loc.category)) return false;
  if (loc.elevation !== undefined && !Number.isFinite(loc.elevation)) return false;

  if (!Array.isArray(loc.center) || loc.center.length !== 2) return false;
  const [lng, lat] = loc.center;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return false;

  if (typeof loc.zoom !== 'number' || !Number.isFinite(loc.zoom) || loc.zoom < 0 || loc.zoom > 24)
    return false;
  if (
    typeof loc.pitch !== 'number' ||
    !Number.isFinite(loc.pitch) ||
    loc.pitch < 0 ||
    loc.pitch > 85
  )
    return false;
  if (
    typeof loc.bearing !== 'number' ||
    !Number.isFinite(loc.bearing) ||
    loc.bearing < -180 ||
    loc.bearing > 360
  )
    return false;

  return true;
}

/**
 * 複数項目の検証と不正項目のフィルタリング
 */
export function filterAndValidateFavorites(items: unknown[]): {
  valid: PresetLocation[];
  rejectedCount: number;
} {
  if (!Array.isArray(items)) return { valid: [], rejectedCount: 0 };
  const valid: PresetLocation[] = [];
  let rejectedCount = 0;

  for (const item of items) {
    if (isValidFavoriteLocation(item)) {
      if (valid.length < MAX_FAVORITES_COUNT) {
        valid.push({
          ...item,
          category: isFavoriteCategory(item.category) ? item.category : 'other',
        });
      } else {
        rejectedCount++;
      }
    } else {
      rejectedCount++;
    }
  }

  return { valid, rejectedCount };
}

// A single record is the commit boundary in both backends. Legacy keys are read-only.
interface FavoritesState {
  version: 2;
  revision: number;
  favorites: PresetLocation[];
  undo: FavoritesUndoData | null;
  lastBackupAt: string | null;
}
const STATE_KEY = 'favorites_state_v2';
let currentState: FavoritesState | null = null;
let storageWarning: string | null = null;
let storageBlocked = false;
let operationQueue: Promise<unknown> = Promise.resolve();

export function getFavoritesStorageWarning(): string | null { return storageWarning; }
function warn(message: string, blocked = false) {
  storageWarning = message;
  storageBlocked ||= blocked;
}
function cloneLocations(items: PresetLocation[]): PresetLocation[] {
  return items.map(item => ({
    ...item,
    center: [...item.center] as [number, number],
    category: isFavoriteCategory(item.category) ? item.category : 'other',
  }));
}
function compatibleItems(value: unknown): PresetLocation[] | null {
  if (!Array.isArray(value)) return null;
  // Preserve legacy limits; never silently discard a record on read.
  if (!value.every(item => item && typeof item.name === 'string' &&
    isValidFavoriteLocation({ ...item, name: item.name.slice(0, MAX_NAME_LENGTH) }))) return null;
  if (value.length > MAX_FAVORITES_COUNT || value.some(item => item.name.length > MAX_NAME_LENGTH)) {
    warn('旧データが現在の登録上限を超えています。元データは保持されています。書き出して保管し、件数・名前を確認してください。');
  }
  return cloneLocations(value);
}
function parseState(value: unknown, revision = 0): FavoritesState | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<FavoritesState>;
  const favorites = compatibleItems(raw.favorites);
  if (!favorites) { warn('保存データを検証できません。元データを保護するため更新を停止しました。', true); return null; }
  let undo: FavoritesUndoData | null = null;
  if (raw.undo) {
    const items = compatibleItems(raw.undo.items);
    if (!items || !Number.isFinite(Date.parse(raw.undo.savedAt))) {
      warn('取り消しデータが破損しています。元データを保護するため更新を停止しました。', true); return null;
    }
    undo = { items, savedAt: raw.undo.savedAt };
  }
  return { version: 2, revision: Number.isSafeInteger(raw.revision) && raw.revision! >= 0 ? raw.revision! : revision,
    favorites, undo, lastBackupAt: raw.lastBackupAt ?? null };
}
function readLocalState(): FavoritesState | null {
  const ls = safeGetLocalStorage();
  if (!ls) return null;
  try {
    const atomic = ls.getItem(FAVORITES_ATOMIC_KEY);
    if (atomic !== null) return parseState(JSON.parse(atomic));
    const legacy = ls.getItem(FAVORITES_STORAGE_KEY);
    if (legacy === null) return null;
    const undo = ls.getItem(FAVORITES_UNDO_KEY);
    return parseState({ favorites: JSON.parse(legacy), undo: undo ? JSON.parse(undo) : null,
      lastBackupAt: ls.getItem(FAVORITES_LAST_BACKUP_KEY) });
  } catch {
    warn('保存データを読み出せません。元データを保護するため更新を停止しました。', true);
    return null;
  }
}
function openFavoritesDb(): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (db: IDBDatabase | null) => {
      if (settled) { db?.close?.(); return; }
      settled = true; clearTimeout(timer); resolve(db);
    };
    const timer = setTimeout(() => finish(null), 5000);
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB) return finish(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME);
      };
      req.onsuccess = () => finish(req.result);
      req.onerror = () => finish(null);
      req.onblocked = () => finish(null);
    } catch { finish(null); }
  });
}
async function dbRead(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const timer = setTimeout(() => { try { tx.abort(); } catch { /* already ended */ } reject(new Error('storage timeout')); }, 5000);
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => { clearTimeout(timer); resolve(req.result); };
    req.onerror = () => { clearTimeout(timer); reject(new Error('storage read')); };
    tx.onabort = () => { clearTimeout(timer); reject(new Error('storage abort')); };
  });
}
async function readState(): Promise<FavoritesState> {
  storageBlocked = false; storageWarning = null;
  const local = readLocalState();
  let remote: FavoritesState | null = null;
  const db = await openFavoritesDb();
  if (db) {
    try {
      const record = await dbRead(db, STATE_KEY);
      if (record != null) remote = parseState(record);
      else {
        const favorites = await dbRead(db, 'favorites');
        if (favorites != null) remote = parseState({ favorites, undo: await dbRead(db, 'favorites_undo') });
      }
    } catch { warn('保存先の読み出しに失敗しました。再試行してください。', true); }
    finally { db.close?.(); }
  }
  // Equal-generation legacy IDB takes precedence, including an explicitly empty list.
  let chosen = remote && (!local || remote.revision >= local.revision) ? remote : local;
  if (currentState && (!chosen || currentState.revision > chosen.revision)) chosen = currentState;
  currentState = chosen ?? { version: 2, revision: 0, favorites: [], undo: null, lastBackupAt: null };
  memoryFavoritesCache = cloneLocations(currentState.favorites);
  return currentState;
}
export function loadFavoriteLocationsSync(): PresetLocation[] {
  if (memoryFavoritesCache) return cloneLocations(memoryFavoritesCache);
  const local = readLocalState();
  if (local) currentState = local;
  return cloneLocations(local?.favorites ?? []);
}
export const loadFavoriteLocations = loadFavoriteLocationsSync;
export async function loadFavoriteLocationsAsync(): Promise<PresetLocation[]> {
  return cloneLocations((await readState()).favorites);
}
async function commit(state: FavoritesState): Promise<StorageOperationResult> {
  let success = false;
  let quota = false;
  let backend: 'idb' | 'localStorage' = 'idb';
  const db = await openFavoritesDb();
  if (db) {
    try {
      success = await new Promise<boolean>(resolve => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const timer = setTimeout(() => { try { tx.abort(); } catch { /* ended */ } }, 5000);
        tx.oncomplete = () => { clearTimeout(timer); resolve(true); };
        tx.onerror = tx.onabort = () => { clearTimeout(timer); resolve(false); };
        const store = tx.objectStore(STORE_NAME);
        store.put(state, STATE_KEY);
        // Old readers see a coherent copy because these writes share this transaction.
        store.put(state.favorites, 'favorites');
        if (state.undo) store.put(state.undo, 'favorites_undo');
        else store.delete('favorites_undo');
      });
    } catch { /* local fallback */ }
    finally { db.close?.(); }
  }
  try {
    const ls = safeGetLocalStorage();
    if (ls) { ls.setItem(FAVORITES_ATOMIC_KEY, JSON.stringify(state)); if (!success) backend = 'localStorage'; success = true; }
  } catch (error) { quota = error instanceof Error && error.name === 'QuotaExceededError'; }
  diagnostic({ operation: 'favorites-commit', backend, outcome: success ? 'success' : 'failure', count: state.favorites.length });
  if (!success) return { success: false, error: quota ? 'quota' : 'storage-unavailable', message: '保存できませんでした。変更前のデータは保持されています。' };
  currentState = state; memoryFavoritesCache = cloneLocations(state.favorites);
  if (state.favorites.length <= MAX_FAVORITES_COUNT && state.favorites.every(isValidFavoriteLocation)) storageWarning = null;
  return { success: true };
}
function updateState(change: (state: FavoritesState) => FavoritesState | StorageOperationResult): Promise<StorageOperationResult> {
  const task = operationQueue.then(async () => {
    const state = await readState();
    if (storageBlocked) return { success: false, error: 'storage-unavailable' as const, message: storageWarning ?? '保存データを確認できません。' };
    const next = change(state);
    if ('success' in next) return next;
    return commit({ ...next, revision: Math.max(Date.now(), state.revision + 1) });
  }).catch((): StorageOperationResult => ({ success: false, error: 'storage-unavailable', message: '保存処理に失敗しました。再試行してください。' }));
  operationQueue = task;
  return task;
}
function validateWrite(items: PresetLocation[], previous: PresetLocation[] = []): StorageOperationResult | null {
  if (!Array.isArray(items) || new Set(items.map(item => item?.id)).size !== items.length) return { success: false, error: 'invalid-data', message: '保存対象または地点IDが不正です。' };
  const legacyCount = previous.length > MAX_FAVORITES_COUNT && items.length <= previous.length && items.every(item => previous.some(old => old.id === item.id));
  const validItem = (item: PresetLocation) => isValidFavoriteLocation(item as unknown) || (
    previous.some(old => old.id === item.id && old.name === item.name) &&
    isValidFavoriteLocation({ ...item, name: item.name.slice(0, MAX_NAME_LENGTH) }));
  if (!Array.isArray(items) || (items.length > MAX_FAVORITES_COUNT && !legacyCount) || !items.every(validItem)) {
    return { success: false, error: 'invalid-data', message: `登録は${MAX_FAVORITES_COUNT}件、名前は${MAX_NAME_LENGTH}文字以内です。元データは保持されています。` };
  }
  return null;
}
export function saveFavoriteLocations(favorites: PresetLocation[]): Promise<StorageOperationResult> {
  return updateState(state => validateWrite(favorites, state.favorites) ?? { ...state, favorites: cloneLocations(favorites) });
}
export function saveFavoritesAndUndoAtomic(favorites: PresetLocation[], undoItems: PresetLocation[]): Promise<StorageOperationResult> {
  return updateState(state => validateWrite(favorites, state.favorites) ?? (compatibleItems(undoItems) ? null : validateWrite(undoItems)) ??
    { ...state, favorites: cloneLocations(favorites), undo: { savedAt: new Date().toISOString(), items: cloneLocations(undoItems) } });
}
export async function loadFavoritesUndoSnapshot(): Promise<FavoritesUndoData | null> { return (await readState()).undo; }
export async function clearFavoritesUndoSnapshot(): Promise<void> { await updateState(state => ({ ...state, undo: null })); }
export async function restoreFavoritesUndo(): Promise<StorageOperationResult & { restoredItems?: PresetLocation[] }> {
  let restoredItems: PresetLocation[] | undefined;
  const result = await updateState(state => {
    if (!state.undo) return { success: false, error: 'invalid-data', message: '復元できる取り消しデータがありません。' };
    const invalid = validateWrite(state.undo.items, state.undo.items);
    if (invalid) return invalid;
    restoredItems = cloneLocations(state.undo.items);
    return { ...state, favorites: restoredItems, undo: null };
  });
  return { ...result, restoredItems: result.success ? restoredItems : undefined };
}
/** Rescue copy only: preserve undecodable source text instead of exporting a filtered empty list. */
export async function readFavoritesRecoveryData(): Promise<Record<string, unknown>> {
  const sources: Record<string, unknown> = {};
  for (const key of [FAVORITES_ATOMIC_KEY, FAVORITES_STORAGE_KEY, FAVORITES_UNDO_KEY, FAVORITES_LAST_BACKUP_KEY]) {
    try { sources[key] = safeGetLocalStorage()?.getItem(key) ?? null; } catch { sources[key] = 'unavailable'; }
  }
  const db = await openFavoritesDb();
  if (db) {
    try { for (const key of [STATE_KEY, 'favorites', 'favorites_undo']) sources['idb:' + key] = await dbRead(db, key); }
    finally { db.close?.(); }
  }
  return sources;
}
export function loadLastBackupAt(): string | null {
  try { return currentState?.lastBackupAt ?? readLocalState()?.lastBackupAt ?? safeGetLocalStorage()?.getItem(FAVORITES_LAST_BACKUP_KEY) ?? null; }
  catch { return null; }
}
export async function saveLastBackupAt(iso: string): Promise<StorageOperationResult> {
  return updateState(state => ({ ...state, lastBackupAt: iso }));
}

/**
 * 2つの経緯度座標が同一地点（約50m以内）かどうかを判定
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

/**
 * ストレージ永続化要求
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

export function saveFavoritesUndoSnapshot(favorites: PresetLocation[]): void {
  void saveFavoritesAndUndoAtomic(favorites, favorites);
}
