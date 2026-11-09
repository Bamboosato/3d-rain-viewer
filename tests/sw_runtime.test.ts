// Perspectives: real handler ownership, network/storage failure, lifetime and offline state.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
function fixture() {
  const handlers: Record<string, (event:any)=>void> = {};
  const stores = new Map<string, Map<string, Response>>();
  const skipWaiting=vi.fn(async()=>{});
  const fetcher = vi.fn(async () => new Response('network', { status: 200 }));
  const put = vi.fn(async (name:string, key:any, response:Response) => { stores.get(name)!.set(typeof key==='string'?key:key.url,response.clone()); });
  const cacheApi = {
    keys: async () => [...stores.keys()], delete: async (name:string) => stores.delete(name),
    open: async (name:string) => {
      if(!stores.has(name)) stores.set(name,new Map());
      return { addAll:async()=>{}, keys:async()=>[...stores.get(name)!.keys()].map(url=>({url})),
        match:async(key:any)=>stores.get(name)!.get(typeof key==='string'?key:key.url)?.clone(),
        put:(key:any,response:Response)=>put(name,key,response),
        delete:async(key:any)=>stores.get(name)!.delete(typeof key==='string'?key:key.url) };
    },
  };
  runInNewContext(readFileSync('public/sw.js','utf8'), { URL, Response, caches:cacheApi, fetch:fetcher,
    self:{location:{origin:'https://fixture.invalid'},addEventListener:(type:string,handler:any)=>handlers[type]=handler,skipWaiting,clients:{claim:async()=>{}}} });
  const request = (url='https://fixture.invalid/', mode='navigate') => {
    let response!:Promise<Response>; let lifetime!:Promise<void>;
    handlers.fetch({ request:{url,mode,method:'GET'},respondWith:(p:any)=>response=p,waitUntil:(p:any)=>lifetime=p });
    expect(lifetime).toBeDefined(); // registration must happen before handler returns
    return { response, lifetime };
  };
  return { handlers, stores, fetcher, put, request, skipWaiting };
}
it('T01 actual activate removes only obsolete owned cache names', async()=>{
  const f=fixture(); for(const key of ['rain3d-shell-v1','rain3d-runtime-v1','rain3d-shell-v13','rain3d-runtime-v13','rain3d-opfs-fallback-v1','other'])f.stores.set(key,new Map());
  let lifetime!:Promise<void>; f.handlers.activate({waitUntil:(p:any)=>lifetime=p});await lifetime;
  expect([...f.stores.keys()]).toEqual(['rain3d-shell-v13','rain3d-runtime-v13','rain3d-opfs-fallback-v1','other']);
});
it.each([404,500])('T28 actual navigation HTTP %i never replaces saved HTML', async(status)=>{
  const f=fixture();f.stores.set('rain3d-shell-v13',new Map([['/index.html',new Response('good')]]));
  f.fetcher.mockImplementation(async()=>new Response('error',{status}));const r=f.request();
  expect((await r.response).status).toBe(status);await r.lifetime;
  expect(await f.stores.get('rain3d-shell-v13')!.get('/index.html')!.text()).toBe('good');
  expect(f.put).not.toHaveBeenCalled();
});
it('T27 network unavailable uses saved HTML, absence is an error', async()=>{
  const f=fixture();f.fetcher.mockRejectedValue(new Error('offline')); f.stores.set('rain3d-shell-v13',new Map([['/index.html',new Response('saved')]]));
  const r=f.request(); expect(await (await r.response).text()).toBe('saved'); await r.lifetime;
  f.stores.clear();const missing=f.request();expect((await missing.response).type).toBe('error');await missing.lifetime;
});
it('T02 waitUntil tracks delayed failed put while response succeeds immediately',async()=>{
  const f=fixture();let reject!: (reason:any)=>void;f.put.mockImplementation(()=>new Promise((_,rej)=>reject=rej));
  const r=f.request();expect((await r.response).status).toBe(200);
  let finished=false;void r.lifetime.then(()=>finished=true);await Promise.resolve();expect(finished).toBe(false);
  reject(new Error('disk'));await r.lifetime;expect(finished).toBe(true);
});
it('T29 shell pruning applies the configured limit to actual cache entries',async()=>{
  const f=fixture();const entries=new Map<string,Response>();for(let i=0;i<100;i++)entries.set(`https://fixture.invalid/${i}`,new Response('asset'));
  f.stores.set('rain3d-shell-v13',entries);const r=f.request('https://fixture.invalid/new.js','cors');await r.response;await r.lifetime;
  expect(entries.size).toBe(100);expect(entries.has('https://fixture.invalid/new.js')).toBe(true);
});

it('T21 explicit update application keeps the worker alive until skipWaiting completes',async()=>{
 const f=fixture();let lifetime:Promise<void>|undefined;
 f.handlers.message({data:{type:'unrelated'},waitUntil:(p:any)=>lifetime=p});expect(f.skipWaiting).not.toHaveBeenCalled();
 let finish!:()=>void;f.skipWaiting.mockImplementation(()=>new Promise<void>(resolve=>finish=resolve));
 f.handlers.message({data:{type:'RAIN3D_APPLY_UPDATE'},waitUntil:(p:any)=>lifetime=p});expect(lifetime).toBeDefined();
 let done=false;void lifetime!.then(()=>done=true);await Promise.resolve();expect(done).toBe(false);finish();await lifetime;expect(done).toBe(true);
});
