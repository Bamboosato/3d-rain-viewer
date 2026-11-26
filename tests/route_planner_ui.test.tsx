// Perspectives:
// - UI/Interaction: Toggle button opens panel, Hyakumeizan picker sets endpoint, profile & departure offset
//   buttons update callbacks, map-pick button triggers callback, summary/legend/checkpoints & errors render.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RoutePlanner, type RouteEndpoint } from '../src/components/RoutePlanner';
import type { PresetLocation } from '../src/types/map';
import type { RouteWeatherAnalysis } from '../src/lib/routeWeatherAnalyzer';

const samplePresets: PresetLocation[] = [
  {
    id: 'fuji',
    name: '富士山',
    kana: 'ふじさん',
    region: '山梨県・静岡県',
    emoji: '🗻',
    elevation: 3776,
    center: [138.7274, 35.3606],
    zoom: 9,
    pitch: 60,
    bearing: -20,
    description: '日本最高峰',
  },
  {
    id: 'takao',
    name: '高尾山',
    kana: 'たかおさん',
    region: '東京都',
    emoji: '⛰️',
    elevation: 599,
    center: [139.2436, 35.6253],
    zoom: 12,
    pitch: 55,
    bearing: 0,
    description: '高尾山',
  },
];

const sampleAnalysis: RouteWeatherAnalysis = {
  route: {
    profile: 'driving-car',
    coordinates: [
      [139.7671, 35.6812],
      [138.7274, 35.3606],
    ],
    distanceMeters: 115200,
    durationSeconds: 5400,
    bbox: [138.7274, 35.3606, 139.7671, 35.6812],
    steps: [],
  },
  departureTime: new Date('2026-11-26T07:00:00Z'),
  departureOffsetMinutes: 0,
  checkpoints: [
    {
      index: 0,
      lng: 139.5,
      lat: 35.6,
      distanceMeters: 11520,
      elapsedSeconds: 540,
      eta: new Date('2026-11-26T07:09:00Z'),
      etaLabelJST: '11/26 16:09',
      precipitation: 7.5,
      status: 'ok',
      severity: 'moderate',
      color: '#facc15',
    },
  ],
  geojson: {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [139.7671, 35.6812],
            [138.7274, 35.3606],
          ],
        },
        properties: {
          segmentIndex: 0,
          etaIso: '2026-11-26T07:09:00.000Z',
          etaLabelJST: '11/26 16:09',
          elapsedSeconds: 540,
          distanceMeters: 11520,
          precipitation: 7.5,
          status: 'ok',
          severity: 'moderate',
          color: '#facc15',
          isDashed: false,
        },
      },
    ],
  },
  maxPrecipitation: 7.5,
  hasRain: true,
  outOfRangeCount: 0,
  missingCount: 0,
  catalogIsStale: false,
  catalogIsPartial: false,
};

describe('RoutePlanner コンポーネント', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it('百名山選択・移動手段変更・地図クリック選択・ルート検索ボタンが正しく連動すること', async () => {
    const onChangeOrigin = vi.fn();
    const onChangeProfile = vi.fn();
    const onChangeDepartureOffsetMinutes = vi.fn();
    const onStartMapPick = vi.fn();
    const onRunRouteCheck = vi.fn();

    const dest: RouteEndpoint = {
      lng: 138.7274,
      lat: 35.3606,
      label: '🗻 富士山',
      source: 'hyakumeizan',
    };

    await act(async () => {
      root.render(
        <RoutePlanner
          presets={samplePresets}
          favorites={[]}
          origin={{
            lng: 139.7671,
            lat: 35.6812,
            label: '📍 現在地',
            source: 'geolocation',
          }}
          destination={dest}
          onChangeOrigin={onChangeOrigin}
          onChangeDestination={vi.fn()}
          onSwapEndpoints={vi.fn()}
          profile="driving-car"
          onChangeProfile={onChangeProfile}
          departureOffsetMinutes={0}
          onChangeDepartureOffsetMinutes={onChangeDepartureOffsetMinutes}
          onStartMapPick={onStartMapPick}
          onRunRouteCheck={onRunRouteCheck}
          onClearRoute={vi.fn()}
          analysis={null}
          isLoading={false}
          error={null}
          isOpen={true}
          onToggleOpen={vi.fn()}
        />
      );
    });

    const favBtn = Array.from(host.querySelectorAll('button')).find(b =>
      b.textContent?.trim() === 'お気に入り'
    );
    expect(favBtn?.className).toContain('whitespace-nowrap');
    expect(favBtn?.className).toContain('flex-col');

    // 百名山ピッカーを開いて高尾山を選択
    const mtnButtons = Array.from(host.querySelectorAll('button')).filter(b =>
      b.textContent?.includes('百名山')
    );
    await act(async () => {
      mtnButtons[0].click();
    });
    const takaoBtn = Array.from(host.querySelectorAll('button')).find(b =>
      b.textContent?.includes('高尾山')
    );
    expect(takaoBtn).toBeDefined();
    await act(async () => {
      takaoBtn!.click();
    });
    expect(onChangeOrigin).toHaveBeenCalledWith(
      expect.objectContaining({ label: '⛰️ 高尾山', source: 'hyakumeizan' })
    );

    // 移動手段・出発時刻・地図クリック
    const hikeBtn = Array.from(host.querySelectorAll('button')).find(b =>
      b.textContent?.includes('登山・徒歩')
    );
    await act(async () => {
      hikeBtn!.click();
    });
    expect(onChangeProfile).toHaveBeenCalledWith('foot-hiking');

    const plus3hBtn = Array.from(host.querySelectorAll('button')).find(b =>
      b.textContent?.trim() === '+3h'
    );
    await act(async () => {
      plus3hBtn!.click();
    });
    expect(onChangeDepartureOffsetMinutes).toHaveBeenCalledWith(180);

    const mapPickBtns = Array.from(host.querySelectorAll('button')).filter(b =>
      b.textContent?.trim() === '地図'
    );
    await act(async () => {
      mapPickBtns[1].click();
    });
    expect(onStartMapPick).toHaveBeenCalledWith('destination');

    // チェック実行
    const submitBtn = host.querySelector('#route-check-submit-btn') as HTMLButtonElement;
    await act(async () => {
      submitBtn.click();
    });
    expect(onRunRouteCheck).toHaveBeenCalledTimes(1);
  });

  it('解析サマリーとエラーアラートおよび百名山POINT_NOT_FOUND時の登山・徒歩再検索ボタンを表示できること', async () => {
    const onFocusCheckpoint = vi.fn();
    const onSwitchToHikingAndRetry = vi.fn();

    await act(async () => {
      root.render(
        <RoutePlanner
          presets={samplePresets}
          favorites={[]}
          origin={{ lng: 139.76, lat: 35.68, label: '📍 現在地', source: 'geolocation' }}
          destination={{ lng: 138.72, lat: 35.36, label: '🗻 富士山', source: 'hyakumeizan' }}
          onChangeOrigin={vi.fn()}
          onChangeDestination={vi.fn()}
          onSwapEndpoints={vi.fn()}
          profile="driving-car"
          onChangeProfile={vi.fn()}
          departureOffsetMinutes={0}
          onChangeDepartureOffsetMinutes={vi.fn()}
          onStartMapPick={vi.fn()}
          onRunRouteCheck={vi.fn()}
          onClearRoute={vi.fn()}
          analysis={sampleAnalysis}
          isLoading={false}
          error="指定地点の近くに車・自転車で通行可能な道路が見つかりませんでした。"
          errorCode="POINT_NOT_FOUND"
          onSwitchToHikingAndRetry={onSwitchToHikingAndRetry}
          onFocusCheckpoint={onFocusCheckpoint}
          isOpen={true}
          onToggleOpen={vi.fn()}
        />
      );
    });

    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('通行可能な道路');
    const retryBtn = host.querySelector('#route-switch-hiking-retry-btn') as HTMLButtonElement;
    expect(retryBtn).not.toBeNull();
    await act(async () => {
      retryBtn.click();
    });
    expect(onSwitchToHikingAndRetry).toHaveBeenCalledTimes(1);

    const summary = host.querySelector('#route-weather-summary');
    expect(summary?.textContent).toContain('115 km');
    expect(summary?.textContent).toContain('1時間30分');
    expect(summary?.textContent).toContain('7.5 mm/h');

    const cpBtn = Array.from(summary!.querySelectorAll('button')).find(b =>
      b.textContent?.includes('11/26 16:09')
    );
    await act(async () => {
      cpBtn!.click();
    });
    expect(onFocusCheckpoint).toHaveBeenCalledWith(sampleAnalysis.checkpoints[0]);
  });
});
