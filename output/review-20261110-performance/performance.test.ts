// Investigation only; product code is unchanged.
// Perspectives before cases: functional cache hits; nonfunctional IO amplification;
// data population/legacy keys; UI diagnostics; normal, failure, boundary, cancellation transitions.
// API-boundary fixtures measure real exported implementations, not copied cache algorithms.
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {readFileSync,writeFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const evidence:Record<string,unknown>={};
const flush=async(n=100)=>{for(let i=0;i<n;i++)await Promise.resolve();};
const current=()=>import('../../src/lib/opfsTileCache');
const previous=()=>import('./before-opfs');
beforeEach(()=>{vi.resetModules();vi.stubGlobal('caches',undefined);vi.stubGlobal('navigator',{storage:{}});});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();writeFileSync('output/review-20261110-performance/metrics.json',JSON.stringify(evidence,null,2));});
function opfsFixture(count:number){
 const stats={enumerations:0,entries:0,fileReads:0,writes:0,closeAttempts:0};
 const files=new Map<string,Uint8Array>();for(let i=0;i<count;i++)files.set(`tile${i}.bin`,new Uint8Array(128).fill(7));
 let gate:Promise<void>|undefined;
 const dir:any={kind:'directory',getDirectoryHandle:async()=>dir,
  entries:async function*(){stats.enumerations++;for(const name of [...files.keys()]){stats.entries++;yield [name,{kind:'file',getFile:()=>file(name)}];}},
  removeEntry:async(name:string)=>{files.delete(name);},
  getFileHandle:async(name:string,options:any)=>{
   if(!files.has(name)){if(!options?.create)throw new Error('missing');files.set(name,new Uint8Array());}
   return {getFile:()=>file(name),createWritable:async()=>{let data:Uint8Array;return {write:async(d:Uint8Array)=>{data=d.slice();},close:async()=>{stats.closeAttempts++;if(gate)await gate;files.set(name,data);stats.writes++;},abort:async()=>{}};}};
  }};
 const file=async(name:string)=>{stats.fileReads++;const bytes=files.get(name)!;return {size:bytes.length,lastModified:Date.now(),arrayBuffer:async()=>bytes.slice().buffer};};
 vi.stubGlobal('navigator',{storage:{getDirectory:async()=>dir}});
 return {dir,stats,files,setGate:(p:Promise<void>)=>gate=p};
}
function cacheFixture(count:number,size=128){
 const stats={keys:0,bodyReads:0,bytesRead:0,puts:0};
 const records=new Map<string,any>();
 const response=(value:number)=>({ok:true,status:200,headers:new Headers({'x-cached-at':String(Date.now())}),clone(){return this;},arrayBuffer:async()=>{stats.bodyReads++;stats.bytesRead+=size;return size===128?new Uint8Array(size).fill(value).buffer:{byteLength:size};}});
 for(let i=0;i<count;i++)records.set(`https://opfs-fallback.local/raster/tile${i}.bin`,response(7));
 const cache={keys:async()=>{stats.keys++;return [...records.keys()].map(url=>({url}));},match:async(k:any)=>records.get(typeof k==='string'?k:k.url),put:async(k:any,r:any)=>{stats.puts++;records.set(typeof k==='string'?k:k.url,r);},delete:async(k:any)=>records.delete(typeof k==='string'?k:k.url)};
 vi.stubGlobal('caches',{open:async()=>cache});return {stats,cache,records};
}
it('P01 20 persistent hits scan the entire 1200-file directory each time only after PR10',async()=>{
 const measured:any={};
 for(const variant of ['before','after']){
  vi.resetModules();const f=opfsFixture(1200);const c=cacheFixture(0);const api=await (variant==='before'?previous():current());const fetcher=vi.fn(async()=>new Uint8Array(128));
  for(let i=0;i<20;i++)expect(new Uint8Array(await api.getTileWithOpfsSWR({category:'raster',key:`tile${i}`,fetcher}))[0]).toBe(7);
  measured[variant]={...f.stats,fallbackKeyScans:c.stats.keys,network:fetcher.mock.calls.length};
 }
 expect(measured.before.entries).toBe(0);expect(measured.after.entries).toBe(24000);expect(measured.after.network).toBe(0);expect(measured.after.fallbackKeyScans).toBe(20);evidence.P01=measured;
});
it('P02 a valid OPFS hit waits 2500ms for a stalled fallback listing after PR10',async()=>{
 vi.useFakeTimers();opfsFixture(1);const c=cacheFixture(0);c.cache.keys=()=>new Promise(()=>{});
 const api=await current();let settled=false;const result=api.getTileWithOpfsSWR({category:'raster',key:'tile0',fetcher:async()=>{throw new Error('must hit');}}).then(r=>{settled=true;return r;});
 await vi.advanceTimersByTimeAsync(2499);expect(settled).toBe(false);await vi.advanceTimersByTimeAsync(2);expect(new Uint8Array(await result)[0]).toBe(7);
 evidence.P02={validOpfsHit:true,fallbackTimeoutMs:2500,settledBeforeDeadline:false};
});
it('P03 directory timeout discards an existing cached tile and enumeration continues after timeout',async()=>{
 vi.useFakeTimers();const f=opfsFixture(1200);let release!:()=>void;const gate=new Promise<void>(r=>release=r);let scanned=0;
 f.dir.entries=async function*(){for(const name of f.files.keys()){scanned++;if(scanned===2)await gate;yield [name,{kind:'file'}];}};
 const api=await current();const fetcher=vi.fn(async()=>{throw new Error('network attempted despite cached tile');});const result=expect(api.getTileWithOpfsSWR({category:'raster',key:'tile0',fetcher})).rejects.toThrow('network attempted');
 await vi.advanceTimersByTimeAsync(2501);await result;expect(fetcher).toHaveBeenCalledTimes(1);expect(f.stats.fileReads).toBe(0);
 release();await flush(6000);expect(scanned).toBe(1200);evidence.P03={cachedTileExisted:true,networkCalls:1,fileReads:0,scanEntriesAfterTimeout:scanned};
});
it('P04 cancelled persistent reads remain pending then return cached data',async()=>{
 const f=opfsFixture(1);let release!:()=>void;const gate=new Promise<void>(r=>release=r);f.dir.entries=async function*(){await gate;yield ['tile0.bin',{kind:'file'}];};
 const api=await current();const controller=new AbortController();let settled=false;const result=api.getTileWithOpfsSWR({category:'raster',key:'tile0',signal:controller.signal,fetcher:async()=>new Uint8Array(128)}).then(r=>{settled=true;return r;});
 await flush();controller.abort();await flush();expect(settled).toBe(false);release();expect(new Uint8Array(await result)[0]).toBe(7);
 evidence.P04={settledOnAbort:false,returnedCachedDataAfterAbort:true};
});
it('P05 every OPFS write reads metadata of all 1200 files after PR10',async()=>{
 const measured:any={};
 for(const variant of ['before','after']){
  vi.resetModules();const f=opfsFixture(1200);const api=await (variant==='before'?previous():current());
  await api.getTileWithOpfsSWR({category:'raster',key:'newtile',fetcher:async()=>new Uint8Array(128)});await flush(15000);
  expect(f.stats.writes).toBe(1);measured[variant]={...f.stats};
 }
 expect(measured.before.fileReads).toBe(0);expect(measured.after.fileReads).toBe(1201);evidence.P05=measured;
});
it('P06 each fallback write rereads every cached tile body only after PR10',async()=>{
 const measured:any={};
 for(const variant of ['before','after']){
  vi.resetModules();vi.stubGlobal('navigator',{storage:{}});const f=cacheFixture(600,100000);const api=await (variant==='before'?previous():current());
  await api.getTileWithOpfsSWR({category:'raster',key:'newtile',fetcher:async()=>new Uint8Array(128)});await flush(8000);measured[variant]={...f.stats};
 }
 expect(measured.before.bytesRead).toBe(0);expect(measured.after.bytesRead).toBe(60000000);evidence.P06=measured;
});
it('P07 healthy OPFS with 40 simultaneous results drops 8 persistence jobs at queue limit',async()=>{
 const f=opfsFixture(0);let release!:()=>void;f.setGate(new Promise<void>(r=>release=r));const api=await current();const {getDiagnostics}=await import('../../src/lib/diagnostics');
 const requests=Array.from({length:40},(_,i)=>({category:'raster' as const,key:`burst${i}`,fetcher:async()=>new Uint8Array(128)}));
 await Promise.all(requests.map(r=>api.getTileWithOpfsSWR(r)));expect(getDiagnostics().filter(d=>d.outcome==='memory-only')).toHaveLength(8);
 release();await flush(20000);expect(f.stats.writes).toBe(32);
 await Promise.all(requests.map(r=>api.getTileWithOpfsSWR(r)));await flush();expect(f.stats.writes).toBe(32);
 evidence.P07={validNetworkResults:40,persisted:32,memoryOnlyEvents:8,afterMemoryRevisitPersisted:32,backendFailure:false};
});
it('P08 SW runtime persistence reads all cached bodies after PR10',async()=>{
 const measured:any={};
 for(const variant of ['before','after']){
  const f=cacheFixture(0,100000);for(let i=0;i<399;i++)f.records.set(`https://www.jma.go.jp/bosai/jmatile/${i}.png`,{status:200,clone(){return this;},arrayBuffer:async()=>{f.stats.bodyReads++;f.stats.bytesRead+=100000;return {byteLength:100000};}});
  const handlers:any={};const response:any={status:200,clone(){return this;},arrayBuffer:async()=>{f.stats.bodyReads++;f.stats.bytesRead+=100000;return {byteLength:100000};}};
  runInNewContext(readFileSync(variant==='before'?'output/review-20261110-performance/before-sw.js':'public/sw.js','utf8'),{URL,Response,fetch:async()=>response,caches:{open:async()=>f.cache},self:{location:{origin:'https://performance.invalid'},addEventListener:(t:string,h:any)=>handlers[t]=h}});
  let reply:any,lifetime:any;handlers.fetch({request:{method:'GET',mode:'cors',url:'https://www.jma.go.jp/bosai/jmatile/new.png'},respondWith:(p:any)=>reply=p,waitUntil:(p:any)=>lifetime=p});await reply;if(lifetime)await lifetime;await flush(4000);measured[variant]={...f.stats};
 }
 expect(measured.before.bodyReads).toBe(0);expect(measured.after.bodyReads).toBe(400);evidence.P08=measured;
});
