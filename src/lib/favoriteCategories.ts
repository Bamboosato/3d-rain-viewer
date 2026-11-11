import type { ComponentType } from 'react';
import { MountainSnow, Camera, Home, Star, type LucideProps } from 'lucide-react';

export type FavoriteCategory = 'nature' | 'tourism' | 'lifestyle' | 'other';

export interface FavoriteCategoryMeta {
  id: FavoriteCategory;
  label: string;
  icon: ComponentType<LucideProps>;
  colorClass: string;
  activeBgClass: string;
  badgeBgClass: string;
  borderColor: string;
  markerBg: string;
  markerBorder: string;
  emoji: string;
  svgPath: string;
}

export const FAVORITE_CATEGORIES: Record<FavoriteCategory, FavoriteCategoryMeta> = {
  nature: {
    id: 'nature',
    label: '自然',
    icon: MountainSnow,
    colorClass: 'bg-emerald-600 text-white',
    activeBgClass: 'bg-emerald-600 border-emerald-400 text-white shadow-emerald-500/30',
    badgeBgClass: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
    borderColor: 'border-emerald-500',
    markerBg: 'rgba(5, 150, 105, 0.95)', // emerald-600
    markerBorder: 'rgba(52, 211, 153, 0.9)', // emerald-400
    emoji: '🌲',
    svgPath: '<path d="m8 3 4 8 5-5 5 15H2L8 3z"/><path d="M4.14 15.08c2.62-1.57 5.24-1.43 7.86.42 2.74 1.94 5.49 2 8.23.19"/>',
  },
  tourism: {
    id: 'tourism',
    label: '観光',
    icon: Camera,
    colorClass: 'bg-amber-600 text-white',
    activeBgClass: 'bg-amber-600 border-amber-400 text-white shadow-amber-500/30',
    badgeBgClass: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
    borderColor: 'border-amber-500',
    markerBg: 'rgba(217, 119, 6, 0.95)', // amber-600
    markerBorder: 'rgba(251, 191, 36, 0.9)', // amber-400
    emoji: '📸',
    svgPath: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  },
  lifestyle: {
    id: 'lifestyle',
    label: '生活',
    icon: Home,
    colorClass: 'bg-indigo-600 text-white',
    activeBgClass: 'bg-indigo-600 border-indigo-400 text-white shadow-indigo-500/30',
    badgeBgClass: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40',
    borderColor: 'border-indigo-500',
    markerBg: 'rgba(79, 70, 229, 0.95)', // indigo-600
    markerBorder: 'rgba(129, 140, 248, 0.9)', // indigo-400
    emoji: '🏠',
    svgPath: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  },
  other: {
    id: 'other',
    label: 'その他',
    icon: Star,
    colorClass: 'bg-slate-600 text-white',
    activeBgClass: 'bg-slate-600 border-slate-400 text-white shadow-slate-500/30',
    badgeBgClass: 'bg-slate-500/20 text-slate-300 border-slate-500/40',
    borderColor: 'border-slate-500',
    markerBg: 'rgba(71, 85, 105, 0.95)', // slate-600
    markerBorder: 'rgba(148, 163, 184, 0.9)', // slate-400
    emoji: '⭐',
    svgPath: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  },
};

export const FAVORITE_CATEGORY_KEYS: FavoriteCategory[] = ['nature', 'tourism', 'lifestyle', 'other'];

export const FAVORITE_CATEGORY_LIST: FavoriteCategoryMeta[] = [
  FAVORITE_CATEGORIES.nature,
  FAVORITE_CATEGORIES.tourism,
  FAVORITE_CATEGORIES.lifestyle,
  FAVORITE_CATEGORIES.other,
];

export function isFavoriteCategory(val: unknown): val is FavoriteCategory {
  return typeof val === 'string' && val in FAVORITE_CATEGORIES;
}

export function getFavoriteCategoryMeta(category?: unknown): FavoriteCategoryMeta {
  if (isFavoriteCategory(category)) {
    return FAVORITE_CATEGORIES[category];
  }
  return FAVORITE_CATEGORIES.other;
}

export function createCategorySvgString(category: FavoriteCategory, size = 14): string {
  const meta = getFavoriteCategoryMeta(category);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${meta.svgPath}</svg>`;
}
