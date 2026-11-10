// UI/state perspectives: frame arrives before backend/map; obsolete load callbacks are removed.
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({ready:null as any,map:null as any}));
vi.mock('../src/lib/maplibreHelper',()=>({registerJaxaTerrainProtocol:()=>{},initGraphicsBackend:()=>new Promise(resolve=>h.ready=resolve),createMapInstance:()=>h.map}));
vi.mock('maplibre-gl',()=>({NavigationControl:class{},ScaleControl:class{}}));
vi.mock('../src/lib/jaxaClient',()=>({JAPAN_RAIN_COORDINATES:[],fetchPointElevationFromAW3D:async()=>null,inspectLocationValues:()=>({precipitation:null,elevation:null})}));
import {MapViewer} from '../src/components/MapViewer';
it('T15 delayed map initialization applies only latest rain frame after load',async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const handlers=new Map<string,Set<Function>>();const sources=new Map();
 const api:any={on:(name:string,fn:Function)=>{if(!handlers.has(name))handlers.set(name,new Set());handlers.get(name)!.add(fn);},once:(name:string,fn:Function)=>api.on(name,fn),off:(name:string,fn:Function)=>handlers.get(name)?.delete(fn),getZoom:()=>10,getSource:(key:string)=>sources.get(key),getLayer:()=>undefined,addSource:vi.fn((key:string,value:any)=>sources.set(key,value)),addLayer:()=>{},addControl:()=>{},setTerrain:()=>{},remove:()=>{},getCenter:()=>({lat:35,lng:139}),getPitch:()=>60,getBearing:()=>0,areTilesLoaded:()=>true,resize:()=>{},setPaintProperty:()=>{},flyTo:()=>{}};
 h.map=api;const node=document.createElement('div');document.body.appendChild(node);const root=createRoot(node);
 const props:any={activePreset:{id:'fixture',center:[139,35],zoom:10,pitch:60,bearing:0},favorites:[],exaggeration:1,rainOpacity:.7,baseMap:'osm',inspectedPoint:null,skipInitialGeolocation:true,onStatusChange:()=>{},onInspectPoint:()=>{}};
 try{
  await act(async()=>root.render(<MapViewer {...props} rainLayerData={{imageUrl:'old',coordinates:[]} as any}/>));
  await act(async()=>root.render(<MapViewer {...props} rainLayerData={{imageUrl:'latest',coordinates:[]} as any}/>));
  await act(async()=>h.ready({backend:'webgl2',webgpuAvailable:false,adapterInfo:'fixture'}));
  await act(async()=>{for(const fn of [...handlers.get('load')??[]])fn();});
  expect(sources.get('rain-source').url).toBe('latest');
  expect(api.addSource.mock.calls.filter((c:any)=>c[0]==='rain-source')).toHaveLength(1);
  // v6 source events show the spinner; style-only events must not re-open it.
  const emit = async (name:string, event:any={}) => act(async()=>{for(const fn of handlers.get(name)??[])fn(event);});
  const loading = () => node.querySelector('[aria-label="地図・3D地形タイル読み込み中"]');
  await emit('idle');expect(loading()).toBeNull();
  await emit('dataloading',{dataType:'style'});expect(loading()).toBeNull();
  await emit('dataloading',{dataType:'source'});expect(loading()).not.toBeNull();
  await emit('idle');expect(loading()).toBeNull();
 }finally{await act(async()=>root.unmount());node.remove();}
});
