import { HYAKUMEIZAN_PRESETS } from './hyakumeizanData';

export interface OsmPlaceCandidate {
  /** 候補となる施設名・ランドマーク名・地名 */
  name: string;
  /** カテゴリ表示ラベル（例: '山頂', '山小屋', '駅', '施設', '地名' など） */
  category: string;
  /** クリック地点からの概算距離（メートル）。住所・広域地名の場合は undefined */
  distanceMeters?: number;
  /** 取得元サービス */
  source: 'overpass' | 'nominatim' | 'local';
}

interface CacheEntry {
  candidates: OsmPlaceCandidate[];
  timestamp: number;
}

const CACHE_TTL_MS = 1000 * 60 * 30; // 30分キャッシュ
const candidateCache = new Map<string, CacheEntry>();

const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/**
 * 2点間の経緯度から概算距離（メートル）を算出（Haversine公式）
 */
function calcDistanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

/**
 * OSMタグから日本語のわかりやすいカテゴリ名と優先度スコア（低いほど優先）を判定
 */
function classifyOsmTags(tags: Record<string, string>): {
  category: string;
  priority: number;
} | null {
  // 道路そのものや行政境界線・河川などは施設候補から除外（登山口やバス停・SA/PAは残す）
  if (tags.boundary === 'administrative' || tags.boundary === 'postal_code') {
    return null;
  }
  if (
    tags.highway &&
    !['trailhead', 'bus_stop', 'rest_area', 'services', 'Mountain_pass'].includes(tags.highway) &&
    !tags.tourism &&
    !tags.amenity &&
    !tags.Natural &&
    !tags.natural
  ) {
    return null;
  }
  if (tags.waterway && !tags.tourism && !tags.natural) {
    return null;
  }

  // 山岳・自然ランドマーク
  if (tags.natural === 'peak' || tags.natural === 'volcano') {
    return { category: '山頂', priority: 1 };
  }
  if (tags.natural === 'saddle' || tags.mountain_pass === 'yes') {
    return { category: '峠・鞍部', priority: 2 };
  }
  if (tags.highway === 'trailhead') {
    return { category: '登山口', priority: 1 };
  }
  if (tags.tourism === 'alpine_hut' || tags.tourism === 'wilderness_hut') {
    return { category: '山小屋', priority: 1 };
  }
  if (tags.tourism === 'camp_site' || tags.tourism === 'caravan_site') {
    return { category: 'キャンプ場', priority: 1 };
  }
  if (tags.tourism === 'viewpoint') {
    return { category: '展望地', priority: 2 };
  }
  if (tags.natural === 'hot_spring' || tags.amenity === 'public_bath' || tags.bath === 'onsen') {
    return { category: '温泉', priority: 2 };
  }
  if (
    tags.natural === 'spring' ||
    tags.natural === 'cape' ||
    tags.natural === 'waterfall' ||
    tags.waterway === 'waterfall' ||
    tags.natural === 'water'
  ) {
    return { category: '自然・景勝', priority: 2 };
  }

  // 交通・駅・バス停・道の駅
  if (tags.railway === 'station' || tags.railway === 'halt' || tags.public_transport === 'station') {
    return { category: '駅', priority: 1 };
  }
  if (tags.aerialway === 'station') {
    return { category: 'ロープウェイ', priority: 1 };
  }
  if (tags.highway === 'rest_area' || tags.highway === 'services') {
    return { category: 'SA・道の駅', priority: 2 };
  }
  if (tags.highway === 'bus_stop') {
    return { category: 'バス停', priority: 3 };
  }
  if (tags.aeroway === 'aerodrome' || tags.aeroway === 'terminal') {
    return { category: '空港', priority: 1 };
  }

  // 観光・宿泊・レジャー・公園
  if (
    tags.tourism === 'attraction' ||
    tags.tourism === 'museum' ||
    tags.tourism === 'theme_park' ||
    tags.tourism === 'zoo' ||
    tags.tourism === 'aquarium' ||
    tags.tourism === 'information'
  ) {
    return { category: '観光施設', priority: 2 };
  }
  if (
    tags.tourism === 'hotel' ||
    tags.tourism === 'guest_house' ||
    tags.tourism === 'chalet' ||
    tags.tourism === 'hostel' ||
    tags.tourism === 'motel'
  ) {
    return { category: '宿泊施設', priority: 2 };
  }
  if (
    tags.leisure === 'park' ||
    tags.leisure === 'nature_reserve' ||
    tags.leisure === 'garden' ||
    tags.leisure === 'stadium' ||
    tags.leisure === 'sports_centre' ||
    tags.leisure === 'golf_course'
  ) {
    return { category: '公園・レジャー', priority: 2 };
  }
  if (tags.amenity === 'place_of_worship' || tags.historic) {
    return { category: '寺社・史跡', priority: 2 };
  }

  // 公共・商業施設・建物
  if (tags.amenity === 'school' || tags.amenity === 'university' || tags.amenity === 'college') {
    return { category: '学校・教育', priority: 3 };
  }
  if (tags.amenity === 'hospital' || tags.amenity === 'clinic') {
    return { category: '医療機関', priority: 3 };
  }
  if (tags.amenity === 'townhall' || tags.amenity === 'community_centre' || tags.amenity === 'library') {
    return { category: '公共施設', priority: 2 };
  }
  if (tags.amenity === 'shelter') {
    return { category: '避難小屋・東屋', priority: 2 };
  }
  if (tags.amenity || tags.shop || tags.office || tags.tourism || tags.leisure || tags.man_made) {
    return { category: '施設', priority: 3 };
  }
  if (tags.building) {
    return { category: '建物', priority: 4 };
  }
  if (tags.place) {
    return { category: '地名', priority: 4 };
  }

  return null;
}

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/**
 * Overpass API を用いてクリック座標周辺の施設・山頂・山小屋・ランドマーク候補を取得
 */
async function fetchOverpassCandidates(
  lat: number,
  lng: number,
  signal?: AbortSignal
): Promise<OsmPlaceCandidate[]> {
  // 一般施設は半径350m以内、山岳ランドマーク（山頂・山小屋・キャンプ場・展望地・峠）は半径1000m以内を検索
  const query = `
[out:json][timeout:6];
(
  nwr["name"](around:350,${lat.toFixed(5)},${lng.toFixed(5)});
  nwr["name"]["natural"~"^(peak|volcano|saddle|hot_spring|spring|waterfall|cape)$"](around:1000,${lat.toFixed(5)},${lng.toFixed(5)});
  nwr["name"]["tourism"~"^(alpine_hut|wilderness_hut|camp_site|viewpoint|information|attraction)$"](around:1000,${lat.toFixed(5)},${lng.toFixed(5)});
  nwr["name"]["highway"="trailhead"](around:1000,${lat.toFixed(5)},${lng.toFixed(5)});
);
out center tags 40;
`.trim();

  let data: { elements?: OverpassElement[] } | null = null;
  let lastError: unknown = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    if (signal?.aborted) break;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        body: `data=${encodeURIComponent(query)}`,
        signal,
      });

      if (!res.ok) {
        throw new Error(`Overpass API HTTP ${res.status}`);
      }

      data = (await res.json()) as { elements?: OverpassElement[] };
      break;
    } catch (err) {
      lastError = err;
      if (signal?.aborted) throw err;
    }
  }

  if (!data) {
    throw lastError ?? new Error('Overpass API failed');
  }

  const elements = data.elements ?? [];

  const scored: Array<OsmPlaceCandidate & { score: number }> = [];

  for (const el of elements) {
    const tags = el.tags;
    if (!tags) continue;

    const rawName = (tags['name:ja'] || tags.name || '').trim();
    if (!rawName) continue;

    const classified = classifyOsmTags(tags);
    if (!classified) continue;

    const elLat = el.lat ?? el.center?.lat;
    const elLon = el.lon ?? el.center?.lon;
    const distanceMeters =
      typeof elLat === 'number' && typeof elLon === 'number'
        ? calcDistanceMeters(lat, lng, elLat, elLon)
        : undefined;

    // 距離とカテゴリ優先度から並び替えスコアを算出
    const score = (distanceMeters ?? 300) + classified.priority * 65;

    scored.push({
      name: rawName,
      category: classified.category,
      distanceMeters,
      source: 'overpass',
      score,
    });
  }

  scored.sort((a, b) => a.score - b.score);

  const unique: OsmPlaceCandidate[] = [];
  const seen = new Set<string>();
  for (const item of scored) {
    const key = item.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({
      name: item.name,
      category: item.category,
      distanceMeters: item.distanceMeters,
      source: item.source,
    });
    if (unique.length >= 6) break;
  }

  return unique;
}

interface NominatimReverseResponse {
  name?: string;
  category?: string;
  type?: string;
  display_name?: string;
  address?: Record<string, string>;
}

/**
 * Nominatim 逆ジオコーディングを用いて直下のスポット名および市区町村・地域名候補を取得
 */
async function fetchNominatimCandidates(
  lat: number,
  lng: number,
  signal?: AbortSignal
): Promise<OsmPlaceCandidate[]> {
  const url = new URL(NOMINATIM_REVERSE_URL);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('lat', lat.toFixed(6));
  url.searchParams.set('lon', lng.toFixed(6));
  url.searchParams.set('zoom', '18');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('accept-language', 'ja');

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
    signal,
  });

  if (!res.ok) {
    throw new Error(`Nominatim API HTTP ${res.status}`);
  }

  const data = (await res.json()) as NominatimReverseResponse;
  const results: OsmPlaceCandidate[] = [];

  // 1. ピンポイントの施設・ランドマーク名がある場合（道路名を除く）
  if (data.name && data.category !== 'highway') {
    const categoryLabel =
      data.category === 'natural'
        ? '自然・山頂'
        : data.category === 'tourism'
          ? '観光・山小屋'
          : data.category === 'railway'
            ? '駅'
            : data.category === 'leisure'
              ? '公園・施設'
              : 'スポット';
    results.push({
      name: data.name.trim(),
      category: categoryLabel,
      distanceMeters: 0,
      source: 'nominatim',
    });
  }

  // 2. 住所階層から使いやすい地名候補（例: 「松本市安曇」「新宿区西新宿」など）を組み立て
  const addr = data.address;
  if (addr) {
    const pref = addr.province || addr.state || '';
    const municipality =
      addr.city || addr.town || addr.village || addr.municipality || addr.county || '';
    const district = addr.city_district || addr.ward || '';
    const locality =
      addr.suburb ||
      addr.quarter ||
      addr.neighbourhood ||
      addr.hamlet ||
      addr.isolated_dwelling ||
      addr.croft ||
      '';
    const poiName =
      addr.peak ||
      addr.alpine_hut ||
      addr.camp_site ||
      addr.tourism ||
      addr.amenity ||
      addr.leisure ||
      addr.building ||
      '';

    if (poiName && !results.some((r) => r.name === poiName)) {
      results.push({
        name: poiName.trim(),
        category: '施設',
        source: 'nominatim',
      });
    }

    // 市区町村＋町字（例: 松本市安曇、横浜市西区みなとみらい）
    const baseCity =
      municipality && district && !municipality.endsWith(district)
        ? `${municipality}${district}`
        : municipality || district;

    if (baseCity && locality && locality !== baseCity) {
      results.push({
        name: `${baseCity}${locality}`,
        category: '地名',
        source: 'nominatim',
      });
    }

    if (locality && locality !== baseCity) {
      results.push({
        name: locality,
        category: '町名・字',
        source: 'nominatim',
      });
    }

    if (baseCity) {
      results.push({
        name: pref && !baseCity.startsWith(pref) ? `${pref}${baseCity}` : baseCity,
        category: '自治体',
        source: 'nominatim',
      });
    }
  }

  return results;
}

/**
 * クリック座標から半径2.5km以内に日本百名山の山頂がある場合はローカル候補として即座に抽出
 */
function findNearbyHyakumeizanCandidates(lat: number, lng: number): OsmPlaceCandidate[] {
  const matches: OsmPlaceCandidate[] = [];
  for (const m of HYAKUMEIZAN_PRESETS) {
    const [mLng, mLat] = m.center;
    const dist = calcDistanceMeters(lat, lng, mLat, mLng);
    if (dist <= 2500) {
      matches.push({
        name: m.name,
        category: '百名山',
        distanceMeters: dist,
        source: 'local',
      });
    }
  }
  matches.sort((a, b) => (a.distanceMeters ?? 0) - (b.distanceMeters ?? 0));
  return matches.slice(0, 2);
}

/**
 * Overpass候補・Nominatim候補・ローカル百名山候補をマージして重複排除（最大7件）
 */
function mergeCandidates(
  overpassList: OsmPlaceCandidate[],
  nominatimList: OsmPlaceCandidate[],
  localList: OsmPlaceCandidate[]
): OsmPlaceCandidate[] {
  const merged: OsmPlaceCandidate[] = [];
  const seen = new Set<string>();

  const add = (item: OsmPlaceCandidate) => {
    const normalized = item.name.trim();
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    merged.push({ ...item, name: normalized });
  };

  // Nominatimで直下(0m)の施設がヒットした場合は最優先で先頭に配置
  for (const item of nominatimList) {
    if (item.distanceMeters === 0) {
      add(item);
    }
  }

  // 次にOverpassの周辺施設・山頂・山小屋候補を距離・重要度順に追加
  for (const item of overpassList) {
    add(item);
  }

  // 近傍の日本百名山（半径2.5km以内）を追加
  for (const item of localList) {
    add(item);
  }

  // 最後にNominatimの地名・市区町村候補を補足として追加
  for (const item of nominatimList) {
    if (item.distanceMeters !== 0) {
      add(item);
    }
  }

  return merged.slice(0, 7);
}

/**
 * 座標からOpenStreetMap (Overpass API + Nominatim) を用いて施設名・地名候補を取得します。
 * 片方のAPIが先に完了した段階で `onPartialUpdate` コールバックを呼ぶことで、体感待ち時間を最小化します。
 */
export async function fetchOsmPlaceCandidates(
  lat: number,
  lng: number,
  options?: {
    signal?: AbortSignal;
    onPartialUpdate?: (candidates: OsmPlaceCandidate[]) => void;
  }
): Promise<OsmPlaceCandidate[]> {
  const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const cached = candidateCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    options?.onPartialUpdate?.(cached.candidates);
    return cached.candidates;
  }

  const localResults = findNearbyHyakumeizanCandidates(lat, lng);
  let overpassResults: OsmPlaceCandidate[] = [];
  let nominatimResults: OsmPlaceCandidate[] = [];

  if (localResults.length > 0) {
    options?.onPartialUpdate?.(localResults);
  }

  const notifyPartial = () => {
    if (options?.signal?.aborted) return;
    const current = mergeCandidates(overpassResults, nominatimResults, localResults);
    if (current.length > 0) {
      options?.onPartialUpdate?.(current);
    }
  };

  const overpassPromise = fetchOverpassCandidates(lat, lng, options?.signal)
    .then((res) => {
      overpassResults = res;
      notifyPartial();
      return res;
    })
    .catch(() => [] as OsmPlaceCandidate[]);

  const nominatimPromise = fetchNominatimCandidates(lat, lng, options?.signal)
    .then((res) => {
      nominatimResults = res;
      notifyPartial();
      return res;
    })
    .catch(() => [] as OsmPlaceCandidate[]);

  await Promise.all([overpassPromise, nominatimPromise]);

  if (options?.signal?.aborted) {
    return [];
  }

  const finalCandidates = mergeCandidates(overpassResults, nominatimResults, localResults);
  if (finalCandidates.length > 0) {
    candidateCache.set(cacheKey, {
      candidates: finalCandidates,
      timestamp: Date.now(),
    });
  }

  return finalCandidates;
}
