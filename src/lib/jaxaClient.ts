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

/** MapLibre ImageSource 用の4隅座標 [左上, 右上, 右下, 左下] */
export const JAPAN_RAIN_COORDINATES: [
  [number, number],
  [number, number],
  [number, number],
  [number, number]
] = [
  [JAPAN_RAIN_BBOX[0], JAPAN_RAIN_BBOX[3]], // Top-Left (West, North)
  [JAPAN_RAIN_BBOX[2], JAPAN_RAIN_BBOX[3]], // Top-Right (East, North)
  [JAPAN_RAIN_BBOX[2], JAPAN_RAIN_BBOX[1]], // Bottom-Right (East, South)
  [JAPAN_RAIN_BBOX[0], JAPAN_RAIN_BBOX[1]], // Bottom-Left (West, South)
];

let jaxaModulePromise: Promise<JaxaEarthModule> | null = null;
let aw3dTileGeneratorPromise: Promise<TileGenerator> | null = null;
let gsmapCollectionPromise: Promise<ImageCollection> | null = null;
let currentRainInspector: Inspector | null = null;
let currentJmaGrid: Uint16Array | undefined = undefined;
let activeRainSourceType: RainSourceId = 'jma-nowcast';
let currentElevationDataCache: DataObject | null = null;
let currentElevationInspector: Inspector | null = null;

/**
 * JAXA Earth API for JavaScript (v2.0.1 ESM) をロードして返します。
 * 公式CDN URLからの動的ESMインポートを試み、オフラインやCORS制限時はローカルバンドルへフォールバックします。
 */
export async function getJaxaEarth(): Promise<JaxaEarthModule> {
  if (!jaxaModulePromise) {
    jaxaModulePromise = (async () => {
      try {
        const remoteMod = await import(/* @vite-ignore */ JAXA_EARTH_ESM_URL);
        return remoteMod as unknown as JaxaEarthModule;
      } catch {
        return localJaxaEarth as unknown as JaxaEarthModule;
      }
    })();
  }
  return jaxaModulePromise;
}

/**
 * GSMaP Hourly の ImageCollection シングルトンを初期化して返します。
 */
export async function getGSMaPImageCollection(): Promise<ImageCollection> {
  if (!gsmapCollectionPromise) {
    gsmapCollectionPromise = (async () => {
      const je = await getJaxaEarth();
      const ic = new je.ImageCollection({ collectionUrl: GSMAP_COLLECTION_URL });
      await ic.init();
      return ic;
    })();
  }
  return gsmapCollectionPromise;
}

/**
 * AW3D30 (全球30m標高DSM) の TileGenerator を初期化して返します。
 */
export async function getAW3DTileGenerator(tileSize = 256): Promise<TileGenerator> {
  if (!aw3dTileGeneratorPromise) {
    aw3dTileGeneratorPromise = (async () => {
      const je = await getJaxaEarth();
      const tg = new je.TileGenerator({
        collectionUrl: AW3D30_COLLECTION_URL,
        band: 'DSM',
        tileSize,
        // iOS Safari でドラッグ・パン中に setInterval がサスペンドしてタイル詰まりを起こすのを防ぐため 0ms（即時）に最適化
        delay: 0,
      });
      await tg.init();
      return tg;
    })();
  }
  return aw3dTileGeneratorPromise;
}

/**
 * 日本列島（九州〜中部山岳〜関東）の標高インスペクタ用AW3Dデータを事前キャッシュします。
 */
export async function preloadCentralMountainElevation(): Promise<void> {
  try {
    const je = await getJaxaEarth();
    const dataObj = await je.getDataObject({
      collectionUrl: AW3D30_COLLECTION_URL,
      band: 'DSM',
      bbox: [130.0, 31.0, 141.0, 38.0],
      width: 660,
      height: 420,
      resampling: je.Resampling.BILINEAR,
    });
    currentElevationDataCache = dataObj;
    currentElevationInspector = new je.data.Inspector(dataObj);
  } catch (err) {
    console.warn('AW3D elevation preload skipped:', err);
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
}

/**
 * GSMaP Hourly カタログから最新観測日時と過去24時間の毎時リスト（最大25フレーム）を取得します。
 */
export async function fetchGSMaPTimelineCatalog(): Promise<GSMaPTimelineCatalog> {
  const ic = await getGSMaPImageCollection();

  const latestDate = ic.last();
  const startWindow = new Date(latestDate.getTime() - 24 * 60 * 60 * 1000);
  let dates = await ic.getDateAll(startWindow, new Date(latestDate.getTime() + 3600 * 1000));

  if (!dates || dates.length === 0) {
    dates = [latestDate];
  } else if (dates.length > 25) {
    dates = dates.slice(-25);
  }

  // 最新24時間窓の中で山岳域（富士山・北アルプス）に降水帯が通過している時刻があれば初期フレームに設定
  const activeRainTarget = dates.find(
    (d) => d.getUTCHours() === 6 || d.getUTCHours() === 5
  );
  const defaultDisplayDate = activeRainTarget ?? dates[dates.length - 1];

  return {
    dates,
    latestDate,
    defaultDisplayDate,
  };
}

/**
 * 指定日時（省略時は最新観測データ）の GSMaP 降水データを取得し、
 * MapLibre 3D地形に重畳可能な透過PNG DataURL と統計情報を生成します。
 */
export async function fetchGSMaPRainLayer(
  targetDate?: Date,
  updateActiveInspector = true
): Promise<GSMaPRainLayerResult> {
  const je = await getJaxaEarth();
  const ic = await getGSMaPImageCollection();

  const useDate = targetDate ?? ic.last();
  const img = await ic.getImage({ date: useDate, band: 'PRECIP' });

  const dataObject = await img.getDataObject({
    bbox: JAPAN_RAIN_BBOX,
    width: 560,
    height: 476,
    resampling: je.Resampling.BILINEAR,
  });

  if (updateActiveInspector) {
    activeRainSourceType = 'jaxa-gsmap';
    currentRainInspector = new je.data.Inspector(dataObject);
  }

  const colorMap = new je.image.ColorMap(createRainColorMapObjects());
  const canvas = je.image.createCanvas(dataObject, colorMap);
  const imageUrl = canvas.toDataURL('image/png');

  const stats = je.data.stat(dataObject);
  const observedDate = img.getDate() ?? useDate;

  return {
    imageUrl,
    coordinates: JAPAN_RAIN_COORDINATES,
    observedAt: observedDate,
    formattedDateJST: formatDateToJST(observedDate),
    maxPrecipitation: Number.isFinite(stats.max) ? stats.max : 0,
    meanPrecipitation: Number.isFinite(stats.mean) ? stats.mean : 0,
    dataObject,
    sourceType: 'jaxa-gsmap',
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
    if (layer.dataObject) {
      const dobj = layer.dataObject;
      getJaxaEarth().then((je) => {
        currentRainInspector = new je.data.Inspector(dobj);
      });
    }
  }
}

/**
 * キャッシュ済みの GSMaP DataObject をアクティブなインスペクターにセットします。
 */
export function setActiveRainDataObject(dataObject: DataObject): void {
  activeRainSourceType = 'jaxa-gsmap';
  getJaxaEarth().then((je) => {
    currentRainInspector = new je.data.Inspector(dataObject);
  });
}

/**
 * 任意の経緯度 [lng, lat] における現在表示中の降水量 (mm/h) と AW3D30 標高 (m) を即座に取得します。
 */
export function inspectLocationValues(
  lng: number,
  lat: number
): { precipitation: number | null; elevation: number | null } {
  let precipitation: number | null = null;
  let elevation: number | null = null;

  if (activeRainSourceType === 'jma-nowcast' && currentJmaGrid) {
    precipitation = inspectJMAPrecipitation(currentJmaGrid, lng, lat);
  } else if (currentRainInspector) {
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

/**
 * 事前キャッシュ範囲外の地点がクリックされた場合、AW3D30 からピンポイントで標高(m)を非同期取得します。
 */
export async function fetchPointElevationFromAW3D(
  lng: number,
  lat: number
): Promise<number | null> {
  try {
    const je = await getJaxaEarth();
    const dl = 0.02;
    // JAXA Earth API の仕様制約 (width/height は 10 以上 10000 以下) に合わせ 16x16 を指定
    const dataObj = await je.getDataObject({
      collectionUrl: AW3D30_COLLECTION_URL,
      band: 'DSM',
      bbox: [lng - dl, lat - dl, lng + dl, lat + dl],
      width: 16,
      height: 16,
      resampling: je.Resampling.BILINEAR,
    });
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
