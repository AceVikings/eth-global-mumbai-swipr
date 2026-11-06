import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { checkBundle } from './check-bundle.mjs';
const temporary = [];
afterEach(async () => Promise.all(temporary.splice(0).map(p => rm(p, { recursive: true, force: true }))));
async function artifact(text) {
  const dir = await mkdtemp(join(tmpdir(), 'swipr-bundle-'));
  temporary.push(dir);
  await mkdir(join(dir, 'assets'));
  await writeFile(join(dir, 'index.html'), '<div id="root"></div>');
  await writeFile(join(dir, 'assets', 'app.js'), text);
  return dir;
}
it('accepts an artifact with unavailable real-data states', async () => {
  expect(await checkBundle(await artifact('Rankings unavailable.'))).toEqual([]);
});
it('rejects a bundled preview fallback', async () => {
  expect(await checkBundle(await artifact('localStorage.getItem("swipr.preview-follows.v1")'))).toContain('preview data in emitted website code');
});
it('rejects a design portrait copied into the deployed public assets', async () => {
  const dir = await artifact('');
  await writeFile(join(dir, 'assets', 'alice.jpg'), 'image');
  expect(await checkBundle(dir)).toContain('design-only portrait shipped');
});
it('rejects a missing build instead of passing an empty directory', async () => {
  const dir = await artifact('');
  await rm(join(dir, 'index.html'));
  await expect(checkBundle(dir)).rejects.toThrow();
});
