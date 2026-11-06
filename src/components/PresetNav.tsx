import React, { useMemo, useState } from 'react';
import { Compass, Mountain, CloudRain, ChevronUp, Search, X, MapPin } from 'lucide-react';
import type { PresetLocation } from '../types/map';
import { AREA_GROUPS } from '../lib/hyakumeizanData';
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
  const [isOpen, setIsOpen] = useState<boolean>(false);
  // 初期状態は現在選択中の山岳の地域ブロックを選択状態にして一覧を見やすくする
  const [selectedArea, setSelectedArea] = useState<string>(
    activePreset.areaGroup ?? '富士山・八ヶ岳・中央アルプス'
  );
  const [selectedPrefecture, setSelectedPrefecture] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const handleToggleOpen = () => {
    runViewTransition(() => {
      setIsOpen((prev) => !prev);
    });
  };

  // 各地域ブロックごとの山岳数集計
  const areaCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of presets) {
      const area = p.areaGroup ?? 'その他';
      counts.set(area, (counts.get(area) ?? 0) + 1);
    }
    return counts;
  }, [presets]);

  // 選択中の地域ブロックでフィルタした山岳リスト
  const areaFilteredPresets = useMemo(() => {
    if (selectedArea === 'ALL') return presets;
    return presets.filter((p) => p.areaGroup === selectedArea);
  }, [presets, selectedArea]);

  // 選択中の地域ブロックに含まれる都道府県一覧とそれぞれの座数
  const availablePrefectures = useMemo(() => {
    const prefMap = new Map<string, number>();
    for (const p of areaFilteredPresets) {
      const prefs = p.prefectures ?? [p.region];
      for (const pref of prefs) {
        prefMap.set(pref, (prefMap.get(pref) ?? 0) + 1);
      }
    }
    return Array.from(prefMap.entries()).map(([name, count]) => ({ name, count }));
  }, [areaFilteredPresets]);

  // 地域・都道府県・キーワード検索を組み合わせた最終的な山岳リスト
  const filteredPresets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    // 検索キーワードが入力されている場合は、地域・都道府県の枠を超えて全100名山から横断検索可能にする
    const baseList = q.length > 0 ? presets : areaFilteredPresets;

    return baseList.filter((p) => {
      if (q.length === 0 && selectedPrefecture !== 'ALL') {
        const prefs = p.prefectures ?? [p.region];
        if (!prefs.includes(selectedPrefecture)) {
          return false;
        }
      }
      if (q.length > 0) {
        const matchName = p.name.toLowerCase().includes(q);
        const matchKana = (p.kana ?? '').toLowerCase().includes(q);
        const matchRegion = p.region.toLowerCase().includes(q);
        const matchArea = (p.areaGroup ?? '').toLowerCase().includes(q);
        return matchName || matchKana || matchRegion || matchArea;
      }
      return true;
    });
  }, [presets, areaFilteredPresets, selectedPrefecture, searchQuery]);

  const handleAreaChange = (newArea: string) => {
    setSelectedArea(newArea);
    setSelectedPrefecture('ALL');
  };

  return (
    <section
      aria-label="日本百名山プリセット切り替えナビゲーション"
      className="pointer-events-auto flex flex-col items-start gap-2 w-[calc(100vw-2rem)] sm:w-[26rem] max-w-md"
    >
      {/* 表示／非表示 トグルボタン */}
      <button
        type="button"
        id="preset-nav-toggle-btn"
        onClick={handleToggleOpen}
        aria-expanded={isOpen}
        aria-controls="preset-nav-panel"
        className="inline-flex items-center gap-1.5 min-h-[40px] px-3 py-1.5 rounded-2xl bg-slate-900/85 hover:bg-slate-800/95 backdrop-blur-md border border-slate-700/80 shadow-xl text-xs font-semibold text-slate-100 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        <Compass className="w-4 h-4 text-sky-400 shrink-0" />
        <span className="hidden sm:inline">日本百名山プリセット</span>
        <span className="sm:hidden">百名山</span>
        <span className="px-2 py-0.5 rounded-lg bg-slate-800/90 border border-slate-700 text-[11px] font-medium text-sky-200">
          {activePreset.emoji} {activePreset.name}
        </span>
        <ChevronUp
          className={`w-3.5 h-3.5 text-slate-400 transition-transform duration-200 ${
            isOpen ? 'rotate-0' : 'rotate-180'
          }`}
        />
      </button>

      {/* 展開パネル本体（地域・都道府県階層セレクタ ＋ 山岳リスト ＋ 選択中の山岳詳細） */}
      {isOpen && (
        <div
          id="preset-nav-panel"
          className="vt-preset-card rounded-2xl bg-slate-900/85 backdrop-blur-md border border-slate-700/80 shadow-2xl p-3 text-slate-100 w-full space-y-2.5"
        >
          {/* 階層ステップ1: 地域ブロック ➔ 都道府県 絞り込みセレクト */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            <label className="flex flex-col gap-1 text-[10px] text-slate-400 font-medium">
              <span className="inline-flex items-center gap-1 px-0.5">
                <MapPin className="w-3 h-3 text-sky-400" />
                <span>1. 地域・山域を選ぶ</span>
              </span>
              <select
                id="preset-area-select"
                aria-label="地域・山域を選択"
                value={selectedArea}
                onChange={(e) => handleAreaChange(e.target.value)}
                className="w-full rounded-xl bg-slate-950/90 border border-slate-700/90 px-2.5 py-1.5 text-xs text-slate-100 font-medium focus:outline-none focus:ring-2 focus:ring-sky-400 cursor-pointer"
              >
                <option value="ALL">すべて表示 ({presets.length}座)</option>
                {AREA_GROUPS.map((area) => (
                  <option key={area} value={area}>
                    {area} ({areaCounts.get(area) ?? 0}座)
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-[10px] text-slate-400 font-medium">
              <span className="inline-flex items-center gap-1 px-0.5">
                <Compass className="w-3 h-3 text-emerald-400" />
                <span>2. 都道府県で絞り込む</span>
              </span>
              <select
                id="preset-pref-select"
                aria-label="都道府県で絞り込む"
                value={selectedPrefecture}
                onChange={(e) => setSelectedPrefecture(e.target.value)}
                className="w-full rounded-xl bg-slate-950/90 border border-slate-700/90 px-2.5 py-1.5 text-xs text-slate-100 font-medium focus:outline-none focus:ring-2 focus:ring-sky-400 cursor-pointer"
              >
                <option value="ALL">
                  すべての都道府県 ({areaFilteredPresets.length}座)
                </option>
                {availablePrefectures.map((pref) => (
                  <option key={pref.name} value={pref.name}>
                    {pref.name} ({pref.count}座)
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* クイック検索バー（山名・よみがな・都道府県） */}
          <div className="relative flex items-center">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 pointer-events-none" />
            <input
              id="preset-search-input"
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="山名・よみがな・都道府県で検索 (例: 槍ヶ岳, やり, 北海道)"
              aria-label="百名山を山名やよみがなで検索"
              className="w-full rounded-xl bg-slate-950/75 border border-slate-800 focus:border-sky-400/70 pl-8 pr-7 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-sky-400"
            />
            {searchQuery.length > 0 && (
              <button
                type="button"
                aria-label="検索キーワードをクリア"
                onClick={() => setSearchQuery('')}
                className="absolute right-2 p-0.5 rounded-md text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* 階層ステップ2: 絞り込まれた山岳選択グリッド */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[10px] text-slate-400 px-0.5">
              <span>
                3. 山岳を選択 ({filteredPresets.length} / {presets.length}座)
              </span>
              {activePreset.areaGroup && selectedArea !== activePreset.areaGroup && searchQuery === '' && (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedArea(activePreset.areaGroup ?? 'ALL');
                    setSelectedPrefecture('ALL');
                  }}
                  className="text-sky-400 hover:text-sky-300 underline cursor-pointer"
                >
                  選択中の「{activePreset.name}」の地域を表示
                </button>
              )}
            </div>

            <div
              id="preset-mountain-list"
              role="group"
              aria-label="山岳選択リスト"
              className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 max-h-40 overflow-y-auto pr-1"
            >
              {filteredPresets.map((preset) => {
                const isSelected = preset.id === activePreset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => onSelectPreset(preset)}
                    aria-pressed={isSelected}
                    className={`relative flex flex-col items-start justify-center px-2.5 py-1.5 rounded-xl text-left transition-colors cursor-pointer select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                      isSelected
                        ? 'text-white font-semibold shadow-md'
                        : 'text-slate-200 hover:text-white hover:bg-slate-800/80 bg-slate-800/45 border border-slate-800/80'
                    }`}
                  >
                    {isSelected && (
                      <span
                        className="vt-active-pill absolute inset-0 rounded-xl bg-gradient-to-r from-sky-500/90 to-blue-600/90 border border-sky-300/40 -z-10"
                        aria-hidden="true"
                      />
                    )}
                    <div className="flex items-center gap-1 w-full min-w-0">
                      <span className="text-xs leading-none shrink-0">{preset.emoji}</span>
                      <span className="text-xs truncate">{preset.name}</span>
                    </div>
                    <div
                      className={`text-[10px] font-mono truncate w-full ${
                        isSelected ? 'text-sky-100' : 'text-slate-400'
                      }`}
                    >
                      {preset.elevation.toLocaleString()}m · {preset.region}
                    </div>
                  </button>
                );
              })}

              {filteredPresets.length === 0 && (
                <div className="col-span-full py-4 text-center text-xs text-slate-400">
                  条件に一致する百名山が見つかりませんでした。
                </div>
              )}
            </div>
          </div>

          {/* 選択中の山岳概要・標高・現在の雨量 */}
          <div className="pt-2 border-t border-slate-800/90 space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
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
              <span className="text-[11px] font-medium text-sky-300 shrink-0">
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
