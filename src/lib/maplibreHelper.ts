import maplibregl from 'maplibre-gl';
import type { BaseMapId, PresetLocation, RendererBackend, WebGPUStatus } from '../types/map';
import { getAW3DTileGenerator, getJaxaEarth } from './jaxaClient';
import { HYAKUMEIZAN_PRESETS } from './hyakumeizanData';
import { fetchTileBytesWithRetry, getTileWithOpfsSWR } from './opfsTileCache';

export const PRESET_LOCATIONS: PresetLocation[] = HYAKUMEIZAN_PRESETS;

const UPSTREAM_RASTER_TEMPLATES: Record<BaseMapId, string> = {
  osm: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  hillshade: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',
  photo:
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
};

export const BASE_MAP_SOURCES: Record<
  BaseMapId,
  { name: string; description: string; tiles: string[]; attribution: string; maxzoom: number }
> = {
  osm: {
    name: 'OpenStreetMap（標準）',
    description: '道路・都市名・行政界を含む標準マップ',
    tiles: ['opfs-raster://osm/{z}/{x}/{y}'],
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
    maxzoom: 19,
  },
  hillshade: {
    name: '起伏陰影（地理院淡色＋3D陰影）',
    description: '山岳の尾根・谷筋の立体陰影を強調した地形図',
    tiles: ['opfs-raster://hillshade/{z}/{x}/{y}'],
    attribution:
      '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noreferrer">国土地理院 淡色地図</a>',
    maxzoom: 18,
  },
  photo: {
    name: '航空写真（衛星・オルソ画像）',
    description: '植生・雪渓・火口をリアルに映す高解像度衛星写真',
    tiles: ['opfs-raster://photo/{z}/{x}/{y}'],
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics',
    maxzoom: 18,
  },
};

let protocolRegistered = false;
const flatZeroTerrainPngCache = new Map<number, Uint8Array>();

/**
 * WebGPU (navigator.gpu) の対応状況を検出し、可能な限り高パフォーマンスGPUアダプタ・デバイスを要求します。
 * 未対応環境では安全に WebGL2 へフォールバックします。
 */
export async function initGraphicsBackend(): Promise<Omit<WebGPUStatus, 'fps'>> {
  if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
    try {
      const gpu = (navigator as Navigator & { gpu?: any }).gpu;
      if (gpu) {
        const adapter = await gpu.requestAdapter({
          powerPreference: 'high-performance',
        });
        if (adapter) {
          const device = await adapter.requestDevice();
          const info = adapter.info || {};
          const adapterLabel =
            [info.vendor, info.architecture || info.device].filter(Boolean).join(' ') ||
            'WebGPU High-Performance Adapter';

          try {
            const shaderModule = device.createShaderModule({
              code: `
                @compute @workgroup_size(64)
                fn main(@builtin(global_invocation_id) id: vec3<u32>) {
                  let _idx = id.x;
                }
              `,
            });
            await device.createComputePipelineAsync({
              layout: 'auto',
              compute: { module: shaderModule, entryPoint: 'main' },
            });
          } catch {
            // シェーダーウォームアップ失敗時もデバイス自体は利用可能
          }

          return {
            backend: 'webgpu',
            webgpuAvailable: true,
            adapterInfo: `${adapterLabel} (WebGPU Active)`,
          };
        }
      }
    } catch (err) {
      console.warn('WebGPU initialization failed, falling back to WebGL2:', err);
    }
  }

  return {
    backend: 'webgl2',
    webgpuAvailable: false,
    adapterInfo: 'WebGL2 Fallback Pipeline',
  };
}

/**
 * AW3D30 の DataObject (Float32Array 標高データ[m]) を
 * MapLibre GL JS の raster-dem が要求する Mapbox Terrain-RGB 形式の PNG バイナリに変換します。
 */
async function encodeTerrainRGBPng(
  data: Float32Array | Uint32Array | null,
  tileSize: number
): Promise<Uint8Array> {
  if (!data) {
    const cachedFlat = flatZeroTerrainPngCache.get(tileSize);
    if (cachedFlat) {
      return cachedFlat;
    }
  }

  const je = await getJaxaEarth();
  const rgba = new Uint8ClampedArray(tileSize * tileSize * 4);

  if (data) {
    const len = Math.min(data.length, tileSize * tileSize);
    for (let i = 0; i < len; i++) {
      let height = data[i];
      if (Number.isNaN(height) || !Number.isFinite(height) || height < -500) {
        height = 0;
      }
      const h = Math.round((height + 10000) * 10) | 0;
      const offset = i * 4;
      rgba[offset] = (h >>> 16) & 255;
      rgba[offset + 1] = (h >>> 8) & 255;
      rgba[offset + 2] = h & 255;
      rgba[offset + 3] = 255;
    }
  } else {
    for (let i = 0; i < tileSize * tileSize; i++) {
      const offset = i * 4;
      rgba[offset] = 1;
      rgba[offset + 1] = 134;
      rgba[offset + 2] = 160;
      rgba[offset + 3] = 255;
    }
  }

  const pngBytes: Uint8Array = await je.image.createPngUint8ArrayByImageDataObject({
    width: tileSize,
    height: tileSize,
    data: rgba,
  });

  if (!data) {
    flatZeroTerrainPngCache.set(tileSize, pngBytes);
  }

  return pngBytes;
}

/**
 * JAXA Earth API (AW3D30) の 3D Terrain RGB カスタムプロトコル (`jaxa-aw3d://`) および
 * OPFS Stale-While-Revalidate 背景地図タイルプロトコル (`opfs-raster://`) を MapLibre に登録します。
 */
export function registerJaxaTerrainProtocol(tileSize = 256): void {
  if (protocolRegistered) return;
  protocolRegistered = true;

  // 1. 背景地図タイル (OSM / 国土地理院淡色 / Esri航空写真): OPFS Stale-While-Revalidate + 通信リトライ
  maplibregl.addProtocol('opfs-raster', async (params, abortController) => {
    const parts = params.url.replace('opfs-raster://', '').split('/');
    const sourceId = (parts[0] as BaseMapId) || 'osm';
    const z = parseInt(parts[1], 10);
    const x = parseInt(parts[2], 10);
    const y = parseInt(parts[3], 10);

    const template = UPSTREAM_RASTER_TEMPLATES[sourceId] ?? UPSTREAM_RASTER_TEMPLATES.osm;
    const upstreamUrl = template
      .replace('{z}', String(z))
      .replace('{x}', String(x))
      .replace('{y}', String(y));

    const buffer = await getTileWithOpfsSWR({
      category: 'raster',
      key: `${sourceId}_${z}_${x}_${y}`,
      fetcher: (sig) => fetchTileBytesWithRetry(upstreamUrl, sig),
      signal: abortController.signal,
    });

    return { data: buffer };
  });

  // 2. 3D標高DEMタイル (JAXA AW3D30): OPFS Stale-While-Revalidate
  maplibregl.addProtocol('jaxa-aw3d', async (params, abortController) => {
    const parts = params.url.replace('jaxa-aw3d://', '').split('/');
    const z = parseInt(parts[0], 10);
    const x = parseInt(parts[1], 10);
    const y = parseInt(parts[2], 10);

    // 過去バージョンで0m平坦タイルとしてキャッシュされてしまった残骸を無効化するためキーを v2 に更新
    const buffer = await getTileWithOpfsSWR({
      category: 'terrain',
      key: `aw3d_v2_${tileSize}_${z}_${x}_${y}`,
      fetcher: async (sig) => {
        let lastError: unknown = null;
        for (let attempt = 0; attempt <= 2; attempt++) {
          if (sig?.aborted) {
            throw new DOMException('Terrain tile request aborted', 'AbortError');
          }
          try {
            const tg = await getAW3DTileGenerator(tileSize);
            const dataObject = await tg.getDataObject(x, y, z, sig);
            if (!dataObject || !dataObject.data) {
              throw new Error('No land elevation data for tile');
            }
            return await encodeTerrainRGBPng(dataObject.data, tileSize);
          } catch (err) {
            lastError = err;
            if (sig?.aborted) throw err;
            if (attempt < 2) {
              await new Promise((res) => setTimeout(res, 250 * (attempt + 1)));
            }
          }
        }
        throw lastError ?? new Error(`Failed to load terrain tile ${z}/${x}/${y}`);
      },
      signal: abortController.signal,
    });
    return { data: buffer };
  });
}

/**
 * WebGPU 優先（未対応環境では WebGL2 自動フォールバック）設定で MapLibre GL JS インスタンスを生成します。
 */
export function createMapInstance(
  container: HTMLElement | string,
  initialPreset: PresetLocation = PRESET_LOCATIONS[0],
  preferredBackend: RendererBackend = 'webgpu'
): maplibregl.Map {
  const baseStyle: maplibregl.StyleSpecification = {
    version: 8,
    sky: {
      'sky-color': '#091428',
      'sky-horizon-blend': 0.45,
      'horizon-color': '#1e3a5f',
      'horizon-fog-blend': 0.6,
      'fog-color': '#0f172a',
      'fog-ground-blend': 0.35,
    },
    sources: {
      osm: {
        type: 'raster',
        tiles: BASE_MAP_SOURCES.osm.tiles,
        tileSize: 256,
        attribution: BASE_MAP_SOURCES.osm.attribution,
        maxzoom: BASE_MAP_SOURCES.osm.maxzoom,
      },
      hillshade: {
        type: 'raster',
        tiles: BASE_MAP_SOURCES.hillshade.tiles,
        tileSize: 256,
        attribution: BASE_MAP_SOURCES.hillshade.attribution,
        maxzoom: BASE_MAP_SOURCES.hillshade.maxzoom,
      },
      photo: {
        type: 'raster',
        tiles: BASE_MAP_SOURCES.photo.tiles,
        tileSize: 256,
        attribution: BASE_MAP_SOURCES.photo.attribution,
        maxzoom: BASE_MAP_SOURCES.photo.maxzoom,
      },
    },
    layers: [
      {
        id: 'base-osm',
        type: 'raster',
        source: 'osm',
        layout: { visibility: 'visible' },
        paint: {
          'raster-brightness-max': 0.88,
          'raster-contrast': 0.12,
          'raster-saturation': -0.15,
        },
      },
      {
        id: 'base-hillshade',
        type: 'raster',
        source: 'hillshade',
        layout: { visibility: 'none' },
        paint: {
          'raster-brightness-max': 0.92,
          'raster-contrast': 0.25,
          'raster-saturation': -0.4,
        },
      },
      {
        id: 'base-photo',
        type: 'raster',
        source: 'photo',
        layout: { visibility: 'none' },
        paint: {
          'raster-brightness-max': 0.95,
          'raster-contrast': 0.08,
        },
      },
    ],
  };

  const baseMapOptions: maplibregl.MapOptions = {
    container,
    style: baseStyle,
    center: initialPreset.center,
    zoom: initialPreset.zoom,
    pitch: initialPreset.pitch,
    bearing: initialPreset.bearing,
    maxPitch: 85,
    minZoom: 4,
    maxZoom: 15,
    fadeDuration: 0,
    attributionControl: false,
  };

  try {
    return new maplibregl.Map({
      ...baseMapOptions,
      canvasContextAttributes: {
        powerPreference: 'high-performance',
        antialias: preferredBackend === 'webgpu',
        desynchronized: true,
        contextType: 'webgl2',
      },
    });
  } catch (err) {
    console.warn('High-performance context creation failed, falling back to default WebGL:', err);
    return new maplibregl.Map(baseMapOptions);
  }
}
