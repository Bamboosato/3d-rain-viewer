import { diagnostic } from './lib/diagnostics';
import { useUpdateBlocker } from './lib/updateGuard';
import { bounded } from './lib/asyncLifecycle';
import { weatherDeadline, WeatherRequestError, WEATHER_FRAME_MS } from './lib/weatherRequests';
import { FrameScheduler, touchFrame, trimFrames } from './lib/frameBudget';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as maplibregl from 'maplibre-gl';
import {
  CloudRain,
  Download,
  Info,
  LocateFixed,
  X,
  ExternalLink,
} from 'lucide-react';
import { MapViewer } from './components/MapViewer';
import { PresetNav } from './components/PresetNav';
import { LayerMenu } from './components/LayerMenu';
import { Legend } from './components/Legend';
import { Inspector } from './components/Inspector';
import { TimelineBar } from './components/TimelineBar';
import { ShareButton } from './components/ShareButton';
import { PRESET_LOCATIONS } from './lib/maplibreHelper';
import {
  fetchGSMaPRainLayer,
  fetchGSMaPTimelineCatalog,
  fetchPointElevationFromAW3D,
  formatDateToJST,
  type GSMaPRainLayerResult,
  inspectLocationValues,
  preloadCentralMountainElevation,
  setActiveRainLayerResult,
} from './lib/jaxaClient';
import {
  fetchPointTimeseries,
  type PointTimeseriesResult,
} from './lib/pointTimeseriesClient';
import {
  fetchJMANowcastCatalog,
  fetchJMANowcastRainLayer,
  getJMAFrameKey,
} from './lib/jmaNowcastClient';
import {
  isSameCoordinate,
  loadFavoriteLocations,
  loadFavoriteLocationsAsync,
  loadLastBackupAt,
  MAX_FAVORITES_COUNT,
  MAX_NAME_LENGTH,
  requestPersistentStorage,
  saveFavoriteLocations,
  saveFavoritesAndUndoAtomic,
  restoreFavoritesUndo,
  getFavoritesStorageWarning,
  readFavoritesRecoveryData,
  saveLastBackupAt,
  type StorageOperationResult,
} from './lib/favoritesStorage';
import {
  buildFavoriteLocation,
  previewImport,
  type ImportMode,
  clearPendingFavoritesPayload,
  decodeFavoritesPayload,
  extractFavoritesPayloadFromHash,
  FavoritesTransferError,
  takeFavoritesPayloadFromLocation,
} from './lib/favoritesTransfer';
import {
  FavoritesSyncDialog,
  type PendingFavoritesImport,
} from './components/FavoritesSyncDialog';
import {
  buildCustomDomainShareUrl,
  parseUrlViewState,
  replaceUrlViewState,
  resolveFrameIndexFromTimeParam,
  resolveInitialPresetFromUrl,
  shareOrCopyUrl,
  type UrlViewState,
} from './lib/urlSync';
import { runViewTransition } from './lib/viewTransition';
import type {
  BaseMapId,
  InspectorPoint,
  PresetLocation,
  RainSourceId,
  TimelineFrameItem,
  WebGPUStatus,
} from './types/map';

export const App: React.FC = () => {
  const initialFavoritesRef = useRef<PresetLocation[] | null>(null);
  if (initialFavoritesRef.current === null) {
    initialFavoritesRef.current = loadFavoriteLocations();
  }
  const initialUrlStateRef = useRef(parseUrlViewState());
  const initialPresetResolutionRef = useRef(
    resolveInitialPresetFromUrl(initialUrlStateRef.current, initialFavoritesRef.current)
  );
  const pendingUrlTimeParamRef = useRef<string | undefined>(initialUrlStateRef.current?.timeParam);
  const sharedSpotNameRef = useRef<string | undefined>(initialUrlStateRef.current?.spotName);

  const [favorites, setFavorites] = useState<PresetLocation[]>(
    () => initialFavoritesRef.current ?? []
  );
  const favoritesRef = useRef<PresetLocation[]>(favorites);

  const [favoritesBusy, setFavoritesBusy] = useState(0);
  useUpdateBlocker(favoritesBusy > 0);
  const [favoritesWarning, setFavoritesWarning] = useState<string | null>(null);
  const favoritesOpQueueRef = useRef<Promise<any>>(Promise.resolve());

  // IndexedDB からの非同期初期読み出し（localStorageが空または利用不可の場合の復元・ADD-02）
  useEffect(() => {
    let mounted = true;
    const restore = loadFavoriteLocationsAsync().then((items) => {
      if (mounted) {
        favoritesRef.current = items;
        setFavorites(items);
        setFavoritesWarning(getFavoritesStorageWarning());
        setLastBackupAt(loadLastBackupAt());
      }
    });
    favoritesOpQueueRef.current = restore;
    return () => {
      mounted = false;
    };
  }, []);

  const runSerializedFavoritesOp = useCallback(
    <T,>(
      op: (current: PresetLocation[]) => Promise<{ next?: PresetLocation[]; result: T; updateSelection?: () => void }>
    ): Promise<T> => {
      setFavoritesBusy(n => n + 1);
      const task = favoritesOpQueueRef.current.then(async () => {
        const current = favoritesRef.current;
        const { next, result, updateSelection } = await op(current);
        if (next !== undefined) {
          favoritesRef.current = next;
          setFavoritesWarning(getFavoritesStorageWarning());
          runViewTransition(() => {
            setFavorites(next);
            updateSelection?.();
          });
        }
        return result;
      });
      const finished = task.finally(() => setFavoritesBusy(n => n - 1));
      favoritesOpQueueRef.current = finished.catch(() => {});
      return finished;
    },
    []
  );

  const [activePreset, setActivePreset] = useState<PresetLocation>(
    () => initialPresetResolutionRef.current.preset
  );
  // 機能C-2: 標高強調デフォルト 1.5倍、雨雲透過度デフォルト 70% (0.7)
  const [exaggeration, setExaggeration] = useState<number>(
    () => initialUrlStateRef.current?.exaggeration ?? 1.5
  );
  const [rainOpacity, setRainOpacity] = useState<number>(0.7);
  const [baseMap, setBaseMap] = useState<BaseMapId>(
    () => initialUrlStateRef.current?.baseMap ?? 'osm'
  );
  const [rainSource, setRainSource] = useState<RainSourceId>(
    () => initialUrlStateRef.current?.rainSource ?? 'jma-nowcast'
  );

  const [timelineFrames, setTimelineFrames] = useState<TimelineFrameItem[]>([]);
  const timelineFramesRef = useRef<TimelineFrameItem[]>([]);
  const replaceTimelineFrames = useCallback((frames: TimelineFrameItem[]) => {
    timelineFramesRef.current = frames;
    setTimelineFrames(frames);
  }, []);
  const [currentTimeIndex, setCurrentTimeIndex] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const startedAtEndRef = useRef<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<1 | 2>(1);
  const [cachedCount, setCachedCount] = useState<number>(0);

  const [catalogRevision, setCatalogRevision] = useState(0);
  const selectedTimeRef = useRef<Date | null>(null);
  const refreshCatalog = useCallback(() => {
    jmaFramesCatalogRef.current = null; gsmapFramesCatalogRef.current = null;
    setCatalogRevision(n => n + 1);
  }, []);
  useEffect(() => {
    const visible = () => { if (document.visibilityState === 'visible') refreshCatalog(); };
    const timer = window.setInterval(visible, 5 * 60 * 1000);
    window.addEventListener('online', refreshCatalog);
    document.addEventListener('visibilitychange', visible);
    return () => { window.clearInterval(timer); window.removeEventListener('online', refreshCatalog); document.removeEventListener('visibilitychange', visible); };
  }, [refreshCatalog]);

  const [rainLayerData, setRainLayerData] = useState<GSMaPRainLayerResult | null>(null);
  const [isLoadingRain, setIsLoadingRain] = useState<boolean>(true);
  const [activePresetRain, setActivePresetRain] = useState<number | null>(null);

  // URLに `name` クエリが含まれている場合は起動時に地点インスペクターを自動表示し共有元の地点名を表示
  const [inspectedPoint, setInspectedPoint] = useState<InspectorPoint | null>(() => {
    const urlState = initialUrlStateRef.current;
    const preset = initialPresetResolutionRef.current.preset;
    if (
      urlState?.spotName &&
      typeof urlState.lng === 'number' &&
      typeof urlState.lat === 'number'
    ) {
      return {
        lng: urlState.lng,
        lat: urlState.lat,
        elevation: preset.elevation > 0 ? preset.elevation : null,
        precipitation: null,
        screenX: typeof window !== 'undefined' ? Math.round(window.innerWidth / 2) : undefined,
        screenY: typeof window !== 'undefined' ? Math.round(window.innerHeight / 2) : undefined,
        label: preset.isFavorite ? `⭐ ${urlState.spotName}` : `📍 ${urlState.spotName}`,
      };
    }
    return null;
  });
  const [shareToastVersion, setShareToastVersion] = useState<number>(0);
  const [showCreditModal, setShowCreditModal] = useState<boolean>(false);
  const [openTopPanel, setOpenTopPanel] = useState<'preset' | 'layer' | 'share' | null>(null);
  // お気に入りのバックアップ・引き継ぎダイアログ（null = 非表示）
  const [favoritesSyncDialog, setFavoritesSyncDialog] = useState<{
    pendingImport: PendingFavoritesImport | null;
    error: string | null;
  } | null>(null);
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(() => loadLastBackupAt());
  const [isLocating, setIsLocating] = useState<boolean>(false);
  const [installPromptEvent, setInstallPromptEvent] = useState<
    (Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }) | null
  >(null);

  // 最新カメラ状態（URLクエリ双方向同期用）
  const cameraViewRef = useRef({
    lat: initialPresetResolutionRef.current.preset.center[1],
    lng: initialPresetResolutionRef.current.preset.center[0],
    zoom: initialPresetResolutionRef.current.preset.zoom,
    pitch: initialPresetResolutionRef.current.preset.pitch,
    bearing: initialPresetResolutionRef.current.preset.bearing,
  });
  const urlSyncTimerRef = useRef<number | null>(null);

  // 地図中心座標（タイムライン引き出し式 降水量推移グラフ用）
  const [mapCenter, setMapCenter] = useState<{ lng: number; lat: number }>({
    lng: initialPresetResolutionRef.current.preset.center[0],
    lat: initialPresetResolutionRef.current.preset.center[1],
  });
  const [isDrawerOpen, setIsDrawerOpen] = useState<boolean>(false);
  const [timeseries, setTimeseries] = useState<PointTimeseriesResult | null>(null);
  const [isTimeseriesLoading, setIsTimeseriesLoading] = useState<boolean>(false);
  const centerDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timeseriesControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setInstallPromptEvent(
        e as Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }
      );
    };
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    return () => window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
  }, []);

  const handleInstallPwa = useCallback(async () => {
    if (!installPromptEvent) return;
    await installPromptEvent.prompt();
    await installPromptEvent.userChoice;
    setInstallPromptEvent(null);
  }, [installPromptEvent]);

  const [, setGpuStatus] = useState<WebGPUStatus>({
    backend: 'webgpu',
    webgpuAvailable: true,
    adapterInfo: 'WebGPU 初期化中...',
    fps: 60,
  });

  const mapInstanceRef = useRef<maplibregl.Map | null>(null);
  const jmaFramesCatalogRef = useRef<{ frames: TimelineFrameItem[]; defaultIndex: number } | null>(
    null
  );
  const gsmapFramesCatalogRef = useRef<{
    frames: TimelineFrameItem[];
    defaultIndex: number;
  } | null>(null);

  const jmaCacheRef = useRef<Map<string, GSMaPRainLayerResult>>(new Map());
  const gsmapCacheRef = useRef<Map<string, GSMaPRainLayerResult>>(new Map());
  const inFlightRequestsRef = useRef<Map<string, Promise<GSMaPRainLayerResult>>>(new Map());
  const activeRequestIdRef = useRef<number>(0);
  const schedulerRef = useRef(new FrameScheduler());
  const activeFrameRef = useRef<GSMaPRainLayerResult | null>(null);
  const restoreDisplayedTime = useCallback((source: RainSourceId, requestId: number) => {
    // An obsolete failure must never move the newest selection or stop playback.
    if (requestId !== activeRequestIdRef.current) return;
    setIsPlaying(false);
    setIsLoadingRain(false);
    const displayed = activeFrameRef.current;
    const frame = displayed?.timelineFrame;
    if (!frame || displayed.sourceType !== source) return;
    let frames = timelineFramesRef.current;
    let index = frames.findIndex(item => item.date.getTime() === frame.date.getTime());
    if (index < 0) {
      // Retain the actually displayed timestamp even after a catalog rollover.
      frames = [...frames, frame].sort((a, b) => a.date.getTime() - b.date.getTime());
      index = frames.indexOf(frame);
      replaceTimelineFrames(frames);
    }
    selectedTimeRef.current = frame.date;
    setCurrentTimeIndex(index);
  }, [replaceTimelineFrames]);
  const frameControllers = useRef(new Map<string, { controller: AbortController; foreground: boolean; schedulerSignal?: AbortSignal }>());
  useEffect(() => {
    const stop = () => {
      for (const entry of frameControllers.current.values()) entry.controller.abort();
      setIsPlaying(false); setIsLoadingRain(false);
    };
    const hide = () => { if (document.visibilityState === 'hidden') stop(); };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', stop); window.addEventListener('offline', stop);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('pagehide', stop); window.removeEventListener('offline', stop);
      for (const entry of frameControllers.current.values()) entry.controller.abort();
    };
  }, []);

  const getCacheForSource = useCallback((source: RainSourceId) => {
    return source === 'jma-nowcast' ? jmaCacheRef.current : gsmapCacheRef.current;
  }, []);

  const getFrameKey = useCallback((source: RainSourceId, frame: TimelineFrameItem): string => {
    if (source === 'jma-nowcast') {
      return getJMAFrameKey(frame);
    }
    return `gsmap:Gauge.v6_hourly:126,28,146,46:560x476:${frame.date.toISOString()}:v2`;
  }, []);

  // 指定ソース・指定インデックスの雨雲フレームを取得（重複リクエスト抑止＆LRUキャッシュ＆in-flight解放） (FIX-04, FIX-05, FIX-13)
  const loadFrameAtIndex = useCallback(
    async (
      source: RainSourceId,
      index: number,
      framesList: TimelineFrameItem[],
      isForeground: boolean
    ): Promise<GSMaPRainLayerResult | null> => {
      const started = performance.now();
      let targetFrame = framesList[index];
      if (!targetFrame) return null;

      const cacheKey = getFrameKey(source, targetFrame);
      const reqKey = `${source}:${cacheKey}`;
      // Generation guards protect state; cancellation also protects I/O and queues.
      if (isForeground) for (const [key, entry] of frameControllers.current) {
        if (key !== reqKey) entry.controller.abort();
      }
      const cacheMap = getCacheForSource(source);
      const existing = cacheMap.get(cacheKey);
      if (existing && existing.status !== 'partial') {
        // LRU 参照時更新 (FIX-13)
        cacheMap.delete(cacheKey);
        cacheMap.set(cacheKey, existing);
        diagnostic({ operation: 'frame', backend: 'memory', outcome: 'hit', generation: activeRequestIdRef.current });
        touchFrame(existing);
        return existing;
      }

      let pending = inFlightRequestsRef.current.get(reqKey);
      const running = frameControllers.current.get(reqKey);
      if (running?.controller.signal.aborted) pending = undefined;
      else if (running && isForeground) {
        running.foreground = true;
        schedulerRef.current.promote(running.schedulerSignal ?? running.controller.signal);
      }
      if (!pending) {
        const controller = new AbortController();
        if (document.visibilityState === 'hidden') return null;
        frameControllers.current.set(reqKey, { controller, foreground: isForeground });
        const frameTimeout = source === 'jma-nowcast' ? WEATHER_FRAME_MS : 25000;
        const fetchPromise = (async () => {
          try {
            const res = await weatherDeadline(frameTimeout, controller.signal, signal => {
              const entry = frameControllers.current.get(reqKey);
              if (entry?.controller === controller) entry.schedulerSignal = signal;
              return schedulerRef.current.run(isForeground, async () => {
                signal.throwIfAborted();
                let result: GSMaPRainLayerResult;
                try {
                  result = await bounded(source === 'jma-nowcast' ? fetchJMANowcastRainLayer(targetFrame, signal)
                    : fetchGSMaPRainLayer(targetFrame.date, false, signal), frameTimeout, signal);
                } catch (error) {
                  signal.throwIfAborted();
                  if (source !== 'jma-nowcast' || !frameControllers.current.get(reqKey)?.foreground || !(error instanceof WeatherRequestError) || !error.refreshCatalog) throw error;
                  // Refresh once, and only fetch again if the same valid time has a new key.
                  const catalog = await bounded(fetchJMANowcastCatalog(), WEATHER_FRAME_MS, signal);
                  signal.throwIfAborted();
                  const replacementIndex = catalog.frames.findIndex(f => f.date.getTime() === targetFrame.date.getTime());
                  const replacement = catalog.frames[replacementIndex];
                  if (!replacement || getFrameKey(source, replacement) === cacheKey) throw error;
                  targetFrame = replacement;
                  jmaFramesCatalogRef.current = catalog;
                  replaceTimelineFrames(catalog.frames); setCurrentTimeIndex(replacementIndex);
                  const cached = cacheMap.get(getFrameKey(source, replacement));
                  result = cached && cached.status !== 'partial' ? cached : await fetchJMANowcastRainLayer(replacement, signal);
                }
                signal.throwIfAborted();
                return { ...result, timelineFrame: targetFrame };
              }, signal);
            });
            if (res && res.status !== 'failure' && !controller.signal.aborted) {
              cacheMap.set(getFrameKey(source, targetFrame), res); touchFrame(res);
              trimFrames([jmaCacheRef.current, gsmapCacheRef.current], activeFrameRef.current);
              setCachedCount(cacheMap.size);
            }
            diagnostic({ operation: 'frame', backend: 'network', outcome: 'success', durationMs: performance.now() - started, generation: activeRequestIdRef.current });
            return res;
          } catch (error) {
            diagnostic({ operation: 'frame', backend: 'network', outcome: 'failure', error: controller.signal.aborted ? 'cancelled' : error instanceof WeatherRequestError ? error.kind : 'network', durationMs: performance.now() - started });
            throw error;
          } finally {
            if (inFlightRequestsRef.current.get(reqKey) === pending) {
              inFlightRequestsRef.current.delete(reqKey);
              frameControllers.current.delete(reqKey);
            }
          }
        })();

        pending = fetchPromise;
        inFlightRequestsRef.current.set(reqKey, pending);
      }

      return await pending;
    },
    [getCacheForSource, getFrameKey, replaceTimelineFrames]
  );

  // 初回マウント時に AW3D30 標高インスペクター用データを事前ロード（共有URLの `name` 指定時は標高も即時取得）
  useEffect(() => {
    preloadCentralMountainElevation();
    const urlState = initialUrlStateRef.current;
    const preset = initialPresetResolutionRef.current.preset;
    if (
      urlState?.spotName &&
      typeof urlState.lng === 'number' &&
      typeof urlState.lat === 'number' &&
      !(preset.elevation > 0)
    ) {
      const targetLng = urlState.lng;
      const targetLat = urlState.lat;
      fetchPointElevationFromAW3D(targetLng, targetLat).then((fetchedElev) => {
        if (fetchedElev !== null) {
          setInspectedPoint((prev) =>
            prev && prev.lng === targetLng && prev.lat === targetLat
              ? { ...prev, elevation: fetchedElev }
              : prev
          );
        }
      });
    }
  }, []);

  // データソース ('jma-nowcast' ⇄ 'jaxa-gsmap') 切り替え・初期化＆バックグラウンドプリフェッチ
  useEffect(() => {
    let mounted = true;
    const activeSource = rainSource;
    const reqId = ++activeRequestIdRef.current;

    const initSourceTimeline = async () => {
      try {
        setIsLoadingRain(true);
        let frames: TimelineFrameItem[] = [];
        let defaultIdx = 0;

        if (activeSource === 'jma-nowcast') {
          if (!jmaFramesCatalogRef.current) {
            const catalog = await fetchJMANowcastCatalog();
            jmaFramesCatalogRef.current = catalog;
          }
          frames = jmaFramesCatalogRef.current.frames;
          defaultIdx = jmaFramesCatalogRef.current.defaultIndex;
        } else {
          if (!gsmapFramesCatalogRef.current) {
            const catalog = await fetchGSMaPTimelineCatalog(true);
            const maxIdx = Math.max(0, catalog.dates.length - 1);
            const gsmapFrames: TimelineFrameItem[] = catalog.dates.map((d, idx) => {
              const hoursAgo = maxIdx - idx;
              return {
                date: d,
                labelJST: formatDateToJST(d),
                relativeBadge: hoursAgo === 0 ? 'カタログ最新' : `-${hoursAgo}時間`,
                isForecast: false,
                isLatestObservation: hoursAgo === 0,
              };
            });
            const defIdx = Math.max(
              0,
              catalog.dates.findIndex(
                (d) => d.getTime() === catalog.defaultDisplayDate.getTime()
              )
            );
            gsmapFramesCatalogRef.current = {
              frames: gsmapFrames,
              defaultIndex: defIdx,
            };
          }
          frames = gsmapFramesCatalogRef.current.frames;
          defaultIdx = gsmapFramesCatalogRef.current.defaultIndex;
        }

        if (!mounted || reqId !== activeRequestIdRef.current) return;

        // 初回起動時にURLの `t` パラメータが指定されていれば該当時刻のフレームを選択
        let targetIdx = defaultIdx;
        if (catalogRevision > 0 && selectedTimeRef.current) {
          const index = frames.findIndex(f => f.date.getTime() === selectedTimeRef.current!.getTime());
          if (index >= 0) targetIdx = index;
        }
        if (pendingUrlTimeParamRef.current !== undefined) {
          targetIdx = resolveFrameIndexFromTimeParam(
            pendingUrlTimeParamRef.current,
            frames,
            defaultIdx
          );
          pendingUrlTimeParamRef.current = undefined;
        }

        const cacheMap = getCacheForSource(activeSource);
        replaceTimelineFrames(frames);
        setCurrentTimeIndex(targetIdx);
        selectedTimeRef.current = frames[targetIdx]?.date ?? null;
        setCachedCount(cacheMap.size);

        const initialRain = await loadFrameAtIndex(activeSource, targetIdx, frames, true);
        if (!mounted || reqId !== activeRequestIdRef.current) return;
        if (!initialRain) { restoreDisplayedTime(activeSource, reqId); return; }

        setActiveRainLayerResult(initialRain);
        activeFrameRef.current = initialRain;
        trimFrames([jmaCacheRef.current, gsmapCacheRef.current], initialRain);
        setRainLayerData(initialRain);

        const [lng, lat] = activePreset.center;
        const inspected = inspectLocationValues(lng, lat);
        setActivePresetRain(inspected.precipitation);
        setInspectedPoint((prev) =>
          prev
            ? {
                ...prev,
                precipitation: inspectLocationValues(prev.lng, prev.lat).precipitation,
              }
            : null
        );
        setIsLoadingRain(false);

        // 前後2フレーム限定でバックグラウンド先読み (予算管理・FIX-13)
        const prefetchOffsets = [-1, 1, -2, 2];
        for (const off of prefetchOffsets) {
          if (!mounted || reqId !== activeRequestIdRef.current || document.visibilityState === 'hidden') break;
          const pIdx = targetIdx + off;
          if (pIdx >= 0 && pIdx < frames.length) {
            const pFrame = frames[pIdx];
            const pKey = getFrameKey(activeSource, pFrame);
            if (!cacheMap.has(pKey)) {
              try {
                await loadFrameAtIndex(activeSource, pIdx, frames, false);
              } catch {
                // 先読み失敗は無視
              }
            }
          }
        }
      } catch (err) {
        console.error(`Failed to initialize rain source (${activeSource}):`, err);
        if (mounted && reqId === activeRequestIdRef.current) {
          restoreDisplayedTime(activeSource, reqId);
        }
      }
    };

    initSourceTimeline();
    return () => {
      mounted = false;
      for (const entry of frameControllers.current.values()) entry.controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rainSource, catalogRevision, loadFrameAtIndex, getCacheForSource, replaceTimelineFrames, restoreDisplayedTime]);

  // 時系列インデックス変更時に該当時刻の雨雲データを即時反映 (要求世代管理・FIX-05)
  const handlePreviewTimeIndex = useCallback((index: number) => {
    const frame = timelineFrames[index];
    if (!frame) return;
    ++activeRequestIdRef.current;
    selectedTimeRef.current = frame.date;
    setCurrentTimeIndex(index); setIsLoadingRain(true); setIsPlaying(false);
    startedAtEndRef.current = false;
    const key = `${rainSource}:${getFrameKey(rainSource, frame)}`;
    for (const [requestKey, entry] of frameControllers.current) if (requestKey !== key) entry.controller.abort();
  }, [timelineFrames, rainSource, getFrameKey]);

  const handleSelectTimeIndex = useCallback(
    async (index: number) => {
      setCurrentTimeIndex(index);
      selectedTimeRef.current = timelineFrames[index]?.date ?? null;
      if (timelineFrames.length === 0) return;

      const reqId = ++activeRequestIdRef.current;
      const targetFrame = timelineFrames[index];
      if (!targetFrame) return;

      const cacheKey = getFrameKey(rainSource, targetFrame);
      for (const [key, entry] of frameControllers.current) {
        if (key !== `${rainSource}:${cacheKey}`) entry.controller.abort();
      }
      const cacheMap = getCacheForSource(rainSource);
      const cached = cacheMap.get(cacheKey);

      if (cached && cached.status !== 'partial') {
        cacheMap.delete(cacheKey); cacheMap.set(cacheKey, cached);
        setActiveRainLayerResult(cached);
        touchFrame(cached); activeFrameRef.current = cached;
        setRainLayerData(cached);
        setIsLoadingRain(false);
        const [lng, lat] = activePreset.center;
        const val = inspectLocationValues(lng, lat);
        setActivePresetRain(val.precipitation);
        setInspectedPoint((prev) =>
          prev
            ? {
                ...prev,
                precipitation: inspectLocationValues(prev.lng, prev.lat).precipitation,
              }
            : null
        );
        return;
      }

      try {
        setIsLoadingRain(true);
        const result = await loadFrameAtIndex(rainSource, index, timelineFrames, true);
        // 最新の要求世代と一致している場合のみ画面に反映 (FIX-05)
        if (reqId === activeRequestIdRef.current && result) {
          setActiveRainLayerResult(result);
          activeFrameRef.current = result;
          trimFrames([jmaCacheRef.current, gsmapCacheRef.current], result);
          setRainLayerData(result);
          const [lng, lat] = activePreset.center;
          const val = inspectLocationValues(lng, lat);
          setActivePresetRain(val.precipitation);
          setInspectedPoint((prev) =>
            prev
              ? {
                  ...prev,
                  precipitation: inspectLocationValues(prev.lng, prev.lat).precipitation,
                }
              : null
          );
        } else if (!result) { restoreDisplayedTime(rainSource, reqId); }
      } catch (err) {
        restoreDisplayedTime(rainSource, reqId);
      } finally {
        if (reqId === activeRequestIdRef.current) {
          setIsLoadingRain(false);
        }
      }
    },
    [timelineFrames, rainSource, activePreset.center, getCacheForSource, loadFrameAtIndex, getFrameKey, restoreDisplayedTime]
  );

  // URLパラメータを即座に最新状態へ同期（共有ボタン押下時の即時フラッシュにも使用）
  const flushUrlState = useCallback(() => {
    if (urlSyncTimerRef.current !== null) {
      window.clearTimeout(urlSyncTimerRef.current);
      urlSyncTimerRef.current = null;
    }
    const map = mapInstanceRef.current;
    if (map) {
      const c = map.getCenter();
      cameraViewRef.current = {
        lat: c.lat,
        lng: c.lng,
        zoom: map.getZoom(),
        pitch: map.getPitch(),
        bearing: map.getBearing(),
      };
    }
    const cam = cameraViewRef.current;
    const activeFrame = timelineFrames[currentTimeIndex];
    replaceUrlViewState({
      lat: cam.lat,
      lng: cam.lng,
      zoom: cam.zoom,
      pitch: cam.pitch,
      bearing: cam.bearing,
      rainSource,
      frameDate: activeFrame?.date,
      baseMap,
      exaggeration,
      spotName: sharedSpotNameRef.current,
    });
  }, [timelineFrames, currentTimeIndex, rainSource, baseMap, exaggeration]);

  // 300msデバウンスで window.history.replaceState を実行
  const scheduleUrlSync = useCallback(() => {
    if (urlSyncTimerRef.current !== null) {
      window.clearTimeout(urlSyncTimerRef.current);
    }
    urlSyncTimerRef.current = window.setTimeout(() => {
      urlSyncTimerRef.current = null;
      const cam = cameraViewRef.current;
      const activeFrame = timelineFrames[currentTimeIndex];
      replaceUrlViewState({
        lat: cam.lat,
        lng: cam.lng,
        zoom: cam.zoom,
        pitch: cam.pitch,
        bearing: cam.bearing,
        rainSource,
        frameDate: activeFrame?.date,
        baseMap,
        exaggeration,
        spotName: sharedSpotNameRef.current,
      });
    }, 300);
  }, [timelineFrames, currentTimeIndex, rainSource, baseMap, exaggeration]);

  // 選択状態は直ちにURLへ反映する。カメラの連続移動だけをデバウンスする。
  useEffect(() => {
    flushUrlState();
    return () => {
      if (urlSyncTimerRef.current !== null) {
        window.clearTimeout(urlSyncTimerRef.current);
      }
    };
  }, [flushUrlState]);

  // MapViewer の moveend イベントから呼ばれるカメラ変更ハンドラ
  const handleCameraChange = useCallback(
    (view: { lat: number; lng: number; zoom: number; pitch: number; bearing: number }) => {
      cameraViewRef.current = view;
      scheduleUrlSync();
      if (centerDebounceTimerRef.current !== null) {
        clearTimeout(centerDebounceTimerRef.current);
      }
      centerDebounceTimerRef.current = setTimeout(() => {
        setMapCenter({ lng: view.lng, lat: view.lat });
      }, 350);
    },
    [scheduleUrlSync]
  );

  // タイムライン引き出し式 降水量推移グラフの時系列データ取得 (非同期・AbortController管理)
  useEffect(() => {
    if (!isDrawerOpen) {
      if (timeseriesControllerRef.current) {
        timeseriesControllerRef.current.abort();
        timeseriesControllerRef.current = null;
      }
      return;
    }

    if (timelineFrames.length === 0) return;

    if (timeseriesControllerRef.current) {
      timeseriesControllerRef.current.abort();
    }
    const controller = new AbortController();
    timeseriesControllerRef.current = controller;

    setIsTimeseriesLoading(true);
    fetchPointTimeseries(
      mapCenter.lng,
      mapCenter.lat,
      timelineFrames,
      rainSource,
      controller.signal
    )
      .then((result) => {
        if (!controller.signal.aborted) {
          setTimeseries(result);
          setIsTimeseriesLoading(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setIsTimeseriesLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [isDrawerOpen, mapCenter.lng, mapCenter.lat, timelineFrames, rainSource]);

  // 雨雲データソース切り替えハンドラ (View Transitions API 連動)
  const handleChangeRainSource = useCallback(
    (nextSource: RainSourceId) => {
      if (nextSource === rainSource) return;
      ++activeRequestIdRef.current;
      for (const entry of frameControllers.current.values()) entry.controller.abort();
      runViewTransition(() => {
        setIsPlaying(false);
        startedAtEndRef.current = false;
        setRainSource(nextSource);
      });
    },
    [rainSource]
  );

  // タイムラプス再生・停止トグル（末尾到達時は再生開始時に先頭巻き戻しフラグをセット）
  const handleTogglePlay = useCallback(() => {
    setIsPlaying((prev) => {
      const nextPlaying = !prev;
      if (nextPlaying) {
        startedAtEndRef.current = currentTimeIndex >= timelineFrames.length - 1;
      } else {
        startedAtEndRef.current = false;
      }
      return nextPlaying;
    });
  }, [currentTimeIndex, timelineFrames.length]);

  // 機能A-2: タイムラプス自動コマ送り・終端停止（1x: 1000ms / 2x: 500ms）
  useEffect(() => {
    if (!isPlaying || isLoadingRain || timelineFrames.length <= 1) return;

    const intervalMs = playbackSpeed === 2 ? 500 : 1000;
    const timer = window.setInterval(() => {
      if (startedAtEndRef.current) {
        startedAtEndRef.current = false;
        handleSelectTimeIndex(0);
        return;
      }
      const nextIdx = currentTimeIndex + 1;
      if (nextIdx >= timelineFrames.length) {
        setIsPlaying(false);
        return;
      }
      handleSelectTimeIndex(nextIdx);
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [isPlaying, isLoadingRain, playbackSpeed, currentTimeIndex, timelineFrames.length, handleSelectTimeIndex]);

  // 山岳プリセット・お気に入り・検索地点切替 (View Transitions API 連動 + インスペクター自動表示)
  const handleSelectPreset = useCallback(
    async (preset: PresetLocation) => {
      const [lng, lat] = preset.center;
      if (centerDebounceTimerRef.current !== null) {
        clearTimeout(centerDebounceTimerRef.current);
      }
      setMapCenter({ lng, lat });
      setIsDrawerOpen(false);
      const inspected = inspectLocationValues(lng, lat);
      const screenX = typeof window !== 'undefined' ? Math.round(window.innerWidth / 2) : undefined;
      const screenY =
        typeof window !== 'undefined' ? Math.round(window.innerHeight / 2) : undefined;
      const isOsmSearch = preset.id.startsWith('osm-search-');
      const resolvedElevation =
        preset.elevation && preset.elevation > 0 ? preset.elevation : inspected.elevation;

      const map = mapInstanceRef.current;
      let initialElevation = resolvedElevation;
      if (initialElevation === null && map?.getTerrain()) {
        const queried = map.queryTerrainElevation([lng, lat]);
        if (queried !== null && Number.isFinite(queried)) {
          initialElevation = Math.round(queried);
        }
      }

      sharedSpotNameRef.current = undefined;
      cameraViewRef.current = {
        lat,
        lng,
        zoom: preset.zoom,
        pitch: preset.pitch,
        bearing: preset.bearing,
      };
      scheduleUrlSync();

      map?.flyTo({
        center: preset.center,
        zoom: preset.zoom,
        pitch: preset.pitch,
        bearing: preset.bearing,
        duration: 1800,
        essential: true,
      });

      runViewTransition(() => {
        setOpenTopPanel(null);
        setActivePreset(preset);
        setActivePresetRain(inspected.precipitation);
        setInspectedPoint({
          lng,
          lat,
          elevation: initialElevation,
          precipitation: inspected.precipitation,
          screenX,
          screenY,
          label: preset.isFavorite
            ? `⭐ ${preset.name}`
            : isOsmSearch
              ? `${preset.emoji} ${preset.name}`
              : `${preset.emoji} ${preset.name}（山頂）`,
        });
      });

      if (initialElevation === null) {
        // カメラ移動完了後 (moveend) に画面上の3D地形メッシュから即座に標高を取得
        if (map) {
          map.once('moveend', () => {
            if (map.getTerrain()) {
              const queried = map.queryTerrainElevation([lng, lat]);
              if (queried !== null && Number.isFinite(queried)) {
                setInspectedPoint((prev) =>
                  prev && prev.lng === lng && prev.lat === lat
                    ? { ...prev, elevation: Math.round(queried) }
                    : prev
                );
              }
            }
          });
        }

        // AW3D30衛星データからも並行取得（画面外や平坦地などのフォールバック）
        const fetchedElev = await fetchPointElevationFromAW3D(lng, lat);
        if (fetchedElev !== null) {
          setInspectedPoint((prev) =>
            prev && prev.lng === lng && prev.lat === lat
              ? { ...prev, elevation: prev.elevation ?? fetchedElev }
              : prev
          );
        }
      }
    },
    [scheduleUrlSync]
  );

  // 現在インスペクターで表示中の地点が既にお気に入り登録済みか判定
  const matchedFavorite = useMemo(() => {
    if (!inspectedPoint) return null;
    return (
      favorites.find((f) =>
        isSameCoordinate(f.center[0], f.center[1], inspectedPoint.lng, inspectedPoint.lat)
      ) ?? null
    );
  }, [favorites, inspectedPoint]);

  // お気に入り地点の登録・更新（直列化・最新世代保護・ADD-01, ADD-02, ADD-03）
  const handleSaveFavorite = useCallback(
    async (customName: string): Promise<StorageOperationResult> => {
      if (!inspectedPoint) {
        return { success: false, error: 'invalid-data', message: '地点が選択されていません。' };
      }
      const trimmed = customName.trim();
      if (!trimmed) {
        return { success: false, error: 'invalid-data', message: '地点名を入力してください。' };
      }
      if (trimmed.length > MAX_NAME_LENGTH) {
        return {
          success: false,
          error: 'invalid-data',
          message: `地点名は最大${MAX_NAME_LENGTH}文字です。（現在${trimmed.length}文字）`,
        };
      }

      const map = mapInstanceRef.current;
      const currentZoom = Number((map?.getZoom() ?? 10.5).toFixed(2));
      const currentPitch = Math.round(map?.getPitch() ?? 60);
      const currentBearing = Math.round(map?.getBearing() ?? 0);

      const nowIso = new Date().toISOString();
      const newFav: PresetLocation = buildFavoriteLocation({
        id: matchedFavorite?.id ?? `fav-${Date.now()}`,
        name: trimmed,
        lng: inspectedPoint.lng,
        lat: inspectedPoint.lat,
        zoom: currentZoom,
        pitch: currentPitch,
        bearing: currentBearing,
        elevation: inspectedPoint.elevation ?? 0,
        createdAt: matchedFavorite?.createdAt ?? nowIso,
        updatedAt: nowIso,
      });

      return runSerializedFavoritesOp<StorageOperationResult>(async (current) => {
        const isExisting = current.some((f) => f.id === newFav.id);
        if (!isExisting && current.length >= MAX_FAVORITES_COUNT) {
          const res: StorageOperationResult = {
            success: false,
            error: 'invalid-data',
            message: `お気に入り登録上限（最大${MAX_FAVORITES_COUNT}件）に達しています。不要な地点を削除してから追加してください。`,
          };
          return {
            result: res,
          };
        }

        const next = isExisting
          ? current.map((f) => (f.id === newFav.id ? newFav : f))
          : [newFav, ...current];

        requestPersistentStorage();
        const saveRes = await saveFavoriteLocations(next);
        if (saveRes.success) {
          return {
            next, result: saveRes,
            updateSelection: () => {
              setActivePreset(newFav);
              setInspectedPoint((prev) => (prev ? { ...prev, label: `⭐ ${trimmed}` } : null));
            },
          };
        } else {
          console.error('Failed to save favorite:', saveRes.message);
          return { result: saveRes };
        }
      });
    },
    [inspectedPoint, matchedFavorite, runSerializedFavoritesOp]
  );

  // お気に入り地点の削除（直列化・ADD-03）
  const handleRemoveFavorite = useCallback(
    async (id: string) => {
      return runSerializedFavoritesOp(async (current) => {
        const next = current.filter((f) => f.id !== id);
        const saveRes = await saveFavoriteLocations(next);
        if (saveRes.success) {
          return { next, result: saveRes };
        }
        setFavoritesWarning(saveRes.message ?? "削除できませんでした。");
        return { result: saveRes };
      });
    },
    [runSerializedFavoritesOp]
  );

  // お気に入り地点のピン留めトグル（直列化）
  const handleTogglePinFavorite = useCallback(
    async (id: string) => {
      return runSerializedFavoritesOp(async (current) => {
        const next = current.map((f) =>
          f.id === id ? { ...f, isPinned: !f.isPinned, updatedAt: new Date().toISOString() } : f
        );
        const saveRes = await saveFavoriteLocations(next);
        if (saveRes.success) {
          return { next, result: saveRes };
        }
        setFavoritesWarning(saveRes.message ?? "ピン留め状態を更新できませんでした。");
        return { result: saveRes };
      });
    },
    [runSerializedFavoritesOp]
  );

  // バックアップ・引き継ぎ（JSON / 同期URL）からの取り込み結果、または元に戻す操作を反映
  const handleApplyFavorites = useCallback(
    (action: { kind: 'import'; items: PresetLocation[]; mode: ImportMode; expected: PresetLocation[] } | { kind: 'undo' }) =>
      runSerializedFavoritesOp(async (current) => {
        if (action.kind === 'undo') {
          const result = await restoreFavoritesUndo();
          return { next: result.success ? result.restoredItems : undefined, result };
        }
        const affected = (items: PresetLocation[]) => action.mode === 'replace' ? items : items.filter(item =>
          action.items.some(incoming => incoming.id === item.id || isSameCoordinate(incoming.center[0], incoming.center[1], item.center[0], item.center[1])));
        if (JSON.stringify(affected(current)) !== JSON.stringify(affected(action.expected))) {
          return { result: { success: false, message: '確認中に対象の一覧が更新されました。表示内容を確認してから、もう一度取り込んでください。' } };
        }
        const preview = previewImport(current, action.items, action.mode);
        if (preview.truncated) return { result: { success: false, message: '登録上限を超えるため取り込みできません。' } };
        const result = await saveFavoritesAndUndoAtomic(preview.next, current);
        return { next: result.success ? preview.next : undefined,
          result: { ...result, restoredItems: result.success ? preview.next : undefined } };
      }),
    [runSerializedFavoritesOp]
  );

  const handleBackupExported = useCallback(async (iso: string) => {
    const result = await saveLastBackupAt(iso);
    if (result.success) setLastBackupAt(iso);
    else setFavoritesWarning('書き出しは開始しましたが、書き出し操作日時を保存できませんでした。');
  }, []);

  const handleOpenFavoritesSync = useCallback(() => {
    runViewTransition(() => {
      setOpenTopPanel(null);
      setFavoritesSyncDialog({ pendingImport: null, error: null });
    });
  }, []);

  const handleCloseFavoritesSync = useCallback(() => {
    clearPendingFavoritesPayload();
    setFavoritesSyncDialog(null);
  }, []);

  // 同期URL（#fav=...）のペイロードを展開し、取り込み確認ダイアログを表示
  const openFavoritesImportFromPayload = useCallback(async (payload: string) => {
    try {
      const items = await decodeFavoritesPayload(payload);
      setOpenTopPanel(null);
      setFavoritesSyncDialog({
        pendingImport: { items, sourceLabel: '同期URL' },
        error: null,
      });
    } catch (err) {
      setFavoritesSyncDialog({
        pendingImport: null,
        error:
          err instanceof FavoritesTransferError
            ? err.message
            : '同期URLを読み込めませんでした。',
      });
    }
  }, []);

  // 起動時・ハッシュ変更時に同期URLを検出（ハッシュはすぐ消去してリロード時の再取り込みを防止）
  const initialFavHashHandledRef = useRef(false);
  useEffect(() => {
    if (!initialFavHashHandledRef.current) {
      initialFavHashHandledRef.current = true;
      const payload = takeFavoritesPayloadFromLocation();
      if (payload) void openFavoritesImportFromPayload(payload);
    }
    const handleHashChange = () => {
      const payload = takeFavoritesPayloadFromLocation();
      if (payload) void openFavoritesImportFromPayload(payload);
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [openFavoritesImportFromPayload]);

  // 最終バックアップから30日以上経過し、その後にお気に入りが更新されている場合はバックアップを推奨
  const backupRecommended = useMemo(() => {
    if (favorites.length === 0) return false;
    const lastMs = lastBackupAt ? Date.parse(lastBackupAt) : 0;
    if (!lastMs) return true;
    const latestUpdate = favorites.reduce(
      (max, f) => Math.max(max, f.updatedAt ? Date.parse(f.updatedAt) || 0 : 0),
      0
    );
    return Date.now() - lastMs > 30 * 24 * 60 * 60 * 1000 && latestUpdate > lastMs;
  }, [favorites, lastBackupAt]);

  // 地点インスペクターからの地点名付きURL共有
  const handleShareInspectorPoint = useCallback(
    async (pointName: string) => {
      if (!inspectedPoint) return;
      const map = mapInstanceRef.current;
      const currentZoom = map?.getZoom() ?? cameraViewRef.current.zoom;
      const currentPitch = map?.getPitch() ?? cameraViewRef.current.pitch;
      const currentBearing = map?.getBearing() ?? cameraViewRef.current.bearing;
      const activeFrame = timelineFrames[currentTimeIndex];

      sharedSpotNameRef.current = pointName;
      const params = {
        lat: inspectedPoint.lat,
        lng: inspectedPoint.lng,
        zoom: currentZoom,
        pitch: currentPitch,
        bearing: currentBearing,
        rainSource,
        frameDate: activeFrame?.date,
        baseMap,
        exaggeration,
        spotName: pointName,
      };
      replaceUrlViewState(params);
      const shareUrl = buildCustomDomainShareUrl(params);
      const outcome = await shareOrCopyUrl({
        url: shareUrl,
        title: `${pointName} | 3D RainScape - リアルタイム雨雲×3D地形ビューア`,
      });
      if (outcome === 'copied') {
        setShareToastVersion((v) => v + 1);
      }
    },
    [inspectedPoint, timelineFrames, currentTimeIndex, rainSource, baseMap, exaggeration]
  );

  // お気に入り一覧からの地点名・登録視点付きURL共有
  const handleShareFavorite = useCallback(
    async (fav: PresetLocation) => {
      const [lng, lat] = fav.center;
      const activeFrame = timelineFrames[currentTimeIndex];
      const params = {
        lat,
        lng,
        zoom: fav.zoom,
        pitch: fav.pitch,
        bearing: fav.bearing,
        rainSource,
        frameDate: activeFrame?.date,
        baseMap,
        exaggeration,
        spotName: fav.name,
      };
      const shareUrl = buildCustomDomainShareUrl(params);
      const outcome = await shareOrCopyUrl({
        url: shareUrl,
        title: `${fav.name} | 3D RainScape - リアルタイム雨雲×3D地形ビューア`,
      });
      if (outcome === 'copied') {
        setShareToastVersion((v) => v + 1);
      }
    },
    [timelineFrames, currentTimeIndex, rainSource, baseMap, exaggeration]
  );

  // 機能B-3: 地図クリック時のインスペクターカード表示・移動 (View Transitions API 連動 + パターンA: ドロワー自動格納)
  const handleInspectPoint = useCallback(
    (point: InspectorPoint) => {
      sharedSpotNameRef.current = undefined;
      scheduleUrlSync();
      setIsDrawerOpen(false);
      runViewTransition(() => {
        setInspectedPoint(point);
      });
    },
    [scheduleUrlSync]
  );

  // パターンA: タイムラインドロワー開閉ハンドラ (ドロワー展開時はインスペクターを自動クローズ)
  const handleToggleDrawer = useCallback(
    (open: boolean) => {
      setIsDrawerOpen(open);
      if (open) {
        sharedSpotNameRef.current = undefined;
        scheduleUrlSync();
        runViewTransition(() => {
          setInspectedPoint(null);
        });
      }
    },
    [scheduleUrlSync]
  );

  // GPS現在地へジャンプ（取得中の連打によるスマホ画面のダブルタップ拡大を抑止）
  const handleJumpToCurrentLocation = useCallback(() => {
    if (!navigator.geolocation || !mapInstanceRef.current || isLocating) return;
    setIsLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        setIsLocating(false);
        const { longitude, latitude } = pos.coords;
        const screenX =
          typeof window !== 'undefined' ? Math.round(window.innerWidth / 2) : undefined;
        const screenY =
          typeof window !== 'undefined' ? Math.round(window.innerHeight / 2) : undefined;

        sharedSpotNameRef.current = undefined;
        // 現在の縮尺(zoom)・傾き(pitch)・方角(bearing)を維持したまま現在地へ移動
        mapInstanceRef.current?.flyTo({
          center: [longitude, latitude],
          duration: 1500,
          essential: true,
        });
        const inspected = inspectLocationValues(longitude, latitude);
        runViewTransition(() => {
          setInspectedPoint({
            lng: longitude,
            lat: latitude,
            elevation: inspected.elevation,
            precipitation: inspected.precipitation,
            screenX,
            screenY,
            label: '📍 現在地',
          });
        });

        if (inspected.elevation === null) {
          const fetchedElev = await fetchPointElevationFromAW3D(longitude, latitude);
          if (fetchedElev !== null) {
            setInspectedPoint((prev) =>
              prev && prev.lng === longitude && prev.lat === latitude
                ? { ...prev, elevation: fetchedElev }
                : prev
            );
          }
        }
      },
      (err) => {
        setIsLocating(false);
        console.warn('Geolocation unavailable:', err);
      },
      {
        enableHighAccuracy: false,
        timeout: 8000,
        maximumAge: 60000,
      }
    );
  }, [isLocating]);

  // 共有URL読み込み（メニューからの読込・またはPWA Launch Handler API 経由）で3D視点・地点名・時刻を即時反映
  const handleImportUrlState = useCallback(
    async (urlState: UrlViewState) => {
      const { preset } = resolveInitialPresetFromUrl(urlState, favorites);
      const [lng, lat] = preset.center;

      sharedSpotNameRef.current = urlState.spotName;
      cameraViewRef.current = {
        lat,
        lng,
        zoom: preset.zoom,
        pitch: preset.pitch,
        bearing: preset.bearing,
      };
      scheduleUrlSync();

      if (urlState.exaggeration !== undefined) {
        setExaggeration(urlState.exaggeration);
      }
      if (urlState.baseMap) {
        setBaseMap(urlState.baseMap);
      }
      if (urlState.rainSource && urlState.rainSource !== rainSource) {
        if (urlState.timeParam !== undefined) {
          pendingUrlTimeParamRef.current = urlState.timeParam;
        }
        setRainSource(urlState.rainSource);
      } else if (urlState.timeParam !== undefined && timelineFrames.length > 0) {
        const targetIdx = resolveFrameIndexFromTimeParam(
          urlState.timeParam,
          timelineFrames,
          currentTimeIndex
        );
        handleSelectTimeIndex(targetIdx);
      }

      mapInstanceRef.current?.flyTo({
        center: [lng, lat],
        zoom: preset.zoom,
        pitch: preset.pitch,
        bearing: preset.bearing,
        duration: 1400,
        essential: true,
      });

      const inspected = inspectLocationValues(lng, lat);
      const resolvedElevation =
        preset.elevation && preset.elevation > 0 ? preset.elevation : inspected.elevation;

      runViewTransition(() => {
        setOpenTopPanel(null);
        setActivePreset(preset);
        setActivePresetRain(inspected.precipitation);

        if (urlState.spotName) {
          const screenX = Math.round(window.innerWidth / 2);
          const screenY = Math.round(window.innerHeight / 2);
          setInspectedPoint({
            lng,
            lat,
            elevation: resolvedElevation,
            precipitation: inspected.precipitation,
            screenX,
            screenY,
            label: preset.isFavorite ? `⭐ ${urlState.spotName}` : `📍 ${urlState.spotName}`,
          });
        } else {
          setInspectedPoint(null);
        }
      });

      if (urlState.spotName && resolvedElevation === null) {
        const fetchedElev = await fetchPointElevationFromAW3D(lng, lat);
        if (fetchedElev !== null) {
          setInspectedPoint((prev) =>
            prev && prev.lng === lng && prev.lat === lat
              ? { ...prev, elevation: fetchedElev }
              : prev
          );
        }
      }
    },
    [
      favorites,
      rainSource,
      timelineFrames,
      currentTimeIndex,
      scheduleUrlSync,
      handleSelectTimeIndex,
    ]
  );

  // PWA Link Capturing (Launch Handler API): インストール済みPWAが共有URLから起動・フォーカスされた際に視点と地点名を即時反映
  useEffect(() => {
    const win = window as Window & {
      launchQueue?: {
        setConsumer: (consumer: (launchParams: { targetURL?: string }) => void) => void;
      };
    };
    if (!win.launchQueue) return;

    win.launchQueue.setConsumer((launchParams) => {
      if (!launchParams?.targetURL) return;
      try {
        const parsedUrl = new URL(launchParams.targetURL);
        const favPayload = extractFavoritesPayloadFromHash(parsedUrl.hash);
        if (favPayload) {
          void openFavoritesImportFromPayload(favPayload);
          return;
        }
        if (!parsedUrl.search) return;
        const urlState = parseUrlViewState(parsedUrl.search);
        if (urlState) {
          handleImportUrlState(urlState);
        }
      } catch (err) {
        console.warn('Failed to apply launchQueue targetURL:', err);
      }
    });
  }, [handleImportUrlState, openFavoritesImportFromPayload]);

  // モーダル・上部パネルオープン時の Escape キー対応 (a11y-debugging 準拠)
  useEffect(() => {
    if (!showCreditModal && !openTopPanel) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showCreditModal) {
          runViewTransition(
            () => setShowCreditModal(false),
            { focusTargetSelector: '#jaxa-credit-trigger-btn' }
          );
        } else if (openTopPanel) {
          runViewTransition(() => setOpenTopPanel(null));
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showCreditModal, openTopPanel]);

  return (
    <div className="app-viewport overflow-hidden bg-slate-950 select-none">
      {/* メイン3D地図キャンバス (<div id="map" className="w-full h-full" /> を内包) */}
      <MapViewer
        activePreset={activePreset}
        favorites={favorites}
        exaggeration={exaggeration}
        rainOpacity={rainOpacity}
        baseMap={baseMap}
        rainLayerData={rainLayerData}
        inspectedPoint={inspectedPoint}
        skipInitialGeolocation={initialPresetResolutionRef.current.isFromUrl}
        onStatusChange={setGpuStatus}
        onInspectPoint={handleInspectPoint}
        onSelectFavorite={handleSelectPreset}
        onCameraChange={handleCameraChange}
        mapInstanceRef={mapInstanceRef}
      />

      {/* 百名山・お気に入り／設定／共有パネル展開中は背後の地図操作・選択をブロックし、背景タップでパネルを閉じる */}
      {openTopPanel !== null && (
        <div
          id="top-panel-backdrop"
          aria-hidden="true"
          onClick={() => runViewTransition(() => setOpenTopPanel(null))}
          className="fixed inset-0 z-30 pointer-events-auto bg-slate-950/20"
        />
      )}

      {/* 上部ヘッダーバー（スマホでは左側はアプリアイコンのみ表示し、右側ボタン群が画面幅に収まるよう調整） */}
      <header className="safe-header-padding pointer-events-none absolute top-0 inset-x-0 z-40 flex items-center justify-between gap-2 bg-gradient-to-b from-slate-950/95 via-slate-950/55 to-transparent">
        <div className="pointer-events-auto flex items-center gap-2 min-w-0 shrink-0">
          <div
            title="3D RainScape | リアルタイム雨雲 × 3D立体地形ビューア"
            aria-label="3D RainScape"
            className="flex items-center justify-center w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-gradient-to-br from-sky-400 to-blue-600 shadow-lg shadow-sky-500/25 shrink-0"
          >
            <CloudRain className="w-5 h-5 text-white" />
          </div>
          <div className="hidden sm:block min-w-0">
            <h1 className="text-base font-bold tracking-tight text-white truncate">
              3D RainScape
            </h1>
            <p className="text-[11px] text-slate-400 hidden xl:block">
              リアルタイム雨雲 × 3D立体地形ビューア
            </p>
          </div>
        </div>

        {/* 右上操作ボタン群（百名山プリセット・表示調整・現在地・共有・アプリ追加・情報アイコンを一列に集約） */}
        <div className="pointer-events-auto flex items-center justify-end gap-1.5 sm:gap-2 min-w-0 flex-1">
          <PresetNav
            presets={PRESET_LOCATIONS}
            favorites={favorites}
            activePreset={activePreset}
            activePresetRain={activePresetRain}
            referenceLocation={{
              lat: cameraViewRef.current.lat,
              lng: cameraViewRef.current.lng,
            }}
            onSelectPreset={handleSelectPreset}
            onRemoveFavorite={handleRemoveFavorite}
            onTogglePinFavorite={handleTogglePinFavorite}
            onShareFavorite={handleShareFavorite}
            onOpenFavoritesSync={handleOpenFavoritesSync}
            backupRecommended={backupRecommended}
            isOpen={openTopPanel === 'preset'}
            onToggleOpen={() =>
              runViewTransition(() =>
                setOpenTopPanel((prev) => (prev === 'preset' ? null : 'preset'))
              )
            }
          />

          <LayerMenu
            exaggeration={exaggeration}
            onChangeExaggeration={setExaggeration}
            rainOpacity={rainOpacity}
            onChangeRainOpacity={setRainOpacity}
            baseMap={baseMap}
            onChangeBaseMap={setBaseMap}
            rainSource={rainSource}
            onChangeRainSource={handleChangeRainSource}
            isOpen={openTopPanel === 'layer'}
            onToggleOpen={() =>
              runViewTransition(() =>
                setOpenTopPanel((prev) => (prev === 'layer' ? null : 'layer'))
              )
            }
          />

          {installPromptEvent && (
            <button
              id="pwa-install-btn"
              type="button"
              onClick={handleInstallPwa}
              title="ホーム画面にアプリを追加"
              className="inline-flex items-center justify-center gap-1.5 min-w-[38px] min-h-[38px] sm:min-h-[42px] px-2.5 sm:px-3.5 py-1.5 rounded-xl bg-emerald-500/25 hover:bg-emerald-500/35 backdrop-blur-md border border-emerald-400/50 shadow-lg text-xs sm:text-sm font-bold text-emerald-200 transition-colors cursor-pointer shrink-0"
            >
              <Download className="w-4 h-4 text-emerald-400 shrink-0" />
              <span className="hidden md:inline">アプリ追加</span>
            </button>
          )}

          <button
            type="button"
            onClick={handleJumpToCurrentLocation}
            onDoubleClick={(e) => e.preventDefault()}
            disabled={isLocating}
            title="現在地へ移動"
            aria-label="現在地へ移動"
            className={`inline-flex items-center justify-center gap-1.5 w-[38px] h-[38px] sm:w-auto sm:min-h-[42px] sm:px-3.5 py-1.5 rounded-xl backdrop-blur-md border shadow-lg text-xs sm:text-sm font-bold transition-colors cursor-pointer shrink-0 ${
              isLocating
                ? 'bg-sky-500/25 border-sky-400/60 text-sky-200'
                : 'bg-slate-900/90 hover:bg-slate-800 border-slate-700/80 text-slate-100'
            }`}
          >
            <LocateFixed
              className={`w-4 h-4 text-sky-400 shrink-0 ${isLocating ? 'animate-spin' : ''}`}
            />
            <span className="hidden sm:inline">{isLocating ? '取得中...' : '現在地'}</span>
          </button>

          <ShareButton
            onFlushUrlState={flushUrlState}
            externalToastVersion={shareToastVersion}
            onImportUrlState={handleImportUrlState}
            isOpen={openTopPanel === 'share'}
            onToggleOpen={() =>
              runViewTransition(() =>
                setOpenTopPanel((prev) => (prev === 'share' ? null : 'share'))
              )
            }
          />

          <button
            id="jaxa-credit-trigger-btn"
            type="button"
            title="データソース・ライセンス情報"
            aria-label="データソース・ライセンス情報を開く"
            onClick={() =>
              runViewTransition(
                () => setShowCreditModal(true),
                { focusTargetSelector: '#jaxa-credit-close-btn' }
              )
            }
            className="inline-flex items-center justify-center w-[38px] h-[38px] sm:w-[42px] sm:h-[42px] rounded-xl bg-slate-900/90 hover:bg-slate-800 backdrop-blur-md border border-slate-700/80 shadow-lg text-slate-100 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 shrink-0"
          >
            <Info className="w-4 h-4 sm:w-5 sm:h-5 text-sky-400" />
          </button>
        </div>
      </header>

      {/* クリック地点の近傍にフローティング表示される地点インスペクター (機能B: 単一インスタンスでView Transitions固有性を保証) */}
      <div className="pointer-events-none fixed inset-0 z-[35]">
        <Inspector
          point={inspectedPoint}
          onClose={() => {
            sharedSpotNameRef.current = undefined;
            scheduleUrlSync();
            runViewTransition(() => setInspectedPoint(null));
          }}
          matchedFavorite={matchedFavorite}
          onSaveFavorite={handleSaveFavorite}
          onRemoveFavorite={handleRemoveFavorite}
          onSharePoint={handleShareInspectorPoint}
        />
      </div>

      {/* グラフ引き出し展開時の地図中心照準マーク (Crosshair) - 雨雲（青・シアン等）上でも際立つ高視認性の赤系デザイン */}
      {isDrawerOpen && (
        <div
          id="map-center-crosshair"
          aria-hidden="true"
          className="pointer-events-none fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10 flex items-center justify-center animate-in fade-in duration-200"
        >
          <div className="relative flex items-center justify-center w-8 h-8 rounded-full border-2 border-rose-500 bg-rose-950/30 backdrop-blur-xs shadow-lg shadow-black/60 ring-1 ring-white/60">
            <div className="absolute w-3 h-[2px] bg-rose-400 rounded-full shadow-[0_0_2px_rgba(0,0,0,0.9)]" />
            <div className="absolute h-3 w-[2px] bg-rose-400 rounded-full shadow-[0_0_2px_rgba(0,0,0,0.9)]" />
            <div className="w-1.5 h-1.5 rounded-full bg-rose-500 shadow shadow-rose-500 animate-pulse ring-1 ring-white/90" />
          </div>
        </div>
      )}

      {/* 右下: 降雨強度 (mm/h) カラーバー凡例（スマホは右下のスリム縦型ピル、デスクトップは折りたたみカード） */}
      <div className="pointer-events-none absolute bottom-[calc(var(--safe-bottom)*0.6+106px)] sm:bottom-[calc(var(--safe-bottom)+118px)] lg:bottom-6 right-3 sm:right-4 z-20">
        <Legend
          maxPrecipitation={rainLayerData?.maxPrecipitation ?? 0}
          isLoading={isLoadingRain}
          rainSource={rainSource}
        />
      </div>

      {/* 下部中央: 時系列タイムラプスバー (横方向センタリング + iPhone ホームバー safe-area-inset-bottom 対応) */}
      <div className="safe-bottom-timeline pointer-events-none absolute inset-x-2 sm:inset-x-16 z-30 flex justify-center">
        <TimelineBar
          rainSource={rainSource}
          onChangeRainSource={handleChangeRainSource}
          frames={timelineFrames}
          currentIndex={currentTimeIndex}
          onSelectIndex={handleSelectTimeIndex}
          onPreviewIndex={handlePreviewTimeIndex}
          isPlaying={isPlaying}
          onTogglePlay={handleTogglePlay}
          playbackSpeed={playbackSpeed}
          onToggleSpeed={() => setPlaybackSpeed((prev) => (prev === 1 ? 2 : 1))}
          observedDateJST={rainLayerData?.formattedDateJST ?? ''}
          displayedFrame={rainLayerData?.timelineFrame ?? null}
          isLoading={isLoadingRain}
          cachedCount={cachedCount}
          timeseries={timeseries}
          isTimeseriesLoading={isTimeseriesLoading}
          centerCoords={mapCenter}
          isDrawerOpen={isDrawerOpen}
          onToggleDrawer={handleToggleDrawer}
        />
      </div>

      {/* お気に入りのバックアップ・引き継ぎダイアログ */}
      {favoritesWarning && <div role="alert" className="fixed bottom-24 left-4 right-4 z-50 rounded bg-slate-900 p-3 text-white">{favoritesWarning}<button className="ml-3 underline" onClick={async () => {
        try {
          const data = await readFavoritesRecoveryData();
          const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
          const link = document.createElement('a'); link.href = url; link.download = 'favorites-recovery.json'; link.click();
          window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch { setFavoritesWarning('救済用データを読み出せませんでした。元の保存内容は変更していません。'); }
      }}>元の保存データを書き出す</button></div>}
      {favoritesSyncDialog && (
        <FavoritesSyncDialog
          favorites={favorites}
          onApplyFavorites={handleApplyFavorites}
          onClose={handleCloseFavoritesSync}
          initialImport={favoritesSyncDialog.pendingImport}
          initialError={favoritesSyncDialog.error}
          lastBackupAt={lastBackupAt}
          onBackupExported={handleBackupExported}
        />
      )}

      {/* データソース・ライセンス情報モーダル */}
      {showCreditModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="jaxa-credit-title"
          style={{
            paddingTop: 'calc(var(--safe-top) + 0.75rem)',
            paddingBottom: 'calc(var(--safe-bottom) + 0.75rem)',
            paddingLeft: 'calc(var(--safe-left) + 0.75rem)',
            paddingRight: 'calc(var(--safe-right) + 0.75rem)',
          }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm"
        >
          <div
            style={{
              maxHeight: 'calc(100dvh - var(--safe-top) - var(--safe-bottom) - 1.5rem)',
            }}
            className="w-full max-w-lg overflow-y-auto rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl p-4 sm:p-5 text-slate-100 text-xs space-y-3"
          >
            <div className="flex items-center justify-between pb-2.5 border-b border-slate-800">
              <h2 id="jaxa-credit-title" className="text-sm font-bold text-white">
                データソース・ライセンス表記 (JAXA Earth API / 気象庁ナウキャスト)
              </h2>
              <button
                id="jaxa-credit-close-btn"
                type="button"
                aria-label="クレジットモーダルを閉じる"
                onClick={() =>
                  runViewTransition(
                    () => setShowCreditModal(false),
                    { focusTargetSelector: '#jaxa-credit-trigger-btn' }
                  )
                }
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2.5 text-slate-300 leading-relaxed">
              <p>
                本アプリケーションは、JAXA地球観測研究センター（EORC）の{' '}
                <strong className="text-sky-300">JAXA Earth API for JavaScript (v2.0.1 ESM)</strong>{' '}
                および <strong className="text-emerald-300">気象庁 高解像度降水ナウキャスト</strong>{' '}
                を組み合わせ、3D山岳地形上でリアルタイム雨雲と衛星確定値の両方を可視化しています。
              </p>

              <div className="rounded-xl bg-slate-950/80 border border-slate-800 p-3 space-y-1.5">
                <div className="font-semibold text-amber-300">
                  1. 全球数値地表モデル (JAXA AW3D30 DSM v3.2)
                </div>
                <p className="text-[11px] text-slate-400">
                  陸域観測技術衛星「だいち」(ALOS) PRISM による水平解像度約30mメッシュの全球標高データを Terrain RGB タイルへ変換し、3D起伏を描画しています。
                </p>
              </div>

              <div className="rounded-xl bg-slate-950/80 border border-slate-800 p-3 space-y-1.5">
                <div className="font-semibold text-emerald-300">
                  2. リアルタイム雨雲 (気象庁 高解像度降水ナウキャスト)
                </div>
                <p className="text-[11px] text-slate-400">
                  気象庁の気象レーダー・アメダス観測網による現在時刻（5分更新）までの過去2時間実況と、60分先までの降水短時間予測タイルをWeb Mercator空間で高速合成して表示します。
                </p>
              </div>

              <div className="rounded-xl bg-slate-950/80 border border-slate-800 p-3 space-y-1.5">
                <div className="font-semibold text-sky-300">
                  3. 衛星全球降水マップ (JAXA GSMaP Hourly Gauge v6)
                </div>
                <p className="text-[11px] text-slate-400">
                  GPM主衛星・コンステレーション衛星と世界中の地上雨量計（Gauge）を統合補正した高精度1時間降水強度（mm/h）データです（雨量計補正のため観測から約3日後に公開）。
                </p>
              </div>

              <div className="rounded-xl bg-slate-950/80 border border-slate-800 p-3 space-y-1.5">
                <div className="font-semibold text-slate-200">
                  4. 背景地図タイル・3D描画エンジン
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
                  <a
                    href="https://www.openstreetmap.org/copyright"
                    target="_blank"
                    rel="noreferrer"
                    className="text-sky-400 hover:underline"
                  >
                    &copy; OpenStreetMap contributors
                  </a>
                  <a
                    href="https://maps.gsi.go.jp/development/ichiran.html"
                    target="_blank"
                    rel="noreferrer"
                    className="text-sky-400 hover:underline"
                  >
                    国土地理院 地理院タイル
                  </a>
                  <span>Tiles &copy; Esri / Maxar</span>
                  <a
                    href="https://maplibre.org/"
                    target="_blank"
                    rel="noreferrer"
                    className="text-sky-400 hover:underline"
                  >
                    MapLibre GL JS
                  </a>
                </div>
              </div>
            </div>

            <div className="pt-2 border-t border-slate-800 flex items-center justify-between">
              <a
                href="https://data.earth.jaxa.jp/"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-sky-400 hover:underline"
              >
                <span>JAXA Earth API 公式ポータル</span>
                <ExternalLink className="w-3 h-3" />
              </a>
              <button
                type="button"
                onClick={() =>
                  runViewTransition(
                    () => setShowCreditModal(false),
                    { focusTargetSelector: '#jaxa-credit-trigger-btn' }
                  )
                }
                className="px-4 py-1.5 rounded-xl bg-sky-500 hover:bg-sky-400 text-white font-semibold cursor-pointer"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
