import type { GSMaPRainLayerResult } from './jaxaClient';
import type { TimelineFrameItem } from '../types/map';
import type { DataState } from '../types/status';
import { safeGetLocalStorage } from './favoritesStorage';
import { requestWeather, readWeatherBytes, weatherDeadline, WeatherRequestError, WEATHER_FRAME_MS, WEATHER_TILE_BYTES } from './weatherRequests';
import { diagnostic } from './diagnostics';

export const JMA_NOWCAST_N1_URL =
  'https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N1.json';
export const JMA_NOWCAST_N2_URL =
  'https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N2.json';
export const JMA_RASRF_URL =
  'https://www.jma.go.jp/bosai/jmatile/data/rasrf/targetTimes.json';

const JMA_CATALOG_STORAGE_KEY = 'rain3d_jma_catalog_v1';

// 日本列島全域をカバーするズームレベル6のタイル範囲
export const JMA_TILE_Z = 6;
export const JMA_X_MIN = 54;
export const JMA_X_MAX = 57; // 4 tiles (54, 55, 56, 57)
export const JMA_Y_MIN = 22;
export const JMA_Y_MAX = 26; // 5 tiles (22, 23, 24, 25, 26)
export const JMA_TILES_X = JMA_X_MAX - JMA_X_MIN + 1; // 4
export const JMA_TILES_Y = JMA_Y_MAX - JMA_Y_MIN + 1; // 5
export const JMA_TOTAL_TILES = JMA_TILES_X * JMA_TILES_Y; // 20 tiles

const JMA_CANVAS_WIDTH = JMA_TILES_X * 256; // 1024
const JMA_CANVAS_HEIGHT = JMA_TILES_Y * 256; // 1280

/** 欠測ピクセルを表すグリッド値 (FIX-02) */
export const JMA_MISSING_VALUE = 0xffff; // 65535

function tile2lng(x: number, z: number): number {
  return (x / Math.pow(2, z)) * 360 - 180;
}

function tile2lat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

// 日本列島カバー領域のバウンディングボックス
export const JMA_NOWCAST_WEST = tile2lng(JMA_X_MIN, JMA_TILE_Z); // 121.875
export const JMA_NOWCAST_EAST = tile2lng(JMA_X_MAX + 1, JMA_TILE_Z); // 149.0625
export const JMA_NOWCAST_NORTH = tile2lat(JMA_Y_MIN, JMA_TILE_Z); // 45.08903556
export const JMA_NOWCAST_SOUTH = tile2lat(JMA_Y_MAX + 1, JMA_TILE_Z); // 27.05912578

export const JMA_NOWCAST_COORDINATES: [
  [number, number],
  [number, number],
  [number, number],
  [number, number],
] = [
  [JMA_NOWCAST_WEST, JMA_NOWCAST_NORTH], // Top-Left
  [JMA_NOWCAST_EAST, JMA_NOWCAST_NORTH], // Top-Right
  [JMA_NOWCAST_EAST, JMA_NOWCAST_SOUTH], // Bottom-Right
  [JMA_NOWCAST_WEST, JMA_NOWCAST_SOUTH], // Bottom-Left
];

interface RawJMATargetTime {
  basetime: string;
  validtime: string;
  member?: 'none' | 'immed';
  elements?: string[];
}

export interface JMANowcastCatalog {
  frames: TimelineFrameItem[];
  defaultIndex: number;
  isStale?: boolean;
  isPartial?: boolean;
  savedAt?: string;
}

export function isValidJMATimeString(str: unknown): str is string {
  if (typeof str !== 'string' || !/^(?:\d{12}|\d{14})$/.test(str)) return false;
  const values = [Number(str.slice(0,4)), Number(str.slice(4,6))-1, Number(str.slice(6,8)), Number(str.slice(8,10)), Number(str.slice(10,12)), Number(str.slice(12,14) || 0)];
  const d = new Date(Date.UTC(values[0], values[1], values[2], values[3], values[4], values[5]));
  return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].every((n,i) => n === values[i]);
}

function parseJMATimeUTC(str: string): Date {
  if (!isValidJMATimeString(str)) {
    throw new Error(`Invalid JMA time string: ${JSON.stringify(str)}`);
  }
  const yyyy = parseInt(str.slice(0, 4), 10);
  const mm = parseInt(str.slice(4, 6), 10) - 1;
  const dd = parseInt(str.slice(6, 8), 10);
  const hh = parseInt(str.slice(8, 10), 10);
  const min = parseInt(str.slice(10, 12), 10);
  const ss = parseInt(str.slice(12, 14) || '0', 10);
  return new Date(Date.UTC(yyyy, mm, dd, hh, min, ss));
}

function formatDateTimeMinuteJST(date: Date): string {
  const jstTime = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = jstTime.getUTCFullYear();
  const mm = String(jstTime.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(jstTime.getUTCDate()).padStart(2, '0');
  const hh = String(jstTime.getUTCHours()).padStart(2, '0');
  const min = String(jstTime.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min} JST`;
}

function isValidMember(member: unknown): boolean {
  return member === undefined || member === 'none' || member === 'immed';
}

function frameMember(frame: TimelineFrameItem): 'none' | 'immed' {
  if (!isValidMember(frame.member)) throw new WeatherRequestError('invalid-data');
  return frame.member ?? 'none';
}

export function getJMAFrameKey(frame: TimelineFrameItem): string {
  // Keep existing none entries usable; immed must never hit a legacy none frame.
  const suffix = frameMember(frame) === 'none' ? 'v1' : 'immed:v2';
  return `jma:${frame.tileDataset || 'hrpns'}:${frame.basetime || ''}:${frame.validtime || ''}:${suffix}`;
}

async function fetchJsonWithTimeout<T>(url: string): Promise<T | null> {
  try {
    return await weatherDeadline(14000, undefined, signal => requestWeather(url, async (res, attemptSignal) => {
      const bytes = await readWeatherBytes(res, attemptSignal, 1024 * 1024);
      try { return JSON.parse(new TextDecoder().decode(bytes)) as T; }
      catch { throw new WeatherRequestError('invalid-data'); }
    }, signal));
  } catch {
    return null;
  }
}

/** 保存済みカタログを読み出し (FIX-08) */
export function loadCachedJMACatalog(): JMANowcastCatalog | null {
  const ls = safeGetLocalStorage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(JMA_CATALOG_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || ![undefined, 1, 2].includes(parsed.version) || !Array.isArray(parsed.frames) || parsed.frames.length === 0) return null;
    const frames: TimelineFrameItem[] = parsed.frames
      .filter(
        (f: any) =>
          f &&
          isValidJMATimeString(f.basetime) &&
          isValidJMATimeString(f.validtime) &&
          ["hrpns", "rasrf"].includes(f.tileDataset) &&
          isValidMember(f.member) && (parsed.version !== 2 || f.member !== undefined) &&
          new Date(f.date).getTime() === parseJMATimeUTC(f.validtime).getTime()
      )
      .map((f: any) => ({
        ...f,
        member: f.member ?? 'none',
        date: parseJMATimeUTC(f.validtime),
        labelJST: formatDateTimeMinuteJST(parseJMATimeUTC(f.validtime)),
        relativeBadge: typeof f.relativeBadge === 'string' ? f.relativeBadge : '保存済み',
        isForecast: typeof f.isForecast === 'boolean' ? f.isForecast : f.validtime > f.basetime,
        isLatestObservation: f.isLatestObservation === true,
      }));
    if (frames.length === 0) return null;
    return {
      frames,
      defaultIndex: Math.max(0, frames.findIndex(f => f.validtime === parsed.frames[parsed.defaultIndex]?.validtime)),
      isStale: true,
      savedAt: typeof parsed.savedAt === 'string' && Number.isFinite(Date.parse(parsed.savedAt)) ? parsed.savedAt : undefined,
    };
  } catch {
    return null;
  }
}

function saveCachedJMACatalog(catalog: JMANowcastCatalog): void {
  const ls = safeGetLocalStorage();
  if (!ls) return;
  try {
    const data = {
      version: 2,
      frames: catalog.frames.map((f) => ({
        ...f,
        member: frameMember(f),
        date: f.date.toISOString(),
      })),
      defaultIndex: catalog.defaultIndex,
      savedAt: new Date().toISOString(),
    };
    ls.setItem(JMA_CATALOG_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // ignore
  }
}

/**
 * 気象庁 高解像度降水ナウキャスト (N1, N2, rasrf) カタログを取得
 * - N1実況を主経路とし、N2/rasrf障害でも実況を維持 (FIX-08)
 * - 空配列や不正JSONからbasetime/validtimeなしの架空フレームを作らない
 * - 通信不可時は保存済みカタログへフォールバック
 */
let catalogInFlight: Promise<JMANowcastCatalog> | null = null;
export function fetchJMANowcastCatalog(): Promise<JMANowcastCatalog> {
  if (!catalogInFlight) {
    const pending = loadJMANowcastCatalog(); catalogInFlight = pending;
    void pending.finally(() => { if (catalogInFlight === pending) catalogInFlight = null; }).catch(() => {});
  }
  return catalogInFlight;
}
async function loadJMANowcastCatalog(): Promise<JMANowcastCatalog> {
  const [rawN1, rawN2, rawRasrf] = await Promise.all([
    fetchJsonWithTimeout<RawJMATargetTime[]>(JMA_NOWCAST_N1_URL),
    fetchJsonWithTimeout<RawJMATargetTime[]>(JMA_NOWCAST_N2_URL),
    fetchJsonWithTimeout<RawJMATargetTime[]>(JMA_RASRF_URL),
  ]);

  // N1 が取得できなかった場合は保存済みカタログへフォールバック
  if (!rawN1 || !Array.isArray(rawN1) || rawN1.length === 0) {
    const cached = loadCachedJMACatalog();
    if (cached) return cached;
    throw new Error('JMA Nowcast catalog unavailable: N1 data fetch failed');
  }

  const validN1 = rawN1
    .filter(
      (item) =>
        item &&
        isValidJMATimeString(item.basetime) &&
        isValidJMATimeString(item.validtime) &&
        isValidMember(item.member) &&
        (!item.elements || item.elements.includes('hrpns'))
    )
    .sort((a, b) => a.validtime.localeCompare(b.validtime));

  if (validN1.length === 0) {
    const cached = loadCachedJMACatalog();
    if (cached) return cached;
    throw new Error('JMA Nowcast catalog empty: no valid N1 observation frames found');
  }

  const validN2 = Array.isArray(rawN2)
    ? rawN2
        .filter(
          (item) =>
            item &&
            isValidJMATimeString(item.basetime) &&
            isValidJMATimeString(item.validtime) &&
            isValidMember(item.member) &&
            (!item.elements || item.elements.includes('hrpns'))
        )
        .sort((a, b) => a.validtime.localeCompare(b.validtime))
    : [];

  const validRasrf = Array.isArray(rawRasrf)
    ? rawRasrf
        .filter(
          (item) =>
            item &&
            isValidJMATimeString(item.basetime) &&
            isValidJMATimeString(item.validtime) &&
            isValidMember(item.member) &&
            item.basetime !== item.validtime &&
            (!item.elements || item.elements.includes('rasrf'))
        )
        .sort((a, b) => a.validtime.localeCompare(b.validtime))
    : [];

  const latestObsRaw = validN1[validN1.length - 1];
  const latestObsDate = parseJMATimeUTC(latestObsRaw.validtime);
  const twoHoursAgoMs = latestObsDate.getTime() - 120 * 60 * 1000;

  // A. 過去2時間分の観測フレーム
  const obsFrames: TimelineFrameItem[] = [];
  for (let i = 0; i < validN1.length; i++) {
    const item = validN1[i];
    const d = parseJMATimeUTC(item.validtime);
    if (d.getTime() < twoHoursAgoMs) continue;

    const isLatest = i === validN1.length - 1;
    const diffMin = Math.round((latestObsDate.getTime() - d.getTime()) / 60000);
    if (!isLatest && diffMin % 10 !== 0) continue;

    obsFrames.push({
      date: d,
      labelJST: formatDateTimeMinuteJST(d),
      relativeBadge: isLatest ? '最新実況' : `-${diffMin}分`,
      isForecast: false,
      isLatestObservation: isLatest,
      basetime: item.basetime,
      validtime: item.validtime,
      tileDataset: 'hrpns',
      member: item.member ?? 'none',
    });
  }

  // B. 直近1時間の高解像度ナウキャスト予測フレーム
  const forecastFrames: TimelineFrameItem[] = [];
  let maxNowcastAheadMin = 0;

  for (let i = 0; i < validN2.length; i++) {
    const item = validN2[i];
    const d = parseJMATimeUTC(item.validtime);
    const aheadMin = Math.round((d.getTime() - latestObsDate.getTime()) / 60000);
    const isLastN2 = i === validN2.length - 1;

    if (aheadMin <= 0) continue;
    if (!isLastN2 && aheadMin % 10 !== 0) continue;

    if (aheadMin > maxNowcastAheadMin) {
      maxNowcastAheadMin = aheadMin;
    }

    forecastFrames.push({
      date: d,
      labelJST: formatDateTimeMinuteJST(d),
      relativeBadge: `+${aheadMin}分予報`,
      isForecast: true,
      isLatestObservation: false,
      basetime: item.basetime,
      validtime: item.validtime,
      tileDataset: 'hrpns',
      member: item.member ?? 'none',
    });
  }

  // C. 最大+15時間の降水短時間予報フレーム
  for (let i = 0; i < validRasrf.length; i++) {
    const item = validRasrf[i];
    const d = parseJMATimeUTC(item.validtime);
    const aheadMin = Math.round((d.getTime() - latestObsDate.getTime()) / 60000);
    if (aheadMin < maxNowcastAheadMin + 30) continue;

    const aheadHours = Math.round(aheadMin / 60);
    forecastFrames.push({
      date: d,
      labelJST: formatDateTimeMinuteJST(d),
      relativeBadge: `+${aheadHours}h予報`,
      isForecast: true,
      isLatestObservation: false,
      basetime: item.basetime,
      validtime: item.validtime,
      tileDataset: 'rasrf',
      member: item.member ?? 'none',
    });
  }

  const allFrames = [...obsFrames, ...forecastFrames];
  const latestIdx = allFrames.findIndex((f) => f.isLatestObservation);
  const catalog: JMANowcastCatalog = {
    frames: allFrames,
    defaultIndex: latestIdx >= 0 ? latestIdx : Math.max(0, obsFrames.length - 1),
    isStale: false,
    savedAt: new Date().toISOString(),
    isPartial: !Array.isArray(rawN2) || !Array.isArray(rawRasrf),
  };

  saveCachedJMACatalog(catalog);
  return catalog;
}

// JMA official color guide Table 2-1. Decode only known categorical RGB values.
const JMA_PALETTE = new Map([
  [242,242,255,0.8,56,189,248,210], [160,210,255,2.5,14,165,233,230],
  [33,140,255,7.5,33,140,255,242], [0,65,255,15,34,197,94,248],
  [250,245,0,25,250,204,21,252], [255,153,0,40,249,115,22,255],
  [255,40,0,65,239,68,68,255], [180,0,104,85,180,0,104,255],
].map(c => [(c[0] << 16) | (c[1] << 8) | c[2], { mmh: c[3], outR: c[4], outG: c[5], outB: c[6], outA: c[7] }]));
export function classifyJMAPixel(r: number, g: number, b: number): { mmh: number; outR: number; outG: number; outB: number; outA: number } | null {
  return JMA_PALETTE.get((r << 16) | (g << 8) | b) ?? null;
}

async function loadTileImage(url: string, signal: AbortSignal, onRetry: () => void): Promise<HTMLImageElement> {
  return requestWeather(url, async (response, attemptSignal) => {
    const bytes = await readWeatherBytes(response, attemptSignal, WEATHER_TILE_BYTES);
    attemptSignal.throwIfAborted();
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    try {
      return await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        const cleanup = () => { img.onload = null; img.onerror = null; attemptSignal.removeEventListener('abort', abort); };
        const abort = () => { cleanup(); img.src = ''; reject(attemptSignal.reason); };
        img.onload = () => {
          cleanup();
          if (img.naturalWidth === 256 && img.naturalHeight === 256) resolve(img);
          else reject(new WeatherRequestError('decode'));
        };
        img.onerror = () => { cleanup(); reject(new WeatherRequestError('decode')); };
        if (attemptSignal.aborted) { abort(); return; }
        attemptSignal.addEventListener('abort', abort, { once: true }); img.src = objectUrl;
      });
    } finally { URL.revokeObjectURL(objectUrl); }
  }, signal, onRetry);
}

/**
 * 指定フレームの気象庁ナウキャストまたは降水短時間予報タイルを取得・合成
 * 全20タイル失敗時はエラーを投げ、降水なし扱いにしない (FIX-02)
 */
export async function fetchJMANowcastRainLayer(
  frame: TimelineFrameItem,
  signal?: AbortSignal
): Promise<GSMaPRainLayerResult> {
  return weatherDeadline(WEATHER_FRAME_MS, signal, activeSignal => loadRainLayer(frame, activeSignal));
}

async function loadRainLayer(
  frame: TimelineFrameItem,
  signal: AbortSignal
): Promise<GSMaPRainLayerResult> {
  const member = frameMember(frame);
  if (signal?.aborted) {
    throw new Error('Aborted');
  }

  const canvas = document.createElement('canvas');
  canvas.width = JMA_CANVAS_WIDTH;
  canvas.height = JMA_CANVAS_HEIGHT;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('Canvas 2D context not available');
  }

  try {
  const isRasrf = frame.tileDataset === 'rasrf';
  const positions: Array<{ gx: number; gy: number; url: string }> = [];
  const loadedTiles: Array<{ gx: number; gy: number; img: HTMLImageElement | null }> = [];
  let unavailable: WeatherRequestError | undefined;
  let lastError: WeatherRequestError | undefined;
  let retries = 0;

  for (let ty = JMA_Y_MIN; ty <= JMA_Y_MAX; ty++) {
    for (let tx = JMA_X_MIN; tx <= JMA_X_MAX; tx++) {
      const gx = tx - JMA_X_MIN;
      const gy = ty - JMA_Y_MIN;
      const url = isRasrf
        ? `https://www.jma.go.jp/bosai/jmatile/data/rasrf/${frame.basetime}/${member}/${frame.validtime}/surf/rasrf/${JMA_TILE_Z}/${tx}/${ty}.png`
        : `https://www.jma.go.jp/bosai/jmatile/data/nowc/${frame.basetime}/${member}/${frame.validtime}/surf/hrpns/${JMA_TILE_Z}/${tx}/${ty}.png`;
      positions.push({ gx, gy, url });
    }
  }

  let cursor = 0;
  // Four tiles per frame, at most two frames in the scheduler. Successful tiles
  // remain in this bounded frame while only individual failed tiles retry.
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < positions.length) {
      signal.throwIfAborted();
      const { gx, gy, url } = positions[cursor++];
      let img: HTMLImageElement | null = null;
      try { img = await loadTileImage(url, signal, () => { retries++; }); }
      catch (error) {
        signal.throwIfAborted();
        if (error instanceof WeatherRequestError) lastError = error;
        if (error instanceof WeatherRequestError && error.refreshCatalog) unavailable = error;
      }
      loadedTiles.push({ gx, gy, img });
    }
  }));
  if (signal?.aborted) {
    throw new Error('Aborted');
  }
  diagnostic({ operation: 'frame', backend: 'network', outcome: lastError ? 'failure' : 'success',
    count: loadedTiles.filter(t => !!t.img).length, retry: retries, error: lastError?.kind });

  let successCount = 0;
  let missingCount = 0;

  for (const { gx, gy, img } of loadedTiles) {
    if (img) {
      successCount++;
      ctx.drawImage(img, gx * 256, gy * 256, 256, 256);
    } else {
      missingCount++;
    }
  }

  // 全20タイル失敗の場合はエラーとして扱い、正常フレームにしない (FIX-02)
  if (successCount === 0) {
    if (unavailable) throw unavailable;
    const error = lastError ?? new WeatherRequestError('invalid-data');
    error.message = `JMA nowcast: All ${JMA_TOTAL_TILES} tiles failed to load`;
    throw error;
  }

  const jmaGrid = new Uint16Array(JMA_CANVAS_WIDTH * JMA_CANVAS_HEIGHT);
  let maxPrecipitation = 0;
  let sumPrecipitation = 0;
  let rainPixelCount = 0;
  let unknownPixels = 0;

  const imgData = ctx.getImageData(0, 0, JMA_CANVAS_WIDTH, JMA_CANVAS_HEIGHT);
  const data = imgData.data;
  const totalPixels = JMA_CANVAS_WIDTH * JMA_CANVAS_HEIGHT;

  for (let i = 0; i < totalPixels; i++) {
    const idx = i * 4;
    const a = data[idx + 3];
    if (a === 0) {
      rainPixelCount++;
      data[idx + 3] = 0;
      continue;
    }

    const classified = classifyJMAPixel(data[idx], data[idx + 1], data[idx + 2]);
    if (classified) {
      jmaGrid[i] = Math.round(classified.mmh * 10);
      data[idx] = classified.outR;
      data[idx + 1] = classified.outG;
      data[idx + 2] = classified.outB;
      data[idx + 3] = classified.outA;

      if (classified.mmh > maxPrecipitation) {
        maxPrecipitation = classified.mmh;
      }
      sumPrecipitation += classified.mmh;
      rainPixelCount++;
    } else {
      unknownPixels++; jmaGrid[i] = JMA_MISSING_VALUE;
      data[idx + 3] = 0;
    }
  }

  // 部分欠落タイル領域のピクセルを JMA_MISSING_VALUE で埋める
  if (missingCount > 0) {
    for (const { gx, gy, img } of loadedTiles) {
      if (!img) {
        const startX = gx * 256;
        const startY = gy * 256;
        for (let dy = 0; dy < 256; dy++) {
          const rowOffset = (startY + dy) * JMA_CANVAS_WIDTH;
          for (let dx = 0; dx < 256; dx++) {
            jmaGrid[rowOffset + startX + dx] = JMA_MISSING_VALUE;
          }
        }
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);

  const imageUrl = canvas.toDataURL('image/png');
  canvas.width = 0; canvas.height = 0;
  const meanPrecipitation =
    rainPixelCount > 0 ? Number((sumPrecipitation / rainPixelCount).toFixed(2)) : 0;
  if (unknownPixels === totalPixels) throw new Error('JMA image has no recognized values');
  const status: DataState = missingCount === 0 && unknownPixels === 0 ? 'success' : 'partial';
  const key = getJMAFrameKey(frame);

  return {
    imageUrl,
    coordinates: JMA_NOWCAST_COORDINATES,
    observedAt: frame.date,
    formattedDateJST: frame.labelJST,
    maxPrecipitation,
    meanPrecipitation,
    sourceType: 'jma-nowcast',
    jmaGrid,
    status,
    missingTilesCount: missingCount,
    totalTilesCount: JMA_TOTAL_TILES,
    key,
  };
  } finally { canvas.width = 0; canvas.height = 0; }
}

/**
 * 合成済み気象庁ナウキャストグリッドから指定経緯度の降雨強度 (mm/h) を取得
 * 欠測領域の場合は null を返し、0mm/h と混同しない (FIX-02)
 */
export function inspectJMAPrecipitation(
  jmaGrid: Uint16Array | undefined,
  lng: number,
  lat: number
): number | null {
  if (
    !jmaGrid ||
    lng < JMA_NOWCAST_WEST ||
    lng > JMA_NOWCAST_EAST ||
    lat < JMA_NOWCAST_SOUTH ||
    lat > JMA_NOWCAST_NORTH
  ) {
    return null;
  }

  const n = Math.pow(2, JMA_TILE_Z);
  const tileX = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const tileY =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;

  const u = (tileX - JMA_X_MIN) / JMA_TILES_X;
  const v = (tileY - JMA_Y_MIN) / JMA_TILES_Y;
  if (u < 0 || u >= 1 || v < 0 || v >= 1) {
    return null;
  }

  const px = Math.min(JMA_CANVAS_WIDTH - 1, Math.max(0, Math.floor(u * JMA_CANVAS_WIDTH)));
  const py = Math.min(JMA_CANVAS_HEIGHT - 1, Math.max(0, Math.floor(v * JMA_CANVAS_HEIGHT)));

  // クリック地点の3x3ピクセル近傍を走査
  let validCount = 0;
  let bestVal = 0;

  for (let dy = -1; dy <= 1; dy++) {
    const ny = py + dy;
    if (ny < 0 || ny >= JMA_CANVAS_HEIGHT) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const nx = px + dx;
      if (nx < 0 || nx >= JMA_CANVAS_WIDTH) continue;
      const val = jmaGrid[ny * JMA_CANVAS_WIDTH + nx];
      if (val === JMA_MISSING_VALUE) {
        // 欠測ピクセル
        continue;
      }
      validCount++;
      if (val > bestVal) bestVal = val;
    }
  }

  // 近傍すべてが欠測なら null を返す (FIX-02)
  if (validCount === 0) {
    return null;
  }

  return Number((bestVal / 10).toFixed(2));
}
