// Perspectives:
// - UI/Lifecycle: MapViewer renders profile-specific traveling marker along route for before-departure,
//   in-transit, and arrived phases; removes marker when routeAnalysis or timelineCurrentTime is null.
// - Animation/Interpolation: During playback (isTimelinePlaying + timelineNextTime), rAF smoothly
//   interpolates marker coordinates between frames and cancels rAF on unmount.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RouteWeatherAnalysis } from '../src/lib/routeWeatherAnalyzer';

const mocks = vi.hoisted(() => ({
  markers: [] as Array<{
    element: HTMLElement;
    lngLat: [number, number] | null;
    removed: boolean;
    setLngLat: ReturnType<typeof vi.fn>;
    addTo: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  }>,
  map: null as any,
}));

vi.mock('../src/lib/maplibreHelper', () => ({
  registerJaxaTerrainProtocol: () => {},
  initGraphicsBackend: async () => ({
    backend: 'webgl2',
    webgpuAvailable: false,
    adapterInfo: 'fixture',
  }),
  createMapInstance: () => mocks.map,
}));

vi.mock('maplibre-gl', () => {
  class MockMarker {
    element: HTMLElement;
    lngLat: [number, number] | null = null;
    removed = false;
    setLngLat = vi.fn((pos: [number, number]) => {
      this.lngLat = pos;
      return this;
    });
    addTo = vi.fn(() => {
      document.body.appendChild(this.element);
      return this;
    });
    remove = vi.fn(() => {
      this.removed = true;
      this.element.remove();
    });
    constructor(opts: { element: HTMLElement }) {
      this.element = opts.element;
      mocks.markers.push(this as any);
    }
  }
  return {
    NavigationControl: class {},
    ScaleControl: class {},
    Marker: MockMarker,
  };
});

vi.mock('../src/lib/jaxaClient', () => ({
  JAPAN_RAIN_COORDINATES: [],
  fetchPointElevationFromAW3D: async () => null,
  inspectLocationValues: () => ({ precipitation: null, elevation: null }),
}));

import { MapViewer } from '../src/components/MapViewer';

const sampleAnalysis: RouteWeatherAnalysis = {
  route: {
    profile: 'driving-car',
    coordinates: [
      [139.0, 35.0],
      [140.0, 36.0],
    ],
    distanceMeters: 100000,
    durationSeconds: 3600,
    bbox: [139.0, 35.0, 140.0, 36.0],
    steps: [],
  },
  departureTime: new Date('2026-11-26T07:00:00Z'),
  departureOffsetMinutes: 0,
  checkpoints: [],
  geojson: { type: 'FeatureCollection', features: [] },
  maxPrecipitation: 0,
  hasRain: false,
  outOfRangeCount: 0,
  missingCount: 0,
  catalogIsStale: false,
  catalogIsPartial: false,
  vertexElapsedSeconds: [0, 3600],
};

describe('MapViewer タイムライン連動・ルート上移動マーカー', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.markers = [];
    const handlers = new Map<string, Set<Function>>();
    const sources = new Map();
    const layers = new Map();
    mocks.map = {
      on: (name: string, fn: Function) => {
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name)!.add(fn);
      },
      once: (name: string, fn: Function) => mocks.map.on(name, fn),
      off: (name: string, fn: Function) => handlers.get(name)?.delete(fn),
      getZoom: () => 10,
      getMinZoom: () => 4,
      getMaxZoom: () => 15,
      unproject: (pt: [number, number]) => ({ lng: 139.5 + pt[0] * 0.001, lat: 35.5 - pt[1] * 0.001 }),
      zoomTo: vi.fn(),
      getSource: (k: string) => sources.get(k),
      getLayer: (k: string) => layers.get(k),
      addSource: (k: string, v: any) => sources.set(k, v),
      addLayer: (v: any) => layers.set(v.id, v),
      removeLayer: (k: string) => layers.delete(k),
      removeSource: (k: string) => sources.delete(k),
      moveLayer: () => {},
      fitBounds: () => {},
      addControl: () => {},
      setTerrain: () => {},
      remove: () => {},
      getCenter: () => ({ lat: 35.5, lng: 139.5 }),
      getPitch: () => 60,
      getBearing: () => 0,
      getCanvas: () => ({ style: { cursor: '' } }),
      areTilesLoaded: () => true,
      resize: () => {},
      setPaintProperty: () => {},
      flyTo: () => {},
      _emit: (name: string) => {
        for (const fn of [...(handlers.get(name) ?? [])]) fn();
      },
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    vi.restoreAllMocks();
  });

  const baseProps: any = {
    activePreset: { id: 'fixture', center: [139.5, 35.5], zoom: 10, pitch: 60, bearing: 0 },
    favorites: [],
    exaggeration: 1,
    rainOpacity: 0.7,
    baseMap: 'osm',
    rainLayerData: null,
    inspectedPoint: null,
    skipInitialGeolocation: true,
    onStatusChange: () => {},
    onInspectPoint: () => {},
  };

  it('出発前・移動中・到着の各フェーズと GSMaP(null時刻) 時の非表示が正しく動作すること', async () => {
    await act(async () => {
      root.render(
        <MapViewer
          {...baseProps}
          routeAnalysis={sampleAnalysis}
          timelineCurrentTime={new Date('2026-11-26T06:50:00Z')}
        />
      );
    });
    await act(async () => {
      mocks.map._emit('load');
    });

    const el = () => document.querySelector('[data-testid="route-travel-marker"]') as HTMLElement | null;
    expect(el()).not.toBeNull();
    expect(el()?.dataset.profile).toBe('driving-car');
    expect(el()?.dataset.phase).toBe('before-departure');
    expect(mocks.markers[0].lngLat).toEqual([139.0, 35.0]);

    // +30分 (半分移動)
    await act(async () => {
      root.render(
        <MapViewer
          {...baseProps}
          routeAnalysis={sampleAnalysis}
          timelineCurrentTime={new Date('2026-11-26T07:30:00Z')}
        />
      );
    });
    expect(el()?.dataset.phase).toBe('in-transit');
    expect(mocks.markers[0].lngLat?.[0]).toBeCloseTo(139.5, 5);
    expect(mocks.markers[0].lngLat?.[1]).toBeCloseTo(35.5, 5);

    // +90分 (到着済み)
    await act(async () => {
      root.render(
        <MapViewer
          {...baseProps}
          routeAnalysis={sampleAnalysis}
          timelineCurrentTime={new Date('2026-11-26T08:30:00Z')}
        />
      );
    });
    expect(el()?.dataset.phase).toBe('arrived');
    expect(mocks.markers[0].lngLat).toEqual([140.0, 36.0]);

    // timelineCurrentTime=null (GSMaP等) でマーカーを削除
    await act(async () => {
      root.render(
        <MapViewer
          {...baseProps}
          routeAnalysis={sampleAnalysis}
          timelineCurrentTime={null}
        />
      );
    });
    expect(el()).toBeNull();
    expect(mocks.markers[0].removed).toBe(true);
  });

  it('タイムライン再生中は requestAnimationFrame で次フレーム時刻まで滑らかに補間移動すること', async () => {
    let perfNow = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => perfNow);
    const rafCallbacks = new Map<number, FrameRequestCallback>();
    let nextRafId = 1;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = nextRafId++;
      rafCallbacks.set(id, cb);
      return id;
    });
    const cancelSpy = vi.fn((id: number) => {
      rafCallbacks.delete(id);
    });
    vi.stubGlobal('cancelAnimationFrame', cancelSpy);

    await act(async () => {
      root.render(
        <MapViewer
          {...baseProps}
          routeAnalysis={sampleAnalysis}
          timelineCurrentTime={new Date('2026-11-26T07:00:00Z')}
          timelineNextTime={new Date('2026-11-26T07:30:00Z')}
          isTimelinePlaying={true}
          isRainLoading={false}
          timelineIntervalMs={1000}
        />
      );
    });
    await act(async () => {
      mocks.map._emit('load');
    });

    const travelMarker = mocks.markers.find(
      m => m.element.dataset.testid === 'route-travel-marker'
    )!;
    expect(travelMarker).toBeDefined();
    expect(travelMarker.lngLat).toEqual([139.0, 35.0]);

    // Advance 500ms of 1000ms interval -> halfway between 07:00 (0%) and 07:30 (50%) = 25% of route
    perfNow = 1500;
    const pending = [...rafCallbacks.values()];
    const targetCb = pending[pending.length - 1];
    await act(async () => {
      targetCb(1500);
    });

    expect(travelMarker.lngLat?.[0]).toBeCloseTo(139.25, 4);
    expect(travelMarker.lngLat?.[1]).toBeCloseTo(35.25, 4);
    vi.unstubAllGlobals();
  });

  it('パネル上の Ctrl+ホイール および スマホ2本指ピンチでブラウザ拡大を抑止し地図ズームへ転送すること', async () => {
    await act(async () => {
      root.render(<MapViewer {...baseProps} />);
    });
    await act(async () => {
      mocks.map._emit('load');
    });

    const panel = document.createElement('div');
    panel.id = 'route-planner-panel';
    document.body.appendChild(panel);

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);

    const mapEl = document.getElementById('map')!;

    const makeWheel = (opts: { ctrlKey: boolean; deltaY: number; clientX?: number; clientY?: number }) => {
      const ev = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: opts.deltaY,
      });
      Object.defineProperties(ev, {
        ctrlKey: { value: opts.ctrlKey },
        clientX: { value: opts.clientX ?? 200 },
        clientY: { value: opts.clientY ?? 200 },
      });
      return ev;
    };

    try {
      // 1. 通常ホイール（Ctrlなし）はブラウザ/パネル標準スクロールを妨げない
      const normalWheel = makeWheel({ ctrlKey: false, deltaY: -120 });
      panel.dispatchEvent(normalWheel);
      expect(normalWheel.defaultPrevented).toBe(false);
      expect(mocks.map.zoomTo).not.toHaveBeenCalled();

      // 2. パネル上の Ctrl+ホイール（上回転 = ズームイン）
      const zoomInWheel = makeWheel({ ctrlKey: true, deltaY: -120, clientX: 200, clientY: 200 });
      panel.dispatchEvent(zoomInWheel);
      expect(zoomInWheel.defaultPrevented).toBe(true);
      expect(mocks.map.zoomTo).toHaveBeenCalledTimes(1);
      expect(mocks.map.zoomTo.mock.calls[0][0]).toBeGreaterThan(10);

      // 3. パネル上の Ctrl+ホイール（下回転 = ズームアウト）
      mocks.map.zoomTo.mockClear();
      const zoomOutWheel = makeWheel({ ctrlKey: true, deltaY: 120, clientX: 200, clientY: 200 });
      panel.dispatchEvent(zoomOutWheel);
      expect(zoomOutWheel.defaultPrevented).toBe(true);
      expect(mocks.map.zoomTo).toHaveBeenCalledTimes(1);
      expect(mocks.map.zoomTo.mock.calls[0][0]).toBeLessThan(10);

      // 4. 地図要素(#map)上での Ctrl+ホイールは MapLibre 本体に任せ、二重ズームしない
      mocks.map.zoomTo.mockClear();
      const mapWheel = makeWheel({ ctrlKey: true, deltaY: -120 });
      mapEl.dispatchEvent(mapWheel);
      expect(mocks.map.zoomTo).not.toHaveBeenCalled();

      // 5. モーダル([role="dialog"])上での Ctrl+ホイールはページ拡大を抑止しつつ地図は動かさない
      const dialogWheel = makeWheel({ ctrlKey: true, deltaY: -120 });
      dialog.dispatchEvent(dialogWheel);
      expect(dialogWheel.defaultPrevented).toBe(true);
      expect(mocks.map.zoomTo).not.toHaveBeenCalled();

      // 6. パネル上の1本指タッチ移動は preventDefault しない（通常スクロール維持）
      const singleTouchMove = new Event('touchmove', { bubbles: true, cancelable: true }) as any;
      singleTouchMove.touches = [{ target: panel, clientX: 100, clientY: 100 }];
      panel.dispatchEvent(singleTouchMove);
      expect(singleTouchMove.defaultPrevented).toBe(false);

      // 7. パネル上の2本指ピンチアウト -> preventDefault & zoomTo(>10)
      const pinchStart = new Event('touchstart', { bubbles: true, cancelable: true }) as any;
      pinchStart.touches = [
        { target: panel, clientX: 100, clientY: 200 },
        { target: panel, clientX: 200, clientY: 200 },
      ];
      panel.dispatchEvent(pinchStart);
      expect(pinchStart.defaultPrevented).toBe(true);

      const pinchOutMove = new Event('touchmove', { bubbles: true, cancelable: true }) as any;
      pinchOutMove.touches = [
        { target: panel, clientX: 50, clientY: 200 },
        { target: panel, clientX: 250, clientY: 200 },
      ];
      panel.dispatchEvent(pinchOutMove);
      expect(pinchOutMove.defaultPrevented).toBe(true);
      expect(mocks.map.zoomTo).toHaveBeenCalledTimes(1);
      expect(mocks.map.zoomTo.mock.calls[0][0]).toBeGreaterThan(10);

      // 8. 2本指ピンチイン -> zoomTo(<10)
      mocks.map.zoomTo.mockClear();
      const pinchInMove = new Event('touchmove', { bubbles: true, cancelable: true }) as any;
      pinchInMove.touches = [
        { target: panel, clientX: 125, clientY: 200 },
        { target: panel, clientX: 175, clientY: 200 },
      ];
      panel.dispatchEvent(pinchInMove);
      expect(pinchInMove.defaultPrevented).toBe(true);
      expect(mocks.map.zoomTo).toHaveBeenCalledTimes(1);
      expect(mocks.map.zoomTo.mock.calls[0][0]).toBeLessThan(10);

      // 9. iOS Safari gesturestart も地図外では抑止する
      const gestureEvt = new Event('gesturestart', { bubbles: true, cancelable: true });
      panel.dispatchEvent(gestureEvt);
      expect(gestureEvt.defaultPrevented).toBe(true);
    } finally {
      panel.remove();
      dialog.remove();
    }
  });
});
