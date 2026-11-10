// Perspectives: transient/permanent failure, retry boundaries, response byte budget,
// cancellation during backoff/queueing, offline cache access, real frame I/O counts.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { requestWeather, readWeatherBytes, weatherDeadline, WeatherRequestError } from '../src/lib/weatherRequests';
import { fetchJMANowcastRainLayer } from '../src/lib/jmaNowcastClient';
import { FrameScheduler } from '../src/lib/frameBudget';
const decode = async (r: Response, s: AbortSignal) => new TextDecoder().decode(await readWeatherBytes(r, s, 32));
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('503 retries twice with backoff and returns the recovered response', async () => {
  const fetcher = vi.fn().mockImplementationOnce(async () => new Response('', {status:503}))
    .mockImplementationOnce(async () => new Response('', {status:503})).mockImplementation(async () => new Response('ok'));
  vi.stubGlobal('fetch', fetcher);
  const job = requestWeather('/tile', decode);
  await vi.advanceTimersByTimeAsync(399); expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(fetcher).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1000); expect(await job).toBe('ok'); expect(fetcher).toHaveBeenCalledTimes(3);
});

it.each([404,410,403])('HTTP %i is not retried; only missing URLs request a catalog refresh', async status => {
  const fetcher = vi.fn(async () => new Response('', {status})); vi.stubGlobal('fetch', fetcher);
  const error = await requestWeather('/tile', decode).catch(e => e);
  expect(error).toBeInstanceOf(WeatherRequestError); expect(error.refreshCatalog).toBe(status !== 403);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('honors Retry-After and defers a delay exceeding the short retry budget', async () => {
  const fetcher = vi.fn().mockImplementationOnce(async () => new Response('', {status:429,headers:{'Retry-After':'2'}}))
    .mockImplementation(async () => new Response('ok')); vi.stubGlobal('fetch', fetcher);
  const job = requestWeather('/tile', decode);
  await vi.advanceTimersByTimeAsync(1999); expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(await job).toBe('ok');
  fetcher.mockClear().mockImplementation(async () => new Response('', {status:429,headers:{'Retry-After':'60'}}));
  await expect(requestWeather('/tile', decode)).rejects.toMatchObject({status:429});
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('a timeout aborts the attempt and recovers without leaving timers', async () => {
  let attemptSignal!: AbortSignal;
  const fetcher = vi.fn().mockImplementationOnce((_url, init) => {attemptSignal=init.signal;return new Promise(()=>{});})
    .mockImplementation(async () => new Response('ok'));vi.stubGlobal('fetch',fetcher);
  const job=requestWeather('/tile',decode);await vi.advanceTimersByTimeAsync(4400);
  expect(attemptSignal.aborted).toBe(true);expect(await job).toBe('ok');expect(vi.getTimerCount()).toBe(0);
});

it('continued network failure stops after three attempts', async () => {
  const fetcher=vi.fn(async()=>{throw new TypeError('network');});vi.stubGlobal('fetch',fetcher);
  const rejected=expect(requestWeather('/tile',decode)).rejects.toMatchObject({kind:'network'});
  await vi.advanceTimersByTimeAsync(2000);await rejected;expect(fetcher).toHaveBeenCalledTimes(3);
});

it('cancel during backoff prevents later I/O', async () => {
  const fetcher=vi.fn(async()=>new Response('',{status:503}));vi.stubGlobal('fetch',fetcher);
  const controller=new AbortController();const job=requestWeather('/tile',decode,controller.signal);
  const rejected=expect(job).rejects.toMatchObject({name:'AbortError'});
  await vi.advanceTimersByTimeAsync(100);controller.abort();await rejected;
  await vi.advanceTimersByTimeAsync(10000);expect(fetcher).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
});

it('offline permits one SW-cache read but no network retry loop', async () => {
  vi.spyOn(navigator,'onLine','get').mockReturnValue(false);
  const fetcher=vi.fn(async()=>new Response('cached'));vi.stubGlobal('fetch',fetcher);
  expect(await requestWeather('/tile',decode)).toBe('cached');
  fetcher.mockClear().mockRejectedValue(new TypeError('offline'));
  await expect(requestWeather('/missing',decode)).rejects.toMatchObject({kind:'network'});
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each(['hidden','offline'])('shared catalog stops retry I/O if it becomes %s during backoff',async state=>{
  const fetcher=vi.fn(async()=>new Response('',{status:503}));vi.stubGlobal('fetch',fetcher);
  const job=requestWeather('/catalog',decode);const rejected=expect(job).rejects.toBeInstanceOf(WeatherRequestError);
  await vi.advanceTimersByTimeAsync(100);
  if(state==='hidden')vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');
  else vi.spyOn(navigator,'onLine','get').mockReturnValue(false);
  await vi.advanceTimersByTimeAsync(5000);await rejected;expect(fetcher).toHaveBeenCalledTimes(1);
});

it('oversized streamed data and decode failure are not retried', async () => {
  const cancel=vi.fn();const body=new ReadableStream({start(c){c.enqueue(new Uint8Array(33));},cancel});
  const fetcher=vi.fn(async()=>new Response(body));vi.stubGlobal('fetch',fetcher);
  await expect(requestWeather('/tile',decode)).rejects.toMatchObject({kind:'invalid-data'});
  expect(cancel).toHaveBeenCalledTimes(1);expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockClear().mockImplementation(async()=>new Response('bad PNG'));
  await expect(requestWeather('/tile',async()=>{throw new WeatherRequestError('decode');})).rejects.toMatchObject({kind:'decode'});
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('deadline includes scheduler queueing and never starts expired work', async () => {
  const scheduler=new FrameScheduler();let release!:()=>void;
  const pending=new Promise<void>(r=>release=r);
  const first=scheduler.run(true,()=>pending),second=scheduler.run(true,()=>pending);
  const work=vi.fn(async()=>{});
  const job=weatherDeadline(500,undefined,signal=>scheduler.run(true,work,signal));
  const rejected=expect(job).rejects.toMatchObject({kind:'timeout'});
  await vi.advanceTimersByTimeAsync(500);await rejected;release();await Promise.all([first,second]);
  expect(work).not.toHaveBeenCalled();
});

it('frame queue accepts four waiting jobs and rejects the next without starting it', async () => {
  const scheduler=new FrameScheduler();let release!:()=>void;
  const gate=new Promise<void>(r=>release=r),started=vi.fn(()=>gate);
  const accepted=Array.from({length:6},()=>scheduler.run(true,started));
  const extra=vi.fn(async()=>{});
  await expect(scheduler.run(true,extra)).rejects.toMatchObject({name:'AbortError'});
  expect(started).toHaveBeenCalledTimes(2);expect(extra).not.toHaveBeenCalled();
  release();await Promise.all(accepted);expect(started).toHaveBeenCalledTimes(6);
});

it('frame retries only the failed tile: 21 reads for 20 tiles, at most four fetches at once', async () => {
  const counts=new Map<string,number>();let active=0,peak=0;
  vi.stubGlobal('Image',class{naturalWidth=256;naturalHeight=256;onload:any;onerror:any;set src(v:string){if(v)queueMicrotask(()=>this.onload?.());}});
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
    active++;peak=Math.max(peak,active);await Promise.resolve();active--;
    const count=(counts.get(url)??0)+1;counts.set(url,count);
    return url.endsWith('/54/22.png')&&count===1?new Response('',{status:503}):new Response(new Uint8Array([1]));
  }));
  const frame:any={date:new Date('2026-11-09T16:00:00Z'),labelJST:'10h',basetime:'20261109060000',validtime:'20261109160000',tileDataset:'rasrf'};
  const job=fetchJMANowcastRainLayer(frame);await vi.advanceTimersByTimeAsync(500);
  expect((await job).status).toBe('success');expect(counts.size).toBe(20);
  expect([...counts.values()].reduce((a,b)=>a+b,0)).toBe(21);expect(peak).toBeLessThanOrEqual(4);
});
