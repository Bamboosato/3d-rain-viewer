import type { GSMaPRainLayerResult } from './jaxaClient';
export const FRAME_BYTES_LIMIT = 25 * 1024 * 1024;
export const FRAME_COUNT_LIMIT = 10;
const accessed = new WeakMap<GSMaPRainLayerResult, number>();
let clock = 0;
export function touchFrame(frame: GSMaPRainLayerResult): void { accessed.set(frame, ++clock); }
export function frameBytes(frame: GSMaPRainLayerResult): number {
  const pixels = frame.jmaGrid?.length ?? ((frame.dataObject?.width ?? 0) * (frame.dataObject?.height ?? 0));
  // Include decoded RGBA, source grid and the UTF-16 data URL retained by JS.
  return pixels * 4 + (frame.jmaGrid?.byteLength ?? frame.dataObject?.data.byteLength ?? 0) + frame.imageUrl.length * 2;
}
export function trimFrames(caches: Map<string, GSMaPRainLayerResult>[], active: GSMaPRainLayerResult | null, limit = FRAME_BYTES_LIMIT): void {
  const entries = caches.flatMap(cache => [...cache].map(([key, frame]) => ({ cache, key, frame })));
  const outside = active && !entries.some(e => e.frame === active) ? frameBytes(active) : 0;
  let bytes = entries.reduce((n, e) => n + frameBytes(e.frame), outside);
  let count = entries.length;
  entries.sort((a, b) => (accessed.get(a.frame) ?? 0) - (accessed.get(b.frame) ?? 0));
  for (const entry of entries) {
    if (bytes <= limit && count <= FRAME_COUNT_LIMIT) break;
    if (entry.frame === active) continue;
    entry.cache.delete(entry.key); bytes -= frameBytes(entry.frame); count--;
  }
}

/** Two foreground slots; prefetch uses at most one and always yields to queued display work. */
export class FrameScheduler {
  private running = 0;
  private background = 0;
  private waiting: Array<{ foreground: boolean; signal?: AbortSignal; start: () => void }> = [];
  run<T>(foreground: boolean, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.waiting.length >= 4) { reject(new DOMException('Frame queue full', 'AbortError')); return; }
      const abort = () => {
        this.waiting = this.waiting.filter(entry => entry !== item);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      const item = { foreground, signal, start: () => {
        signal?.removeEventListener('abort', abort);
        if (signal?.aborted) { abort(); this.pump(); return; }
        const background = !item.foreground;
        this.running++; if (background) this.background++;
        Promise.resolve().then(work).then(resolve, reject).finally(() => {
          this.running--; if (background) this.background--; this.pump();
        });
      } };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      this.waiting.push(item); this.pump();
    });
  }
  promote(signal: AbortSignal) {
    for (const item of this.waiting) if (item.signal === signal) item.foreground = true;
    this.pump();
  }
  private pump() {
    while (this.running < 2 && this.waiting.length) {
      let index = this.waiting.findIndex(entry => entry.foreground);
      if (index < 0) { if (this.background) return; index = 0; }
      this.waiting.splice(index, 1)[0].start();
    }
  }
}
