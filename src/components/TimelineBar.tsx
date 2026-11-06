import React from 'react';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Clock,
  Sparkles,
  Radio,
  Satellite,
} from 'lucide-react';
import type { RainSourceId, TimelineFrameItem } from '../types/map';

interface TimelineBarProps {
  rainSource: RainSourceId;
  onChangeRainSource: (source: RainSourceId) => void;
  frames: TimelineFrameItem[];
  currentIndex: number;
  onSelectIndex: (index: number) => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
  playbackSpeed: 1 | 2;
  onToggleSpeed: () => void;
  observedDateJST: string;
  isLoading: boolean;
  cachedCount?: number;
}

/**
 * スマホ画面向けに日時文字列 ("2026-11-06 14:25 JST") を "11/06 14:25" へ短縮
 */
function formatCompactMobileDate(fullJst: string): string {
  if (!fullJst) return '取得中...';
  return fullJst
    .replace(/^\d{4}-/, '')
    .replace('-', '/')
    .replace(/\s*JST$/, '')
    .trim();
}

export const TimelineBar: React.FC<TimelineBarProps> = ({
  rainSource,
  onChangeRainSource,
  frames,
  currentIndex,
  onSelectIndex,
  isPlaying,
  onTogglePlay,
  playbackSpeed,
  onToggleSpeed,
  observedDateJST,
  isLoading,
}) => {
  const maxIndex = Math.max(0, frames.length - 1);
  const currentFrame = frames[currentIndex];
  const isForecastFrame = Boolean(currentFrame?.isForecast);
  const isLatestObsFrame = Boolean(currentFrame?.isLatestObservation);

  // 差分時間表示を廃止し、「過去」「現在」「予測」の固定2文字ラベルに統一
  const fixedStateLabel: '過去' | '現在' | '予測' = isForecastFrame
    ? '予測'
    : isLatestObsFrame
      ? '現在'
      : '過去';

  const latestObsIndex = frames.findIndex((f) => f.isLatestObservation);
  const nowMarkerPercent =
    rainSource === 'jma-nowcast' && latestObsIndex > 0 && maxIndex > 0
      ? (latestObsIndex / maxIndex) * 100
      : null;

  const compactDateJST = formatCompactMobileDate(observedDateJST);

  return (
    <section
      aria-label="雨雲タイムラプスコントローラー"
      className="pointer-events-auto rounded-2xl bg-slate-900/90 backdrop-blur-md border border-slate-700/80 shadow-2xl px-3.5 sm:px-4 py-2.5 text-sm text-slate-100 w-full max-w-3xl"
    >
      {/* 1行目: スマホでもボタン・文字を大きく押しやすく配置 (flex-nowrap) */}
      <div className="flex flex-nowrap items-center justify-between gap-2 whitespace-nowrap">
        {/* 左側: 大きめの再生・コマ送り・速度ボタン */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            id="timeline-play-btn"
            onClick={onTogglePlay}
            disabled={frames.length <= 1}
            aria-label={isPlaying ? 'タイムラプス再生を停止' : 'タイムラプスを再生'}
            className={`inline-flex items-center justify-center gap-1.5 h-10 sm:h-9 px-3 sm:px-3.5 rounded-xl font-bold transition-colors cursor-pointer shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
              isPlaying
                ? 'bg-amber-500 hover:bg-amber-400 text-slate-950'
                : 'bg-sky-500 hover:bg-sky-400 text-white'
            } disabled:opacity-50`}
          >
            {isPlaying ? (
              <Pause className="w-4 h-4 sm:w-4 sm:h-4 fill-current" />
            ) : (
              <Play className="w-4 h-4 sm:w-4 sm:h-4 fill-current" />
            )}
            <span className="hidden sm:inline text-sm">{isPlaying ? '停止' : '再生'}</span>
          </button>

          <button
            type="button"
            onClick={() => onSelectIndex(Math.max(0, currentIndex - 1))}
            disabled={currentIndex <= 0}
            aria-label="前の時刻フレームへ戻る"
            className="inline-flex items-center justify-center w-10 h-10 sm:w-9 sm:h-9 rounded-xl bg-slate-800/90 hover:bg-slate-700 disabled:opacity-40 text-slate-100 border border-slate-700/80 transition-colors cursor-pointer"
          >
            <SkipBack className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => onSelectIndex(Math.min(maxIndex, currentIndex + 1))}
            disabled={currentIndex >= maxIndex}
            aria-label="次の時刻フレームへ進む"
            className="inline-flex items-center justify-center w-10 h-10 sm:w-9 sm:h-9 rounded-xl bg-slate-800/90 hover:bg-slate-700 disabled:opacity-40 text-slate-100 border border-slate-700/80 transition-colors cursor-pointer"
          >
            <SkipForward className="w-4 h-4" />
          </button>

          <button
            type="button"
            id="timeline-speed-btn"
            onClick={onToggleSpeed}
            title={`再生速度切替 (${playbackSpeed === 2 ? '0.5秒/コマ' : '1.0秒/コマ'})`}
            aria-label={`再生速度を切り替え（現在 ${playbackSpeed}倍速）`}
            className="inline-flex items-center justify-center h-10 sm:h-9 px-2.5 sm:px-3 rounded-xl bg-slate-800/90 hover:bg-slate-700 text-slate-100 font-mono text-sm font-bold transition-colors cursor-pointer border border-slate-700/80"
          >
            {playbackSpeed}x
          </button>

          {rainSource === 'jma-nowcast' && latestObsIndex >= 0 && (
            <button
              type="button"
              id="timeline-jump-now-btn"
              onClick={() => onSelectIndex(latestObsIndex)}
              title="現在時刻の実況へジャンプ"
              className={`hidden md:inline-flex items-center justify-center gap-1 h-9 px-2.5 rounded-xl border text-xs font-bold transition-colors cursor-pointer ${
                isLatestObsFrame
                  ? 'bg-emerald-500/25 text-emerald-200 border-emerald-400/50'
                  : 'bg-slate-800/90 hover:bg-slate-700 text-emerald-300 border-slate-700/80'
              }`}
            >
              <Radio className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span>現在へ</span>
            </button>
          )}

          {rainSource === 'jaxa-gsmap' && frames.length > 1 && (
            <button
              type="button"
              onClick={() => {
                const peakIdx = frames.findIndex((f) => f.date.getUTCHours() === 6);
                onSelectIndex(peakIdx >= 0 ? peakIdx : maxIndex);
              }}
              title="山岳域の降雨ピーク時刻へジャンプ"
              className="hidden md:inline-flex items-center justify-center gap-1 h-9 px-2.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-400/30 text-xs font-bold transition-colors cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span>ピーク</span>
            </button>
          )}
        </div>

        {/* 中央〜右側: 大きくて見やすい日時バッジ ＋ 固定2文字ピル（「過去」「現在」「予測」） */}
        <div
          id="timeline-timestamp-badge"
          onClick={() => {
            if (rainSource === 'jma-nowcast' && latestObsIndex >= 0) {
              onSelectIndex(latestObsIndex);
            }
          }}
          title={
            rainSource === 'jma-nowcast'
              ? 'タップして現在時刻の実況へ戻る'
              : undefined
          }
          className="flex items-center justify-center gap-2 h-10 sm:h-9 px-3 sm:px-3.5 rounded-xl bg-slate-950/90 border border-sky-500/40 shadow-inner min-w-0 shrink-0 cursor-pointer"
        >
          <Clock className="w-4 h-4 text-sky-400 shrink-0" />
          {/* PC表示用フル日時 */}
          <span className="hidden sm:inline font-mono text-sm font-bold tracking-tight text-sky-100 tabular-nums">
            {observedDateJST || 'データ取得中...'}
          </span>
          {/* スマホ表示用日時 ("11/06 14:25") - 14px (text-sm) に拡大 */}
          <span className="sm:hidden font-mono text-sm font-bold tracking-tight text-sky-100 tabular-nums">
            {compactDateJST}
          </span>

          <span
            id="timeline-status-pill"
            className={`inline-flex items-center justify-center w-12 py-0.5 rounded-lg font-sans text-xs sm:text-xs font-bold text-center ${
              isForecastFrame
                ? 'bg-amber-500/25 text-amber-200 border border-amber-400/50'
                : isLatestObsFrame
                  ? 'bg-emerald-500/25 text-emerald-200 border border-emerald-400/50'
                  : 'bg-sky-500/25 text-sky-200 border border-sky-400/40'
            }`}
          >
            {fixedStateLabel}
          </span>

          {isLoading && (
            <span
              title="雨雲データ取得中"
              className="inline-block w-2 h-2 rounded-full bg-sky-400 animate-ping shrink-0"
            />
          )}
        </div>

        {/* 右側: PC表示用データソース切替タブ（スマホでは右上の「設定」パネル内に集約し、タイムラインのボタン・文字サイズを最大化） */}
        <div
          role="tablist"
          aria-label="雨雲データソース切り替え"
          className="hidden sm:inline-flex items-center gap-0.5 p-0.5 h-9 rounded-xl bg-slate-950/90 border border-slate-800 shrink-0"
        >
          <button
            type="button"
            role="tab"
            id="timeline-tab-jma"
            title="気象庁 高解像度降水ナウキャスト ＋ 今後の雨"
            aria-selected={rainSource === 'jma-nowcast'}
            onClick={() => onChangeRainSource('jma-nowcast')}
            className={`inline-flex items-center gap-1 h-8 px-2.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
              rainSource === 'jma-nowcast'
                ? 'bg-emerald-500/25 text-emerald-200 border border-emerald-400/50'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Radio className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span>リアルタイム</span>
          </button>

          <button
            type="button"
            role="tab"
            id="timeline-tab-gsmap"
            title="JAXA GSMaP 衛星全球降水マップ (過去24時間)"
            aria-selected={rainSource === 'jaxa-gsmap'}
            onClick={() => onChangeRainSource('jaxa-gsmap')}
            className={`inline-flex items-center gap-1 h-8 px-2.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
              rainSource === 'jaxa-gsmap'
                ? 'bg-sky-500/25 text-sky-200 border border-sky-400/50'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Satellite className="w-3.5 h-3.5 text-sky-400 shrink-0" />
            <span>衛星(24h)</span>
          </button>
        </div>
      </div>

      {/* 2行目: 操作しやすい太めのシークバー ＋ 「過去」「現在」「予測」固定ラベル */}
      <div className="flex items-center gap-3 mt-2">
        <span className="text-xs sm:text-xs font-bold text-sky-300 shrink-0">過去</span>

        <div className="relative flex-1 flex items-center py-1">
          {/* JMAモード時の「現在」境界マーカー */}
          {nowMarkerPercent !== null && (
            <div
              title="現在位置"
              style={{ left: `${nowMarkerPercent}%` }}
              className="pointer-events-none absolute -top-1 -bottom-1 -translate-x-1/2 flex flex-col items-center justify-center z-0"
            >
              <span className="w-1.5 h-4 rounded-full bg-emerald-400 shadow shadow-emerald-400/60" />
            </div>
          )}

          <input
            id="timeline-seek-slider"
            type="range"
            aria-label="観測・予測時刻シークバー"
            min={0}
            max={maxIndex}
            step={1}
            value={currentIndex}
            onChange={(e) => onSelectIndex(parseInt(e.target.value, 10))}
            className="relative z-10 w-full accent-sky-400 cursor-pointer h-2 bg-slate-700/90 rounded-lg"
          />
        </div>

        <span
          className={`text-xs sm:text-xs font-bold shrink-0 ${
            rainSource === 'jma-nowcast' ? 'text-amber-300' : 'text-emerald-300'
          }`}
        >
          {rainSource === 'jma-nowcast' ? '予測' : '現在'}
        </span>
      </div>
    </section>
  );
};
