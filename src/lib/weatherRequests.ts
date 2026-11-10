import { abortableDelay, bounded } from './asyncLifecycle';
import type { ErrorKind } from '../types/status';

export const WEATHER_ATTEMPT_MS = 4000;
export const WEATHER_FRAME_MS = 18000;
export const WEATHER_TILE_BYTES = 512 * 1024;
export class WeatherRequestError extends Error {
  constructor(public kind: ErrorKind, public status?: number, public retryAfterMs = 0) {
    super(`Weather ${kind}${status ? ` (${status})` : ''}`);
  }
  get refreshCatalog() { return this.status === 404 || this.status === 410; }
}

/** Cancel underlying I/O as well as settling the caller; includes queueing time. */
export async function weatherDeadline<T>(ms: number, parent: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(parent?.reason);
  if (parent?.aborted) cancel(); else parent?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Weather deadline', 'TimeoutError')), ms);
  try {
    controller.signal.throwIfAborted();
    return await bounded(work(controller.signal), ms, controller.signal);
  } catch (error) {
    if (parent?.aborted) throw parent.reason;
    if (controller.signal.aborted) throw new WeatherRequestError('timeout');
    throw error;
  } finally { clearTimeout(timer); parent?.removeEventListener('abort', cancel); }
}

/** Keep successful resources; only the failed request gets up to two retries. */
export async function requestWeather<T>(url: string, decode: (response: Response, signal: AbortSignal) => Promise<T>, signal?: AbortSignal, onRetry?: () => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    // A shared catalog has no single owner signal. Still stop retrying when the
    // page hides or connectivity disappears during backoff; permit cache on attempt 0.
    if (attempt > 0 && typeof document !== 'undefined' && document.visibilityState === 'hidden') throw new WeatherRequestError('cancelled');
    if (attempt > 0 && typeof navigator !== 'undefined' && navigator.onLine === false) throw new WeatherRequestError('network');
    try {
      return await weatherDeadline(WEATHER_ATTEMPT_MS, signal, async attemptSignal => {
        let response: Response;
        try { response = await fetch(url, { signal: attemptSignal }); }
        catch { attemptSignal.throwIfAborted(); throw new WeatherRequestError('network'); }
        if (!response.ok) {
          const header = response.headers.get('Retry-After');
          const delay = header ? Math.max(0, Number.isFinite(Number(header)) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : 0;
          void response.body?.cancel().catch(() => {});
          throw new WeatherRequestError('http', response.status, Number.isFinite(delay) ? delay : 0);
        }
        return decode(response, attemptSignal);
      });
    } catch (error) {
      signal?.throwIfAborted();
      const retryable = error instanceof WeatherRequestError &&
        (error.kind === 'network' || error.kind === 'timeout' || error.status === 429 || (error.status ?? 0) >= 500);
      // Long Retry-After is deferred to a later refresh, never polled aggressively.
      // The first fetch may be served by the existing SW cache even offline.
      if (!retryable || attempt >= 2 || error.retryAfterMs > WEATHER_ATTEMPT_MS ||
          (typeof navigator !== 'undefined' && navigator.onLine === false)) throw error;
      onRetry?.();
      await abortableDelay(Math.max(attempt === 0 ? 400 : 1000, error.retryAfterMs), signal);
    }
  }
}

export async function readWeatherBytes(response: Response, signal: AbortSignal, limit: number): Promise<Uint8Array> {
  if (Number(response.headers.get('Content-Length')) > limit) {
    void response.body?.cancel().catch(() => {}); throw new WeatherRequestError('invalid-data');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new WeatherRequestError('invalid-data');
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { cancel(); throw new WeatherRequestError('invalid-data'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof WeatherRequestError) throw error;
    throw new WeatherRequestError('network');
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}
