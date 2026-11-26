export type RouteProfile = 'driving-car' | 'foot-hiking' | 'cycling-regular';

export interface RouteStep {
  distance: number;
  duration: number;
  wayPoints: [number, number];
}

export interface OrsRouteResult {
  profile: RouteProfile;
  coordinates: [number, number][];
  distanceMeters: number;
  durationSeconds: number;
  bbox: [number, number, number, number];
  steps: RouteStep[];
}

export type RouteErrorCode =
  | 'MISSING_API_KEY'
  | 'INVALID_REQUEST'
  | 'POINT_NOT_FOUND'
  | 'LIMIT_EXCEEDED'
  | 'RATE_LIMITED'
  | 'UPSTREAM_AUTH_ERROR'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_UNAVAILABLE'
  | 'NETWORK_ERROR'
  | 'INVALID_RESPONSE'
  | 'ABORTED';

export class RouteClientError extends Error {
  constructor(
    public readonly code: RouteErrorCode,
    public readonly userMessage: string,
    public readonly status?: number
  ) {
    super(userMessage);
    this.name = 'RouteClientError';
  }
}

function isFiniteLngLat(pair: unknown): pair is [number, number] {
  if (!Array.isArray(pair) || pair.length < 2) return false;
  const [lng, lat] = pair;
  return (
    typeof lng === 'number' &&
    Number.isFinite(lng) &&
    lng >= -180 &&
    lng <= 180 &&
    typeof lat === 'number' &&
    Number.isFinite(lat) &&
    lat >= -90 &&
    lat <= 90
  );
}

function computeBbox(coordinates: [number, number][]): [number, number, number, number] {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of coordinates) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLng, minLat, maxLng, maxLat];
}

/**
 * Parse and validate an OpenRouteService `/v2/directions/{profile}/geojson` response.
 */
export function parseOrsGeoJson(profile: RouteProfile, raw: unknown): OrsRouteResult {
  if (!raw || typeof raw !== 'object') {
    throw new RouteClientError(
      'INVALID_RESPONSE',
      'ルートデータの形式が不正です。'
    );
  }

  const collection = raw as {
    type?: unknown;
    bbox?: unknown;
    features?: unknown;
  };

  if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features) || collection.features.length === 0) {
    throw new RouteClientError(
      'INVALID_RESPONSE',
      'ルートが見つかりませんでした。'
    );
  }

  const feature = collection.features[0] as {
    geometry?: { type?: unknown; coordinates?: unknown };
    properties?: {
      summary?: { distance?: unknown; duration?: unknown };
      segments?: Array<{
        steps?: Array<{
          distance?: unknown;
          duration?: unknown;
          way_points?: unknown;
        }>;
      }>;
    };
  };

  if (
    !feature?.geometry ||
    feature.geometry.type !== 'LineString' ||
    !Array.isArray(feature.geometry.coordinates) ||
    feature.geometry.coordinates.length < 2
  ) {
    throw new RouteClientError(
      'INVALID_RESPONSE',
      'ルート座標データが含まれていません。'
    );
  }

  const coordinates: [number, number][] = [];
  for (const rawCoord of feature.geometry.coordinates) {
    if (!isFiniteLngLat(rawCoord)) {
      throw new RouteClientError(
        'INVALID_RESPONSE',
        'ルート座標に不正な値が含まれています。'
      );
    }
    coordinates.push([rawCoord[0], rawCoord[1]]);
  }

  const summary = feature.properties?.summary;
  const distanceMeters = summary?.distance;
  const durationSeconds = summary?.duration;

  if (
    typeof distanceMeters !== 'number' ||
    !Number.isFinite(distanceMeters) ||
    distanceMeters < 0 ||
    typeof durationSeconds !== 'number' ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds < 0
  ) {
    throw new RouteClientError(
      'INVALID_RESPONSE',
      'ルートの距離・所要時間情報が取得できませんでした。'
    );
  }

  const steps: RouteStep[] = [];
  if (Array.isArray(feature.properties?.segments)) {
    for (const seg of feature.properties.segments) {
      if (!seg || !Array.isArray(seg.steps)) continue;
      for (const step of seg.steps) {
        if (
          step &&
          typeof step.distance === 'number' &&
          Number.isFinite(step.distance) &&
          step.distance >= 0 &&
          typeof step.duration === 'number' &&
          Number.isFinite(step.duration) &&
          step.duration >= 0 &&
          Array.isArray(step.way_points) &&
          step.way_points.length === 2 &&
          Number.isInteger(step.way_points[0]) &&
          Number.isInteger(step.way_points[1])
        ) {
          steps.push({
            distance: step.distance,
            duration: step.duration,
            wayPoints: [step.way_points[0], step.way_points[1]],
          });
        }
      }
    }
  }

  const bbox = computeBbox(coordinates);

  return {
    profile,
    coordinates,
    distanceMeters,
    durationSeconds,
    bbox,
    steps,
  };
}

function mapProxyErrorCode(code: unknown, status: number): RouteErrorCode {
  switch (code) {
    case 'MISSING_API_KEY':
      return 'MISSING_API_KEY';
    case 'POINT_NOT_FOUND':
      return 'POINT_NOT_FOUND';
    case 'LIMIT_EXCEEDED':
      return 'LIMIT_EXCEEDED';
    case 'RATE_LIMITED':
      return 'RATE_LIMITED';
    case 'UPSTREAM_AUTH_ERROR':
      return 'UPSTREAM_AUTH_ERROR';
    case 'UPSTREAM_TIMEOUT':
      return 'UPSTREAM_TIMEOUT';
    case 'UPSTREAM_UNAVAILABLE':
      return 'UPSTREAM_UNAVAILABLE';
    case 'INVALID_REQUEST':
    case 'INVALID_PROFILE':
    case 'INVALID_COORDINATES':
    case 'PAYLOAD_TOO_LARGE':
      return 'INVALID_REQUEST';
    default:
      if (status === 429) return 'RATE_LIMITED';
      if (status === 504) return 'UPSTREAM_TIMEOUT';
      if (status >= 500) return 'UPSTREAM_UNAVAILABLE';
      return 'INVALID_REQUEST';
  }
}

export interface FetchRouteOptions {
  profile: RouteProfile;
  coordinates: [number, number][];
  signal?: AbortSignal;
}

/**
 * Fetch route directions via the same-origin `/api/route` proxy (never handles API keys in frontend).
 */
export async function fetchRouteFromProxy({
  profile,
  coordinates,
  signal,
}: FetchRouteOptions): Promise<OrsRouteResult> {
  if (coordinates.length < 2) {
    throw new RouteClientError(
      'INVALID_REQUEST',
      '出発地と目的地の2地点を指定してください。'
    );
  }

  let response: Response;
  try {
    response = await fetch('/api/route', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ profile, coordinates }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      throw new RouteClientError('ABORTED', 'ルート検索をキャンセルしました。');
    }
    throw new RouteClientError(
      'NETWORK_ERROR',
      'ルート検索サーバーへ接続できませんでした。通信環境をご確認ください。'
    );
  }

  if (!response.ok) {
    let errorBody: { error?: unknown; code?: unknown } | null = null;
    try {
      errorBody = (await response.json()) as { error?: unknown; code?: unknown };
    } catch {
      // ignore non-JSON error body
    }
    const mappedCode = mapProxyErrorCode(errorBody?.code, response.status);
    const serverMsg =
      typeof errorBody?.error === 'string' && errorBody.error.trim()
        ? errorBody.error.trim()
        : `ルート取得に失敗しました (HTTP ${response.status})。`;
    throw new RouteClientError(mappedCode, serverMsg, response.status);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new RouteClientError(
      'INVALID_RESPONSE',
      'ルート応答のJSON解析に失敗しました。'
    );
  }

  return parseOrsGeoJson(profile, json);
}
