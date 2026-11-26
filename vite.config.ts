import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { handleRouteRequest } from './api/route';

const MAX_DEV_BODY_BYTES = 16384;

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const orsApiKey = env.ORS_API_KEY || process.env.ORS_API_KEY;

  return {
    plugins: [
      react(),
      {
        name: 'ors-route-dev-proxy',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            const pathname = (req.url ?? '').split('?')[0];
            if (pathname !== '/api/route') {
              next();
              return;
            }

            try {
              const method = req.method ?? 'GET';
              const chunks: Buffer[] = [];
              let totalBytes = 0;
              let payloadTooLarge = false;

              if (method !== 'GET' && method !== 'HEAD') {
                await new Promise<void>((resolveRead, rejectRead) => {
                  req.on('data', (chunk: Buffer | string) => {
                    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                    totalBytes += buf.byteLength;
                    if (totalBytes > MAX_DEV_BODY_BYTES) {
                      payloadTooLarge = true;
                      return;
                    }
                    chunks.push(buf);
                  });
                  req.on('end', () => resolveRead());
                  req.on('error', err => rejectRead(err));
                });
              }

              if (payloadTooLarge) {
                res.statusCode = 413;
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.setHeader('Cache-Control', 'no-store');
                res.end(
                  JSON.stringify({
                    error: 'Request payload too large.',
                    code: 'PAYLOAD_TOO_LARGE',
                  })
                );
                return;
              }

              const headers = new Headers();
              for (const [key, value] of Object.entries(req.headers)) {
                if (typeof value === 'string') {
                  headers.set(key, value);
                } else if (Array.isArray(value)) {
                  headers.set(key, value.join(', '));
                }
              }

              const abortController = new AbortController();
              res.on('close', () => {
                if (!res.writableEnded) {
                  abortController.abort();
                }
              });

              const webRequest = new Request('http://localhost/api/route', {
                method,
                headers,
                body:
                  method === 'GET' || method === 'HEAD'
                    ? undefined
                    : Buffer.concat(chunks),
                signal: abortController.signal,
              });

              const webResponse = await handleRouteRequest(webRequest, orsApiKey);
              res.statusCode = webResponse.status;
              webResponse.headers.forEach((value, key) => {
                res.setHeader(key, value);
              });
              const bodyBuffer = Buffer.from(await webResponse.arrayBuffer());
              res.end(bodyBuffer);
            } catch {
              if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.end(
                  JSON.stringify({
                    error: 'ローカル開発プロキシでエラーが発生しました。',
                    code: 'DEV_PROXY_ERROR',
                  })
                );
              }
            }
          });
        },
      },
      {
        name: 'rain3d-shell-manifest',
        async writeBundle(options, bundle) {
          const swPath = resolve(options.dir ?? 'dist', 'sw.js');
          const assets = [
            ...new Set([
              '/index.html',
              ...Object.keys(bundle)
                .filter(name => /\.(js|css)$/.test(name))
                .map(name => '/' + name),
            ]),
          ];
          const sw = await readFile(swPath, 'utf8');
          await writeFile(
            swPath,
            sw.replace('/*BUILD_ASSETS*/', assets.map(name => JSON.stringify(name)).join(', '))
          );
        },
      },
    ],
    build: {
      target: 'esnext',
    },
  };
});
