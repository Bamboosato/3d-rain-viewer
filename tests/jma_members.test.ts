// Perspectives before cases: member boundaries and URL identity; persisted old/new
// catalogs; malformed member rejection; same-time variants must not share a cache key.
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { fetchJMANowcastCatalog, fetchJMANowcastRainLayer, getJMAFrameKey, loadCachedJMACatalog } from '../src/lib/jmaNowcastClient';
import type { TimelineFrameItem } from '../src/types/map';
const base='20261109060000', storageKey='rain3d_jma_catalog_v1';
const frame:TimelineFrameItem={date:new Date('2026-11-09T12:00:00Z'),labelJST:'fixture',relativeBadge:'',basetime:base,validtime:'20261109120000',tileDataset:'rasrf'};
const row=(validtime:string,member?:unknown)=>({basetime:base,validtime,elements:['rasrf'],...(member===undefined?{}:{member})});
beforeEach(()=>{
 localStorage.clear();
 vi.stubGlobal('Image',class{naturalWidth=256;naturalHeight=256;onload:any;onerror:any;set src(value:string){if(value)queueMicrotask(()=>this.onload?.());}});
});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});

it('catalog preserves member through 1h/1.5h and 6h/7h boundaries and offline restoration',async()=>{
 const fetcher=vi.fn(async(url:string)=>Response.json(url.includes('N1')?[{basetime:base,validtime:base,elements:['hrpns']}]:
  url.includes('N2')?[{basetime:base,validtime:'20261109070000',elements:['hrpns']}]:
  [row('20261109073000','immed'),row('20261109120000','immed'),row('20261109130000','none')]));
 vi.stubGlobal('fetch',fetcher);
 const catalog=await fetchJMANowcastCatalog();
 expect(catalog.frames.map(f=>[f.validtime,f.member])).toEqual([
  [base,'none'],['20261109070000','none'],['20261109073000','immed'],['20261109120000','immed'],['20261109130000','none']]);
 expect(fetcher).toHaveBeenCalledTimes(3);
 expect(JSON.parse(localStorage.getItem(storageKey)!).version).toBe(2);
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:403})));
 const offline=await fetchJMANowcastCatalog();expect(offline.isStale).toBe(true);
 expect(offline.frames).toEqual(catalog.frames);
});

it.each(['none','immed'] as const)('real image loader uses %s for all 20 URLs and the returned frame key',async member=>{
 const fetcher=vi.fn(async(url:string)=>new Response(new Uint8Array([1]),{status:url.includes(`/${base}/${member}/`)?200:404}));
 vi.stubGlobal('fetch',fetcher);
 const result=await fetchJMANowcastRainLayer({...frame,member});
 expect(result.status).toBe('success');expect(fetcher).toHaveBeenCalledTimes(20);
 expect(fetcher.mock.calls.every(([url])=>url.includes(`/${base}/${member}/${frame.validtime}/surf/rasrf/`))).toBe(true);
 expect(result.key).toBe(getJMAFrameKey({...frame,member}));
});

it('same-time members have different keys while legacy none keys remain unchanged',()=>{
 const oldKey=`jma:rasrf:${base}:${frame.validtime}:v1`;
 expect(getJMAFrameKey(frame)).toBe(oldKey);
 expect(getJMAFrameKey({...frame,member:'none'})).toBe(oldKey);
 const existing=new Map([[oldKey,'previous none image']]);
 expect(existing.get(getJMAFrameKey({...frame,member:'immed'}))).toBeUndefined();
});

it.each([undefined,1])('legacy catalog version %s restores the old none identity without deleting user data',version=>{
 localStorage.setItem(storageKey,JSON.stringify({version,frames:[frame],defaultIndex:0}));
 localStorage.setItem('rain3d_favorite_atomic_state_v1','retained');
 const before=localStorage.getItem(storageKey);
 const restored=loadCachedJMACatalog()!;
 expect(restored.frames[0].member).toBe('none');expect(getJMAFrameKey(restored.frames[0])).toBe(getJMAFrameKey(frame));
 expect(localStorage.getItem(storageKey)).toBe(before);
 expect(localStorage.getItem('rain3d_favorite_atomic_state_v1')).toBe('retained');
});

it.each(['../immed','unknown',null])('unsupported member %s is rejected before image I/O and removed from saved catalogs',async member=>{
 const invalid={...frame,member} as TimelineFrameItem;
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 await expect(fetchJMANowcastRainLayer(invalid)).rejects.toMatchObject({kind:'invalid-data'});
 expect(fetcher).not.toHaveBeenCalled();expect(()=>getJMAFrameKey(invalid)).toThrow();
 localStorage.setItem(storageKey,JSON.stringify({version:2,frames:[invalid],defaultIndex:0}));
 expect(loadCachedJMACatalog()).toBeNull();
});

it('new catalog without a member is rejected; invalid network members never become selectable',async()=>{
 localStorage.setItem(storageKey,JSON.stringify({version:2,frames:[frame],defaultIndex:0}));
 expect(loadCachedJMACatalog()).toBeNull();
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>Response.json(url.includes('N1')?[{basetime:base,validtime:base,elements:['hrpns']}]:
  url.includes('N2')?[]:[row('20261109120000','invalid'),row('20261109130000','none')])));
 const catalog=await fetchJMANowcastCatalog();expect(catalog.frames.map(f=>f.validtime)).toEqual([base,'20261109130000']);
});
