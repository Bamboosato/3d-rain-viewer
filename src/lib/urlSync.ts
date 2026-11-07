import type { BaseMapId, PresetLocation, RainSourceId, TimelineFrameItem } from '../types/map';
import { HYAKUMEIZAN_PRESETS } from './hyakumeizanData';
import { isSameCoordinate } from './favoritesStorage';

/**
 * 共有リンク生成時に使用する公式カスタムドメイン
 */
export const PUBLIC_APP_ORIGIN = 'https://3d-rain-viewer.bamboosato.com';

export interface UrlViewState {
  lat: number;
  lng: number;
  zoom: number;
  pitch: number;
  bearing: number;
  rainSource?: RainSourceId;
  /** UNIX秒タイムスタンプ、またはフレームインデックス、またはISO日時文字列 */
  timeParam?: string;
  baseMap?: BaseMapId;
  exaggeration?: number;
}

function clamp(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

/**
 * 現在の window.location.search から初期3D視点・データソース・時刻パラメータを解析します。
 * `lat` と `lng` が有効な数値として存在する場合のみカメラ状態を復元します。
 */
export function parseUrlViewState(search: string = typeof window !== 'undefined' ? window.location.search : ''): UrlViewState | null {
  if (!search) return null;
  const params = new URLSearchParams(search);

  const latRaw = params.get('lat');
  const lngRaw = params.get('lng');
  if (latRaw === null || lngRaw === null) {
    return null;
  }

  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null;
  }

  const zRaw = params.get('z');
  const pRaw = params.get('p');
  const bRaw = params.get('b');
  const srcRaw = params.get('src');
  const tRaw = params.get('t');
  const mapRaw = params.get('map');
  const exRaw = params.get('ex');

  const zoom = zRaw !== null && Number.isFinite(Number(zRaw)) ? clamp(Number(zRaw), 3, 18) : 10.5;
  const pitch = pRaw !== null && Number.isFinite(Number(pRaw)) ? clamp(Math.round(Number(pRaw)), 0, 85) : 60;
  const bearing = bRaw !== null && Number.isFinite(Number(bRaw)) ? clamp(Math.round(Number(bRaw)), -180, 180) : 0;

  const rainSource: RainSourceId | undefined =
    srcRaw === 'jma-nowcast' || srcRaw === 'jaxa-gsmap' ? srcRaw : undefined;

  const baseMap: BaseMapId | undefined =
    mapRaw === 'osm' || mapRaw === 'hillshade' || mapRaw === 'photo' ? mapRaw : undefined;

  const exaggeration =
    exRaw !== null && Number.isFinite(Number(exRaw))
      ? clamp(Number(exRaw), 1.0, 3.0)
      : undefined;

  return {
    lat,
    lng,
    zoom,
    pitch,
    bearing,
    rainSource,
    timeParam: tRaw ?? undefined,
    baseMap,
    exaggeration,
  };
}

/**
 * URLパラメータから復元した UrlViewState を PresetLocation に変換します。
 * 座標が日本百名山プリセットの山頂付近（約2km以内）に一致する場合はその山岳情報を引き継ぎます。
 */
export function resolveInitialPresetFromUrl(
  urlState: UrlViewState | null,
  favorites: PresetLocation[] = []
): { preset: PresetLocation; isFromUrl: boolean } {
  if (!urlState) {
    return { preset: HYAKUMEIZAN_PRESETS[0], isFromUrl: false };
  }

  // お気に入りまたは百名山プリセットに一致する座標があるかチェック
  const matchedFav = favorites.find((f) =>
    isSameCoordinate(f.center[0], f.center[1], urlState.lng, urlState.lat, 0.005)
  );
  if (matchedFav) {
    return {
      preset: {
        ...matchedFav,
        center: [urlState.lng, urlState.lat],
        zoom: urlState.zoom,
        pitch: urlState.pitch,
        bearing: urlState.bearing,
      },
      isFromUrl: true,
    };
  }

  const matchedMountain = HYAKUMEIZAN_PRESETS.find((m) =>
    isSameCoordinate(m.center[0], m.center[1], urlState.lng, urlState.lat, 0.02)
  );
  if (matchedMountain) {
    return {
      preset: {
        ...matchedMountain,
        center: [urlState.lng, urlState.lat],
        zoom: urlState.zoom,
        pitch: urlState.pitch,
        bearing: urlState.bearing,
      },
      isFromUrl: true,
    };
  }

  return {
    preset: {
      id: 'shared-url-view',
      name: `共有地点 (${urlState.lat.toFixed(2)}°N, ${urlState.lng.toFixed(2)}°E)`,
      emoji: '📍',
      region: '共有された3D視点',
      elevation: 0,
      center: [urlState.lng, urlState.lat],
      zoom: urlState.zoom,
      pitch: urlState.pitch,
      bearing: urlState.bearing,
      description: 'URLパラメータから復元された3Dカメラ視点です。',
    },
    isFromUrl: true,
  };
}

/**
 * URLの `t` パラメータ（UNIX秒 / ミリ秒 / フレームインデックス / ISO文字列）から、
 * 現在のタイムラインフレーム配列内で最も近いインデックスを返します。
 */
export function resolveFrameIndexFromTimeParam(
  timeParam: string | undefined,
  frames: TimelineFrameItem[],
  defaultIndex: number
): number {
  if (!timeParam || frames.length === 0) return defaultIndex;

  const num = Number(timeParam);
  if (Number.isFinite(num)) {
    // 小さい整数の場合はフレームインデックスとして扱う
    if (Number.isInteger(num) && num >= 0 && num < frames.length) {
      return num;
    }
    // UNIX秒（10桁前後）またはミリ秒（13桁前後）として最も近いフレームを探索
    const targetMs = num < 1e11 ? num * 1000 : num;
    let bestIdx = defaultIndex;
    let minDiff = Infinity;
    frames.forEach((f, idx) => {
      const diff = Math.abs(f.date.getTime() - targetMs);
      if (diff < minDiff) {
        minDiff = diff;
        bestIdx = idx;
      }
    });
    // 48時間以上離れている古いリンクの場合は最新のデフォルトフレームを優先
    if (minDiff <= 1000 * 60 * 60 * 48) {
      return bestIdx;
    }
    return defaultIndex;
  }

  const parsedMs = Date.parse(timeParam);
  if (Number.isFinite(parsedMs)) {
    let bestIdx = defaultIndex;
    let minDiff = Infinity;
    frames.forEach((f, idx) => {
      const diff = Math.abs(f.date.getTime() - parsedMs);
      if (diff < minDiff) {
        minDiff = diff;
        bestIdx = idx;
      }
    });
    if (minDiff <= 1000 * 60 * 60 * 48) {
      return bestIdx;
    }
  }

  return defaultIndex;
}

/**
 * 現在のカメラ状態・雨雲ソース・観測時刻からURLSearchParamsを生成します。
 */
export function buildUrlSearchParams(state: {
  lat: number;
  lng: number;
  zoom: number;
  pitch: number;
  bearing: number;
  rainSource: RainSourceId;
  frameDate?: Date;
  baseMap?: BaseMapId;
  exaggeration?: number;
}): URLSearchParams {
  const params = new URLSearchParams();
  params.set('lat', state.lat.toFixed(4));
  params.set('lng', state.lng.toFixed(4));
  params.set('z', state.zoom.toFixed(2));
  params.set('p', String(Math.round(state.pitch)));
  params.set('b', String(Math.round(state.bearing)));
  params.set('src', state.rainSource);

  if (state.frameDate && Number.isFinite(state.frameDate.getTime())) {
    params.set('t', String(Math.floor(state.frameDate.getTime() / 1000)));
  }

  if (state.baseMap && state.baseMap !== 'osm') {
    params.set('map', state.baseMap);
  }

  if (typeof state.exaggeration === 'number' && Math.abs(state.exaggeration - 1.5) >= 0.05) {
    params.set('ex', state.exaggeration.toFixed(1));
  }

  return params;
}

/**
 * ブラウザ履歴を汚さずに（window.history.replaceState）アドレスバーのURLクエリを更新します。
 */
export function replaceUrlViewState(state: {
  lat: number;
  lng: number;
  zoom: number;
  pitch: number;
  bearing: number;
  rainSource: RainSourceId;
  frameDate?: Date;
  baseMap?: BaseMapId;
  exaggeration?: number;
}): void {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  const params = buildUrlSearchParams(state);
  const nextUrl = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
  window.history.replaceState(null, '', nextUrl);
}

/**
 * SNS・チャット共有用の完全なURL（カスタムドメイン https://3d-rain-viewer.bamboosato.com ベース）を生成します。
 */
export function getShareableCustomDomainUrl(): string {
  if (typeof window === 'undefined') {
    return `${PUBLIC_APP_ORIGIN}/`;
  }
  const search = window.location.search || '';
  return `${PUBLIC_APP_ORIGIN}/${search}`;
}
