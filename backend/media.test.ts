import { afterEach, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApi } from './api';
import { readConfig } from './config';
import { checkPortrait, createMedia } from './media';
import { createBee, swarmReference } from './providers/bee';
const image = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89';
const bytes = Buffer.from(image.slice(23), 'base64'), ref = swarmReference(bytes);
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()); }))); });
it('uploads and reads an actual WebP by its Swarm BMT reference', async () => {
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST'
    ? new Response(JSON.stringify({ reference: ref }), { status: 201, headers: { 'content-type': 'application/json' } })
    : new Response(bytes));
  const service = createMedia(createBee({ url: 'http://bee', batchId: 'b'.repeat(64), fetch: fetcher }));
  expect(await service.upload(image)).toEqual({ image: `bzz://${ref}`, reference: ref, size: bytes.length, bmt: 'verified' });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect((await service.read(ref)).bytes).toEqual(new Uint8Array(bytes));
});
it('rejects changed content, oversized bodies and false upload references', async () => {
  const bee = (response: () => Response) => createBee({ url: 'http://bee', batchId: 'b'.repeat(64), fetch: async () => response() });
  await expect(bee(() => new Response(bytes)).download('a'.repeat(64))).rejects.toThrow('does not match');
  await expect(bee(() => new Response(JSON.stringify({ reference: 'a'.repeat(64) }))).upload(bytes)).rejects.toThrow('does not match');
  await expect(bee(() => new Response(bytes, { headers: { 'content-length': '999999999' } })).download(ref)).rejects.toThrow('too large');
});
it('rejects non-images, animation, malformed RIFF sizes and metadata before upload', async () => {
  const upload = vi.fn(); const service = createMedia({ upload } as any);
  await expect(service.upload('javascript:alert(1)')).rejects.toMatchObject({ status: 400 });
  await expect(service.upload(`bzz://${ref}`)).rejects.toMatchObject({ status: 400 });
  const invalid = Buffer.from(bytes); invalid.writeUInt32LE(999, 4);
  expect(() => checkPortrait(invalid)).toThrow();
  const animation = Buffer.concat([bytes.subarray(0, 12), Buffer.from('ANIM'), Buffer.alloc(4)]);
  animation.writeUInt32LE(animation.length - 8, 4);
  expect(() => checkPortrait(animation)).toThrow();
  expect(upload).not.toHaveBeenCalled();
});
it('requires a linked wallet to upload and serves verified public media with image headers', async () => {
  const media = { upload: vi.fn(async () => ({ image: `bzz://${ref}`, bmt: 'verified' as const, reference: ref, size: bytes.length })),
    read: vi.fn(async () => ({ ref, bytes, bmt: 'verified' as const })) };
  const server = createApi({ config: readConfig({}), ledger: null, media, authenticate: async auth => {
    if (!auth) throw new (await import('./auth')).ApiError(401, 'unauthorized', 'Sign in.');
    return { userId: 'test', wallets: ['0x' + 'a'.repeat(40)] };
  } });
  servers.push(server); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = (wallet: string, auth?: string) => fetch(`${base}/api/media`, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify({ image, wallet }) });
  expect((await post('0x' + 'a'.repeat(40))).status).toBe(401);
  expect((await post('0x' + 'b'.repeat(40), 'Bearer test')).status).toBe(403);
  expect(media.upload).not.toHaveBeenCalled();
  expect((await post('0x' + 'a'.repeat(40), 'Bearer test')).status).toBe(201);
  const r = await fetch(`${base}/api/media/${ref}`);
  expect(r.status).toBe(200); expect(r.headers.get('content-type')).toBe('image/webp');
  expect(r.headers.get('x-swarm-integrity')).toBe('verified');
  expect(Buffer.from(await r.arrayBuffer())).toEqual(bytes);
  expect((await fetch(`${base}/api/media/${'a'.repeat(128)}`)).status).toBe(400);
});
