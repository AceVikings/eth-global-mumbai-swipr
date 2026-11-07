import { createAutomation } from './automation/service';
import { createPrivyControl } from './automation/privy';
import { createGrants } from './automation/grants';
import { createHistorySource, createPerformanceSource } from './trading/history-source';
import { activeWalletGhosts } from './contracts/ghosts';
import { ghostResult } from './trading/performance';
import { MAX_PROFILE_IMAGE_BYTES } from './contracts/profile-image';
import { createMedia, type MediaService } from './media';
import { createBee } from './providers/bee';
import { createEnsService, type EnsService } from './ens/service';
import { createEnsStats } from './ens/stats';
import { createTradingService, type TradingService } from './trading/service';
import { createWalletBalance } from './wallet-balance';
import express from 'express';
import { buildWalletAction } from './bots/wallet-actions';
import { deleteAccountMessage } from './account';
import { verifySocialAction, type SocialStore } from './social/store';
import { rankClosedPositions, type VerifiedClosedPosition } from './social/rankings';
import { requestLimiter } from './rate-limit';
import { createServer, type IncomingMessage } from 'node:http';
import { createBotGateway, PARSE_ERROR_BODY } from './bots/gateway';
import { createWorkerBridge } from './bots/bridge';
import { verifyBotAction } from './bots/auth';
import { BotError } from './bots/validation';
import type { BotProfile, BotSignal } from './contracts/bots';
import type { ProjectStore } from './bots/store';
import { randomUUID } from 'node:crypto';
import { ApiError, createAuthenticator, requireWallet } from './auth';
import type { Config } from './config';
import type { Ledger } from './ledger';
import { createFlashClient, type OrderIntent, validateTypedData } from './providers/flash';
export type ApiDependencies = {
  config: Config; ledger: Ledger | null; projects?: ProjectStore | null; social?: SocialStore | null;
  trading?: TradingService; ens?: EnsService; media?: MediaService;
  walletBalance?: (address: string) => Promise<{ address: string; chainId: number; display: string; gasDisplay: string }>;
  walletProfiles?: () => Promise<BotProfile[]>;
  walletSignals?: (profiles: BotProfile[]) => Promise<BotSignal[]>;
  executeSocial?: (input: unknown) => Promise<unknown>;
  verifiedPositions?: () => Promise<{ positions: VerifiedClosedPosition[]; asOf: string }>;
  executeBot?: (input: unknown) => Promise<unknown>;
  fundGas?: (input: unknown) => Promise<unknown>;
  account?: { health?(): Promise<{ ok: boolean }>; list(wallet: string): Promise<{ key: string; schema: string }[]>; remove(identity: import('./auth').Identity, wallet: string, input: Record<string, unknown>): Promise<unknown> };
  arkivRpc?: (input: Record<string, unknown>) => Promise<unknown>;
  seatDirectory?: (wallet: string, profiles: BotProfile[]) => Promise<import('./contracts/seats').SeatDirectory>;
  walletGhosts?: (wallet: string) => Promise<import('./contracts/ghosts').WalletGhostRecord[]>;
  walletSocial?: (wallet: string) => Promise<{ entityKey: string | null; following: string[] }>;
  authenticate?: ReturnType<typeof createAuthenticator>;
  fetcher?: typeof fetch;
};
export { jsonBody } from './http';
import { jsonBody } from './http';
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const value = await jsonBody(req);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'invalid_json', 'Expected a JSON object.');
  return value as Record<string, unknown>;
}
export function createApi({ config, ledger, projects = null, social = null, walletProfiles, walletSignals, walletSocial, walletGhosts, seatDirectory, walletBalance, trading, ens, media, executeBot, executeSocial, fundGas, account, arkivRpc, verifiedPositions, authenticate = createAuthenticator(config), fetcher = fetch }: ApiDependencies) {
  const allowRequest = requestLimiter();
  const allowUpload = requestLimiter(12);
  const mediaStore = media ?? (config.beeUrl && config.swarmBatchId
    ? createMedia(createBee({ url: config.beeUrl, batchId: config.swarmBatchId, fetch: fetcher, maxBytes: MAX_PROFILE_IMAGE_BYTES })) : null);
  const trades = trading ?? (config.flashKey && config.privySecret && walletProfiles && seatDirectory ? createTradingService({ allowAuto: !!config.automation.signerId, apiKey: config.flashKey, ticketSecret: config.privySecret, rpcUrl: config.baseRpc, profiles: walletProfiles, seats: seatDirectory, fetcher }) : null);
  const history = trades ? createHistorySource(trades) : null;
  const performance = verifiedPositions ?? (history && walletProfiles && seatDirectory ? createPerformanceSource(history, walletProfiles, seatDirectory) : null);
  const readBalance = walletBalance ?? createWalletBalance(config.baseRpc);
  const flash = config.flashKey ? createFlashClient({ apiKey: config.flashKey, fetch: fetcher }) : null;
  const automation = config.automation.signerId && config.privyAppId && config.privySecret && walletProfiles && seatDirectory && trades && flash
    ? createAutomation({ control:createPrivyControl({appId:config.privyAppId,appSecret:config.privySecret,fetcher}),signerId:config.automation.signerId,trades,flash,profiles:walletProfiles,seats:seatDirectory,grants:createGrants(config.arkiv) }) : null;
  const names = ens ?? (walletProfiles ? createEnsService({rpcUrl:config.sepoliaRpc,profiles:walletProfiles,rootName:config.ensRootName,
    stats: flash&&trades?createEnsStats(flash,trades):undefined}) : null);
  const listBots = async () => {
    if (walletProfiles) {
      const profiles = await walletProfiles();
      return { profiles, signals: walletSignals ? await walletSignals(profiles) : [], state: 'ready', detail: 'Wallet-owned Arkiv profiles and operator proposals. Performance requires verified fills.' };
    }
    if (!projects) return { profiles: [], signals: [], state: 'unavailable', detail: 'Arkiv writer is not configured. Bot profiles have not been published.' };
    const result = await projects.list();
    return { ...result, state: 'ready', detail: 'Owner-signed registrations stored in Arkiv. Execution history is unverified.' };
  };
  const writeSocial = executeSocial ?? createWorkerBridge({ url: config.workerUrl, production: process.env.NODE_ENV === 'production', fetcher, path: '/internal/social' });
  const writeBot = executeBot ?? createWorkerBridge({ url: config.workerUrl, production: process.env.NODE_ENV === 'production', fetcher });
  const sponsorEns = createWorkerBridge({ url:config.workerUrl,production:process.env.NODE_ENV==='production',fetcher,path:'/internal/ens' });
  const submitTrade = createWorkerBridge({url:config.workerUrl,production:process.env.NODE_ENV==='production',fetcher,path:'/internal/trading'});
  const fundWrite = fundGas ?? createWorkerBridge({ url: config.workerUrl, production: process.env.NODE_ENV === 'production', fetcher, path: '/internal/gas' });
  const forwardBot = async (input: unknown, authorization?: string) => {
    try {
      const verified = await verifyBotAction(input, config.botAudience);
      if (walletProfiles) throw new ApiError(409, 'wallet_transaction_required', 'Prepare profile and signal writes at /api/bots/wallet-transaction, then send them through the owner/operator wallet.');
      if (verified.payload.action !== 'signal.publish') {
        const identity = await authenticate(authorization);
        requireWallet(identity, verified.actor);
      }
      return await writeBot(input);
    } catch (error) {
      if (error instanceof BotError) throw new ApiError(error.status, error.code, error.message);
      throw error;
    }
  };
  const makeGateway = (authorization?: string) => createBotGateway({
    listBots, executeBot: input => forwardBot(input, authorization),
    ...(walletProfiles ? { prepareWalletAction: async (input: Record<string, unknown>) => buildWalletAction(input, await walletProfiles()) } : {}),
    async quote(input) {
      if (!flash) throw new ApiError(503, 'quotes_unavailable', 'Flash quotes are not configured.');
      const intent: OrderIntent = { side: input.side, asset: input.asset, qty: input.qty, funder: input.funder,
        orderType: 'limit', sharedPrice: input.limitPrice, limitNotionalPrice: input.limitPrice };
      const result = await flash.quote(intent);
      return { quoteId: result.quoteId, intent, typedData: result.typedData,
        executable: false, detail: 'Indicative quote only. Wallet signing and verified execution gates are required.' };
    },
    async getOrder(input) {
      if (!flash) throw new ApiError(503, 'quotes_unavailable', 'Flash is not configured.');
      const result = await flash.getOrder(input.orderId, input.funder);
      return { orderId: input.orderId, status: result.status, fills: result.fills };
    },
    async submitOrder() { throw new ApiError(503, 'execution_unavailable', 'Order submission awaits verified pass, signer and receipt gates.'); },
    async sealFill() { throw new ApiError(503, 'notary_unavailable', 'Fill sealing needs the verified notary and Arkiv product-schema publisher.'); },
    async prepareEnsText(input) { if (!names) throw new ApiError(503, 'ens_unavailable', 'ENS is unavailable.'); const identity=await authenticate(authorization); if (identity.wallets.length!==1) throw new ApiError(400, 'choose_wallet', 'Use the ENS REST endpoint to select your wallet.'); return names.text(requireWallet(identity,identity.wallets[0]) as `0x${string}`,input); },
  });
  const app = express();
  app.disable('x-powered-by');
  // Preserve bounded JSON parsing and MCP-specific errors in the transport.
  app.use(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('x-request-id', requestId);
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    try {
      const origin = req.headers.origin;
      if (origin && !config.origins.includes(origin)) throw new ApiError(403, 'origin_denied', 'Origin is not allowed.');
      if (origin) { res.setHeader('access-control-allow-origin', origin); res.setHeader('vary', 'Origin'); }
      if (req.method === 'OPTIONS') {
        res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
        res.setHeader('access-control-allow-headers', 'Authorization,Content-Type,Idempotency-Key,MCP-Protocol-Version');
        res.writeHead(204); res.end(); return;
      }
      const url = new URL(req.url || '/', 'http://localhost');
      const path = url.pathname;
      if ((req.method === 'POST' || path.startsWith('/api/ens/') || path.startsWith('/api/media/')) && !allowRequest(req.socket.remoteAddress ?? 'unknown')) throw new ApiError(429, 'rate_limited', 'Too many requests. Try again shortly.');
      const gateway = makeGateway(req.headers.authorization);
      if (path === '/api/media' && req.method === 'POST') {
        const identity = await authenticate(req.headers.authorization);
        const input = await body(req);
        const wallet = requireWallet(identity, input.wallet);
        if (!allowUpload(wallet)) throw new ApiError(429, 'rate_limited', 'Too many image uploads. Try again shortly.');
        if (!mediaStore) throw new ApiError(503, 'media_unavailable', 'Image uploads are temporarily unavailable.');
        return send(201, await mediaStore.upload(input.image));
      }
      if (path.startsWith('/api/media/') && req.method === 'GET') {
        const ref = path.slice('/api/media/'.length);
        if (!/^[0-9a-f]{64}$/.test(ref)) throw new ApiError(400, 'invalid_reference', 'Invalid media reference.');
        if (!mediaStore) throw new ApiError(503, 'media_unavailable', 'Images are temporarily unavailable.');
        const image = await mediaStore.read(ref);
        res.writeHead(200, { 'content-type': 'image/webp', 'content-length': image.bytes.length,
          'cache-control': 'public, max-age=86400, immutable', 'content-security-policy': "default-src 'none'; sandbox",
          'x-swarm-reference': image.ref, 'x-swarm-integrity': image.bmt });
        res.end(image.bytes); return;
      }
      if (path.startsWith('/api/ens/')) {
        if (!names) throw new ApiError(503,'ens_unavailable','ENS is unavailable.');
        if(req.method==='GET'&&path==='/api/ens/verify') return send(200,await names.verify(url.searchParams.get('profileId'),url.searchParams.get('name')||undefined));
        const identity=await authenticate(req.headers.authorization);
        const input=req.method==='POST'?await body(req):{};
        const wallet=requireWallet(identity,input.wallet||url.searchParams.get('wallet')) as `0x${string}`;
        if(req.method==='POST'&&path==='/api/ens/text'){
          if(typeof input.name!=='string'||typeof input.key!=='string'||typeof input.value!=='string')throw new ApiError(400,'invalid_record','Provide name, key and value.');
          return send(200,await names.text(wallet,{name:input.name,key:input.key,value:input.value}));
        }
        if(req.method==='POST'&&path==='/api/ens/publish')return send(200,await names.publish(wallet,input));
        if(req.method==='POST'&&path==='/api/ens/onboard')return send(200,await sponsorEns({wallet,profileId:input.profileId}));
        if(req.method==='GET'&&path==='/api/ens/receipt'){
          const hash=url.searchParams.get('hash')||'';
          if(!/^0x[0-9a-f]{64}$/i.test(hash))throw new ApiError(400,'invalid_hash','Invalid transaction.');
          return send(200,await names.receipt(hash as `0x${string}`));
        }
        throw new ApiError(404,'not_found','Route not found.');
      }
      if (req.method === 'GET' && path === '/api/automation') {
        const identity=await authenticate(req.headers.authorization),wallet=requireWallet(identity,url.searchParams.get('wallet'));
        if(!automation)return send(200,{grants:[],configured:false});
        return send(200,{...await automation.state(wallet),configured:true,signerId:config.automation.signerId});
      }
      if (req.method === 'GET' && path === '/api/automation/signers') {
        const identity=await authenticate(req.headers.authorization),wallet=requireWallet(identity,url.searchParams.get('wallet'));
        if(!automation)throw new ApiError(503,'permissions_unavailable','Automatic copying is not configured.');
        return send(200,await automation.signers(identity,wallet));
      }
      if (req.method === 'POST' && path === '/api/automation/prepare') {
        const identity=await authenticate(req.headers.authorization),input=await body(req),wallet=requireWallet(identity,input.wallet);
        if(!automation)throw new ApiError(503,'permissions_unavailable','Automatic copying is not configured.');
        return send(200,await automation.prepare(identity,wallet,String(input.seatId||''),input.exits===true));
      }
      if (path.startsWith('/api/trades/')) {
        const identity = await authenticate(req.headers.authorization);
        if (!trades) throw new ApiError(503, 'trading_unavailable', 'Trading is not configured.');
        const input = req.method === 'POST' ? await body(req) : {};
        const wallet = requireWallet(identity, input.wallet || url.searchParams.get('wallet'));
        if(req.method==='GET' && path==='/api/trades/pass')return send(200,await (trading?trades.passState(wallet,url.searchParams.get('seatId')||''):submitTrade({action:'pass-state',wallet,seatId:url.searchParams.get('seatId')||''})));
        if(req.method==='POST' && path==='/api/trades/pass-exit')return send(200,await (trading?trades.passExit(wallet,String(input.seatId||''),input.asset as 'WETH'|'cbBTC',String(input.reason||'')):submitTrade({action:'pass-exit',wallet,seatId:input.seatId,asset:input.asset,reason:input.reason})));
        if(req.method==='POST' && path==='/api/trades/pass-settlement')return send(200,await (trading?trades.passSettlement(wallet,String(input.seatId||''),input.txHash):submitTrade({action:'pass-settlement',wallet,seatId:input.seatId,...(Object.hasOwn(input,'txHash')?{txHash:input.txHash}:{})})));
        if (req.method === 'POST' && path === '/api/trades/quote') return send(200, await trades.quote(wallet, input));
        if (req.method === 'POST' && path === '/api/trades/preflight') return send(200, await (trading ? trades.preflight(wallet, input.ticket) : submitTrade({action:'preflight',wallet,ticket:input.ticket})));
        if (req.method === 'POST' && path === '/api/trades/approval') return send(200, await trades.approval(wallet, input.ticket, input.txHash));
        if (req.method === 'POST' && path === '/api/trades/submit') return send(200, await (trading ? trades.submit(wallet, input.ticket, input.signature) : submitTrade({wallet,ticket:input.ticket,signature:input.signature})));
        if (req.method === 'POST' && path === '/api/trades/cancel-prepare') return send(200, await trades.prepareCancel(wallet, String(input.orderId || '')));
        if (req.method === 'POST' && path === '/api/trades/cancel') return send(200, await trades.cancel(wallet, String(input.orderId || ''), input.signature));
        if (req.method === 'GET' && path === '/api/trades/history') return send(200, await trades.history(wallet));
        if (req.method === 'GET' && path === '/api/trades/status') return send(200, await (trading ? trades.status(wallet, url.searchParams.get('orderId') || '') : submitTrade({action:'status',wallet,orderId:url.searchParams.get('orderId') || ''})));
        throw new ApiError(404, 'not_found', 'Route not found.');
      }
      if (path === '/api/wallet' && req.method === 'GET') {
        const identity = await authenticate(req.headers.authorization);
        const wallet = requireWallet(identity, url.searchParams.get('address'));
        try { return send(200, await readBalance(wallet)); }
        catch { throw new ApiError(503, 'balance_unavailable', 'Could not load your Base balance. Try again.'); }
      }
      if (path === '/api/arkiv/rpc' && req.method === 'POST') {
        await authenticate(req.headers.authorization);
        if (!arkivRpc) throw new ApiError(503, 'rpc_unavailable', 'Account storage is unavailable.');
        return send(200, await arkivRpc(await body(req)));
      }
      if (path === '/api/account/data' || path === '/api/account/delete') {
        const identity = await authenticate(req.headers.authorization);
        if (!account) throw new ApiError(503, 'account_unavailable', 'Account storage is unavailable.');
        const input = req.method === 'POST' ? await body(req) : {};
        const wallet = requireWallet(identity, input.wallet || url.searchParams.get('wallet'));
        if (path === '/api/account/data' && req.method === 'GET') {
          const expires = Math.floor(Date.now() / 1000) + 300;
          return send(200, { wallet, entities: await account.list(wallet), expires,
            deletionMessage: deleteAccountMessage(config.botAudience, identity.userId, wallet, expires) });
        }
        if (path === '/api/account/delete' && req.method === 'POST') return send(200, await account.remove(identity, wallet, input));
        throw new ApiError(405, 'method_not_allowed', 'Method not allowed.');
      }
      if (path === '/api/arkiv/gas' && req.method === 'POST') {
        const identity = await authenticate(req.headers.authorization);
        const input = await body(req);
        const wallet = requireWallet(identity, input.wallet);
        return send(200, await fundWrite({ wallet, subject: identity.userId }));
      }
      if (req.method === 'GET' && ['/healthz', '/health'].includes(path)) return send(200, { ok: true, service: 'api' });
      if (req.method === 'GET' && ['/readyz', '/ready'].includes(path)) {
        const database = account?.health ? await account.health() : ledger ? await ledger.health() : { ok: false };
        return send(database.ok ? 200 : 503, { ok: database.ok, database });
      }
      if (path === '/mcp' || path === '/api/agent') {
        if (req.method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'Use POST for the stateless bot transport.');
        const protocol = req.headers['mcp-protocol-version'];
        if (path === '/mcp' && protocol && protocol !== '2025-03-26') throw new ApiError(400, 'unsupported_protocol', 'Supported MCP protocol: 2025-03-26.');
        let input: unknown;
        try { input = await jsonBody(req); } catch (error) {
          if (path === '/mcp' && error instanceof ApiError && error.code === 'invalid_json') return send(400, PARSE_ERROR_BODY);
          throw error;
        }
        const result = path === '/mcp' ? await gateway.mcp(input) : await gateway.agent(input);
        if (result.body === undefined) { res.writeHead(result.status); res.end(); return; }
        return send(result.status, result.body);
      }
      if (path === '/api/bots/integration' && req.method === 'GET') {
        if (!config.publicApiUrl) throw new ApiError(503, 'api_origin_unconfigured', 'The public API origin is not configured.');
        return send(200, {
        audience: config.botAudience, apiUrl: config.publicApiUrl, mcpUrl: `${config.publicApiUrl}/mcp`,
        tools: gateway.tools.map(t => ({ name: t.name, description: t.description })), tradingEnabled: false,
      });
      }
      if (path === '/api/bots' && req.method === 'GET') return send(200, await listBots());
      if (path === '/api/bots/wallet-transaction' && req.method === 'POST') {
        if (!walletProfiles) throw new ApiError(503, 'storage_unavailable', 'Wallet storage is unavailable.');
        return send(200, buildWalletAction(await body(req), await walletProfiles()));
      }
      if (path === '/api/bots/commands' && req.method === 'POST') return send(200, await forwardBot(await body(req), req.headers.authorization));
      if (req.method === 'GET' && path === '/api/runtime') return send(200, {
        mode: config.mode, tradingEnabled: false,
        integrations: [
          ['database', !!walletProfiles || !!ledger, 'Wallet-owned Arkiv records'], ['flash', !!flash, 'Quote adapter; execution gates pending'],
          ['privy', !!(config.privyAppId && config.privySecret && config.privyVerificationKey), 'JWT and linked-wallet verification'],
          ['baseRpc', !!config.baseRpc, 'Receipt adapter; funded acceptance tests pending'],
          ['arkiv', !!walletProfiles || !!ledger, 'Rabdi native wallet ownership; execution receipts remain separate'],
          ['ens', !!names, 'Sepolia ENSv2 identity and text records; verified against live source data'],
          ['swarm', !!(config.beeUrl && config.swarmBatchId), 'Profile media transport with BMT integrity verification; live availability depends on Bee'],
        ].map(([name, configured, detail]) => ({ name, configured, verified: false, detail })),
      });
      if (req.method === 'GET' && path === '/api/ghosts/results') {
        const identity = await authenticate(req.headers.authorization);
        const wallet = requireWallet(identity, url.searchParams.get('wallet'));
        if (!walletGhosts || !walletProfiles || !history) throw new ApiError(503, 'ghosts_unavailable', 'Simulation history is unavailable.');
        const [records, profiles] = await Promise.all([walletGhosts(wallet), walletProfiles()]);
        const results = [];
        for (const ghost of activeWalletGhosts(records)) {
          const profile = profiles.find(p => p.id === ghost.traderId);
          if (!profile) { results.push({ traderId: ghost.traderId, state: 'unavailable' }); continue; }
          try { results.push(ghostResult(ghost, await history(profile.owner))); }
          catch { results.push({ traderId: ghost.traderId, state: 'unavailable' }); }
        }
        return send(200, { results, asOf: new Date().toISOString(), basis: 'Confirmed Flash wallet fills; simulated amounts, no open-position valuation.' });
      }
      if (req.method === 'GET' && path === '/api/ghosts') {
        const identity = await authenticate(req.headers.authorization);
        const wallet = requireWallet(identity, url.searchParams.get('wallet'));
        if (!walletGhosts) throw new ApiError(503, 'ghosts_unavailable', 'Ghost storage is unavailable.');
        return send(200, { records: await walletGhosts(wallet), state: 'ready' });
      }
      if (req.method === 'GET' && path === '/api/social') {
        const identity = await authenticate(req.headers.authorization);
        const wallet = requireWallet(identity, url.searchParams.get('wallet'));
        if (walletSocial) return send(200, { ...await walletSocial(wallet), state: 'ready', audience: config.botAudience, detail: 'Following owned by your Arkiv wallet.' });
        return send(200, social
          ? { following: await social.following(wallet), state: 'ready', detail: 'Following stored in Arkiv.', audience: config.botAudience }
          : { following: [], state: 'unavailable', detail: 'Arkiv social storage is not configured.', audience: config.botAudience });
      }
      if (req.method === 'POST' && path === '/api/social/commands') {
        if (walletSocial) throw new ApiError(409, 'wallet_transaction_required', 'Follow changes must be sent by your wallet on Arkiv.');
        const identity = await authenticate(req.headers.authorization);
        const input = await body(req);
        const { actor } = await verifySocialAction(input, config.botAudience);
        requireWallet(identity, actor);
        return send(200, await writeSocial(input));
      }
      if (req.method === 'GET' && path === '/api/leaderboards') {
        const role = url.searchParams.get('role') ?? 'trader';
        const sort = url.searchParams.get('sort') ?? 'percentage';
        const scope = url.searchParams.get('scope') ?? 'everyone';
        if (!['trader', 'copier'].includes(role) || !['percentage', 'absolute'].includes(sort) || !['everyone', 'following'].includes(scope)) throw new ApiError(400, 'invalid', 'Invalid leaderboard filters.');
        let following: string[] | undefined;
        if (scope === 'following') {
          const identity = await authenticate(req.headers.authorization);
          const wallet = requireWallet(identity, url.searchParams.get('wallet'));
          if (!social && !walletSocial) return send(200, { state: 'unavailable', rows: [], asOf: null, detail: 'Arkiv social storage is not configured.' });
          following = walletSocial ? (await walletSocial(wallet)).following : await social!.following(wallet);
        }
        if (!performance) return send(200, { state: 'unavailable', rows: [], asOf: null, detail: 'Verified closed fill history is not connected. Ghosts and proposed signals are excluded.' });
        let data;
        try { data = await performance(); } catch { throw new ApiError(503, 'history_unavailable', 'Verified performance history is temporarily unavailable.'); }
        return send(200, { state: 'ready', rows: rankClosedPositions(data.positions, { role: role as 'trader' | 'copier', sort: sort as 'percentage' | 'absolute', following }), asOf: data.asOf,
          detail: 'Confirmed Flash wallet round trips using FIFO cost basis. Cash flows include execution fees. Outside trades and separately paid profit share are excluded; open positions are unranked. Roles identify registered traders and seat holders, not bot attribution.' });
      }
      if (req.method === 'GET' && path === '/api/traders') return send(200, {
        traders: [], source: 'arkiv', asOfBlock: null, state: 'unavailable',
        detail: 'No verified Arkiv directory is connected.',
      });
      if (path === '/api/seats' && req.method === 'GET') {
        const identity = await authenticate(req.headers.authorization);
        const wallet = requireWallet(identity, url.searchParams.get('wallet'));
        if (!seatDirectory || !walletProfiles) throw new ApiError(503, 'seats_unavailable', 'Seats could not be loaded.');
        return send(200, await seatDirectory(wallet, await walletProfiles()));
      }
      if (!['/api/me', '/api/passes', '/api/quotes', '/api/orders'].includes(path)) throw new ApiError(404, 'not_found', 'Route not found.');
      const identity = await authenticate(req.headers.authorization);
      if (req.method === 'GET' && path === '/api/me') return send(200, identity);
      if (req.method === 'GET' && path === '/api/passes') {
        if (!ledger) throw new ApiError(503, 'database_unavailable', 'Pass storage is unavailable.');
        const passes = (await Promise.all(identity.wallets.map(w => ledger.listPasses(w)))).flat();
        return send(200, { passes });
      }
      if (req.method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'Method not allowed.');
      const input = await body(req);
      const wallet = requireWallet(identity, input.wallet);
      if (path === '/api/passes') {
        void wallet;
        throw new ApiError(409, 'wallet_transaction_required', 'Join seats through the copier wallet. Private seats require a trader invitation.');
      }
      if (path === '/api/orders') throw new ApiError(503, 'execution_unavailable', 'Order submission awaits verified pass, signer and receipt gates.');
      if (!flash) throw new ApiError(503, 'quotes_unavailable', 'Flash quotes are not configured.');
      if (input.asset !== 'WETH' && input.asset !== 'cbBTC') throw new ApiError(400, 'invalid_asset', 'Choose WETH or cbBTC.');
      if (typeof input.qty !== 'string' || typeof input.sharedPrice !== 'string') throw new ApiError(400, 'invalid_quote', 'Quote amount and price are required as decimal strings.');
      const intent: OrderIntent = { side: 'buy', asset: input.asset, qty: input.qty, funder: wallet,
        orderType: 'limit', sharedPrice: input.sharedPrice, limitNotionalPrice: input.sharedPrice };
      const quote = await flash.quote(intent);
      let signingCheck = 'blocked';
      try {
        validateTypedData(quote.typedData, intent, { now: Math.floor(Date.now() / 1000), maxDeadline: Math.floor(Date.now() / 1000) + 900 });
        signingCheck = 'validated';
      } catch { /* A verified vault and bounded deadline are required before signing. */ }
      const raw = quote.raw as { fees?: { estimatedFeeNotional?: unknown } };
      return send(200, { quote: { quoteId: quote.quoteId, asset: intent.asset, qty: intent.qty,
        sharedPrice: intent.sharedPrice, estimatedFeeNotional: typeof raw.fees?.estimatedFeeNotional === 'string' ? raw.fees.estimatedFeeNotional : null },
        signingCheck, executable: false, detail: 'Indicative live quote. Signing needs a verified vault and bounded deadline. No order submitted.' });
    } catch (error) {
      if (error instanceof BotError) return send(error.status, { error: { code: error.code, message: error.message }, requestId });
      if (error instanceof ApiError) return send(error.status, { error: { code: error.code, message: error.message }, requestId });
      // Never echo provider payloads, authorization headers, SQL or credentials.
      const provider = error && typeof error === 'object' && 'provider' in error;
      const status = provider ? 502 : 503;
      console.error(JSON.stringify({ severity: 'ERROR', requestId, code: provider ? 'provider_failure' : 'service_failure' }));
      if (!res.headersSent) send(status, { error: { code: provider ? 'provider_failure' : 'service_unavailable', message: 'The service could not complete this request.' }, requestId });
      else res.end();
    }
  });
  const server = createServer(app);
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  return server;
}
