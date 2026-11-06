import type { TimelineFrameItem } from '../types/map';
import type { GSMaPRainLayerResult } from './jaxaClient';

const JMA_NOWCAST_N1_URL =
  'https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N1.json';
const JMA_NOWCAST_N2_URL =
  'https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N2.json';
const JMA_RASRF_URL =
  'https://www.jma.go.jp/bosai/jmatile/data/rasrf/targetTimes.json';

/**
 * 気象庁 高解像度降水ナウキャスト (hrpns) & 今後の雨・降水短時間予報 (rasrf) タイル合成グリッド定義 (z=6)
 * x: 54..57 (4タイル), y: 23..26 (4タイル) -> 計16タイルで日本列島全域 (沖縄〜北海道) をカバー
 */
const JMA_TILE_Z = 6;
const JMA_X_MIN = 54;
const JMA_X_MAX = 57;
const JMA_Y_MIN = 22;
const JMA_Y_MAX = 26;
const JMA_TILES_X = JMA_X_MAX - JMA_X_MIN + 1; // 4
const JMA_TILES_Y = JMA_Y_MAX - JMA_Y_MIN + 1; // 4
const JMA_CANVAS_WIDTH = JMA_TILES_X * 256; // 1024
const JMA_CANVAS_HEIGHT = JMA_TILES_Y * 256; // 1024

function tile2lon(x: number, z: number): number {
  return (x / Math.pow(2, z)) * 360 - 180;
}

function tile2lat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

export const JMA_NOWCAST_WEST = tile2lon(JMA_X_MIN, JMA_TILE_Z); // 123.75
export const JMA_NOWCAST_EAST = tile2lon(JMA_X_MAX + 1, JMA_TILE_Z); // 146.25
export const JMA_NOWCAST_NORTH = tile2lat(JMA_Y_MIN, JMA_TILE_Z); // 45.08903556
export const JMA_NOWCAST_SOUTH = tile2lat(JMA_Y_MAX + 1, JMA_TILE_Z); // 27.05912578

/** MapLibre ImageSource 用の正確な Web Mercator 4隅座標 */
export const JMA_NOWCAST_COORDINATES: [
  [number, number],
  [number, number],
  [number, number],
  [number, number]
] = [
  [JMA_NOWCAST_WEST, JMA_NOWCAST_NORTH], // Top-Left
  [JMA_NOWCAST_EAST, JMA_NOWCAST_NORTH], // Top-Right
  [JMA_NOWCAST_EAST, JMA_NOWCAST_SOUTH], // Bottom-Right
  [JMA_NOWCAST_WEST, JMA_NOWCAST_SOUTH], // Bottom-Left
];

interface RawJMATargetTime {
  basetime: string;
  validtime: string;
  member?: string;
  elements?: string[];
}

export interface JMANowcastCatalog {
  frames: TimelineFrameItem[];
  defaultIndex: number;
}

/**
 * JMAの時刻文字列 (YYYYMMDDHHmmss, UTC) を Date オブジェクトに変換
 */
export function parseJMATimeUTC(str: string): Date {
  const yyyy = parseInt(str.slice(0, 4), 10);
  const mm = parseInt(str.slice(4, 6), 10) - 1;
  const dd = parseInt(str.slice(6, 8), 10);
  const hh = parseInt(str.slice(8, 10), 10);
  const min = parseInt(str.slice(10, 12), 10);
  const ss = parseInt(str.slice(12, 14) || '0', 10);
  return new Date(Date.UTC(yyyy, mm, dd, hh, min, ss));
}

/**
 * 分単位まで含めた JST 日時フォーマット (例: 2026-11-06 11:20 JST)
 */
export function formatDateTimeMinuteJST(date: Date): string {
  const jstTime = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = jstTime.getUTCFullYear();
  const mm = String(jstTime.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(jstTime.getUTCDate()).padStart(2, '0');
  const hh = String(jstTime.getUTCHours()).padStart(2, '0');
  const min = String(jstTime.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min} JST`;
}

/**
 * 気象庁 高解像度降水ナウキャスト (N1: 過去2h実況, N2: +60分予測) および
 * 今後の雨・降水短時間予報 (rasrf: 最大+15時間予測) カタログを統合取得します。
 */
export async function fetchJMANowcastCatalog(): Promise<JMANowcastCatalog> {
  const [resN1, resN2, resRasrf] = await Promise.all([
    fetch(JMA_NOWCAST_N1_URL),
    fetch(JMA_NOWCAST_N2_URL),
    fetch(JMA_RASRF_URL).catch(() => null),
  ]);

  if (!resN1.ok) {
    throw new Error(`JMA Nowcast N1 fetch failed: ${resN1.status}`);
  }

  const rawN1: RawJMATargetTime[] = await resN1.json();
  const rawN2: RawJMATargetTime[] = resN2.ok ? await resN2.json() : [];
  const rawRasrf: RawJMATargetTime[] =
    resRasrf && resRasrf.ok ? await resRasrf.json() : [];

  // 1. 過去実況 (hrpns) を validtime 昇順にソート
  const validN1 = rawN1
    .filter((item) => !item.elements || item.elements.includes('hrpns'))
    .sort((a, b) => a.validtime.localeCompare(b.validtime));

  // 2. 高解像度降水ナウキャスト予測 (hrpns, 最大+60分) を validtime 昇順にソート
  const validN2 = rawN2
    .filter((item) => !item.elements || item.elements.includes('hrpns'))
    .sort((a, b) => a.validtime.localeCompare(b.validtime));

  // 3. 今後の雨・降水短時間予報 (rasrf, 最大+15時間) の予測フレームを validtime 昇順にソート
  const validRasrf = rawRasrf
    .filter(
      (item) =>
        item.basetime !== item.validtime &&
        (!item.elements || item.elements.includes('rasrf'))
    )
    .sort((a, b) => a.validtime.localeCompare(b.validtime));

  if (validN1.length === 0) {
    const now = new Date();
    return {
      frames: [
        {
          date: now,
          labelJST: formatDateTimeMinuteJST(now),
          relativeBadge: 'リアルタイム実況',
          isForecast: false,
          isLatestObservation: true,
          tileDataset: 'hrpns',
        },
      ],
      defaultIndex: 0,
    };
  }

  const latestObsRaw = validN1[validN1.length - 1];
  const latestObsDate = parseJMATimeUTC(latestObsRaw.validtime);
  const twoHoursAgoMs = latestObsDate.getTime() - 120 * 60 * 1000;

  // A. 過去2時間分の観測フレーム（10分刻み + 最新実況フレームは必ず含める）
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
      relativeBadge: isLatest ? 'リアルタイム実況' : `-${diffMin}分`,
      isForecast: false,
      isLatestObservation: isLatest,
      basetime: item.basetime,
      validtime: item.validtime,
      tileDataset: 'hrpns',
    });
  }

  // B. 直近1時間の高解像度ナウキャスト予測フレーム（10分刻み + N2最終フレーム [+55分/+60分] は必ず含める）
  const forecastFrames: TimelineFrameItem[] = [];
  let maxNowcastAheadMin = 0;

  for (let i = 0; i < validN2.length; i++) {
    const item = validN2[i];
    const d = parseJMATimeUTC(item.validtime);
    const aheadMin = Math.round((d.getTime() - latestObsDate.getTime()) / 60000);
    const isLastN2 = i === validN2.length - 1;

    if (aheadMin <= 0) continue;
    if (!isLastN2 && aheadMin % 10 !== 0) continue;

    maxNowcastAheadMin = Math.max(maxNowcastAheadMin, aheadMin);
    forecastFrames.push({
      date: d,
      labelJST: formatDateTimeMinuteJST(d),
      relativeBadge: `+${aheadMin}分 予測`,
      isForecast: true,
      isLatestObservation: false,
      basetime: item.basetime,
      validtime: item.validtime,
      tileDataset: 'hrpns',
    });
  }

  // C. 1時間超〜最大+15時間先までの「今後の雨（降水短時間予報: rasrf）」フレームを連結
  for (const item of validRasrf) {
    const d = parseJMATimeUTC(item.validtime);
    const aheadMin = Math.round((d.getTime() - latestObsDate.getTime()) / 60000);
    // ナウキャスト最終時刻より30分以上先の予測フレームを連結（重複防止）
    if (aheadMin < maxNowcastAheadMin + 30) continue;

    const aheadHours = Math.round(aheadMin / 60);
    forecastFrames.push({
      date: d,
      labelJST: formatDateTimeMinuteJST(d),
      relativeBadge: `+${aheadHours}時間 予測`,
      isForecast: true,
      isLatestObservation: false,
      basetime: item.basetime,
      validtime: item.validtime,
      tileDataset: 'rasrf',
    });
  }

  const allFrames = [...obsFrames, ...forecastFrames];
  const latestIdx = allFrames.findIndex((f) => f.isLatestObservation);

  return {
    frames: allFrames,
    defaultIndex: latestIdx >= 0 ? latestIdx : Math.max(0, obsFrames.length - 1),
  };
}

/**
 * 気象庁ナウキャスト (hrpns) / 降水短時間予報 (rasrf) のピクセルRGB値を降雨強度 (mm/h) に変換し、
 * 3D地形上で視認しやすい透過レーダーカラーへ補正します。
 */
function classifyJMAPixel(
  r: number,
  g: number,
  b: number
): { mmh: number; outR: number; outG: number; outB: number; outA: number } | null {
  // JMA hrpns / rasrf 共通パレット:
  // Level 1: #f2f2ff (242,242,255) -> 0.5-1 mm/h (3D地形上で白飛びしないようシアンブルーに視認性強化)
  if (r >= 230 && g >= 230 && b >= 245) {
    return { mmh: 0.8, outR: 56, outG: 189, outB: 248, outA: 210 };
  }
  // Level 2: #a0d2ff (160,210,255) -> 1-5 mm/h
  if (r >= 145 && r <= 175 && g >= 195 && g <= 225 && b >= 240) {
    return { mmh: 2.5, outR: 14, outG: 165, outB: 233, outA: 230 };
  }
  // Level 3: #218cff (33,140,255) -> 5-10 mm/h
  if (r <= 55 && g >= 120 && g <= 160 && b >= 240) {
    return { mmh: 7.5, outR: 33, outG: 140, outB: 255, outA: 242 };
  }
  // Level 4: #0041ff (0,65,255) -> 10-20 mm/h
  if (r <= 25 && g >= 45 && g <= 85 && b >= 240) {
    return { mmh: 15.0, outR: 34, outG: 197, outB: 94, outA: 248 };
  }
  // Level 5: #faf500 (250,245,0) -> 20-30 mm/h
  if (r >= 235 && g >= 225 && b <= 30) {
    return { mmh: 25.0, outR: 250, outG: 204, outB: 21, outA: 252 };
  }
  // Level 6: #ff9900 (255,153,0) -> 30-50 mm/h
  if (r >= 240 && g >= 135 && g <= 175 && b <= 30) {
    return { mmh: 40.0, outR: 249, outG: 115, outB: 22, outA: 255 };
  }
  // Level 7: #ff2800 (255,40,0) -> 50-80 mm/h
  if (r >= 240 && g <= 65 && b <= 30) {
    return { mmh: 65.0, outR: 239, outG: 68, outB: 68, outA: 255 };
  }
  // Level 8: #b40068 (180,0,104) -> 80+ mm/h
  if (r >= 160 && r <= 205 && g <= 25 && b >= 85 && b <= 125) {
    return { mmh: 85.0, outR: 180, outG: 0, outB: 104, outA: 255 };
  }
  return null;
}

function loadTileImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * 指定フレームの気象庁ナウキャスト (hrpns) または 降水短時間予報 (rasrf) タイルを
 * 1枚の透過PNG DataURLに合成し、0ms地点インスペクター用の数値グリッドとともに返します。
 */
export async function fetchJMANowcastRainLayer(
  frame: TimelineFrameItem
): Promise<GSMaPRainLayerResult> {
  const canvas = document.createElement('canvas');
  canvas.width = JMA_CANVAS_WIDTH;
  canvas.height = JMA_CANVAS_HEIGHT;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const isRasrf = frame.tileDataset === 'rasrf';
  const tileTasks: Array<Promise<{ gx: number; gy: number; img: HTMLImageElement | null }>> = [];
  for (let ty = JMA_Y_MIN; ty <= JMA_Y_MAX; ty++) {
    for (let tx = JMA_X_MIN; tx <= JMA_X_MAX; tx++) {
      const gx = tx - JMA_X_MIN;
      const gy = ty - JMA_Y_MIN;
      const url = isRasrf
        ? `https://www.jma.go.jp/bosai/jmatile/data/rasrf/${frame.basetime}/none/${frame.validtime}/surf/rasrf/${JMA_TILE_Z}/${tx}/${ty}.png`
        : `https://www.jma.go.jp/bosai/jmatile/data/nowc/${frame.basetime}/none/${frame.validtime}/surf/hrpns/${JMA_TILE_Z}/${tx}/${ty}.png`;
      tileTasks.push(loadTileImage(url).then((img) => ({ gx, gy, img })));
    }
  }

  const loadedTiles = await Promise.all(tileTasks);
  if (ctx) {
    for (const { gx, gy, img } of loadedTiles) {
      if (img) {
        ctx.drawImage(img, gx * 256, gy * 256, 256, 256);
      }
    }
  }

  const jmaGrid = new Uint16Array(JMA_CANVAS_WIDTH * JMA_CANVAS_HEIGHT);
  let maxPrecipitation = 0;
  let sumPrecipitation = 0;
  let rainPixelCount = 0;

  if (ctx) {
    const imgData = ctx.getImageData(0, 0, JMA_CANVAS_WIDTH, JMA_CANVAS_HEIGHT);
    const data = imgData.data;
    const totalPixels = JMA_CANVAS_WIDTH * JMA_CANVAS_HEIGHT;

    for (let i = 0; i < totalPixels; i++) {
      const idx = i * 4;
      const a = data[idx + 3];
      if (a < 20) {
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
        data[idx + 3] = 0;
      }
    }

    ctx.putImageData(imgData, 0, 0);
  }

  const imageUrl = canvas.toDataURL('image/png');
  const meanPrecipitation =
    rainPixelCount > 0 ? Number((sumPrecipitation / rainPixelCount).toFixed(2)) : 0;

  return {
    imageUrl,
    coordinates: JMA_NOWCAST_COORDINATES,
    observedAt: frame.date,
    formattedDateJST: frame.labelJST,
    maxPrecipitation,
    meanPrecipitation,
    sourceType: 'jma-nowcast',
    jmaGrid,
  };
}

/**
 * 合成済み気象庁ナウキャスト/降水短時間予報グリッドから指定経緯度の降雨強度 (mm/h) を0msで取得します。
 */
export function inspectJMAPrecipitation(
  jmaGrid: Uint16Array | undefined,
  lng: number,
  lat: number
): number {
  if (
    !jmaGrid ||
    lng < JMA_NOWCAST_WEST ||
    lng > JMA_NOWCAST_EAST ||
    lat < JMA_NOWCAST_SOUTH ||
    lat > JMA_NOWCAST_NORTH
  ) {
    return 0;
  }

  const n = Math.pow(2, JMA_TILE_Z);
  const tileX = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const tileY =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;

  const u = (tileX - JMA_X_MIN) / JMA_TILES_X;
  const v = (tileY - JMA_Y_MIN) / JMA_TILES_Y;
  if (u < 0 || u >= 1 || v < 0 || v >= 1) {
    return 0;
  }

  const px = Math.min(JMA_CANVAS_WIDTH - 1, Math.max(0, Math.floor(u * JMA_CANVAS_WIDTH)));
  const py = Math.min(JMA_CANVAS_HEIGHT - 1, Math.max(0, Math.floor(v * JMA_CANVAS_HEIGHT)));

  // クリック地点の3x3ピクセル近傍の最大値を取ることで境界上の微小クリックズレも吸収
  let bestVal = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const ny = py + dy;
    if (ny < 0 || ny >= JMA_CANVAS_HEIGHT) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const nx = px + dx;
      if (nx < 0 || nx >= JMA_CANVAS_WIDTH) continue;
      const val = jmaGrid[ny * JMA_CANVAS_WIDTH + nx];
      if (val > bestVal) bestVal = val;
    }
  }

  return Number((bestVal / 10).toFixed(2));
}
