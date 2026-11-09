import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react(), {
    name: 'rain3d-shell-manifest',
    async writeBundle(options, bundle) {
      const swPath = resolve(options.dir ?? 'dist', 'sw.js');
      const assets = [...new Set(['/index.html', ...Object.keys(bundle).filter(name => /\.(js|css)$/.test(name)).map(name => '/' + name)])];
      const sw = await readFile(swPath, 'utf8');
      await writeFile(swPath, sw.replace('/*BUILD_ASSETS*/', assets.map(name => JSON.stringify(name)).join(', ')));
    },
  }],
  build: {
    target: 'esnext',
  },
});
