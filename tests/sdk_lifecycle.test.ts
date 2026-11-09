// Functional/error/state perspectives: actual singleton recovery and bounded SDK work.
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({init:vi.fn(),dates:vi.fn(),stats:vi.fn()}));
vi.mock('../src/lib/jaxa.earth.esm.js',()=>({ImageCollection:class{init(){return h.init();}last(){return new Date('2026-11-09T00:00:00Z');}getDateAll(){return h.dates();}async getImage(){return {getDate:()=>new Date('2026-11-09T00:00:00Z'),getDataObject:async()=>({width:1,height:1,data:new Float32Array([NaN])})};}},Resampling:{BILINEAR:'bilinear'},image:{ColorMap:class{},createCanvas:()=>document.createElement('canvas')},data:{Inspector:class{getValueByCoordinateXY(){return null;}},stat:()=>h.stats()}}));
beforeEach(()=>{vi.resetModules();vi.useFakeTimers();localStorage.clear();h.init.mockReset();h.dates.mockReset();h.stats.mockReset();h.dates.mockResolvedValue([new Date('2026-11-09T00:00:00Z')]);});
afterEach(()=>{vi.useRealTimers();});
it('T11 failed collection initialization is retried by the real singleton',async()=>{
 h.init.mockRejectedValueOnce(new Error('first')).mockResolvedValue(undefined);
 const s=await import('../src/lib/jaxaClient');const first=expect(s.getGSMaPImageCollection()).rejects.toThrow('first');await vi.advanceTimersByTimeAsync(1500);await first;
 await expect(s.getGSMaPImageCollection()).resolves.toBeDefined();expect(h.init).toHaveBeenCalledTimes(2);
});
it('T11 SDK initialization stall has a deadline and allows reinitialization',async()=>{
 h.init.mockImplementationOnce(()=>new Promise(()=>{})).mockResolvedValue(undefined);
 const s=await import('../src/lib/jaxaClient');const first=expect(s.getGSMaPImageCollection()).rejects.toThrow();await vi.advanceTimersByTimeAsync(12000);await first;
 await expect(s.getGSMaPImageCollection()).resolves.toBeDefined();expect(h.init).toHaveBeenCalledTimes(2);
});
it('T23/T26 GSMaP refreshed catalog is persisted and reused on offline startup',async()=>{
 h.init.mockResolvedValue(undefined);const s=await import('../src/lib/jaxaClient');const first=s.fetchGSMaPTimelineCatalog(true);await vi.advanceTimersByTimeAsync(1500);expect((await first).isStale).toBe(false);
 h.init.mockRejectedValue(new Error('offline'));const cached=await s.fetchGSMaPTimelineCatalog(true);expect(cached.isStale).toBe(true);expect(cached.savedAt).toBeDefined();expect(cached.dates).toHaveLength(1);
});

it('T06 GSMaP non-finite statistics cannot become successful zero rainfall',async()=>{
 h.init.mockResolvedValue(undefined);h.stats.mockReturnValue({max:NaN,mean:NaN});
 const s=await import('../src/lib/jaxaClient');const result=expect(s.fetchGSMaPRainLayer()).rejects.toThrow('missing');
 await vi.advanceTimersByTimeAsync(1500);await result;
});
