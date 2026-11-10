import {
  JMA_TILE_Z,
  JMA_X_MIN,
  JMA_X_MAX,
  JMA_Y_MIN,
  JMA_Y_MAX,
  classifyJMAPixel,
} from './jmaNowcastClient';
import {
  requestWeather,
  readWeatherBytes,
  WeatherRequestError,
  WEATHER_TILE_BYTES,
} from './weatherRequests';
import type { RainSourceId, TimelineFrameItem } from '../types/map';

export interface PointTimeseriesItem {
  frame: TimelineFrameItem;
  precipitation: number | null; // mm/h (null = missing or out of coverage)
  isForecast: boolean;
  isLatestObservation: boolean;
}

export interface PointTimeseriesResult {
  lng: number;
  lat: number;
  items: PointTimeseriesItem[];
  maxPrecipitation: number;
  fetchedAt: number;
}

/**
 * 経緯度から気象庁ナウキャスト (Zoom=6) のタイル座標およびタイル内ピクセル座標を算出
 */
export function getJMATileCoordinates(lng: number, lat: number): {
  tx: number;
  ty: number;
  px: number;
  py: number;
  inBounds: boolean;
} {
  const n = Math.pow(2, JMA_TILE_Z); // 64
  const tileX = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  // Web Mercator Y
  const tileY =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;

  const tx = Math.floor(tileX);
  const ty = Math.floor(tileY);

  const px = Math.min(255, Math.max(0, Math.floor((tileX - tx) * 256)));
  const py = Math.min(255, Math.max(0, Math.floor((tileY - ty) * 256)));

  const inBounds =
    tx >= JMA_X_MIN && tx <= JMA_X_MAX && ty >= JMA_Y_MIN && ty <= JMA_Y_MAX;

  return { tx, ty, px, py, inBounds };
}

/**
 * フレーム情報とタイル座標から気象庁タイル画像URLを生成
 */
export function getJMATileUrl(
  frame: TimelineFrameItem,
  tx: number,
  ty: number
): string {
  const isRasrf = frame.tileDataset === 'rasrf';
  return isRasrf
    ? `https://www.jma.go.jp/bosai/jmatile/data/rasrf/${frame.basetime}/none/${frame.validtime}/surf/rasrf/${JMA_TILE_Z}/${tx}/${ty}.png`
    : `https://www.jma.go.jp/bosai/jmatile/data/nowc/${frame.basetime}/none/${frame.validtime}/surf/hrpns/${JMA_TILE_Z}/${tx}/${ty}.png`;
}

/**
 * タイルピクセルバッファ (256x256 RGBA) の該当ピクセル近傍 (3x3) から降水量 (mm/h) を算出
 */
export function sampleJMAPrecipitationFromTile(
  data: Uint8ClampedArray,
  px: number,
  py: number
): number | null {
  let validCount = 0;
  let bestMmh = 0;
  let hasRain = false;

  for (let dy = -1; dy <= 1; dy++) {
    const ny = py + dy;
    if (ny < 0 || ny >= 256) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const nx = px + dx;
      if (nx < 0 || nx >= 256) continue;
      const idx = (ny * 256 + nx) * 4;
      const a = data[idx + 3];
      if (a === 0) {
        // 透明ピクセル = 降水なし (0 mm/h)
        validCount++;
        continue;
      }
      const classified = classifyJMAPixel(data[idx], data[idx + 1], data[idx + 2]);
      if (classified) {
        validCount++;
        hasRain = true;
        if (classified.mmh > bestMmh) {
          bestMmh = classified.mmh;
        }
      }
    }
  }

  if (validCount === 0) return null;
  return hasRain ? bestMmh : 0;
}

// メモリ節約のため上限60タイルを保持するLRUキャッシュ
const MAX_TILE_CACHE = 60;
const tilePixelCache = new Map<string, Uint8ClampedArray>();
const pendingTileFetches = new Map<string, Promise<Uint8ClampedArray | null>>();

// 結果キャッシュ (地点経緯度 + 最新フレーム validtime)
const MAX_RESULT_CACHE = 50;
const resultCache = new Map<string, PointTimeseriesResult>();

export function clearPointTimeseriesCache(): void {
  tilePixelCache.clear();
  pendingTileFetches.clear();
  resultCache.clear();
}

async function loadTilePixelData(
  url: string,
  signal?: AbortSignal
): Promise<Uint8ClampedArray | null> {
  const cached = tilePixelCache.get(url);
  if (cached) {
    // LRU順更新
    tilePixelCache.delete(url);
    tilePixelCache.set(url, cached);
    return cached;
  }

  const inFlight = pendingTileFetches.get(url);
  if (inFlight) {
    return inFlight;
  }

  const fetchPromise = (async () => {
    try {
      signal?.throwIfAborted();
      const img = await requestWeather(
        url,
        async (response, attemptSignal) => {
          const bytes = await readWeatherBytes(response, attemptSignal, WEATHER_TILE_BYTES);
          attemptSignal.throwIfAborted();
          const objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
          try {
            return await new Promise<HTMLImageElement>((resolve, reject) => {
              const el = new Image();
              const cleanup = () => {
                el.onload = null;
                el.onerror = null;
                attemptSignal.removeEventListener('abort', abort);
              };
              const abort = () => {
                cleanup();
                el.src = '';
                reject(attemptSignal.reason);
              };
              el.onload = () => {
                cleanup();
                if (el.naturalWidth === 256 && el.naturalHeight === 256) resolve(el);
                else reject(new WeatherRequestError('decode'));
              };
              el.onerror = () => {
                cleanup();
                reject(new WeatherRequestError('decode'));
              };
              if (attemptSignal.aborted) {
                abort();
                return;
              }
              attemptSignal.addEventListener('abort', abort, { once: true });
              el.src = objectUrl;
            });
          } finally {
            URL.revokeObjectURL(objectUrl);
          }
        },
        signal
      );

      signal?.throwIfAborted();
      if (typeof document === 'undefined') return null;

      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 256;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;

      ctx.drawImage(img, 0, 0);
      const imgData = ctx.getImageData(0, 0, 256, 256);
      const data = new Uint8ClampedArray(imgData.data);

      if (tilePixelCache.size >= MAX_TILE_CACHE) {
        const oldestKey = tilePixelCache.keys().next().value;
        if (oldestKey) tilePixelCache.delete(oldestKey);
      }
      tilePixelCache.set(url, data);
      return data;
    } catch {
      return null;
    } finally {
      pendingTileFetches.delete(url);
    }
  })();

  pendingTileFetches.set(url, fetchPromise);
  return fetchPromise;
}

/**
 * 並列数を制限して Promise を実行するヘルパー
 */
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  signal: AbortSignal | undefined,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  const workerCount = Math.min(limit, items.length);

  const workers = Array.from({ length: workerCount }, async () => {
    while (index < items.length) {
      signal?.throwIfAborted();
      const currentIndex = index++;
      results[currentIndex] = await fn(items[currentIndex]);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * 地図の中心座標における過去〜未来の雨量時系列データを非同期取得
 */
export async function fetchPointTimeseries(
  lng: number,
  lat: number,
  frames: TimelineFrameItem[],
  rainSource: RainSourceId,
  signal?: AbortSignal
): Promise<PointTimeseriesResult> {
  signal?.throwIfAborted();

  if (!frames || frames.length === 0) {
    return { lng, lat, items: [], maxPrecipitation: 0, fetchedAt: Date.now() };
  }

  const cacheKey = `${rainSource}:${lng.toFixed(3)},${lat.toFixed(3)}:${frames
    .map((f) => f.validtime || f.date.getTime())
    .join(',')}`;

  const cachedResult = resultCache.get(cacheKey);
  if (cachedResult) {
    return cachedResult;
  }

  let items: PointTimeseriesItem[] = [];

  if (rainSource === 'jma-nowcast') {
    const coords = getJMATileCoordinates(lng, lat);

    if (!coords.inBounds) {
      // 気象庁レーダー観測域外（日本近海・陸地外）
      items = frames.map((frame) => ({
        frame,
        precipitation: null,
        isForecast: Boolean(frame.isForecast),
        isLatestObservation: Boolean(frame.isLatestObservation),
      }));
    } else {
      // 該当タイル (z=6, coords.tx, coords.ty) のみを取得（最大5並列で実行）
      items = await runWithConcurrency(
        frames,
        5,
        signal,
        async (frame): Promise<PointTimeseriesItem> => {
          signal?.throwIfAborted();
          const tileUrl = getJMATileUrl(frame, coords.tx, coords.ty);
          const pixelBuffer = await loadTilePixelData(tileUrl, signal);
          let precipitation: number | null = null;
          if (pixelBuffer) {
            precipitation = sampleJMAPrecipitationFromTile(
              pixelBuffer,
              coords.px,
              coords.py
            );
          }
          return {
            frame,
            precipitation,
            isForecast: Boolean(frame.isForecast),
            isLatestObservation: Boolean(frame.isLatestObservation),
          };
        }
      );
    }
  } else {
    // JAXA GSMaP 等の他ソース時のフォールバック
    items = frames.map((frame) => ({
      frame,
      precipitation: 0,
      isForecast: Boolean(frame.isForecast),
      isLatestObservation: Boolean(frame.isLatestObservation),
    }));
  }

  signal?.throwIfAborted();

  let maxPrecipitation = 0;
  for (const item of items) {
    if (item.precipitation !== null && item.precipitation > maxPrecipitation) {
      maxPrecipitation = item.precipitation;
    }
  }

  const result: PointTimeseriesResult = {
    lng,
    lat,
    items,
    maxPrecipitation,
    fetchedAt: Date.now(),
  };

  if (resultCache.size >= MAX_RESULT_CACHE) {
    const oldest = resultCache.keys().next().value;
    if (oldest) resultCache.delete(oldest);
  }
  resultCache.set(cacheKey, result);

  return result;
}
