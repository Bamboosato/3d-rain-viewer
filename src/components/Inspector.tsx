import React, { useEffect, useState } from 'react';
import { MapPin, X, Mountain, CloudRain, Navigation2, Star, Trash2, Check } from 'lucide-react';
import type { InspectorPoint, PresetLocation } from '../types/map';

interface InspectorProps {
  point: InspectorPoint | null;
  onClose: () => void;
  matchedFavorite?: PresetLocation | null;
  onSaveFavorite?: (name: string) => void;
  onRemoveFavorite?: (id: string) => void;
}

function getRainfallIntensityInfo(mmPerHour: number): {
  label: string;
  badgeClass: string;
} {
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
}) => {
  const [isEditingFav, setIsEditingFav] = useState<boolean>(false);
  const [favNameInput, setFavNameInput] = useState<string>('');

  // 選択地点が変わったら入力フォームをリセットし、初期候補名をセット
  useEffect(() => {
    setIsEditingFav(false);
    if (point) {
      setFavNameInput(matchedFavorite?.name ?? getSuggestedFavoriteName(point));
    }
  }, [point?.lng, point?.lat, point?.label, matchedFavorite?.id]);

  if (!point) return null;

  const rainVal = point.precipitation ?? 0;
  const intensity = getRainfallIntensityInfo(rainVal);

  // クリック地点の近傍に配置しつつ、画面端やUIパネルと重なりすぎないよう安全範囲にクランプ
  const hasScreenPos =
    typeof point.screenX === 'number' &&
    typeof point.screenY === 'number' &&
    typeof window !== 'undefined' &&
    window.innerWidth >= 768;

  const clampedLeft = hasScreenPos
    ? Math.min(Math.max(point.screenX! + 18, 24), window.innerWidth - 320)
    : undefined;
  const clampedTop = hasScreenPos
    ? Math.min(Math.max(point.screenY! - 60, 76), window.innerHeight - 310)
    : undefined;

  const handleSaveSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = favNameInput.trim() || getSuggestedFavoriteName(point);
    onSaveFavorite?.(trimmed);
    setIsEditingFav(false);
  };

  return (
    <div
      id="point-inspector-card"
      role="region"
      aria-label="クリック地点の詳細インスペクター"
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
      className="vt-inspector-card pointer-events-auto rounded-2xl bg-slate-900/95 backdrop-blur-md border border-sky-400/60 shadow-2xl p-3.5 sm:p-4 text-xs text-slate-100 w-72"
    >
      {/* ヘッダーと閉じるボタン */}
      <div className="flex items-center justify-between pb-2.5 mb-2.5 border-b border-slate-700/80">
        <div className="flex flex-col min-w-0">
          <div className="flex items-center gap-1.5 font-bold text-sky-300 text-xs">
            <MapPin className="w-4 h-4 text-sky-400 shrink-0" />
            <span>地点インスペクター</span>
          </div>
          {point.label && (
            <div
              id="inspector-point-label"
              className="text-sm font-bold text-white mt-1 truncate"
            >
              {point.label}
            </div>
          )}
        </div>
        <button
          type="button"
          id="inspector-close-btn"
          onClick={onClose}
          aria-label="インスペクターを閉じる"
          className="inline-flex items-center justify-center min-w-[32px] min-h-[32px] p-1 rounded-xl text-slate-300 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 経緯度座標 */}
      <div className="flex items-center justify-between px-2.5 py-1.5 rounded-xl bg-slate-950/80 border border-slate-800 mb-2.5 font-mono text-[11px]">
        <span className="flex items-center gap-1 text-slate-400 font-sans">
          <Navigation2 className="w-3 h-3 text-slate-400" />
          座標
        </span>
        <span className="text-slate-200 font-semibold">
          {point.lat.toFixed(4)}°N, {point.lng.toFixed(4)}°E
        </span>
      </div>

      {/* 標高バッジ & 降雨強度バッジ */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-amber-500/15 border border-amber-400/35 p-2.5 flex flex-col justify-between">
          <div className="flex items-center gap-1 text-[11px] text-amber-300/90 font-medium">
            <Mountain className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span>標高 (AW3D30)</span>
          </div>
          <div
            id="inspector-elevation-value"
            className="font-mono text-sm font-bold text-amber-200 mt-1"
          >
            {point.elevation !== null ? `${point.elevation.toLocaleString()} m` : '計測中...'}
          </div>
        </div>

        <div className={`rounded-xl border p-2.5 flex flex-col justify-between ${intensity.badgeClass}`}>
          <div className="flex items-center gap-1 text-[11px] font-medium">
            <CloudRain className="w-3.5 h-3.5 shrink-0" />
            <span>降雨強度</span>
          </div>
          <div id="inspector-rain-value" className="font-mono text-sm font-bold mt-1">
            {rainVal.toFixed(2)} <span className="text-[11px] font-normal">mm/h</span>
          </div>
        </div>
      </div>

      {/* 雨量ステータスラベル */}
      <div className="mt-2.5 pt-2 border-t border-slate-800/90 flex items-center justify-between text-xs">
        <span className="text-slate-400">現在の降水判定</span>
        <span className="font-bold text-sky-300">{intensity.label}</span>
      </div>

      {/* お気に入り地点登録・解除エリア（現在の縮尺・傾き・方角も一緒に記憶） */}
      {onSaveFavorite && (
        <div className="mt-2.5 pt-2.5 border-t border-slate-800/90">
          {!isEditingFav && !matchedFavorite && (
            <button
              type="button"
              id="inspector-fav-open-btn"
              onClick={() => {
                setFavNameInput(getSuggestedFavoriteName(point));
                setIsEditingFav(true);
              }}
              className="w-full inline-flex items-center justify-center gap-1.5 min-h-[38px] px-3 py-1.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/40 text-amber-200 text-xs sm:text-sm font-bold transition-colors cursor-pointer"
            >
              <Star className="w-4 h-4 text-amber-400 shrink-0" />
              <span>お気に入り地点に登録</span>
            </button>
          )}

          {!isEditingFav && matchedFavorite && (
            <div className="flex items-center justify-between gap-1.5">
              <button
                type="button"
                id="inspector-fav-edit-btn"
                onClick={() => {
                  setFavNameInput(matchedFavorite.name);
                  setIsEditingFav(true);
                }}
                title="現在の縮尺・傾き・方角で上書き保存、または名前を変更"
                className="flex-1 inline-flex items-center justify-center gap-1.5 min-h-[36px] px-2.5 py-1.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/50 text-amber-200 text-xs font-bold truncate cursor-pointer"
              >
                <Star className="w-3.5 h-3.5 text-amber-400 fill-amber-400 shrink-0" />
                <span className="truncate">登録済（視点・名前を更新）</span>
              </button>

              {onRemoveFavorite && (
                <button
                  type="button"
                  id="inspector-fav-remove-btn"
                  onClick={() => onRemoveFavorite(matchedFavorite.id)}
                  title="お気に入りから削除"
                  aria-label="お気に入りから削除"
                  className="inline-flex items-center justify-center min-w-[36px] min-h-[36px] p-1.5 rounded-xl bg-rose-500/20 hover:bg-rose-500/30 border border-rose-400/40 text-rose-300 transition-colors cursor-pointer shrink-0"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          )}

          {isEditingFav && (
            <form onSubmit={handleSaveSubmit} className="space-y-2">
              <div className="text-[11px] text-amber-300/90 font-medium">
                ⭐ 地点名を入力（現在の縮尺・傾き・方角も記憶します）
              </div>
              <input
                id="inspector-fav-name-input"
                type="text"
                value={favNameInput}
                onChange={(e) => setFavNameInput(e.target.value)}
                placeholder="例: 自宅、上高地、キャンプ場"
                aria-label="お気に入り地点の名前"
                autoFocus
                className="w-full rounded-xl bg-slate-950/90 border border-amber-400/50 px-3 py-1.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
              <div className="flex items-center gap-1.5">
                <button
                  type="submit"
                  id="inspector-fav-save-btn"
                  className="flex-1 inline-flex items-center justify-center gap-1 min-h-[36px] px-3 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs sm:text-sm cursor-pointer"
                >
                  <Check className="w-4 h-4" />
                  <span>保存する</span>
                </button>
                <button
                  type="button"
                  onClick={() => setIsEditingFav(false)}
                  className="px-3 py-1.5 min-h-[36px] rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold text-xs cursor-pointer"
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
