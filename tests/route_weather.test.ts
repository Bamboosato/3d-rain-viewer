// Perspectives:
// - Functional: ORS GeoJSON parsing, 10-15 segment splitting, steps-based & fallback ETA, JMA frame selection,
//   color-coded GeoJSON generation using classifyJMAPixel-compatible sampling.
// - Data/Boundary: `member: 'immed'` preservation, +15h out-of-range vs 0 mm/h distinction, out-of-Japan-bounds
//   and tile failure (`null`) never collapsed into 0 mm/h.
// - Performance/Lifecycle: Tile URL deduplication across checkpoints sharing tiles, AbortSignal cancellation.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchRouteFromProxy,
  parseOrsGeoJson,
  RouteClientError,
  type OrsRouteResult,
} from '../src/lib/orsClient';
import {
  analyzeRouteWeather,
  computeRoutePlaybackStepMs,
  getRouteRainStyle,
  interpolateRoutePositionAtTime,
  selectNearestJMAFrame,
  splitRouteIntoSegments,
} from '../src/lib/routeWeatherAnalyzer';
import type { TimelineFrameItem } from '../src/types/map';

const sampleFrames: TimelineFrameItem[] = [
  {
    date: new Date('2026-11-26T07:00:00Z'), // 16:00 JST
    labelJST: '2026-11-26 16:00 JST',
    relativeBadge: '最新実況',
    isForecast: false,
    isLatestObservation: true,
    basetime: '20261126070000',
    validtime: '20261126070000',
    tileDataset: 'hrpns',
    member: 'none',
  },
  {
    date: new Date('2026-11-26T08:00:00Z'), // 17:00 JST
    labelJST: '2026-11-26 17:00 JST',
    relativeBadge: '+60分予報',
    isForecast: true,
    isLatestObservation: false,
    basetime: '20261126070000',
    validtime: '20261126080000',
    tileDataset: 'hrpns',
    member: 'none',
  },
  {
    date: new Date('2026-11-26T10:00:00Z'), // 19:00 JST (rasrf immed)
    labelJST: '2026-11-26 19:00 JST',
    relativeBadge: '+3h予報',
    isForecast: true,
    isLatestObservation: false,
    basetime: '20261126070000',
    validtime: '20261126100000',
    tileDataset: 'rasrf',
    member: 'immed',
  },
];

function makeSampleRoute(): OrsRouteResult {
  // Tokyo -> near Mt. Fuji (~100km, 3600s)
  return {
    profile: 'driving-car',
    coordinates: [
      [139.7671, 35.6812],
      [139.35, 35.55],
      [139.0, 35.45],
      [138.7274, 35.3606],
    ],
    distanceMeters: 100000,
    durationSeconds: 3600,
    bbox: [138.7274, 35.3606, 139.7671, 35.6812],
    steps: [
      { distance: 40000, duration: 900, wayPoints: [0, 1] },
      { distance: 35000, duration: 1500, wayPoints: [1, 2] },
      { distance: 25000, duration: 1200, wayPoints: [2, 3] },
    ],
  };
}

describe('orsClient: GeoJSON パースとエラーハンドリング', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('3次元座標 [lng, lat, elev] を含む ORS GeoJSON を型安全にパースできること', () => {
    const raw = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              [139.7671, 35.6812, 12.5],
              [138.7274, 35.3606, 1450.2],
            ],
          },
          properties: {
            summary: { distance: 98432.1, duration: 5412.4 },
            segments: [
              {
                steps: [{ distance: 98432.1, duration: 5412.4, way_points: [0, 1] }],
              },
            ],
          },
        },
      ],
    };

    const parsed = parseOrsGeoJson('driving-car', raw);
    expect(parsed.coordinates).toEqual([
      [139.7671, 35.6812],
      [138.7274, 35.3606],
    ]);
    expect(parsed.distanceMeters).toBeCloseTo(98432.1);
    expect(parsed.durationSeconds).toBeCloseTo(5412.4);
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.bbox).toEqual([138.7274, 35.3606, 139.7671, 35.6812]);
  });

  it('fetchRouteFromProxy が /api/route を呼び出し 500 エラーを RouteClientError へ変換すること', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: 'サーバーに ORS_API_KEY が設定されていません。',
          code: 'MISSING_API_KEY',
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchRouteFromProxy({
        profile: 'driving-car',
        coordinates: [
          [139.76, 35.68],
          [138.72, 35.36],
        ],
      })
    ).rejects.toMatchObject({
      name: 'RouteClientError',
      code: 'MISSING_API_KEY',
      status: 500,
    });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/route');
  });
});

describe('routeWeatherAnalyzer: 分割・予測フレーム選定・色分け・キャッシュ重複排除', () => {
  it('ルート座標を 10〜15 区間に隙間なく分割し、通過経過時間を算出すること', () => {
    const route = makeSampleRoute();
    const segments = splitRouteIntoSegments(route);
    expect(segments.length).toBeGreaterThanOrEqual(10);
    expect(segments.length).toBeLessThanOrEqual(15);

    // Adjacent segments share exact boundary coordinates
    for (let i = 1; i < segments.length; i++) {
      const prevEnd = segments[i - 1].coordinates[segments[i - 1].coordinates.length - 1];
      const currStart = segments[i].coordinates[0];
      expect(prevEnd[0]).toBeCloseTo(currStart[0], 7);
      expect(prevEnd[1]).toBeCloseTo(currStart[1], 7);
      expect(segments[i].elapsedSeconds).toBeGreaterThan(segments[i - 1].elapsedSeconds);
    }
  });

  it('2頂点のみの短距離ルートでも 10 区間に分割できること', () => {
    const shortRoute: OrsRouteResult = {
      profile: 'foot-hiking',
      coordinates: [
        [139.76, 35.68],
        [139.77, 35.69],
      ],
      distanceMeters: 1400,
      durationSeconds: 1200,
      bbox: [139.76, 35.68, 139.77, 35.69],
      steps: [],
    };
    const segments = splitRouteIntoSegments(shortRoute);
    expect(segments).toHaveLength(10);
    expect(segments[0].elapsedSeconds).toBeCloseTo(60, 0);
    expect(segments[9].elapsedSeconds).toBeCloseTo(1140, 0);
  });

  it('予測上限 (+15h超) を超える ETA は null を返し 0mm/h と誤認しないこと', () => {
    const within = selectNearestJMAFrame(
      new Date('2026-11-26T09:50:00Z'),
      sampleFrames
    );
    expect(within?.validtime).toBe('20261126100000');
    expect(within?.member).toBe('immed');

    const outOfRange = selectNearestJMAFrame(
      new Date('2026-11-26T20:00:00Z'),
      sampleFrames
    );
    expect(outOfRange).toBeNull();
  });

  it('降水強度に応じた正しい色分けと、欠測/範囲外の破線スタイルを返すこと', () => {
    expect(getRouteRainStyle(0, 'ok').color).toBe('#38bdf8');
    expect(getRouteRainStyle(2.5, 'ok').color).toBe('#22c55e');
    expect(getRouteRainStyle(7.5, 'ok').color).toBe('#facc15');
    expect(getRouteRainStyle(25, 'ok').color).toBe('#f97316');
    expect(getRouteRainStyle(40, 'ok').color).toBe('#ef4444');
    expect(getRouteRainStyle(null, 'out-of-range')).toEqual({
      severity: 'unknown',
      color: '#94a3b8',
      isDashed: true,
    });
  });

  it('member: immed URL を保持し、同一タイルの複数チェックポイントでタイル取得を重複排除すること', async () => {
    const route = makeSampleRoute();
    const fetchedUrls: string[] = [];

    // 256x256 RGBA tile where every pixel is JMA yellow-rain (250, 245, 0 -> 25 mm/h)
    const rainTileBuffer = new Uint8ClampedArray(256 * 256 * 4);
    for (let i = 0; i < 256 * 256; i++) {
      const idx = i * 4;
      rainTileBuffer[idx] = 250;
      rainTileBuffer[idx + 1] = 245;
      rainTileBuffer[idx + 2] = 0;
      rainTileBuffer[idx + 3] = 255;
    }

    const analysis = await analyzeRouteWeather({
      route,
      // +3h departure -> hits sampleFrames[2] (rasrf, member: 'immed')
      departureTime: new Date('2026-11-26T09:30:00Z'),
      departureOffsetMinutes: 180,
      frames: sampleFrames,
      tileLoader: async url => {
        fetchedUrls.push(url);
        return rainTileBuffer;
      },
    });

    expect(analysis.checkpoints).toHaveLength(15);
    // 15 checkpoints fall into at most 2 tiles at zoom 6 (tx=56,57 / ty=25) -> far fewer fetches than 15
    expect(fetchedUrls.length).toBeGreaterThanOrEqual(1);
    expect(fetchedUrls.length).toBeLessThanOrEqual(3);
    expect(fetchedUrls.every(u => u.includes('/rasrf/20261126070000/immed/20261126100000/'))).toBe(
      true
    );
    expect(analysis.maxPrecipitation).toBe(25);
    expect(analysis.hasRain).toBe(true);
    expect(analysis.geojson.features).toHaveLength(15);
    expect(analysis.geojson.features[0].properties.color).toBe('#f97316');
  });

  it('日本域外のルートやタイル取得失敗 (null) は無降雨 (0) にせず範囲外/取得不可として扱うこと', async () => {
    const foreignRoute: OrsRouteResult = {
      profile: 'driving-car',
      coordinates: [
        [-0.12, 51.5],
        [-0.1, 51.52],
      ],
      distanceMeters: 2500,
      durationSeconds: 300,
      bbox: [-0.12, 51.5, -0.1, 51.52],
      steps: [],
    };
    const tileLoader = vi.fn(async () => new Uint8ClampedArray(256 * 256 * 4));
    const foreignAnalysis = await analyzeRouteWeather({
      route: foreignRoute,
      departureTime: new Date('2026-11-26T07:00:00Z'),
      departureOffsetMinutes: 0,
      frames: sampleFrames,
      tileLoader,
    });
    expect(tileLoader).not.toHaveBeenCalled();
    expect(foreignAnalysis.outOfRangeCount).toBe(10);
    expect(foreignAnalysis.maxPrecipitation).toBeNull();
    expect(foreignAnalysis.geojson.features[0].properties.isDashed).toBe(true);

    const jpAnalysisMissing = await analyzeRouteWeather({
      route: makeSampleRoute(),
      departureTime: new Date('2026-11-26T07:00:00Z'),
      departureOffsetMinutes: 0,
      frames: sampleFrames,
      tileLoader: async () => null,
    });
    expect(jpAnalysisMissing.missingCount).toBe(15);
    expect(jpAnalysisMissing.maxPrecipitation).toBeNull();
  });

  it('AbortSignal が中断された場合は即座にキャンセルすること', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      analyzeRouteWeather({
        route: makeSampleRoute(),
        departureTime: new Date('2026-11-26T07:00:00Z'),
        departureOffsetMinutes: 0,
        frames: sampleFrames,
        signal: controller.signal,
      })
    ).rejects.toThrow();
  });

  it('interpolateRoutePositionAtTime が steps の速度差・出発前・到着後・0秒境界を正しく補間すること', async () => {
    const route = makeSampleRoute();
    // steps: [0->1: 900s], [1->2: 1500s], [2->3: 1200s], total=3600s
    const analysis = await analyzeRouteWeather({
      route,
      departureTime: new Date('2026-11-26T07:00:00Z'),
      departureOffsetMinutes: 0,
      frames: sampleFrames,
      tileLoader: async () => new Uint8ClampedArray(256 * 256 * 4),
    });

    // Before departure
    const before = interpolateRoutePositionAtTime(
      analysis,
      new Date('2026-11-26T06:50:00Z')
    );
    expect(before?.phase).toBe('before-departure');
    expect(before?.lng).toBeCloseTo(139.7671, 6);
    expect(before?.lat).toBeCloseTo(35.6812, 6);
    expect(before?.progress).toBe(0);

    // At 900s (+15min): exact vertex 1 ([139.35, 35.55]) per steps duration
    const atVertex1 = interpolateRoutePositionAtTime(
      analysis,
      new Date('2026-11-26T07:15:00Z')
    );
    expect(atVertex1?.phase).toBe('in-transit');
    expect(atVertex1?.lng).toBeCloseTo(139.35, 4);
    expect(atVertex1?.lat).toBeCloseTo(35.55, 4);
    expect(atVertex1?.bearing).toBeGreaterThanOrEqual(0);
    expect(atVertex1?.bearing).toBeLessThan(360);

    // Without steps: distance-proportional fallback
    const noStepsAnalysis = await analyzeRouteWeather({
      route: { ...route, steps: [] },
      departureTime: new Date('2026-11-26T07:00:00Z'),
      departureOffsetMinutes: 0,
      frames: sampleFrames,
      tileLoader: async () => new Uint8ClampedArray(256 * 256 * 4),
    });
    const halfNoSteps = interpolateRoutePositionAtTime(
      noStepsAnalysis,
      new Date('2026-11-26T07:30:00Z')
    );
    expect(halfNoSteps?.phase).toBe('in-transit');
    expect(halfNoSteps?.progress).toBeCloseTo(0.5, 4);

    // After arrival
    const arrived = interpolateRoutePositionAtTime(
      analysis,
      new Date('2026-11-26T08:30:00Z')
    );
    expect(arrived?.phase).toBe('arrived');
    expect(arrived?.lng).toBeCloseTo(138.7274, 6);
    expect(arrived?.lat).toBeCloseTo(35.3606, 6);
    expect(arrived?.progress).toBe(1);

    // Zero duration edge case
    const zeroDur = interpolateRoutePositionAtTime(
      { ...analysis, route: { ...route, durationSeconds: 0 }, vertexElapsedSeconds: undefined },
      new Date('2026-11-26T07:00:00Z')
    );
    expect(zeroDur?.phase).toBe('arrived');
    expect(Number.isFinite(zeroDur?.lng)).toBe(true);
  });

  it('computeRoutePlaybackStepMs がルート移動中のコマ幅に応じて再生時間を比例スケーリングすること', async () => {
    const route = { ...makeSampleRoute(), durationSeconds: 10800 }; // 3h
    const departure = new Date('2026-11-26T07:00:00Z');
    const analysis = await analyzeRouteWeather({
      route,
      departureTime: departure,
      departureOffsetMinutes: 0,
      frames: sampleFrames,
      tileLoader: async () => new Uint8ClampedArray(256 * 256 * 4),
    });

    // ルートなし / GSMaP 時は既定値
    expect(
      computeRoutePlaybackStepMs({
        playbackSpeed: 1,
        currentFrameTime: departure,
        nextFrameTime: new Date('2026-11-26T08:00:00Z'),
        routeAnalysis: null,
        rainSource: 'jma-nowcast',
      })
    ).toBe(1000);
    expect(
      computeRoutePlaybackStepMs({
        playbackSpeed: 2,
        currentFrameTime: departure,
        nextFrameTime: new Date('2026-11-26T08:00:00Z'),
        routeAnalysis: analysis,
        rainSource: 'jaxa-gsmap',
      })
    ).toBe(500);

    // 移動中: 10分 / 30分 / 60分コマ
    expect(
      computeRoutePlaybackStepMs({
        playbackSpeed: 1,
        currentFrameTime: new Date('2026-11-26T07:00:00Z'),
        nextFrameTime: new Date('2026-11-26T07:10:00Z'),
        routeAnalysis: analysis,
        rainSource: 'jma-nowcast',
      })
    ).toBe(1000);
    expect(
      computeRoutePlaybackStepMs({
        playbackSpeed: 1,
        currentFrameTime: new Date('2026-11-26T08:00:00Z'),
        nextFrameTime: new Date('2026-11-26T08:30:00Z'),
        routeAnalysis: analysis,
        rainSource: 'jma-nowcast',
      })
    ).toBe(3000);
    expect(
      computeRoutePlaybackStepMs({
        playbackSpeed: 1,
        currentFrameTime: new Date('2026-11-26T08:30:00Z'),
        nextFrameTime: new Date('2026-11-26T09:30:00Z'),
        routeAnalysis: analysis,
        rainSource: 'jma-nowcast',
      })
    ).toBe(6000);
    expect(
      computeRoutePlaybackStepMs({
        playbackSpeed: 2,
        currentFrameTime: new Date('2026-11-26T08:30:00Z'),
        nextFrameTime: new Date('2026-11-26T09:30:00Z'),
        routeAnalysis: analysis,
        rainSource: 'jma-nowcast',
      })
    ).toBe(3000);

    // 極端な間隔のクランプ (2分 -> 400ms / 250ms, 120分 -> 6000ms)
    expect(
      computeRoutePlaybackStepMs({
        playbackSpeed: 1,
        currentFrameTime: new Date('2026-11-26T07:00:00Z'),
        nextFrameTime: new Date('2026-11-26T07:02:00Z'),
        routeAnalysis: analysis,
        rainSource: 'jma-nowcast',
      })
    ).toBe(400);
    expect(
      computeRoutePlaybackStepMs({
        playbackSpeed: 2,
        currentFrameTime: new Date('2026-11-26T07:00:00Z'),
        nextFrameTime: new Date('2026-11-26T07:02:00Z'),
        routeAnalysis: analysis,
        rainSource: 'jma-nowcast',
      })
    ).toBe(250);
    expect(
      computeRoutePlaybackStepMs({
        playbackSpeed: 1,
        currentFrameTime: new Date('2026-11-26T07:00:00Z'),
        nextFrameTime: new Date('2026-11-26T09:00:00Z'),
        routeAnalysis: analysis,
        rainSource: 'jma-nowcast',
      })
    ).toBe(6000);

    // 出発前・到着後は既定値 (1000ms) に戻る
    expect(
      computeRoutePlaybackStepMs({
        playbackSpeed: 1,
        currentFrameTime: new Date('2026-11-26T05:00:00Z'),
        nextFrameTime: new Date('2026-11-26T06:00:00Z'),
        routeAnalysis: analysis,
        rainSource: 'jma-nowcast',
      })
    ).toBe(1000);
    expect(
      computeRoutePlaybackStepMs({
        playbackSpeed: 1,
        currentFrameTime: new Date('2026-11-26T10:00:00Z'),
        nextFrameTime: new Date('2026-11-26T11:00:00Z'),
        routeAnalysis: analysis,
        rainSource: 'jma-nowcast',
      })
    ).toBe(1000);
  });
});
