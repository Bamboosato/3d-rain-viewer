import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Share2 } from 'lucide-react';
import {
  DEFAULT_SHARE_TITLE,
  getShareableCustomDomainUrl,
  shareOrCopyUrl,
} from '../lib/urlSync';

interface ShareButtonProps {
  /** 共有実行直前にデバウンス中のURL状態を即時フラッシュするためのコールバック */
  onFlushUrlState?: () => void;
  /** インスペクターやお気に入り一覧から共有コピーされた際の外部トースト表示トリガー */
  externalToastVersion?: number;
}

export const ShareButton: React.FC<ShareButtonProps> = ({
  onFlushUrlState,
  externalToastVersion = 0,
}) => {
  const [showToast, setShowToast] = useState<boolean>(false);
  const timerRef = useRef<number | null>(null);

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

  useEffect(() => {
    if (externalToastVersion > 0) {
      triggerToast();
    }
  }, [externalToastVersion, triggerToast]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const handleShare = useCallback(async () => {
    onFlushUrlState?.();
    const shareUrl = getShareableCustomDomainUrl();
    const outcome = await shareOrCopyUrl({
      url: shareUrl,
      title: DEFAULT_SHARE_TITLE,
    });
    if (outcome === 'copied') {
      triggerToast();
    }
  }, [onFlushUrlState, triggerToast]);

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
