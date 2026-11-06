// Check emitted website code, not test fixtures or static design studies.
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const previewMarkers = [
  'previewTraders', 'PREVIEW_ROWS', 'swipr.preview-follows.v1',
  'alice.swipr.eth', '/assets/alice.jpg', '/assets/dan.jpg', '/assets/priya.jpg',
  'Illustrative profiles. No live trades or funds.', 'Sample figures · ',
];

export async function checkBundle(directory = 'dist') {
  const failures = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (/\.(?:js|html|json)$/.test(entry.name)) {
        const text = await readFile(file, 'utf8');
        if (previewMarkers.some(marker => text.includes(marker))) failures.push('preview data in emitted website code');
      } else if (/^(alice|dan|priya)\.jpg$/.test(entry.name)) failures.push('design-only portrait shipped');
    }
  }
  await readFile(resolve(directory, 'index.html'));
  await visit(resolve(directory));
  return [...new Set(failures)];
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    const failures = await checkBundle();
    console.log(failures.length ? `BLOCKED: ${failures.join('; ')}` : 'PASS: known preview data and portraits absent from the production artifact.');
    process.exitCode = failures.length ? 1 : 0;
  } catch {
    console.error('BLOCKED: production artifact missing or unreadable. Run npm run build.');
    process.exitCode = 1;
  }
}
