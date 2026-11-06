import express from 'express';
import { createServer } from 'node:http';
import { ApiError } from './auth';
import { jsonBody } from './http';
import { BotError } from './bots/validation';

type Executor = { execute(input: unknown): Promise<unknown> };
export function createWorkerServer(options: {
  social: Executor | null; projects: Executor | null;
  funding?: Executor | null;
  stopping: () => boolean; lastHealthyAt: () => number; canWrite: () => boolean;
}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    const path = req.url?.split('?')[0];
    const send = (status: number, value: unknown) => { res.writeHead(status); res.end(JSON.stringify(value)); };
    if (path === '/internal/bots' || path === '/internal/social' || path === '/internal/gas') {
      if (options.stopping()) return send(503, { error: { code: 'unavailable', message: 'Worker is stopping.' } });
      if (req.method !== 'POST') return send(405, { error: { code: 'method_not_allowed', message: 'Use POST.' } });
      const target = path === '/internal/gas' ? options.funding : path === '/internal/social' ? options.social : options.projects;
      if (!target || (path !== '/internal/gas' && !options.canWrite())) return send(503, { error: { code: 'unavailable', message: 'The requested writer is not configured. No command was accepted.' } });
      try {
        return send(200, await target.execute(await jsonBody(req)));
      } catch (error) {
        const known = error instanceof BotError || error instanceof ApiError;
        return send(known ? error.status : 503, { error: {
          code: known ? error.code : 'unavailable',
          message: known ? error.message : 'Command was not confirmed; reconcile the same request ID.',
        } });
      }
    }
    if (!['/healthz', '/readyz', '/health', '/ready'].includes(path || '')) return send(404, { error: 'not_found' });
    if (req.method !== 'GET') return send(405, { error: 'method_not_allowed' });
    const lastHealthyAt = options.lastHealthyAt();
    const alive = !options.stopping();
    const ready = alive && options.canWrite() && lastHealthyAt > 0 && Date.now() - lastHealthyAt < 60000;
    const ok = path === '/health' || path === '/healthz' ? alive : ready;
    return send(ok ? 200 : 503, { ok, service: 'worker', ready,
      lastHealthyAt: lastHealthyAt ? new Date(lastHealthyAt).toISOString() : null });
  });
  const server = createServer(app);
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  return server;
}
