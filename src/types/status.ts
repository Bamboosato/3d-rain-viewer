/**
 * アプリケーション共通の状態・結果・エラー分類型定義
 * 指示書 セクション 3.2 準拠
 */

export type DataState = 'success' | 'partial' | 'failure' | 'stale';

export type StorageState = 'persisted' | 'saving' | 'memory-only' | 'failed';

export type RequestState = 'idle' | 'loading' | 'success' | 'error' | 'cancelled' | 'timeout';

export type ErrorKind =
  | 'network'
  | 'http'
  | 'decode'
  | 'invalid-data'
  | 'storage-unavailable'
  | 'quota'
  | 'timeout'
  | 'cancelled';

export interface AppDiagnosticEvent {
  appBuild: string;
  cacheFormatVersion: string;
  processType: string;
  storageTarget?: string;
  success: boolean;
  errorKind?: ErrorKind;
  errorMessage?: string;
  itemCount?: number;
  byteSize?: number;
  durationMs?: number;
  retryCount?: number;
  requestGeneration?: number;
  cacheHitStatus?: 'hit' | 'miss' | 'stale';
  isMemoryOnly?: boolean;
}

export type DiagnosticLogger = (event: AppDiagnosticEvent) => void;
