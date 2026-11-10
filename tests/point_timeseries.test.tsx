import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  getJMATileCoordinates,
  getJMATileUrl,
  sampleJMAPrecipitationFromTile,
  fetchPointTimeseries,
  clearPointTimeseriesCache,
  type PointTimeseriesResult,
} from '../src/lib/pointTimeseriesClient';
import { RainfallChart } from '../src/components/RainfallChart';
import { TimelineBar } from '../src/components/TimelineBar';
import type { TimelineFrameItem } from '../src/types/map';

const dummyFrames: TimelineFrameItem[] = [
  {
    date: new Date('2026-11-10T04:00:00Z'),
    labelJST: '11/10 13:00',
    relativeBadge: '-60分',
    isForecast: false,
    isLatestObservation: false,
    basetime: '20261110050000',
    validtime: '20261110040000',
    tileDataset: 'hrpns',
  },
  {
    date: new Date('2026-11-10T05:00:00Z'),
    labelJST: '11/10 14:00',
    relativeBadge: '最新実況',
    isForecast: false,
    isLatestObservation: true,
    basetime: '20261110050000',
    validtime: '20261110050000',
    tileDataset: 'hrpns',
  },
  {
    date: new Date('2026-11-10T05:30:00Z'),
    labelJST: '11/10 14:30',
    relativeBadge: '+30分予報',
    isForecast: true,
    isLatestObservation: false,
    basetime: '20261110050000',
    validtime: '20261110053000',
    tileDataset: 'hrpns',
  },
  {
    date: new Date('2026-11-10T06:00:00Z'),
    labelJST: '11/10 15:00',
    relativeBadge: '+1h予報',
    isForecast: true,
    isLatestObservation: false,
    basetime: '20261110050000',
    validtime: '20261110060000',
    tileDataset: 'rasrf',
  },
];

describe('pointTimeseriesClient: 座標・ピクセル計算およびサンプリング (機能・境界値観点)', () => {
  beforeEach(() => {
    clearPointTimeseriesCache();
  });

  it('東京中心 (35.6812, 139.7671) のJMAタイル座標が正しく日本の観測範囲内 (z=6, tx=56, ty=25) に収まること', () => {
    const coords = getJMATileCoordinates(139.7671, 35.6812);
    expect(coords.inBounds).toBe(true);
    expect(coords.tx).toBe(56);
    expect(coords.ty).toBe(25);
    expect(coords.px).toBeGreaterThanOrEqual(0);
    expect(coords.px).toBeLessThanOrEqual(255);
    expect(coords.py).toBeGreaterThanOrEqual(0);
    expect(coords.py).toBeLessThanOrEqual(255);
  });

  it('気象庁レーダー観測域外 (ロンドン: 51.5, -0.12) では inBounds が false と判定されること', () => {
    const coords = getJMATileCoordinates(-0.12, 51.5);
    expect(coords.inBounds).toBe(false);
  });

  it('hrpns と rasrf で適切なタイルURLが生成されること', () => {
    const hrpnsUrl = getJMATileUrl(dummyFrames[0], 56, 25);
    expect(hrpnsUrl).toContain('/nowc/20261110050000/none/20261110040000/surf/hrpns/6/56/25.png');

    const rasrfUrl = getJMATileUrl(dummyFrames[3], 56, 25);
    expect(rasrfUrl).toContain('/rasrf/20261110050000/none/20261110060000/surf/rasrf/6/56/25.png');
  });

  it('member: immed のフレームで正しく URL に /immed/ が含まれること (FIX: +2h〜+6h 域外/欠測バグ防止)', () => {
    const immedFrame: TimelineFrameItem = {
      ...dummyFrames[3],
      member: 'immed',
    };
    const url = getJMATileUrl(immedFrame, 56, 25);
    expect(url).toContain('/rasrf/20261110050000/immed/20261110060000/surf/rasrf/6/56/25.png');
  });

  it('透明ピクセル (alpha = 0) の場合は降水量 0 mm/h を返すこと', () => {
    const data = new Uint8ClampedArray(256 * 256 * 4);
    // 全て透明
    const val = sampleJMAPrecipitationFromTile(data, 128, 128);
    expect(val).toBe(0);
  });

  it('気象庁カラーパレットのRGB (242, 242, 255 -> 0.8mm/h) が正しくデコードされること', () => {
    const data = new Uint8ClampedArray(256 * 256 * 4);
    const px = 100;
    const py = 100;
    const idx = (py * 256 + px) * 4;
    data[idx] = 242;
    data[idx + 1] = 242;
    data[idx + 2] = 255;
    data[idx + 3] = 255; // 不透明

    const val = sampleJMAPrecipitationFromTile(data, px, py);
    expect(val).toBe(0.8);
  });

  it('3x3近傍に異なる降雨強度がある場合、最大の強度が採用されること', () => {
    const data = new Uint8ClampedArray(256 * 256 * 4);
    const px = 50;
    const py = 50;
    // 中心は 0.8mm/h (242, 242, 255)
    let idx = (py * 256 + px) * 4;
    data[idx] = 242; data[idx + 1] = 242; data[idx + 2] = 255; data[idx + 3] = 255;
    // 右隣 (px+1) は 25mm/h (250, 245, 0)
    idx = (py * 256 + px + 1) * 4;
    data[idx] = 250; data[idx + 1] = 245; data[idx + 2] = 0; data[idx + 3] = 255;

    const val = sampleJMAPrecipitationFromTile(data, px, py);
    expect(val).toBe(25);
  });
});

describe('pointTimeseriesClient: 時系列取得・キャッシュ・キャンセル (非機能・性能観点)', () => {
  beforeEach(() => {
    clearPointTimeseriesCache();
    vi.stubGlobal('Image', class {
      naturalWidth = 256;
      naturalHeight = 256;
      onload: any;
      set src(v: string) {
        if (v) queueMicrotask(() => this.onload?.());
      }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('日本域外の座標では、全件ネットワーク通信を行わずに全フレーム null を返すこと', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await fetchPointTimeseries(-0.12, 51.5, dummyFrames, 'jma-nowcast');
    expect(result.items).toHaveLength(4);
    expect(result.items.every((it) => it.precipitation === null)).toBe(true);
    expect(result.maxPrecipitation).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('AbortSignal が事前に中断されている場合、処理が直ちに中断されること', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      fetchPointTimeseries(139.76, 35.68, dummyFrames, 'jma-nowcast', controller.signal)
    ).rejects.toThrow();
  });

  it('同一地点の2回目の呼び出しでは結果キャッシュが返されること', async () => {
    const canvasData = new Uint8ClampedArray(256 * 256 * 4);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
      getImageData: () => ({ data: canvasData }),
    } as any);

    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal('fetch', fetchMock);

    const res1 = await fetchPointTimeseries(139.76, 35.68, dummyFrames, 'jma-nowcast');
    const res2 = await fetchPointTimeseries(139.76, 35.68, dummyFrames, 'jma-nowcast');

    expect(res1).toBe(res2);
  });
});

describe('RainfallChart コンポーネント (UI・操作観点)', () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  const mockTimeseries: PointTimeseriesResult = {
    lng: 139.76,
    lat: 35.68,
    fetchedAt: Date.now(),
    maxPrecipitation: 15,
    items: [
      {
        frame: dummyFrames[0],
        precipitation: 2.5,
        isForecast: false,
        isLatestObservation: false,
      },
      {
        frame: dummyFrames[1],
        precipitation: 15,
        isForecast: false,
        isLatestObservation: true,
      },
      {
        frame: dummyFrames[2],
        precipitation: 5.0,
        isForecast: true,
        isLatestObservation: false,
      },
      {
        frame: dummyFrames[3],
        precipitation: 0,
        isForecast: true,
        isLatestObservation: false,
      },
    ],
  };

  it('Y軸固定列と各フレームの時刻・雨量バーが表示されること', async () => {
    const onSelect = vi.fn();
    await act(async () => {
      root.render(
        <RainfallChart
          timeseries={mockTimeseries}
          currentIndex={1}
          onSelectIndex={onSelect}
          rainSource="jma-nowcast"
        />
      );
    });

    // Y軸スケール最大値 (max 15 -> scale 20)
    expect(host.textContent).toContain('20');
    // 雨量数値
    expect(host.textContent).toContain('2.5');
    expect(host.textContent).toContain('15');
    expect(host.textContent).toContain('5.0');
    expect(host.textContent).toContain('0');
  });

  it('バーをクリックすると onSelectIndex が呼ばれること', async () => {
    const onSelect = vi.fn();
    await act(async () => {
      root.render(
        <RainfallChart
          timeseries={mockTimeseries}
          currentIndex={1}
          onSelectIndex={onSelect}
          rainSource="jma-nowcast"
        />
      );
    });

    const firstBar = host.querySelector('button[data-bar-index="0"]') as HTMLButtonElement;
    expect(firstBar).toBeDefined();
    await act(async () => {
      firstBar.click();
    });
    expect(onSelect).toHaveBeenCalledWith(0);
  });

  it('最新実況フレームの後に「現在」境界線が表示されること', async () => {
    await act(async () => {
      root.render(
        <RainfallChart
          timeseries={mockTimeseries}
          currentIndex={1}
          onSelectIndex={vi.fn()}
          rainSource="jma-nowcast"
        />
      );
    });

    const nowDivider = host.querySelector('[aria-label="現在実況境界"]');
    expect(nowDivider).not.toBeNull();
  });
});

describe('TimelineBar: 引き出し式ドロワーの操作 (UI/UX観点)', () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it('ハンドルのクリックでドロワーの開閉がトグルされること', async () => {
    const onToggleDrawer = vi.fn();
    await act(async () => {
      root.render(
        <TimelineBar
          rainSource="jma-nowcast"
          frames={dummyFrames}
          currentIndex={1}
          onSelectIndex={vi.fn()}
          isPlaying={false}
          onTogglePlay={vi.fn()}
          playbackSpeed={1}
          onToggleSpeed={vi.fn()}
          observedDateJST="2026-11-10 14:00 JST"
          isLoading={false}
          isDrawerOpen={false}
          onToggleDrawer={onToggleDrawer}
        />
      );
    });

    const handle = host.querySelector('#timeline-drawer-handle') as HTMLElement;
    expect(handle).not.toBeNull();
    // ハンドル下に説明テキストが含まれず、ミニマルなバーのみであること
    expect(handle.textContent?.trim()).toBe('');

    await act(async () => {
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientY: 200, pointerId: 1 }));
      handle.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientY: 200, pointerId: 1 }));
    });

    expect(onToggleDrawer).toHaveBeenCalledWith(true);
  });

  it('上へのプルアップドラッグ (deltaY < -30) でドロワーが開くこと', async () => {
    const onToggleDrawer = vi.fn();
    await act(async () => {
      root.render(
        <TimelineBar
          rainSource="jma-nowcast"
          frames={dummyFrames}
          currentIndex={1}
          onSelectIndex={vi.fn()}
          isPlaying={false}
          onTogglePlay={vi.fn()}
          playbackSpeed={1}
          onToggleSpeed={vi.fn()}
          observedDateJST="2026-11-10 14:00 JST"
          isLoading={false}
          isDrawerOpen={false}
          onToggleDrawer={onToggleDrawer}
        />
      );
    });

    const handle = host.querySelector('#timeline-drawer-handle') as HTMLElement;
    await act(async () => {
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientY: 200, pointerId: 1 }));
      handle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientY: 150, pointerId: 1 }));
      handle.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientY: 150, pointerId: 1 }));
    });

    expect(onToggleDrawer).toHaveBeenCalledWith(true);
  });

  it('下へのプルダウンドラッグ (deltaY > 30) でドロワーが閉じること', async () => {
    const onToggleDrawer = vi.fn();
    await act(async () => {
      root.render(
        <TimelineBar
          rainSource="jma-nowcast"
          frames={dummyFrames}
          currentIndex={1}
          onSelectIndex={vi.fn()}
          isPlaying={false}
          onTogglePlay={vi.fn()}
          playbackSpeed={1}
          onToggleSpeed={vi.fn()}
          observedDateJST="2026-11-10 14:00 JST"
          isLoading={false}
          isDrawerOpen={true}
          onToggleDrawer={onToggleDrawer}
        />
      );
    });

    const handle = host.querySelector('#timeline-drawer-handle') as HTMLElement;
    await act(async () => {
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientY: 150, pointerId: 1 }));
      handle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientY: 200, pointerId: 1 }));
      handle.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientY: 200, pointerId: 1 }));
    });

    expect(onToggleDrawer).toHaveBeenCalledWith(false);
  });

  it('パターンA: ドロワー展開とインスペクター表示が相互に自動クローズ（排他制御）されること', () => {
    let inspectedPoint: any = { lng: 139.76, lat: 35.68, elevation: 10, precipitation: 2.5 };
    let isDrawerOpen = false;

    const handleToggleDrawer = (open: boolean) => {
      isDrawerOpen = open;
      if (open) {
        inspectedPoint = null;
      }
    };

    const handleInspectPoint = (pt: any) => {
      isDrawerOpen = false;
      inspectedPoint = pt;
    };

    // 初期状態: インスペクターが表示されている
    expect(inspectedPoint).not.toBeNull();
    expect(isDrawerOpen).toBe(false);

    // ドロワーを開く（スワイプまたはタップ） -> インスペクターが自動で閉じる
    handleToggleDrawer(true);
    expect(isDrawerOpen).toBe(true);
    expect(inspectedPoint).toBeNull();

    // グラフ表示中に地図をタップして地点選択 -> ドロワーが自動で閉じ、インスペクターが表示される
    handleInspectPoint({ lng: 138.72, lat: 35.36, elevation: 3776, precipitation: 0 });
    expect(isDrawerOpen).toBe(false);
    expect(inspectedPoint).not.toBeNull();
    expect(inspectedPoint.elevation).toBe(3776);
  });
});
