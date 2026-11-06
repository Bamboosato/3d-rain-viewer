import React from 'react';
import { CloudRain } from 'lucide-react';
import type { RainSourceId } from '../types/map';

interface LegendProps {
  maxPrecipitation?: number;
  isLoading?: boolean;
  rainSource?: RainSourceId;
}

const LEGEND_STEPS = [
  { label: '80+', desc: '猛烈な雨', color: '#b40068' },
  { label: '50–80', desc: '非常に激しい', color: '#ef4444' },
  { label: '20–50', desc: '激しい雨', color: '#f97316' },
  { label: '10–20', desc: 'やや強い雨', color: '#facc15' },
  { label: '5–10', desc: '強い雨', color: '#22c55e' },
  { label: '1–5', desc: '弱い〜並の雨', color: '#218cff' },
  { label: '0.5–1', desc: '弱い雨', color: '#00d5ff' },
  { label: '0.1–0.5', desc: '小雨・雨雲域', color: '#38bdf8' },
];

export const Legend: React.FC<LegendProps> = ({
  maxPrecipitation = 0,
  isLoading = false,
  rainSource = 'jma-nowcast',
}) => {
  return (
    <aside
      aria-label="降雨強度カラーバー凡例"
      className="pointer-events-auto select-none rounded-2xl bg-slate-900/85 backdrop-blur-md border border-slate-700/70 shadow-2xl p-3.5 text-xs text-slate-100 w-52"
    >
      <div className="flex items-center justify-between gap-2 mb-2.5 pb-2 border-b border-slate-700/70">
        <div className="flex items-center gap-1.5 font-semibold text-slate-100">
          <CloudRain className="w-4 h-4 text-sky-400 shrink-0" />
          <span>降雨強度 (mm/h)</span>
        </div>
        <span
          className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
            rainSource === 'jma-nowcast'
              ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
              : 'bg-sky-500/20 text-sky-300 border-sky-500/30'
          }`}
        >
          {rainSource === 'jma-nowcast' ? 'JMA Nowcast' : 'GSMaP'}
        </span>
      </div>

      {/* 連続グラデーションカラーバー */}
      <div className="mb-3">
        <div
          className="h-2.5 w-full rounded-full border border-slate-600/80 shadow-inner"
          style={{
            background:
              'linear-gradient(90deg, rgba(56,189,248,0.35) 0%, #00d5ff 18%, #218cff 35%, #22c55e 52%, #facc15 68%, #f97316 82%, #ef4444 92%, #b40068 100%)',
          }}
        />
        <div className="flex justify-between text-[10px] font-mono text-slate-400 mt-1">
          <span>0.1</span>
          <span>2</span>
          <span>10</span>
          <span>30</span>
          <span>80+</span>
        </div>
      </div>

      {/* 段階別カラー凡例リスト */}
      <ul className="space-y-1">
        {LEGEND_STEPS.map((item) => (
          <li key={item.label} className="flex items-center justify-between text-[11px]">
            <div className="flex items-center gap-2">
              <span
                className="w-3 h-3 rounded-sm shrink-0 border border-white/20 shadow-sm"
                style={{ backgroundColor: item.color }}
              />
              <span className="font-mono text-slate-200 w-12">{item.label}</span>
            </div>
            <span className="text-slate-400 text-[10px]">{item.desc}</span>
          </li>
        ))}
      </ul>

      <div className="mt-2.5 pt-2 border-t border-slate-800 flex items-center justify-between text-[10px] text-slate-400">
        <span>日本域最大観測値</span>
        <span className="font-mono font-semibold text-sky-300">
          {isLoading ? '読込中...' : `${maxPrecipitation.toFixed(1)} mm/h`}
        </span>
      </div>
    </aside>
  );
};
