import { afterEach, expect, it, vi } from 'vitest';
// Mock SDK only. Exercise the real active Inspector adoption implementation.
vi.mock('../../src/lib/jaxa.earth.esm.js',()=>({data:{Inspector:class{constructor(private data:any){}getValueByCoordinateXY(){return this.data.value;}}}}));
afterEach(()=>{vi.useRealTimers();});
it('J01 ADD-04: point inspection immediately following GSMaP adoption reads the new frame',async()=>{
  vi.useFakeTimers();
  const s=await import('../../src/lib/jaxaClient');
  const loading=s.getJaxaEarth();await vi.advanceTimersByTimeAsync(1500);await loading;
  s.setActiveRainLayerResult({sourceType:'jaxa-gsmap',dataObject:{value:1}} as any);
  for(let i=0;i<5;i++) await Promise.resolve();
  expect(s.inspectLocationValues(139,35).precipitation).toBe(1);
  s.setActiveRainLayerResult({sourceType:'jaxa-gsmap',dataObject:{value:20}} as any);
  expect(s.inspectLocationValues(139,35).precipitation).toBe(20);
});
