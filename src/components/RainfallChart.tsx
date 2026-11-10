import React, { useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import type { PointTimeseriesResult } from '../lib/pointTimeseriesClient';
import type { RainSourceId, TimelineFrameItem } from '../types/map';

interface RainfallChartProps {
  timeseries: PointTimeseriesResult | null;
  currentIndex: number;
  onSelectIndex: (index: number) => void;
  isLoading?: boolean;
  rainSource: RainSourceId;
  centerCoords?: { lng: number; lat: number };
}

/**
 * 気象庁カラーガイドに基づく雨量バー色
 */
function getRainColor(mmh: number | null): string {
  if (mmh === null) return '#475569'; // slate-600 (欠測)
  if (mmh <= 0) return '#334155'; // slate-700 (0 mm/h)
  if (mmh >= 80) return '#b40068';
  if (mmh >= 50) return '#ef4444';
  if (mmh >= 20) return '#f97316';
  if (mmh >= 10) return '#facc15';
  if (mmh >= 5) return '#22c55e';
  if (mmh >= 1) return '#218cff';
  if (mmh >= 0.5) return '#00d5ff';
  return '#38bdf8';
}

/**
 * 降雨強度に応じた簡易日本語ラベル
 */
function getRainIntensityText(mmh: number | null): string {
  if (mmh === null) return '域外・欠測';
  if (mmh <= 0) return '降水なし';
  if (mmh >= 80) return '猛烈な雨';
  if (mmh >= 50) return '非常に激しい雨';
  if (mmh >= 20) return '激しい雨';
  if (mmh >= 10) return 'やや強い雨';
  if (mmh >= 5) return '強い雨';
  if (mmh >= 1) return '並の雨';
  return '小雨';
}

/**
 * 時刻バー用の短縮ラベル生成
 */
function formatBarTime(frame: TimelineFrameItem): string {
  if (frame.relativeBadge && frame.isForecast) {
    // 予報フレームは "+30分" や "+2h" などの簡潔表示を優先
    return frame.relativeBadge.replace('予報', '');
  }
  const date = frame.date;
  if (!date || isNaN(date.getTime())) return '';
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export const RainfallChart: React.FC<RainfallChartProps> = ({
  timeseries,
  currentIndex,
  onSelectIndex,
  isLoading = false,
  rainSource,
  centerCoords,
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isUserScrollingRef = useRef(false);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Y軸最大スケールの動的決定 (最低10mm/h、超えたら20, 50, 80, 100...)
  const maxRain = timeseries?.maxPrecipitation ?? 0;
  const yScaleMax =
    maxRain <= 5
      ? 10
      : maxRain <= 15
        ? 20
        : maxRain <= 35
          ? 50
          : maxRain <= 65
            ? 80
            : Math.ceil(maxRain / 20) * 20;

  const selectedItem = timeseries?.items[currentIndex] ?? null;
  const selectedMm = selectedItem?.precipitation ?? null;

  // スライダー時刻との連動: 選択中のバーが横スクロール領域の中央に来るよう自動スクロール
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || isUserScrollingRef.current) return;

    const targetBar = container.querySelector(
      `[data-bar-index="${currentIndex}"]`
    ) as HTMLElement | null;

    if (targetBar) {
      const containerWidth = container.clientWidth;
      const barLeft = targetBar.offsetLeft;
      const barWidth = targetBar.offsetWidth;
      // 中央位置を算出
      const targetScrollLeft = barLeft - containerWidth / 2 + barWidth / 2;
      container.scrollTo({
        left: Math.max(0, targetScrollLeft),
        behavior: 'smooth',
      });
    }
  }, [currentIndex, timeseries]);

  const handleTouchOrWheel = (e: React.UIEvent) => {
    // 3Dマップへのイベント貫通防止
    e.stopPropagation();
    isUserScrollingRef.current = true;
    clearTimeout(scrollTimeoutRef.current);
    scrollTimeoutRef.current = setTimeout(() => {
      isUserScrollingRef.current = false;
    }, 400);
  };

  const items = timeseries?.items ?? [];

  return (
    <div
      className="rainfall-chart-container relative w-full flex flex-col select-none"
      aria-label="中心座標の降水量推移グラフ"
    >
      {/* グラフヘッダー: 地図中心座標 & 現在選択時刻の雨量情報 */}
      <div className="flex items-center justify-between gap-2 px-1 mb-1.5 text-xs">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="font-bold text-rose-300 shrink-0">中心地点</span>
          {centerCoords && (
            <span className="font-mono text-[11px] text-slate-300 truncate">
              {centerCoords.lat.toFixed(2)}°N, {centerCoords.lng.toFixed(2)}°E
            </span>
          )}
          {isLoading && (
            <Loader2 className="w-3 h-3 text-rose-400 animate-spin shrink-0 ml-1" />
          )}
        </div>

        {/* 選択フレームの雨量ピル */}
        <div className="flex items-center gap-1.5 shrink-0 font-sans">
          <span className="text-[11px] text-slate-300">
            {selectedItem?.isForecast ? '予測' : selectedItem?.isLatestObservation ? '現在' : '過去'}:
          </span>
          <span
            style={{ backgroundColor: `${getRainColor(selectedMm)}33`, borderColor: getRainColor(selectedMm) }}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[11px] font-mono font-bold text-white shadow-xs"
          >
            <span
              style={{ backgroundColor: getRainColor(selectedMm) }}
              className="w-1.5 h-1.5 rounded-full shrink-0"
            />
            {selectedMm === null ? '域外/欠測' : `${selectedMm >= 10 ? Math.round(selectedMm) : selectedMm.toFixed(1)} mm/h`}
            <span className="text-[10px] font-sans font-normal text-slate-200 ml-0.5">
              ({getRainIntensityText(selectedMm)})
            </span>
          </span>
        </div>
      </div>

      {/* グラフ本体: 左固定Y軸 + 横スクロールバー */}
      <div className="relative flex items-end border border-slate-700/60 rounded-xl bg-slate-950/70 backdrop-blur-sm overflow-hidden">
        {/* Y軸固定列 (mm/h) */}
        <div
          aria-hidden="true"
          className="sticky left-0 z-20 flex flex-col justify-between items-end pr-1.5 py-1 text-[10px] font-mono font-bold text-slate-400 bg-slate-900/95 backdrop-blur-md border-r border-slate-700/70 h-[148px] shrink-0 min-w-[34px] pointer-events-none"
        >
          <span className="leading-none">{yScaleMax}</span>
          <span className="leading-none text-slate-400">{Math.round((yScaleMax * 2) / 3)}</span>
          <span className="leading-none text-slate-400">{Math.round(yScaleMax / 3)}</span>
          <span className="leading-none text-slate-400">0</span>
        </div>

        {/* 横スクロール バー領域 */}
        <div
          ref={scrollContainerRef}
          onWheel={handleTouchOrWheel}
          onTouchMove={handleTouchOrWheel}
          className="relative flex-1 flex items-end overflow-x-auto overflow-y-hidden scrollbar-thin select-none touch-pan-x py-1 px-1.5 min-h-[148px]"
          style={{ touchAction: 'pan-x' }}
        >
          {items.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-xs text-slate-400 py-10">
              {isLoading ? '雨量データを取得中...' : '雨量時系列データがありません'}
            </div>
          ) : (
            items.map((item, index) => {
              const isSelected = index === currentIndex;
              const mmh = item.precipitation;
              const barColor = getRainColor(mmh);
              // バーの高さパーセンテージ (0mmの場合は0%、降水があれば視認性のため最低8%)
              const heightPct =
                mmh !== null && mmh > 0
                  ? Math.min(100, Math.max(8, (mmh / yScaleMax) * 100))
                  : 0;

              const showNowLineAfterThis = item.isLatestObservation && index < items.length - 1;

              return (
                <React.Fragment key={item.frame.validtime || `${item.frame.date.getTime()}-${index}`}>
                  <button
                    type="button"
                    data-bar-index={index}
                    onClick={() => onSelectIndex(index)}
                    aria-label={`${formatBarTime(item.frame)}: ${mmh === null ? '欠測' : `${mmh} mm/h`} ${isSelected ? '(選択中)' : ''}`}
                    className={`group relative flex flex-col items-center justify-end h-[140px] min-w-[34px] sm:min-w-[38px] px-0.5 rounded-lg transition-colors cursor-pointer shrink-0 ${
                      isSelected
                        ? 'bg-sky-500/25 ring-1.5 ring-sky-400 shadow-sm'
                        : 'hover:bg-slate-800/60'
                    }`}
                  >
                    {/* 選択中の上部ハイライトポインタ */}
                    {isSelected && (
                      <span className="absolute -top-1 w-2.5 h-1 rounded-full bg-sky-400 shadow shadow-sky-400 animate-pulse" />
                    )}

                    {/* バー上部の雨量数値ラベル */}
                    <span
                      className={`text-[9px] font-mono tabular-nums leading-none mb-1 ${
                        isSelected ? 'font-bold text-sky-200' : 'text-slate-300'
                      }`}
                    >
                      {mmh === null ? '-' : mmh === 0 ? '0' : mmh >= 10 ? Math.round(mmh) : mmh.toFixed(1)}
                    </span>

                    {/* バー本体 */}
                    <div className="w-full flex items-end justify-center h-24 bg-slate-800/50 rounded-sm overflow-hidden">
                      <div
                        style={{
                          height: `${heightPct}%`,
                          backgroundColor: barColor,
                        }}
                        className={`w-full rounded-t-sm transition-all duration-150 ${
                          isSelected ? 'brightness-125' : ''
                        }`}
                      />
                    </div>

                    {/* バー下部の時刻ラベル */}
                    <span
                      className={`text-[10px] font-sans leading-none mt-1 truncate ${
                        isSelected ? 'font-bold text-sky-200' : 'text-slate-400'
                      }`}
                    >
                      {formatBarTime(item.frame)}
                    </span>
                  </button>

                  {/* 「現在」縦の境界線（Nowライン） */}
                  {showNowLineAfterThis && (
                    <div
                      aria-label="現在実況境界"
                      className="relative flex flex-col items-center justify-center mx-1 h-[140px] shrink-0 pointer-events-none z-10"
                    >
                      <div className="h-full border-r-2 border-dashed border-emerald-400/90" />
                      <span className="absolute top-0 px-1 py-0.2 rounded text-[8px] font-bold bg-emerald-500/80 text-slate-950 whitespace-nowrap shadow shadow-emerald-500/40">
                        現在
                      </span>
                    </div>
                  )}
                </React.Fragment>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
