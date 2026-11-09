import React, { useEffect, useState } from 'react';

interface QrCodeProps {
  text: string;
  /** 表示サイズ(px) */
  size?: number;
  className?: string;
}

type QrState =
  | { status: 'loading' }
  | { status: 'ready'; path: string; count: number }
  | { status: 'error'; message: string };

/**
 * テキストをQRコード（SVG）で表示します。
 * QRライブラリ（qrcode-generator）は表示時にのみ動的読み込みし、初期バンドルを増やしません。
 */
export const QrCode: React.FC<QrCodeProps> = ({ text, size = 240, className }) => {
  const [state, setState] = useState<QrState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    import('qrcode-generator')
      .then((mod) => {
        if (cancelled) return;
        const qrcode = mod.default;
        // 情報量を最大化するため誤り訂正レベル L、型番は自動選択
        const qr = qrcode(0, 'L');
        qr.addData(text, 'Byte');
        qr.make();
        const count = qr.getModuleCount();
        let path = '';
        for (let r = 0; r < count; r++) {
          for (let c = 0; c < count; c++) {
            if (qr.isDark(r, c)) path += `M${c} ${r}h1v1h-1z`;
          }
        }
        setState({ status: 'ready', path, count });
      })
      .catch(() => {
        if (cancelled) return;
        setState({
          status: 'error',
          message:
            'データ量が多いためQRコードを作成できません。URLのコピー、またはJSONファイルをご利用ください。',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [text]);

  if (state.status === 'error') {
    return (
      <div className="rounded-xl bg-rose-500/10 border border-rose-400/40 p-3 text-xs text-rose-200">
        {state.message}
      </div>
    );
  }

  if (state.status === 'loading') {
    return (
      <div
        style={{ width: size, height: size }}
        className="rounded-xl bg-slate-800/60 animate-pulse"
        aria-label="QRコードを作成中"
      />
    );
  }

  const margin = 4;
  const view = state.count + margin * 2;
  return (
    <svg
      role="img"
      aria-label="お気に入り引き継ぎ用QRコード"
      width={size}
      height={size}
      viewBox={`${-margin} ${-margin} ${view} ${view}`}
      shapeRendering="crispEdges"
      className={className}
      style={{ background: '#ffffff', borderRadius: 12 }}
    >
      <rect x={-margin} y={-margin} width={view} height={view} fill="#ffffff" />
      <path d={state.path} fill="#000000" />
    </svg>
  );
};
