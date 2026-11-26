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
});
