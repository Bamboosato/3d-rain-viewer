import type { TimelineFrameItem } from '../types/map';
import type { OrsRouteResult } from './orsClient';
import {
  getJMATileCoordinates,
  getJMATileUrl,
  loadTilePixelData,
  sampleJMAPrecipitationFromTile,
} from './pointTimeseriesClient';

export type RouteRainSeverity =
  | 'none'
  | 'weak'
  | 'moderate'
  | 'strong'
  | 'extreme'
  | 'unknown';

export type RouteSegmentStatus = 'ok' | 'out-of-range' | 'missing';

export interface RouteSegmentSplit {
  index: number;
  coordinates: [number, number][];
  midPoint: [number, number];
  distanceMeters: number;
  elapsedSeconds: number;
}

export interface RouteCheckpoint {
  index: number;
  lng: number;
  lat: number;
  distanceMeters: number;
  elapsedSeconds: number;
  eta: Date;
  etaLabelJST: string;
  precipitation: number | null;
  status: RouteSegmentStatus;
  severity: RouteRainSeverity;
  color: string;
  frameLabelJST?: string;
  frameRelativeBadge?: string;
}

export interface RouteWeatherSegmentProperties {
  segmentIndex: number;
  etaIso: string;
  etaLabelJST: string;
  elapsedSeconds: number;
  distanceMeters: number;
  precipitation: number | null;
  status: RouteSegmentStatus;
  severity: RouteRainSeverity;
  color: string;
  isDashed: boolean;
}

export interface RouteWeatherFeature {
  type: 'Feature';
  geometry: {
    type: 'LineString';
    coordinates: [number, number][];
  };
  properties: RouteWeatherSegmentProperties;
}

export interface RouteWeatherFeatureCollection {
  type: 'FeatureCollection';
  features: RouteWeatherFeature[];
}

export interface RouteWeatherAnalysis {
  route: OrsRouteResult;
  departureTime: Date;
  departureOffsetMinutes: number;
  checkpoints: RouteCheckpoint[];
  geojson: RouteWeatherFeatureCollection;
  maxPrecipitation: number | null;
  hasRain: boolean;
  outOfRangeCount: number;
  missingCount: number;
  catalogIsStale: boolean;
  catalogIsPartial: boolean;
  vertexElapsedSeconds?: number[];
}

export type RouteTravelPhase = 'before-departure' | 'in-transit' | 'arrived';

export interface RoutePositionAtTime {
  lng: number;
  lat: number;
  bearing: number;
  phase: RouteTravelPhase;
  elapsedSeconds: number;
  progress: number;
}

const MIN_SEGMENTS = 10;
const MAX_SEGMENTS = 15;
const DEFAULT_MAX_FRAME_DIFF_MS = 60 * 60 * 1000; // 60 minutes

function haversineDistanceFloat(
  lng1: number,
  lat1: number,
  lng2: number,
  lat2: number
): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function formatEtaLabelJST(date: Date): string {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const mm = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(jst.getUTCDate()).padStart(2, '0');
  const hh = String(jst.getUTCHours()).padStart(2, '0');
  const min = String(jst.getUTCMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${min}`;
}

export function getRouteRainStyle(
  precipitation: number | null,
  status: RouteSegmentStatus
): { severity: RouteRainSeverity; color: string; isDashed: boolean } {
  if (status !== 'ok' || precipitation === null || !Number.isFinite(precipitation)) {
    return { severity: 'unknown', color: '#94a3b8', isDashed: true };
  }
  if (precipitation <= 0) {
    return { severity: 'none', color: '#38bdf8', isDashed: false };
  }
  if (precipitation < 5) {
    return { severity: 'weak', color: '#22c55e', isDashed: false };
  }
  if (precipitation < 15) {
    return { severity: 'moderate', color: '#facc15', isDashed: false };
  }
  if (precipitation < 30) {
    return { severity: 'strong', color: '#f97316', isDashed: false };
  }
  return { severity: 'extreme', color: '#ef4444', isDashed: false };
}

function buildVertexElapsedSeconds(
  coords: [number, number][],
  cumDistances: number[],
  route: OrsRouteResult
): number[] {
  const n = coords.length;
  const totalDist = cumDistances[n - 1];
  const fallback = (): number[] => {
    if (totalDist > 0) {
      return cumDistances.map(d => (d / totalDist) * route.durationSeconds);
    }
    return coords.map((_, i) =>
      n > 1 ? (i / (n - 1)) * route.durationSeconds : 0
    );
  };

  if (!route.steps || route.steps.length === 0) {
    return fallback();
  }

  const times = new Array<number>(n).fill(-1);
  times[0] = 0;
  let elapsedSoFar = 0;

  for (const step of route.steps) {
    const [startIdx, endIdx] = step.wayPoints;
    if (startIdx < 0 || endIdx < startIdx || endIdx >= n) {
      return fallback();
    }
    const spanDist = cumDistances[endIdx] - cumDistances[startIdx];
    const spanEdges = endIdx - startIdx;
    for (let idx = startIdx; idx <= endIdx; idx++) {
      let ratio = 0;
      if (spanEdges === 0) {
        ratio = 1;
      } else if (spanDist > 0) {
        ratio = (cumDistances[idx] - cumDistances[startIdx]) / spanDist;
      } else {
        ratio = (idx - startIdx) / spanEdges;
      }
      const candidate = elapsedSoFar + step.duration * ratio;
      times[idx] = Math.max(times[idx], candidate);
    }
    elapsedSoFar += step.duration;
  }

  if (elapsedSoFar <= 0 && route.durationSeconds > 0) {
    return fallback();
  }

  // Fill any unvisited vertices monotonically and scale to summary.duration if needed
  let lastKnown = 0;
  for (let i = 0; i < n; i++) {
    if (times[i] < lastKnown) {
      times[i] = lastKnown;
    } else {
      lastKnown = times[i];
    }
  }

  const finalStepTime = times[n - 1];
  if (finalStepTime > 0 && route.durationSeconds > 0) {
    const scale = route.durationSeconds / finalStepTime;
    return times.map(t => t * scale);
  }
  return fallback();
}

function interpolateAlongPolyline(
  coords: [number, number][],
  cumMetric: number[],
  cumTimes: number[],
  targetMetric: number
): { coord: [number, number]; elapsedSeconds: number; edgeIndex: number } {
  const lastIdx = coords.length - 1;
  if (targetMetric <= cumMetric[0]) {
    return {
      coord: [coords[0][0], coords[0][1]],
      elapsedSeconds: cumTimes[0],
      edgeIndex: 0,
    };
  }
  if (targetMetric >= cumMetric[lastIdx]) {
    return {
      coord: [coords[lastIdx][0], coords[lastIdx][1]],
      elapsedSeconds: cumTimes[lastIdx],
      edgeIndex: Math.max(0, lastIdx - 1),
    };
  }

  // Binary search for edge i where cumMetric[i] <= targetMetric <= cumMetric[i + 1]
  let lo = 0;
  let hi = lastIdx - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cumMetric[mid] <= targetMetric) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  const m0 = cumMetric[lo];
  const m1 = cumMetric[lo + 1];
  const span = m1 - m0;
  const t = span > 0 ? Math.min(1, Math.max(0, (targetMetric - m0) / span)) : 0;

  const lng = coords[lo][0] + (coords[lo + 1][0] - coords[lo][0]) * t;
  const lat = coords[lo][1] + (coords[lo + 1][1] - coords[lo][1]) * t;
  const elapsedSeconds = cumTimes[lo] + (cumTimes[lo + 1] - cumTimes[lo]) * t;

  return { coord: [lng, lat], elapsedSeconds, edgeIndex: lo };
}

function coordsEqual(a: [number, number], b: [number, number]): boolean {
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
}

/**
 * Split a route LineString into 10–15 equal-distance (or equal-vertex if zero-distance) segments.
 */
export function splitRouteIntoSegments(
  route: OrsRouteResult,
  desiredCount?: number
): RouteSegmentSplit[] {
  const coords = route.coordinates;
  if (coords.length < 2) {
    return [];
  }

  const defaultCount =
    route.distanceMeters < 15000 ? 10 : route.distanceMeters < 50000 ? 12 : 15;
  const count = Math.max(
    MIN_SEGMENTS,
    Math.min(MAX_SEGMENTS, Math.round(desiredCount ?? defaultCount))
  );

  const cumDistances: number[] = [0];
  for (let i = 1; i < coords.length; i++) {
    const d = haversineDistanceFloat(
      coords[i - 1][0],
      coords[i - 1][1],
      coords[i][0],
      coords[i][1]
    );
    cumDistances.push(cumDistances[i - 1] + d);
  }

  const cumTimes = buildVertexElapsedSeconds(coords, cumDistances, route);
  const totalHaversine = cumDistances[cumDistances.length - 1];
  const useDistanceMetric = totalHaversine > 0;
  const metric = useDistanceMetric
    ? cumDistances
    : coords.map((_, i) => i);
  const totalMetric = metric[metric.length - 1];
  const displayTotalDistance =
    route.distanceMeters > 0 ? route.distanceMeters : totalHaversine;

  const segments: RouteSegmentSplit[] = [];

  for (let s = 0; s < count; s++) {
    const startM = (totalMetric * s) / count;
    const endM = (totalMetric * (s + 1)) / count;
    const midM = (startM + endM) / 2;

    const startInterp = interpolateAlongPolyline(coords, metric, cumTimes, startM);
    const endInterp = interpolateAlongPolyline(coords, metric, cumTimes, endM);
    const midInterp = interpolateAlongPolyline(coords, metric, cumTimes, midM);

    const segCoords: [number, number][] = [startInterp.coord];
    for (let v = startInterp.edgeIndex + 1; v <= endInterp.edgeIndex; v++) {
      const pt = coords[v];
      if (!coordsEqual(segCoords[segCoords.length - 1], pt)) {
        segCoords.push([pt[0], pt[1]]);
      }
    }
    if (!coordsEqual(segCoords[segCoords.length - 1], endInterp.coord)) {
      segCoords.push(endInterp.coord);
    }
    if (segCoords.length === 1) {
      segCoords.push([endInterp.coord[0], endInterp.coord[1]]);
    }

    const segmentDistanceMeters =
      totalMetric > 0
        ? (displayTotalDistance * (endM - startM)) / totalMetric
        : 0;

    segments.push({
      index: s,
      coordinates: segCoords,
      midPoint: midInterp.coord,
      distanceMeters: segmentDistanceMeters,
      elapsedSeconds: midInterp.elapsedSeconds,
    });
  }

  return segments;
}

/**
 * Find the nearest JMA Nowcast / Short-Range Forecast frame within maxDiffMs.
 */
export function selectNearestJMAFrame(
  eta: Date,
  frames: TimelineFrameItem[],
  maxDiffMs: number = DEFAULT_MAX_FRAME_DIFF_MS
): TimelineFrameItem | null {
  const etaMs = eta.getTime();
  let bestFrame: TimelineFrameItem | null = null;
  let bestDiff = Infinity;

  for (const frame of frames) {
    if (!frame?.basetime || !frame?.validtime) continue;
    const frameMs = frame.date.getTime();
    if (!Number.isFinite(frameMs)) continue;
    const diff = Math.abs(frameMs - etaMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestFrame = frame;
    }
  }

  if (!bestFrame || bestDiff > maxDiffMs) {
    return null;
  }
  return bestFrame;
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  signal: AbortSignal | undefined,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      signal?.throwIfAborted();
      const idx = cursor++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface AnalyzeRouteWeatherOptions {
  route: OrsRouteResult;
  departureTime: Date;
  departureOffsetMinutes: number;
  frames: TimelineFrameItem[];
  catalogIsStale?: boolean;
  catalogIsPartial?: boolean;
  signal?: AbortSignal;
  tileLoader?: (url: string, signal?: AbortSignal) => Promise<Uint8ClampedArray | null>;
}

/**
 * Sample JMA forecast precipitation along 10–15 route checkpoints in parallel
 * and construct a color-coded GeoJSON FeatureCollection for 3D map rendering.
 */
export async function analyzeRouteWeather({
  route,
  departureTime,
  departureOffsetMinutes,
  frames,
  catalogIsStale = false,
  catalogIsPartial = false,
  signal,
  tileLoader = loadTilePixelData,
}: AnalyzeRouteWeatherOptions): Promise<RouteWeatherAnalysis> {
  signal?.throwIfAborted();

  const segments = splitRouteIntoSegments(route);

  interface PreparedSegment {
    segment: RouteSegmentSplit;
    eta: Date;
    etaLabelJST: string;
    frame: TimelineFrameItem | null;
    tileCoords: ReturnType<typeof getJMATileCoordinates>;
    tileUrl: string | null;
  }

  const prepared: PreparedSegment[] = segments.map(segment => {
    const eta = new Date(departureTime.getTime() + segment.elapsedSeconds * 1000);
    const frame = selectNearestJMAFrame(eta, frames);
    const tileCoords = getJMATileCoordinates(segment.midPoint[0], segment.midPoint[1]);
    const tileUrl =
      frame && tileCoords.inBounds
        ? getJMATileUrl(frame, tileCoords.tx, tileCoords.ty)
        : null;
    return {
      segment,
      eta,
      etaLabelJST: formatEtaLabelJST(eta),
      frame,
      tileCoords,
      tileUrl,
    };
  });

  // Deduplicate tile fetches across checkpoints sharing the same (frame, tx, ty)
  const uniqueUrls = [...new Set(prepared.map(p => p.tileUrl).filter((u): u is string => u !== null))];
  const tileBuffers = new Map<string, Uint8ClampedArray | null>();

  if (uniqueUrls.length > 0) {
    await runWithConcurrency(uniqueUrls, 5, signal, async url => {
      signal?.throwIfAborted();
      const buffer = await tileLoader(url, signal);
      tileBuffers.set(url, buffer);
    });
  }

  signal?.throwIfAborted();

  const checkpoints: RouteCheckpoint[] = [];
  const features: RouteWeatherFeature[] = [];
  let maxPrecipitation: number | null = null;
  let hasRain = false;
  let outOfRangeCount = 0;
  let missingCount = 0;

  for (const item of prepared) {
    let status: RouteSegmentStatus;
    let precipitation: number | null = null;

    if (!item.frame || !item.tileCoords.inBounds) {
      status = 'out-of-range';
      outOfRangeCount++;
    } else if (!item.tileUrl) {
      status = 'missing';
      missingCount++;
    } else {
      const buffer = tileBuffers.get(item.tileUrl);
      if (!buffer) {
        status = 'missing';
        missingCount++;
      } else {
        const sampled = sampleJMAPrecipitationFromTile(
          buffer,
          item.tileCoords.px,
          item.tileCoords.py
        );
        if (sampled === null) {
          status = 'missing';
          missingCount++;
        } else {
          status = 'ok';
          precipitation = sampled;
          if (maxPrecipitation === null || sampled > maxPrecipitation) {
            maxPrecipitation = sampled;
          }
          if (sampled > 0) {
            hasRain = true;
          }
        }
      }
    }

    const style = getRouteRainStyle(precipitation, status);
    const checkpoint: RouteCheckpoint = {
      index: item.segment.index,
      lng: item.segment.midPoint[0],
      lat: item.segment.midPoint[1],
      distanceMeters: item.segment.distanceMeters,
      elapsedSeconds: item.segment.elapsedSeconds,
      eta: item.eta,
      etaLabelJST: item.etaLabelJST,
      precipitation,
      status,
      severity: style.severity,
      color: style.color,
      frameLabelJST: item.frame?.labelJST,
      frameRelativeBadge: item.frame?.relativeBadge,
    };
    checkpoints.push(checkpoint);

    features.push({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: item.segment.coordinates,
      },
      properties: {
        segmentIndex: item.segment.index,
        etaIso: item.eta.toISOString(),
        etaLabelJST: item.etaLabelJST,
        elapsedSeconds: item.segment.elapsedSeconds,
        distanceMeters: item.segment.distanceMeters,
        precipitation,
        status,
        severity: style.severity,
        color: style.color,
        isDashed: style.isDashed,
      },
    });
  }

  const vertexElapsedSeconds = computeRouteVertexElapsedSeconds(route);

  return {
    route,
    departureTime,
    departureOffsetMinutes,
    checkpoints,
    geojson: {
      type: 'FeatureCollection',
      features,
    },
    maxPrecipitation,
    hasRain,
    outOfRangeCount,
    missingCount,
    catalogIsStale,
    catalogIsPartial,
    vertexElapsedSeconds,
  };
}

/**
 * Compute cumulative elapsed seconds at each vertex along the route.
 */
export function computeRouteVertexElapsedSeconds(route: OrsRouteResult): number[] {
  const coords = route.coordinates;
  if (coords.length === 0) return [];
  if (coords.length === 1) return [0];

  const cumDistances: number[] = [0];
  for (let i = 1; i < coords.length; i++) {
    const d = haversineDistanceFloat(
      coords[i - 1][0],
      coords[i - 1][1],
      coords[i][0],
      coords[i][1]
    );
    cumDistances.push(cumDistances[i - 1] + d);
  }
  return buildVertexElapsedSeconds(coords, cumDistances, route);
}

function computeBearingDegrees(
  from: [number, number],
  to: [number, number]
): number {
  if (coordsEqual(from, to)) return 0;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const toDeg = (rad: number) => (rad * 180) / Math.PI;
  const lat1 = toRad(from[1]);
  const lat2 = toRad(to[1]);
  const dLng = toRad(to[0] - from[0]);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Interpolate the traveler's [lng, lat] and travel phase along the route for any timestamp.
 */
export function interpolateRoutePositionAtTime(
  analysis: RouteWeatherAnalysis,
  targetTime: Date
): RoutePositionAtTime | null {
  const coords = analysis.route.coordinates;
  const n = coords.length;
  const targetMs = targetTime.getTime();
  const departureMs = analysis.departureTime.getTime();
  if (n < 2 || !Number.isFinite(targetMs) || !Number.isFinite(departureMs)) {
    return null;
  }

  const elapsedSeconds = (targetMs - departureMs) / 1000;
  const totalDuration = analysis.route.durationSeconds;

  if (elapsedSeconds < 0) {
    return {
      lng: coords[0][0],
      lat: coords[0][1],
      bearing: computeBearingDegrees(coords[0], coords[1]),
      phase: 'before-departure',
      elapsedSeconds,
      progress: 0,
    };
  }

  if (totalDuration <= 0 || elapsedSeconds >= totalDuration) {
    return {
      lng: coords[n - 1][0],
      lat: coords[n - 1][1],
      bearing: computeBearingDegrees(coords[n - 2], coords[n - 1]),
      phase: 'arrived',
      elapsedSeconds,
      progress: 1,
    };
  }

  const vertexTimes =
    analysis.vertexElapsedSeconds && analysis.vertexElapsedSeconds.length === n
      ? analysis.vertexElapsedSeconds
      : computeRouteVertexElapsedSeconds(analysis.route);

  const interpolated = interpolateAlongPolyline(
    coords,
    vertexTimes,
    vertexTimes,
    elapsedSeconds
  );
  const edgeIdx = Math.min(n - 2, Math.max(0, interpolated.edgeIndex));

  return {
    lng: interpolated.coord[0],
    lat: interpolated.coord[1],
    bearing: computeBearingDegrees(coords[edgeIdx], coords[edgeIdx + 1]),
    phase: 'in-transit',
    elapsedSeconds,
    progress: Math.min(1, Math.max(0, elapsedSeconds / totalDuration)),
  };
}

/**
 * Compute playback step duration (ms) proportional to real frame time delta
 * when an active route overlaps the [currentFrameTime, nextFrameTime] interval.
 */
export function computeRoutePlaybackStepMs(options: {
  playbackSpeed: 1 | 2;
  currentFrameTime: Date | null;
  nextFrameTime: Date | null;
  routeAnalysis: RouteWeatherAnalysis | null;
  rainSource: 'jma-nowcast' | 'jaxa-gsmap';
}): number {
  const { playbackSpeed, currentFrameTime, nextFrameTime, routeAnalysis, rainSource } =
    options;
  const baseMs = playbackSpeed === 2 ? 500 : 1000;

  if (!routeAnalysis || rainSource !== 'jma-nowcast' || !currentFrameTime || !nextFrameTime) {
    return baseMs;
  }

  const curMs = currentFrameTime.getTime();
  const nextMs = nextFrameTime.getTime();
  const stepMinutes = (nextMs - curMs) / 60000;
  if (!Number.isFinite(stepMinutes) || stepMinutes <= 0) {
    return baseMs;
  }

  const departureMs = routeAnalysis.departureTime.getTime();
  const arrivalMs = departureMs + routeAnalysis.route.durationSeconds * 1000;
  if (
    !Number.isFinite(departureMs) ||
    !Number.isFinite(arrivalMs) ||
    nextMs <= departureMs ||
    curMs >= arrivalMs
  ) {
    return baseMs;
  }

  const minMs = Math.max(250, Math.round(baseMs * 0.4));
  const maxMs = baseMs * 6;
  const scaledMs = Math.round(baseMs * (stepMinutes / 10));
  return Math.min(maxMs, Math.max(minMs, scaledMs));
}
