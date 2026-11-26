import React, { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Loader2 } from 'lucide-react';
import type {
  BaseMapId,
  InspectorPoint,
  PresetLocation,
  WebGPUStatus,
} from '../types/map';
import {
  createMapInstance,
  initGraphicsBackend,
  registerJaxaTerrainProtocol,
} from '../lib/maplibreHelper';
import {
  fetchPointElevationFromAW3D,
  type GSMaPRainLayerResult,
  inspectLocationValues,
  JAPAN_RAIN_COORDINATES,
} from '../lib/jaxaClient';
import { createCategorySvgString, getFavoriteCategoryMeta } from '../lib/favoriteCategories';
import {
  interpolateRoutePositionAtTime,
  type RouteWeatherAnalysis,
} from '../lib/routeWeatherAnalyzer';
import type { RouteProfile } from '../lib/orsClient';
import type { RouteEndpoint } from './RoutePlanner';

function createTravelIconSvg(profile: RouteProfile): string {
  if (profile === 'driving-car') {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/></svg>';
  }
  if (profile === 'cycling-regular') {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/></svg>';
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z"/><path d="M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z"/><path d="M16 17h4"/><path d="M4 13h4"/></svg>';
}

interface MapViewerProps {
  activePreset: PresetLocation;
  favorites?: PresetLocation[];
  exaggeration: number;
  rainOpacity: number;
  baseMap: BaseMapId;
  rainLayerData: GSMaPRainLayerResult | null;
  inspectedPoint: InspectorPoint | null;
  skipInitialGeolocation?: boolean;
  onStatusChange: (status: WebGPUStatus) => void;
  onInspectPoint: (point: InspectorPoint) => void;
  onSelectFavorite?: (preset: PresetLocation) => void;
  onCameraChange?: (view: {
    lat: number;
    lng: number;
    zoom: number;
    pitch: number;
    bearing: number;
  }) => void;
  mapInstanceRef?: React.MutableRefObject<maplibregl.Map | null>;
  routeAnalysis?: RouteWeatherAnalysis | null;
  routeOrigin?: RouteEndpoint | null;
  routeDestination?: RouteEndpoint | null;
  routePickMode?: 'origin' | 'destination' | null;
  onPickRoutePoint?: (point: { lng: number; lat: number }) => void;
  timelineCurrentTime?: Date | null;
  timelineNextTime?: Date | null;
  isTimelinePlaying?: boolean;
  isRainLoading?: boolean;
  timelineIntervalMs?: number;
}

export const MapViewer: React.FC<MapViewerProps> = ({
  activePreset,
  favorites = [],
  exaggeration,
  rainOpacity,
  baseMap,
  rainLayerData,
  inspectedPoint,
  skipInitialGeolocation = false,
  onStatusChange,
  onInspectPoint,
  onSelectFavorite,
  onCameraChange,
  mapInstanceRef,
  routeAnalysis = null,
  routeOrigin = null,
  routeDestination = null,
  routePickMode = null,
  onPickRoutePoint,
  timelineCurrentTime = null,
  timelineNextTime = null,
  isTimelinePlaying = false,
  isRainLoading = false,
  timelineIntervalMs = 1000,
}) => {
  const [isTilesLoading, setIsTilesLoading] = useState<boolean>(true);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const internalMapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const favoriteMarkersRef = useRef<maplibregl.Marker[]>([]);
  const routeMarkersRef = useRef<maplibregl.Marker[]>([]);
  const travelMarkerRef = useRef<maplibregl.Marker | null>(null);
  const travelMarkerNodesRef = useRef<{
    root: HTMLDivElement;
    badge: HTMLDivElement;
    pill: HTMLSpanElement;
    profile: RouteProfile;
  } | null>(null);
  const isMapLoadedRef = useRef<boolean>(false);
  const hasUserMovedOrSelectedRef = useRef<boolean>(skipInitialGeolocation);
  const initialPresetIdRef = useRef<string>(activePreset.id);
  const latestRainOpacityRef = useRef<number>(rainOpacity);
  const latestExaggerationRef = useRef<number>(exaggeration);
  const latestFavoritesRef = useRef<PresetLocation[]>(favorites);
  const onInspectPointRef = useRef(onInspectPoint);
  const onSelectFavoriteRef = useRef(onSelectFavorite);
  const onCameraChangeRef = useRef(onCameraChange);
  const routePickModeRef = useRef<'origin' | 'destination' | null>(routePickMode);
  const onPickRoutePointRef = useRef(onPickRoutePoint);

  latestRainOpacityRef.current = rainOpacity;
  latestExaggerationRef.current = exaggeration;
  latestFavoritesRef.current = favorites;
  onInspectPointRef.current = onInspectPoint;
  onSelectFavoriteRef.current = onSelectFavorite;
  onCameraChangeRef.current = onCameraChange;
  routePickModeRef.current = routePickMode;
  onPickRoutePointRef.current = onPickRoutePoint;

  const renderFavoriteMarkers = (map: maplibregl.Map, favList: PresetLocation[]) => {
    for (const m of favoriteMarkersRef.current) {
      m.remove();
    }
    favoriteMarkersRef.current = [];

    for (const fav of favList) {
      const catMeta = getFavoriteCategoryMeta(fav.category);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `fav-map-marker fav-cat-${catMeta.id}`;
      btn.title = `${catMeta.emoji} ${fav.name}（${catMeta.label} · クリックして視点・インスペクターを表示）`;
      btn.setAttribute('aria-label', `お気に入り地点: ${fav.name}（${catMeta.label}）`);

      const badge = document.createElement('span');
      badge.className = 'fav-map-icon-badge';
      badge.innerHTML = createCategorySvgString(catMeta.id, 13);

      const label = document.createElement('span');
      label.className = 'fav-map-label';
      label.textContent = fav.name;

      btn.appendChild(badge);
      btn.appendChild(label);

      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        onSelectFavoriteRef.current?.(fav);
      });

      const marker = new maplibregl.Marker({ element: btn, anchor: 'center' })
        .setLngLat(fav.center)
        .addTo(map);
      favoriteMarkersRef.current.push(marker);
    }
  };

  // MapLibre GL JS 初期化 (WebGPU優先 + WebGL2自動フォールバック)
  useEffect(() => {
    if (!containerRef.current || internalMapRef.current) return;

    let disposed = false;
    let rafId = 0;
    let frameCount = 0;
    let lastFpsTime = performance.now();
    let resizeObserver: ResizeObserver | null = null;
    let clearTileLoadingTimeout = () => {};
    let clearMoveEndSettleTimer = () => {};
    let backendStatus: Omit<WebGPUStatus, 'fps'> = {
      backend: 'webgpu',
      webgpuAvailable: true,
      adapterInfo: 'Initializing WebGPU...',
    };

    registerJaxaTerrainProtocol(256);

    let pendingInitialCenter: [number, number] | null = null;

    // 初期表示時: URLパラメータによる視点指定がなく、位置情報が取得できる場合は現在位置を中心に表示する
    if (!skipInitialGeolocation && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (disposed || hasUserMovedOrSelectedRef.current) return;
          const coords: [number, number] = [pos.coords.longitude, pos.coords.latitude];
          pendingInitialCenter = coords;
          const existingMap = internalMapRef.current;
          if (existingMap) {
            existingMap.flyTo({
              center: coords,
              duration: 1400,
              essential: true,
            });
          }
        },
        () => {
          // 位置情報が不許可・タイムアウトの場合はフォールバック（初期プリセット）を維持
        },
        {
          enableHighAccuracy: false,
          timeout: 6000,
          maximumAge: 300000,
        }
      );
    }

    const setup = async () => {
      backendStatus = await initGraphicsBackend();
      if (disposed || !containerRef.current) return;

      const initialPresetForMap: PresetLocation = pendingInitialCenter
        ? {
            ...activePreset,
            center: pendingInitialCenter,
            zoom: 10.5,
            pitch: 60,
            bearing: 0,
          }
        : activePreset;

      const map = createMapInstance(
        containerRef.current,
        initialPresetForMap,
        backendStatus.backend
      );
      internalMapRef.current = map;
      if (mapInstanceRef) {
        mapInstanceRef.current = map;
      }

      const updateFavZoomMode = () => {
        if (!containerRef.current) return;
        const nextMode = map.getZoom() >= 9 ? 'detail' : 'wide';
        if (containerRef.current.dataset.favMode !== nextMode) {
          containerRef.current.dataset.favMode = nextMode;
        }
      };
      updateFavZoomMode();
      map.on('zoom', updateFavZoomMode);

      // カメラ移動完了時に現在の3D視点パラメータを通知（URL同期用）
      const emitCameraView = () => {
        if (disposed) return;
        const center = map.getCenter();
        onCameraChangeRef.current?.({
          lat: center.lat,
          lng: center.lng,
          zoom: map.getZoom(),
          pitch: map.getPitch(),
          bearing: map.getBearing(),
        });
      };
      // 地図・地形タイルの読み込み状態追跡（シンプルなローディングスピナー用）
      let tileLoadingTimeout: ReturnType<typeof setTimeout> | null = null;
      let moveEndSettleTimer: ReturnType<typeof setTimeout> | null = null;

      clearTileLoadingTimeout = () => {
        if (tileLoadingTimeout !== null) {
          clearTimeout(tileLoadingTimeout);
          tileLoadingTimeout = null;
        }
      };

      clearMoveEndSettleTimer = () => {
        if (moveEndSettleTimer !== null) {
          clearTimeout(moveEndSettleTimer);
          moveEndSettleTimer = null;
        }
      };

      // カメラ移動完了時に現在の3D視点パラメータを通知（URL同期用）およびパン・ドラッグ後のスピナー停止判定
      const handleMoveEnd = () => {
        if (disposed) return;
        emitCameraView();

        // 画面ドラッグ・スクロール操作終了後、画面内タイルが揃った時点で速やかにスピナーを停止
        clearMoveEndSettleTimer();
        let retries = 4;
        const checkSettle = () => {
          if (disposed) return;
          if (map.areTilesLoaded() || retries <= 0) {
            clearTileLoadingTimeout();
            setIsTilesLoading(false);
          } else {
            retries -= 1;
            moveEndSettleTimer = setTimeout(checkSettle, 200);
          }
        };
        moveEndSettleTimer = setTimeout(checkSettle, 250);
      };
      map.on('moveend', handleMoveEnd);

      const handleDataLoading = (e: maplibregl.MapEventType['dataloading']) => {
        if (disposed) return;
        if (e.dataType === 'source') {
          setIsTilesLoading(true);
          clearTileLoadingTimeout();
          // iOS WebKit 等で idle イベントが遅延・欠落した場合も最大 2.5 秒でスピナーを安全に解除
          tileLoadingTimeout = setTimeout(() => {
            if (!disposed) {
              setIsTilesLoading(false);
            }
          }, 2500);
        }
      };
      const handleIdle = () => {
        if (disposed) return;
        clearTileLoadingTimeout();
        clearMoveEndSettleTimer();
        setIsTilesLoading(false);
      };

      map.on('dataloading', handleDataLoading);
      map.on('idle', handleIdle);
      map.on('error', () => {
        if (disposed) return;
        if (map.areTilesLoaded()) {
          clearTileLoadingTimeout();
          clearMoveEndSettleTimer();
          setIsTilesLoading(false);
        }
      });

      renderFavoriteMarkers(map, latestFavoritesRef.current);

      if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
        resizeObserver = new ResizeObserver(() => {
          if (!disposed) {
            map.resize();
          }
        });
        resizeObserver.observe(containerRef.current);
      }

      map.on('dragstart', () => {
        hasUserMovedOrSelectedRef.current = true;
      });

      map.addControl(
        new maplibregl.NavigationControl({
          visualizePitch: true,
          showZoom: true,
          showCompass: true,
        }),
        'bottom-left'
      );

      map.addControl(
        new maplibregl.ScaleControl({ maxWidth: 100, unit: 'metric' }),
        'bottom-left'
      );

      map.on('load', () => {
        if (disposed) return;
        isMapLoadedRef.current = true;
        setMapReady(true);

        // JAXA AW3D30 Terrain RGB ソースの追加
        if (!map.getSource('terrain')) {
          map.addSource('terrain', {
            type: 'raster-dem',
            tiles: ['jaxa-aw3d://{z}/{x}/{y}'],
            tileSize: 256,
            maxzoom: 11,
            encoding: 'mapbox',
            attribution:
              '<a href="https://data.earth.jaxa.jp/" target="_blank" rel="noreferrer">JAXA Earth API (AW3D30 / GSMaP)</a>',
          });
        }

        // 3D起伏を有効化 (source: 'terrain', exaggeration: 1.5)
        map.setTerrain({
          source: 'terrain',
          exaggeration: latestExaggerationRef.current,
        });

        // 地形陰影レイヤー (Hillshade) を重ねて山岳の立体感を強調
        if (!map.getLayer('terrain-hillshade')) {
          map.addLayer({
            id: 'terrain-hillshade',
            type: 'hillshade',
            source: 'terrain',
            paint: {
              'hillshade-exaggeration': 0.45,
              'hillshade-shadow-color': '#020617',
              'hillshade-highlight-color': '#f8fafc',
              'hillshade-accent-color': '#334155',
            },
          });
        }
      });

      // 地図クリック時に地点標高・雨量インスペクターを更新（ルート地点選択モード時はルート地点を確定）
      map.on('click', async (e) => {
        const { lng, lat } = e.lngLat;
        if (routePickModeRef.current) {
          onPickRoutePointRef.current?.({ lng, lat });
          return;
        }
        const { x: screenX, y: screenY } = e.point;
        const inspected = inspectLocationValues(lng, lat);
        let terrainElev = inspected.elevation;

        if (terrainElev === null && map.getTerrain()) {
          const queried = map.queryTerrainElevation(e.lngLat);
          if (queried !== null && Number.isFinite(queried)) {
            terrainElev = Math.round(queried);
          }
        }

        onInspectPointRef.current({
          lng,
          lat,
          elevation: terrainElev,
          precipitation: inspected.precipitation,
          screenX,
          screenY,
        });

        // 事前キャッシュ範囲外の場合はAW3D30から非同期で標高を補完
        if (terrainElev === null) {
          const fetchedElev = await fetchPointElevationFromAW3D(lng, lat);
          if (fetchedElev !== null && !disposed) {
            onInspectPointRef.current({
              lng,
              lat,
              elevation: fetchedElev,
              precipitation: inspectLocationValues(lng, lat).precipitation,
              screenX,
              screenY,
            });
          }
        }
      });

      // リアルタイムFPS計測ループ
      const measureFps = (now: number) => {
        if (disposed) return;
        frameCount++;
        const elapsed = now - lastFpsTime;
        if (elapsed >= 1000) {
          const currentFps = Math.min(120, Math.round((frameCount * 1000) / elapsed));
          onStatusChange({
            ...backendStatus,
            fps: currentFps,
          });
          frameCount = 0;
          lastFpsTime = now;
        }
        rafId = requestAnimationFrame(measureFps);
      };
      rafId = requestAnimationFrame(measureFps);
    };

    setup();

    return () => {
      disposed = true;
      clearTileLoadingTimeout();
      clearMoveEndSettleTimer();
      cancelAnimationFrame(rafId);
      resizeObserver?.disconnect();
      isMapLoadedRef.current = false;
      for (const m of favoriteMarkersRef.current) {
        m.remove();
      }
      favoriteMarkersRef.current = [];
      for (const m of routeMarkersRef.current) {
        m.remove();
      }
      routeMarkersRef.current = [];
      if (travelMarkerRef.current) {
        travelMarkerRef.current.remove();
        travelMarkerRef.current = null;
      }
      travelMarkerNodesRef.current = null;
      if (markerRef.current) {
        markerRef.current.remove();
        markerRef.current = null;
      }
      if (internalMapRef.current) {
        internalMapRef.current.remove();
        internalMapRef.current = null;
      }
      if (mapInstanceRef) {
        mapInstanceRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // GSMaP 降水ラスタレイヤー ('rain-layer') の追加・フリッカーレス更新
  useEffect(() => {
    const map = internalMapRef.current;
    if (!map || !rainLayerData) return;

    const applyRainLayer = () => {
      if (!map.getSource('rain-source')) {
        map.addSource('rain-source', {
          type: 'image',
          url: rainLayerData.imageUrl,
          coordinates: rainLayerData.coordinates ?? JAPAN_RAIN_COORDINATES,
        });

        const beforeId = map.getLayer('route-weather-casing')
          ? 'route-weather-casing'
          : undefined;
        map.addLayer(
          {
            id: 'rain-layer',
            type: 'raster',
            source: 'rain-source',
            paint: {
              'raster-opacity': latestRainOpacityRef.current,
              'raster-resampling': 'linear',
              'raster-fade-duration': 0,
            },
          },
          beforeId
        );
      } else {
        const imgSource = map.getSource('rain-source') as maplibregl.ImageSource | undefined;
        imgSource?.updateImage({
          url: rainLayerData.imageUrl,
          coordinates: rainLayerData.coordinates ?? JAPAN_RAIN_COORDINATES,
        });
      }
    };

    if (isMapLoadedRef.current) {
      applyRainLayer();
    } else {
      map.once('load', applyRainLayer);
    }
    return () => { map.off('load', applyRainLayer); };
  }, [rainLayerData, mapReady]);

  // クリック地点の3Dピンマーカー表示更新
  useEffect(() => {
    const map = internalMapRef.current;
    if (!map) return;

    if (!inspectedPoint) {
      if (markerRef.current) {
        markerRef.current.remove();
        markerRef.current = null;
      }
      return;
    }

    if (!markerRef.current) {
      const el = document.createElement('div');
      el.className = 'w-5 h-5 rounded-full bg-sky-400/90 border-2 border-white shadow-lg flex items-center justify-center pointer-events-none';
      const pulse = document.createElement('div');
      pulse.className = 'w-full h-full rounded-full bg-sky-400 animate-ping opacity-75';
      el.appendChild(pulse);
      markerRef.current = new maplibregl.Marker({ element: el })
        .setLngLat([inspectedPoint.lng, inspectedPoint.lat])
        .addTo(map);
    } else {
      markerRef.current.setLngLat([inspectedPoint.lng, inspectedPoint.lat]);
    }
  }, [inspectedPoint]);

  // お気に入り地点の地図上「★」マーカー同期（広域=★のみ / 拡大=★＋地点名）
  useEffect(() => {
    const map = internalMapRef.current;
    if (!map) return;
    renderFavoriteMarkers(map, favorites);
  }, [favorites]);

  // ルート地点選択モード中のカーソル切替
  useEffect(() => {
    const map = internalMapRef.current;
    const canvas = map?.getCanvas?.();
    if (canvas?.style) {
      canvas.style.cursor = routePickMode ? 'crosshair' : '';
    }
  }, [routePickMode, mapReady]);

  // ルート色分けGeoJSONレイヤーの追加・更新・削除
  useEffect(() => {
    const map = internalMapRef.current;
    if (!map) return;

    const ROUTE_LAYER_IDS = [
      'route-weather-line-dashed',
      'route-weather-line',
      'route-weather-casing',
    ] as const;

    const removeRouteLayers = () => {
      for (const id of ROUTE_LAYER_IDS) {
        if (map.getLayer?.(id)) {
          map.removeLayer?.(id);
        }
      }
      if (map.getSource?.('route-weather-source')) {
        map.removeSource?.('route-weather-source');
      }
    };

    const applyRouteLayers = () => {
      if (!routeAnalysis) {
        removeRouteLayers();
        return;
      }

      const existingSource = map.getSource?.('route-weather-source') as
        | maplibregl.GeoJSONSource
        | undefined;

      if (existingSource && typeof existingSource.setData === 'function') {
        existingSource.setData(routeAnalysis.geojson as GeoJSON.GeoJSON);
      } else {
        map.addSource?.('route-weather-source', {
          type: 'geojson',
          data: routeAnalysis.geojson as GeoJSON.GeoJSON,
        });
      }

      if (!map.getLayer?.('route-weather-casing')) {
        map.addLayer?.({
          id: 'route-weather-casing',
          type: 'line',
          source: 'route-weather-source',
          layout: {
            'line-join': 'round',
            'line-cap': 'round',
          },
          paint: {
            'line-color': '#0f172a',
            'line-width': 8,
            'line-opacity': 0.85,
          },
        });
      }

      if (!map.getLayer?.('route-weather-line')) {
        map.addLayer?.({
          id: 'route-weather-line',
          type: 'line',
          source: 'route-weather-source',
          filter: ['!', ['get', 'isDashed']],
          layout: {
            'line-join': 'round',
            'line-cap': 'round',
          },
          paint: {
            'line-color': ['get', 'color'],
            'line-width': 4.5,
            'line-opacity': 0.95,
          },
        });
      }

      if (!map.getLayer?.('route-weather-line-dashed')) {
        map.addLayer?.({
          id: 'route-weather-line-dashed',
          type: 'line',
          source: 'route-weather-source',
          filter: ['==', ['get', 'isDashed'], true],
          layout: {
            'line-join': 'round',
            'line-cap': 'round',
          },
          paint: {
            'line-color': ['get', 'color'],
            'line-width': 4,
            'line-opacity': 0.85,
            'line-dasharray': [2, 2],
          },
        });
      }

      if (map.getLayer?.('rain-layer') && typeof map.moveLayer === 'function') {
        for (const id of [
          'route-weather-casing',
          'route-weather-line',
          'route-weather-line-dashed',
        ]) {
          if (map.getLayer?.(id)) {
            map.moveLayer(id);
          }
        }
      }

      const [minLng, minLat, maxLng, maxLat] = routeAnalysis.route.bbox;
      if (
        Number.isFinite(minLng) &&
        Number.isFinite(minLat) &&
        Number.isFinite(maxLng) &&
        Number.isFinite(maxLat)
      ) {
        map.fitBounds?.(
          [
            [minLng, minLat],
            [maxLng, maxLat],
          ],
          {
            padding: { top: 96, bottom: 130, left: 48, right: 48 },
            maxZoom: 14,
            duration: 1000,
          }
        );
      }
    };

    if (isMapLoadedRef.current) {
      applyRouteLayers();
    } else {
      map.once('load', applyRouteLayers);
    }
    return () => {
      map.off('load', applyRouteLayers);
    };
  }, [routeAnalysis, mapReady]);

  // ルート出発地 (S) / 目的地 (G) マーカー表示
  useEffect(() => {
    const map = internalMapRef.current;
    if (!map) return;

    for (const m of routeMarkersRef.current) {
      m.remove();
    }
    routeMarkersRef.current = [];

    if (!routeOrigin && !routeDestination) return;

    const MarkerCtor = Object.getOwnPropertyDescriptor(maplibregl, 'Marker')?.value as
      | typeof maplibregl.Marker
      | undefined;
    if (typeof MarkerCtor !== 'function') return;

    const endpoints: Array<{
      point: RouteEndpoint | null;
      badge: string;
      classes: string;
    }> = [
      {
        point: routeOrigin,
        badge: 'S',
        classes:
          'w-7 h-7 rounded-full bg-emerald-500 border-2 border-white text-slate-950 font-bold text-xs shadow-lg flex items-center justify-center pointer-events-none',
      },
      {
        point: routeDestination,
        badge: 'G',
        classes:
          'w-7 h-7 rounded-full bg-rose-500 border-2 border-white text-white font-bold text-xs shadow-lg flex items-center justify-center pointer-events-none',
      },
    ];

    for (const ep of endpoints) {
      if (!ep.point) continue;
      const el = document.createElement('div');
      el.className = ep.classes;
      el.textContent = ep.badge;
      const marker = new MarkerCtor({ element: el, anchor: 'center' })
        .setLngLat([ep.point.lng, ep.point.lat])
        .addTo(map);
      routeMarkersRef.current.push(marker);
    }
  }, [routeOrigin, routeDestination, mapReady]);

  // タイムライン連動：ルート上の移動アイコン（再生中はコマ間を rAF で滑らか補間）
  useEffect(() => {
    const map = internalMapRef.current;

    const removeTravelMarker = () => {
      if (travelMarkerRef.current) {
        travelMarkerRef.current.remove();
        travelMarkerRef.current = null;
      }
      travelMarkerNodesRef.current = null;
    };

    if (!map || !routeAnalysis || !timelineCurrentTime) {
      removeTravelMarker();
      return;
    }

    const MarkerCtor = Object.getOwnPropertyDescriptor(maplibregl, 'Marker')?.value as
      | typeof maplibregl.Marker
      | undefined;
    if (typeof MarkerCtor !== 'function') {
      removeTravelMarker();
      return;
    }

    const profile = routeAnalysis.route.profile;
    if (!travelMarkerRef.current || travelMarkerNodesRef.current?.profile !== profile) {
      removeTravelMarker();

      const root = document.createElement('div');
      root.dataset.testid = 'route-travel-marker';
      root.dataset.profile = profile;
      root.setAttribute('aria-label', 'ルート上の現在予定位置');
      root.className = 'pointer-events-none flex flex-col items-center gap-0.5 select-none';

      const pill = document.createElement('span');
      pill.className =
        'px-1.5 py-0.5 rounded-full bg-slate-950/90 border border-slate-600/80 text-[9px] font-bold text-slate-100 whitespace-nowrap shadow';

      const badge = document.createElement('div');
      badge.className =
        'w-8 h-8 rounded-full bg-sky-500 border-2 border-white text-white shadow-xl flex items-center justify-center';
      badge.innerHTML = createTravelIconSvg(profile);

      root.appendChild(pill);
      root.appendChild(badge);

      const initialPos = interpolateRoutePositionAtTime(routeAnalysis, timelineCurrentTime);
      if (!initialPos) {
        return;
      }

      const marker = new MarkerCtor({ element: root, anchor: 'center' })
        .setLngLat([initialPos.lng, initialPos.lat])
        .addTo(map);
      travelMarkerRef.current = marker;
      travelMarkerNodesRef.current = { root, badge, pill, profile };
    }

    const applyPosition = (time: Date) => {
      const marker = travelMarkerRef.current;
      const nodes = travelMarkerNodesRef.current;
      if (!marker || !nodes) return;
      const pos = interpolateRoutePositionAtTime(routeAnalysis, time);
      if (!pos) return;

      marker.setLngLat([pos.lng, pos.lat]);
      nodes.root.dataset.phase = pos.phase;

      if (pos.phase === 'before-departure') {
        nodes.root.style.opacity = '0.72';
        nodes.pill.textContent = '出発前';
        nodes.pill.style.display = '';
        nodes.badge.className =
          'w-8 h-8 rounded-full bg-slate-700 border-2 border-white/80 text-slate-100 shadow-lg flex items-center justify-center';
      } else if (pos.phase === 'arrived') {
        nodes.root.style.opacity = '1';
        nodes.pill.textContent = '到着';
        nodes.pill.style.display = '';
        nodes.badge.className =
          'w-8 h-8 rounded-full bg-rose-500 border-2 border-white text-white shadow-xl flex items-center justify-center';
      } else {
        nodes.root.style.opacity = '1';
        nodes.pill.textContent = '';
        nodes.pill.style.display = 'none';
        nodes.badge.className =
          'w-8 h-8 rounded-full bg-sky-500 border-2 border-white text-white shadow-xl ring-4 ring-sky-400/35 flex items-center justify-center';
      }
    };

    applyPosition(timelineCurrentTime);

    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let rafId = 0;
    let active = true;

    if (
      isTimelinePlaying &&
      !isRainLoading &&
      timelineNextTime &&
      timelineNextTime.getTime() > timelineCurrentTime.getTime() &&
      !prefersReducedMotion
    ) {
      const startMs = performance.now();
      const fromMs = timelineCurrentTime.getTime();
      const toMs = timelineNextTime.getTime();
      const durationMs = Math.max(100, timelineIntervalMs);

      const tick = (now: number) => {
        if (!active) return;
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
          return;
        }
        const progress = Math.min(1, Math.max(0, (now - startMs) / durationMs));
        applyPosition(new Date(fromMs + (toMs - fromMs) * progress));
        if (progress < 1) {
          rafId = requestAnimationFrame(tick);
        }
      };

      rafId = requestAnimationFrame(tick);
    }

    return () => {
      active = false;
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [
    routeAnalysis,
    timelineCurrentTime,
    timelineNextTime,
    isTimelinePlaying,
    isRainLoading,
    timelineIntervalMs,
    mapReady,
  ]);

  // プリセット変更時のスムーズな3Dカメラフライ移動
  useEffect(() => {
    if (activePreset.id !== initialPresetIdRef.current) {
      hasUserMovedOrSelectedRef.current = true;
    }
    const map = internalMapRef.current;
    if (!map || !isMapLoadedRef.current) return;

    map.flyTo({
      center: activePreset.center,
      zoom: activePreset.zoom,
      pitch: activePreset.pitch,
      bearing: activePreset.bearing,
      duration: 1800,
      essential: true,
    });
  }, [activePreset]);

  // 標高強調 (Exaggeration) の即時変更: map.setTerrain({ source: 'terrain', exaggeration: val })
  useEffect(() => {
    const map = internalMapRef.current;
    if (!map || !isMapLoadedRef.current) return;
    if (map.getSource('terrain')) {
      map.setTerrain({
        source: 'terrain',
        exaggeration,
      });
    }
  }, [exaggeration]);

  // 雨雲透過度 (Opacity) の即時変更: map.setPaintProperty('rain-layer', 'raster-opacity', val)
  useEffect(() => {
    const map = internalMapRef.current;
    if (!map || !isMapLoadedRef.current) return;
    if (map.getLayer('rain-layer')) {
      map.setPaintProperty('rain-layer', 'raster-opacity', rainOpacity);
    }
  }, [rainOpacity]);

  // 背景地図レイヤー切り替え (OSM標準 / 起伏陰影 / 航空写真)
  useEffect(() => {
    const map = internalMapRef.current;
    if (!map || !isMapLoadedRef.current) return;

    const layers: Array<{ id: string; key: BaseMapId }> = [
      { id: 'base-osm', key: 'osm' },
      { id: 'base-hillshade', key: 'hillshade' },
      { id: 'base-photo', key: 'photo' },
    ];
    for (const item of layers) {
      if (map.getLayer(item.id)) {
        map.setLayoutProperty(
          item.id,
          'visibility',
          item.key === baseMap ? 'visible' : 'none'
        );
      }
    }
    if (map.getLayer('terrain-hillshade')) {
      map.setPaintProperty(
        'terrain-hillshade',
        'hillshade-exaggeration',
        baseMap === 'hillshade' ? 0.85 : 0.45
      );
    }
  }, [baseMap]);

  return (
    <div className="relative z-0 isolate w-full h-full">
      <div id="map" ref={containerRef} className="w-full h-full" />

      {/* 地図・3D地形タイルの読み込み中を示すシンプルなインジケーター（スピナー） */}
      {isTilesLoading && (
        <div
          role="status"
          aria-label="地図・3D地形タイル読み込み中"
          className="pointer-events-none absolute left-3 z-10 flex items-center justify-center p-1.5 rounded-full bg-slate-900/80 backdrop-blur-md border border-slate-700/70 shadow-lg text-sky-400 animate-in fade-in duration-200"
          style={{
            bottom: 'calc(var(--safe-bottom) * 0.6 + 108px)',
          }}
        >
          <Loader2 className="w-4 h-4 animate-spin" />
        </div>
      )}
    </div>
  );
};
