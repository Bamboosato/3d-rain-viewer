import { useUpdateBlocker } from '../lib/updateGuard';
import React, { useEffect, useRef, useState } from 'react';
import {
  MapPin,
  X,
  Mountain,
  CloudRain,
  Navigation2,
  Star,
  Trash2,
  Check,
  Loader2,
  Sparkles,
  Share2,
} from 'lucide-react';
import type { InspectorPoint, PresetLocation } from '../types/map';
import { fetchOsmPlaceCandidates, type OsmPlaceCandidate } from '../lib/osmPlaceClient';
import {
  FAVORITE_CATEGORY_LIST,
  type FavoriteCategory,
} from '../lib/favoriteCategories';

interface InspectorProps {
  point: InspectorPoint | null;
  onClose: () => void;
  matchedFavorite?: PresetLocation | null;
  onSaveFavorite?: (name: string, category: FavoriteCategory) => void | Promise<any>;
  onRemoveFavorite?: (id: string) => void | Promise<any>;
  onSharePoint?: (pointName: string) => void;
}

function getRainfallIntensityInfo(mmPerHour: number | null): {
  label: string;
  badgeClass: string;
} {
  if (mmPerHour === null) {
    return {
      label: '欠測 / 取得不可',
      badgeClass: 'bg-slate-800/80 border-slate-700/80 text-slate-400',
    };
  }
  if (mmPerHour >= 80) {
    return {
      label: '猛烈な雨',
      badgeClass: 'bg-fuchsia-500/25 border-fuchsia-400/50 text-fuchsia-200',
    };
  }
  if (mmPerHour >= 50) {
    return {
      label: '非常に激しい雨',
      badgeClass: 'bg-red-500/25 border-red-400/50 text-red-200',
    };
  }
  if (mmPerHour >= 20) {
    return {
      label: '激しい雨',
      badgeClass: 'bg-orange-500/25 border-orange-400/50 text-orange-200',
    };
  }
  if (mmPerHour >= 10) {
    return {
      label: 'やや強い雨',
      badgeClass: 'bg-yellow-500/25 border-yellow-400/50 text-yellow-200',
    };
  }
  if (mmPerHour >= 5) {
    return {
      label: '強い雨',
      badgeClass: 'bg-emerald-500/25 border-emerald-400/50 text-emerald-200',
    };
  }
  if (mmPerHour >= 1) {
    return {
      label: '弱い〜並の雨',
      badgeClass: 'bg-blue-500/25 border-blue-400/50 text-blue-200',
    };
  }
  if (mmPerHour >= 0.1) {
    return {
      label: '小雨・雨雲域',
      badgeClass: 'bg-sky-500/25 border-sky-400/50 text-sky-200',
    };
  }
  return {
    label: '降水なし',
    badgeClass: 'bg-slate-800 border-slate-700 text-slate-300',
  };
}

function getSuggestedFavoriteName(point: InspectorPoint): string {
  if (point.label) {
    const cleaned = point.label
      .replace(/^[^\p{L}\p{N}]+\s*/u, '')
      .replace(/（山頂）$/, '')
      .trim();
    if (cleaned) return cleaned;
  }
  return `登録地点 (${point.lat.toFixed(2)}°N, ${point.lng.toFixed(2)}°E)`;
}

export const Inspector: React.FC<InspectorProps> = ({
  point,
  onClose,
  matchedFavorite = null,
  onSaveFavorite,
  onRemoveFavorite,
  onSharePoint,
}) => {
  const [isEditingFav, setIsEditingFav] = useState<boolean>(false);
  const [isSavingFav, setIsSavingFav] = useState<boolean>(false);
  useUpdateBlocker(isEditingFav || isSavingFav);
  const [favSaveError, setFavSaveError] = useState<string | null>(null);
  const [favNameInput, setFavNameInput] = useState<string>('');
  const [favCategoryInput, setFavCategoryInput] = useState<FavoriteCategory>('nature');
  const [osmCandidates, setOsmCandidates] = useState<OsmPlaceCandidate[]>([]);
  const [isLoadingOsm, setIsLoadingOsm] = useState<boolean>(false);
  const [isShareCopied, setIsShareCopied] = useState<boolean>(false);
  const [cardHeight, setCardHeight] = useState<number>(0);
  const [viewport, setViewport] = useState<{ width: number; height: number }>(() => ({
    width: typeof window !== 'undefined' ? window.innerWidth : 1280,
    height: typeof window !== 'undefined' ? window.innerHeight : 800,
  }));
  const cardRef = useRef<HTMLDivElement | null>(null);
  const hasUserEditedRef = useRef<boolean>(false);

  // ウィンドウリサイズ追従
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleResize = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // インスペクターカード自身の高さ変化（お気に入り編集展開・OSM候補チップ描画時）をリアルタイム計測
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const updateHeight = () => {
      setCardHeight(el.offsetHeight);
    };
    updateHeight();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => updateHeight());
      observer.observe(el);
      return () => observer.disconnect();
    }
  }, [point, isEditingFav, osmCandidates.length, isLoadingOsm]);

  // 選択地点が変わったら入力フォームをリセットし、初期候補名をセット
  useEffect(() => {
    setIsEditingFav(false);
    setOsmCandidates([]);
    setIsLoadingOsm(false);
    setIsShareCopied(false);
    hasUserEditedRef.current = false;
    if (point) {
      setFavNameInput(matchedFavorite?.name ?? getSuggestedFavoriteName(point));
    }
  }, [point?.lng, point?.lat, point?.label, matchedFavorite?.id, matchedFavorite?.name]);

  // お気に入り編集フォームが開かれた時点で OpenStreetMap (Overpass + Nominatim) から施設・地名候補を取得
  useEffect(() => {
    if (!isEditingFav || !point) return;

    const controller = new AbortController();
    setIsLoadingOsm(true);

    const applyCandidates = (candidates: OsmPlaceCandidate[]) => {
      setOsmCandidates(candidates);
      // 初期値が汎用座標名（「登録地点 (...)」）で、かつユーザーがまだ手入力していない場合は第1候補を自動セット
      if (
        candidates.length > 0 &&
        !hasUserEditedRef.current &&
        !matchedFavorite &&
        !point.label
      ) {
        setFavNameInput(candidates[0].name);
      }
    };

    fetchOsmPlaceCandidates(point.lat, point.lng, {
      signal: controller.signal,
      onPartialUpdate: applyCandidates,
    })
      .then((finalCandidates) => {
        if (!controller.signal.aborted) {
          applyCandidates(finalCandidates);
          setIsLoadingOsm(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setIsLoadingOsm(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [isEditingFav, point?.lat, point?.lng, point?.label, matchedFavorite]);

  if (!point) return null;

  const rainVal = point.precipitation;
  const intensity = getRainfallIntensityInfo(rainVal);

  // PC画面ではクリック地点の近傍に配置しつつ、上部ヘッダー（72px）および下部タイムラインバー（116px）と絶対に重ならないようクランプ
  const hasScreenPos =
    typeof point.screenX === 'number' &&
    typeof point.screenY === 'number' &&
    viewport.width >= 768;

  const TOP_SAFE_OFFSET = 72;
  const BOTTOM_TIMELINE_RESERVE = 116;
  const SIDE_SAFE_OFFSET = 20;
  const CARD_WIDTH = 320;

  const estimatedHeight = isEditingFav ? 420 : 220;
  const effectiveCardHeight = cardHeight > 0 ? cardHeight : estimatedHeight;

  let clampedLeft: number | undefined;
  let clampedTop: number | undefined;

  if (hasScreenPos) {
    const sx = point.screenX!;
    const sy = point.screenY!;
    // クリック地点の右側に十分な余白があれば右側、なければ左側へ配置して選択マーカー隠れも防ぐ
    const preferRight = sx + 22;
    const preferLeft = sx - CARD_WIDTH - 22;
    const rawLeft =
      preferRight + CARD_WIDTH <= viewport.width - SIDE_SAFE_OFFSET
        ? preferRight
        : preferLeft >= SIDE_SAFE_OFFSET
          ? preferLeft
          : preferRight;

    clampedLeft = Math.min(
      Math.max(rawLeft, SIDE_SAFE_OFFSET),
      Math.max(SIDE_SAFE_OFFSET, viewport.width - CARD_WIDTH - SIDE_SAFE_OFFSET)
    );

    const maxAllowedTop = Math.max(
      TOP_SAFE_OFFSET,
      viewport.height - effectiveCardHeight - BOTTOM_TIMELINE_RESERVE
    );
    clampedTop = Math.min(Math.max(sy - 60, TOP_SAFE_OFFSET), maxAllowedTop);
  }

  const handleSaveSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = favNameInput.trim() || getSuggestedFavoriteName(point);
    setIsSavingFav(true);
    setFavSaveError(null);
    try {
      const res = await onSaveFavorite?.(trimmed, favCategoryInput);
      if (res && typeof res === 'object' && res.success === false) {
        setFavSaveError(res.message || '保存に失敗しました。');
      } else {
        setIsEditingFav(false);
      }
    } catch {
      setFavSaveError('保存処理中にエラーが発生しました。');
    } finally {
      setIsSavingFav(false);
    }
  };

  const handleShareClick = () => {
    if (!onSharePoint) return;
    const shareName =
      matchedFavorite?.name ||
      (isEditingFav && favNameInput.trim() ? favNameInput.trim() : '') ||
      getSuggestedFavoriteName(point);
    onSharePoint(shareName);
    setIsShareCopied(true);
    window.setTimeout(() => setIsShareCopied(false), 2000);
  };

  return (
    <div
      ref={cardRef}
      id="point-inspector-card"
      role="region"
      aria-label="地点インスペクター"
      style={
        hasScreenPos
          ? {
              position: 'fixed',
              left: `${clampedLeft}px`,
              top: `${clampedTop}px`,
            }
          : {
              position: 'fixed',
              right: 'calc(env(safe-area-inset-right, 0px) + 10px)',
              bottom: 'calc(env(safe-area-inset-bottom, 0px) * 0.6 + 104px)',
            }
      }
      className="vt-inspector-card pointer-events-auto rounded-2xl bg-slate-900/95 backdrop-blur-md border border-sky-400/60 shadow-2xl p-4 text-slate-100 w-72 sm:w-80 max-h-[calc(100dvh-188px)] overflow-y-auto space-y-3"
    >
      {/* ヘッダー（タイトル＋座標＋閉じるボタン） */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <MapPin className="w-4 h-4 text-sky-400 shrink-0" />
            <span
              id="inspector-point-label"
              className="text-sm font-bold text-white truncate"
            >
              {point.label || '選択地点'}
            </span>
          </div>
          <div className="flex items-center gap-1 mt-1 text-xs text-slate-400 font-mono truncate">
            <Navigation2 className="w-3 h-3 text-slate-500 shrink-0" />
            <span>
              {point.lat.toFixed(4)}°N, {point.lng.toFixed(4)}°E
            </span>
          </div>
        </div>
        <button
          type="button"
          id="inspector-close-btn"
          onClick={onClose}
          aria-label="インスペクターを閉じる"
          className="inline-flex items-center justify-center w-8 h-8 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 shrink-0 -mr-1 -mt-1"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 標高 & 雨量（2カラム・大きめフォントで視認性向上） */}
      <div className="grid grid-cols-2 gap-2.5">
        <div className="rounded-xl bg-amber-500/15 border border-amber-400/35 px-3 py-2.5">
          <div className="flex items-center gap-1 text-xs text-amber-300 font-semibold truncate">
            <Mountain className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span>標高</span>
          </div>
          <div
            id="inspector-elevation-value"
            className="font-mono text-base font-bold text-amber-100 mt-1 truncate"
          >
            {point.elevation !== null ? `${point.elevation.toLocaleString()} m` : '計測中...'}
          </div>
        </div>

        <div className={`rounded-xl border px-3 py-2.5 ${intensity.badgeClass}`}>
          <div className="flex items-center justify-between gap-1 text-xs font-semibold">
            <span className="inline-flex items-center gap-1 truncate">
              <CloudRain className="w-3.5 h-3.5 shrink-0" />
              <span>雨量</span>
            </span>
            <span className="text-[11px] opacity-90 truncate">{intensity.label}</span>
          </div>
          <div id="inspector-rain-value" className="font-mono text-base font-bold mt-1 truncate">
            {rainVal !== null ? (<>{rainVal.toFixed(1)} <span className="text-xs font-normal">mm/h</span></>) : (<span className="text-sm font-normal text-slate-400">欠測 (-- mm/h)</span>)}
          </div>
        </div>
      </div>

      {/* お気に入り登録・編集・地点共有エリア */}
      {onSaveFavorite && (
        <div className="pt-1">
          {!isEditingFav && !matchedFavorite && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                id="inspector-fav-open-btn"
                onClick={() => {
                  hasUserEditedRef.current = false;
                  setFavNameInput(getSuggestedFavoriteName(point));
                  setFavCategoryInput('nature');
                  setIsEditingFav(true);
                }}
                className="flex-1 inline-flex items-center justify-center gap-1.5 min-h-[40px] px-3 py-2 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/40 text-amber-200 text-sm font-bold transition-colors cursor-pointer truncate"
              >
                <Star className="w-4 h-4 text-amber-400 shrink-0" />
                <span className="truncate">お気に入りに追加</span>
              </button>

              {onSharePoint && (
                <button
                  type="button"
                  id="inspector-share-btn"
                  onClick={handleShareClick}
                  title="この地点を共有"
                  aria-label="この地点を共有"
                  className={`inline-flex items-center justify-center w-10 h-10 rounded-xl border transition-colors cursor-pointer shrink-0 ${
                    isShareCopied
                      ? 'bg-emerald-500/25 border-emerald-400/60 text-emerald-300'
                      : 'bg-sky-500/20 hover:bg-sky-500/30 border-sky-400/40 text-sky-300'
                  }`}
                >
                  {isShareCopied ? (
                    <Check className="w-4 h-4" />
                  ) : (
                    <Share2 className="w-4 h-4" />
                  )}
                </button>
              )}
            </div>
          )}

          {!isEditingFav && matchedFavorite && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                id="inspector-fav-edit-btn"
                onClick={() => {
                  hasUserEditedRef.current = false;
                  setFavNameInput(matchedFavorite.name);
                  setFavCategoryInput(matchedFavorite.category ?? 'other');
                  setIsEditingFav(true);
                }}
                title="現在の視点で更新、または名前を変更"
                className="flex-1 inline-flex items-center justify-center gap-1.5 min-h-[40px] px-3 py-2 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/50 text-amber-200 text-sm font-bold truncate cursor-pointer"
              >
                <Star className="w-4 h-4 text-amber-400 fill-amber-400 shrink-0" />
                <span className="truncate">名前・視点を更新</span>
              </button>

              {onSharePoint && (
                <button
                  type="button"
                  id="inspector-share-btn"
                  onClick={handleShareClick}
                  title={`「${matchedFavorite.name}」を共有`}
                  aria-label={`「${matchedFavorite.name}」を共有`}
                  className={`inline-flex items-center justify-center w-10 h-10 rounded-xl border transition-colors cursor-pointer shrink-0 ${
                    isShareCopied
                      ? 'bg-emerald-500/25 border-emerald-400/60 text-emerald-300'
                      : 'bg-sky-500/20 hover:bg-sky-500/30 border-sky-400/40 text-sky-300'
                  }`}
                >
                  {isShareCopied ? (
                    <Check className="w-4 h-4" />
                  ) : (
                    <Share2 className="w-4 h-4" />
                  )}
                </button>
              )}

              {onRemoveFavorite && (
                <button
                  type="button"
                  id="inspector-fav-remove-btn"
                  onClick={() => onRemoveFavorite(matchedFavorite.id)}
                  title="お気に入りから削除"
                  aria-label="お気に入りから削除"
                  className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-rose-500/20 hover:bg-rose-500/30 border border-rose-400/40 text-rose-300 transition-colors cursor-pointer shrink-0"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          )}

          {isEditingFav && (
            <form onSubmit={handleSaveSubmit} className="space-y-2.5 pt-1 border-t border-slate-800">
              <div className="text-xs text-amber-300 font-semibold truncate">
                ⭐ 地点名（現在の視点も保存）
              </div>
              <input
                id="inspector-fav-name-input"
                type="text"
                value={favNameInput}
                onChange={(e) => {
                  hasUserEditedRef.current = true;
                  setFavNameInput(e.target.value);
                }}
                placeholder="地点名を入力"
                aria-label="お気に入り地点の名前"
                autoFocus
                className="w-full rounded-xl bg-slate-950/90 border border-amber-400/50 px-3 py-2 text-base sm:text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-400"
              />

              {/* カテゴリ選択（4カテゴリ横並びピル型ボタングループ） */}
              <div className="space-y-1">
                <div className="text-[11px] text-slate-300 font-semibold px-0.5">カテゴリ</div>
                <div
                  role="radiogroup"
                  aria-label="お気に入りカテゴリ"
                  className="grid grid-cols-4 gap-1 p-0.5 rounded-xl bg-slate-950/80 border border-slate-800"
                >
                  {FAVORITE_CATEGORY_LIST.map((cat) => {
                    const isSelected = favCategoryInput === cat.id;
                    const Icon = cat.icon;
                    return (
                      <button
                        key={cat.id}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        onClick={() => setFavCategoryInput(cat.id)}
                        className={`inline-flex items-center justify-center gap-1 min-h-[34px] py-1 px-1 rounded-lg text-xs font-bold transition-all cursor-pointer select-none ${
                          isSelected
                            ? `${cat.activeBgClass} shadow-md`
                            : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                        }`}
                      >
                        <Icon className="w-3.5 h-3.5 shrink-0" />
                        <span className="truncate">{cat.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* OpenStreetMap 施設・地名候補チップ */}
              {(isLoadingOsm || osmCandidates.length > 0) && (
                <div
                  id="inspector-osm-candidates"
                  className="rounded-xl bg-slate-950/75 border border-slate-800/90 p-2.5 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="inline-flex items-center gap-1 font-semibold text-sky-300 truncate">
                      <Sparkles className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                      <span className="truncate">周辺の候補（タップで選択）</span>
                    </span>
                    {isLoadingOsm && (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400 shrink-0" />
                    )}
                  </div>

                  {osmCandidates.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto pr-0.5">
                      {osmCandidates.map((cand) => {
                        const isSelected = favNameInput.trim() === cand.name;
                        return (
                          <button
                            key={`${cand.source}-${cand.category}-${cand.name}`}
                            type="button"
                            onClick={() => {
                              hasUserEditedRef.current = true;
                              setFavNameInput(cand.name);
                            }}
                            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors cursor-pointer text-left max-w-full ${
                              isSelected
                                ? 'bg-sky-500/30 border border-sky-400 text-sky-100 shadow-sm'
                                : 'bg-slate-900 hover:bg-slate-800 border border-slate-700/80 text-slate-200'
                            }`}
                          >
                            <span className="px-1.5 py-0.5 rounded bg-slate-800 text-[10px] text-sky-300 shrink-0">
                              {cand.category}
                            </span>
                            <span className="truncate">{cand.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    isLoadingOsm && (
                      <div className="text-xs text-slate-400 truncate">
                        周辺の施設・地名を検索中...
                      </div>
                    )
                  )}
                </div>
              )}

              {favSaveError && (
                <div
                  id="inspector-fav-save-error"
                  role="alert"
                  className="text-xs text-rose-300 font-medium bg-rose-500/15 border border-rose-500/40 rounded-lg px-2.5 py-1.5"
                >
                  {favSaveError}
                </div>
              )}

              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  id="inspector-fav-save-btn"
                  disabled={isSavingFav}
                  className="flex-1 inline-flex items-center justify-center gap-1 min-h-[38px] px-3 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 font-bold text-sm cursor-pointer"
                >
                  {isSavingFav ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>保存中...</span>
                    </>
                  ) : (
                    <>
                      <Check className="w-4 h-4" />
                      <span>保存</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setIsEditingFav(false)}
                  disabled={isSavingFav}
                  className="px-3.5 py-1.5 min-h-[38px] rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 font-semibold text-sm cursor-pointer"
                >
                  キャンセル
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
};

