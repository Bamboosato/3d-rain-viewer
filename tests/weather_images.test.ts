// Functional/data perspectives: decode errors, partial recovery, known zero, unknown colors.
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {fetchJMANowcastRainLayer,JMA_MISSING_VALUE} from '../src/lib/jmaNowcastClient';
const frame:any={basetime:'20261109060000',validtime:'20261109060000',tileDataset:'hrpns',date:new Date('2026-11-09T06:00:00Z'),labelJST:'fixture'};
let width=256;let failTile=false;
beforeEach(()=>{width=256;failTile=false;
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>failTile&&url.includes('/54/')?new Response('',{status:403}):new Response(new Uint8Array([1]))));
 vi.stubGlobal('Image',class{naturalWidth=width;naturalHeight=width;crossOrigin='';onload:any;onerror:any;set src(value:string){if(value)queueMicrotask(()=>this.onload?.());}});
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
it('T09 missing canvas context is a failure, never a successful zero frame',async()=>{
 vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(null);await expect(fetchJMANowcastRainLayer(frame)).rejects.toThrow('Canvas');
});
it('T09 wrong decoded image dimensions are rejected',async()=>{
 width=1;await expect(fetchJMANowcastRainLayer(frame)).rejects.toThrow('All 20');
});
it('T08 partial missing tile areas recover on a new request',async()=>{
 failTile=true;const partial=await fetchJMANowcastRainLayer(frame);expect(partial.status).toBe('partial');expect(partial.missingTilesCount).toBe(5);expect(partial.jmaGrid![0]).toBe(JMA_MISSING_VALUE);
 failTile=false;const recovered=await fetchJMANowcastRainLayer(frame);expect(recovered.status).toBe('success');expect(recovered.jmaGrid![0]).toBe(0);
});
it('a missing regional tile (404) preserves available areas as partial, never discards the whole frame',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.includes('/54/')?new Response('',{status:404}):new Response(new Uint8Array([1]))));
 const partial=await fetchJMANowcastRainLayer(frame);
 expect(partial.status).toBe('partial');expect(partial.missingTilesCount).toBe(5);
 expect(partial.jmaGrid![0]).toBe(JMA_MISSING_VALUE);
});
it('T09 all unknown opaque RGB values are rejected as missing data',async()=>{
 const data=new Uint8ClampedArray(1024*1280*4);for(let i=0;i<data.length;i+=4){data[i]=50;data[i+1]=50;data[i+2]=50;data[i+3]=255;}
 vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:()=>{},getImageData:()=>({data}),putImageData:()=>{}} as any);
 await expect(fetchJMANowcastRainLayer(frame)).rejects.toThrow('recognized');
});

it('T24/T26 concurrent catalog refresh is shared while optional forecast failure is explicit',async()=>{
 localStorage.clear();const fetcher=vi.fn(async(url:string)=>{
  if(url.includes('N1'))return Response.json([{basetime:'20261109060000',validtime:'20261109060000',elements:['hrpns']}]);
  throw new Error('forecast offline');
 });vi.stubGlobal('fetch',fetcher);
 const {fetchJMANowcastCatalog}=await import('../src/lib/jmaNowcastClient');
 const a=fetchJMANowcastCatalog(),b=fetchJMANowcastCatalog();expect(a).toBe(b);
 const result=await a;expect(result.frames).toHaveLength(1);expect(result.isPartial).toBe(true);
 // One N1 plus three bounded attempts for each failed optional catalog; still shared.
 expect(fetcher).toHaveBeenCalledTimes(7);
});
