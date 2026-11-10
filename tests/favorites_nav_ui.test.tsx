import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { PresetNav } from '../src/components/PresetNav';
import type { PresetLocation } from '../src/types/map';

const dummyPreset: PresetLocation = {
  id: 'preset-1',
  name: '基準地点',
  center: [139.3, 35.6],
  elevation: 100,
  zoom: 11,
  pitch: 60,
  bearing: 0,
  region: '関東',
  emoji: '📍',
  description: '',
};

// 基準地点 [139.3, 35.6] から近い地点
const favNear: PresetLocation = {
  id: 'fav-near',
  name: '高尾山',
  center: [139.2438, 35.625],
  elevation: 599,
  zoom: 13,
  pitch: 45,
  bearing: 0,
  region: '関東',
  emoji: '⭐',
  description: '',
  isFavorite: true,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  isPinned: false,
};

// 基準地点から遠い地点（登録日時は新しい）
const favFar: PresetLocation = {
  id: 'fav-far',
  name: '槍ヶ岳',
  center: [137.6475, 36.3122],
  elevation: 3180,
  zoom: 12,
  pitch: 55,
  bearing: 0,
  region: '中部',
  emoji: '⭐',
  description: '',
  isFavorite: true,
  createdAt: '2026-11-05T00:00:00Z',
  updatedAt: '2026-11-05T00:00:00Z',
  isPinned: false,
};

// 基準地点から遠く登録も古いが、ピン留めされている地点
const favPinnedFar: PresetLocation = {
  id: 'fav-pinned-far',
  name: '北岳',
  center: [138.2389, 35.6744],
  elevation: 3193,
  zoom: 12,
  pitch: 50,
  bearing: 0,
  region: '中部',
  emoji: '⭐',
  description: '',
  isFavorite: true,
  createdAt: '2026-10-20T00:00:00Z',
  updatedAt: '2026-10-20T00:00:00Z',
  isPinned: true,
};

describe('PresetNav: お気に入りタブのUI/UXと並び順・ピン留め機能', () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
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

  it('タイトルが「お気に入り (xx件)」となり、ボタン名が「保存・復元」であること', async () => {
    await act(async () => {
      root.render(
        <PresetNav
          presets={[dummyPreset]}
          favorites={[favNear, favFar]}
          activePreset={dummyPreset}
          referenceLocation={{ lat: 35.6, lng: 139.3 }}
          onSelectPreset={vi.fn()}
          onOpenFavoritesSync={vi.fn()}
          isOpen={true}
        />
      );
    });

    // お気に入りタブに切り替え
    const favTabBtn = host.querySelector('#preset-tab-favorites') as HTMLButtonElement;
    expect(favTabBtn).not.toBeNull();
    await act(async () => {
      favTabBtn.click();
    });

    // タイトル確認: "お気に入り (2件)"
    expect(host.textContent).toContain('お気に入り (2件)');
    expect(host.textContent).not.toContain('登録済みのお気に入り');

    // ボタン名確認: "保存・復元"
    const syncBtn = host.querySelector('#favorites-sync-open-btn');
    expect(syncBtn).not.toBeNull();
    expect(syncBtn?.textContent).toContain('保存・復元');
    expect(syncBtn?.textContent).not.toContain('バックアップ・引き継ぎ');
  });

  it('初期ソートが「近い順」であり、ピン留め地点が最上位、距離ラベル表示、標高非表示であること', async () => {
    await act(async () => {
      root.render(
        <PresetNav
          presets={[dummyPreset]}
          favorites={[favFar, favNear, favPinnedFar]}
          activePreset={dummyPreset}
          referenceLocation={{ lat: 35.6, lng: 139.3 }}
          onSelectPreset={vi.fn()}
          onOpenFavoritesSync={vi.fn()}
          isOpen={true}
        />
      );
    });

    const favTabBtn = host.querySelector('#preset-tab-favorites') as HTMLButtonElement;
    await act(async () => {
      favTabBtn.click();
    });

    const list = host.querySelector('#preset-favorite-list');
    expect(list).not.toBeNull();

    const items = list?.querySelectorAll(':scope > div');
    expect(items?.length).toBe(3);

    // 1番目: ピン留めされている「北岳」（距離が遠くても最上位）
    expect(items?.[0].textContent).toContain('北岳');
    // 2番目: ピン留め以外のうち一番近い「高尾山」
    expect(items?.[1].textContent).toContain('高尾山');
    // 3番目: ピン留め以外のうち遠い「槍ヶ岳」
    expect(items?.[2].textContent).toContain('槍ヶ岳');

    // 「近い順」時は距離アイコン（📍）と距離ラベルが含まれること
    expect(items?.[1].textContent).toMatch(/📍\s*\d+/);

    // リストの2行目に標高「599m ·」や「3180m ·」が含まれないこと（整理されたこと）
    expect(items?.[1].textContent).not.toContain('599m');
    expect(items?.[2].textContent).not.toContain('3,180m');
  });

  it('「登録順」に切り替えると、ピン留めが最上位を維持しつつ作成日時の新しい順に並び替わること', async () => {
    await act(async () => {
      root.render(
        <PresetNav
          presets={[dummyPreset]}
          favorites={[favNear, favFar, favPinnedFar]}
          activePreset={dummyPreset}
          referenceLocation={{ lat: 35.6, lng: 139.3 }}
          onSelectPreset={vi.fn()}
          onOpenFavoritesSync={vi.fn()}
          isOpen={true}
        />
      );
    });

    const favTabBtn = host.querySelector('#preset-tab-favorites') as HTMLButtonElement;
    await act(async () => {
      favTabBtn.click();
    });

    // 並び順切替ボタン（登録順）をクリック
    const buttons = Array.from(host.querySelectorAll('button'));
    const createdSortBtn = buttons.find((b) => b.textContent?.trim() === '登録順');
    expect(createdSortBtn).toBeDefined();

    await act(async () => {
      createdSortBtn?.click();
    });

    const list = host.querySelector('#preset-favorite-list');
    const items = list?.querySelectorAll(':scope > div');

    // 1番目: ピン留め「北岳」（ピン留め最優先）
    expect(items?.[0].textContent).toContain('北岳');
    // 2番目: 登録順で新しい「槍ヶ岳」（11/05）
    expect(items?.[1].textContent).toContain('槍ヶ岳');
    // 3番目: 登録順で古い「高尾山」（11/01）
    expect(items?.[2].textContent).toContain('高尾山');

    // 選択状態が localStorage に永続化されていること
    expect(localStorage.getItem('rain3d_favorites_sort_order')).toBe('created');
  });

  it('ピン留めボタンのクリックで onTogglePinFavorite が呼び出されること', async () => {
    const onTogglePinFavorite = vi.fn();
    await act(async () => {
      root.render(
        <PresetNav
          presets={[dummyPreset]}
          favorites={[favNear]}
          activePreset={dummyPreset}
          referenceLocation={{ lat: 35.6, lng: 139.3 }}
          onSelectPreset={vi.fn()}
          onTogglePinFavorite={onTogglePinFavorite}
          isOpen={true}
        />
      );
    });

    const favTabBtn = host.querySelector('#preset-tab-favorites') as HTMLButtonElement;
    await act(async () => {
      favTabBtn.click();
    });

    const pinBtn = host.querySelector('button[title*="ピン留め"]') as HTMLButtonElement;
    expect(pinBtn).not.toBeNull();

    await act(async () => {
      pinBtn.click();
    });

    expect(onTogglePinFavorite).toHaveBeenCalledWith('fav-near');
  });
});
