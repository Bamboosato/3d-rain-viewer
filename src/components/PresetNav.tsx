import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
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
  Share2,
  Check,
  ArrowRightLeft,
  Pin,
} from 'lucide-react';
import type { PresetLocation } from '../types/map';
import { AREA_GROUPS } from '../lib/hyakumeizanData';
import {
  FAVORITE_CATEGORY_LIST,
  getFavoriteCategoryMeta,
  type FavoriteCategory,
} from '../lib/favoriteCategories';
import {
  calcDistanceMeters,
  formatDistanceLabel,
  searchOsmLocationsByKeyword,
  type OsmSearchLocation,
  type SearchReferenceLocation,
} from '../lib/osmPlaceClient';
import { runViewTransition } from '../lib/viewTransition';

type NavTabId = 'hyakumeizan' | 'favorites' | 'search';

interface PresetNavProps {
  presets: PresetLocation[];
  favorites?: PresetLocation[];
  activePreset: PresetLocation;
  activePresetRain?: number | null;
  referenceLocation?: SearchReferenceLocation;
  onSelectPreset: (preset: PresetLocation) => void;
  onRemoveFavorite?: (id: string) => void;
  onShareFavorite?: (preset: PresetLocation) => void;
  /** お気に入りのピン留めトグル */
  onTogglePinFavorite?: (id: string) => void;
  /** お気に入りのバックアップ・引き継ぎダイアログを開く */
  onOpenFavoritesSync?: () => void;
  /** バックアップ推奨バッジを表示するか */
  backupRecommended?: boolean;
  isOpen?: boolean;
  onToggleOpen?: () => void;
}

export const PresetNav: React.FC<PresetNavProps> = ({
  presets,
  favorites = [],
  activePreset,
  referenceLocation,
  onSelectPreset,
  onRemoveFavorite,
  onShareFavorite,
  onTogglePinFavorite,
  onOpenFavoritesSync,
  backupRecommended = false,
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

  // 「🔍 検索」タブ専用の状態（文字入力 ➔ 検索ボタン押下で検索実行）
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [submittedQuery, setSubmittedQuery] = useState<string>('');
  const [osmResults, setOsmResults] = useState<OsmSearchLocation[]>([]);
  const [isSearchingOsm, setIsSearchingOsm] = useState<boolean>(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchRenderVersion, setSearchRenderVersion] = useState<number>(0);
  const [copiedFavoriteId, setCopiedFavoriteId] = useState<string | null>(null);
  const [gpsLocation, setGpsLocation] = useState<SearchReferenceLocation | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const lastExecutedAtRef = useRef<number>(0);

  useEffect(() => {
    return () => {
      searchAbortRef.current?.abort();
    };
  }, []);

  // GPS現在地の取得（許可されている場合は距離順ソートの第1優先基準位置として使用）
  useEffect(() => {
    if (!isOpen || (activeTab !== 'search' && activeTab !== 'favorites')) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGpsLocation({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        });
      },
      () => {
        // 位置情報未許可時は地図中心座標へフォールバック
      },
      {
        enableHighAccuracy: false,
        timeout: 4000,
        maximumAge: 600000,
      }
    );
  }, [isOpen, activeTab]);

  // 距離計算の基準位置（第1優先: GPS現在地 / 第2優先: 現在の地図中心または選択中プリセット座標）
  const effectiveRefLocation = useMemo<SearchReferenceLocation>(() => {
    if (gpsLocation) return gpsLocation;
    if (referenceLocation) return referenceLocation;
    return {
      lat: activePreset.center[1],
      lng: activePreset.center[0],
    };
  }, [gpsLocation, referenceLocation, activePreset.center]);

  // お気に入りの並び順（初期値: 近い順 'distance' / 登録順 'created'）
  const [favoritesSortOrder, setFavoritesSortOrder] = useState<'distance' | 'created'>(() => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const saved = window.localStorage.getItem('rain3d_favorites_sort_order');
        if (saved === 'created' || saved === 'distance') return saved;
      }
    } catch {
      // ignore
    }
    return 'distance';
  });

  const handleToggleFavoritesSortOrder = useCallback((order: 'distance' | 'created') => {
    setFavoritesSortOrder(order);
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem('rain3d_favorites_sort_order', order);
      }
    } catch {
      // ignore
    }
  }, []);

  // お気に入り一覧（ピン留め最上位 + 選択された並び順）
  const sortedFavorites = useMemo(() => {
    const list = favorites.map((fav) => {
      const distanceMeters = effectiveRefLocation
        ? calcDistanceMeters(
            effectiveRefLocation.lat,
            effectiveRefLocation.lng,
            fav.center[1],
            fav.center[0]
          )
        : undefined;
      return {
        preset: fav,
        distanceMeters,
      };
    });

    list.sort((a, b) => {
      // 1. ピン留め優先（ピン留め地点は最上位）
      const aPinned = Boolean(a.preset.isPinned);
      const bPinned = Boolean(b.preset.isPinned);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;

      // 2. 選択された並び順
      if (favoritesSortOrder === 'distance') {
        const distA = a.distanceMeters ?? Infinity;
        const distB = b.distanceMeters ?? Infinity;
        if (distA !== distB) return distA - distB;
      }

      // 登録順（作成日時の降順）
      const timeA = a.preset.createdAt ? Date.parse(a.preset.createdAt) : 0;
      const timeB = b.preset.createdAt ? Date.parse(b.preset.createdAt) : 0;
      return timeB - timeA;
    });

    return list;
  }, [favorites, effectiveRefLocation, favoritesSortOrder]);

  // お気に入りのカテゴリ絞り込み状態（初期値: 'ALL'）
  const [selectedFavCategory, setSelectedFavCategory] = useState<'ALL' | FavoriteCategory>('ALL');

  // カテゴリ別のお気に入り件数集計
  const favCategoryCounts = useMemo(() => {
    const counts: Record<string, number> = { ALL: favorites.length, nature: 0, tourism: 0, lifestyle: 0, other: 0 };
    for (const fav of favorites) {
      const cat = fav.category ?? 'other';
      counts[cat] = (counts[cat] ?? 0) + 1;
    }
    return counts;
  }, [favorites]);

  // 選択されたカテゴリでフィルタしたお気に入り一覧
  const filteredFavorites = useMemo(() => {
    if (selectedFavCategory === 'ALL') return sortedFavorites;
    return sortedFavorites.filter(({ preset }) => (preset.category ?? 'other') === selectedFavCategory);
  }, [sortedFavorites, selectedFavCategory]);

  // 非同期検索完了時にDOM再構築とブラウザの再描画（リフロー）を即時確定させるヘルパー
  const commitSearchUiUpdate = useCallback((updater: () => void) => {
    try {
      flushSync(() => {
        updater();
        setSearchRenderVersion((v) => v + 1);
      });
    } catch {
      updater();
      setSearchRenderVersion((v) => v + 1);
    }
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        if (panelRef.current) {
          void panelRef.current.offsetHeight;
        }
      });
    }
  }, []);

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

  // 「🔍 検索」タブ用：お気に入り優先 ➔ 名前の一致度 ➔ 現在位置から近い順 で最大6件抽出
  const localMatchedPresets = useMemo(() => {
    const q = submittedQuery.trim().toLowerCase();
    if (!q) return [];
    const allLocal = [...favorites, ...presets];

    const matched = allLocal
      .filter((p) => {
        const matchName = p.name.toLowerCase().includes(q);
        const matchKana = (p.kana ?? '').toLowerCase().includes(q);
        const matchRegion = p.region.toLowerCase().includes(q);
        const matchArea = (p.areaGroup ?? '').toLowerCase().includes(q);
        return matchName || matchKana || matchRegion || matchArea;
      })
      .map((p) => {
        const lowerName = p.name.toLowerCase();
        const lowerKana = (p.kana ?? '').toLowerCase();
        const matchTier =
          lowerName === q || lowerKana === q
            ? 1
            : lowerName.startsWith(q) || lowerKana.startsWith(q)
              ? 2
              : 3;
        const distanceMeters = calcDistanceMeters(
          effectiveRefLocation.lat,
          effectiveRefLocation.lng,
          p.center[1],
          p.center[0]
        );
        return {
          preset: p,
          favRank: p.isFavorite ? 0 : 1,
          matchTier,
          distanceMeters,
        };
      });

    matched.sort((a, b) => {
      if (a.favRank !== b.favRank) return a.favRank - b.favRank;
      if (a.matchTier !== b.matchTier) return a.matchTier - b.matchTier;
      return a.distanceMeters - b.distanceMeters;
    });

    return matched.slice(0, 6);
  }, [favorites, presets, submittedQuery, effectiveRefLocation]);

  // 検索ボタン押下（またはEnterキー）で 国土地理院 + OpenStreetMap (Nominatim) 検索を実行
  const executeSearch = useCallback(
    (rawInput?: string) => {
      const liveValue = rawInput ?? searchInputRef.current?.value ?? searchQuery;
      const trimmed = liveValue.trim();
      lastExecutedAtRef.current = Date.now();
      searchAbortRef.current?.abort();

      if (liveValue !== searchQuery) {
        setSearchQuery(liveValue);
      }
      // スマホの仮想キーボードを閉じて検索結果リストの表示領域を確保＆IME未確定文字を確定
      searchInputRef.current?.blur();

      if (!trimmed) {
        commitSearchUiUpdate(() => {
          setSubmittedQuery('');
          setOsmResults([]);
          setIsSearchingOsm(false);
          setSearchError(null);
        });
        return;
      }

      const controller = new AbortController();
      searchAbortRef.current = controller;

      commitSearchUiUpdate(() => {
        setSubmittedQuery(trimmed);
        setOsmResults([]);
        setSearchError(null);
        setIsSearchingOsm(true);
      });

      searchOsmLocationsByKeyword(
        trimmed,
        controller.signal,
        (partialItems) => {
          if (!controller.signal.aborted && partialItems.length > 0) {
            commitSearchUiUpdate(() => {
              setOsmResults(partialItems);
              setIsSearchingOsm(false);
            });
          }
        },
        effectiveRefLocation
      )
        .then((items) => {
          if (!controller.signal.aborted) {
            commitSearchUiUpdate(() => {
              setOsmResults(items);
              setIsSearchingOsm(false);
            });
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            commitSearchUiUpdate(() => {
              setIsSearchingOsm(false);
              setSearchError(
                '検索中に通信エラーが発生しました。もう一度「検索」を押してください。'
              );
            });
          }
        });
    },
    [searchQuery, commitSearchUiUpdate, effectiveRefLocation]
  );

  const handleClearSearch = useCallback(() => {
    searchAbortRef.current?.abort();
    commitSearchUiUpdate(() => {
      setSearchQuery('');
      setSubmittedQuery('');
      setOsmResults([]);
      setIsSearchingOsm(false);
      setSearchError(null);
    });
  }, [commitSearchUiUpdate]);

  const handleSearchFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    executeSearch(searchInputRef.current?.value ?? searchQuery);
  };

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
        <span className="md:hidden shrink-0">地名検索</span>
        <ChevronUp
          className={`w-3.5 h-3.5 sm:w-4 sm:h-4 text-slate-400 transition-transform duration-200 shrink-0 ${
            isOpen ? 'rotate-0' : 'rotate-180'
          }`}
        />
      </button>

      {/* 展開パネル本体 */}
      {isOpen && (
        <div
          ref={panelRef}
          id="preset-nav-panel"
          className="safe-top-dropdown fixed z-30 rounded-2xl bg-slate-900/[0.98] border border-slate-700/80 shadow-2xl p-3.5 text-slate-100 w-[calc(100vw-1.5rem)] sm:w-[26rem] max-w-md space-y-3 overflow-y-auto min-h-[22rem]"
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
            <div className="space-y-2.5 min-h-[17.5rem] flex flex-col">
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

              <div className="space-y-1.5 flex-1 flex flex-col min-h-0">
                <div className="flex items-center justify-between text-xs text-slate-300 font-semibold px-0.5">
                  <span>山岳を選択 ({filteredMountains.length}座)</span>
                </div>

                <div
                  id="preset-mountain-list"
                  role="group"
                  aria-label="百名山リスト"
                  className="grid grid-cols-2 gap-2 max-h-56 overflow-y-auto pr-1 flex-1"
                >
                  {filteredMountains.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => {
                        setInternalIsOpen(false);
                        onSelectPreset(preset);
                      }}
                      className="relative flex flex-col items-start justify-center px-3 py-2 rounded-xl text-left transition-colors cursor-pointer select-none min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 text-slate-100 hover:text-white bg-slate-800/50 hover:bg-slate-800 border border-slate-700/80 hover:border-sky-400/60"
                    >
                      <div className="flex items-center gap-1.5 w-full min-w-0">
                        <span className="text-sm leading-none shrink-0">{preset.emoji}</span>
                        <span className="text-sm sm:text-xs font-semibold truncate">
                          {preset.name}
                        </span>
                      </div>
                      <div className="text-xs sm:text-[10px] font-mono truncate w-full mt-0.5 text-slate-400">
                        {preset.elevation.toLocaleString()}m · {preset.region}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* === タブ2: ⭐ お気に入り（検索枠なし・シンプル一覧） === */}
          {activeTab === 'favorites' && (
            <div className="space-y-2 min-h-[17.5rem] flex flex-col">
              <div className="flex flex-wrap items-center justify-between gap-1.5 text-xs text-slate-300 font-semibold px-0.5">
                <div className="flex items-center gap-2 min-w-0">
                  <button
                    type="button"
                    onClick={() => setSelectedFavCategory('ALL')}
                    title="すべてのお気に入りを表示"
                    className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer border ${
                      selectedFavCategory === 'ALL'
                        ? 'bg-sky-500/20 text-sky-200 border-sky-400/40'
                        : 'text-slate-300 hover:text-white hover:bg-slate-800/60 border-transparent'
                    }`}
                  >
                    <span className="truncate">お気に入り ({favorites.length}件)</span>
                    {selectedFavCategory !== 'ALL' && (
                      <span className="text-[10px] px-1.5 py-0.2 rounded bg-sky-500/20 text-sky-300 border border-sky-400/30 font-normal">
                        すべて表示
                      </span>
                    )}
                  </button>
                  {favorites.length > 1 && (
                    <div
                      role="radiogroup"
                      aria-label="並び順"
                      className="inline-flex items-center p-0.5 rounded-lg bg-slate-900/80 border border-slate-700/80 text-[11px]"
                    >
                      <button
                        type="button"
                        role="radio"
                        aria-checked={favoritesSortOrder === 'distance'}
                        onClick={() => handleToggleFavoritesSortOrder('distance')}
                        className={`px-2 py-0.5 rounded-md font-medium transition-colors cursor-pointer ${
                          favoritesSortOrder === 'distance'
                            ? 'bg-sky-500 text-white font-bold shadow-sm'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        近い順
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={favoritesSortOrder === 'created'}
                        onClick={() => handleToggleFavoritesSortOrder('created')}
                        className={`px-2 py-0.5 rounded-md font-medium transition-colors cursor-pointer ${
                          favoritesSortOrder === 'created'
                            ? 'bg-sky-500 text-white font-bold shadow-sm'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        登録順
                      </button>
                    </div>
                  )}
                </div>

                {onOpenFavoritesSync && (
                  <button
                    type="button"
                    id="favorites-sync-open-btn"
                    onClick={onOpenFavoritesSync}
                    title="お気に入りの保存・復元"
                    className="relative inline-flex items-center gap-1 shrink-0 min-h-[30px] px-2 py-1 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-400/40 text-amber-200 text-[11px] font-bold transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                  >
                    <ArrowRightLeft className="w-3.5 h-3.5" />
                    保存・復元
                    {backupRecommended && (
                      <span
                        className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-rose-500 ring-2 ring-slate-900"
                        aria-label="保存をおすすめします"
                      />
                    )}
                  </button>
                )}
              </div>

              {/* カテゴリ絞り込みボタン（4カテゴリ・上段アイコン／下段テキストの2段配置） */}
              <div
                role="tablist"
                aria-label="カテゴリで絞り込み"
                className="grid grid-cols-4 gap-1.5"
              >
                {FAVORITE_CATEGORY_LIST.map((cat) => {
                  const isSelected = selectedFavCategory === cat.id;
                  const Icon = cat.icon;
                  const count = favCategoryCounts[cat.id] ?? 0;
                  return (
                    <button
                      key={cat.id}
                      type="button"
                      role="tab"
                      aria-selected={isSelected}
                      onClick={() =>
                        setSelectedFavCategory((prev) => (prev === cat.id ? 'ALL' : cat.id))
                      }
                      className={`flex flex-col items-center justify-center gap-1 py-1.5 px-1 rounded-xl min-h-[46px] font-bold transition-all cursor-pointer ${
                        isSelected
                          ? `${cat.activeBgClass} border-2 shadow-sm`
                          : 'bg-slate-900/80 hover:bg-slate-800/80 text-slate-300 hover:text-white border border-slate-700/70'
                      }`}
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      <span className="text-[11px] leading-tight truncate">
                        {cat.label} ({count})
                      </span>
                    </button>
                  );
                })}
              </div>

              <div
                id="preset-favorite-list"
                role="group"
                aria-label="お気に入り地点リスト"
                className="grid grid-cols-1 gap-2 max-h-64 overflow-y-auto pr-1 flex-1"
              >
                {filteredFavorites.map(({ preset, distanceMeters }) => {
                  const isPinned = Boolean(preset.isPinned);
                  const distLabel = distanceMeters !== undefined ? formatDistanceLabel(distanceMeters) : '';
                  const catMeta = getFavoriteCategoryMeta(preset.category);
                  const CatIcon = catMeta.icon;
                  return (
                    <div
                      key={preset.id}
                      className={`relative flex items-center justify-between gap-1 rounded-xl transition-colors text-slate-100 hover:text-white hover:bg-slate-800 hover:border-sky-400/60 ${
                        isPinned
                          ? 'bg-slate-800/70 border border-amber-500/40'
                          : 'bg-slate-800/50 border border-slate-700/80'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setInternalIsOpen(false);
                          onSelectPreset(preset);
                        }}
                        className="flex-1 flex items-center gap-2.5 px-3 py-2 text-left cursor-pointer select-none min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 rounded-xl"
                      >
                        {/* カテゴリ専用アイコンバッジ */}
                        <div
                          className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${catMeta.colorClass} shadow-sm border border-white/20`}
                          title={`カテゴリ: ${catMeta.label}`}
                          aria-label={`カテゴリ: ${catMeta.label}`}
                        >
                          <CatIcon className="w-3.5 h-3.5 text-white" />
                        </div>

                        <div className="flex-1 flex flex-col items-start justify-center min-w-0">
                          <div className="flex items-center gap-1.5 w-full min-w-0">
                            {isPinned && (
                              <Pin className="w-3.5 h-3.5 text-amber-400 fill-amber-400 shrink-0" aria-label="ピン留め" />
                            )}
                            <span className="text-sm sm:text-xs font-semibold truncate">
                              {preset.name}
                            </span>
                          </div>
                          <div className="text-xs sm:text-[10px] font-mono truncate w-full mt-0.5 text-slate-400">
                            {favoritesSortOrder === 'distance' && distLabel ? `📍 ${distLabel} · ` : ''}
                            ズーム{preset.zoom.toFixed(1)} · 傾き{Math.round(preset.pitch)}°
                          </div>
                        </div>
                      </button>

                      <div className="flex items-center gap-0.5 pr-1 shrink-0">
                        {onTogglePinFavorite && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onTogglePinFavorite(preset.id);
                            }}
                            title={isPinned ? `「${preset.name}」のピン留めを解除` : `「${preset.name}」を上部にピン留め`}
                            aria-label={isPinned ? `「${preset.name}」のピン留めを解除` : `「${preset.name}」を上部にピン留め`}
                            className={`p-1.5 rounded-lg transition-colors cursor-pointer shrink-0 ${
                              isPinned
                                ? 'text-amber-400 hover:text-amber-300 hover:bg-amber-500/20'
                                : 'text-slate-400 hover:text-amber-300 hover:bg-slate-700/60'
                            }`}
                          >
                            <Pin className={`w-3.5 h-3.5 ${isPinned ? 'fill-amber-400' : ''}`} />
                          </button>
                        )}
                        {onShareFavorite && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onShareFavorite(preset);
                              setCopiedFavoriteId(preset.id);
                              window.setTimeout(() => {
                                setCopiedFavoriteId((prev) =>
                                  prev === preset.id ? null : prev
                                );
                              }, 2000);
                            }}
                            title={`「${preset.name}」の視点URLを共有`}
                            aria-label={`「${preset.name}」の視点URLを共有`}
                            className={`p-1.5 rounded-lg transition-colors cursor-pointer shrink-0 ${
                              copiedFavoriteId === preset.id
                                ? 'text-emerald-300 bg-emerald-500/25'
                                : 'text-slate-300 hover:text-sky-300 hover:bg-sky-500/20'
                            }`}
                          >
                            {copiedFavoriteId === preset.id ? (
                              <Check className="w-3.5 h-3.5" />
                            ) : (
                              <Share2 className="w-3.5 h-3.5" />
                            )}
                          </button>
                        )}
                        {onRemoveFavorite && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onRemoveFavorite(preset.id);
                            }}
                            title={`「${preset.name}」を削除`}
                            aria-label={`「${preset.name}」を削除`}
                            className="p-1.5 rounded-lg text-slate-300 hover:text-rose-300 hover:bg-rose-500/20 transition-colors cursor-pointer shrink-0"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}

                {favorites.length === 0 && (
                  <div className="col-span-full py-6 px-3 text-center text-xs text-slate-400 bg-slate-950/60 rounded-xl border border-slate-800/80">
                    地図上の地点をタップして「⭐ お気に入りに追加」から登録できます。
                    {onOpenFavoritesSync && (
                      <span className="block mt-1">
                        別の端末のお気に入りやバックアップは「バックアップ・引き継ぎ」から取り込めます。
                      </span>
                    )}
                  </div>
                )}

                {favorites.length > 0 && filteredFavorites.length === 0 && (
                  <div className="col-span-full py-6 px-3 text-center text-xs text-slate-400 bg-slate-950/60 rounded-xl border border-slate-800/80">
                    「{getFavoriteCategoryMeta(selectedFavCategory).label}」カテゴリのお気に入りは登録されていません。
                  </div>
                )}
              </div>
            </div>
          )}

          {/* === タブ3: 🔍 地名・施設検索（文字入力 ➔ 検索ボタン押下で検索） === */}
          {activeTab === 'search' && (
            <div className="space-y-2.5 min-h-[17.5rem] flex flex-col">
              <form onSubmit={handleSearchFormSubmit} className="flex items-center gap-1.5">
                <div className="relative flex items-center flex-1 min-w-0">
                  <Search className="w-4 h-4 text-emerald-400 absolute left-3 pointer-events-none" />
                  <input
                    ref={searchInputRef}
                    id="preset-search-input"
                    type="text"
                    enterKeyHint="search"
                    value={searchQuery}
                    onChange={(e) => {
                      const val = e.target.value;
                      setSearchQuery(val);
                      if (val.trim().length === 0) {
                        handleClearSearch();
                      }
                    }}
                    placeholder="地名・施設・山小屋・駅名などを入力"
                    aria-label="地名・施設・山名を検索"
                    className="w-full rounded-xl bg-slate-950/90 border border-slate-700 focus:border-emerald-400 pl-9 pr-8 py-2 text-base sm:text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                  />
                  {searchQuery.length > 0 && (
                    <button
                      type="button"
                      aria-label="検索キーワードをクリア"
                      onClick={handleClearSearch}
                      className="absolute right-2 p-1 rounded-md text-slate-400 hover:text-white cursor-pointer"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>

                <button
                  type="submit"
                  id="preset-search-submit-btn"
                  disabled={!searchQuery.trim()}
                  onPointerDown={() => {
                    // 日本語IME変換中（未確定状態）のまま「検索」ボタンをタップした場合、
                    // ブラウザがIME確定(blur)でclick/submitイベントを消費してしまうケースを救済
                    window.setTimeout(() => {
                      if (Date.now() - lastExecutedAtRef.current < 100) return;
                      const currentVal = (searchInputRef.current?.value ?? searchQuery).trim();
                      if (currentVal.length > 0) {
                        executeSearch(currentVal);
                      }
                    }, 35);
                  }}
                  className="inline-flex items-center justify-center gap-1 min-h-[38px] px-3.5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 font-bold text-xs sm:text-xs transition-colors cursor-pointer disabled:cursor-not-allowed shrink-0"
                >
                  {isSearchingOsm ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Search className="w-3.5 h-3.5" />
                  )}
                  <span>検索</span>
                </button>
              </form>

              <div
                key={`search-results-${submittedQuery}-${isSearchingOsm ? 'loading' : 'done'}-${osmResults.length}-${searchRenderVersion}`}
                className="max-h-64 overflow-y-auto space-y-2.5 pr-1 flex-1"
              >
                {!submittedQuery && !isSearchingOsm && (
                  <div className="py-6 px-3 text-center text-xs text-slate-400 bg-slate-950/60 rounded-xl border border-slate-800/80">
                    キーワードを入力して「検索」ボタンを押すと、全国の地名・施設（OpenStreetMap）や百名山から候補を表示します。
                  </div>
                )}

                {/* 1. ローカル一致（お気に入り・日本百名山） */}
                {localMatchedPresets.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-xs font-semibold text-sky-300 px-0.5 truncate">
                      百名山・お気に入り ({localMatchedPresets.length}件 · 近い順)
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                      {localMatchedPresets.map(({ preset, distanceMeters }) => (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => {
                            setInternalIsOpen(false);
                            onSelectPreset(preset);
                          }}
                          className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-slate-800/60 hover:bg-slate-800 border border-slate-700/80 hover:border-sky-400/60 text-left transition-colors cursor-pointer min-w-0 overflow-hidden"
                        >
                          <div className="min-w-0 flex-1 overflow-hidden">
                            <div className="flex items-center justify-between gap-1.5 min-w-0">
                              <div className="flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden">
                                <span className="text-sm leading-none shrink-0">
                                  {preset.emoji}
                                </span>
                                <span className="text-xs font-bold text-white truncate min-w-0">
                                  {preset.name}
                                </span>
                              </div>
                              <span className="text-[10px] font-mono text-sky-300/90 whitespace-nowrap shrink-0">
                                {formatDistanceLabel(distanceMeters)}
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
                {(submittedQuery.length > 0 || isSearchingOsm) && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2 text-xs font-semibold text-emerald-300 px-0.5 min-w-0">
                      <span className="truncate min-w-0">
                        「{submittedQuery}」の検索結果（一致・近い順）
                      </span>
                      {isSearchingOsm && (
                        <span className="text-[11px] text-slate-400 font-normal shrink-0">
                          検索中...
                        </span>
                      )}
                    </div>

                    {searchError ? (
                      <div className="py-4 px-3 text-center text-xs text-rose-300 bg-rose-950/40 rounded-xl border border-rose-800/60">
                        {searchError}
                      </div>
                    ) : osmResults.length > 0 ? (
                      <div className="grid grid-cols-1 gap-1.5">
                        {osmResults.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => handleSelectOsmLocation(item)}
                            className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-slate-950/80 hover:bg-slate-800 border border-slate-800 hover:border-emerald-500/40 text-left transition-colors cursor-pointer min-w-0 overflow-hidden"
                          >
                            <div className="min-w-0 flex-1 overflow-hidden">
                              <div className="flex items-center justify-between gap-1.5 min-w-0">
                                <div className="flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden">
                                  <span className="text-sm leading-none shrink-0">
                                    {item.emoji}
                                  </span>
                                  <span className="text-xs font-bold text-white truncate min-w-0">
                                    {item.name}
                                  </span>
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                  <span className="px-1.5 py-0.5 rounded bg-slate-800 text-[10px] text-emerald-300 whitespace-nowrap shrink-0">
                                    {item.category}
                                  </span>
                                  {item.distanceMeters !== undefined && (
                                    <span className="text-[10px] font-mono text-slate-300 whitespace-nowrap shrink-0">
                                      {formatDistanceLabel(item.distanceMeters)}
                                    </span>
                                  )}
                                </div>
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

