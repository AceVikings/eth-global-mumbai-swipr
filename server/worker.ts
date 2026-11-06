import { SocialStore } from './social/store';
import { ApiError } from './auth';
import { jsonBody } from './http';
import { ProjectStore } from './bots/store';
import { BotError } from './bots/validation';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Ledger, type Job } from './ledger';
import { readConfig } from './config';
import { createArkivJournal } from './arkiv-journal';
import { createArkivMaintainer } from './arkiv-maintenance';
import { createBaseRpc } from './providers/base';
export async function runJob(job: Job, baseRpc?: string, fetcher: typeof fetch = fetch) {
  if (job.kind === 'probe-base') {
    if (!baseRpc) throw new Error('base_rpc_unconfigured');
    const rpc = createBaseRpc({ url: baseRpc, fetch: fetcher });
    if (await rpc.chainId() !== 8453) throw new Error('base_chain_mismatch');
    return;
  }
  throw new Error('unsupported_job_kind');
}
async function main() {
  const config = readConfig();
  if (!config.arkiv.writerAddress) throw new Error('ARKIV_WRITER_ADDRESS is required by the worker');
  const renew = config.arkivMaintainerKey ? createArkivMaintainer(config.arkiv, config.arkivMaintainerKey) : null;
  if (renew) await renew();
  const journal = createArkivJournal(config.arkiv);
  const ledger = await Ledger.open(journal);
  const social = new SocialStore(journal, config.botAudience);
  const projects = new ProjectStore(journal, config.botAudience);
  let stopping = false, lastHealthy = 0, lastProbeMinute = -1, lastRenewal = Date.now();
  const server = createServer(async (req, res) => {
    const path = req.url?.split('?')[0];
    if (path === '/internal/bots' || path === '/internal/social') {
      res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
      if (stopping || req.method !== 'POST') { res.writeHead(stopping ? 503 : 405); res.end(JSON.stringify({ error: { code: 'unavailable', message: 'Worker cannot accept this command.' } })); return; }
      try {
        const input = await jsonBody(req);
        const result = await (path === '/internal/social' ? social.execute(input) : projects.execute(input));
        res.writeHead(200); res.end(JSON.stringify(result));
      } catch (error) {
        const known = error instanceof BotError || error instanceof ApiError;
        res.writeHead(known ? error.status : 503);
        res.end(JSON.stringify({ error: { code: known ? error.code : 'unavailable', message: known ? error.message : 'Bot command was not confirmed; reconcile the same request ID.' } }));
      }
      return;
    }
    if (!['/healthz', '/readyz', '/health', '/ready'].includes(path || '')) { res.writeHead(404); res.end(); return; }
    const ok = !stopping && Date.now() - lastHealthy < 60000;
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok, service: 'worker', lastHealthyAt: lastHealthy ? new Date(lastHealthy).toISOString() : null }));
  });
  await new Promise<void>(resolve => server.listen(config.port, '0.0.0.0', resolve));
  const shutdown = () => { stopping = true; };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  console.log(JSON.stringify({ service: 'worker', port: config.port }));
  try {
    while (!stopping) {
      try {
        if (renew && Date.now() - lastRenewal > 3600000) { await renew(); lastRenewal = Date.now(); }
        if (!(await ledger.health()).ok) throw new Error('arkiv_unhealthy');
        const minute = Math.floor(Date.now() / 60000);
        if (config.baseRpc && minute !== lastProbeMinute) {
          // Network probes carry no project state and need no onchain write.
          await runJob({ kind: 'probe-base' } as Job, config.baseRpc);
          lastProbeMinute = minute;
        }
        const job = config.arkiv.privateKey ? await ledger.claimJob(['probe-base'], 60000) : null;
        if (job) {
          try {
            await runJob(job, config.baseRpc);
            await ledger.completeJob(job.id, job.leaseToken!);
          } catch {
            // Do not store arbitrary provider responses or private job payloads.
            await ledger.failJob(job.id, job.leaseToken!, 'provider_probe_failed', 10000);
          }
        }
        lastHealthy = Date.now();
      } catch { console.error(JSON.stringify({ severity: 'ERROR', service: 'worker', code: 'worker_cycle_failed' })); }
      if (!stopping) await delay(2000);
    }
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await ledger.close();
  }
}
if (process.argv[1]?.endsWith('/worker.ts')) void main().catch(() => {
  console.error('Worker startup failed; check Arkiv configuration.'); process.exitCode = 1;
});
