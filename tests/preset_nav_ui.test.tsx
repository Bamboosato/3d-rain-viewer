import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { PresetNav } from '../src/components/PresetNav';
import type { PresetLocation } from '../src/types/map';

const dummyPresetA: PresetLocation = {
  id: 'preset-fuji',
  name: '富士山',
  center: [138.7278, 35.3606],
  elevation: 3776,
  zoom: 12,
  pitch: 60,
  bearing: 0,
  region: '中部',
  areaGroup: '富士山・八ヶ岳・中央アルプス',
  emoji: '🗻',
  description: '',
};

const dummyPresetB: PresetLocation = {
  id: 'preset-kita',
  name: '北岳',
  center: [138.2389, 35.6744],
  elevation: 3193,
  zoom: 12,
  pitch: 50,
  bearing: 0,
  region: '中部',
  areaGroup: '南アルプス',
  emoji: '⛰️',
  description: '',
};

const dummyFavorite: PresetLocation = {
  id: 'fav-1',
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

describe('PresetNav: 地点名非表示・非選択状態・列数固定・ホバー色のUI検証', () => {
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

  it('1. ホーム画面のトグルボタンに地点名が表示されず、PC用・スマホ用のラベルが配置されていること', async () => {
    await act(async () => {
      root.render(
        <PresetNav
          presets={[dummyPresetA, dummyPresetB]}
          favorites={[dummyFavorite]}
          activePreset={dummyPresetA}
          referenceLocation={{ lat: 35.6, lng: 139.3 }}
          onSelectPreset={vi.fn()}
          isOpen={false}
        />
      );
    });

    const toggleBtn = host.querySelector('#preset-nav-toggle-btn') as HTMLButtonElement;
    expect(toggleBtn).not.toBeNull();

    // 地点名（富士山）が表示されていないこと
    expect(toggleBtn.textContent).not.toContain('富士山');
    expect(toggleBtn.textContent).not.toContain('🗻');

    // PC用「地点切替・検索」とスマホ用「地名検索」が存在すること
    const pcLabel = toggleBtn.querySelector('.hidden.md\\:inline');
    expect(pcLabel).not.toBeNull();
    expect(pcLabel?.textContent).toBe('地点切替・検索');

    const spLabel = toggleBtn.querySelector('.md\\:hidden');
    expect(spLabel).not.toBeNull();
    expect(spLabel?.textContent).toBe('地名検索');
  });

  it('2. 百名山タブ: 2列固定 (grid-cols-2)、最後に選択された地点も選択状態にせず、ホバー枠線スタイルを持つこと', async () => {
    await act(async () => {
      root.render(
        <PresetNav
          presets={[dummyPresetA, dummyPresetB]}
          favorites={[dummyFavorite]}
          activePreset={dummyPresetA}
          referenceLocation={{ lat: 35.6, lng: 139.3 }}
          onSelectPreset={vi.fn()}
          isOpen={true}
        />
      );
    });

    // パネルの最小高さ確認
    const panel = host.querySelector('#preset-nav-panel');
    expect(panel?.className).toContain('min-h-[22rem]');

    // 百名山リストの列数確認: grid-cols-2 固定（sm:grid-cols-3を含まない）
    const mountainList = host.querySelector('#preset-mountain-list');
    expect(mountainList).not.toBeNull();
    expect(mountainList?.className).toContain('grid-cols-2');
    expect(mountainList?.className).not.toContain('sm:grid-cols-3');

    // 選択中の「〇〇」を表示リンクが存在しないこと
    expect(host.textContent).not.toContain('選択中の「富士山」を表示');

    // activePreset（富士山）であっても vt-active-pill が存在しないこと
    const activePill = host.querySelector('.vt-active-pill');
    expect(activePill).toBeNull();

    // 各カードに統一ホバー色 (hover:border-sky-400/60) が付与されていること
    const buttons = mountainList?.querySelectorAll('button');
    expect(buttons && buttons.length > 0).toBe(true);
    buttons?.forEach((btn) => {
      expect(btn.className).toContain('hover:border-sky-400/60');
      expect(btn.getAttribute('aria-pressed')).toBeNull();
    });
  });

  it('3. お気に入りタブ: 1列固定 (grid-cols-1)、選択状態にならず、ホバー枠線スタイルを持つこと', async () => {
    await act(async () => {
      root.render(
        <PresetNav
          presets={[dummyPresetA, dummyPresetB]}
          favorites={[dummyFavorite]}
          activePreset={dummyPresetA}
          referenceLocation={{ lat: 35.6, lng: 139.3 }}
          onSelectPreset={vi.fn()}
          isOpen={true}
        />
      );
    });

    // お気に入りタブへ切り替え
    const favTabBtn = host.querySelector('#preset-tab-favorites') as HTMLButtonElement;
    await act(async () => {
      favTabBtn.click();
    });

    // お気に入りリストの列数確認: grid-cols-1 固定（sm:grid-cols-2を含まない）
    const favoriteList = host.querySelector('#preset-favorite-list');
    expect(favoriteList).not.toBeNull();
    expect(favoriteList?.className).toContain('grid-cols-1');
    expect(favoriteList?.className).not.toContain('sm:grid-cols-2');

    // activePill が存在しないこと
    expect(host.querySelector('.vt-active-pill')).toBeNull();

    // カードコンテナにホバー色 (hover:border-sky-400/60) が付与されていること
    const cardContainers = favoriteList?.querySelectorAll(':scope > div');
    expect(cardContainers && cardContainers.length > 0).toBe(true);
    cardContainers?.forEach((card) => {
      expect(card.className).toContain('hover:border-sky-400/60');
    });
  });

  it('4. タブ切り替え時もコンテナが安定した最小高さ (min-h-[17.5rem]) を維持すること', async () => {
    await act(async () => {
      root.render(
        <PresetNav
          presets={[dummyPresetA]}
          favorites={[]}
          activePreset={dummyPresetA}
          referenceLocation={{ lat: 35.6, lng: 139.3 }}
          onSelectPreset={vi.fn()}
          isOpen={true}
        />
      );
    });

    // 百名山タブのコンテナ
    let tabContainer = host.querySelector('#preset-mountain-list')?.closest('.min-h-\\[17\\.5rem\\]');
    expect(tabContainer).not.toBeNull();

    // お気に入りタブ（0件でも min-h-[17.5rem]）
    const favTabBtn = host.querySelector('#preset-tab-favorites') as HTMLButtonElement;
    await act(async () => {
      favTabBtn.click();
    });
    tabContainer = host.querySelector('#preset-favorite-list')?.closest('.min-h-\\[17\\.5rem\\]');
    expect(tabContainer).not.toBeNull();

    // 検索タブ（初期状態でも min-h-[17.5rem]）
    const searchTabBtn = host.querySelector('#preset-tab-search') as HTMLButtonElement;
    await act(async () => {
      searchTabBtn.click();
    });
    const searchInput = host.querySelector('#preset-search-input');
    tabContainer = searchInput?.closest('.min-h-\\[17\\.5rem\\]');
    expect(tabContainer).not.toBeNull();
  });
});
