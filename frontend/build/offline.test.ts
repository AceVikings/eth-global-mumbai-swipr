import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { createOfflineWorker } from './offline';

const assets = { '/assets/app.js': 'app-v1', '/assets/app.js.map': 'source-map' };
const publicAssets = { '/assets/portrait.jpg': new Uint8Array([1, 2]), '/manifest.webmanifest': new Uint8Array([3]) };

describe('offline worker build and runtime', () => {
  it('versions contents even when public filenames stay the same', () => {
    const original = createOfflineWorker(assets, publicAssets, '<html>v1</html>');
    expect(createOfflineWorker(assets, publicAssets, '<html>v1</html>').version).toBe(original.version);
    expect(createOfflineWorker(assets, { ...publicAssets, '/assets/portrait.jpg': new Uint8Array([9]) }, '<html>v1</html>').version).not.toBe(original.version);
    expect(createOfflineWorker(assets, publicAssets, '<html>v2</html>').version).not.toBe(original.version);
    expect(createOfflineWorker({ ...assets, '/assets/app.js': 'app-v2' }, publicAssets, '<html>v1</html>').version).not.toBe(original.version);
  });

  it('includes the shell and emitted assets, never source maps or APIs', () => {
    const { files } = createOfflineWorker({ ...assets, '/api/private': 'sensitive' }, publicAssets, 'shell');
    expect(files).toEqual(expect.arrayContaining(['/', '/index.html', '/manifest.webmanifest', '/assets/app.js', '/assets/portrait.jpg']));
    expect(files).not.toContain('/assets/app.js.map');
    expect(files).not.toContain('/api/private');
  });

  it('serves only owned static cache entries and bypasses API, external and non-GET requests', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    const matches: unknown[] = [];
    const cached = { body: 'cached' };
    runInNewContext(createOfflineWorker(assets, publicAssets, 'shell').source, {
      URL, Request,
      self: { location: { origin: 'https://swipr.example' }, addEventListener: (name: string, handler: any) => { handlers[name] = handler; } },
      caches: { open: async () => ({ match: async (request: unknown, options: unknown) => { matches.push({ request, options }); return cached; } }) },
      fetch: async () => { throw new Error('offline'); },
    });
    const dispatch = async (path: string, method = 'GET', mode = 'cors') => {
      let response: Promise<unknown> | undefined;
      const request = { url: new URL(path, 'https://swipr.example').href, method, mode };
      handlers.fetch({ request, respondWith: (value: Promise<unknown>) => { response = value; } });
      return { handled: !!response, result: await response };
    };
    expect((await dispatch('/assets/app.js')).result).toEqual(cached);
    expect((matches[0] as any).options.ignoreVary).toBe(true);
    expect((await dispatch('/page', 'GET', 'navigate')).result).toEqual(cached);
    expect(await dispatch('/api/quotes')).toEqual({ handled: false, result: undefined });
    expect((await dispatch('https://wallet.example/private')).handled).toBe(false);
    expect((await dispatch('/assets/app.js', 'POST')).handled).toBe(false);
    expect((await dispatch('/unknown.json')).handled).toBe(false);
  });
});
