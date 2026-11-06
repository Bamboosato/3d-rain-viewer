import React, { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
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

interface MapViewerProps {
  activePreset: PresetLocation;
  exaggeration: number;
  rainOpacity: number;
  baseMap: BaseMapId;
  rainLayerData: GSMaPRainLayerResult | null;
  inspectedPoint: InspectorPoint | null;
  onStatusChange: (status: WebGPUStatus) => void;
  onInspectPoint: (point: InspectorPoint) => void;
  mapInstanceRef?: React.MutableRefObject<maplibregl.Map | null>;
}

export const MapViewer: React.FC<MapViewerProps> = ({
  activePreset,
  exaggeration,
  rainOpacity,
  baseMap,
  rainLayerData,
  inspectedPoint,
  onStatusChange,
  onInspectPoint,
  mapInstanceRef,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const internalMapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const isMapLoadedRef = useRef<boolean>(false);
  const hasUserMovedOrSelectedRef = useRef<boolean>(false);
  const initialPresetIdRef = useRef<string>(activePreset.id);
  const latestRainOpacityRef = useRef<number>(rainOpacity);
  const latestExaggerationRef = useRef<number>(exaggeration);
  const onInspectPointRef = useRef(onInspectPoint);

  latestRainOpacityRef.current = rainOpacity;
  latestExaggerationRef.current = exaggeration;
  onInspectPointRef.current = onInspectPoint;

  // MapLibre GL JS 初期化 (WebGPU優先 + WebGL2自動フォールバック)
  useEffect(() => {
    if (!containerRef.current || internalMapRef.current) return;

    let disposed = false;
    let rafId = 0;
    let frameCount = 0;
    let lastFpsTime = performance.now();
    let resizeObserver: ResizeObserver | null = null;
    let backendStatus: Omit<WebGPUStatus, 'fps'> = {
      backend: 'webgpu',
      webgpuAvailable: true,
      adapterInfo: 'Initializing WebGPU...',
    };

    registerJaxaTerrainProtocol(256);

    let pendingInitialCenter: [number, number] | null = null;

    // 初期表示時: 位置情報が取得できる場合は現在位置を中心に表示する
    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (disposed || hasUserMovedOrSelectedRef.current) return;
          const coords: [number, number] = [pos.coords.longitude, pos.coords.latitude];
          pendingInitialCenter = coords;
          const existingMap = internalMapRef.current;
          if (existingMap) {
            existingMap.flyTo({
              center: coords,
              zoom: 10.5,
              pitch: 60,
              bearing: 0,
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

      // 地図クリック時に地点標高・雨量インスペクターを更新
      map.on('click', async (e) => {
        const { lng, lat } = e.lngLat;
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
          precipitation: inspected.precipitation ?? 0,
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
              precipitation: inspectLocationValues(lng, lat).precipitation ?? 0,
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
      cancelAnimationFrame(rafId);
      resizeObserver?.disconnect();
      isMapLoadedRef.current = false;
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

        map.addLayer({
          id: 'rain-layer',
          type: 'raster',
          source: 'rain-source',
          paint: {
            'raster-opacity': latestRainOpacityRef.current,
            'raster-resampling': 'linear',
            'raster-fade-duration': 0,
          },
        });
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
  }, [rainLayerData]);

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
    <div className="relative w-full h-full">
      <div id="map" ref={containerRef} className="w-full h-full" />
    </div>
  );
};
