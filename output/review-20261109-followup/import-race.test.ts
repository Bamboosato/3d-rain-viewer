// Real App + FavoritesSyncDialog + favoritesStorage. Only map/weather/IDB API are fixtures.
// Intent: normal save in progress, incoming sync URL, import commits before normal save.
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({map:null as any,inspector:null as any}));
vi.mock('../../src/components/MapViewer',()=>({MapViewer:(p:any)=>{h.map=p;return null;}}));
vi.mock('../../src/components/Inspector',()=>({Inspector:(p:any)=>{h.inspector=p;return null;}}));
vi.mock('../../src/components/PresetNav',()=>({PresetNav:()=>null}));
vi.mock('../../src/components/LayerMenu',()=>({LayerMenu:()=>null}));
vi.mock('../../src/components/TimelineBar',()=>({TimelineBar:()=>null}));
vi.mock('../../src/components/ShareButton',()=>({ShareButton:()=>null}));
vi.mock('../../src/components/Legend',()=>({Legend:()=>null}));
vi.mock('../../src/lib/maplibreHelper',()=>({PRESET_LOCATIONS:[{id:'fixture',name:'fixture',center:[139,35],zoom:10,pitch:60,bearing:0,elevation:1}]}));
vi.mock('../../src/lib/jmaNowcastClient',()=>({getJMAFrameKey:()=>'',fetchJMANowcastCatalog:()=>new Promise(()=>{}),fetchJMANowcastRainLayer:()=>new Promise(()=>{})}));
vi.mock('../../src/lib/jaxaClient',()=>({preloadCentralMountainElevation:()=>{},fetchPointElevationFromAW3D:async()=>null,inspectLocationValues:()=>({precipitation:null,elevation:1}),setActiveRainLayerResult:()=>{},formatDateToJST:()=>'',fetchGSMaPTimelineCatalog:()=>new Promise(()=>{}),fetchGSMaPRainLayer:()=>new Promise(()=>{})}));
import App from '../../src/App';
import * as s from '../../src/lib/favoritesStorage';

it('D01 ADD-03: importing during normal save must commit the same latest list as the UI',async()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  vi.stubGlobal('indexedDB',undefined);localStorage.clear();sessionStorage.clear();s.resetFavoritesMemoryCacheForTesting();
  window.history.replaceState(null,'','/');
  const old={id:'A',name:'old-A',center:[139,35] as [number,number],zoom:10,pitch:60,bearing:0,elevation:1,region:'fixture',description:'fixture',emoji:'*'};
  localStorage.setItem('rain3d_favorite_locations_v1',JSON.stringify([old]));
  const payload='1j'+btoa(JSON.stringify([['new-B',14000000,3600000,1000,60,0,1,1794182400]])).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const node=document.createElement('div');document.body.appendChild(node);const root=createRoot(node);
  const opens:any[]=[];const values=new Map();
  function complete(req:any){
    req.result={transaction:()=>{const tx:any={objectStore:()=>({put:(value:any,key:string)=>values.set(key,structuredClone(value)),get:(key:string)=>{const r:any={};queueMicrotask(()=>{r.result=values.get(key);r.onsuccess?.();});return r;}})};queueMicrotask(()=>tx.oncomplete?.());return tx;}};
    req.done=true;req.onsuccess?.();
  }
  try{
    await act(async()=>root.render(React.createElement(App)));
    await act(async()=>h.map.onInspectPoint({lng:139,lat:35,elevation:1,precipitation:null}));
    vi.stubGlobal('indexedDB',{open:()=>{const req:any={};opens.push(req);return req;}});
    let save:Promise<any>;
    await act(async()=>{save=h.inspector.onSaveFavorite('edited-A');});
    expect(opens).toHaveLength(1); // paused normal save
    await act(async()=>{
      window.history.replaceState(null,'',`/#fav=${payload}`);
      window.dispatchEvent(new Event('hashchange'));
    });
    const button=[...node.querySelectorAll('button')].find(b=>b.textContent==='追加する');
    expect(button).toBeDefined();
    const beforeImport=opens.length;
    await act(async()=>button!.click());
    expect(opens.length).toBe(beforeImport+1); // import bypasses normal-save queue
    await act(async()=>complete(opens.at(-1))); // import persisted first
    await act(async()=>{complete(opens[0]);await save;}); // stale normal save persists last
    const displayed=h.map.favorites.map((f:any)=>f.name).sort();
    s.resetFavoritesMemoryCacheForTesting();
    const persisted=s.loadFavoriteLocations().map(f=>f.name).sort();
    expect({displayed,persisted}).toEqual({displayed:['edited-A','new-B'],persisted:['edited-A','new-B']});
  }finally{
    await act(async()=>{for(const req of opens)if(!req.done)complete(req);});
    await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals();vi.restoreAllMocks();
  }
});
