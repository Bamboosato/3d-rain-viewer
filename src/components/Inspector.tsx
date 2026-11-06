import React from 'react';
import { MapPin, X, Mountain, CloudRain, Navigation2 } from 'lucide-react';
import type { InspectorPoint } from '../types/map';

interface InspectorProps {
  point: InspectorPoint | null;
  onClose: () => void;
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

export const Inspector: React.FC<InspectorProps> = ({ point, onClose }) => {
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
    ? Math.min(Math.max(point.screenY! - 60, 76), window.innerHeight - 250)
    : undefined;

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
              bottom: 'calc(env(safe-area-inset-bottom, 0px) + 90px)',
            }
      }
      className="vt-inspector-card pointer-events-auto rounded-2xl bg-slate-900/95 backdrop-blur-md border border-sky-400/60 shadow-2xl p-3 sm:p-4 text-xs text-slate-100 w-64 sm:w-72"
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
              className="text-xs font-bold text-white mt-1 truncate"
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
          className="inline-flex items-center justify-center min-w-[32px] min-h-[32px] p-1 rounded-xl text-slate-300 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
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
      <div className="mt-2.5 pt-2 border-t border-slate-800/90 flex items-center justify-between text-[11px]">
        <span className="text-slate-400">現在の降水判定</span>
        <span className="font-semibold text-sky-300">{intensity.label}</span>
      </div>
    </div>
  );
};
