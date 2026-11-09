// UI/state-transition probes of the real App, with map/SDK/network boundaries mocked.
// R11 initial frame adoption; R12 initial A -> selected B -> late A;
// R13 selected old-source request -> source switch -> late old-source response.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  map: null as any, timeline: null as any, layer: null as any, inspector: null as any, preset: null as any,
  active: null as any, requests: new Map<string, (result: any) => void>(),
  setActive: vi.fn(),
}));
vi.mock('../../src/components/MapViewer', () => ({ MapViewer: (p: any) => { h.map = p; return null; } }));
vi.mock('../../src/components/TimelineBar', () => ({ TimelineBar: (p: any) => { h.timeline = p; return null; } }));
vi.mock('../../src/components/LayerMenu', () => ({ LayerMenu: (p: any) => { h.layer = p; return null; } }));
vi.mock('../../src/components/PresetNav', () => ({ PresetNav: (p: any) => { h.preset = p; return null; } }));
vi.mock('../../src/components/Legend', () => ({ Legend: () => null }));
vi.mock('../../src/components/Inspector', () => ({ Inspector: (p: any) => { h.inspector = p; return null; } }));
vi.mock('../../src/components/ShareButton', () => ({ ShareButton: () => null }));
vi.mock('../../src/components/FavoritesSyncDialog', () => ({ FavoritesSyncDialog: () => null }));
vi.mock('../../src/lib/maplibreHelper', () => ({ PRESET_LOCATIONS: [{ id: 'fixture', name: 'fixture', center: [139, 35], zoom: 10, pitch: 60, bearing: 0, elevation: 1 }] }));
vi.mock('../../src/lib/jmaNowcastClient', () => ({
  getJMAFrameKey: (f: any) => f.validtime,
  fetchJMANowcastCatalog: async () => ({ defaultIndex: 0, frames: ['A', 'B'].map((id, i) => ({ date: new Date(`2026-11-09T0${i}:00:00Z`), labelJST: id, validtime: id, basetime: id })) }),
  fetchJMANowcastRainLayer: (f: any) => new Promise(resolve => h.requests.set(f.validtime, resolve)),
}));
vi.mock('../../src/lib/jaxaClient', () => ({
  preloadCentralMountainElevation: vi.fn(), fetchPointElevationFromAW3D: async () => null,
  inspectLocationValues: () => ({ precipitation: h.active ? 10 : null, elevation: 1 }),
  setActiveRainLayerResult: (result: any) => { h.active = result; h.setActive(result); },
  formatDateToJST: () => 'G',
  fetchGSMaPTimelineCatalog: async () => ({ dates: [new Date('2026-11-09T02:00:00Z')], defaultDisplayDate: new Date('2026-11-09T02:00:00Z') }),
  fetchGSMaPRainLayer: async () => ({ imageUrl: 'G', sourceType: 'jaxa-gsmap', observedAt: new Date('2026-11-09T02:00:00Z'), status: 'success' }),
}));
import App from '../../src/App';
let root: Root;
let container: HTMLDivElement;
const frame = (id: string) => ({ imageUrl: id, sourceType: 'jma-nowcast', observedAt: new Date('2026-11-09T00:00:00Z'), status: 'success' });
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  h.requests.clear(); h.active = null; h.setActive.mockClear();
  localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, '', '/');
  localStorage.setItem('rain3d_favorite_locations_v1', JSON.stringify([
    { id: 'fav-A', name: 'A', center: [139, 35], zoom: 10, pitch: 60, bearing: 0, elevation: 1 },
    { id: 'fav-B', name: 'B', center: [140, 36], zoom: 10, pitch: 60, bearing: 0, elevation: 1 },
  ]));
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(React.createElement(App)); });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it('R11 FIX-05: initial visible frame also becomes the active point-value frame', async () => {
  await act(async () => { h.requests.get('A')!(frame('A')); });
  expect(h.map.rainLayerData.imageUrl).toBe('A');
  expect(h.setActive).toHaveBeenCalledWith(expect.objectContaining({ imageUrl: 'A' }));
});

it('R12 FIX-05: late initial A must not overwrite a user-selected B', async () => {
  let selection: Promise<void>;
  await act(async () => { selection = h.timeline.onSelectIndex(1); });
  await act(async () => { h.requests.get('B')!(frame('B')); await selection; });
  expect(h.map.rainLayerData.imageUrl).toBe('B');
  await act(async () => { h.requests.get('A')!(frame('A')); });
  expect(h.map.rainLayerData.imageUrl).toBe('B');
});

it('R13 FIX-05: late selected JMA B must not overwrite the switched GSMaP source', async () => {
  await act(async () => { h.requests.get('A')!(frame('A')); });
  let selection: Promise<void>;
  await act(async () => { selection = h.timeline.onSelectIndex(1); });
  await act(async () => { h.layer.onChangeRainSource('jaxa-gsmap'); });
  expect(h.map.rainLayerData.imageUrl).toBe('G');
  await act(async () => { h.requests.get('B')!(frame('B')); await selection; });
  expect(h.map.rainLayerData.imageUrl).toBe('G');
});

it('R14 FIX-03: editing A after deleting B must not resurrect B from a stale callback', async () => {
  await act(async () => { h.map.onInspectPoint({ lng: 139, lat: 35, elevation: 1, precipitation: null }); });
  await act(async () => { await h.preset.onRemoveFavorite('fav-B'); });
  expect(h.map.favorites.map((f: any) => f.id)).toEqual(['fav-A']);
  await act(async () => { h.inspector.onSaveFavorite('edited-A'); });
  expect(h.map.favorites.map((f: any) => f.id)).toEqual(['fav-A']);
});
