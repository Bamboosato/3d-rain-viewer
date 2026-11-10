// Real App; external map/weather boundaries mocked. Tests cover persistence reload,
// overlapping requests, partial retry and lifecycle refresh, not copied production logic.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { WeatherRequestError } from '../../src/lib/weatherRequests';
const h = vi.hoisted(() => ({ map: null as any, timeline: null as any, layer: null as any,
  requests: new Map<string, {resolve: (x:any)=>void, reject:(x:any)=>void}>(),
  catalogCalls: 0, frameCalls: [] as string[], active: null as any,
  frameIds: ['A','B'],
}));
vi.mock('../../src/components/MapViewer', () => ({ MapViewer: (p:any) => { h.map=p; return null; } }));
vi.mock('../../src/components/TimelineBar', () => ({ TimelineBar: (p:any) => { h.timeline=p; return null; } }));
vi.mock('../../src/components/LayerMenu', () => ({ LayerMenu: (p:any) => { h.layer=p; return null; } }));
vi.mock('../../src/components/PresetNav', () => ({ PresetNav: () => null }));
vi.mock('../../src/components/Inspector', () => ({ Inspector: () => null }));
vi.mock('../../src/components/Legend', () => ({ Legend: () => null }));
vi.mock('../../src/components/ShareButton', () => ({ ShareButton: () => null }));
vi.mock('../../src/components/FavoritesSyncDialog', () => ({ FavoritesSyncDialog: () => null }));
vi.mock('../../src/lib/maplibreHelper', () => ({ PRESET_LOCATIONS:[{id:'fixture',name:'fixture',center:[139,35],zoom:10,pitch:60,bearing:0,elevation:1}] }));
vi.mock('../../src/lib/jmaNowcastClient', () => ({
  getJMAFrameKey:(f:any)=>f.validtime,
  fetchJMANowcastCatalog:async()=>{h.catalogCalls++; return {defaultIndex:0, frames:h.frameIds.map((id,i)=>({date:new Date(`2026-11-09T0${i}:00:00Z`),labelJST:id,basetime:id,validtime:id}))};},
  fetchJMANowcastRainLayer:(f:any)=>{h.frameCalls.push(f.validtime);return new Promise((resolve,reject)=>h.requests.set(f.validtime,{resolve,reject}));},
}));
vi.mock('../../src/lib/jaxaClient', () => ({
  preloadCentralMountainElevation:()=>{},fetchPointElevationFromAW3D:async()=>null,
  inspectLocationValues:()=>({precipitation:h.active?10:null,elevation:1}),
  setActiveRainLayerResult:(r:any)=>{h.active=r;},formatDateToJST:()=> 'G',
  fetchGSMaPTimelineCatalog:async()=>({dates:[],defaultDisplayDate:new Date()}),
  fetchGSMaPRainLayer:async()=>null,
}));
import App from '../../src/App';
import * as storage from '../../src/lib/favoritesStorage';
const loc=(id:string)=>({id,name:id,center:[139,35] as [number,number],zoom:10,pitch:60,bearing:0,elevation:1,region:'fixture',emoji:'*',description:'fixture'});
const frame=(id:string,status='success')=>({imageUrl:id,sourceType:'jma-nowcast',observedAt:new Date('2026-11-09T00:00:00Z'),status,missingTilesCount:status==='partial'?1:0});
let root:Root|undefined; let container:HTMLDivElement;
async function mount(){container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);await act(async()=>root!.render(React.createElement(App)));}
beforeEach(()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  vi.stubGlobal('indexedDB',undefined);localStorage.clear();sessionStorage.clear();storage.resetFavoritesMemoryCacheForTesting();
  window.history.replaceState(null,'','/');h.requests.clear();h.frameCalls=[];h.catalogCalls=0;h.active=null;h.frameIds=['A','B'];
});
afterEach(async()=>{if(root){await act(async()=>root!.unmount());container.remove();root=undefined;}vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});

function fakeIdb(values:Map<string,any>){return {open:()=>{const req:any={};queueMicrotask(()=>{
  req.result={transaction:()=>{const tx:any={objectStore:()=>({delete:(key:string)=>values.delete(key),put:(value:any,key:string)=>values.set(key,structuredClone(value)),get:(key:string)=>{const r:any={};queueMicrotask(()=>{r.result=structuredClone(values.get(key));r.onsuccess?.();});return r;}})};queueMicrotask(()=>tx.oncomplete?.());return tx;}};
  req.onsuccess?.();});return req;}};}

it('A01 ADD-02: successful IDB-only delete-all must remain empty after App restart',async()=>{
  localStorage.setItem('rain3d_favorite_locations_v1',JSON.stringify([loc('old')]));
  vi.stubGlobal('indexedDB',fakeIdb(new Map()));
  const spy=vi.spyOn(localStorage,'setItem').mockImplementation(()=>{throw new DOMException('quota','QuotaExceededError');});
  expect((await storage.saveFavoriteLocations([])).success).toBe(true);spy.mockRestore();
  storage.resetFavoritesMemoryCacheForTesting();await mount();
  expect(h.map.favorites.map((x:any)=>x.id)).toEqual([]);
});

it('A02 ADD-02: successful IDB-only edit must override an old nonempty localStorage copy',async()=>{
  localStorage.setItem('rain3d_favorite_locations_v1',JSON.stringify([loc('old')]));
  vi.stubGlobal('indexedDB',fakeIdb(new Map()));
  const spy=vi.spyOn(localStorage,'setItem').mockImplementation(()=>{throw new DOMException('quota','QuotaExceededError');});
  expect((await storage.saveFavoriteLocations([loc('new')])).success).toBe(true);spy.mockRestore();
  storage.resetFavoritesMemoryCacheForTesting();await mount();
  expect(h.map.favorites.map((x:any)=>x.id)).toEqual(['new']);
});

it('A03 ADD-04: failed initial A must not end the loading state of pending selected B',async()=>{
  await mount();let selection:Promise<void>;
  await act(async()=>{selection=h.timeline.onSelectIndex(1);});
  expect(h.timeline.isLoading).toBe(true);
  vi.spyOn(console,'error').mockImplementation(()=>{});
  await act(async()=>h.requests.get('A')!.reject(new Error('initial fixture failure')));
  const loading=h.timeline.isLoading;
  await act(async()=>{h.requests.get('B')!.resolve(frame('B'));await selection;});
  expect(loading).toBe(true);
});

it('A04 ADD-05: reselecting a partial frame must issue a recovery request',async()=>{
  await mount();await act(async()=>h.requests.get('A')!.resolve(frame('A','partial')));
  await act(async()=>{void h.timeline.onSelectIndex(0);});
  expect(h.frameCalls.filter(x=>x==='A')).toHaveLength(2);
});

it('A05 ADD-07: expiry and online/foreground events trigger catalog refresh',async()=>{
  vi.useFakeTimers();await mount();await act(async()=>h.requests.get('A')!.resolve(frame('A')));
  await act(async()=>{await vi.advanceTimersByTimeAsync(6*60*1000);window.dispatchEvent(new Event('online'));document.dispatchEvent(new Event('visibilitychange'));});
  expect(h.catalogCalls).toBeGreaterThan(1);
});

it('T10 failed frame is actually requested again after retry',async()=>{
 await mount();vi.spyOn(console,'error').mockImplementation(()=>{});
 await act(async()=>h.requests.get('A')!.reject(new Error('fixture failure')));
 let retry:Promise<void>;
 await act(async()=>{retry=h.timeline.onSelectIndex(0);});
 expect(h.frameCalls.filter(key=>key==='A')).toHaveLength(2);
 await act(async()=>{h.requests.get('A')!.resolve(frame('A'));await retry;});
 expect(h.map.rainLayerData.imageUrl).toBe('A');expect(h.timeline.isLoading).toBe(false);
});

it('FORECAST a burst starts the latest frame without waiting for cancelled providers',async()=>{
 h.frameIds=['A','B','C','D','E','F','G','H'];await mount();
 const old=h.requests.get('A')!;const selections:Promise<void>[]=[];
 await act(async()=>{for(let i=1;i<8;i++)selections.push(h.timeline.onSelectIndex(i));});
 expect(h.frameCalls).toEqual(['A','H']);
 await act(async()=>{h.requests.get('H')!.resolve(frame('H'));await Promise.all(selections);});
 await act(async()=>old.resolve(frame('A')));
 expect(h.map.rainLayerData.imageUrl).toBe('H');expect(h.timeline.isWaiting).toBe(false);
});

it('FORECAST promoted prefetch refreshes a missing catalog once, without looping the unchanged URL',async()=>{
 await mount();await act(async()=>h.requests.get('A')!.resolve(frame('A')));
 let selection!:Promise<void>;
 await act(async()=>{selection=h.timeline.onSelectIndex(1);});
 await act(async()=>{h.requests.get('B')!.reject(new WeatherRequestError('http',404));await selection;});
 expect(h.catalogCalls).toBe(2);expect(h.frameCalls.filter(x=>x==='B')).toHaveLength(1);
 expect(h.map.rainLayerData.imageUrl).toBe('A');expect(h.timeline.isWaiting).toBe(true);
 expect(container.textContent).not.toMatch(/選択時刻の取得に失敗|雨雲データを取得できません/);
 const count=h.frameCalls.length;
 await act(async()=>h.timeline.onSelectIndex(0));expect(h.frameCalls).toHaveLength(count);
});
