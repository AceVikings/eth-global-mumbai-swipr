import { createAutomation } from './automation/service';
import { createPrivyControl } from './automation/privy';
import { createGrants } from './automation/grants';
import { CopyAccounting } from './trading/accounting';
import { createSeatDirectory } from './passes/seats';
import { createEnsRegistrar } from './ens/registrar';
import { createEnsService } from './ens/service';
import { createWalletDirectory } from './bots/wallet-directory';
import { createTradingService } from './trading/service';
import { createFlashClient } from './providers/flash';
import { createEnsStats } from './ens/stats';
import { createWorkerServer } from './worker-http';
import { createGasFunder } from './gas-funding';
import { SocialStore } from './social/store';
import { ProjectStore } from './bots/store';
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
  // The funding signer has a durable nonce stream and cannot also send retention transactions.
  const renew = !config.funding.enabled && config.arkiv.writerAddress && config.arkivMaintainerKey ? createArkivMaintainer(config.arkiv, config.arkivMaintainerKey) : null;
  const funding = config.funding.enabled && config.arkivMaintainerKey
    ? createGasFunder({ ...config.arkiv, key: config.arkivMaintainerKey, startNonce: config.funding.startNonce }) : null;
  if (renew) await renew();
  const journal = config.arkiv.writerAddress ? createArkivJournal(config.arkiv) : null;
  const ledger = journal ? await Ledger.open(journal) : null;
  const social = journal ? new SocialStore(journal, config.botAudience) : null;
  const projects = journal ? new ProjectStore(journal, config.botAudience) : null;
  const directory = config.arkiv.accessKey ? createWalletDirectory(config.arkiv) : null;
  const accounting = journal ? new CopyAccounting(journal) : undefined;
  const trades = directory && config.flashKey && config.privySecret ? createTradingService({ allowAuto:!!config.automation.signerId,apiKey:config.flashKey,ticketSecret:config.privySecret,rpcUrl:config.baseRpc,profiles:directory,seats:createSeatDirectory(config.arkiv),accounting }) : null;
  const automation = config.automation.signerId && config.automation.key && config.privyAppId && config.privySecret && directory && trades && config.flashKey
    ? createAutomation({control:createPrivyControl({appId:config.privyAppId,appSecret:config.privySecret,authorizationKey:config.automation.key}),signerId:config.automation.signerId,trades,flash:createFlashClient({apiKey:config.flashKey,fetch}),profiles:directory,seats:createSeatDirectory(config.arkiv),grants:createGrants(config.arkiv)}) : null;
  let lastAutomation = 0;
  const names = directory ? createEnsService({rpcUrl:config.sepoliaRpc,rootName:config.ensRootName,profiles:directory,stats:trades&&config.flashKey?createEnsStats(createFlashClient({apiKey:config.flashKey,fetch}),trades):undefined}) : null;
  const ens = directory && names && config.ensRegistrarKey ? createEnsRegistrar({key:config.ensRegistrarKey as `0x${string}`,rootName:config.ensRootName,rpcUrl:config.sepoliaRpc,profiles:directory,snapshot:names.snapshot}) : null;
  let stopping = false, lastHealthy = 0, lastProbeMinute = -1, lastRenewal = Date.now();
  // Missing credentials keeps liveness available, but readiness and all writes fail closed.
  const server = createWorkerServer({ social, projects, funding, ens, trading:trades ? {execute:async(raw:unknown)=>{
      const input=raw as {action?:string;wallet:string;ticket:unknown;signature:unknown;orderId?:string};
      return input.action==='status' ? trades.status(input.wallet,String(input.orderId||'')) : trades.submit(input.wallet,input.ticket,input.signature);
    }} : null, stopping: () => stopping,
    lastHealthyAt: () => lastHealthy, canWrite: () => journal?.canWrite === true, canFund: () => !!funding });
  await new Promise<void>(resolve => server.listen(config.port, '0.0.0.0', resolve));
  const shutdown = () => { stopping = true; };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  console.log(JSON.stringify({ service: 'worker', port: config.port }));
  try {
    while (!stopping) {
      if (!ledger) {
        if (funding && Date.now() - lastHealthy > 15000) {
          try { lastHealthy = await funding.health() ? Date.now() : 0; } catch { lastHealthy = 0; }
        }
        await delay(2000); continue;
      }
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
        if(Date.now()-lastAutomation>30000){
          lastAutomation=Date.now();
          // Settle known copy holds even after logout, permission revocation or pass expiry.
          // Unknown submissions retain their hold; checking status never resubmits an order.
          if(accounting&&trades)for(const pending of (await accounting.pendingOrders()).slice(0,20)){
            try{await trades.status(pending.wallet,pending.orderId);}catch{/* Retry verification next cycle. */}
          }
          if(automation){const result=await automation.tick();if(result.failed||result.submitted)console.log(JSON.stringify({service:'worker',code:'automation_cycle',...result}));}
        }
        lastHealthy = Date.now();
      } catch { console.error(JSON.stringify({ severity: 'ERROR', service: 'worker', code: 'worker_cycle_failed' })); }
      if (!stopping) await delay(2000);
    }
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await ledger?.close();
  }
}
if (process.argv[1]?.endsWith('/worker.ts')) void main().catch(() => {
  console.error('Worker startup failed; check Arkiv configuration.'); process.exitCode = 1;
});
