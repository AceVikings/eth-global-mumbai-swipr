/** Delete bounded batches, waiting for the index before preparing another wallet write. */
export async function clearWalletRecords<T extends { entities: { key: string }[] }>(
  read: () => Promise<T>, remove: (keys: string[]) => Promise<void>,
  wait = () => new Promise<void>(resolve => setTimeout(resolve, 1000)),
): Promise<T> {
  let manifest = await read();
  for (let batch = 0; batch < 20; batch++) {
    if (!manifest.entities.length) return manifest;
    const keys = manifest.entities.slice(0, 100).map(e => e.key);
    const pending = new Set(keys);
    await remove(keys);
    for (let attempt = 0; attempt < 20; attempt++) {
      manifest = await read();
      if (!manifest.entities.some(e => pending.has(e.key))) break;
      if (attempt === 19) throw new Error('The deletion is confirmed, but its index is still updating. Retry account deletion shortly.');
      await wait();
    }
  }
  if (manifest.entities.length) throw new Error('More data remains. Retry deletion to continue; your login has been kept.');
  return manifest;
}
