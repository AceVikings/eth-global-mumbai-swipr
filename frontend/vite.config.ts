import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOfflineWorker } from './build/offline';

function offlineShell(): Plugin {
  let root = process.cwd();
  return {
    name: 'swipr-offline-shell',
    configResolved(config) { root = config.root; },
    generateBundle(_options, bundle) {
      const contents = Object.fromEntries(Object.values(bundle).map(file => [
        `/${file.fileName}`, file.type === 'chunk' ? file.code : file.source,
      ]));
      // Only public assets used by this website belong in the offline shell.
      // Fonts are already fingerprinted and present in the emitted bundle.
      const publicPaths = ['/manifest.webmanifest', ...[
        'mark.svg', 'icon-192.png', 'icon-512.png',
      ].map(file => `/assets/${file}`)];
      const publicContents = Object.fromEntries(publicPaths.map(path => [path,
        readFileSync(resolve(root, 'public', path.slice(1))),
      ]));
      const { source } = createOfflineWorker(contents, publicContents, readFileSync(resolve(root, 'index.html'), 'utf8'));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}
const frontendRoot = dirname(fileURLToPath(import.meta.url));
export default defineConfig({ root: frontendRoot, envDir: resolve(frontendRoot, '..'), server: { proxy: { '/api': 'http://127.0.0.1:8787', '/mcp': 'http://127.0.0.1:8787' } }, plugins: [react(), tailwind(), offlineShell()] });
