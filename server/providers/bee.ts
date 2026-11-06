import { createHttp, ProviderError, type FetchLike } from './http.ts';

const REF = /^[0-9a-f]{64}$/;
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Content integrity status. Bee addresses content by its BMT root; this adapter does
 * not yet recompute that root, so every result is 'unverified' until a real BMT
 * implementation is wired in and checked against our node. A SHA-256 is not a BMT.
 */
export type BmtStatus = 'unverified';

export function checkRef(ref: string): string {
  const r = ref.toLowerCase().replace(/^0x/, '');
  if (/^[0-9a-f]{128}$/.test(r)) throw new ProviderError('bee', 'invalid', 'encrypted (128-hex) refs are never stored or fetched here');
  if (!REF.test(r)) throw new ProviderError('bee', 'invalid', 'ref must be 64 hex chars');
  return r;
}

export function createBee(o: { url: string; batchId: string; fetch: FetchLike; timeoutMs?: number }) {
  if (!REF.test(o.batchId.toLowerCase())) throw new ProviderError('bee', 'not_configured', 'postage batch id must be 64 hex chars');
  const base = o.url.replace(/\/+$/, '');
  const http = createHttp({ provider: 'bee', fetch: o.fetch, timeoutMs: o.timeoutMs ?? 20_000 });

  return {
    /** Pinned upload to our own node. Not retried: a timeout may still have stored the bytes. */
    async upload(bytes: Uint8Array, contentType = 'application/octet-stream') {
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) throw new ProviderError('bee', 'invalid', 'upload size out of range');
      const j = await http.json(`${base}/bytes`, {
        method: 'POST',
        headers: { 'content-type': contentType, 'swarm-postage-batch-id': o.batchId.toLowerCase(), 'swarm-pin': 'true' },
        body: bytes as BodyInit,
      });
      const ref = typeof j?.reference === 'string' ? checkRef(j.reference) : null;
      if (!ref) throw new ProviderError('bee', 'bad_response', 'upload returned no reference', { ambiguous: true });
      return { ref, size: bytes.byteLength, pinned: true as const, bmt: 'unverified' as BmtStatus };
    },
    async download(ref: string) {
      const res = await http.raw(`${base}/bytes/${checkRef(ref)}`, {}, { retry: true });
      const declared = Number(res.headers.get('content-length'));
      if (declared > MAX_BYTES) throw new ProviderError('bee', 'bad_response', 'content too large');
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > MAX_BYTES) throw new ProviderError('bee', 'bad_response', 'content too large');
      return { ref: checkRef(ref), bytes, bmt: 'unverified' as BmtStatus };
    },
  };
}
export type BeeClient = ReturnType<typeof createBee>;
