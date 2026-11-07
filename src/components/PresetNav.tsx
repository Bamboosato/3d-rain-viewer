import React, { useEffect, useMemo, useState } from 'react';
import {
  Compass,
  Mountain,
  ChevronUp,
  Search,
  X,
  MapPin,
  Star,
  Trash2,
  Loader2,
} from 'lucide-react';
import type { PresetLocation } from '../types/map';
import { AREA_GROUPS } from '../lib/hyakumeizanData';
import {
  searchOsmLocationsByKeyword,
  type OsmSearchLocation,
} from '../lib/osmPlaceClient';
import { runViewTransition } from '../lib/viewTransition';

type NavTabId = 'hyakumeizan' | 'favorites' | 'search';

interface PresetNavProps {
  presets: PresetLocation[];
  favorites?: PresetLocation[];
  activePreset: PresetLocation;
  activePresetRain?: number | null;
  onSelectPreset: (preset: PresetLocation) => void;
  onRemoveFavorite?: (id: string) => void;
  isOpen?: boolean;
  onToggleOpen?: () => void;
}

export const PresetNav: React.FC<PresetNavProps> = ({
  presets,
  favorites = [],
  activePreset,
  onSelectPreset,
  onRemoveFavorite,
  isOpen: controlledIsOpen,
  onToggleOpen,
}) => {
  const [internalIsOpen, setInternalIsOpen] = useState<boolean>(false);
  const isOpen = controlledIsOpen ?? internalIsOpen;

  const [activeTab, setActiveTab] = useState<NavTabId>('hyakumeizan');
  const [selectedArea, setSelectedArea] = useState<string>(
    activePreset.areaGroup && !activePreset.isFavorite
      ? activePreset.areaGroup
      : '富士山・八ヶ岳・中央アルプス'
  );
  const [selectedPrefecture, setSelectedPrefecture] = useState<string>('ALL');

  // 「🔍 検索」タブ専用の状態
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [osmResults, setOsmResults] = useState<OsmSearchLocation[]>([]);
  const [isSearchingOsm, setIsSearchingOsm] = useState<boolean>(false);

  const handleToggleOpen = () => {
    if (onToggleOpen) {
      onToggleOpen();
      return;
    }
    runViewTransition(() => {
      setInternalIsOpen((prev) => !prev);
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

  // 選択中の地域ブロックでフィルタした百名山リスト
  const areaFilteredPresets = useMemo(() => {
    if (selectedArea === 'ALL') return presets;
    return presets.filter((p) => p.areaGroup === selectedArea);
  }, [presets, selectedArea]);

  // 選択中の地域ブロックに含まれる都道府県一覧と座数
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

  // 「🏔️ 百名山」タブ用の都道府県絞り込み済みリスト
  const filteredMountains = useMemo(() => {
    if (selectedPrefecture === 'ALL') return areaFilteredPresets;
    return areaFilteredPresets.filter((p) => {
      const prefs = p.prefectures ?? [p.region];
      return prefs.includes(selectedPrefecture);
    });
  }, [areaFilteredPresets, selectedPrefecture]);

  // 「🔍 検索」タブ用：お気に入り＋百名山からのローカル即時一致（最大6件）
  const localMatchedPresets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    const allLocal = [...favorites, ...presets];
    return allLocal
      .filter((p) => {
        const matchName = p.name.toLowerCase().includes(q);
        const matchKana = (p.kana ?? '').toLowerCase().includes(q);
        const matchRegion = p.region.toLowerCase().includes(q);
        const matchArea = (p.areaGroup ?? '').toLowerCase().includes(q);
        return matchName || matchKana || matchRegion || matchArea;
      })
      .slice(0, 6);
  }, [favorites, presets, searchQuery]);

  // 「🔍 検索」タブでキーワード入力時に OpenStreetMap (Nominatim) をデバウンス検索
  useEffect(() => {
    if (activeTab !== 'search') return;
    const trimmed = searchQuery.trim();
    if (trimmed.length === 0) {
      setOsmResults([]);
      setIsSearchingOsm(false);
      return;
    }

    const controller = new AbortController();
    setIsSearchingOsm(true);

    const timer = window.setTimeout(() => {
      searchOsmLocationsByKeyword(trimmed, controller.signal)
        .then((items) => {
          if (!controller.signal.aborted) {
            setOsmResults(items);
            setIsSearchingOsm(false);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setIsSearchingOsm(false);
          }
        });
    }, 350);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [searchQuery, activeTab]);

  const handleAreaChange = (newArea: string) => {
    setSelectedArea(newArea);
    setSelectedPrefecture('ALL');
  };

  const handleSelectOsmLocation = (item: OsmSearchLocation) => {
    const asPreset: PresetLocation = {
      id: item.id,
      name: item.name,
      emoji: item.emoji,
      region: item.subLabel,
      elevation: 0,
      center: [item.lng, item.lat],
      zoom: item.recommendedZoom,
      pitch: 60,
      bearing: 0,
      description: `${item.subLabel}（${item.category}）`,
    };
    setInternalIsOpen(false);
    onSelectPreset(asPreset);
  };

  return (
    <section
      aria-label="地点切り替え・検索ナビゲーション"
      className="pointer-events-auto relative flex items-center min-w-0 shrink"
    >
      {/* 表示／非表示 トグルボタン */}
      <button
        type="button"
        id="preset-nav-toggle-btn"
        onClick={handleToggleOpen}
        aria-expanded={isOpen}
        aria-controls="preset-nav-panel"
        className="inline-flex items-center gap-1 sm:gap-1.5 min-h-[38px] sm:min-h-[42px] px-2.5 sm:px-3.5 py-1.5 rounded-xl bg-slate-900/90 hover:bg-slate-800/95 backdrop-blur-md border border-slate-700/80 shadow-lg text-xs sm:text-sm font-bold text-slate-100 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 min-w-0 max-w-full"
      >
        <Compass className="w-4 h-4 text-sky-400 shrink-0" />
        <span className="hidden md:inline shrink-0">地点切替・検索</span>
        <span className="px-2 py-0.5 rounded-lg bg-slate-800/90 border border-slate-700 text-xs font-semibold text-sky-200 max-w-[6.5rem] sm:max-w-[12rem] truncate">
          {activePreset.emoji} {activePreset.name}
        </span>
        <ChevronUp
          className={`w-3.5 h-3.5 sm:w-4 sm:h-4 text-slate-400 transition-transform duration-200 shrink-0 ${
            isOpen ? 'rotate-0' : 'rotate-180'
          }`}
        />
      </button>

      {/* 展開パネル本体 */}
      {isOpen && (
        <div
          id="preset-nav-panel"
          className="vt-preset-card safe-top-dropdown fixed z-30 rounded-2xl bg-slate-900/95 backdrop-blur-md border border-slate-700/80 shadow-2xl p-3.5 text-slate-100 w-[calc(100vw-1.5rem)] sm:w-[26rem] max-w-md space-y-3 overflow-y-auto"
        >
          {/* 3タブ切替: 🏔️ 百名山 / ⭐ お気に入り / 🔍 検索 */}
          <div className="grid grid-cols-3 gap-1 p-1 rounded-xl bg-slate-950/85 border border-slate-800">
            <button
              type="button"
              id="preset-tab-hyakumeizan"
              onClick={() => setActiveTab('hyakumeizan')}
              className={`inline-flex items-center justify-center gap-1 min-h-[36px] px-2 py-1 rounded-lg text-xs font-bold transition-colors cursor-pointer truncate ${
                activeTab === 'hyakumeizan'
                  ? 'bg-sky-500/25 text-sky-200 border border-sky-400/50 shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Mountain className="w-3.5 h-3.5 text-sky-400 shrink-0" />
              <span className="truncate">百名山 ({presets.length})</span>
            </button>

            <button
              type="button"
              id="preset-tab-favorites"
              onClick={() => setActiveTab('favorites')}
              className={`inline-flex items-center justify-center gap-1 min-h-[36px] px-2 py-1 rounded-lg text-xs font-bold transition-colors cursor-pointer truncate ${
                activeTab === 'favorites'
                  ? 'bg-amber-500/25 text-amber-200 border border-amber-400/50 shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Star className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span className="truncate">お気に入り ({favorites.length})</span>
            </button>

            <button
              type="button"
              id="preset-tab-search"
              onClick={() => setActiveTab('search')}
              className={`inline-flex items-center justify-center gap-1 min-h-[36px] px-2 py-1 rounded-lg text-xs font-bold transition-colors cursor-pointer truncate ${
                activeTab === 'search'
                  ? 'bg-emerald-500/25 text-emerald-200 border border-emerald-400/50 shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Search className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span className="truncate">地名・施設検索</span>
            </button>
          </div>

          {/* === タブ1: 🏔️ 日本百名山（検索枠なし・地域＆都道府県セレクトのみ） === */}
          {activeTab === 'hyakumeizan' && (
            <div className="space-y-2.5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-xs text-slate-300 font-semibold">
                  <span className="inline-flex items-center gap-1 px-0.5 truncate">
                    <MapPin className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                    <span>地域・山域</span>
                  </span>
                  <select
                    id="preset-area-select"
                    aria-label="地域・山域を選択"
                    value={selectedArea}
                    onChange={(e) => handleAreaChange(e.target.value)}
                    className="w-full rounded-xl bg-slate-950/90 border border-slate-700/90 px-3 py-2 text-base sm:text-xs text-slate-100 font-medium focus:outline-none focus:ring-2 focus:ring-sky-400 cursor-pointer"
                  >
                    <option value="ALL">すべて表示 ({presets.length}座)</option>
                    {AREA_GROUPS.map((area) => (
                      <option key={area} value={area}>
                        {area} ({areaCounts.get(area) ?? 0}座)
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1 text-xs text-slate-300 font-semibold">
                  <span className="inline-flex items-center gap-1 px-0.5 truncate">
                    <Compass className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    <span>都道府県</span>
                  </span>
                  <select
                    id="preset-pref-select"
                    aria-label="都道府県で絞り込む"
                    value={selectedPrefecture}
                    onChange={(e) => setSelectedPrefecture(e.target.value)}
                    className="w-full rounded-xl bg-slate-950/90 border border-slate-700/90 px-3 py-2 text-base sm:text-xs text-slate-100 font-medium focus:outline-none focus:ring-2 focus:ring-sky-400 cursor-pointer"
                  >
                    <option value="ALL">すべて ({areaFilteredPresets.length}座)</option>
                    {availablePrefectures.map((pref) => (
                      <option key={pref.name} value={pref.name}>
                        {pref.name} ({pref.count}座)
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs text-slate-300 font-semibold px-0.5">
                  <span>山岳を選択 ({filteredMountains.length}座)</span>
                  {activePreset.areaGroup &&
                    !activePreset.isFavorite &&
                    selectedArea !== activePreset.areaGroup && (
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedArea(activePreset.areaGroup ?? 'ALL');
                          setSelectedPrefecture('ALL');
                        }}
                        className="text-sky-400 hover:text-sky-300 underline cursor-pointer truncate"
                      >
                        選択中の「{activePreset.name}」を表示
                      </button>
                    )}
                </div>

                <div
                  id="preset-mountain-list"
                  role="group"
                  aria-label="百名山リスト"
                  className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-56 overflow-y-auto pr-1"
                >
                  {filteredMountains.map((preset) => {
                    const isSelected = preset.id === activePreset.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => {
                          setInternalIsOpen(false);
                          onSelectPreset(preset);
                        }}
                        aria-pressed={isSelected}
                        className={`relative flex flex-col items-start justify-center px-3 py-2 rounded-xl text-left transition-colors cursor-pointer select-none min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
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
                          {preset.elevation.toLocaleString()}m · {preset.region}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* === タブ2: ⭐ お気に入り（検索枠なし・シンプル一覧） === */}
          {activeTab === 'favorites' && (
            <div className="space-y-1.5">
              <div className="text-xs text-slate-300 font-semibold px-0.5">
                登録済みのお気に入り ({favorites.length}件)
              </div>

              <div
                id="preset-favorite-list"
                role="group"
                aria-label="お気に入り地点リスト"
                className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-64 overflow-y-auto pr-1"
              >
                {favorites.map((preset) => {
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
                          {preset.elevation > 0 ? `${preset.elevation.toLocaleString()}m · ` : ''}
                          ズーム{preset.zoom.toFixed(1)} · 傾き{Math.round(preset.pitch)}°
                        </div>
                      </button>

                      {onRemoveFavorite && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemoveFavorite(preset.id);
                          }}
                          title={`「${preset.name}」を削除`}
                          aria-label={`「${preset.name}」を削除`}
                          className="p-2 mr-1 rounded-lg text-slate-300 hover:text-rose-300 hover:bg-rose-500/20 transition-colors cursor-pointer shrink-0"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  );
                })}

                {favorites.length === 0 && (
                  <div className="col-span-full py-6 px-3 text-center text-xs text-slate-400 bg-slate-950/60 rounded-xl border border-slate-800/80">
                    地図上の地点をタップして「⭐ お気に入りに追加」から登録できます。
                  </div>
                )}
              </div>
            </div>
          )}

          {/* === タブ3: 🔍 地名・施設検索（OpenStreetMap全国検索 ＋ 百名山・お気に入り横断） === */}
          {activeTab === 'search' && (
            <div className="space-y-2.5">
              <div className="relative flex items-center">
                <Search className="w-4 h-4 text-emerald-400 absolute left-3 pointer-events-none" />
                <input
                  id="preset-search-input"
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="地名・施設・山小屋・駅名などを入力"
                  aria-label="地名・施設・山名を検索"
                  autoFocus
                  className="w-full rounded-xl bg-slate-950/90 border border-slate-700 focus:border-emerald-400 pl-9 pr-9 py-2 text-base sm:text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                />
                {isSearchingOsm ? (
                  <Loader2 className="w-4 h-4 text-emerald-400 animate-spin absolute right-3 pointer-events-none" />
                ) : (
                  searchQuery.length > 0 && (
                    <button
                      type="button"
                      aria-label="検索キーワードをクリア"
                      onClick={() => setSearchQuery('')}
                      className="absolute right-2.5 p-1 rounded-md text-slate-400 hover:text-white cursor-pointer"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )
                )}
              </div>

              <div className="max-h-64 overflow-y-auto space-y-2.5 pr-1">
                {searchQuery.trim().length === 0 && (
                  <div className="py-6 px-3 text-center text-xs text-slate-400 bg-slate-950/60 rounded-xl border border-slate-800/80">
                    キーワードを入力すると、全国の地名・施設（OpenStreetMap）や百名山から候補を表示します。
                  </div>
                )}

                {/* 1. ローカル一致（お気に入り・日本百名山） */}
                {localMatchedPresets.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-xs font-semibold text-sky-300 px-0.5">
                      百名山・お気に入り ({localMatchedPresets.length}件)
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                      {localMatchedPresets.map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => {
                            setInternalIsOpen(false);
                            onSelectPreset(preset);
                          }}
                          className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-slate-800/60 hover:bg-slate-800 border border-slate-700/80 text-left transition-colors cursor-pointer"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="text-sm shrink-0">{preset.emoji}</span>
                              <span className="text-xs font-bold text-white truncate">
                                {preset.name}
                              </span>
                            </div>
                            <div className="text-[11px] text-slate-400 truncate mt-0.5">
                              {preset.isFavorite
                                ? 'お気に入り登録地点'
                                : `${preset.elevation.toLocaleString()}m · ${preset.region}`}
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* 2. OpenStreetMap 全国スポット検索結果 */}
                {searchQuery.trim().length > 0 && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs font-semibold text-emerald-300 px-0.5">
                      <span>全国の地名・施設候補 (OpenStreetMap)</span>
                      {isSearchingOsm && (
                        <span className="text-[11px] text-slate-400 font-normal">検索中...</span>
                      )}
                    </div>

                    {osmResults.length > 0 ? (
                      <div className="grid grid-cols-1 gap-1.5">
                        {osmResults.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => handleSelectOsmLocation(item)}
                            className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-slate-950/80 hover:bg-slate-800 border border-slate-800 hover:border-emerald-500/40 text-left transition-colors cursor-pointer"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="text-sm shrink-0">{item.emoji}</span>
                                <span className="text-xs font-bold text-white truncate">
                                  {item.name}
                                </span>
                                <span className="px-1.5 py-0.5 rounded bg-slate-800 text-[10px] text-emerald-300 shrink-0">
                                  {item.category}
                                </span>
                              </div>
                              <div className="text-[11px] text-slate-400 truncate mt-0.5">
                                {item.subLabel}
                              </div>
                            </div>
                          </button>
                        ))}
                      </div>
                    ) : (
                      !isSearchingOsm && (
                        <div className="py-4 px-3 text-center text-xs text-slate-400 bg-slate-950/60 rounded-xl border border-slate-800/80">
                          一致する地名・施設が見つかりませんでした。
                        </div>
                      )
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
};

