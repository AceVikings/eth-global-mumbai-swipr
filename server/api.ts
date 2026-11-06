import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ApiError, createAuthenticator, requireWallet } from './auth';
import type { Config } from './config';
import type { Ledger } from './ledger';
import type { Terms } from '../shared/types';
import { createFlashClient, type OrderIntent, validateTypedData } from './providers/flash';
export type ApiDependencies = {
  config: Config; ledger: Ledger | null;
  authenticate?: ReturnType<typeof createAuthenticator>;
  fetcher?: typeof fetch;
};
const MAX_BODY = 32768;
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new ApiError(415, 'json_required', 'Send application/json.');
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new ApiError(413, 'body_too_large', 'Request is too large.');
    chunks.push(chunk);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new ApiError(400, 'invalid_json', 'Expected a JSON object.'); }
}
export function createApi({ config, ledger, authenticate = createAuthenticator(config), fetcher = fetch }: ApiDependencies) {
  const flash = config.flashKey ? createFlashClient({ apiKey: config.flashKey, fetch: fetcher }) : null;
  const server = createServer(async (req, res) => {
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
        res.setHeader('access-control-allow-headers', 'Authorization,Content-Type,Idempotency-Key');
        res.writeHead(204); res.end(); return;
      }
      const url = new URL(req.url || '/', 'http://localhost');
      const path = url.pathname;
      if (req.method === 'GET' && ['/healthz', '/health'].includes(path)) return send(200, { ok: true, service: 'api' });
      if (req.method === 'GET' && ['/readyz', '/ready'].includes(path)) {
        const database = ledger ? await ledger.health() : { ok: false };
        return send(database.ok ? 200 : 503, { ok: database.ok, database });
      }
      if (req.method === 'GET' && path === '/api/runtime') return send(200, {
        mode: config.mode, tradingEnabled: false,
        integrations: [
          ['database', !!ledger, 'Durable PostgreSQL ledger'], ['flash', !!flash, 'Quote adapter; execution gates pending'],
          ['privy', !!(config.privyAppId && config.privySecret && config.privyVerificationKey), 'JWT and linked-wallet verification'],
          ['baseRpc', !!config.baseRpc, 'Receipt adapter; funded acceptance tests pending'],
          ['ens', !!config.sepoliaRpc, 'Registry deployment and mint verification pending'],
          ['arkiv', false, 'Signed directory and sealed entity adapter pending'],
          ['swarm', !!(config.beeUrl && config.swarmBatchId), 'Archive transport; BMT and gateway acceptance pending'],
        ].map(([name, configured, detail]) => ({ name, configured, verified: false, detail })),
      });
      if (req.method === 'GET' && path === '/api/traders') return send(200, {
        traders: [], source: 'arkiv', asOfBlock: null, state: 'unavailable',
        detail: 'No verified Arkiv directory is connected.',
      });
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
        // Only a chain-verified directory may authorize seat requests. Never accept
        // preview profile IDs or client-supplied mint/allowance assertions.
        void (input.terms as Terms); void wallet;
        throw new ApiError(503, 'matcher_unavailable', 'Verified trader directory and ENS matcher are not connected.');
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
      const raw = quote.raw as { estimatedFeeNotional?: unknown };
      return send(200, { quote: { quoteId: quote.quoteId, asset: intent.asset, qty: intent.qty,
        sharedPrice: intent.sharedPrice, estimatedFeeNotional: typeof raw.estimatedFeeNotional === 'string' ? raw.estimatedFeeNotional : null },
        signingCheck, executable: false, detail: 'Indicative live quote. Signing needs a verified vault and bounded deadline. No order submitted.' });
    } catch (error) {
      if (error instanceof ApiError) return send(error.status, { error: { code: error.code, message: error.message }, requestId });
      // Never echo provider payloads, authorization headers, SQL or credentials.
      const provider = error && typeof error === 'object' && 'provider' in error;
      const status = provider ? 502 : 503;
      console.error(JSON.stringify({ severity: 'ERROR', requestId, code: provider ? 'provider_failure' : 'service_failure' }));
      if (!res.headersSent) send(status, { error: { code: provider ? 'provider_failure' : 'service_unavailable', message: 'The service could not complete this request.' }, requestId });
      else res.end();
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  return server;
}
