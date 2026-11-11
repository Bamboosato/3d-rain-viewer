import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  FAVORITE_CATEGORIES,
  FAVORITE_CATEGORY_KEYS,
  getFavoriteCategoryMeta,
  createCategorySvgString,
  isFavoriteCategory,
  type FavoriteCategory,
} from '../src/lib/favoriteCategories';
import {
  isValidFavoriteLocation,
  filterAndValidateFavorites,
} from '../src/lib/favoritesStorage';
import { buildFavoriteLocation } from '../src/lib/favoritesTransfer';
import { Inspector } from '../src/components/Inspector';
import { PresetNav } from '../src/components/PresetNav';
import type { InspectorPoint, PresetLocation } from '../src/types/map';

describe('お気に入り4カテゴリ（自然・観光・生活・その他）マスター＆データ互換性検証', () => {
  it('1. 4カテゴリのマスターがすべて定義され、未知の値には "other" へ安全にフォールバックすること', () => {
    expect(FAVORITE_CATEGORY_KEYS).toEqual(['nature', 'tourism', 'lifestyle', 'other']);
    expect(FAVORITE_CATEGORIES.nature.label).toBe('自然');
    expect(FAVORITE_CATEGORIES.tourism.label).toBe('観光');
    expect(FAVORITE_CATEGORIES.lifestyle.label).toBe('生活');
    expect(FAVORITE_CATEGORIES.other.label).toBe('その他');

    // 未知の値・undefined
    expect(getFavoriteCategoryMeta(undefined).id).toBe('other');
    expect(getFavoriteCategoryMeta(null).id).toBe('other');
    expect(getFavoriteCategoryMeta('unknown-cat').id).toBe('other');
    expect(getFavoriteCategoryMeta('nature').id).toBe('nature');

    // SVG文字列生成
    const svgStr = createCategorySvgString('nature', 16);
    expect(svgStr).toContain('<svg');
    expect(svgStr).toContain('width="16"');
    expect(svgStr).toContain('</svg>');
  });

  it('2. isValidFavoriteLocation が有効カテゴリを承認し、無効カテゴリを拒絶、未設定は後方互換で承認すること', () => {
    const base: PresetLocation = {
      id: 'fav-test-1',
      name: 'テスト地点',
      center: [139.7, 35.6],
      zoom: 12,
      pitch: 45,
      bearing: 0,
      elevation: 100,
      region: '関東',
      emoji: '⭐',
      description: '',
      isFavorite: true,
    };

    // 未設定（既存データ）: 承認
    expect(isValidFavoriteLocation(base)).toBe(true);

    // 有効な4カテゴリ: 承認
    for (const cat of FAVORITE_CATEGORY_KEYS) {
      expect(isValidFavoriteLocation({ ...base, category: cat })).toBe(true);
    }

    // 不正なカテゴリ: 拒絶
    expect(isValidFavoriteLocation({ ...base, category: 'space' as any })).toBe(false);
  });

  it('3. buildFavoriteLocation および filterAndValidateFavorites が未指定時に "other" を補完すること', () => {
    const built = buildFavoriteLocation({
      name: '尾瀬ヶ原',
      lng: 139.2,
      lat: 36.9,
      zoom: 11,
      pitch: 50,
      bearing: 0,
      category: 'nature',
    });
    expect(built.category).toBe('nature');
    expect(built.emoji).toBe('🌲');

    // 未指定時は 'other' (⭐)
    const builtDefault = buildFavoriteLocation({
      name: '未指定地点',
      lng: 139.2,
      lat: 36.9,
      zoom: 11,
      pitch: 50,
      bearing: 0,
    });
    expect(builtDefault.category).toBe('other');
    expect(builtDefault.emoji).toBe('⭐');

    // filterAndValidateFavorites の補完
    const rawLegacy = {
      id: 'legacy-fav-1',
      name: '旧お気に入り',
      center: [139.5, 35.5],
      zoom: 10,
      pitch: 40,
      bearing: 0,
      elevation: 50,
      region: '関東',
      emoji: '⭐',
      description: '',
      isFavorite: true,
    };
    const { valid } = filterAndValidateFavorites([rawLegacy]);
    expect(valid.length).toBe(1);
    expect(valid[0].category).toBe('other');
  });
});

describe('Inspector: お気に入り登録・編集モーダルでの4カテゴリ選択UI検証', () => {
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

  const dummyPoint: InspectorPoint = {
    lng: 139.7,
    lat: 35.6,
    elevation: 50,
    precipitation: 0,
  };

  it('新規登録時に4カテゴリボタンが表示され、初期選択が「自然」で、選択変更して保存できること', async () => {
    const onSaveFavorite = vi.fn().mockResolvedValue({ success: true });
    await act(async () => {
      root.render(
        <Inspector
          point={dummyPoint}
          onClose={vi.fn()}
          onSaveFavorite={onSaveFavorite}
        />
      );
    });

    // 「お気に入りに追加」ボタンをクリックして編集フォームを開く
    const openBtn = host.querySelector('#inspector-fav-open-btn') as HTMLButtonElement;
    expect(openBtn).not.toBeNull();
    await act(async () => {
      openBtn.click();
    });

    // 4つのカテゴリボタンが描画されていること
    const radioGroup = host.querySelector('div[role="radiogroup"][aria-label="お気に入りカテゴリ"]');
    expect(radioGroup).not.toBeNull();
    const catButtons = radioGroup?.querySelectorAll('button[role="radio"]');
    expect(catButtons?.length).toBe(4);

    // 初期選択は「自然 (nature)」
    const natureBtn = Array.from(catButtons ?? []).find((b) => b.textContent?.includes('自然')) as HTMLButtonElement;
    expect(natureBtn).toBeDefined();
    expect(natureBtn.getAttribute('aria-checked')).toBe('true');

    // 「観光 (tourism)」ボタンをクリック
    const tourismBtn = Array.from(catButtons ?? []).find((b) => b.textContent?.includes('観光')) as HTMLButtonElement;
    expect(tourismBtn).toBeDefined();
    await act(async () => {
      tourismBtn.click();
    });
    expect(tourismBtn.getAttribute('aria-checked')).toBe('true');
    expect(natureBtn.getAttribute('aria-checked')).toBe('false');

    // 保存ボタンを押下
    const saveBtn = host.querySelector('#inspector-fav-save-btn') as HTMLButtonElement;
    await act(async () => {
      saveBtn.click();
    });

    // onSaveFavorite に選択した 'tourism' が渡されること
    expect(onSaveFavorite).toHaveBeenCalledWith(expect.any(String), 'tourism');
  });

  it('既存お気に入りの編集時、保存済みの category が初期選択されていること', async () => {
    const existingFav: PresetLocation = {
      id: 'fav-home',
      name: '自宅',
      center: [139.7, 35.6],
      zoom: 13,
      pitch: 45,
      bearing: 0,
      elevation: 30,
      region: '東京',
      emoji: '🏠',
      description: '',
      isFavorite: true,
      category: 'lifestyle',
    };

    await act(async () => {
      root.render(
        <Inspector
          point={dummyPoint}
          matchedFavorite={existingFav}
          onClose={vi.fn()}
          onSaveFavorite={vi.fn()}
        />
      );
    });

    // 編集ボタンをクリック
    const editBtn = host.querySelector('#inspector-fav-edit-btn') as HTMLButtonElement;
    expect(editBtn).not.toBeNull();
    await act(async () => {
      editBtn.click();
    });

    // 「生活」が初期選択されていること
    const lifestyleBtn = host.querySelector('button[role="radio"][aria-checked="true"]');
    expect(lifestyleBtn?.textContent).toContain('生活');
  });
});

describe('PresetNav: お気に入り一覧のカテゴリバッジと絞り込みタブ検証', () => {
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

  const dummyPresets: PresetLocation[] = [
    {
      id: 'fuji',
      name: '富士山',
      center: [138.7, 35.3],
      zoom: 12,
      pitch: 60,
      bearing: 0,
      elevation: 3776,
      region: '中部',
      emoji: '🗻',
      description: '',
    },
  ];

  const favNature: PresetLocation = {
    id: 'fav-nat',
    name: '上高地',
    center: [137.6, 36.2],
    zoom: 12,
    pitch: 50,
    bearing: 0,
    elevation: 1500,
    region: '中部',
    emoji: '🌲',
    description: '',
    isFavorite: true,
    category: 'nature',
  };

  const favTourism: PresetLocation = {
    id: 'fav-tour',
    name: '清水寺',
    center: [135.7, 34.9],
    zoom: 13,
    pitch: 45,
    bearing: 0,
    elevation: 200,
    region: '近畿',
    emoji: '📸',
    description: '',
    isFavorite: true,
    category: 'tourism',
  };

  const favOther: PresetLocation = {
    id: 'fav-oth',
    name: '旧登録地点',
    center: [139.3, 35.6],
    zoom: 11,
    pitch: 40,
    bearing: 0,
    elevation: 50,
    region: '関東',
    emoji: '⭐',
    description: '',
    isFavorite: true,
    // category 未設定 (旧データ)
  };

  it('一覧上部に4カテゴリボタンが表示され、絞り込み・トグル解除・タイトルクリックによる全件復帰ができること', async () => {
    await act(async () => {
      root.render(
        <PresetNav
          presets={dummyPresets}
          favorites={[favNature, favTourism, favOther]}
          activePreset={dummyPresets[0]}
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

    // カテゴリ絞り込みボタンが4つ（自然・観光・生活・その他）存在すること（「すべて」はタイトルボタン化）
    const filterTabs = host.querySelectorAll('div[role="tablist"][aria-label="カテゴリで絞り込み"] button[role="tab"]');
    expect(filterTabs.length).toBe(4);

    // 初期状態（すべて）では3件表示
    let list = host.querySelector('#preset-favorite-list');
    let items = list?.querySelectorAll(':scope > div');
    expect(items?.length).toBe(3);

    // 「自然」タブをクリック
    const natureTab = Array.from(filterTabs).find((t) => t.textContent?.includes('自然')) as HTMLButtonElement;
    expect(natureTab).toBeDefined();
    await act(async () => {
      natureTab.click();
    });

    // 「上高地」のみ1件表示
    list = host.querySelector('#preset-favorite-list');
    items = list?.querySelectorAll(':scope > div');
    expect(items?.length).toBe(1);
    expect(items?.[0].textContent).toContain('上高地');

    // 選択中の「自然」タブを再度クリック（トグルで全件表示に戻ること）
    await act(async () => {
      natureTab.click();
    });
    list = host.querySelector('#preset-favorite-list');
    items = list?.querySelectorAll(':scope > div');
    expect(items?.length).toBe(3);

    // 「その他」タブをクリック（category 未設定の旧データが 'other' として抽出されること）
    const otherTab = Array.from(filterTabs).find((t) => t.textContent?.includes('その他')) as HTMLButtonElement;
    await act(async () => {
      otherTab.click();
    });

    list = host.querySelector('#preset-favorite-list');
    items = list?.querySelectorAll(':scope > div');
    expect(items?.length).toBe(1);
    expect(items?.[0].textContent).toContain('旧登録地点');

    // カテゴリ選択中はタイトルが「すべて表示 (3件)」に切り替わること、クリックして全件表示に戻ること
    const titleBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('すべて表示 (3件)')
    ) as HTMLButtonElement;
    expect(titleBtn).toBeDefined();
    await act(async () => {
      titleBtn.click();
    });

    list = host.querySelector('#preset-favorite-list');
    items = list?.querySelectorAll(':scope > div');
    expect(items?.length).toBe(3);

    // 全件表示復帰後はタイトルが「お気に入り (3件)」に戻ること
    const restoredTitleBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('お気に入り (3件)')
    );
    expect(restoredTitleBtn).toBeDefined();

    // アイテム先頭にカテゴリのアイコンバッジ要素が存在すること
    const badge = items?.[0].querySelector('div[title*="カテゴリ"]');
    expect(badge).not.toBeNull();
  });
});
