// Regression budgets for accumulated caches and rapid viewport changes.
// Perspectives before cases: functional cache hits; nonfunctional IO amplification;
// data population/legacy keys; UI diagnostics; normal, failure, boundary, cancellation transitions.
// API-boundary fixtures measure real exported implementations, not copied cache algorithms.
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const evidence:Record<string,unknown>={};
const flush=async(n=100)=>{for(let i=0;i<n;i++)await Promise.resolve();};
const current=()=>import('../src/lib/opfsTileCache');
beforeEach(()=>{vi.resetModules();vi.stubGlobal('caches',undefined);vi.stubGlobal('navigator',{storage:{}});});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();mkdirSync('output/implementation-20261110-performance',{recursive:true});writeFileSync('output/implementation-20261110-performance/metrics.json',JSON.stringify(evidence,null,2));});
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

it('P01 warm persistent reads share one inventory, irrespective of requested tile count',async()=>{
 const f=opfsFixture(1200);const c=cacheFixture(0);const api=await current();const fetcher=vi.fn(async()=>new Uint8Array(128));
 for(let i=0;i<20;i++)expect(new Uint8Array(await api.getTileWithOpfsSWR({category:'raster',key:`tile${i}`,fetcher}))[0]).toBe(7);
 expect(f.stats.entries).toBe(1200);expect(c.stats.keys).toBe(1);expect(fetcher).not.toHaveBeenCalled();evidence.P01={...f.stats,fallbackKeyScans:c.stats.keys,network:0};
});
it('P02 a usable OPFS copy is not held behind an unavailable secondary store',async()=>{
 vi.useFakeTimers();opfsFixture(1);const c=cacheFixture(0);c.cache.keys=()=>new Promise(()=>{});
 const api=await current();let settled=false;const result=api.getTileWithOpfsSWR({category:'raster',key:'tile0',fetcher:async()=>{throw new Error('must hit');}}).then(r=>{settled=true;return r;});
 await vi.advanceTimersByTimeAsync(30);expect(settled).toBe(true);expect(new Uint8Array(await result)[0]).toBe(7);await vi.advanceTimersByTimeAsync(2600);
 evidence.P02={settledWithinMs:30};
});
it('P03 timed out inventory falls back to direct legacy access and stops enumerating',async()=>{
 vi.useFakeTimers();const f=opfsFixture(1200);let release!:()=>void;const gate=new Promise<void>(r=>release=r);let scanned=0;
 f.dir.entries=async function*(){for(const name of f.files.keys()){scanned++;if(scanned===2)await gate;yield [name,{kind:'file'}];}};
 const api=await current();const fetcher=vi.fn(async()=>new Uint8Array(128));const result=api.getTileWithOpfsSWR({category:'raster',key:'tile0',fetcher});
 await vi.advanceTimersByTimeAsync(2550);expect(new Uint8Array(await result)[0]).toBe(7);expect(fetcher).not.toHaveBeenCalled();release();await flush();expect(scanned).toBe(2);
 evidence.P03={cachedTileUsed:true,networkCalls:0,scanEntriesAfterTimeout:scanned};
});
it('P04 viewport cancellation rejects immediately even while inventory is pending',async()=>{
 const f=opfsFixture(1);let release!:()=>void;const gate=new Promise<void>(r=>release=r);f.dir.entries=async function*(){await gate;yield ['tile0.bin',{kind:'file'}];};
 const api=await current();const controller=new AbortController();const result=api.getTileWithOpfsSWR({category:'raster',key:'tile0',signal:controller.signal,fetcher:async()=>new Uint8Array(128)});
 const rejected=expect(result).rejects.toMatchObject({name:'AbortError'});await flush();controller.abort();await rejected;release();await flush();evidence.P04={rejectedOnAbort:true};
});
it('P05 writing one tile audits at most four legacy file sizes without rescanning the directory',async()=>{
 const f=opfsFixture(1200);const api=await current();await api.getTileWithOpfsSWR({category:'raster',key:'newtile',fetcher:async()=>new Uint8Array(128)});await flush(15000);
 expect(f.stats.writes).toBe(1);expect(f.stats.fileReads).toBeLessThanOrEqual(4);expect(f.stats.enumerations).toBe(1);evidence.P05={...f.stats};
});
it('P06 fallback migration reads at most four old bodies per write, never the entire cache',async()=>{
 const f=cacheFixture(600,100000);const api=await current();await api.getTileWithOpfsSWR({category:'raster',key:'newtile',fetcher:async()=>new Uint8Array(128)});await flush(8000);
 expect(f.stats.puts).toBe(1);expect(f.stats.bytesRead).toBeLessThanOrEqual(400000);expect(f.stats.keys).toBe(1);evidence.P06={...f.stats};
});
it('P07 rapid pan/zoom burst of 40 tiles drains deferred saves without dropping them',async()=>{
 const f=opfsFixture(0);let release!:()=>void;f.setGate(new Promise<void>(r=>release=r));const api=await current();const {getDiagnostics}=await import('../src/lib/diagnostics');
 const requests=Array.from({length:40},(_,i)=>({category:'raster' as const,key:`burst${i}`,fetcher:async()=>new Uint8Array(128)}));
 await Promise.all(requests.map(r=>api.getTileWithOpfsSWR(r)));expect(getDiagnostics().filter(d=>d.outcome==='deferred')).toHaveLength(8);await flush();expect(f.stats.closeAttempts).toBe(1);
 release();await flush(20000);expect(f.stats.writes).toBe(40);
 await Promise.all(requests.map(r=>api.getTileWithOpfsSWR(r)));expect(f.stats.writes).toBe(40);expect(getDiagnostics().some(d=>d.outcome==='memory-only')).toBe(false);
 evidence.P07={validNetworkResults:40,persisted:40,deferred:8,memoryOnlyEvents:0};
});
it('P08 SW audits bounded legacy bodies and measures only each incoming response',async()=>{
 const f=cacheFixture(0,100000);for(let i=0;i<399;i++)f.records.set(`https://www.jma.go.jp/bosai/jmatile/${i}.png`,{status:200,clone(){return this;},arrayBuffer:async()=>{f.stats.bodyReads++;f.stats.bytesRead+=100000;return new Uint8Array(100000).buffer;}});
 const handlers:any={};const response=new Response(new Uint8Array(100000));
 runInNewContext(readFileSync('public/sw.js','utf8'),{URL,Response,Headers,fetch:async()=>response.clone(),caches:{open:async()=>f.cache},self:{location:{origin:'https://performance.invalid'},addEventListener:(t:string,h:any)=>handlers[t]=h}});
 let reply:any,lifetime:any;handlers.fetch({request:{method:'GET',mode:'cors',url:'https://www.jma.go.jp/bosai/jmatile/new.png'},respondWith:(p:any)=>reply=p,waitUntil:(p:any)=>lifetime=p});await reply;await lifetime;
 expect(f.stats.puts).toBe(1);expect(f.stats.bodyReads).toBeLessThanOrEqual(4);evidence.P08={legacyBodyReads:f.stats.bodyReads,legacyBytesRead:f.stats.bytesRead,incomingBytesRead:100000};
});

it('P09 reload discards the old document queue without reporting storage failures',async()=>{
 const f=opfsFixture(0);let release!:()=>void;f.setGate(new Promise<void>(r=>release=r));const api=await current();const {getDiagnostics}=await import('../src/lib/diagnostics');
 await Promise.all(Array.from({length:40},(_,i)=>api.getTileWithOpfsSWR({category:'raster',key:`closing${i}`,fetcher:async()=>new Uint8Array(128)})));await flush();
 const event=new Event('pagehide');Object.defineProperty(event,'persisted',{value:false});window.dispatchEvent(event);release();await flush(10000);
 expect(f.stats.writes).toBeLessThanOrEqual(1);expect(getDiagnostics().some(e=>e.outcome==='memory-only')).toBe(false);
 evidence.P09={writesAfterDocumentClose:f.stats.writes,falseStorageErrors:0};
});
