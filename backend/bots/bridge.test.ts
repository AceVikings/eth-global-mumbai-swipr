import { expect, it } from 'vitest';
import { createWorkerBridge } from './bridge';
it('refuses arbitrary destinations and local endpoints in production', () => {
  for (const url of ['https://example.com', 'http://10.0.0.1', 'https://x.run.app/path', 'https://x.run.app/?key=x', 'http://localhost:8788']) {
    expect(() => createWorkerBridge({ url, production: true })).toThrow();
  }
});
it('keeps the API read only and forwards the exact signed request', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const bridge = createWorkerBridge({ url: 'http://127.0.0.1:8788', fetcher: async (url, init) => {
    calls.push({ url: String(url), init }); return Response.json({ replayed: false });
  } });
  const input = { payload: { requestId: 'same-on-retry' }, signature: 'test' };
  expect(await bridge(input)).toEqual({ replayed: false });
  expect(calls[0].url).toBe('http://127.0.0.1:8788/internal/bots');
  expect(calls[0].init?.body).toBe(JSON.stringify(input));
});
it('reports ambiguous failures without retrying', async () => {
  let calls = 0;
  const bridge = createWorkerBridge({ url: 'http://localhost:8788', fetcher: async () => { calls++; throw Error('lost ack'); } });
  await expect(bridge({})).rejects.toMatchObject({ code: 'write_uncertain' });
  expect(calls).toBe(1);
});
it('scopes Cloud Run identity to the worker origin', async () => {
  const calls: { url: string; headers?: HeadersInit }[] = [];
  const bridge = createWorkerBridge({ url: 'https://worker.run.app', production: true, fetcher: async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers });
    return calls.length === 1 ? new Response('eyJheader.payload.signature') : Response.json({ replayed: true });
  } });
  await bridge({});
  expect(calls[0].url).toContain('audience=https%3A%2F%2Fworker.run.app');
  expect(calls[1].headers).toMatchObject({ authorization: 'Bearer eyJheader.payload.signature' });
});
