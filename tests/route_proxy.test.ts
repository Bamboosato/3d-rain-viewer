// Perspectives:
// - Functional: POST /api/route validation, ORS GeoJSON forwarding, Authorization header injection.
// - Error/Boundary: GET -> 405, missing ORS_API_KEY -> 500, oversized body -> 413, invalid profile/coords -> 400,
//   ORS 401/403 -> 502, ORS 429 -> 429, ORS 2010/2004 -> 400 with Japanese message, timeout -> 504.
// - Security: API key must never appear in response body or headers under any failure or success path.

import { describe, it, expect, vi } from 'vitest';
import { handleRouteRequest } from '../api/route';

function makePostRequest(body: unknown, signal?: AbortSignal): Request {
  return new Request('https://example.com/api/route', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal,
  });
}

describe('api/route handleRouteRequest', () => {
  it('GET リクエストには 405 Method Not Allowed を返すこと', async () => {
    const req = new Request('https://example.com/api/route', { method: 'GET' });
    const res = await handleRouteRequest(req, 'secret-key');
    expect(res.status).toBe(405);
    const json = await res.json();
    expect(json.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('ORS_API_KEY が未設定の場合は 500 と分かりやすい JSON エラーを返すこと', async () => {
    const req = makePostRequest({
      profile: 'driving-car',
      coordinates: [
        [139.7671, 35.6812],
        [138.7274, 35.3606],
      ],
    });
    const res = await handleRouteRequest(req, undefined);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.code).toBe('MISSING_API_KEY');
    expect(json.error).toContain('ORS_API_KEY');
  });

  it('不正な profile や不正な coordinates は上流へ送らず 400 を返すこと', async () => {
    const fetchMock = vi.fn();

    const badProfileRes = await handleRouteRequest(
      makePostRequest({
        profile: 'wheelchair',
        coordinates: [
          [139.76, 35.68],
          [138.72, 35.36],
        ],
      }),
      'test-key',
      fetchMock as any
    );
    expect(badProfileRes.status).toBe(400);
    expect((await badProfileRes.json()).code).toBe('INVALID_PROFILE');

    const badCoordRes = await handleRouteRequest(
      makePostRequest({
        profile: 'foot-hiking',
        coordinates: [[139.76, 35.68]],
      }),
      'test-key',
      fetchMock as any
    );
    expect(badCoordRes.status).toBe(400);
    expect((await badCoordRes.json()).code).toBe('INVALID_COORDINATES');

    const outOfRangeRes = await handleRouteRequest(
      makePostRequest({
        profile: 'driving-car',
        coordinates: [
          [200, 35.68],
          [138.72, 35.36],
        ],
      }),
      'test-key',
      fetchMock as any
    );
    expect(outOfRangeRes.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('16KB 超のボディは 413 PAYLOAD_TOO_LARGE を返すこと', async () => {
    const huge = 'x'.repeat(17000);
    const res = await handleRouteRequest(makePostRequest(huge), 'test-key');
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('正常リクエスト時に ORS_API_KEY を Authorization ヘッダーに付与して GeoJSON を返すこと', async () => {
    const sampleGeoJson = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              [139.7671, 35.6812],
              [138.7274, 35.3606],
            ],
          },
          properties: {
            summary: { distance: 120000, duration: 7200 },
          },
        },
      ],
    };

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Response(JSON.stringify(sampleGeoJson), {
        status: 200,
        headers: { 'Content-Type': 'application/geo+json' },
      });
    });

    const secret = 'ORS_SUPER_SECRET_KEY_12345';
    const res = await handleRouteRequest(
      makePostRequest({
        profile: 'foot-hiking',
        coordinates: [
          [139.7671, 35.6812],
          [138.7274, 35.3606],
        ],
      }),
      secret,
      fetchMock as any
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(
      'https://api.heigit.org/openrouteservice/v2/directions/foot-hiking/geojson'
    );
    expect((calledInit?.headers as Record<string, string>)?.Authorization).toBe(secret);
    const sentBody = JSON.parse(String(calledInit?.body));
    expect(sentBody.radiuses).toEqual([1500, 1500]);

    const bodyText = await res.text();
    expect(bodyText).not.toContain(secret);
    expect(JSON.parse(bodyText).type).toBe('FeatureCollection');
  });

  it('ORS エラー (401 / 429 / 2010 / 2004) 時に API キーを露出せず適切に変換すること', async () => {
    const secret = 'SECRET_KEY_NEVER_LEAK';

    const authFail = await handleRouteRequest(
      makePostRequest({
        profile: 'driving-car',
        coordinates: [
          [139.76, 35.68],
          [138.72, 35.36],
        ],
      }),
      secret,
      (async () =>
        new Response(
          JSON.stringify({ error: { message: `Invalid token ${secret}` } }),
          { status: 401 }
        )) as any
    );
    expect(authFail.status).toBe(502);
    const authText = await authFail.text();
    expect(authText).not.toContain(secret);
    expect(JSON.parse(authText).code).toBe('UPSTREAM_AUTH_ERROR');

    const rateLimit = await handleRouteRequest(
      makePostRequest({
        profile: 'driving-car',
        coordinates: [
          [139.76, 35.68],
          [138.72, 35.36],
        ],
      }),
      secret,
      (async () => new Response('{}', { status: 429 })) as any
    );
    expect(rateLimit.status).toBe(429);
    expect((await rateLimit.json()).code).toBe('RATE_LIMITED');

    const pointNotFound = await handleRouteRequest(
      makePostRequest({
        profile: 'foot-hiking',
        coordinates: [
          [139.76, 35.68],
          [138.72, 35.36],
        ],
      }),
      secret,
      (async () =>
        new Response(
          JSON.stringify({ error: { code: 2010, message: 'Could not find point 0' } }),
          { status: 404 }
        )) as any
    );
    expect(pointNotFound.status).toBe(400);
    expect((await pointNotFound.json()).code).toBe('POINT_NOT_FOUND');

    const limitExceeded = await handleRouteRequest(
      makePostRequest({
        profile: 'driving-car',
        coordinates: [
          [139.76, 35.68],
          [138.72, 35.36],
        ],
      }),
      secret,
      (async () =>
        new Response(
          JSON.stringify({ error: { code: 2004, message: 'Distance limit exceeded' } }),
          { status: 400 }
        )) as any
    );
    expect(limitExceeded.status).toBe(400);
    expect((await limitExceeded.json()).code).toBe('LIMIT_EXCEEDED');
  });
});
