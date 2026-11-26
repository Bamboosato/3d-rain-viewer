export const ALLOWED_ROUTE_PROFILES = [
  'driving-car',
  'foot-hiking',
  'cycling-regular',
] as const;

export type RouteProfile = (typeof ALLOWED_ROUTE_PROFILES)[number];

const ORS_BASE_URL = 'https://api.heigit.org/openrouteservice/v2/directions';
const MAX_REQUEST_BYTES = 16384;
const UPSTREAM_TIMEOUT_MS = 15000;

interface RouteRequestPayload {
  profile: RouteProfile;
  coordinates: [number, number][];
  radiuses?: number[];
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function isAllowedProfile(value: unknown): value is RouteProfile {
  return (
    typeof value === 'string' &&
    (ALLOWED_ROUTE_PROFILES as readonly string[]).includes(value)
  );
}

function isValidCoordinatePair(pair: unknown): pair is [number, number] {
  if (!Array.isArray(pair) || pair.length < 2 || pair.length > 3) return false;
  const [lng, lat] = pair;
  return (
    typeof lng === 'number' &&
    Number.isFinite(lng) &&
    lng >= -180 &&
    lng <= 180 &&
    typeof lat === 'number' &&
    Number.isFinite(lat) &&
    lat >= -90 &&
    lat <= 90
  );
}

function validateRoutePayload(
  raw: unknown
): { ok: true; payload: RouteRequestPayload } | { ok: false; code: string; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      error: 'リクエストボディが不正です。',
    };
  }

  const obj = raw as Record<string, unknown>;
  if (!isAllowedProfile(obj.profile)) {
    return {
      ok: false,
      code: 'INVALID_PROFILE',
      error:
        'Invalid profile. Allowed profiles: driving-car, foot-hiking, cycling-regular.',
    };
  }

  if (
    !Array.isArray(obj.coordinates) ||
    obj.coordinates.length < 2 ||
    obj.coordinates.length > 5
  ) {
    return {
      ok: false,
      code: 'INVALID_COORDINATES',
      error: 'coordinates は2〜5地点の配列で指定してください。',
    };
  }

  const coordinates: [number, number][] = [];
  for (const item of obj.coordinates) {
    if (!isValidCoordinatePair(item)) {
      return {
        ok: false,
        code: 'INVALID_COORDINATES',
        error: 'coordinates に有効な [経度, 緯度] を指定してください。',
      };
    }
    coordinates.push([item[0], item[1]]);
  }

  let radiuses: number[];
  if (obj.radiuses === undefined) {
    const defaultRadius = obj.profile === 'foot-hiking' ? 1500 : 1000;
    radiuses = coordinates.map(() => defaultRadius);
  } else {
    if (!Array.isArray(obj.radiuses) || obj.radiuses.length !== coordinates.length) {
      return {
        ok: false,
        code: 'INVALID_REQUEST',
        error: 'radiuses の件数は coordinates と一致させてください。',
      };
    }
    for (const r of obj.radiuses) {
      if (
        typeof r !== 'number' ||
        !Number.isFinite(r) ||
        (r !== -1 && (r < 1 || r > 5000))
      ) {
        return {
          ok: false,
          code: 'INVALID_REQUEST',
          error: 'radiuses には -1 または 1〜5000 の数値を指定してください。',
        };
      }
    }
    radiuses = obj.radiuses;
  }

  return {
    ok: true,
    payload: {
      profile: obj.profile,
      coordinates,
      radiuses,
    },
  };
}

function sanitizeUpstreamMessage(rawMessage: unknown, apiKey: string): string {
  if (typeof rawMessage !== 'string' || !rawMessage.trim()) {
    return 'ルート検索サービスでエラーが発生しました。';
  }
  return rawMessage.split(apiKey).join('[REDACTED]').slice(0, 300);
}

/**
 * Shared request handler for Vercel Serverless Function (`/api/route`) and Vite dev middleware.
 */
export async function handleRouteRequest(
  request: Request,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse(
      { error: 'Method Not Allowed. Use POST.', code: 'METHOD_NOT_ALLOWED' },
      405
    );
  }

  const trimmedApiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!trimmedApiKey) {
    return jsonResponse(
      {
        error:
          'サーバーに ORS_API_KEY が設定されていません。環境変数を確認してください。',
        code: 'MISSING_API_KEY',
      },
      500
    );
  }

  let rawBodyText = '';
  try {
    rawBodyText = await request.text();
  } catch {
    return jsonResponse(
      { error: 'リクエストボディを読み取れませんでした。', code: 'INVALID_REQUEST' },
      400
    );
  }

  const byteLength = new TextEncoder().encode(rawBodyText).byteLength;
  if (byteLength > MAX_REQUEST_BYTES) {
    return jsonResponse(
      { error: 'Request payload too large.', code: 'PAYLOAD_TOO_LARGE' },
      413
    );
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBodyText);
  } catch {
    return jsonResponse(
      { error: 'Invalid JSON body.', code: 'INVALID_REQUEST' },
      400
    );
  }

  const validation = validateRoutePayload(parsedBody);
  if (!validation.ok) {
    return jsonResponse(
      { error: validation.error, code: validation.code },
      400
    );
  }

  const { profile, coordinates, radiuses } = validation.payload;
  const upstreamUrl = `${ORS_BASE_URL}/${profile}/geojson`;

  const timeoutController = new AbortController();
  let timedOut = false;
  const onParentAbort = () => {
    timeoutController.abort(request.signal?.reason);
  };
  if (request.signal?.aborted) {
    timeoutController.abort(request.signal.reason);
  } else {
    request.signal?.addEventListener('abort', onParentAbort, { once: true });
  }
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, UPSTREAM_TIMEOUT_MS);

  try {
    const upstreamResponse = await fetchImpl(upstreamUrl, {
      method: 'POST',
      headers: {
        Authorization: trimmedApiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json, application/geo+json',
      },
      body: JSON.stringify({ coordinates, radiuses }),
      signal: timeoutController.signal,
    });

    const responseText = await upstreamResponse.text();
    if (upstreamResponse.ok) {
      return new Response(responseText, {
        status: 200,
        headers: {
          'Content-Type': 'application/geo+json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }

    let upstreamErrorCode: number | undefined;
    let upstreamMessage: string | undefined;
    try {
      const errJson = JSON.parse(responseText) as {
        error?: { code?: number; message?: string } | string;
        message?: string;
      };
      if (errJson && typeof errJson.error === 'object' && errJson.error !== null) {
        if (typeof errJson.error.code === 'number') {
          upstreamErrorCode = errJson.error.code;
        }
        upstreamMessage = errJson.error.message;
      } else if (typeof errJson?.error === 'string') {
        upstreamMessage = errJson.error;
      } else if (typeof errJson?.message === 'string') {
        upstreamMessage = errJson.message;
      }
    } catch {
      // upstream body was not JSON
    }

    if (upstreamResponse.status === 401 || upstreamResponse.status === 403) {
      return jsonResponse(
        {
          error:
            'ルート検索サービスの認証に失敗しました。サーバーの API キー設定を確認してください。',
          code: 'UPSTREAM_AUTH_ERROR',
        },
        502
      );
    }

    if (upstreamResponse.status === 429) {
      return jsonResponse(
        {
          error:
            'ルート検索の利用上限に達しました。しばらく待ってから再試行してください。',
          code: 'RATE_LIMITED',
        },
        429
      );
    }

    if (upstreamErrorCode === 2010) {
      return jsonResponse(
        {
          error:
            '指定地点の近くに通行可能な道路・登山道が見つかりませんでした。地点を少しずらして再試行してください。',
          code: 'POINT_NOT_FOUND',
          upstreamCode: 2010,
        },
        400
      );
    }

    if (upstreamErrorCode === 2004) {
      return jsonResponse(
        {
          error: 'ルートの距離または条件がサービス上限を超えています。',
          code: 'LIMIT_EXCEEDED',
          upstreamCode: 2004,
        },
        400
      );
    }

    const forwardStatus =
      upstreamResponse.status >= 400 && upstreamResponse.status < 500
        ? upstreamResponse.status
        : 502;
    return jsonResponse(
      {
        error: sanitizeUpstreamMessage(upstreamMessage, trimmedApiKey),
        code: 'UPSTREAM_ERROR',
        ...(upstreamErrorCode !== undefined ? { upstreamCode: upstreamErrorCode } : {}),
      },
      forwardStatus
    );
  } catch (error) {
    if (timedOut) {
      return jsonResponse(
        {
          error: 'ルート検索サービスがタイムアウトしました。',
          code: 'UPSTREAM_TIMEOUT',
        },
        504
      );
    }
    if (request.signal?.aborted) {
      return jsonResponse(
        {
          error: 'ルート検索がキャンセルされました。',
          code: 'ABORTED',
        },
        499
      );
    }
    void error;
    return jsonResponse(
      {
        error: 'ルート検索サービスへ接続できませんでした。',
        code: 'UPSTREAM_UNAVAILABLE',
      },
      502
    );
  } finally {
    clearTimeout(timeoutTimer);
    request.signal?.removeEventListener('abort', onParentAbort);
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    return handleRouteRequest(request, process.env.ORS_API_KEY);
  },
};
