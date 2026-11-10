import { bounded } from './asyncLifecycle';
import { safeGetLocalStorage } from './favoritesStorage';
import type {
  Bbox,
  ColorMapObject,
  DataObject,
  ImageCollection,
  Inspector,
  JaxaEarthModule,
  TileGenerator,
} from '../types/jaxa';
import type { RainSourceId } from '../types/map';
import type { DataState } from '../types/status';
import { inspectJMAPrecipitation } from './jmaNowcastClient';
import * as localJaxaEarth from './jaxa.earth.esm.js';

export const JAXA_EARTH_ESM_URL =
  'https://data.earth.jaxa.jp/api/javascript/v2.0.1/jaxa.earth.esm.js';

export const AW3D30_COLLECTION_URL =
  'https://s3.ap-northeast-1.wasabisys.com/je-pds/cog/v1/JAXA.EORC_ALOS.PRISM_AW3D30.v3.2_global/collection.json';

export const GSMAP_COLLECTION_URL =
  'https://s3.ap-northeast-1.wasabisys.com/je-pds/cog/v1/JAXA.EORC_GSMaP_standard.Gauge.v6_hourly/collection.json';

/** 日本列島および周辺海域（屋久島〜利尻島・知床）をカバーするBBox [西経, 南緯, 東経, 北緯] */
export const JAPAN_RAIN_BBOX: Bbox = [126.0, 28.0, 146.0, 46.0];

/** MapLibre ImageSource 用の座標バインド [左上, 右上, 右下, 左下] */
export const JAPAN_RAIN_COORDINATES: [
  [number, number],
  [number, number],
  [number, number],
  [number, number],
] = [
  [JAPAN_RAIN_BBOX[0], JAPAN_RAIN_BBOX[3]], // Top-Left: [126.0, 46.0]
  [JAPAN_RAIN_BBOX[2], JAPAN_RAIN_BBOX[3]], // Top-Right: [146.0, 46.0]
  [JAPAN_RAIN_BBOX[2], JAPAN_RAIN_BBOX[1]], // Bottom-Right: [146.0, 28.0]
  [JAPAN_RAIN_BBOX[0], JAPAN_RAIN_BBOX[1]], // Bottom-Left: [126.0, 28.0]
];

let readyJaxaModule = localJaxaEarth as unknown as JaxaEarthModule;
let jaxaModulePromise: Promise<JaxaEarthModule> | null = null;
const aw3dTileGenerators = new Map<number, Promise<TileGenerator>>();
let gsmapCollectionPromise: Promise<ImageCollection> | null = null;
let currentRainInspector: Inspector | null = null;
let currentJmaGrid: Uint16Array | undefined = undefined;
let activeRainSourceType: RainSourceId = 'jma-nowcast';
let currentElevationDataCache: DataObject | null = null;
let currentElevationInspector: Inspector | null = null;

/**
 * JAXA Earth API for JavaScript (v2.0.1 ESM) をロードして返します。
 * 外部動的importが初期表示を無期限に妨げないようタイムアウト（1500ms）を設け、
 * オフライン・遅延時は同梱のローカルバンドルへ即時フォールバックします (FIX-12)。
 */
export async function getJaxaEarth(): Promise<JaxaEarthModule> {
  if (!jaxaModulePromise) {
    jaxaModulePromise = (async () => {
      try {
        const remoteMod = await bounded(import(/* @vite-ignore */ JAXA_EARTH_ESM_URL), 1500) as unknown as JaxaEarthModule;
        readyJaxaModule = remoteMod;
        return remoteMod;
      } catch {
        return localJaxaEarth as unknown as JaxaEarthModule;
      }
    })();
  }
  return jaxaModulePromise;
}

/**
 * GSMaP Hourly の ImageCollection シングルトンを初期化して返します。
 * 初期化失敗時はシングルトンPromiseを破棄し、次回再試行可能にします (FIX-04)。
 */
export async function getGSMaPImageCollection(): Promise<ImageCollection> {
  if (!gsmapCollectionPromise) {
    const pending = (async () => {
      const je = await getJaxaEarth();
      const ic = new je.ImageCollection({ collectionUrl: GSMAP_COLLECTION_URL });
      await bounded(ic.init(), 10000);
      return ic;
    })();
    gsmapCollectionPromise = pending;
    void pending.catch(() => { if (gsmapCollectionPromise === pending) gsmapCollectionPromise = null; });
  }
  return gsmapCollectionPromise;
}

/**
 * AW3D30 (全球30m標高DSM) の TileGenerator を初期化して返します。
 * 失敗時は再初期化可能にします (FIX-04)。
 */
export async function getAW3DTileGenerator(tileSize = 256): Promise<TileGenerator> {
  if (!aw3dTileGenerators.has(tileSize)) {
    const pending = (async () => {
      const je = await getJaxaEarth();
      const tg = new je.TileGenerator({ collectionUrl: AW3D30_COLLECTION_URL, band: 'DSM', tileSize, delay: 0 });
      await bounded(tg.init(), 10000);
      return tg;
    })();
    aw3dTileGenerators.set(tileSize, pending);
    void pending.catch(() => { if (aw3dTileGenerators.get(tileSize) === pending) aw3dTileGenerators.delete(tileSize); });
  }
  return aw3dTileGenerators.get(tileSize)!;
}

/**
 * 日本列島（九州〜中部山岳〜関東）の標高インスペクタ用AW3Dデータを事前キャッシュします。
 */
export async function preloadCentralMountainElevation(): Promise<void> {
  try {
    const je = await getJaxaEarth();
    const dataObj = await bounded(je.getDataObject({
      collectionUrl: AW3D30_COLLECTION_URL,
      band: 'DSM',
      bbox: [130.0, 31.0, 141.0, 38.0],
      width: 660,
      height: 420,
      resampling: je.Resampling.BILINEAR,
    }), 15000);
    currentElevationDataCache = dataObj;
    currentElevationInspector = new je.data.Inspector(dataObj);
  } catch (err) {
    // Optional preload failure never changes the active rain result.
  }
}

export interface GSMaPRainLayerResult {
  imageUrl: string;
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
  observedAt: Date;
  formattedDateJST: string;
  maxPrecipitation: number;
  meanPrecipitation: number;
  dataObject?: DataObject;
  sourceType?: RainSourceId;
  jmaGrid?: Uint16Array;
  status?: DataState;
  missingTilesCount?: number;
  totalTilesCount?: number;
  key?: string;
  /** Metadata of the frame actually displayed, independent of the slider thumb. */
  timelineFrame?: import('../types/map').TimelineFrameItem;
}

/**
 * 降雨強度 (mm/h) を気象レーダー風の多段階カラーマップに変換する定義
 */
export function createRainColorMapObjects(): ColorMapObject[] {
  return [
    {
      min: 0.0,
      max: 0.1,
      colors: ['00000000', '00000000'],
      deleteMin: true,
    },
    {
      min: 0.1,
      max: 0.5,
      colors: ['38bdf840', '38bdf8b8'], // 小雨・雲域 (Light Sky Blue)
    },
    {
      min: 0.5,
      max: 1.0,
      colors: ['38bdf8b8', '00d5ffdc'], // 弱い雨 (Cyan)
    },
    {
      min: 1.0,
      max: 2.0,
      colors: ['00d5ffdc', '218cffef'], // 並の雨 (Vibrant Blue)
    },
    {
      min: 2.0,
      max: 5.0,
      colors: ['218cffef', '0041ffff', '22c55eff'], // やや強い雨 (Deep Blue -> Emerald)
    },
    {
      min: 5.0,
      max: 10.0,
      colors: ['22c55eff', 'facc15ff'], // 強い雨 (Green -> Yellow)
    },
    {
      min: 10.0,
      max: 20.0,
      colors: ['facc15ff', 'f97316ff'], // 激しい雨 (Yellow -> Orange)
    },
    {
      min: 20.0,
      max: 50.0,
      colors: ['f97316ff', 'ef4444ff'], // 非常に激しい雨 (Orange -> Red)
    },
    {
      min: 50.0,
      max: 100.0,
      colors: ['ef4444ff', 'b40068ff'], // 猛烈な雨 (Red -> Magenta/Purple)
      deleteMax: false,
    },
  ];
}

export function formatDateToJST(date: Date): string {
  const jstTime = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = jstTime.getUTCFullYear();
  const mm = String(jstTime.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(jstTime.getUTCDate()).padStart(2, '0');
  const hh = String(jstTime.getUTCHours()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:00 JST`;
}

export interface GSMaPTimelineCatalog {
  dates: Date[];
  latestDate: Date;
  defaultDisplayDate: Date;
  isStale?: boolean;
  savedAt?: string;
}

/**
 * GSMaP Hourly カタログから最新観測日時と過去24時間の毎時リスト（最大25フレーム）を取得します。
 */
let catalogInFlight: Promise<GSMaPTimelineCatalog> | null = null;
export function fetchGSMaPTimelineCatalog(refresh = false): Promise<GSMaPTimelineCatalog> {
  if (!catalogInFlight) {
    const pending = loadGSMaPTimelineCatalog(refresh);
    catalogInFlight = pending;
    void pending.finally(() => { if (catalogInFlight === pending) catalogInFlight = null; }).catch(() => {});
  }
  return catalogInFlight;
}
async function loadGSMaPTimelineCatalog(refresh = false): Promise<GSMaPTimelineCatalog> {
  if (refresh) gsmapCollectionPromise = null;
  try {
  const ic = await getGSMaPImageCollection();

  const latestDate = ic.last();
  const startWindow = new Date(latestDate.getTime() - 24 * 60 * 60 * 1000);
  let dates = await bounded(ic.getDateAll(startWindow, new Date(latestDate.getTime() + 3600 * 1000)), 10000);
  if (!Number.isFinite(latestDate.getTime())) throw new Error("Invalid catalog date");
  dates = dates.filter(d => Number.isFinite(d.getTime())).sort((a,b) => a.getTime()-b.getTime());

  if (!dates || dates.length === 0) {
    dates = [latestDate];
  } else if (dates.length > 25) {
    dates = dates.slice(-25);
  }

  const activeRainTarget = dates.find(
    (d) => d.getUTCHours() === 6 || d.getUTCHours() === 5
  );
  const defaultDisplayDate = activeRainTarget ?? dates[dates.length - 1];

  const savedAt = new Date().toISOString();
  try { safeGetLocalStorage()?.setItem('rain3d_gsmap_catalog_v1', JSON.stringify({ version: 1, dates, latestDate, defaultDisplayDate, savedAt })); } catch { /* optional cache */ }
  return { dates, latestDate, defaultDisplayDate, savedAt, isStale: false };
  } catch (error) {
    try {
      const raw = JSON.parse(safeGetLocalStorage()?.getItem('rain3d_gsmap_catalog_v1') ?? 'null');
      if (raw?.version === 1 && Array.isArray(raw.dates) && raw.dates.length > 0 && raw.dates.length <= 25) {
        const dates = raw.dates.map((d: string) => new Date(d)) as Date[];
        const defaultDisplayDate = new Date(raw.defaultDisplayDate);
        if (dates.every(d => Number.isFinite(d.getTime())) && dates.some(d => d.getTime() === defaultDisplayDate.getTime())) {
          return { dates, latestDate: dates[dates.length-1], defaultDisplayDate, isStale: true, savedAt: raw.savedAt };
        }
      }
    } catch { /* invalid cache is not a catalog */ }
    throw error;
  }
}

/**
 * 指定日時の GSMaP 降水データを取得。
 * 取得関数はデータを返す責任に限定し、途中でアクティブインスペクターを変更しない (FIX-05)。
 */
export async function fetchGSMaPRainLayer(
  targetDate?: Date,
  updateActiveInspector = false,
  signal?: AbortSignal
): Promise<GSMaPRainLayerResult> {
  signal?.throwIfAborted();
  const je = await getJaxaEarth();
  signal?.throwIfAborted();
  const ic = await getGSMaPImageCollection();
  signal?.throwIfAborted();

  const useDate = targetDate ?? ic.last();
  const img = await bounded(ic.getImage({ date: useDate, band: 'PRECIP' }), 10000, signal);
  signal?.throwIfAborted();

  const dataObject = await bounded(img.getDataObject({
    bbox: JAPAN_RAIN_BBOX,
    width: 560,
    height: 476,
    resampling: je.Resampling.BILINEAR,
  }), 15000, signal);
  signal?.throwIfAborted();

  if (updateActiveInspector) {
    activeRainSourceType = 'jaxa-gsmap';
    currentRainInspector = new je.data.Inspector(dataObject);
  }

  const colorMap = new je.image.ColorMap(createRainColorMapObjects());
  const canvas = je.image.createCanvas(dataObject, colorMap);
  const imageUrl = canvas.toDataURL('image/png');
  canvas.width = 0; canvas.height = 0;

  const stats = je.data.stat(dataObject);
  if (!Number.isFinite(stats.max) || !Number.isFinite(stats.mean)) throw new Error('GSMaP missing data');
  const observedDate = img.getDate() ?? useDate;
  const key = `gsmap:Gauge.v6_hourly:126,28,146,46:560x476:${observedDate.toISOString()}:v2`;

  return {
    imageUrl,
    coordinates: JAPAN_RAIN_COORDINATES,
    observedAt: observedDate,
    formattedDateJST: formatDateToJST(observedDate),
    maxPrecipitation: Number.isFinite(stats.max) ? stats.max : 0,
    meanPrecipitation: Number.isFinite(stats.mean) ? stats.mean : 0,
    dataObject,
    sourceType: 'jaxa-gsmap',
    status: 'success',
    key,
  };
}

/**
 * 現在表示中のレイヤー結果（気象庁ナウキャスト または JAXA GSMaP）をアクティブインスペクターにセットします。
 */
export function setActiveRainLayerResult(layer: GSMaPRainLayerResult): void {
  if (layer.sourceType === 'jma-nowcast') {
    activeRainSourceType = 'jma-nowcast';
    currentJmaGrid = layer.jmaGrid;
  } else {
    activeRainSourceType = 'jaxa-gsmap';
    currentRainInspector = null;
    if (layer.dataObject) {
      const dobj = layer.dataObject;
      currentRainInspector = new readyJaxaModule.data.Inspector(dobj);
    }
  }
}

export function setActiveRainDataObject(dataObject: DataObject): void {
  activeRainSourceType = 'jaxa-gsmap';
  currentRainInspector = new readyJaxaModule.data.Inspector(dataObject);
}

/**
 * 任意の経緯度 [lng, lat] における現在表示中の降水量 (mm/h) と AW3D30 標高 (m) を即座に取得します。
 * 欠測時は precipitation: null を返します (FIX-02)。
 */
export function inspectLocationValues(
  lng: number,
  lat: number
): { precipitation: number | null; elevation: number | null } {
  let precipitation: number | null = null;
  let elevation: number | null = null;

  if (activeRainSourceType === 'jma-nowcast' && currentJmaGrid) {
    precipitation = inspectJMAPrecipitation(currentJmaGrid, lng, lat);
  } else if (activeRainSourceType === 'jaxa-gsmap' && currentRainInspector) {
    const val = currentRainInspector.getValueByCoordinateXY(lng, lat);
    if (val !== null && Number.isFinite(val)) {
      precipitation = Math.max(0, Number(val.toFixed(2)));
    }
  }

  if (currentElevationInspector && currentElevationDataCache) {
    const elev = currentElevationInspector.getValueByCoordinateXY(lng, lat);
    if (elev !== null && Number.isFinite(elev)) {
      elevation = Math.round(elev);
    }
  }

  return { precipitation, elevation };
}

export async function fetchPointElevationFromAW3D(
  lng: number,
  lat: number
): Promise<number | null> {
  try {
    const je = await getJaxaEarth();
    const dl = 0.02;
    const dataObj = await bounded(je.getDataObject({
      collectionUrl: AW3D30_COLLECTION_URL,
      band: 'DSM',
      bbox: [lng - dl, lat - dl, lng + dl, lat + dl],
      width: 16,
      height: 16,
      resampling: je.Resampling.BILINEAR,
    }), 15000);
    const isp = new je.data.Inspector(dataObj);
    const val = isp.getValueByCoordinateXY(lng, lat);
    if (val !== null && Number.isFinite(val)) {
      return Math.round(val);
    }
  } catch {
    // 取得失敗時は null
  }
  return null;
}
