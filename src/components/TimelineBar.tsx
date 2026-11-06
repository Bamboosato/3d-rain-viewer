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

/**
 * スマホ画面向けに相対バッジ文字列 ("リアルタイム実況", "+14時間 予測") を短縮
 */
function formatCompactMobileBadge(badge: string): string {
  return badge
    .replace('リアルタイム実況', '現在実況')
    .replace('カタログ最新', '最新')
    .replace(/\s*予測$/, '予測')
    .replace('時間', 'h');
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
  cachedCount = 0,
}) => {
  const maxIndex = Math.max(0, frames.length - 1);
  const currentFrame = frames[currentIndex];
  const relativeLabel =
    currentFrame?.relativeBadge ??
    (rainSource === 'jma-nowcast' ? 'リアルタイム実況' : 'カタログ最新');
  const compactRelativeLabel = formatCompactMobileBadge(relativeLabel);
  const isForecastFrame = Boolean(currentFrame?.isForecast);
  const isLatestObsFrame = Boolean(currentFrame?.isLatestObservation);

  const latestObsIndex = frames.findIndex((f) => f.isLatestObservation);
  const nowMarkerPercent =
    rainSource === 'jma-nowcast' && latestObsIndex > 0 && maxIndex > 0
      ? (latestObsIndex / maxIndex) * 100
      : null;

  const compactDateJST = formatCompactMobileDate(observedDateJST);

  return (
    <section
      aria-label="雨雲タイムラプスコントローラー"
      className="pointer-events-auto rounded-2xl bg-slate-900/85 backdrop-blur-md border border-slate-700/75 shadow-2xl px-2.5 sm:px-3.5 py-1.5 sm:py-2 text-xs text-slate-100 w-full max-w-3xl"
    >
      {/* 1行目: スマホ・PCともに折り返しなしの1行レイアウト (flex-nowrap) で縦幅を完全固定 */}
      <div className="flex flex-nowrap items-center justify-between gap-1 sm:gap-1.5 whitespace-nowrap">
        {/* 左側: 再生・コマ送り・速度・現在ジャンプ */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            id="timeline-play-btn"
            onClick={onTogglePlay}
            disabled={frames.length <= 1}
            aria-label={isPlaying ? 'タイムラプス再生を停止' : 'タイムラプスを再生'}
            className={`inline-flex items-center justify-center gap-1 h-7 px-2 sm:px-2.5 rounded-lg font-semibold transition-colors cursor-pointer shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
              isPlaying
                ? 'bg-amber-500 hover:bg-amber-400 text-slate-950'
                : 'bg-sky-500 hover:bg-sky-400 text-white'
            } disabled:opacity-50`}
          >
            {isPlaying ? (
              <Pause className="w-3.5 h-3.5 fill-current" />
            ) : (
              <Play className="w-3.5 h-3.5 fill-current" />
            )}
            <span className="hidden sm:inline text-xs">{isPlaying ? '停止' : '再生'}</span>
          </button>

          <button
            type="button"
            onClick={() => onSelectIndex(Math.max(0, currentIndex - 1))}
            disabled={currentIndex <= 0}
            aria-label="前の時刻フレームへ戻る"
            className="inline-flex items-center justify-center w-6 sm:w-7 h-7 rounded-lg bg-slate-800/85 hover:bg-slate-700 disabled:opacity-40 text-slate-200 border border-slate-700/80 transition-colors cursor-pointer"
          >
            <SkipBack className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
          </button>

          <button
            type="button"
            onClick={() => onSelectIndex(Math.min(maxIndex, currentIndex + 1))}
            disabled={currentIndex >= maxIndex}
            aria-label="次の時刻フレームへ進む"
            className="inline-flex items-center justify-center w-6 sm:w-7 h-7 rounded-lg bg-slate-800/85 hover:bg-slate-700 disabled:opacity-40 text-slate-200 border border-slate-700/80 transition-colors cursor-pointer"
          >
            <SkipForward className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
          </button>

          <button
            type="button"
            id="timeline-speed-btn"
            onClick={onToggleSpeed}
            title={`再生速度切替 (${playbackSpeed === 2 ? '0.5秒/コマ' : '1.0秒/コマ'})`}
            aria-label={`再生速度を切り替え（現在 ${playbackSpeed}倍速）`}
            className="inline-flex items-center justify-center h-7 px-1.5 sm:px-2 rounded-lg bg-slate-800/85 hover:bg-slate-700 text-slate-200 font-mono text-[11px] font-semibold transition-colors cursor-pointer border border-slate-700/80"
          >
            {playbackSpeed}x
          </button>

          {rainSource === 'jma-nowcast' && latestObsIndex >= 0 && (
            <button
              type="button"
              id="timeline-jump-now-btn"
              onClick={() => onSelectIndex(latestObsIndex)}
              title="最新のリアルタイム実況時刻へジャンプ"
              className={`hidden sm:inline-flex items-center justify-center gap-1 h-7 px-2 rounded-lg border text-[11px] font-medium transition-colors cursor-pointer ${
                isLatestObsFrame
                  ? 'bg-emerald-500/25 text-emerald-200 border-emerald-400/50'
                  : 'bg-slate-800/85 hover:bg-slate-700 text-emerald-300 border-slate-700/80'
              }`}
            >
              <Radio className="w-3 h-3 text-emerald-400 shrink-0" />
              <span>現在</span>
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
              className="hidden sm:inline-flex items-center justify-center gap-1 h-7 px-2 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-400/30 text-[11px] font-medium transition-colors cursor-pointer"
            >
              <Sparkles className="w-3 h-3 text-amber-400 shrink-0" />
              <span>ピーク</span>
            </button>
          )}
        </div>

        {/* 中央: 観測・予測日時バッジ（スマホではタップで現在時刻へジャンプ可能＆短縮日時表示） */}
        <div
          id="timeline-timestamp-badge"
          onClick={() => {
            if (rainSource === 'jma-nowcast' && latestObsIndex >= 0) {
              onSelectIndex(latestObsIndex);
            }
          }}
          title={
            rainSource === 'jma-nowcast'
              ? 'タップして最新のリアルタイム実況時刻へ戻る'
              : undefined
          }
          className="flex items-center justify-center gap-1 sm:gap-1.5 h-7 px-2 sm:px-2.5 rounded-lg bg-slate-950/90 border border-sky-500/35 shadow-inner min-w-0 shrink-0 cursor-pointer"
        >
          <Clock className="hidden sm:inline-block w-3.5 h-3.5 text-sky-400 shrink-0" />
          {/* PC表示用フル日時 */}
          <span className="hidden sm:inline font-mono text-[13px] font-bold tracking-tight text-sky-200 tabular-nums">
            {observedDateJST || 'データ取得中...'}
          </span>
          {/* スマホ表示用コンパクト日時 ("11/06 14:25") */}
          <span className="sm:hidden font-mono text-[11px] font-bold tracking-tight text-sky-200 tabular-nums">
            {compactDateJST}
          </span>

          <span
            id="timeline-status-pill"
            className={`inline-flex items-center justify-center w-[4.25rem] sm:w-[6.25rem] py-0.5 rounded font-mono text-[10px] font-semibold text-center ${
              isForecastFrame
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                : isLatestObsFrame
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                  : 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
            }`}
          >
            <span className="hidden sm:inline">{relativeLabel}</span>
            <span className="sm:hidden">{compactRelativeLabel}</span>
          </span>

          {isLoading && (
            <span
              title="雨雲データ取得中"
              className="inline-block w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full bg-sky-400 animate-ping shrink-0"
            />
          )}
        </div>

        {/* 右側: データソース切替タブ（スマホでは省スペースのアイコン+短ラベル） */}
        <div
          role="tablist"
          aria-label="雨雲データソース切り替え"
          className="inline-flex items-center gap-0.5 p-0.5 h-7 rounded-lg bg-slate-950/90 border border-slate-800 shrink-0"
        >
          <button
            type="button"
            role="tab"
            id="timeline-tab-jma"
            title="気象庁 高解像度降水ナウキャスト (過去2h実況〜+60分) ＋ 今後の雨 (+15時間予測)"
            aria-selected={rainSource === 'jma-nowcast'}
            onClick={() => onChangeRainSource('jma-nowcast')}
            className={`inline-flex items-center gap-1 h-6 px-1.5 sm:px-2 rounded-md text-[10px] sm:text-[11px] font-semibold transition-colors cursor-pointer ${
              rainSource === 'jma-nowcast'
                ? 'bg-emerald-500/25 text-emerald-200 border border-emerald-400/50'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Radio className="w-3 h-3 text-emerald-400 shrink-0" />
            <span className="hidden sm:inline">リアルタイム</span>
            <span className="sm:hidden">実況</span>
          </button>

          <button
            type="button"
            role="tab"
            id="timeline-tab-gsmap"
            title="JAXA GSMaP 衛星全球降水マップ (地上雨量計補正済み・過去24時間)"
            aria-selected={rainSource === 'jaxa-gsmap'}
            onClick={() => onChangeRainSource('jaxa-gsmap')}
            className={`inline-flex items-center gap-1 h-6 px-1.5 sm:px-2 rounded-md text-[10px] sm:text-[11px] font-semibold transition-colors cursor-pointer ${
              rainSource === 'jaxa-gsmap'
                ? 'bg-sky-500/25 text-sky-200 border border-sky-400/50'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Satellite className="w-3 h-3 text-sky-400 shrink-0" />
            <span className="hidden sm:inline">衛星(24h)</span>
            <span className="sm:hidden">衛星</span>
          </button>
        </div>
      </div>

      {/* 2行目: スリムなシークバー ＋ 両端ラベル */}
      <div className="flex items-center gap-1.5 sm:gap-2 mt-1 sm:mt-1.5">
        <span className="text-[10px] font-mono text-slate-400 shrink-0 tabular-nums">
          <span className="hidden sm:inline">
            {rainSource === 'jma-nowcast' ? '-2h実況' : '-24h'}
          </span>
          <span className="sm:hidden">{rainSource === 'jma-nowcast' ? '-2h' : '-24h'}</span>
        </span>

        <div className="relative flex-1 flex items-center py-0.5">
          {/* JMAモード時の「現在(リアルタイム実況)」位置マーカー */}
          {nowMarkerPercent !== null && (
            <div
              title="現在（リアルタイム実況）位置"
              style={{ left: `${nowMarkerPercent}%` }}
              className="pointer-events-none absolute top-0 bottom-0 -translate-x-1/2 flex flex-col items-center justify-center z-0"
            >
              <span className="w-1 h-3 rounded-full bg-emerald-400/80 shadow shadow-emerald-400/50" />
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
            className="relative z-10 w-full accent-sky-400 cursor-pointer h-1.5 bg-slate-700/90 rounded-lg"
          />
        </div>

        <span className="text-[10px] font-mono text-amber-300/90 shrink-0 tabular-nums">
          <span className="hidden sm:inline">
            {rainSource === 'jma-nowcast'
              ? `+15h予測 (${cachedCount}/${frames.length})`
              : `最新 (${cachedCount}/${frames.length}h)`}
          </span>
          <span className="sm:hidden">
            {rainSource === 'jma-nowcast' ? '+15h予測' : '最新'}
          </span>
        </span>
      </div>
    </section>
  );
};
