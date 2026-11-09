// Perspectives: bounded lifetime, cancellation transitions, quotas, freshness and ownership.
// Each test resets module state and uses API-boundary fixtures; no external services.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FrameScheduler, frameBytes, touchFrame, trimFrames } from '../src/lib/frameBudget';
import { bounded } from '../src/lib/asyncLifecycle';
beforeEach(() => { vi.resetModules(); vi.stubGlobal('caches', undefined); vi.stubGlobal('navigator', { storage: {} }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function cacheFixture() {
  const data = new Map<string, Response>();
  const cache = {
    keys: async () => [...data.keys()].map(url => new Request(url)),
    match: async (key: string | Request) => data.get(typeof key === 'string' ? key : key.url)?.clone(),
    put: vi.fn(async (key: string | Request, response: Response) => { data.set(typeof key === 'string' ? key : key.url, response.clone()); }),
    delete: vi.fn(async (key: string | Request) => data.delete(typeof key === 'string' ? key : key.url)),
  };
  vi.stubGlobal('caches', { open: async () => cache });
  return { data, cache };
}
it('T32 all subscribers cancel; same key recovers even if old provider never settles', async () => {
  const { getTileWithOpfsSWR } = await import('../src/lib/opfsTileCache');
  const controller = new AbortController();
  const first = getTileWithOpfsSWR({ category: 'raster', key: 'cancel', signal: controller.signal, fetcher: () => new Promise(() => {}) });
  const rejected = expect(first).rejects.toThrow();
  await tick(); controller.abort(); await rejected;
  const second = await getTileWithOpfsSWR({ category: 'raster', key: 'cancel', fetcher: async () => new Uint8Array(128).fill(2) });
  expect(new Uint8Array(second)[0]).toBe(2);
});
it('T32 settled subscriber unregisters its abort listener', async () => {
  const controller = new AbortController(); const remove = vi.spyOn(controller.signal, 'removeEventListener');
  const { getTileWithOpfsSWR } = await import('../src/lib/opfsTileCache');
  await getTileWithOpfsSWR({ category: 'raster', key: 'done', signal: controller.signal, fetcher: async () => new Uint8Array(128) });
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
});
it('T33 body stall times out and releases subsequent work', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: () => new Promise(() => {}) })));
  const { fetchTileBytesWithRetry } = await import('../src/lib/opfsTileCache');
  const result = expect(fetchTileBytesWithRetry('https://fixture.invalid/tile', undefined, 100, 0)).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(101); await result;
});
it('T33 Retry-After waiting is cancelled without sending another request', async () => {
  vi.useFakeTimers(); const controller = new AbortController();
  const fetcher = vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '30' } }));
  vi.stubGlobal('fetch', fetcher);
  const { fetchTileBytesWithRetry } = await import('../src/lib/opfsTileCache');
  const result = expect(fetchTileBytesWithRetry('https://fixture.invalid/tile', controller.signal)).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(100); controller.abort(); await result;
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('T33 permanent HTTP errors are not retried', async () => {
  const fetcher = vi.fn(async () => new Response('', { status: 404 })); vi.stubGlobal('fetch', fetcher);
  const { fetchTileBytesWithRetry } = await import('../src/lib/opfsTileCache');
  await expect(fetchTileBytesWithRetry('https://fixture.invalid/tile')).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('T36 actual ArrayBuffer transfer detaches only caller copy and second request hits cache', async () => {
  const { getTileWithOpfsSWR } = await import('../src/lib/opfsTileCache');
  const fetcher = vi.fn(async () => new Uint8Array(128).fill(7));
  const options = { category: 'raster' as const, key: 'transfer', fetcher };
  const first = await getTileWithOpfsSWR(options);
  structuredClone(first, { transfer: [first] }); expect(first.byteLength).toBe(0);
  const second = await getTileWithOpfsSWR(options);
  expect(new Uint8Array(second)[127]).toBe(7); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('T29 quota below count limit evicts a cache entry then retries once', async () => {
  const { data, cache } = cacheFixture();
  data.set('https://opfs-fallback.local/raster/old.bin', new Response(new Uint8Array(128), { headers: { 'x-cached-at': '1' } }));
  cache.put.mockRejectedValueOnce(new DOMException('quota', 'QuotaExceededError'));
  const { getTileWithOpfsSWR } = await import('../src/lib/opfsTileCache');
  await getTileWithOpfsSWR({ category: 'raster', key: 'new', fetcher: async () => new Uint8Array(128) });
  await vi.waitFor(() => expect(cache.put).toHaveBeenCalledTimes(2));
  expect(cache.delete).toHaveBeenCalled();
});
it('T30 both persistent backends unavailable retain readable memory and emit memory-only', async () => {
  const { getTileWithOpfsSWR } = await import('../src/lib/opfsTileCache');
  const { getDiagnostics } = await import('../src/lib/diagnostics');
  await getTileWithOpfsSWR({ category: 'raster', key: 'memory', fetcher: async () => new Uint8Array(128) });
  await vi.waitFor(() => expect(getDiagnostics().some(e => e.outcome === 'memory-only')).toBe(true));
});
it('T05/T31 latest persistent copy retains its original freshness and triggers stale revalidation', async () => {
  const { data } = cacheFixture();
  data.set('https://opfs-fallback.local/raster/old.bin', new Response(new Uint8Array(128).fill(9), { headers: { 'x-cached-at': '1' } }));
  const file = { size: 128, lastModified: 0, arrayBuffer: async () => new Uint8Array(128).fill(1).buffer };
  const dir: any = { getDirectoryHandle: async () => dir, getFileHandle: async () => ({ getFile: async () => file }) };
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => dir } });
  const { getTileWithOpfsSWR } = await import('../src/lib/opfsTileCache');
  const fetcher = vi.fn(async () => { throw new Error('offline'); });
  const result = await getTileWithOpfsSWR({ category: 'raster', key: 'old', fetcher });
  expect(new Uint8Array(result)[0]).toBe(9); await tick(); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('T34 frame budget covers both sources and protects active frame', () => {
  const frame = (name: string) => ({ imageUrl: name, jmaGrid: new Uint16Array(100) }) as any;
  const a = frame('a'), b = frame('b'), c = frame('c'); touchFrame(a); touchFrame(b); touchFrame(c);
  const one = new Map([['a',a],['b',b]]), two = new Map([['c',c]]);
  trimFrames([one,two], a, frameBytes(a)+frameBytes(c));
  expect([...one.keys()]).toEqual(['a']); expect(two.has('c')).toBe(true);
});
it('T34 display work overtakes queued prefetch while concurrency remains bounded', async () => {
  const scheduler = new FrameScheduler(); const starts: string[] = []; let release!: () => void;
  const first = scheduler.run(false, () => new Promise<void>(resolve => { starts.push('background1'); release=resolve; }));
  const second = scheduler.run(false, async () => { starts.push('background2'); });
  const display = scheduler.run(true, async () => { starts.push('display'); });
  await display; expect(starts).toEqual(['background1','display']); release(); await Promise.all([first,second]);
});
it('T33 bounded provider failure does not leave timers or external listeners', async () => {
  const controller = new AbortController(); const remove=vi.spyOn(controller.signal,'removeEventListener');
  await expect(bounded(Promise.reject(new Error('fixture')),100,controller.signal)).rejects.toThrow('fixture');
  expect(remove).toHaveBeenCalled();
});
it('RE14 diagnostic allowlist excludes arbitrary user data', async () => {
  const { diagnostic, getDiagnostics } = await import('../src/lib/diagnostics');
  diagnostic({ operation:'frame', backend:'network', outcome:'failure', url:'secret', name:'private' } as any);
  expect(JSON.stringify(getDiagnostics())).not.toMatch(/secret|private/);
});

it('T29 byte budget evicts entries even when count is below its limit', async () => {
 const { data, cache } = cacheFixture();
 const large:any = { clone(){return this;}, arrayBuffer:async()=>({byteLength:21*1024*1024}) };
 data.set('https://opfs-fallback.local/terrain/a.bin',large);data.set('https://opfs-fallback.local/terrain/b.bin',large);
 const {getTileWithOpfsSWR}=await import('../src/lib/opfsTileCache');
 await getTileWithOpfsSWR({category:'terrain',key:'new',fetcher:async()=>new Uint8Array(128)});
 await vi.waitFor(()=>expect(cache.delete).toHaveBeenCalled());
 expect(data.has('https://opfs-fallback.local/terrain/a.bin')).toBe(false);
});
it('T04/T05 late old OPFS close cannot overwrite a newer immutable generation after restart',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-09T00:00:00Z'));
 const files=new Map<string,{bytes:Uint8Array,modified:number}>();let closeOld!:()=>void;let first=true;
 const dir:any={kind:'directory',getDirectoryHandle:async()=>dir,
  entries:async function*(){for(const name of files.keys())yield [name,{kind:'file',getFile:async()=>({size:files.get(name)!.bytes.length,lastModified:files.get(name)!.modified})}];},
  removeEntry:async(name:string)=>{files.delete(name);},
  getFileHandle:async(name:string,options:any)=>{
   if(!files.has(name)){if(!options?.create)throw new Error('not found');files.set(name,{bytes:new Uint8Array(),modified:0});}
   return {getFile:async()=>({size:files.get(name)!.bytes.length,lastModified:files.get(name)!.modified,arrayBuffer:async()=>files.get(name)!.bytes.slice().buffer}),
    createWritable:async()=>{let staged:Uint8Array;return {write:async(bytes:Uint8Array)=>{staged=bytes;},close:()=>{
      const commit=()=>files.set(name,{bytes:staged,modified:Date.now()});
      if(first){first=false;return new Promise<void>(resolve=>{closeOld=()=>{commit();resolve();};});}commit();return Promise.resolve();
    },abort:async()=>{}};}};
  }};
 vi.stubGlobal('navigator',{storage:{getDirectory:async()=>dir}});
 let api=await import('../src/lib/opfsTileCache');
 await api.getTileWithOpfsSWR({category:'raster',key:'generation',fetcher:async()=>new Uint8Array(128).fill(1)});await tick();
 await vi.advanceTimersByTimeAsync(3000);await tick();
 await vi.advanceTimersByTimeAsync(6*60*1000);
 await api.getTileWithOpfsSWR({category:'raster',key:'generation',fetcher:async()=>new Uint8Array(128).fill(2)});await tick();
 expect([...files.values()].some(file=>file.bytes[0]===2)).toBe(true);
 closeOld();await tick();vi.resetModules();api=await import('../src/lib/opfsTileCache');
 const result=await api.getTileWithOpfsSWR({category:'raster',key:'generation',fetcher:async()=>{throw new Error('offline');}});
 expect(new Uint8Array(result)[0]).toBe(2);
});

it('T29 exact byte boundary is retained; the next write evicts old data', async () => {
 const {data,cache}=cacheFixture();
 const api=await import('../src/lib/opfsTileCache');api.MAX_PERSISTENT_BYTES.raster=256;
 data.set('https://opfs-fallback.local/raster/old.bin',new Response(new Uint8Array(128)));
 await api.getTileWithOpfsSWR({category:'raster',key:'one',fetcher:async()=>new Uint8Array(128)});
 await vi.waitFor(()=>expect(data.size).toBe(2));expect(cache.delete).not.toHaveBeenCalled();
 await api.getTileWithOpfsSWR({category:'raster',key:'two',fetcher:async()=>new Uint8Array(128)});
 await vi.waitFor(()=>expect(cache.delete).toHaveBeenCalled());expect(data.size).toBe(2);
});
