import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRightLeft,
  Check,
  ClipboardPaste,
  Copy,
  Download,
  FileUp,
  QrCode as QrCodeIcon,
  RotateCcw,
  Share2,
  X,
} from 'lucide-react';
import type { PresetLocation } from '../types/map';
import {
  buildFavoritesSyncUrl,
  decodeFavoritesPayload,
  exportFavoritesFile,
  extractFavoritesPayloadFromText,
  FavoritesTransferError,
  MAX_FAVORITES,
  previewImport,
  readBackupFile,
  type ImportMode,
} from '../lib/favoritesTransfer';
import {
  clearFavoritesUndoSnapshot,
  loadFavoritesUndoSnapshot,
  saveFavoritesUndoSnapshot,
} from '../lib/favoritesStorage';
import { shareOrCopyUrl } from '../lib/urlSync';
import { QrCode } from './QrCode';

export interface PendingFavoritesImport {
  items: PresetLocation[];
  /** 取り込み元の表示名（例: 「同期URL」「favorites.json」） */
  sourceLabel: string;
}

interface FavoritesSyncDialogProps {
  favorites: PresetLocation[];
  /** 新しいお気に入り一覧を保存・反映する */
  onApplyFavorites: (next: PresetLocation[]) => void;
  onClose: () => void;
  /** 同期URLから起動した場合などに、最初から取り込み確認を表示する */
  initialImport?: PendingFavoritesImport | null;
  initialError?: string | null;
  lastBackupAt: string | null;
  onBackupExported: (iso: string) => void;
}

type StatusMessage = { kind: 'success' | 'error' | 'info'; text: string } | null;

/** QRコードが細かくなりスマホで読み取りにくくなる目安の文字数 */
const QR_DENSE_THRESHOLD = 1200;

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function toErrorMessage(err: unknown): string {
  if (err instanceof FavoritesTransferError) return err.message;
  return '読み込み中にエラーが発生しました。';
}

export const FavoritesSyncDialog: React.FC<FavoritesSyncDialogProps> = ({
  favorites,
  onApplyFavorites,
  onClose,
  initialImport = null,
  initialError = null,
  lastBackupAt,
  onBackupExported,
}) => {
  const [pendingImport, setPendingImport] = useState<PendingFavoritesImport | null>(initialImport);
  const [importMode, setImportMode] = useState<ImportMode>('merge');
  const [status, setStatus] = useState<StatusMessage>(
    initialError ? { kind: 'error', text: initialError } : null
  );
  const [syncUrl, setSyncUrl] = useState<string | null>(null);
  const [isBuildingUrl, setIsBuildingUrl] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [undoSnapshot, setUndoSnapshot] = useState(() => loadFavoritesUndoSnapshot());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // 外部（同期URLの起動・hashchange）から新しい取り込み依頼が来た場合に反映
  useEffect(() => {
    if (initialImport) {
      setPendingImport(initialImport);
      setImportMode('merge');
      setStatus(null);
    }
  }, [initialImport]);

  useEffect(() => {
    if (initialError) setStatus({ kind: 'error', text: initialError });
  }, [initialError]);

  // お気に入りが変化したら作成済みの同期URLは古くなるため破棄
  useEffect(() => {
    setSyncUrl(null);
  }, [favorites]);

  // Escape キーで閉じる
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const preview = useMemo(
    () => (pendingImport ? previewImport(favorites, pendingImport.items, importMode) : null),
    [favorites, pendingImport, importMode]
  );

  /* ---------------- 書き出し ---------------- */

  const handleExportFile = useCallback(async () => {
    if (favorites.length === 0) return;
    try {
      const outcome = await exportFavoritesFile(favorites);
      if (outcome === 'cancelled') return;
      const now = new Date().toISOString();
      onBackupExported(now);
      setStatus({
        kind: 'success',
        text:
          outcome === 'shared'
            ? `${favorites.length}件のお気に入りをバックアップファイルとして共有しました。`
            : `${favorites.length}件のお気に入りをバックアップファイルに保存しました。`,
      });
    } catch {
      setStatus({ kind: 'error', text: 'バックアップファイルの書き出しに失敗しました。' });
    }
  }, [favorites, onBackupExported]);

  const handleBuildSyncUrl = useCallback(async () => {
    if (favorites.length === 0) return;
    setIsBuildingUrl(true);
    try {
      setSyncUrl(await buildFavoritesSyncUrl(favorites));
      setStatus(null);
    } catch {
      setStatus({ kind: 'error', text: '同期URLの作成に失敗しました。' });
    } finally {
      setIsBuildingUrl(false);
    }
  }, [favorites]);

  const handleCopySyncUrl = useCallback(async () => {
    if (!syncUrl) return;
    try {
      await navigator.clipboard.writeText(syncUrl);
      setUrlCopied(true);
      window.setTimeout(() => setUrlCopied(false), 2000);
    } catch {
      setStatus({ kind: 'error', text: 'コピーできませんでした。URLを長押しして選択してください。' });
    }
  }, [syncUrl]);

  const handleShareSyncUrl = useCallback(async () => {
    if (!syncUrl) return;
    const outcome = await shareOrCopyUrl({
      url: syncUrl,
      title: '3D RainScape お気に入りの引き継ぎ',
    });
    if (outcome === 'copied') {
      setUrlCopied(true);
      window.setTimeout(() => setUrlCopied(false), 2000);
    } else if (outcome === 'failed') {
      setStatus({ kind: 'error', text: '共有できませんでした。' });
    }
  }, [syncUrl]);

  /* ---------------- 読み込み ---------------- */

  const handleFileSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const items = await readBackupFile(file);
      setPendingImport({ items, sourceLabel: file.name });
      setImportMode('merge');
      setStatus(null);
    } catch (err) {
      setStatus({ kind: 'error', text: toErrorMessage(err) });
    }
  }, []);

  const handleReadPastedUrl = useCallback(async () => {
    const payload = extractFavoritesPayloadFromText(pasteText);
    if (!payload) {
      setStatus({
        kind: 'error',
        text: '同期URLが見つかりません。「#fav=」を含むURLを貼り付けてください。',
      });
      return;
    }
    try {
      const items = await decodeFavoritesPayload(payload);
      setPendingImport({ items, sourceLabel: '貼り付けた同期URL' });
      setImportMode('merge');
      setPasteText('');
      setStatus(null);
    } catch (err) {
      setStatus({ kind: 'error', text: toErrorMessage(err) });
    }
  }, [pasteText]);

  const handleConfirmImport = useCallback(() => {
    if (!pendingImport || !preview) return;
    saveFavoritesUndoSnapshot(favorites);
    setUndoSnapshot(loadFavoritesUndoSnapshot());
    onApplyFavorites(preview.next);
    const parts: string[] = [];
    if (preview.added) parts.push(`追加 ${preview.added}件`);
    if (preview.updated) parts.push(`更新 ${preview.updated}件`);
    if (preview.unchanged) parts.push(`変更なし ${preview.unchanged}件`);
    if (preview.removed) parts.push(`削除 ${preview.removed}件`);
    setStatus({
      kind: 'success',
      text: `取り込みが完了しました（${parts.join('・') || '変更なし'}）。現在 ${preview.next.length}件です。`,
    });
    setPendingImport(null);
  }, [favorites, onApplyFavorites, pendingImport, preview]);

  const handleUndo = useCallback(() => {
    const snapshot = loadFavoritesUndoSnapshot();
    if (!snapshot) return;
    onApplyFavorites(snapshot.items);
    clearFavoritesUndoSnapshot();
    setUndoSnapshot(null);
    setStatus({
      kind: 'info',
      text: `取り込み前の状態（${snapshot.items.length}件）に戻しました。`,
    });
  }, [onApplyFavorites]);

  const sectionClass = 'rounded-xl bg-slate-950/70 border border-slate-800 p-3 space-y-2.5';
  const primaryBtn =
    'inline-flex items-center justify-center gap-1.5 min-h-[40px] px-3 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="favorites-sync-title"
      style={{
        paddingTop: 'calc(var(--safe-top) + 0.75rem)',
        paddingBottom: 'calc(var(--safe-bottom) + 0.75rem)',
        paddingLeft: 'calc(var(--safe-left) + 0.75rem)',
        paddingRight: 'calc(var(--safe-right) + 0.75rem)',
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        style={{
          maxHeight: 'calc(100dvh - var(--safe-top) - var(--safe-bottom) - 1.5rem)',
        }}
        className="w-full max-w-md flex flex-col rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl text-slate-100 text-xs focus:outline-none select-text overflow-hidden"
      >
        {/* ダイアログ上部ヘッダー（スクロール時も常時固定して閉じられるよう sticky 配置） */}
        <div className="shrink-0 flex items-center justify-between px-4 sm:px-5 py-3 border-b border-slate-800 bg-slate-900/95 backdrop-blur-md">
          <h2
            id="favorites-sync-title"
            className="inline-flex items-center gap-1.5 text-sm font-bold text-white min-w-0"
          >
            <ArrowRightLeft className="w-4 h-4 text-amber-400 shrink-0" />
            <span className="truncate">お気に入りのバックアップ・引き継ぎ</span>
          </h2>
          <button
            type="button"
            aria-label="閉じる"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* ダイアログ本体（スクロール領域） */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-3">

        {status && (
          <div
            role={status.kind === 'error' ? 'alert' : 'status'}
            className={`rounded-xl px-3 py-2 border ${
              status.kind === 'error'
                ? 'bg-rose-500/10 border-rose-400/40 text-rose-200'
                : status.kind === 'success'
                  ? 'bg-emerald-500/10 border-emerald-400/40 text-emerald-200'
                  : 'bg-sky-500/10 border-sky-400/40 text-sky-200'
            }`}
          >
            {status.text}
          </div>
        )}

        {pendingImport && preview ? (
          /* ===== 取り込み確認 ===== */
          <div className={sectionClass}>
            <div className="text-sm font-bold text-amber-200">
              {pendingImport.items.length}件のお気に入りが見つかりました
            </div>
            <div className="text-slate-400 truncate">読み込み元: {pendingImport.sourceLabel}</div>

            <ul className="max-h-28 overflow-y-auto rounded-lg bg-slate-900/80 border border-slate-800 px-2.5 py-1.5 space-y-0.5">
              {pendingImport.items.slice(0, 50).map((item, i) => (
                <li key={`${item.id}-${i}`} className="truncate text-slate-200">
                  ⭐ {item.name}
                </li>
              ))}
              {pendingImport.items.length > 50 && (
                <li className="text-slate-500">ほか {pendingImport.items.length - 50}件</li>
              )}
            </ul>

            <fieldset className="space-y-1.5">
              <legend className="sr-only">取り込み方法</legend>
              {(
                [
                  {
                    value: 'merge',
                    label: '追加（おすすめ）',
                    desc: '今のお気に入りを残したまま追加します。同じ地点は新しい方で更新します。',
                  },
                  {
                    value: 'replace',
                    label: '置き換え',
                    desc: '今のお気に入りを消して、読み込んだ内容に入れ替えます。',
                  },
                ] as const
              ).map((opt) => (
                <label
                  key={opt.value}
                  className={`flex items-start gap-2 rounded-lg border px-2.5 py-2 cursor-pointer ${
                    importMode === opt.value
                      ? 'border-amber-400/60 bg-amber-500/10'
                      : 'border-slate-700 hover:bg-slate-800/60'
                  }`}
                >
                  <input
                    type="radio"
                    name="favorites-import-mode"
                    value={opt.value}
                    checked={importMode === opt.value}
                    onChange={() => setImportMode(opt.value)}
                    className="mt-0.5 accent-amber-400"
                  />
                  <span className="space-y-0.5">
                    <span className="block font-bold text-slate-100">{opt.label}</span>
                    <span className="block text-slate-400">{opt.desc}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            <div className="rounded-lg bg-slate-900/80 border border-slate-800 px-2.5 py-2 text-slate-300">
              取り込み後: <strong className="text-white">{preview.next.length}件</strong>（新規{' '}
              {preview.added}件・更新 {preview.updated}件・変更なし {preview.unchanged}件
              {importMode === 'replace' && preview.removed > 0 && (
                <span className="text-rose-300">・削除 {preview.removed}件</span>
              )}
              ）
              {preview.truncated > 0 && (
                <div className="mt-1 text-amber-300">
                  上限（{MAX_FAVORITES}件）を超えるため {preview.truncated}件は取り込まれません。
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setPendingImport(null)}
                className={`${primaryBtn} bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200`}
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={handleConfirmImport}
                className={`${primaryBtn} ${
                  importMode === 'replace'
                    ? 'bg-rose-500/80 hover:bg-rose-500 text-white'
                    : 'bg-amber-500/90 hover:bg-amber-500 text-slate-950'
                }`}
              >
                {importMode === 'replace' ? '置き換える' : '追加する'}
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* ===== 1. バックアップ（JSONファイル） ===== */}
            <section className={sectionClass} aria-labelledby="fav-sync-backup-heading">
              <div>
                <h3 id="fav-sync-backup-heading" className="font-bold text-slate-100 text-[13px]">
                  📁 バックアップ（JSONファイル）
                </h3>
                <p className="text-slate-400 mt-0.5">
                  お気に入り {favorites.length}件をファイルに保存します。機種変更やデータ消失に備えて定期的に保存してください。
                </p>
                <p className="text-slate-500 mt-0.5">
                  最終バックアップ: {formatDateTime(lastBackupAt) || 'まだ保存していません'}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={handleExportFile}
                  disabled={favorites.length === 0}
                  className={`${primaryBtn} bg-sky-500/25 hover:bg-sky-500/35 border border-sky-400/50 text-sky-100`}
                >
                  <Download className="w-4 h-4" />
                  ファイルに保存
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className={`${primaryBtn} bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100`}
                >
                  <FileUp className="w-4 h-4" />
                  ファイルから復元
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={handleFileSelected}
                />
              </div>
            </section>

            {/* ===== 2. 他の端末へ送る（QR / URL） ===== */}
            <section className={sectionClass} aria-labelledby="fav-sync-send-heading">
              <div>
                <h3 id="fav-sync-send-heading" className="font-bold text-slate-100 text-[13px]">
                  📱 他の端末へ送る（QRコード / URL）
                </h3>
                <p className="text-slate-400 mt-0.5">
                  お気に入り全件を1本のURLにまとめます。別の端末でQRを読み取るか、URLを開くと取り込めます。
                </p>
              </div>

              {!syncUrl ? (
                <button
                  type="button"
                  onClick={handleBuildSyncUrl}
                  disabled={favorites.length === 0 || isBuildingUrl}
                  className={`${primaryBtn} w-full bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/50 text-amber-100`}
                >
                  <QrCodeIcon className="w-4 h-4" />
                  {isBuildingUrl ? '作成中…' : 'QRコードとURLを作成'}
                </button>
              ) : (
                <div className="space-y-2.5">
                  <div className="flex justify-center">
                    <QrCode text={syncUrl} size={232} />
                  </div>
                  {syncUrl.length > QR_DENSE_THRESHOLD && (
                    <p className="text-amber-300">
                      件数が多くQRコードが細かくなっています。読み取りにくい場合はURLを送ってください。
                    </p>
                  )}
                  <div className="rounded-lg bg-slate-900/80 border border-slate-800 px-2.5 py-1.5 font-mono text-[10px] text-slate-400 break-all max-h-16 overflow-y-auto">
                    {syncUrl}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={handleCopySyncUrl}
                      className={`${primaryBtn} ${
                        urlCopied
                          ? 'bg-emerald-500/25 border border-emerald-400/50 text-emerald-100'
                          : 'bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100'
                      }`}
                    >
                      {urlCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                      {urlCopied ? 'コピーしました' : 'URLをコピー'}
                    </button>
                    <button
                      type="button"
                      onClick={handleShareSyncUrl}
                      className={`${primaryBtn} bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100`}
                    >
                      <Share2 className="w-4 h-4" />
                      共有
                    </button>
                  </div>
                  <p className="text-slate-500">
                    ※ このURLを知っている人は誰でもお気に入りを取り込めます。送り先にご注意ください。
                  </p>
                </div>
              )}
            </section>

            {/* ===== 3. 同期URLを貼り付けて取り込む ===== */}
            <section className={sectionClass} aria-labelledby="fav-sync-paste-heading">
              <h3 id="fav-sync-paste-heading" className="font-bold text-slate-100 text-[13px]">
                🔗 受け取った同期URLを貼り付ける
              </h3>
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder="https://3d-rain-viewer.bamboosato.com/#fav=..."
                rows={2}
                className="w-full rounded-xl bg-slate-900/90 border border-slate-700/90 px-3 py-2 text-base sm:text-xs text-slate-100 font-mono focus:outline-none focus:ring-2 focus:ring-sky-400 resize-none"
              />
              <button
                type="button"
                onClick={handleReadPastedUrl}
                disabled={!pasteText.trim()}
                className={`${primaryBtn} w-full bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100`}
              >
                <ClipboardPaste className="w-4 h-4" />
                読み込む
              </button>
            </section>

            {undoSnapshot && (
              <button
                type="button"
                onClick={handleUndo}
                className={`${primaryBtn} w-full bg-transparent hover:bg-slate-800 border border-dashed border-slate-600 text-slate-300`}
              >
                <RotateCcw className="w-4 h-4" />
                直前の取り込みを元に戻す（{formatDateTime(undoSnapshot.savedAt)}・
                {undoSnapshot.items.length}件の状態へ）
              </button>
            )}
          </>
        )}
        </div>
      </div>
    </div>
  );
};
