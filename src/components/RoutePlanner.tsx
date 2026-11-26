import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpDown,
  Bike,
  Car,
  ChevronUp,
  Clock,
  CloudRain,
  Footprints,
  Loader2,
  LocateFixed,
  MapPin,
  Mountain,
  MousePointerClick,
  Route,
  Search,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import type { PresetLocation } from '../types/map';
import type { RouteErrorCode, RouteProfile } from '../lib/orsClient';
import type {
  RouteCheckpoint,
  RouteWeatherAnalysis,
} from '../lib/routeWeatherAnalyzer';
import { runViewTransition } from '../lib/viewTransition';

export interface RouteEndpoint {
  lng: number;
  lat: number;
  label: string;
  source: 'geolocation' | 'favorite' | 'hyakumeizan' | 'map';
}

interface RoutePlannerProps {
  presets: PresetLocation[];
  favorites: PresetLocation[];
  origin: RouteEndpoint | null;
  destination: RouteEndpoint | null;
  onChangeOrigin: (endpoint: RouteEndpoint | null) => void;
  onChangeDestination: (endpoint: RouteEndpoint | null) => void;
  onSwapEndpoints: () => void;
  profile: RouteProfile;
  onChangeProfile: (profile: RouteProfile) => void;
  departureOffsetMinutes: number;
  onChangeDepartureOffsetMinutes: (minutes: number) => void;
  onStartMapPick: (target: 'origin' | 'destination') => void;
  onRunRouteCheck: () => void;
  onClearRoute: () => void;
  analysis: RouteWeatherAnalysis | null;
  isLoading: boolean;
  error: string | null;
  errorCode?: RouteErrorCode | null;
  onSwitchToHikingAndRetry?: () => void;
  onFocusCheckpoint?: (checkpoint: RouteCheckpoint) => void;
  isOpen?: boolean;
  onToggleOpen?: () => void;
}

const PROFILE_OPTIONS: Array<{
  id: RouteProfile;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'driving-car', label: '車', icon: Car },
  { id: 'foot-hiking', label: '登山・徒歩', icon: Footprints },
  { id: 'cycling-regular', label: '自転車', icon: Bike },
];

const DEPARTURE_OFFSET_OPTIONS: Array<{ minutes: number; label: string }> = [
  { minutes: 0, label: '今すぐ' },
  { minutes: 30, label: '+30分' },
  { minutes: 60, label: '+1h' },
  { minutes: 120, label: '+2h' },
  { minutes: 180, label: '+3h' },
  { minutes: 360, label: '+6h' },
];

const ROUTE_COLOR_LEGEND = [
  { label: '無降雨', color: '#38bdf8', dashed: false },
  { label: '弱雨 (<5)', color: '#22c55e', dashed: false },
  { label: 'やや強 (5-15)', color: '#facc15', dashed: false },
  { label: '強雨 (15+)', color: '#f97316', dashed: false },
  { label: '猛烈 (30+)', color: '#ef4444', dashed: false },
  { label: '範囲外', color: '#94a3b8', dashed: true },
];

export function formatRouteDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return '-';
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km).toLocaleString()} km`;
}

export function formatRouteDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '-';
  const totalMin = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours === 0) return `${mins}分`;
  return `${hours}時間${String(mins).padStart(2, '0')}分`;
}

export const RoutePlanner: React.FC<RoutePlannerProps> = ({
  presets,
  favorites,
  origin,
  destination,
  onChangeOrigin,
  onChangeDestination,
  onSwapEndpoints,
  profile,
  onChangeProfile,
  departureOffsetMinutes,
  onChangeDepartureOffsetMinutes,
  onStartMapPick,
  onRunRouteCheck,
  onClearRoute,
  analysis,
  isLoading,
  error,
  errorCode = null,
  onSwitchToHikingAndRetry,
  onFocusCheckpoint,
  isOpen: controlledIsOpen,
  onToggleOpen,
}) => {
  const [internalIsOpen, setInternalIsOpen] = useState(false);
  const isOpen = controlledIsOpen ?? internalIsOpen;

  const [activePicker, setActivePicker] = useState<{
    target: 'origin' | 'destination';
    kind: 'favorite' | 'hyakumeizan';
  } | null>(null);
  const [mountainFilter, setMountainFilter] = useState('');
  const [locatingTarget, setLocatingTarget] = useState<'origin' | 'destination' | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);

  const handleToggleOpen = () => {
    setActivePicker(null);
    setGeoError(null);
    if (onToggleOpen) {
      onToggleOpen();
      return;
    }
    runViewTransition(() => {
      setInternalIsOpen(prev => !prev);
    });
  };

  const filteredPresets = useMemo(() => {
    const q = mountainFilter.trim().toLowerCase();
    if (!q) return presets.slice(0, 30);
    return presets
      .filter(
        p =>
          p.name.toLowerCase().includes(q) ||
          (p.kana && p.kana.toLowerCase().includes(q)) ||
          p.region.toLowerCase().includes(q)
      )
      .slice(0, 30);
  }, [presets, mountainFilter]);

  const handleUseCurrentLocation = (target: 'origin' | 'destination') => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGeoError('この端末・ブラウザでは現在地を取得できません。');
      return;
    }
    setGeoError(null);
    setLocatingTarget(target);
    navigator.geolocation.getCurrentPosition(
      pos => {
        setLocatingTarget(null);
        const endpoint: RouteEndpoint = {
          lng: pos.coords.longitude,
          lat: pos.coords.latitude,
          label: '📍 現在地',
          source: 'geolocation',
        };
        if (target === 'origin') onChangeOrigin(endpoint);
        else onChangeDestination(endpoint);
      },
      () => {
        setLocatingTarget(null);
        setGeoError('現在地の取得に失敗しました。位置情報の許可を確認してください。');
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
    );
  };

  const handleSelectPresetEndpoint = (
    target: 'origin' | 'destination',
    loc: PresetLocation,
    source: 'favorite' | 'hyakumeizan'
  ) => {
    const endpoint: RouteEndpoint = {
      lng: loc.center[0],
      lat: loc.center[1],
      label: source === 'favorite' ? `⭐ ${loc.name}` : `${loc.emoji} ${loc.name}`,
      source,
    };
    if (target === 'origin') onChangeOrigin(endpoint);
    else onChangeDestination(endpoint);
    setActivePicker(null);
    setMountainFilter('');
  };

  const endpointRows: Array<{
    target: 'origin' | 'destination';
    title: string;
    badge: string;
    badgeClass: string;
    value: RouteEndpoint | null;
    onChange: (ep: RouteEndpoint | null) => void;
  }> = [
    {
      target: 'origin',
      title: '出発地',
      badge: 'S',
      badgeClass: 'bg-emerald-500 text-slate-950',
      value: origin,
      onChange: onChangeOrigin,
    },
    {
      target: 'destination',
      title: '目的地',
      badge: 'G',
      badgeClass: 'bg-rose-500 text-white',
      value: destination,
      onChange: onChangeDestination,
    },
  ];

  const hasActiveRoute = analysis !== null;

  return (
    <aside
      aria-label="ルート上の雨雲チェック"
      className="pointer-events-auto relative flex items-center shrink-0"
    >
      <button
        type="button"
        id="route-planner-toggle-btn"
        onClick={handleToggleOpen}
        aria-expanded={isOpen}
        aria-controls="route-planner-panel"
        aria-label="ルート雨雲チェック"
        title="ルート上の雨雲チェック"
        className={`relative inline-flex items-center justify-center gap-1 sm:gap-1.5 w-[38px] h-[38px] sm:w-auto sm:min-h-[42px] sm:px-3.5 py-1.5 rounded-xl backdrop-blur-md border shadow-lg text-xs sm:text-sm font-bold transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 shrink-0 ${
          hasActiveRoute || isOpen
            ? 'bg-emerald-500/20 hover:bg-emerald-500/30 border-emerald-400/60 text-emerald-100'
            : 'bg-slate-900/65 hover:bg-slate-800/80 border-slate-700/60 text-slate-100'
        }`}
      >
        <Route className="w-4 h-4 text-emerald-400 shrink-0" />
        <span className="hidden sm:inline">ルート</span>
        <ChevronUp
          className={`hidden sm:block w-4 h-4 text-slate-400 transition-transform duration-200 shrink-0 ${
            isOpen ? 'rotate-0' : 'rotate-180'
          }`}
        />
        {hasActiveRoute && (
          <span
            aria-hidden="true"
            className="sm:hidden absolute top-1 right-1 w-2 h-2 rounded-full bg-emerald-400 ring-2 ring-slate-900"
          />
        )}
      </button>

      {isOpen && (
        <div
          id="route-planner-panel"
          className="safe-top-dropdown fixed z-30 w-[min(calc(100vw-1.5rem),22rem)] rounded-2xl bg-slate-900/95 backdrop-blur-md border border-slate-700/80 shadow-2xl p-3.5 text-xs text-slate-100 space-y-3 overflow-y-auto"
        >
          {/* ヘッダー */}
          <div className="flex items-center justify-between pb-2 border-b border-slate-800">
            <div className="flex items-center gap-1.5 font-bold text-slate-100 text-xs sm:text-sm">
              <Route className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>ルート雨雲チェック</span>
            </div>
            <button
              type="button"
              onClick={handleToggleOpen}
              aria-label="ルートパネルを閉じる"
              className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* 出発地・目的地入力 */}
          <div className="space-y-2 relative">
            {endpointRows.map((row, idx) => {
              const isPickerFav =
                activePicker?.target === row.target && activePicker.kind === 'favorite';
              const isPickerMtn =
                activePicker?.target === row.target && activePicker.kind === 'hyakumeizan';
              const isLocatingThis = locatingTarget === row.target;

              return (
                <div
                  key={row.target}
                  className="rounded-xl bg-slate-950/75 border border-slate-800 p-2.5 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold shrink-0 ${row.badgeClass}`}
                      >
                        {row.badge}
                      </span>
                      <div className="min-w-0">
                        <div className="text-[10px] text-slate-400">{row.title}</div>
                        <div className="font-semibold text-slate-100 truncate">
                          {row.value ? row.value.label : '未選択（下から選択）'}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      {idx === 0 && (
                        <button
                          type="button"
                          onClick={onSwapEndpoints}
                          disabled={!origin && !destination}
                          title="出発地と目的地を入れ替え"
                          aria-label="出発地と目的地を入れ替え"
                          className="p-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 disabled:opacity-40 text-slate-300 cursor-pointer disabled:cursor-not-allowed"
                        >
                          <ArrowUpDown className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {row.value && (
                        <button
                          type="button"
                          onClick={() => row.onChange(null)}
                          aria-label={`${row.title}をクリア`}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* 選択ソースボタン群（縦2段レイアウト＋whitespace-nowrapで折り返し防止） */}
                  <div className="grid grid-cols-4 gap-1">
                    <button
                      type="button"
                      onClick={() => handleUseCurrentLocation(row.target)}
                      disabled={isLocatingThis}
                      className="flex flex-col items-center justify-center gap-0.5 min-h-[42px] px-1 py-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-[10px] font-medium leading-tight whitespace-nowrap text-slate-200 cursor-pointer"
                    >
                      {isLocatingThis ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400 shrink-0" />
                      ) : (
                        <LocateFixed className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                      )}
                      <span>現在地</span>
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        setActivePicker(prev =>
                          prev?.target === row.target && prev.kind === 'favorite'
                            ? null
                            : { target: row.target, kind: 'favorite' }
                        )
                      }
                      className={`flex flex-col items-center justify-center gap-0.5 min-h-[42px] px-1 py-1.5 rounded-lg text-[10px] font-medium leading-tight whitespace-nowrap cursor-pointer ${
                        isPickerFav
                          ? 'bg-amber-500/25 text-amber-200 border border-amber-400/50'
                          : 'bg-slate-800/80 hover:bg-slate-700 text-slate-200'
                      }`}
                    >
                      <Star className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                      <span>お気に入り</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setMountainFilter('');
                        setActivePicker(prev =>
                          prev?.target === row.target && prev.kind === 'hyakumeizan'
                            ? null
                            : { target: row.target, kind: 'hyakumeizan' }
                        );
                      }}
                      className={`flex flex-col items-center justify-center gap-0.5 min-h-[42px] px-1 py-1.5 rounded-lg text-[10px] font-medium leading-tight whitespace-nowrap cursor-pointer ${
                        isPickerMtn
                          ? 'bg-emerald-500/25 text-emerald-200 border border-emerald-400/50'
                          : 'bg-slate-800/80 hover:bg-slate-700 text-slate-200'
                      }`}
                    >
                      <Mountain className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      <span>百名山</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setActivePicker(null);
                        onStartMapPick(row.target);
                      }}
                      className="flex flex-col items-center justify-center gap-0.5 min-h-[42px] px-1 py-1.5 rounded-lg bg-slate-800/80 hover:bg-sky-500/25 hover:text-sky-200 text-[10px] font-medium leading-tight whitespace-nowrap text-slate-200 cursor-pointer"
                    >
                      <MousePointerClick className="w-3.5 h-3.5 text-sky-300 shrink-0" />
                      <span>地図</span>
                    </button>
                  </div>

                  {/* お気に入りリスト展開 */}
                  {isPickerFav && (
                    <div className="rounded-lg bg-slate-900 border border-slate-700/80 p-2 max-h-36 overflow-y-auto space-y-1">
                      {favorites.length === 0 ? (
                        <div className="text-[11px] text-slate-400 py-1 text-center">
                          登録済みのお気に入り地点がありません。
                        </div>
                      ) : (
                        favorites.map(fav => (
                          <button
                            key={fav.id}
                            type="button"
                            onClick={() =>
                              handleSelectPresetEndpoint(row.target, fav, 'favorite')
                            }
                            className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md hover:bg-slate-800 text-left text-[11px] text-slate-100 cursor-pointer"
                          >
                            <span className="truncate">
                              ⭐ {fav.name}
                            </span>
                            <span className="text-[10px] text-slate-400 shrink-0">
                              {fav.region}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  )}

                  {/* 百名山リスト展開 */}
                  {isPickerMtn && (
                    <div className="rounded-lg bg-slate-900 border border-slate-700/80 p-2 space-y-1.5">
                      <div className="relative">
                        <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                        <input
                          type="text"
                          value={mountainFilter}
                          onChange={e => setMountainFilter(e.target.value)}
                          placeholder="山名・よみ・地域で絞り込み..."
                          className="w-full pl-7 pr-2 py-1 rounded-md bg-slate-950 border border-slate-700 text-[11px] text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-400"
                        />
                      </div>
                      <div className="max-h-36 overflow-y-auto space-y-1">
                        {filteredPresets.map(mtn => (
                          <button
                            key={mtn.id}
                            type="button"
                            onClick={() =>
                              handleSelectPresetEndpoint(row.target, mtn, 'hyakumeizan')
                            }
                            className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md hover:bg-slate-800 text-left text-[11px] text-slate-100 cursor-pointer"
                          >
                            <span className="truncate">
                              {mtn.emoji} {mtn.name}
                            </span>
                            <span className="text-[10px] text-slate-400 shrink-0">
                              {mtn.elevation}m
                            </span>
                          </button>
                        ))}
                        {filteredPresets.length === 0 && (
                          <div className="text-[11px] text-slate-400 py-1 text-center">
                            該当する百名山がありません。
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {geoError && (
            <div
              role="alert"
              className="rounded-xl bg-amber-500/15 border border-amber-400/40 px-2.5 py-2 text-[11px] text-amber-200 flex items-start gap-1.5"
            >
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
              <span>{geoError}</span>
            </div>
          )}

          {/* 移動手段 */}
          <div>
            <div className="text-[11px] font-medium text-slate-300 mb-1.5">移動手段</div>
            <div className="grid grid-cols-3 gap-1.5">
              {PROFILE_OPTIONS.map(opt => {
                const Icon = opt.icon;
                const active = profile === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => onChangeProfile(opt.id)}
                    aria-pressed={active}
                    className={`inline-flex items-center justify-center gap-1 min-h-[34px] px-2 py-1.5 rounded-xl border text-[11px] font-semibold transition-colors cursor-pointer ${
                      active
                        ? 'bg-sky-500/25 border-sky-400/60 text-sky-100'
                        : 'bg-slate-950/75 border-slate-800 text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">{opt.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 出発時刻オフセット */}
          <div>
            <div className="flex items-center gap-1 text-[11px] font-medium text-slate-300 mb-1.5">
              <Clock className="w-3.5 h-3.5 text-sky-400 shrink-0" />
              <span>出発時刻</span>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {DEPARTURE_OFFSET_OPTIONS.map(opt => {
                const active = departureOffsetMinutes === opt.minutes;
                return (
                  <button
                    key={opt.minutes}
                    type="button"
                    onClick={() => onChangeDepartureOffsetMinutes(opt.minutes)}
                    aria-pressed={active}
                    className={`min-h-[30px] px-2 py-1 rounded-lg border text-[11px] font-semibold transition-colors cursor-pointer ${
                      active
                        ? 'bg-emerald-500/25 border-emerald-400/60 text-emerald-100'
                        : 'bg-slate-950/75 border-slate-800 text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 実行・クリアボタン */}
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              id="route-check-submit-btn"
              onClick={onRunRouteCheck}
              disabled={!origin || !destination || isLoading}
              className="flex-1 inline-flex items-center justify-center gap-1.5 min-h-[38px] px-3 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-700 disabled:text-slate-400 text-slate-950 font-bold text-xs transition-colors cursor-pointer disabled:cursor-not-allowed"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>ルート＆雨雲取得中...</span>
                </>
              ) : (
                <>
                  <CloudRain className="w-4 h-4" />
                  <span>ルート上の雨雲をチェック</span>
                </>
              )}
            </button>

            {(analysis || origin || destination || error) && (
              <button
                type="button"
                id="route-check-clear-btn"
                onClick={onClearRoute}
                disabled={isLoading}
                title="ルートをクリア"
                aria-label="ルートをクリア"
                className="inline-flex items-center justify-center min-h-[38px] px-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 border border-slate-700 cursor-pointer"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* エラー表示 */}
          {error && (
            <div
              role="alert"
              className="rounded-xl bg-rose-500/15 border border-rose-400/40 px-3 py-2 text-[11px] text-rose-200 space-y-2"
            >
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
              {errorCode === 'POINT_NOT_FOUND' &&
                profile !== 'foot-hiking' &&
                (origin?.source === 'hyakumeizan' ||
                  destination?.source === 'hyakumeizan') &&
                onSwitchToHikingAndRetry && (
                  <button
                    type="button"
                    id="route-switch-hiking-retry-btn"
                    onClick={onSwitchToHikingAndRetry}
                    disabled={isLoading}
                    className="w-full inline-flex items-center justify-center gap-1.5 min-h-[32px] px-2.5 py-1 rounded-lg bg-emerald-500/25 hover:bg-emerald-500/35 border border-emerald-400/50 text-emerald-100 font-semibold text-[11px] cursor-pointer"
                  >
                    <Footprints className="w-3.5 h-3.5 text-emerald-300 shrink-0" />
                    <span>登山・徒歩に切り替えて再検索</span>
                  </button>
                )}
            </div>
          )}

          {/* 解析結果サマリー */}
          {analysis && (
            <div
              id="route-weather-summary"
              className="rounded-xl bg-slate-950/85 border border-slate-800 p-2.5 space-y-2.5"
            >
              <div className="grid grid-cols-3 gap-1.5 text-center">
                <div className="rounded-lg bg-slate-900/90 border border-slate-800 px-1.5 py-1.5">
                  <div className="text-[10px] text-slate-400">総距離</div>
                  <div className="font-mono font-bold text-slate-100 text-xs">
                    {formatRouteDistance(analysis.route.distanceMeters)}
                  </div>
                </div>
                <div className="rounded-lg bg-slate-900/90 border border-slate-800 px-1.5 py-1.5">
                  <div className="text-[10px] text-slate-400">所要時間</div>
                  <div className="font-mono font-bold text-slate-100 text-xs">
                    {formatRouteDuration(analysis.route.durationSeconds)}
                  </div>
                </div>
                <div className="rounded-lg bg-slate-900/90 border border-slate-800 px-1.5 py-1.5">
                  <div className="text-[10px] text-slate-400">最大予測雨量</div>
                  <div
                    className={`font-mono font-bold text-xs ${
                      analysis.maxPrecipitation !== null && analysis.maxPrecipitation >= 15
                        ? 'text-orange-300'
                        : analysis.maxPrecipitation !== null && analysis.maxPrecipitation > 0
                          ? 'text-emerald-300'
                          : 'text-sky-300'
                    }`}
                  >
                    {analysis.maxPrecipitation !== null
                      ? `${analysis.maxPrecipitation.toFixed(1)} mm/h`
                      : '範囲外'}
                  </div>
                </div>
              </div>

              {(analysis.outOfRangeCount > 0 ||
                analysis.missingCount > 0 ||
                analysis.catalogIsStale ||
                analysis.catalogIsPartial) && (
                <div className="text-[10px] text-amber-300/90 leading-relaxed bg-amber-500/10 border border-amber-400/25 rounded-lg px-2 py-1.5">
                  {analysis.outOfRangeCount > 0 && (
                    <div>
                      ※ 気象庁予報範囲（最大+15h）または観測域外の区間（
                      {analysis.outOfRangeCount}区間）はグレー破線で表示しています。
                    </div>
                  )}
                  {analysis.missingCount > 0 && (
                    <div>
                      ※ 一部区間の降水データ取得に失敗しました（{analysis.missingCount}区間）。
                    </div>
                  )}
                  {(analysis.catalogIsStale || analysis.catalogIsPartial) && (
                    <div>※ 保存済みまたは一部のみの気象庁カタログを使用しています。</div>
                  )}
                </div>
              )}

              {/* ルート色分け凡例 */}
              <div className="flex flex-wrap gap-x-2.5 gap-y-1 text-[10px] text-slate-300 pt-0.5">
                {ROUTE_COLOR_LEGEND.map(item => (
                  <span key={item.label} className="inline-flex items-center gap-1">
                    <span
                      className="w-3 h-1.5 rounded-full inline-block"
                      style={{
                        backgroundColor: item.dashed ? 'transparent' : item.color,
                        borderTop: item.dashed ? `2px dashed ${item.color}` : undefined,
                      }}
                    />
                    <span>{item.label}</span>
                  </span>
                ))}
              </div>

              {/* チェックポイント一覧 */}
              <div className="max-h-40 overflow-y-auto divide-y divide-slate-800/80 border-t border-slate-800 pt-1">
                {analysis.checkpoints.map(cp => (
                  <button
                    key={cp.index}
                    type="button"
                    onClick={() => onFocusCheckpoint?.(cp)}
                    className="w-full flex items-center justify-between gap-2 py-1.5 px-1 hover:bg-slate-800/70 rounded text-left text-[11px] cursor-pointer"
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0 border border-white/30"
                        style={{ backgroundColor: cp.color }}
                      />
                      <MapPin className="w-3 h-3 text-slate-400 shrink-0" />
                      <span className="font-mono text-slate-200">{cp.etaLabelJST}</span>
                      <span className="text-[10px] text-slate-400 truncate">
                        区間{cp.index + 1}
                      </span>
                    </div>
                    <span className="font-mono font-semibold text-slate-100 shrink-0">
                      {cp.status === 'ok' && cp.precipitation !== null
                        ? `${cp.precipitation.toFixed(1)} mm/h`
                        : cp.status === 'out-of-range'
                          ? '予測範囲外'
                          : '取得不可'}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </aside>
  );
};
