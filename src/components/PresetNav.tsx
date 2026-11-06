import React, { useMemo, useState } from 'react';
import {
  Compass,
  Mountain,
  CloudRain,
  ChevronUp,
  Search,
  X,
  MapPin,
  Star,
  Trash2,
} from 'lucide-react';
import type { PresetLocation } from '../types/map';
import { AREA_GROUPS } from '../lib/hyakumeizanData';
import { FAVORITE_AREA_GROUP } from '../lib/favoritesStorage';
import { runViewTransition } from '../lib/viewTransition';

interface PresetNavProps {
  presets: PresetLocation[];
  favorites?: PresetLocation[];
  activePreset: PresetLocation;
  activePresetRain: number | null;
  onSelectPreset: (preset: PresetLocation) => void;
  onRemoveFavorite?: (id: string) => void;
  isOpen?: boolean;
  onToggleOpen?: () => void;
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
  favorites = [],
  activePreset,
  activePresetRain,
  onSelectPreset,
  onRemoveFavorite,
  isOpen: controlledIsOpen,
  onToggleOpen,
}) => {
  const [internalIsOpen, setInternalIsOpen] = useState<boolean>(false);
  const isOpen = controlledIsOpen ?? internalIsOpen;
  // 初期状態は現在選択中の山岳の地域ブロックを選択状態にして一覧を見やすくする
  const [selectedArea, setSelectedArea] = useState<string>(
    activePreset.areaGroup ?? '富士山・八ヶ岳・中央アルプス'
  );
  const [selectedPrefecture, setSelectedPrefecture] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const handleToggleOpen = () => {
    if (onToggleOpen) {
      onToggleOpen();
      return;
    }
    runViewTransition(() => {
      setInternalIsOpen((prev) => !prev);
    });
  };

  // 全リスト（お気に入り＋百名山100座）
  const allLocations = useMemo(() => [...favorites, ...presets], [favorites, presets]);

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
    if (selectedArea === FAVORITE_AREA_GROUP) return favorites;
    if (selectedArea === 'ALL') return presets;
    return presets.filter((p) => p.areaGroup === selectedArea);
  }, [presets, favorites, selectedArea]);

  // 選択中の地域ブロックに含まれる都道府県一覧とそれぞれの座数
  const availablePrefectures = useMemo(() => {
    if (selectedArea === FAVORITE_AREA_GROUP) return [];
    const prefMap = new Map<string, number>();
    for (const p of areaFilteredPresets) {
      const prefs = p.prefectures ?? [p.region];
      for (const pref of prefs) {
        prefMap.set(pref, (prefMap.get(pref) ?? 0) + 1);
      }
    }
    return Array.from(prefMap.entries()).map(([name, count]) => ({ name, count }));
  }, [areaFilteredPresets, selectedArea]);

  // 地域・都道府県・キーワード検索を組み合わせた最終的な山岳リスト
  const filteredPresets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    // 検索キーワードが入力されている場合は、お気に入り＋全100名山から横断検索可能にする
    const baseList = q.length > 0 ? allLocations : areaFilteredPresets;

    return baseList.filter((p) => {
      if (
        q.length === 0 &&
        selectedArea !== FAVORITE_AREA_GROUP &&
        selectedPrefecture !== 'ALL'
      ) {
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
  }, [allLocations, areaFilteredPresets, selectedArea, selectedPrefecture, searchQuery]);

  const handleAreaChange = (newArea: string) => {
    setSelectedArea(newArea);
    setSelectedPrefecture('ALL');
  };

  const isFavoriteView = selectedArea === FAVORITE_AREA_GROUP && searchQuery.trim() === '';

  return (
    <section
      aria-label="日本百名山・お気に入り地点切り替えナビゲーション"
      className="pointer-events-auto relative flex items-center"
    >
      {/* 表示／非表示 トグルボタン */}
      <button
        type="button"
        id="preset-nav-toggle-btn"
        onClick={handleToggleOpen}
        aria-expanded={isOpen}
        aria-controls="preset-nav-panel"
        className="inline-flex items-center gap-1.5 min-h-[42px] px-3 sm:px-3.5 py-1.5 rounded-xl bg-slate-900/90 hover:bg-slate-800/95 backdrop-blur-md border border-slate-700/80 shadow-lg text-xs sm:text-sm font-bold text-slate-100 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        <Compass className="w-4 h-4 text-sky-400 shrink-0" />
        <span className="hidden md:inline">百名山・お気に入り</span>
        <span className="px-2 py-0.5 rounded-lg bg-slate-800/90 border border-slate-700 text-xs font-semibold text-sky-200 max-w-[9rem] sm:max-w-none truncate">
          {activePreset.emoji} {activePreset.name}
        </span>
        <ChevronUp
          className={`w-4 h-4 text-slate-400 transition-transform duration-200 shrink-0 ${
            isOpen ? 'rotate-0' : 'rotate-180'
          }`}
        />
      </button>

      {/* 展開パネル本体（右上ツールバー直下に固定展開 + iPhone safe-area-inset-top 対応） */}
      {isOpen && (
        <div
          id="preset-nav-panel"
          className="vt-preset-card safe-top-dropdown fixed z-30 rounded-2xl bg-slate-900/90 backdrop-blur-md border border-slate-700/80 shadow-2xl p-3.5 text-slate-100 w-[calc(100vw-1.5rem)] sm:w-[26rem] max-w-md space-y-2.5 overflow-y-auto"
        >
          {/* クイック切替タブ: 日本百名山 ⇄ ⭐ お気に入り地点 */}
          <div className="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-slate-950/85 border border-slate-800">
            <button
              type="button"
              id="preset-tab-hyakumeizan"
              onClick={() => {
                if (selectedArea === FAVORITE_AREA_GROUP) {
                  handleAreaChange(
                    activePreset.areaGroup && activePreset.areaGroup !== FAVORITE_AREA_GROUP
                      ? activePreset.areaGroup
                      : '富士山・八ヶ岳・中央アルプス'
                  );
                }
              }}
              className={`inline-flex items-center justify-center gap-1.5 min-h-[36px] px-2.5 py-1 rounded-lg text-xs sm:text-sm font-bold transition-colors cursor-pointer ${
                selectedArea !== FAVORITE_AREA_GROUP
                  ? 'bg-sky-500/25 text-sky-200 border border-sky-400/50 shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Mountain className="w-4 h-4 text-sky-400 shrink-0" />
              <span>日本百名山 ({presets.length})</span>
            </button>

            <button
              type="button"
              id="preset-tab-favorites"
              onClick={() => handleAreaChange(FAVORITE_AREA_GROUP)}
              className={`inline-flex items-center justify-center gap-1.5 min-h-[36px] px-2.5 py-1 rounded-lg text-xs sm:text-sm font-bold transition-colors cursor-pointer ${
                selectedArea === FAVORITE_AREA_GROUP
                  ? 'bg-amber-500/25 text-amber-200 border border-amber-400/50 shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Star className="w-4 h-4 text-amber-400 shrink-0" />
              <span>お気に入り ({favorites.length})</span>
            </button>
          </div>

          {/* 階層ステップ1: 地域ブロック ➔ 都道府県 絞り込みセレクト（百名山モード時のみ表示） */}
          {!isFavoriteView && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <label className="flex flex-col gap-1 text-xs text-slate-300 font-semibold">
                <span className="inline-flex items-center gap-1 px-0.5">
                  <MapPin className="w-3.5 h-3.5 text-sky-400" />
                  <span>1. 地域・山域を選ぶ</span>
                </span>
                <select
                  id="preset-area-select"
                  aria-label="地域・山域を選択"
                  value={selectedArea}
                  onChange={(e) => handleAreaChange(e.target.value)}
                  className="w-full rounded-xl bg-slate-950/90 border border-slate-700/90 px-3 py-2 text-sm sm:text-xs text-slate-100 font-medium focus:outline-none focus:ring-2 focus:ring-sky-400 cursor-pointer"
                >
                  <option value="ALL">すべて表示 ({presets.length}座)</option>
                  <option value={FAVORITE_AREA_GROUP}>
                    {FAVORITE_AREA_GROUP} ({favorites.length}件)
                  </option>
                  {AREA_GROUPS.map((area) => (
                    <option key={area} value={area}>
                      {area} ({areaCounts.get(area) ?? 0}座)
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1 text-xs text-slate-300 font-semibold">
                <span className="inline-flex items-center gap-1 px-0.5">
                  <Compass className="w-3.5 h-3.5 text-emerald-400" />
                  <span>2. 都道府県で絞り込む</span>
                </span>
                <select
                  id="preset-pref-select"
                  aria-label="都道府県で絞り込む"
                  value={selectedPrefecture}
                  onChange={(e) => setSelectedPrefecture(e.target.value)}
                  className="w-full rounded-xl bg-slate-950/90 border border-slate-700/90 px-3 py-2 text-sm sm:text-xs text-slate-100 font-medium focus:outline-none focus:ring-2 focus:ring-sky-400 cursor-pointer"
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
          )}

          {/* クイック検索バー（山名・よみがな・都道府県・お気に入り名） */}
          <div className="relative flex items-center">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 pointer-events-none" />
            <input
              id="preset-search-input"
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="山名・よみがな・お気に入り名で検索"
              aria-label="百名山やお気に入り地点を検索"
              className="w-full rounded-xl bg-slate-950/75 border border-slate-800 focus:border-sky-400/70 pl-9 pr-8 py-2 text-sm sm:text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-sky-400"
            />
            {searchQuery.length > 0 && (
              <button
                type="button"
                aria-label="検索キーワードをクリア"
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 p-1 rounded-md text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* 階層ステップ2: 絞り込まれた山岳・お気に入り選択リスト */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs text-slate-300 font-semibold px-0.5">
              <span>
                {isFavoriteView
                  ? `登録済みのお気に入り地点 (${favorites.length}件)`
                  : `3. 山岳を選択 (${filteredPresets.length} / ${presets.length}座)`}
              </span>
              {!isFavoriteView &&
                activePreset.areaGroup &&
                selectedArea !== activePreset.areaGroup &&
                searchQuery === '' && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedArea(activePreset.areaGroup ?? 'ALL');
                      setSelectedPrefecture('ALL');
                    }}
                    className="text-sky-400 hover:text-sky-300 underline cursor-pointer"
                  >
                    選択中の「{activePreset.name}」を表示
                  </button>
                )}
            </div>

            <div
              id="preset-mountain-list"
              role="group"
              aria-label="山岳・お気に入り選択リスト"
              className={`grid gap-2 max-h-48 overflow-y-auto pr-1 ${
                isFavoriteView ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-2 sm:grid-cols-3'
              }`}
            >
              {filteredPresets.map((preset) => {
                const isSelected = preset.id === activePreset.id;
                return (
                  <div
                    key={preset.id}
                    className={`relative flex items-center justify-between gap-1 rounded-xl transition-colors ${
                      isSelected
                        ? 'text-white font-bold shadow-md'
                        : 'text-slate-100 hover:text-white hover:bg-slate-800/80 bg-slate-800/50 border border-slate-700/80'
                    }`}
                  >
                    {isSelected && (
                      <span
                        className="vt-active-pill absolute inset-0 rounded-xl bg-gradient-to-r from-sky-500/90 to-blue-600/90 border border-sky-300/40 -z-10"
                        aria-hidden="true"
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setInternalIsOpen(false);
                        onSelectPreset(preset);
                      }}
                      aria-pressed={isSelected}
                      className="flex-1 flex flex-col items-start justify-center px-3 py-2 text-left cursor-pointer select-none min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 rounded-xl"
                    >
                      <div className="flex items-center gap-1.5 w-full min-w-0">
                        <span className="text-sm leading-none shrink-0">{preset.emoji}</span>
                        <span className="text-sm sm:text-xs font-semibold truncate">
                          {preset.name}
                        </span>
                      </div>
                      <div
                        className={`text-xs sm:text-[10px] font-mono truncate w-full mt-0.5 ${
                          isSelected ? 'text-sky-100' : 'text-slate-400'
                        }`}
                      >
                        {preset.isFavorite
                          ? `${preset.elevation > 0 ? `${preset.elevation.toLocaleString()}m · ` : ''}ズーム${preset.zoom.toFixed(1)} · 傾き${Math.round(preset.pitch)}°`
                          : `${preset.elevation.toLocaleString()}m · ${preset.region}`}
                      </div>
                    </button>

                    {preset.isFavorite && onRemoveFavorite && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveFavorite(preset.id);
                        }}
                        title={`「${preset.name}」をお気に入りから削除`}
                        aria-label={`「${preset.name}」をお気に入りから削除`}
                        className="p-2 mr-1 rounded-lg text-slate-300 hover:text-rose-300 hover:bg-rose-500/20 transition-colors cursor-pointer shrink-0"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                );
              })}

              {filteredPresets.length === 0 && (
                <div className="col-span-full py-5 px-3 text-center text-xs text-slate-400 bg-slate-950/60 rounded-xl border border-slate-800/80 leading-relaxed">
                  {isFavoriteView
                    ? 'まだお気に入り地点が登録されていません。\n地図上の好きな地点をタップし、「地点インスペクター」の「⭐ お気に入り地点に登録」から保存できます。'
                    : '条件に一致する地点が見つかりませんでした。'}
                </div>
              )}
            </div>
          </div>

          {/* 選択中の山岳・地点概要・標高・現在の雨量 */}
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
                  付近の雨量:{' '}
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
