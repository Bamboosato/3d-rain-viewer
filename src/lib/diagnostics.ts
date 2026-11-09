import type { ErrorKind } from '../types/status';
export interface DiagnosticEvent {
  operation: 'favorites-read' | 'favorites-commit' | 'tile-read' | 'tile-write' | 'catalog' | 'frame';
  backend: 'idb' | 'localStorage' | 'opfs' | 'cache' | 'memory' | 'network';
  outcome: 'success' | 'failure' | 'hit' | 'miss' | 'stale' | 'memory-only' | 'deferred';
  bytes?: number;
  count?: number;
  durationMs?: number;
  retry?: number;
  error?: ErrorKind;
  generation?: number;
}
const recent: Array<DiagnosticEvent & { version: string; at: number }> = [];
export function diagnostic(event: DiagnosticEvent): void {
  // Explicit allowlist: never forward URLs, keys, coordinates, exceptions or user content.
  const safe = { version: 'lifecycle-v2', at: Date.now(), operation: event.operation,
    backend: event.backend, outcome: event.outcome, bytes: event.bytes,
    count: event.count, durationMs: event.durationMs, retry: event.retry, error: event.error, generation: event.generation };
  recent.push(safe); if (recent.length > 100) recent.shift();
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('rain3d-diagnostic', { detail: safe }));
}
export function getDiagnostics() { return recent.map(event => ({ ...event })); }
