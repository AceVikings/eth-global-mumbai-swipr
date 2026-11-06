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
export function createApi({ config, ledger, projects = null, social = null, walletProfiles, walletSignals, walletSocial, walletGhosts, seatDirectory, executeBot, executeSocial, fundGas, account, arkivRpc, verifiedPositions, authenticate = createAuthenticator(config), fetcher = fetch }: ApiDependencies) {
  const allowRequest = requestLimiter();
  const flash = config.flashKey ? createFlashClient({ apiKey: config.flashKey, fetch: fetcher }) : null;
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
    async prepareEnsText() { throw new ApiError(503, 'ens_unavailable', 'The owner-managed ENS resolver and agent charter are not configured.'); },
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
      if (req.method === 'POST' && !allowRequest(req.socket.remoteAddress ?? 'unknown')) throw new ApiError(429, 'rate_limited', 'Too many requests. Try again shortly.');
      const gateway = makeGateway(req.headers.authorization);
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
          ['ens', false, 'Sepolia RPC connected by default; registry deployment and mint verification pending'],
          ['arkiv', !!walletProfiles || !!ledger, 'Rabdi native wallet ownership; execution receipts remain separate'],
          ['swarm', !!(config.beeUrl && config.swarmBatchId), 'Archive transport; BMT and gateway acceptance pending'],
        ].map(([name, configured, detail]) => ({ name, configured, verified: false, detail })),
      });
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
        if (!verifiedPositions) return send(200, { state: 'unavailable', rows: [], asOf: null, detail: 'Verified closed fill history is not connected. Ghosts and proposed signals are excluded.' });
        const data = await verifiedPositions();
        return send(200, { state: 'ready', rows: rankClosedPositions(data.positions, { role: role as 'trader' | 'copier', sort: sort as 'percentage' | 'absolute', following }), asOf: data.asOf,
          detail: 'Since inception. Closed-position net profit after fees and profit share; return = net profit / entry cost.' });
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
