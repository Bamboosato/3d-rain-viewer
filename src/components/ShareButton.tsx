import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronUp, ClipboardPaste, Link2, Share2, X } from 'lucide-react';
import {
  DEFAULT_SHARE_TITLE,
  extractUrlViewStateFromText,
  getShareableCustomDomainUrl,
  shareOrCopyUrl,
  type UrlViewState,
} from '../lib/urlSync';
import { runViewTransition } from '../lib/viewTransition';

interface ShareButtonProps {
  /** 共有実行直前にデバウンス中のURL状態を即時フラッシュするためのコールバック */
  onFlushUrlState?: () => void;
  /** インスペクターやお気に入り一覧から共有コピーされた際の外部トースト表示トリガー */
  externalToastVersion?: number;
  /** 共有URLを読み込んだ際にカメラ・地点名・時刻等を反映するコールバック */
  onImportUrlState?: (urlState: UrlViewState) => void;
  /** 上部パネル開閉状態（PresetNav / LayerMenu と排他制御） */
  isOpen?: boolean;
  onToggleOpen?: () => void;
}

export const ShareButton: React.FC<ShareButtonProps> = ({
  onFlushUrlState,
  externalToastVersion = 0,
  onImportUrlState,
  isOpen: controlledIsOpen,
  onToggleOpen,
}) => {
  const [internalIsOpen, setInternalIsOpen] = useState<boolean>(false);
  const isOpen = controlledIsOpen ?? internalIsOpen;

  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [showPasteBox, setShowPasteBox] = useState<boolean>(false);
  const [pasteInput, setPasteInput] = useState<string>('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const closeMenu = useCallback(() => {
    setShowPasteBox(false);
    setPasteInput('');
    setPasteError(null);
    if (controlledIsOpen !== undefined) {
      if (controlledIsOpen) {
        onToggleOpen?.();
      }
    } else {
      setInternalIsOpen(false);
    }
  }, [controlledIsOpen, onToggleOpen]);

  const handleToggleMenu = useCallback(() => {
    setShowPasteBox(false);
    setPasteInput('');
    setPasteError(null);
    if (onToggleOpen) {
      onToggleOpen();
      return;
    }
    runViewTransition(() => {
      setInternalIsOpen((prev) => !prev);
    });
  }, [onToggleOpen]);

  const triggerToast = useCallback((message: string) => {
    setToastMessage(message);
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      setToastMessage(null);
      timerRef.current = null;
    }, 2200);
  }, []);

  useEffect(() => {
    if (externalToastVersion > 0) {
      triggerToast('共有リンクをコピーしました！');
    }
  }, [externalToastVersion, triggerToast]);

  useEffect(() => {
    if (!isOpen) {
      setShowPasteBox(false);
      setPasteInput('');
      setPasteError(null);
    }
  }, [isOpen]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  // 1. 「この画面を共有」
  const handleShareScreen = useCallback(async () => {
    onFlushUrlState?.();
    const shareUrl = getShareableCustomDomainUrl();
    closeMenu();
    const outcome = await shareOrCopyUrl({
      url: shareUrl,
      title: DEFAULT_SHARE_TITLE,
    });
    if (outcome === 'copied') {
      triggerToast('共有リンクをコピーしました！');
    }
  }, [onFlushUrlState, closeMenu, triggerToast]);

  // 共有URL文字列を解析して適用
  const applyUrlText = useCallback(
    (rawText: string): boolean => {
      const state = extractUrlViewStateFromText(rawText);
      if (!state) return false;
      onImportUrlState?.(state);
      closeMenu();
      triggerToast(
        state.spotName
          ? `「${state.spotName}」を読み込みました！`
          : '共有URLの視点を読み込みました！'
      );
      return true;
    },
    [onImportUrlState, closeMenu, triggerToast]
  );

  // 2. 「共有URLを読み込む」（まずクリップボード自動読取を試み、不可またはURL外なら貼り付け欄を表示）
  const handleLoadSharedUrlClick = useCallback(async () => {
    setPasteError(null);
    if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
      try {
        const clipText = await navigator.clipboard.readText();
        if (clipText && applyUrlText(clipText)) {
          return;
        }
      } catch {
        // iOS等でクリップボード読取権限が拒否または未対応の場合はペースト入力欄へフォールバック
      }
    }
    setShowPasteBox(true);
  }, [applyUrlText]);

  const handlePasteSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!applyUrlText(pasteInput)) {
      setPasteError('有効な共有URLが見つかりません');
    }
  };

  const showToast = toastMessage !== null;

  return (
    <div className="pointer-events-auto relative flex items-center shrink-0">
      <button
        id="share-view-btn"
        type="button"
        onClick={handleToggleMenu}
        onDoubleClick={(e) => e.preventDefault()}
        aria-expanded={isOpen}
        aria-controls="share-menu-panel"
        title="この画面を共有 / 共有URLを読み込む"
        aria-label="共有メニューを開く"
        className={`inline-flex items-center justify-center gap-1 sm:gap-1.5 min-w-[38px] min-h-[38px] sm:min-h-[42px] px-2.5 sm:px-3.5 py-1.5 rounded-xl backdrop-blur-md border shadow-lg text-xs sm:text-sm font-bold transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 shrink-0 ${
          showToast
            ? 'bg-emerald-500/25 border-emerald-400/60 text-emerald-200'
            : isOpen
              ? 'bg-sky-500/25 border-sky-400/60 text-sky-100'
              : 'bg-slate-900/90 hover:bg-slate-800 border-slate-700/80 text-slate-100'
        }`}
      >
        {showToast ? (
          <Check className="w-4 h-4 text-emerald-400 shrink-0" />
        ) : (
          <Share2 className="w-4 h-4 text-sky-400 shrink-0" />
        )}
        <span className="hidden sm:inline">{showToast ? '完了' : '共有'}</span>
        <ChevronUp
          className={`hidden sm:inline w-3.5 h-3.5 text-slate-400 transition-transform duration-200 shrink-0 ${
            isOpen ? 'rotate-0' : 'rotate-180'
          }`}
        />
      </button>

      {/* 2択ミニメニュー（この画面を共有 / 共有URLを読み込む） */}
      {isOpen && (
        <div
          id="share-menu-panel"
          role="menu"
          aria-label="共有メニュー"
          className="safe-top-dropdown fixed right-3 sm:right-14 z-30 rounded-2xl bg-slate-900/95 backdrop-blur-md border border-slate-700/80 shadow-2xl p-2.5 text-slate-100 w-64 sm:w-72 space-y-1.5"
        >
          <button
            type="button"
            id="share-menu-current-screen-btn"
            role="menuitem"
            onClick={handleShareScreen}
            className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/40 text-left text-xs sm:text-sm font-bold text-sky-100 transition-colors cursor-pointer"
          >
            <Share2 className="w-4 h-4 text-sky-400 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="truncate">この画面を共有</div>
              <div className="text-[11px] font-normal text-sky-200/80 truncate">
                現在の3D視点・時刻のURLを発行
              </div>
            </div>
          </button>

          <button
            type="button"
            id="share-menu-import-url-btn"
            role="menuitem"
            onClick={handleLoadSharedUrlClick}
            className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-slate-800/80 hover:bg-slate-800 border border-slate-700/80 text-left text-xs sm:text-sm font-bold text-slate-100 transition-colors cursor-pointer"
          >
            <ClipboardPaste className="w-4 h-4 text-emerald-400 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="truncate">共有URLを読み込む</div>
              <div className="text-[11px] font-normal text-slate-400 truncate">
                コピーした共有リンクをアプリ内で開く
              </div>
            </div>
          </button>

          {/* クリップボード自動読取が許可されない環境（iOS等）向けのペースト入力欄 */}
          {showPasteBox && (
            <form
              onSubmit={handlePasteSubmit}
              className="pt-2 mt-1 border-t border-slate-800 space-y-2"
            >
              <div className="flex items-center justify-between text-xs text-emerald-300 font-semibold px-0.5">
                <span className="inline-flex items-center gap-1 truncate">
                  <Link2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>共有URLを貼り付け</span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setShowPasteBox(false);
                    setPasteError(null);
                  }}
                  aria-label="貼り付け欄を閉じる"
                  className="text-slate-400 hover:text-white p-0.5 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="flex items-center gap-1.5">
                <input
                  id="share-url-paste-input"
                  type="url"
                  value={pasteInput}
                  onChange={(e) => {
                    setPasteInput(e.target.value);
                    setPasteError(null);
                  }}
                  onPaste={(e) => {
                    const pasted = e.clipboardData.getData('text');
                    if (pasted && applyUrlText(pasted)) {
                      e.preventDefault();
                    }
                  }}
                  placeholder="https://3d-rain-viewer.bamboosato.com/?..."
                  aria-label="共有URLを貼り付け"
                  autoFocus
                  className="flex-1 min-w-0 rounded-xl bg-slate-950/90 border border-slate-700 focus:border-emerald-400 px-2.5 py-1.5 text-base sm:text-xs text-white placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                />
                <button
                  type="submit"
                  className="px-3 py-1.5 min-h-[34px] rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs cursor-pointer shrink-0"
                >
                  開く
                </button>
              </div>

              {pasteError && (
                <div className="text-[11px] text-rose-300 px-0.5 truncate">
                  {pasteError}
                </div>
              )}
            </form>
          )}
        </div>
      )}

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
          <span>{toastMessage ?? '共有リンクをコピーしました！'}</span>
        </div>
      </div>
    </div>
  );
};

