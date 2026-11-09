import type { PresetLocation } from '../types/map';
import {
  FAVORITE_AREA_GROUP,
  isSameCoordinate,
  isValidFavoriteLocation,
  MAX_FAVORITES_COUNT,
  MAX_NAME_LENGTH,
} from './favoritesStorage';
import { PUBLIC_APP_ORIGIN } from './urlSync';

/**
 * お気に入り地点の端末間引き継ぎ・バックアップ（サーバー不要）
 *
 * - JSONファイル書き出し／読み込み
 * - 同期URL（`#fav=...` にお気に入り全件を圧縮して埋め込み）／QRコード
 * - 取り込み時のマージ（追加）／置き換え
 */

export const BACKUP_APP_ID = '3d-rain-viewer';
export const BACKUP_KIND = 'favorites';
export const BACKUP_SCHEMA_VERSION = 1;

/** 1回の取り込み・保存で扱うお気に入りの最大件数（不正データ対策） (FIX-14, ADD-01) */
export const MAX_FAVORITES = MAX_FAVORITES_COUNT;
/** 読み込むJSONファイルの最大サイズ */
export const MAX_BACKUP_FILE_BYTES = 1024 * 1024;
/** 同期URL `#fav=` ペイロードの最大文字数 */
const MAX_HASH_PAYLOAD_CHARS = 64 * 1024;
/** 同期URL展開後の最大バイト数（圧縮爆弾対策） */
const MAX_DECODED_BYTES = 1024 * 1024;
export { MAX_NAME_LENGTH };

export const FAVORITES_HASH_KEY = 'fav';

export interface FavoritesBackupFile {
  app: typeof BACKUP_APP_ID;
  kind: typeof BACKUP_KIND;
  schema: number;
  exportedAt: string;
  count: number;
  items: PresetLocation[];
}

export type ImportMode = 'merge' | 'replace';

export interface MergePreview {
  next: PresetLocation[];
  added: number;
  updated: number;
  unchanged: number;
  /** 置き換え時に消える件数 */
  removed: number;
  /** 上限超過で切り捨てられた件数 */
  truncated: number;
}

export class FavoritesTransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FavoritesTransferError';
  }
}

function clamp(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function toTimestamp(iso?: string): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function sanitizeIso(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

function sanitizeName(v: unknown): string {
  if (typeof v !== 'string') return '';
  // 制御文字を除去し、長さを制限
  // eslint-disable-next-line no-control-regex
  if (v.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(v)) throw new FavoritesTransferError('名前が長すぎるか制御文字を含みます。元のファイルで確認してください。');
  return v.trim();
}

export interface FavoriteInput {
  id?: string;
  name: string;
  lng: number;
  lat: number;
  zoom: number;
  pitch: number;
  bearing: number;
  elevation?: number;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * 最小限の情報からお気に入り地点（PresetLocation）を組み立てます。
 * 表示用の region / description はここで再生成するため、外部データの文言は信用しません。
 */
export function buildFavoriteLocation(input: FavoriteInput): PresetLocation {
  const zoom = Number(clamp(input.zoom, 3, 18).toFixed(2));
  const pitch = Math.round(clamp(input.pitch, 0, 85));
  const bearing = Math.round(clamp(input.bearing, -180, 180));
  const now = new Date().toISOString();
  return {
    id: input.id ?? `fav-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: input.name,
    emoji: '⭐',
    areaGroup: FAVORITE_AREA_GROUP,
    region: `ズーム${zoom.toFixed(1)} · 傾き${pitch}°`,
    elevation: Math.round(isFiniteNumber(input.elevation) ? clamp(input.elevation, -500, 9000) : 0),
    center: [input.lng, input.lat],
    zoom,
    pitch,
    bearing,
    description: `登録時点のカメラ設定（縮尺 ${zoom.toFixed(1)} / 傾き ${pitch}° / 方角 ${bearing}°）を記憶したお気に入り地点です。`,
    isFavorite: true,
    createdAt: input.createdAt ?? input.updatedAt ?? now,
    updatedAt: input.updatedAt ?? input.createdAt ?? now,
  };
}

/**
 * 外部から読み込んだ1件分のデータを検証・正規化します。不正な場合は null。
 */
function sanitizeFavorite(raw: unknown): PresetLocation | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const name = sanitizeName(item.name);
  if (!name) return null;
  const center = item.center;
  if (!Array.isArray(center) || center.length !== 2) return null;
  const [lng, lat] = center;
  if (!isFiniteNumber(lng) || !isFiniteNumber(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) {
    return null;
  }
  if (!isFiniteNumber(item.zoom) || !isFiniteNumber(item.pitch) || !isFiniteNumber(item.bearing)) {
    return null;
  }
  const id =
    typeof item.id === 'string' && /^[\w.-]{1,64}$/.test(item.id) ? item.id : undefined;
  if (item.id !== undefined && id === undefined) throw new FavoritesTransferError('地点IDが不正です。');
  if (!isValidFavoriteLocation({ ...item, id: id ?? 'import', name })) throw new FavoritesTransferError('地点の座標・視点設定が不正です。');
  for (const key of ['createdAt', 'updatedAt']) if (item[key] !== undefined && !sanitizeIso(item[key])) throw new FavoritesTransferError('登録日時が不正です。');
  return { ...buildFavoriteLocation({
    id,
    name,
    lng,
    lat,
    zoom: item.zoom,
    pitch: item.pitch,
    bearing: item.bearing,
    elevation: isFiniteNumber(item.elevation) ? item.elevation : 0,
    createdAt: sanitizeIso(item.createdAt),
    updatedAt: sanitizeIso(item.updatedAt),
  }), zoom: item.zoom, pitch: item.pitch, bearing: item.bearing };
}

function sanitizeList(rawItems: unknown[]): PresetLocation[] {
  if (rawItems.length > MAX_FAVORITES * 2) {
    throw new FavoritesTransferError(
      `データの件数が多すぎます（${rawItems.length}件）。上限は${MAX_FAVORITES}件です。`
    );
  }
  const items = rawItems
    .map(sanitizeFavorite)
    .filter((v): v is PresetLocation => v !== null);
  if (items.length !== rawItems.length) throw new FavoritesTransferError('不正な地点を含むため取り込みを停止しました。元のファイルを確認してください。');
  if (items.length === 0) {
    throw new FavoritesTransferError('取り込めるお気に入り地点が見つかりませんでした。');
  }
  return items;
}

/* ------------------------------------------------------------------ */
/* マージ                                                              */
/* ------------------------------------------------------------------ */

function findDuplicateIndex(list: PresetLocation[], target: PresetLocation): number {
  const byId = list.findIndex((f) => f.id === target.id);
  if (byId >= 0) return byId;
  return list.findIndex((f) =>
    isSameCoordinate(f.center[0], f.center[1], target.center[0], target.center[1])
  );
}

/** 取り込みデータ内の重複（同一ID・同一地点）を、更新日時が新しい方を残して除去します。 */
function dedupe(items: PresetLocation[]): PresetLocation[] {
  const result: PresetLocation[] = [];
  for (const item of items) {
    const idx = findDuplicateIndex(result, item);
    if (idx < 0) {
      result.push(item);
    } else if (toTimestamp(item.updatedAt) > toTimestamp(result[idx].updatedAt)) {
      result[idx] = item;
    }
  }
  return result;
}

/**
 * 取り込み結果を事前計算します（実際の保存は行いません）。
 * - merge: 既存を残したまま追加。同一ID／同一地点（約50m以内）は更新日時が新しい方を採用
 * - replace: 取り込みデータで全件置き換え
 */
export function previewImport(
  current: PresetLocation[],
  incomingRaw: PresetLocation[],
  mode: ImportMode
): MergePreview {
  const incoming = dedupe(incomingRaw);

  if (mode === 'replace') {
    const next = incoming.slice(0, MAX_FAVORITES);
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    for (const item of next) {
      const idx = findDuplicateIndex(current, item);
      if (idx < 0) added++;
      else if (toTimestamp(item.updatedAt) > toTimestamp(current[idx].updatedAt)) updated++;
      else unchanged++;
    }
    const keptCount = next.filter((item) => findDuplicateIndex(current, item) >= 0).length;
    return {
      next,
      added,
      updated,
      unchanged,
      removed: Math.max(0, current.length - keptCount),
      truncated: incoming.length - next.length,
    };
  }

  const merged = [...current];
  const newItems: PresetLocation[] = [];
  let updated = 0;
  let unchanged = 0;
  for (const item of incoming) {
    const idx = findDuplicateIndex(merged, item);
    if (idx < 0) {
      if (findDuplicateIndex(newItems, item) < 0) newItems.push(item);
      continue;
    }
    const existing = merged[idx];
    if (toTimestamp(item.updatedAt) > toTimestamp(existing.updatedAt)) {
      // 既存IDを維持して内容のみ更新（選択中プリセットとの紐付けを保つ）
      merged[idx] = { ...item, id: existing.id, createdAt: existing.createdAt ?? item.createdAt };
      updated++;
    } else {
      unchanged++;
    }
  }
  const room = Math.max(0, MAX_FAVORITES - merged.length);
  const acceptedNew = newItems.slice(0, room);
  return {
    next: [...acceptedNew, ...merged],
    added: acceptedNew.length,
    updated,
    unchanged,
    removed: 0,
    truncated: newItems.length - acceptedNew.length,
  };
}

/* ------------------------------------------------------------------ */
/* JSONファイル                                                         */
/* ------------------------------------------------------------------ */

export function buildBackupFile(favorites: PresetLocation[]): FavoritesBackupFile {
  return {
    app: BACKUP_APP_ID,
    kind: BACKUP_KIND,
    schema: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    count: favorites.length,
    items: favorites.map((f) => ({
      id: f.id,
      name: f.name,
      emoji: f.emoji,
      areaGroup: f.areaGroup,
      region: f.region,
      elevation: f.elevation,
      center: f.center,
      zoom: f.zoom,
      pitch: f.pitch,
      bearing: f.bearing,
      description: f.description,
      isFavorite: true,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    })),
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function buildBackupFileName(date = new Date()): string {
  const stamp = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(
    date.getHours()
  )}${pad2(date.getMinutes())}`;
  return `3d-rainscape-favorites-${stamp}.json`;
}

/**
 * お気に入りをJSONファイルとして書き出します。
 * スマホ（タッチ端末）では共有シート（ファイルに保存・AirDrop・LINE等）、PCではダウンロード保存。
 */
export async function exportFavoritesFile(
  favorites: PresetLocation[]
): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const json = JSON.stringify(buildBackupFile(favorites), null, 2);
  const fileName = buildBackupFileName();
  const blob = new Blob([json], { type: 'application/json' });

  const isTouchDevice =
    typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
  if (isTouchDevice && typeof navigator.share === 'function' && typeof File === 'function') {
    const file = new File([blob], fileName, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: '3D RainScape お気に入りバックアップ' });
        return 'shared';
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return 'cancelled';
        // 共有失敗時はダウンロードへフォールバック
      }
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
}

/**
 * JSONバックアップ文字列を解析してお気に入り一覧を返します。
 * 本アプリの書き出し形式のほか、お気に入り配列そのもの（旧形式）も受け付けます。
 */
export function parseBackupJson(text: string): PresetLocation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FavoritesTransferError('JSONファイルとして読み込めませんでした。');
  }
  if (Array.isArray(parsed)) {
    return sanitizeList(parsed);
  }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (obj.app !== undefined && obj.app !== BACKUP_APP_ID) {
      throw new FavoritesTransferError('3D RainScape のバックアップファイルではありません。');
    }
    if (obj.kind !== undefined && obj.kind !== BACKUP_KIND) {
      throw new FavoritesTransferError('お気に入りのバックアップファイルではありません。');
    }
    if (typeof obj.schema === 'number' && obj.schema > BACKUP_SCHEMA_VERSION) {
      throw new FavoritesTransferError(
        '新しいバージョンのアプリで作成されたファイルです。アプリを更新してから読み込んでください。'
      );
    }
    if (Array.isArray(obj.items)) {
      return sanitizeList(obj.items);
    }
  }
  throw new FavoritesTransferError('お気に入りのデータが含まれていません。');
}

export async function readBackupFile(file: File): Promise<PresetLocation[]> {
  if (file.size > MAX_BACKUP_FILE_BYTES) {
    throw new FavoritesTransferError('ファイルサイズが大きすぎます（上限 1MB）。');
  }
  const text = await file.text();
  return parseBackupJson(text);
}

/* ------------------------------------------------------------------ */
/* 同期URL / QR                                                        */
/* ------------------------------------------------------------------ */

/**
 * URL埋め込み用のコンパクト表現:
 * [name, lng×1e5, lat×1e5, zoom×100, pitch, bearing, elevation, updatedAt(UNIX秒)]
 */
type CompactFavorite = [string, number, number, number, number, number, number, number];

function toCompact(f: PresetLocation): CompactFavorite {
  return [
    f.name,
    Math.round(f.center[0] * 1e5),
    Math.round(f.center[1] * 1e5),
    Math.round(f.zoom * 100),
    Math.round(f.pitch),
    Math.round(f.bearing),
    Math.round(f.elevation || 0),
    Math.round(toTimestamp(f.updatedAt) / 1000),
  ];
}

function fromCompact(raw: unknown, index: number): PresetLocation | null {
  if (!Array.isArray(raw) || raw.length < 6) return null;
  const [name, lngE5, latE5, zoomE2, pitch, bearing, elevation, updatedSec] = raw;
  if (![lngE5, latE5, zoomE2, pitch, bearing].every(isFiniteNumber)) return null;
  const updatedAt =
    isFiniteNumber(updatedSec) && updatedSec > 0
      ? new Date(updatedSec * 1000).toISOString()
      : undefined;
  return sanitizeFavorite({
    id: `fav-${updatedSec && isFiniteNumber(updatedSec) ? updatedSec * 1000 : Date.now()}-${index}`,
    name,
    center: [(lngE5 as number) / 1e5, (latE5 as number) / 1e5],
    zoom: (zoomE2 as number) / 100,
    pitch,
    bearing,
    elevation: isFiniteNumber(elevation) ? elevation : 0,
    createdAt: updatedAt,
    updatedAt,
  });
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(str: string): Uint8Array {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function supportsDeflateRaw(): boolean {
  try {
    if (typeof CompressionStream === 'undefined' || typeof DecompressionStream === 'undefined') {
      return false;
    }
    new CompressionStream('deflate-raw');
    return true;
  } catch {
    return false;
  }
}

async function readStreamWithLimit(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new FavoritesTransferError('同期URLのデータが大きすぎます。');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return readStreamWithLimit(stream, Number.MAX_SAFE_INTEGER);
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return readStreamWithLimit(stream, MAX_DECODED_BYTES);
}

/**
 * お気に入り一覧を同期URL用ペイロード文字列にエンコードします。
 * 形式: `1z<base64url(deflate-raw(JSON))>`（圧縮非対応ブラウザでは `1j<base64url(JSON)>`）
 */
export async function encodeFavoritesPayload(favorites: PresetLocation[]): Promise<string> {
  if (favorites.length > MAX_FAVORITES || favorites.some(item => item.name.length > MAX_NAME_LENGTH)) throw new FavoritesTransferError('同期URLの上限を超えています。JSONファイルを書き出して保管してください。');
  const json = JSON.stringify(favorites.map(toCompact));
  const raw = new TextEncoder().encode(json);
  if (supportsDeflateRaw()) {
    return `${BACKUP_SCHEMA_VERSION}z${bytesToBase64Url(await deflateRaw(raw))}`;
  }
  return `${BACKUP_SCHEMA_VERSION}j${bytesToBase64Url(raw)}`;
}

export async function decodeFavoritesPayload(payload: string): Promise<PresetLocation[]> {
  if (!payload || payload.length > MAX_HASH_PAYLOAD_CHARS) {
    throw new FavoritesTransferError('同期URLの形式が正しくありません。');
  }
  const version = Number(payload[0]);
  const codec = payload[1];
  const body = payload.slice(2);
  if (!Number.isFinite(version) || version < 1) {
    throw new FavoritesTransferError('同期URLの形式が正しくありません。');
  }
  if (version > BACKUP_SCHEMA_VERSION) {
    throw new FavoritesTransferError(
      '新しいバージョンのアプリで作成された同期URLです。アプリを更新してから開いてください。'
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = base64UrlToBytes(body);
  } catch {
    throw new FavoritesTransferError('同期URLが途中で切れているか、壊れています。');
  }

  if (codec === 'z') {
    if (!supportsDeflateRaw()) {
      throw new FavoritesTransferError(
        'このブラウザは同期URLの展開に対応していません。JSONファイルでの引き継ぎをご利用ください。'
      );
    }
    try {
      bytes = await inflateRaw(bytes);
    } catch (err) {
      if (err instanceof FavoritesTransferError) throw err;
      throw new FavoritesTransferError('同期URLが途中で切れているか、壊れています。');
    }
  } else if (codec !== 'j') {
    throw new FavoritesTransferError('同期URLの形式が正しくありません。');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new FavoritesTransferError('同期URLが途中で切れているか、壊れています。');
  }
  if (!Array.isArray(parsed)) {
    throw new FavoritesTransferError('同期URLの形式が正しくありません。');
  }
  if (parsed.length > MAX_FAVORITES * 2) {
    throw new FavoritesTransferError('同期URLの件数が多すぎます。');
  }
  const items = parsed
    .map((raw, i) => fromCompact(raw, i))
    .filter((v): v is PresetLocation => v !== null);
  if (items.length !== parsed.length) throw new FavoritesTransferError('不正な地点を含む同期URLです。');
  if (items.length === 0) {
    throw new FavoritesTransferError('取り込めるお気に入り地点が見つかりませんでした。');
  }
  return items;
}

export async function buildFavoritesSyncUrl(favorites: PresetLocation[]): Promise<string> {
  const payload = await encodeFavoritesPayload(favorites);
  return `${PUBLIC_APP_ORIGIN}/#${FAVORITES_HASH_KEY}=${payload}`;
}

/** URLのハッシュ部分（`#fav=...`）から同期ペイロードを取り出します。無ければ null。 */
export function extractFavoritesPayloadFromHash(hash: string): string | null {
  if (!hash) return null;
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(body);
  const payload = params.get(FAVORITES_HASH_KEY);
  return payload && payload.length > 2 ? payload : null;
}

/** 貼り付けられた文字列（URL全体・ペイロードのみ）から同期ペイロードを取り出します。 */
export function extractFavoritesPayloadFromText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const hashIndex = trimmed.indexOf('#');
  if (hashIndex >= 0) {
    return extractFavoritesPayloadFromHash(trimmed.slice(hashIndex).split(/\s/)[0]);
  }
  if (/^\d[zj][A-Za-z0-9_-]+$/.test(trimmed)) return trimmed;
  return null;
}

/**
 * 現在のアドレスバーから `#fav=...` を取り出し、履歴を汚さずにハッシュを消去します。
 * （リロード時の再取り込みや、通常の共有URLへの混入を防止）
 */
export const PENDING_FAVORITES_PAYLOAD_KEY = 'rain3d_pending_fav_payload_v1';

export function hasPendingFavoritesPayload(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.sessionStorage?.getItem(PENDING_FAVORITES_PAYLOAD_KEY)) return true;
  } catch {
    // ignore
  }
  try {
    return !!extractFavoritesPayloadFromHash(window.location.hash);
  } catch {
    return false;
  }
}

export function clearPendingFavoritesPayload(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage?.removeItem(PENDING_FAVORITES_PAYLOAD_KEY);
  } catch {
    // ignore
  }
  try {
    if (window.location.hash.includes(FAVORITES_HASH_KEY)) {
      const hash = window.location.hash.slice(1);
      const params = new URLSearchParams(hash);
      params.delete(FAVORITES_HASH_KEY);
      const remaining = params.toString();
      const newUrl = remaining
        ? `${window.location.pathname}${window.location.search}#${remaining}`
        : `${window.location.pathname}${window.location.search}`;
      window.history.replaceState(null, '', newUrl);
    }
  } catch {
    // ignore
  }
}

/**
 * 現在のアドレスバーまたは保留領域から #fav=... を取り出します。
 * 初回SW制御開始等のリロードで取り込みを失わないよう、保留可能を確認してからURLから消去します (FIX-06)。
 */
export function takeFavoritesPayloadFromLocation(): string | null {
  if (typeof window === 'undefined') return null;

  // 1. 保留ストレージに既に存在するか確認
  let pending: string | null = null;
  try {
    pending = window.sessionStorage?.getItem(PENDING_FAVORITES_PAYLOAD_KEY) ?? null;
  } catch {
    pending = null;
  }

  // 2. URLハッシュから抽出
  const hashPayload = extractFavoritesPayloadFromHash(window.location.hash);
  const payload = hashPayload || pending;

  if (!payload) return null;

  // 3. sessionStorage に退避を試みる
  let persistedInSession = false;
  try {
    if (window.sessionStorage) {
      window.sessionStorage.setItem(PENDING_FAVORITES_PAYLOAD_KEY, payload);
      persistedInSession = true;
    }
  } catch {
    persistedInSession = false;
  }

  // 4. sessionStorageへ保存できた場合のみURLハッシュをクリア。失敗時は救済のためハッシュを残す
  if (persistedInSession && hashPayload && window.history?.replaceState) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }

  return payload;
}
