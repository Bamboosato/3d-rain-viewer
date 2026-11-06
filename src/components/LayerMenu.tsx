import React, { useState } from 'react';
import { Settings, Mountain, Eye, Layers, ChevronUp, Radio, Satellite } from 'lucide-react';
import type { BaseMapId, RainSourceId } from '../types/map';
import { BASE_MAP_SOURCES } from '../lib/maplibreHelper';
import { runViewTransition } from '../lib/viewTransition';

interface LayerMenuProps {
  exaggeration: number;
  onChangeExaggeration: (val: number) => void;
  rainOpacity: number;
  onChangeRainOpacity: (val: number) => void;
  baseMap: BaseMapId;
  onChangeBaseMap: (id: BaseMapId) => void;
  rainSource: RainSourceId;
  onChangeRainSource: (source: RainSourceId) => void;
}

export const LayerMenu: React.FC<LayerMenuProps> = ({
  exaggeration,
  onChangeExaggeration,
  rainOpacity,
  onChangeRainOpacity,
  baseMap,
  onChangeBaseMap,
  rainSource,
  onChangeRainSource,
}) => {
  const [isOpen, setIsOpen] = useState<boolean>(true);

  const handleToggleOpen = () => {
    runViewTransition(() => {
      setIsOpen((prev) => !prev);
    });
  };

  return (
    <aside
      aria-label="レイヤー＆描画調整メニュー"
      className="vt-layer-menu pointer-events-auto flex flex-col items-end gap-2"
    >
      {/* 歯車アイコン トグルボタン (タップしやすい min-h-[42px]) */}
      <button
        type="button"
        id="layer-menu-toggle-btn"
        onClick={handleToggleOpen}
        aria-expanded={isOpen}
        aria-controls="layer-menu-panel"
        className="inline-flex items-center gap-2 min-h-[42px] px-3.5 py-2 rounded-2xl bg-slate-900/90 hover:bg-slate-800/95 backdrop-blur-md border border-slate-700/80 shadow-xl text-xs font-semibold text-slate-100 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        <Settings
          className={`w-4 h-4 text-sky-400 transition-transform duration-300 ${
            isOpen ? 'rotate-90' : 'rotate-0'
          }`}
        />
        <span>レイヤー＆描画調整</span>
        <ChevronUp
          className={`w-3.5 h-3.5 text-slate-400 transition-transform duration-200 ${
            isOpen ? 'rotate-0' : 'rotate-180'
          }`}
        />
      </button>

      {/* 展開パネル本体 */}
      {isOpen && (
        <div
          id="layer-menu-panel"
          className="rounded-2xl bg-slate-900/90 backdrop-blur-md border border-slate-700/80 shadow-2xl p-3.5 text-xs text-slate-100 w-72 space-y-2.5 max-h-[calc(100vh-22rem)] overflow-y-auto"
        >
          {/* 0. 雨雲データソース切り替え (リアルタイム気象庁ナウキャスト ⇄ 衛星確定値JAXA GSMaP) */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="flex items-center gap-1.5 font-medium text-slate-200">
                <Radio className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>雨雲データソース</span>
              </span>
            </div>
            <div className="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-slate-950/80 border border-slate-800">
              <button
                type="button"
                id="source-btn-jma"
                onClick={() => onChangeRainSource('jma-nowcast')}
                className={`flex flex-col items-center justify-center min-h-[40px] px-2 py-1.5 rounded-lg text-[11px] font-semibold transition-colors cursor-pointer ${
                  rainSource === 'jma-nowcast'
                    ? 'bg-emerald-500/25 text-emerald-200 border border-emerald-400/50 shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <span className="flex items-center gap-1">
                  <Radio className="w-3 h-3 text-emerald-400" />
                  <span>リアルタイム</span>
                </span>
                <span className="text-[9px] text-slate-400 font-normal">気象庁ナウキャスト</span>
              </button>

              <button
                type="button"
                id="source-btn-gsmap"
                onClick={() => onChangeRainSource('jaxa-gsmap')}
                className={`flex flex-col items-center justify-center min-h-[40px] px-2 py-1.5 rounded-lg text-[11px] font-semibold transition-colors cursor-pointer ${
                  rainSource === 'jaxa-gsmap'
                    ? 'bg-sky-500/25 text-sky-200 border border-sky-400/50 shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <span className="flex items-center gap-1">
                  <Satellite className="w-3 h-3 text-sky-400" />
                  <span>衛星確定値</span>
                </span>
                <span className="text-[9px] text-slate-400 font-normal">JAXA GSMaP (24h)</span>
              </button>
            </div>
          </div>

          {/* 1. 標高強調 (Exaggeration) スライダー: 1.0x 〜 3.0x (デフォルト 1.5x) */}
          <div className="pt-2 border-t border-slate-800">
            <div className="flex items-center justify-between mb-1.5">
              <label
                htmlFor="terrain-exaggeration"
                className="flex items-center gap-1.5 font-medium text-slate-200 cursor-pointer"
              >
                <Mountain className="w-4 h-4 text-amber-400 shrink-0" />
                <span>地形の立体感（高さ強調）</span>
              </label>
              <span
                id="exaggeration-value-badge"
                className="px-2 py-0.5 rounded-md bg-amber-500/20 border border-amber-400/30 font-mono font-bold text-amber-300"
              >
                {exaggeration.toFixed(1)}x
              </span>
            </div>
            <input
              id="terrain-exaggeration"
              type="range"
              min={1.0}
              max={3.0}
              step={0.1}
              value={exaggeration}
              onChange={(e) => onChangeExaggeration(parseFloat(e.target.value))}
              className="w-full accent-amber-400 cursor-pointer h-2 bg-slate-700 rounded-lg"
            />
            <div className="flex justify-between text-[10px] font-mono text-slate-400 mt-1">
              <span>1.0x (実寸)</span>
              <span>1.5x (標準)</span>
              <span>3.0x (最大強調)</span>
            </div>
          </div>

          {/* 2. 雨雲透過度 (Opacity) スライダー: 0% 〜 100% (デフォルト 70%) */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label
                htmlFor="rain-opacity"
                className="flex items-center gap-1.5 font-medium text-slate-200 cursor-pointer"
              >
                <Eye className="w-4 h-4 text-sky-400 shrink-0" />
                <span>雨雲の濃さ（不透明度）</span>
              </label>
              <span
                id="opacity-value-badge"
                className="px-2 py-0.5 rounded-md bg-sky-500/20 border border-sky-400/30 font-mono font-bold text-sky-300"
              >
                {Math.round(rainOpacity * 100)}%
              </span>
            </div>
            <input
              id="rain-opacity"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={rainOpacity}
              onChange={(e) => onChangeRainOpacity(parseFloat(e.target.value))}
              className="w-full accent-sky-400 cursor-pointer h-2 bg-slate-700 rounded-lg"
            />
            <div className="flex justify-between text-[10px] font-mono text-slate-400 mt-1">
              <span>0% (非表示)</span>
              <span>70% (推奨)</span>
              <span>100% (不透明)</span>
            </div>
          </div>

          {/* 3. 背景地図切り替えラジオボタン (OSM標準 / 起伏陰影 / 航空写真) */}
          <fieldset className="pt-2 border-t border-slate-800">
            <legend className="flex items-center gap-1.5 font-medium text-slate-200 mb-2">
              <Layers className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>背景地図レイヤー切り替え</span>
            </legend>
            <div className="space-y-1.5">
              {(Object.keys(BASE_MAP_SOURCES) as BaseMapId[]).map((id) => {
                const info = BASE_MAP_SOURCES[id];
                const checked = baseMap === id;
                const radioId = `basemap-radio-${id}`;
                return (
                  <label
                    key={id}
                    htmlFor={radioId}
                    className={`flex items-center gap-2.5 min-h-[36px] px-2.5 py-1.5 rounded-xl border transition-colors cursor-pointer ${
                      checked
                        ? 'bg-sky-500/20 border-sky-400/50 text-white'
                        : 'bg-slate-800/60 border-slate-700/60 text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    <input
                      id={radioId}
                      type="radio"
                      name="basemap"
                      value={id}
                      checked={checked}
                      onChange={() => onChangeBaseMap(id)}
                      className="w-4 h-4 accent-sky-400 cursor-pointer shrink-0"
                    />
                    <div className="flex flex-col">
                      <span className="font-semibold text-xs leading-tight">{info.name}</span>
                      <span className="text-[10px] text-slate-400 mt-0.5">{info.description}</span>
                    </div>
                  </label>
                );
              })}
            </div>
          </fieldset>
        </div>
      )}
    </aside>
  );
};
