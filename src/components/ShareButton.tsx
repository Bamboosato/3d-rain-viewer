import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Share2 } from 'lucide-react';
import { getShareableCustomDomainUrl } from '../lib/urlSync';

interface ShareButtonProps {
  /** 共有実行直前にデバウンス中のURL状態を即時フラッシュするためのコールバック */
  onFlushUrlState?: () => void;
}

const SHARE_TITLE = '3D RainScape - リアルタイム雨雲×3D地形ビューア';

export const ShareButton: React.FC<ShareButtonProps> = ({ onFlushUrlState }) => {
  const [showToast, setShowToast] = useState<boolean>(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const triggerToast = useCallback(() => {
    setShowToast(true);
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      setShowToast(false);
      timerRef.current = null;
    }, 2000);
  }, []);

  const copyToClipboard = useCallback(async (text: string): Promise<boolean> => {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // フォールバックへ進む
      }
    }
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      return true;
    } catch {
      return false;
    }
  }, []);

  const handleShare = useCallback(async () => {
    onFlushUrlState?.();
    const shareUrl = getShareableCustomDomainUrl();

    // モバイル端末等でネイティブシェアシートが利用可能な場合は優先呼び出し
    const isMobileDevice =
      typeof navigator !== 'undefined' &&
      /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

    if (isMobileDevice && typeof navigator.share === 'function') {
      try {
        await navigator.share({
          title: SHARE_TITLE,
          url: shareUrl,
        });
        return;
      } catch (err) {
        // ユーザーによるキャンセル(AbortError)時は何もしない
        if (err instanceof Error && err.name === 'AbortError') {
          return;
        }
        // それ以外の失敗時はクリップボードコピーへフォールバック
      }
    }

    const copied = await copyToClipboard(shareUrl);
    if (copied) {
      triggerToast();
    }
  }, [onFlushUrlState, copyToClipboard, triggerToast]);

  return (
    <>
      <button
        id="share-view-btn"
        type="button"
        onClick={handleShare}
        onDoubleClick={(e) => e.preventDefault()}
        title="現在の3D視点・時刻を共有"
        aria-label="現在の3D視点・時刻を共有"
        className={`inline-flex items-center justify-center gap-1.5 w-[38px] h-[38px] sm:w-auto sm:min-h-[42px] sm:px-3.5 py-1.5 rounded-xl backdrop-blur-md border shadow-lg text-xs sm:text-sm font-bold transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 shrink-0 ${
          showToast
            ? 'bg-emerald-500/25 border-emerald-400/60 text-emerald-200'
            : 'bg-slate-900/90 hover:bg-slate-800 border-slate-700/80 text-slate-100'
        }`}
      >
        {showToast ? (
          <Check className="w-4 h-4 text-emerald-400 shrink-0" />
        ) : (
          <Share2 className="w-4 h-4 text-sky-400 shrink-0" />
        )}
        <span className="hidden sm:inline">{showToast ? 'コピー済' : '共有'}</span>
      </button>

      {/* 画面上部トースト通知（2秒間フェード表示） */}
      <div
        id="share-toast"
        role="status"
        aria-live="polite"
        className={`pointer-events-none fixed top-16 sm:top-20 left-1/2 -translate-x-1/2 z-50 transition-all duration-300 ${
          showToast
            ? 'opacity-100 translate-y-0'
            : 'opacity-0 -translate-y-2'
        }`}
      >
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-slate-900/95 border border-emerald-400/60 shadow-2xl text-xs sm:text-sm font-bold text-emerald-200 backdrop-blur-md whitespace-nowrap">
          <Check className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>共有リンクをコピーしました！</span>
        </div>
      </div>
    </>
  );
};
