import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../auth';
import type { BotActionType } from '../contracts/bots';
import { createBotGateway, MCP_PROTOCOL_VERSION, TOOL_NAMES, validate, type BotGatewayDeps } from './gateway';

const ADDR = `0x${'a'.repeat(40)}`;
const SIG = `0x${'b'.repeat(130)}`;
const BOT = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
function deps(overrides: Partial<BotGatewayDeps> = {}): BotGatewayDeps {
  return {
    listBots: vi.fn(async () => ({ profiles: [], signals: [], state: 'unavailable', detail: 'test' })),
    executeBot: vi.fn(async () => ({ replayed: false })),
    quote: vi.fn(async () => ({ quoteId: 'q1' })),
    getOrder: vi.fn(async () => ({ status: 'OPEN' })),
    submitOrder: vi.fn(async () => { throw new ApiError(503, 'execution_unavailable', 'Trading is disabled.'); }),
    sealFill: vi.fn(async () => ({ sealed: false })),
    prepareEnsText: vi.fn(async () => ({ to: ADDR, data: '0x' })),
    ...overrides,
  };
}
const envelope = (action: BotActionType, data: Record<string, unknown> = { profileId: BOT }, extra: Record<string, unknown> = {}) => ({
  payload: { version: 1, audience: 'https://swipr.test', chainId: 8453, requestId: '2f1e4b9c-1d2a-4c3b-8e7f-0a1b2c3d4e5f',
    issuedAt: 1_800_000_000, expiresAt: 1_800_000_300, action, data, ...extra },
  signature: SIG,
});
const signal = { profileId: BOT, asset: 'WETH', side: 'buy', quantity: '0.01', limitPrice: '3000.5' };
const profile = { operator: ADDR, name: 'Momentum', bio: '', style: 'Balanced', strategy: 'rule-based', assets: ['WETH', 'cbBTC'] };
const rpc = (method: string, params?: unknown, id: unknown = 1) => ({ jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) });
const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

describe('MCP protocol', () => {
  it('initializes statelessly, pings and lists exactly the strict tool set', async () => {
    const g = createBotGateway(deps());
    const init = await g.mcp(rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } }));
    expect(init).toMatchObject({ status: 200, body: { id: 1, result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} } } } });
    expect(await g.mcp(rpc('ping', undefined, 'p'))).toEqual({ status: 200, body: { jsonrpc: '2.0', id: 'p', result: {} } });
    const list = await g.mcp(rpc('tools/list'));
    const tools = (list.body as any).result.tools as { name: string; inputSchema: { additionalProperties: boolean } }[];
    expect(tools.map(t => t.name)).toEqual([...TOOL_NAMES]);
    for (const t of tools) expect(t.inputSchema.additionalProperties).toBe(false);
  });
  it('never responds to notifications or client responses, and never runs tools from them', async () => {
    const d = deps(); const g = createBotGateway(d);
    expect(await g.mcp({ jsonrpc: '2.0', method: 'notifications/initialized' })).toEqual({ status: 202 });
    expect(await g.mcp({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'swipr_list_bots' } })).toEqual({ status: 202 });
    expect(await g.mcp({ jsonrpc: '2.0', id: 4, result: {} })).toEqual({ status: 202 });
    expect(d.listBots).not.toHaveBeenCalled();
  });
  it('returns JSON-RPC protocol errors for malformed requests, methods and unknown tools', async () => {
    const g = createBotGateway(deps());
    expect(await g.mcp({ id: 1, method: 'ping' })).toMatchObject({ status: 400, body: { id: 1, error: { code: -32600 } } });
    expect(await g.mcp(rpc('ping', undefined, null))).toMatchObject({ status: 400, body: { id: null, error: { code: -32600 } } });
    expect(await g.mcp(rpc('resources/list'))).toMatchObject({ status: 200, body: { error: { code: -32601 } } });
    expect(await g.mcp(rpc('tools/call', { name: 'rm_rf' }))).toMatchObject({ body: { error: { code: -32602 } } });
    expect(await g.mcp(rpc('tools/call', []))).toMatchObject({ body: { error: { code: -32602 } } });
  });
  it('handles batches, rejects batched initialize and drops notification replies', async () => {
    const g = createBotGateway(deps());
    const out = await g.mcp([rpc('ping', undefined, 1), { jsonrpc: '2.0', method: 'notifications/cancelled' }, rpc('initialize', {}, 2)]);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject([{ id: 1, result: {} }, { id: 2, error: { code: -32600 } }]);
    expect(await g.mcp([])).toMatchObject({ status: 400 });
    expect(await g.mcp([{ jsonrpc: '2.0', method: 'notifications/initialized' }])).toEqual({ status: 202 });
  });
  it('reports tool failures as isError results, not protocol errors', async () => {
    const g = createBotGateway(deps());
    const res = await g.mcp(rpc('tools/call', { name: 'flash_submit_order', arguments: { quoteId: 'q1', funder: ADDR, signature: SIG } }));
    const result = (res.body as any).result;
    expect(result.isError).toBe(true);
    expect(parse(result)).toEqual({ error: { code: 'execution_unavailable', message: 'Trading is disabled.' } });
  });
});

describe('signed bot mutations', () => {
  it('forwards a matching SignedBotAction unchanged to executeBot', async () => {
    const d = deps(); const g = createBotGateway(d);
    const signed = envelope('signal.publish', signal);
    const result = await g.callTool('swipr_publish_signal', { signedAction: signed });
    expect(result.isError).toBe(false);
    expect(d.executeBot).toHaveBeenCalledWith(signed);
    const create = envelope('profile.upsert', profile);
    expect((await g.callTool('swipr_register_bot', { signedAction: create })).isError).toBe(false);
    expect(d.executeBot).toHaveBeenLastCalledWith(create);
  });
  it('rejects missing, mismatched, unsigned or over-long envelopes before executeBot', async () => {
    const d = deps(); const g = createBotGateway(d);
    const cases: [string, unknown][] = [
      ['swipr_register_bot', {}],
      ['swipr_halt_bot', { signedAction: envelope('profile.upsert', { name: 'x' }) }],
      ['swipr_register_bot', { signedAction: { payload: envelope('profile.upsert').payload } }],
      ['swipr_register_bot', { signedAction: { ...envelope('profile.upsert'), signature: '0x1234' } }],
      ['swipr_halt_bot', { signedAction: envelope('profile.halt', { profileId: BOT }, { expiresAt: 1_800_000_301 }) }],
      ['swipr_halt_bot', { signedAction: envelope('profile.halt', { profileId: BOT }, { chainId: 1 }) }],
      ['swipr_halt_bot', { signedAction: envelope('profile.halt', {}) }],
      ['swipr_halt_bot', { signedAction: envelope('profile.halt', { profileId: 'bot-1' }) }],
      ['swipr_register_bot', { signedAction: envelope('profile.upsert', { ...profile, assets: [] }) }],
      ['swipr_register_bot', { signedAction: envelope('profile.upsert', { ...profile, owner: ADDR }) }],
      ['swipr_publish_signal', { signedAction: envelope('signal.publish', { ...signal, execute: true }) }],
      ['swipr_halt_bot', { signedAction: envelope('profile.halt'), trusted: true }],
    ];
    for (const [name, args] of cases) {
      const result = await g.callTool(name, args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
    expect(d.executeBot).not.toHaveBeenCalled();
  });
});

describe('REST /api/agent and dependency errors', () => {
  it('shares the dispatcher and maps outcomes to HTTP statuses', async () => {
    const d = deps(); const g = createBotGateway(d);
    expect(await g.agent({ tool: 'swipr_list_bots' })).toMatchObject({ status: 200, body: { tool: 'swipr_list_bots', result: { state: 'unavailable' } } });
    expect(await g.agent({ tool: 'flash_quote', arguments: { side: 'buy', asset: 'WETH', qty: '10', funder: ADDR, limitPrice: '3000' } }))
      .toMatchObject({ status: 200, body: { result: { quoteId: 'q1' } } });
    expect(d.quote).toHaveBeenCalledWith({ side: 'buy', asset: 'WETH', qty: '10', funder: ADDR, limitPrice: '3000' });
    expect(await g.agent({ tool: 'nope' })).toMatchObject({ status: 404, body: { error: { code: 'unknown_tool' } } });
    expect(await g.agent({ tool: 'flash_quote', arguments: { asset: 'DOGE' } })).toMatchObject({ status: 400, body: { error: { code: 'invalid_arguments' } } });
    expect(await g.agent({ name: 'swipr_list_bots' })).toMatchObject({ status: 400 });
    expect(await g.agent({ tool: 'flash_submit_order', arguments: { quoteId: 'q1', funder: ADDR, signature: SIG } })).toMatchObject({ status: 503 });
  });
  it('hides unexpected and provider error details', async () => {
    const providerError = Object.assign(new Error('flash 500 key=secret'), { provider: 'flash' });
    const g = createBotGateway(deps({
      getOrder: async () => { throw providerError; },
      sealFill: async () => { throw new Error('stack with secret'); },
    }));
    const order = await g.agent({ tool: 'flash_get_order', arguments: { orderId: 'o-1', funder: ADDR } });
    expect(order).toMatchObject({ status: 502, body: { error: { code: 'provider_failure' } } });
    const seal = await g.callTool('swipr_seal_fill', { orderId: 'o-1', funder: ADDR, txHash: `0x${'c'.repeat(64)}` });
    expect(seal.isError).toBe(true);
    expect(JSON.stringify([order, seal])).not.toContain('secret');
  });
  it('validates ENS text preparation inputs strictly', async () => {
    const d = deps(); const g = createBotGateway(d);
    expect((await g.callTool('set_ens_text', { name: 'bot.swipr.eth', key: 'swipr.bot', value: 'bot-1' })).isError).toBe(false);
    expect((await g.callTool('set_ens_text', { name: 'Bot.ETH', key: 'url', value: 'x' })).isError).toBe(true);
    expect(d.prepareEnsText).toHaveBeenCalledTimes(1);
  });
});

describe('schema validator', () => {
  it('reports the first violating path', () => {
    const schema = { type: 'object' as const, properties: { n: { type: 'integer' as const, minimum: 2 } }, required: ['n'], additionalProperties: false };
    expect(validate(schema, { n: 2 })).toBeNull();
    expect(validate(schema, { n: 1.5 })).toBe('arguments.n: expected integer');
    expect(validate(schema, {})).toBe('arguments.n: required');
    expect(validate(schema, { n: 3, x: 1 })).toBe('arguments.x: unknown property');
  });
});
