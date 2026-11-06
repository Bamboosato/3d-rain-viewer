import React, { useCallback, useEffect, useRef, useState } from 'react';
import type maplibregl from 'maplibre-gl';
import {
  Activity,
  CloudRain,
  Cpu,
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
import { PRESET_LOCATIONS } from './lib/maplibreHelper';
import {
  fetchGSMaPRainLayer,
  fetchGSMaPTimelineCatalog,
  formatDateToJST,
  type GSMaPRainLayerResult,
  inspectLocationValues,
  preloadCentralMountainElevation,
  setActiveRainLayerResult,
} from './lib/jaxaClient';
import {
  fetchJMANowcastCatalog,
  fetchJMANowcastRainLayer,
} from './lib/jmaNowcastClient';
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
  const [activePreset, setActivePreset] = useState<PresetLocation>(PRESET_LOCATIONS[0]);
  // 機能C-2: 標高強調デフォルト 1.5倍、雨雲透過度デフォルト 70% (0.7)
  const [exaggeration, setExaggeration] = useState<number>(1.5);
  const [rainOpacity, setRainOpacity] = useState<number>(0.7);
  const [baseMap, setBaseMap] = useState<BaseMapId>('osm');
  const [rainSource, setRainSource] = useState<RainSourceId>('jma-nowcast');

  const [timelineFrames, setTimelineFrames] = useState<TimelineFrameItem[]>([]);
  const [currentTimeIndex, setCurrentTimeIndex] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<1 | 2>(1);
  const [cachedCount, setCachedCount] = useState<number>(0);

  const [rainLayerData, setRainLayerData] = useState<GSMaPRainLayerResult | null>(null);
  const [isLoadingRain, setIsLoadingRain] = useState<boolean>(true);
  const [activePresetRain, setActivePresetRain] = useState<number | null>(null);

  const [inspectedPoint, setInspectedPoint] = useState<InspectorPoint | null>(null);
  const [showCreditModal, setShowCreditModal] = useState<boolean>(false);
  const [installPromptEvent, setInstallPromptEvent] = useState<
    (Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }) | null
  >(null);

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

  const [gpuStatus, setGpuStatus] = useState<WebGPUStatus>({
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

  const jmaCacheRef = useRef<Map<number, GSMaPRainLayerResult>>(new Map());
  const gsmapCacheRef = useRef<Map<number, GSMaPRainLayerResult>>(new Map());
  const inFlightRequestsRef = useRef<Map<string, Promise<GSMaPRainLayerResult>>>(new Map());

  const getCacheForSource = useCallback((source: RainSourceId) => {
    return source === 'jma-nowcast' ? jmaCacheRef.current : gsmapCacheRef.current;
  }, []);

  // 指定ソース・指定インデックスの雨雲フレームを取得（重複リクエスト抑止＆キャッシュ対応）
  const loadFrameAtIndex = useCallback(
    async (
      source: RainSourceId,
      index: number,
      framesList: TimelineFrameItem[],
      isForeground: boolean
    ): Promise<GSMaPRainLayerResult | null> => {
      const targetFrame = framesList[index];
      if (!targetFrame) return null;

      const cacheMap = getCacheForSource(source);
      const existing = cacheMap.get(index);
      if (existing) {
        if (isForeground) {
          setActiveRainLayerResult(existing);
        }
        return existing;
      }

      const reqKey = `${source}:${index}`;
      let pending = inFlightRequestsRef.current.get(reqKey);
      if (!pending) {
        const fetchPromise =
          source === 'jma-nowcast'
            ? fetchJMANowcastRainLayer(targetFrame)
            : fetchGSMaPRainLayer(targetFrame.date, isForeground);

        pending = fetchPromise.then((res) => {
          cacheMap.set(index, res);
          inFlightRequestsRef.current.delete(reqKey);
          setCachedCount(cacheMap.size);
          return res;
        });
        inFlightRequestsRef.current.set(reqKey, pending);
      }

      const result = await pending;
      if (isForeground) {
        setActiveRainLayerResult(result);
      }
      return result;
    },
    [getCacheForSource]
  );

  // 初回マウント時に AW3D30 標高インスペクター用データを事前ロード
  useEffect(() => {
    preloadCentralMountainElevation();
  }, []);

  // データソース ('jma-nowcast' ⇄ 'jaxa-gsmap') 切り替え・初期化＆バックグラウンドプリフェッチ
  useEffect(() => {
    let mounted = true;
    const activeSource = rainSource;

    const initSourceTimeline = async () => {
      try {
        setIsLoadingRain(true);
        let frames: TimelineFrameItem[] = [];
        let defaultIdx = 0;

        if (activeSource === 'jma-nowcast') {
          if (!jmaFramesCatalogRef.current) {
            jmaFramesCatalogRef.current = await fetchJMANowcastCatalog();
          }
          frames = jmaFramesCatalogRef.current.frames;
          defaultIdx = jmaFramesCatalogRef.current.defaultIndex;
        } else {
          if (!gsmapFramesCatalogRef.current) {
            const catalog = await fetchGSMaPTimelineCatalog();
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

        if (!mounted) return;

        const cacheMap = getCacheForSource(activeSource);
        setTimelineFrames(frames);
        setCurrentTimeIndex(defaultIdx);
        setCachedCount(cacheMap.size);

        const initialRain = await loadFrameAtIndex(activeSource, defaultIdx, frames, true);
        if (!mounted || !initialRain) return;

        setRainLayerData(initialRain);

        const [lng, lat] = activePreset.center;
        const inspected = inspectLocationValues(lng, lat);
        setActivePresetRain(inspected.precipitation ?? 0);
        setInspectedPoint((prev) =>
          prev
            ? {
                ...prev,
                precipitation: inspectLocationValues(prev.lng, prev.lat).precipitation ?? 0,
              }
            : null
        );
        setIsLoadingRain(false);

        // 全フレームをバックグラウンドで順次プリフェッチ（フリッカーレス高速再生用）
        for (let offset = 1; offset < frames.length; offset++) {
          if (!mounted) break;
          const idx = (defaultIdx + offset) % frames.length;
          if (!cacheMap.has(idx)) {
            try {
              await loadFrameAtIndex(activeSource, idx, frames, false);
            } catch {
              // 個別フレームのバックグラウンド取得失敗は無視
            }
          }
        }
      } catch (err) {
        console.error(`Failed to initialize rain source (${activeSource}):`, err);
        if (mounted) {
          setIsLoadingRain(false);
        }
      }
    };

    initSourceTimeline();
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rainSource, loadFrameAtIndex, getCacheForSource]);

  // 時系列インデックス変更時に該当時刻の雨雲データを即時反映
  const handleSelectTimeIndex = useCallback(
    async (index: number) => {
      setCurrentTimeIndex(index);
      if (timelineFrames.length === 0) return;

      const cacheMap = getCacheForSource(rainSource);
      const cached = cacheMap.get(index);
      if (cached) {
        setActiveRainLayerResult(cached);
        setRainLayerData(cached);
        setTimeout(() => {
          const [lng, lat] = activePreset.center;
          const val = inspectLocationValues(lng, lat);
          setActivePresetRain(val.precipitation ?? 0);
          setInspectedPoint((prev) =>
            prev
              ? {
                  ...prev,
                  precipitation: inspectLocationValues(prev.lng, prev.lat).precipitation ?? 0,
                }
              : null
          );
        }, 0);
        return;
      }

      try {
        setIsLoadingRain(true);
        const result = await loadFrameAtIndex(rainSource, index, timelineFrames, true);
        if (result) {
          setRainLayerData(result);
          const [lng, lat] = activePreset.center;
          const val = inspectLocationValues(lng, lat);
          setActivePresetRain(val.precipitation ?? 0);
          setInspectedPoint((prev) =>
            prev
              ? {
                  ...prev,
                  precipitation: inspectLocationValues(prev.lng, prev.lat).precipitation ?? 0,
                }
              : null
          );
        }
      } catch (err) {
        console.error('Failed to load rain frame:', err);
      } finally {
        setIsLoadingRain(false);
      }
    },
    [timelineFrames, rainSource, activePreset.center, getCacheForSource, loadFrameAtIndex]
  );

  // 雨雲データソース切り替えハンドラ (View Transitions API 連動)
  const handleChangeRainSource = useCallback(
    (nextSource: RainSourceId) => {
      if (nextSource === rainSource) return;
      runViewTransition(() => {
        setIsPlaying(false);
        setRainSource(nextSource);
      });
    },
    [rainSource]
  );

  // 機能A-2: タイムラプス自動コマ送り・ループ再生（1x: 1000ms / 2x: 500ms）
  useEffect(() => {
    if (!isPlaying || timelineFrames.length <= 1) return;

    const intervalMs = playbackSpeed === 2 ? 500 : 1000;
    const timer = window.setInterval(() => {
      const nextIdx = (currentTimeIndex + 1) % timelineFrames.length;
      handleSelectTimeIndex(nextIdx);
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [isPlaying, playbackSpeed, currentTimeIndex, timelineFrames.length, handleSelectTimeIndex]);

  // 山岳プリセット切替 (View Transitions API 連動)
  const handleSelectPreset = useCallback((preset: PresetLocation) => {
    const [lng, lat] = preset.center;
    const inspected = inspectLocationValues(lng, lat);

    runViewTransition(
      () => {
        setActivePreset(preset);
        setActivePresetRain(inspected.precipitation ?? 0);
      },
      { focusTargetSelector: '#preset-active-heading' }
    );
  }, []);

  // 機能B-3: 地図クリック時のインスペクターカード表示・移動 (View Transitions API 連動)
  const handleInspectPoint = useCallback((point: InspectorPoint) => {
    runViewTransition(() => {
      setInspectedPoint(point);
    });
  }, []);

  // GPS現在地へジャンプ
  const handleJumpToCurrentLocation = useCallback(() => {
    if (!navigator.geolocation || !mapInstanceRef.current) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { longitude, latitude } = pos.coords;
        mapInstanceRef.current?.flyTo({
          center: [longitude, latitude],
          zoom: 10.5,
          pitch: 60,
          bearing: 0,
          duration: 1800,
        });
        const inspected = inspectLocationValues(longitude, latitude);
        runViewTransition(() => {
          setInspectedPoint({
            lng: longitude,
            lat: latitude,
            elevation: inspected.elevation,
            precipitation: inspected.precipitation ?? 0,
          });
        });
      },
      (err) => {
        console.warn('Geolocation unavailable:', err);
      }
    );
  }, []);

  // モーダルオープン時の Escape キー対応 (a11y-debugging 準拠)
  useEffect(() => {
    if (!showCreditModal) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        runViewTransition(
          () => setShowCreditModal(false),
          { focusTargetSelector: '#jaxa-credit-trigger-btn' }
        );
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showCreditModal]);

  return (
    <div className="relative w-screen h-dvh overflow-hidden bg-slate-950 select-none">
      {/* メイン3D地図キャンバス (<div id="map" className="w-full h-full" /> を内包) */}
      <MapViewer
        activePreset={activePreset}
        exaggeration={exaggeration}
        rainOpacity={rainOpacity}
        baseMap={baseMap}
        rainLayerData={rainLayerData}
        inspectedPoint={inspectedPoint}
        onStatusChange={setGpuStatus}
        onInspectPoint={handleInspectPoint}
        mapInstanceRef={mapInstanceRef}
      />

      {/* 上部ヘッダーバー */}
      <header className="pointer-events-none absolute top-0 inset-x-0 z-20 flex items-center justify-between gap-2 px-3 sm:px-4 py-2.5 sm:py-3 bg-gradient-to-b from-slate-950/90 via-slate-950/45 to-transparent">
        <div className="pointer-events-auto flex items-center gap-2 min-w-0">
          <div className="flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-gradient-to-br from-sky-400 to-blue-600 shadow-lg shadow-sky-500/25 shrink-0">
            <CloudRain className="w-4 h-4 sm:w-5 sm:h-5 text-white" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-sm sm:text-base font-bold tracking-tight text-white truncate">
                3D RainScape
              </h1>
              <span className="hidden md:inline-flex text-[10px] font-mono uppercase px-2 py-0.5 rounded-full bg-sky-500/20 text-sky-300 border border-sky-400/30">
                JAXA AW3D30 × {rainSource === 'jma-nowcast' ? 'JMA Nowcast' : 'JAXA GSMaP'}
              </span>
            </div>
            <p className="text-[11px] text-slate-400 hidden sm:block">
              リアルタイム雨雲 (気象庁ナウキャスト / JAXA GSMaP) × 全球3D標高モデル (AW3D30) 立体地形ビューア
            </p>
          </div>
        </div>

        {/* 右上ステータス・操作ボタン群 */}
        <div className="pointer-events-auto flex items-center gap-1.5 sm:gap-2 shrink-0">
          <div
            title={gpuStatus.adapterInfo}
            className="hidden md:flex items-center gap-2 min-h-[38px] px-3 py-1.5 rounded-xl bg-slate-900/85 backdrop-blur-md border border-slate-700/80 text-xs font-mono"
          >
            <Cpu
              className={`w-3.5 h-3.5 ${
                gpuStatus.backend === 'webgpu' ? 'text-emerald-400' : 'text-amber-400'
              }`}
            />
            <span className="text-slate-200 font-semibold uppercase">
              {gpuStatus.backend === 'webgpu' ? 'WebGPU' : 'WebGL2'}
            </span>
            <span className="text-slate-600">|</span>
            <Activity className="w-3.5 h-3.5 text-sky-400" />
            <span className="text-sky-300 font-semibold">{gpuStatus.fps} FPS</span>
          </div>

          {installPromptEvent && (
            <button
              id="pwa-install-btn"
              type="button"
              onClick={handleInstallPwa}
              className="inline-flex items-center gap-1.5 min-h-[38px] px-3 py-1.5 rounded-xl bg-emerald-500/25 hover:bg-emerald-500/35 backdrop-blur-md border border-emerald-400/50 text-xs font-semibold text-emerald-200 transition-colors cursor-pointer"
            >
              <Download className="w-3.5 h-3.5 text-emerald-400" />
              <span>アプリ追加</span>
            </button>
          )}

          <button
            type="button"
            onClick={handleJumpToCurrentLocation}
            className="inline-flex items-center gap-1.5 min-h-[38px] px-3 py-1.5 rounded-xl bg-slate-900/85 hover:bg-slate-800 backdrop-blur-md border border-slate-700/80 text-xs text-slate-200 transition-colors cursor-pointer"
          >
            <LocateFixed className="w-3.5 h-3.5 text-sky-400" />
            <span className="hidden sm:inline">現在地</span>
          </button>

          <button
            id="jaxa-credit-trigger-btn"
            type="button"
            onClick={() =>
              runViewTransition(
                () => setShowCreditModal(true),
                { focusTargetSelector: '#jaxa-credit-close-btn' }
              )
            }
            className="inline-flex items-center gap-1.5 min-h-[38px] px-3 py-1.5 rounded-xl bg-slate-900/85 hover:bg-slate-800 backdrop-blur-md border border-slate-700/80 text-xs text-slate-200 transition-colors cursor-pointer"
          >
            <Info className="w-3.5 h-3.5 text-sky-400" />
            <span className="hidden sm:inline">データソース情報</span>
          </button>
        </div>
      </header>

      {/* 左上: 山岳プリセットボタン群 & アクティブ標高バッジ */}
      <div className="pointer-events-none absolute top-16 left-4 z-10 flex flex-col gap-3 max-w-[calc(100vw-2rem)]">
        <PresetNav
          presets={PRESET_LOCATIONS}
          activePreset={activePreset}
          activePresetRain={activePresetRain}
          onSelectPreset={handleSelectPreset}
        />
      </div>

      {/* クリック地点の近傍にフローティング表示される地点インスペクター (機能B: 単一インスタンスでView Transitions固有性を保証) */}
      <div className="pointer-events-none fixed inset-0 z-30">
        <Inspector
          point={inspectedPoint}
          onClose={() => runViewTransition(() => setInspectedPoint(null))}
        />
      </div>

      {/* 右上: 歯車アイコン展開式 レイヤー＆描画調整メニュー (機能C) */}
      <div className="pointer-events-none absolute top-16 right-4 z-20">
        <LayerMenu
          exaggeration={exaggeration}
          onChangeExaggeration={setExaggeration}
          rainOpacity={rainOpacity}
          onChangeRainOpacity={setRainOpacity}
          baseMap={baseMap}
          onChangeBaseMap={setBaseMap}
          rainSource={rainSource}
          onChangeRainSource={handleChangeRainSource}
        />
      </div>

      {/* 右下: 降雨強度 (mm/h) カラーバー凡例 */}
      <div className="pointer-events-none hidden sm:block absolute bottom-32 sm:bottom-6 right-4 z-10">
        <Legend
          maxPrecipitation={rainLayerData?.maxPrecipitation ?? 0}
          isLoading={isLoadingRain}
          rainSource={rainSource}
        />
      </div>

      {/* 下部中央: 時系列タイムラプスバー (機能A: リアルタイム気象庁ナウキャスト ⇄ JAXA GSMaP 24h) */}
      <div className="pointer-events-none absolute bottom-4 inset-x-4 sm:left-16 sm:right-64 z-20 flex justify-center">
        <TimelineBar
          rainSource={rainSource}
          onChangeRainSource={handleChangeRainSource}
          frames={timelineFrames}
          currentIndex={currentTimeIndex}
          onSelectIndex={handleSelectTimeIndex}
          isPlaying={isPlaying}
          onTogglePlay={() => setIsPlaying((prev) => !prev)}
          playbackSpeed={playbackSpeed}
          onToggleSpeed={() => setPlaybackSpeed((prev) => (prev === 1 ? 2 : 1))}
          observedDateJST={rainLayerData?.formattedDateJST ?? ''}
          isLoading={isLoadingRain}
          cachedCount={cachedCount}
        />
      </div>

      {/* データソース・ライセンス情報モーダル */}
      {showCreditModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="jaxa-credit-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-sm"
        >
          <div className="w-full max-w-lg rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl p-5 text-slate-100 text-xs space-y-3">
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
