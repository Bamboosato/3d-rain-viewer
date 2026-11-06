import React, { useState } from 'react';
import { Compass, Mountain, CloudRain, ChevronUp } from 'lucide-react';
import type { PresetLocation } from '../types/map';
import { runViewTransition } from '../lib/viewTransition';

interface PresetNavProps {
  presets: PresetLocation[];
  activePreset: PresetLocation;
  activePresetRain: number | null;
  onSelectPreset: (preset: PresetLocation) => void;
}

function getRainSummaryLabel(mmh: number | null): string {
  if (mmh === null) return '確認中...';
  if (mmh < 0.1) return '降水なし';
  if (mmh < 1.0) return '小雨・雲域';
  if (mmh < 5.0) return '弱い雨';
  if (mmh < 15.0) return '本降り';
  return '強い雨';
}

export const PresetNav: React.FC<PresetNavProps> = ({
  presets,
  activePreset,
  activePresetRain,
  onSelectPreset,
}) => {
  const [isOpen, setIsOpen] = useState<boolean>(true);

  const handleToggleOpen = () => {
    runViewTransition(() => {
      setIsOpen((prev) => !prev);
    });
  };

  return (
    <section
      aria-label="山岳エリア切り替えナビゲーション"
      className="pointer-events-auto flex flex-col items-start gap-2 max-w-md"
    >
      {/* 表示／非表示 トグルボタン */}
      <button
        type="button"
        id="preset-nav-toggle-btn"
        onClick={handleToggleOpen}
        aria-expanded={isOpen}
        aria-controls="preset-nav-panel"
        className="inline-flex items-center gap-2 min-h-[40px] px-3.5 py-1.5 rounded-2xl bg-slate-900/85 hover:bg-slate-800/95 backdrop-blur-md border border-slate-700/80 shadow-xl text-xs font-semibold text-slate-100 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        <Compass className="w-4 h-4 text-sky-400 shrink-0" />
        <span>山岳エリア切り替え</span>
        <span className="px-2 py-0.5 rounded-lg bg-slate-800/90 border border-slate-700 text-[11px] font-medium text-sky-200">
          {activePreset.emoji} {activePreset.name}
        </span>
        <ChevronUp
          className={`w-3.5 h-3.5 text-slate-400 transition-transform duration-200 ${
            isOpen ? 'rotate-0' : 'rotate-180'
          }`}
        />
      </button>

      {/* 展開パネル本体（プリセット選択ボタン ＋ 選択中の山岳情報を1つのカードに集約） */}
      {isOpen && (
        <div
          id="preset-nav-panel"
          className="vt-preset-card rounded-2xl bg-slate-900/85 backdrop-blur-md border border-slate-700/80 shadow-2xl p-3 text-slate-100 w-full space-y-2.5"
        >
          {/* 山岳エリア選択ボタン群 */}
          <div
            className="grid grid-cols-2 sm:grid-cols-4 gap-1.5"
            role="group"
            aria-label="山岳エリア選択"
          >
            {presets.map((preset) => {
              const isSelected = preset.id === activePreset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => onSelectPreset(preset)}
                  aria-pressed={isSelected}
                  className={`relative flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-medium transition-colors cursor-pointer select-none whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                    isSelected
                      ? 'text-white font-semibold shadow-md'
                      : 'text-slate-300 hover:text-white hover:bg-slate-800/70 bg-slate-800/40'
                  }`}
                >
                  {isSelected && (
                    <span
                      className="vt-active-pill absolute inset-0 rounded-xl bg-gradient-to-r from-sky-500/90 to-blue-600/90 border border-sky-300/40 -z-10"
                      aria-hidden="true"
                    />
                  )}
                  <span className="text-sm leading-none">{preset.emoji}</span>
                  <span>{preset.name}</span>
                </button>
              );
            })}
          </div>

          {/* 選択中の山岳概要・標高・現在の雨量 */}
          <div className="pt-2 border-t border-slate-800/90 space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <span className="text-base leading-none" aria-hidden="true">
                  {activePreset.emoji}
                </span>
                <h2
                  id="preset-active-heading"
                  tabIndex={-1}
                  className="vt-preset-title text-sm font-bold tracking-tight text-white outline-none"
                >
                  {activePreset.name}
                </h2>
                <span className="text-[11px] text-slate-400">({activePreset.region})</span>
              </div>
              <span className="text-[11px] font-medium text-sky-300">
                {getRainSummaryLabel(activePresetRain)}
              </span>
            </div>

            <p className="text-[11px] text-slate-300 leading-relaxed">
              {activePreset.description}
            </p>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <div className="vt-preset-elevation inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/15 border border-amber-400/30 text-amber-200 font-mono text-[11px] font-semibold">
                <Mountain className="w-3.5 h-3.5 text-amber-400" />
                <span>標高 {activePreset.elevation.toLocaleString()} m</span>
              </div>

              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-sky-500/15 border border-sky-400/30 text-sky-200 font-mono text-[11px] font-semibold">
                <CloudRain className="w-3.5 h-3.5 text-sky-400" />
                <span>
                  山頂付近の雨量:{' '}
                  {activePresetRain !== null ? `${activePresetRain.toFixed(1)} mm/h` : '計測中...'}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
