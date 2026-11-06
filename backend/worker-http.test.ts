import { afterEach, expect, it, vi } from 'vitest';
import { createWorkerServer } from './worker-http';
import type { Server } from 'node:http';
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise(r => server.close(r)); } });
async function start(canWrite = false, lastHealthyAt = 0, stopping = false) {
  const execute = vi.fn(async () => ({ ok: true }));
  const server = createWorkerServer({ social: canWrite ? { execute } : null,
    projects: canWrite ? { execute } : null, canWrite: () => canWrite,
    lastHealthyAt: () => lastHealthyAt, stopping: () => stopping });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No HTTP port');
  return { url: `http://127.0.0.1:${address.port}`, execute };
}
it('boots without credentials while refusing readiness and commands', async () => {
  const { url } = await start();
  expect((await fetch(`${url}/health`)).status).toBe(200);
  expect((await fetch(`${url}/ready`)).status).toBe(503);
  expect((await fetch(`${url}/internal/bots`, { method: 'POST', body: '{}' })).status).toBe(503);
});
it('requires a fresh healthy cycle and a writable store for readiness', async () => {
  for (const [at, status] of [[Date.now(), 200], [Date.now() - 61000, 503], [0, 503]]) {
    const { url } = await start(true, at);
    expect((await fetch(`${url}/readyz`)).status).toBe(status);
  }
});
it('fails liveness and refuses writes during shutdown', async () => {
  const { url, execute } = await start(true, Date.now(), true);
  expect((await fetch(`${url}/healthz`)).status).toBe(503);
  expect((await fetch(`${url}/internal/social`, { method: 'POST', body: '{}' })).status).toBe(503);
  expect(execute).not.toHaveBeenCalled();
});

it('can serve bounded gas funding without a central product writer', async () => {
  const server = createWorkerServer({ social: null, projects: null, funding: { execute: async () => ({ funded: false }) },
    canWrite: () => false, canFund: () => true, lastHealthyAt: () => Date.now(), stopping: () => false });
  servers.push(server); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const a = server.address(); if (!a || typeof a === 'string') throw new Error('No port');
  const url = `http://127.0.0.1:${a.port}`;
  expect((await fetch(`${url}/ready`)).status).toBe(200);
  expect((await fetch(`${url}/internal/bots`, { method: 'POST', body: '{}' })).status).toBe(503);
  expect((await fetch(`${url}/internal/gas`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
});
