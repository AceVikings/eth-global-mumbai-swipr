import { ApiError } from '../auth';
import { BOT_ASSETS, BOT_CHAIN_ID, BOT_MAX_TTL_SECONDS, BOT_STRATEGIES, BOT_STYLES,
  type BotActionType, type BotAsset, type SignedBotAction } from '../contracts/bots';

// Transport-neutral dispatcher shared by POST /mcp (stateless JSON-RPC 2.0, MCP 2025-03-26)
// and POST /api/agent ({ tool, arguments }). The host owns HTTP parsing, CORS, body limits
// and provider wiring. This module never verifies or bypasses wallet signatures itself:
// bot mutations only reach executeBot with a SignedBotAction whose action matches the tool.

export const MCP_PROTOCOL_VERSION = '2025-03-26';
export const SERVER_INFO = { name: 'swipr', version: '0.1.0' } as const;
const MAX_BATCH = 20;

export type Side = 'buy' | 'sell';
export interface QuoteArgs { side: Side; asset: BotAsset; qty: string; funder: string; limitPrice: string }
export interface OrderLookupArgs { orderId: string; funder: string }
export interface SubmitOrderArgs { quoteId: string; funder: string; signature: `0x${string}` }
export interface SealFillArgs { orderId: string; funder: string; txHash: `0x${string}` }
export interface EnsTextArgs { name: string; key: string; value: string }

export interface BotGatewayDeps {
  listBots(): Promise<unknown>;
  prepareWalletAction?(input: Record<string, unknown>): Promise<unknown>;
  /** Must forward the raw envelope to the worker, which verifies EIP-191, freshness and replay. */
  executeBot(envelope: SignedBotAction): Promise<unknown>;
  quote(input: QuoteArgs): Promise<unknown>;
  getOrder(input: OrderLookupArgs): Promise<unknown>;
  /** The wallet's EIP-712 signature over the Flash order is the only authority; never sign server-side. */
  submitOrder(input: SubmitOrderArgs): Promise<unknown>;
  /** Must derive the fill from provider status and a Base receipt, never from caller claims. */
  sealFill(input: SealFillArgs): Promise<unknown>;
  /** Returns unsigned calldata for the wallet to send; must not broadcast. */
  prepareEnsText(input: EnsTextArgs): Promise<unknown>;
}

export interface JsonSchema {
  type: 'object' | 'array' | 'string' | 'integer';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  enum?: readonly (string | number)[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}
export interface ToolAnnotations { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
export interface ToolDescriptor { name: ToolName; description: string; inputSchema: JsonSchema; annotations: ToolAnnotations }
export interface CallToolResult { content: { type: 'text'; text: string }[]; isError: boolean }
export type ToolOutcome =
  | { ok: true; data: unknown }
  | { ok: false; status: number; code: string; message: string };
export type GatewayResponse = { status: number; body?: unknown };

const ADDRESS = '^0x[0-9a-fA-F]{40}$';
const SIG = '^0x[0-9a-fA-F]{130}$';
const HASH = '^0x[0-9a-fA-F]{64}$';
const DECIMAL = '^(0|[1-9][0-9]{0,17})(\\.[0-9]{1,18})?$';
const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const ID = '^[A-Za-z0-9_-]{1,128}$';

const str = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: 'string', description, ...extra });
const obj = (properties: Record<string, JsonSchema>, required = Object.keys(properties), description?: string): JsonSchema =>
  ({ type: 'object', ...(description && { description }), properties, required, additionalProperties: false });
const ASSET = str('Base asset traded against USDC.', { enum: BOT_ASSETS });
const SIDE = str('Order side.', { enum: ['buy', 'sell'] });
const FUNDER = str('Wallet that funds and signs the order.', { pattern: ADDRESS });

// Mirrors the key sets in server/bots/validation.ts so mismatched envelopes fail before a
// network hop. The worker stays authoritative for text normalization, lengths and signatures.
const PROFILE_ID = str('Stable profile UUID.', { pattern: UUID });
const ACTION_DATA: Record<BotActionType, JsonSchema> = {
  'profile.upsert': obj({
    profileId: str('Omit to create (the new ID is this requestId); set to edit.', { pattern: UUID }),
    operator: str('Wallet allowed to publish signals for this bot.', { pattern: ADDRESS }),
    ensName: str('Optional second-level ENSv2 Sepolia name.', { maxLength: 255 }),
    image: str('Optional WebP thumbnail data URL (8 KB decoded); empty removes it.', { maxLength: 10947 }),
    name: str('Display name.', { minLength: 1 }), bio: str('Short bio.'),
    style: str('Risk style.', { enum: BOT_STYLES }), strategy: str('How signals are produced.', { enum: BOT_STRATEGIES }),
    assets: { type: 'array', items: ASSET, minItems: 1, maxItems: 8 },
  }, ['operator', 'name', 'style', 'strategy', 'assets']),
  'profile.halt': obj({ profileId: PROFILE_ID }),
  'signal.publish': obj({
    profileId: PROFILE_ID, asset: ASSET, side: SIDE,
    quantity: str('Positive decimal quantity.', { pattern: DECIMAL }), limitPrice: str('Positive decimal USDC limit price.', { pattern: DECIMAL }),
    thesis: str('Optional rationale.'),
  }, ['profileId', 'asset', 'side', 'quantity', 'limitPrice'], 'A proposal only; never an executable order or verified fill.'),
};
const signedAction = (action: BotActionType): JsonSchema => obj({
  payload: obj({
    version: { type: 'integer', enum: [1] },
    audience: str('Must equal the audience from GET /api/bots/integration.', { minLength: 1, maxLength: 256 }),
    chainId: { type: 'integer', enum: [BOT_CHAIN_ID] },
    requestId: str('Fresh UUID; reused IDs replay or conflict.', { pattern: UUID }),
    issuedAt: { type: 'integer', description: 'Unix seconds.', minimum: 1 },
    expiresAt: { type: 'integer', description: `Unix seconds, at most ${BOT_MAX_TTL_SECONDS} after issuedAt.`, minimum: 1 },
    action: str('Must match this tool.', { enum: [action] }),
    data: ACTION_DATA[action],
  }),
  signature: str('EIP-191 personal_sign of botMessage(payload).', { pattern: SIG }),
}, undefined, `SignedBotAction with action "${action}".`);

type Run = (deps: BotGatewayDeps, args: any) => Promise<unknown>;
const tool = (name: ToolName, description: string, inputSchema: JsonSchema, hints: Partial<ToolAnnotations>, run: Run) =>
  ({ name, description, inputSchema, run, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, ...hints } });
const bot = (action: BotActionType): Run => (deps, args: { signedAction: SignedBotAction }) => {
  const { payload } = args.signedAction;
  if (payload.expiresAt <= payload.issuedAt || payload.expiresAt - payload.issuedAt > BOT_MAX_TTL_SECONDS)
    throw new ApiError(400, 'invalid_freshness', `expiresAt must be within ${BOT_MAX_TTL_SECONDS} seconds after issuedAt.`);
  if (payload.action !== action) throw new ApiError(400, 'action_mismatch', `This tool only accepts ${action}.`);
  return deps.executeBot(args.signedAction);
};

export const TOOL_NAMES = ['swipr_prepare_wallet_action', 'swipr_list_bots', 'swipr_register_bot', 'swipr_halt_bot', 'swipr_publish_signal',
  'flash_quote', 'flash_get_order', 'flash_submit_order', 'swipr_seal_fill', 'set_ens_text'] as const;
export type ToolName = typeof TOOL_NAMES[number];

const TOOLS = [
  tool('swipr_prepare_wallet_action', 'Prepare an unsigned Arkiv profile or signal transaction. The owner/operator wallet must approve and send it on Rabdi. Never trades or transfers funds.', obj({
    wallet: FUNDER, action: str('Wallet action.', { enum: ['profile.upsert', 'profile.halt', 'signal.publish'] }),
    data: { type: 'object', additionalProperties: true, description: 'Profile fields, profileId for halt, or profileId/asset/side/quantity/limitPrice/thesis for a signal. Use the native 0x entity key.' },
  }), { readOnlyHint: true }, (deps, args) => {
    if (!deps.prepareWalletAction) throw new ApiError(503, 'storage_unavailable', 'Wallet storage is unavailable.');
    return deps.prepareWalletAction(args);
  }),
  tool('swipr_list_bots', 'List registered bot profiles and published signals with storage readiness.', obj({}),
    { readOnlyHint: true, idempotentHint: true }, deps => deps.listBots()),
  tool('swipr_register_bot', 'Create or edit a bot profile. Must be signed by the owner wallet.',
    obj({ signedAction: signedAction('profile.upsert') }), { idempotentHint: true }, bot('profile.upsert')),
  tool('swipr_halt_bot', 'Halt a bot profile so it cannot publish new signals. Must be signed by the owner wallet.',
    obj({ signedAction: signedAction('profile.halt') }), { destructiveHint: true, idempotentHint: true }, bot('profile.halt')),
  tool('swipr_publish_signal', 'Publish a trade proposal. Must be signed by the registered operator. Signals are not orders or fills.',
    obj({ signedAction: signedAction('signal.publish') }), { idempotentHint: true }, bot('signal.publish')),
  tool('flash_quote', 'Fetch an indicative Flash limit-order quote on Base. Never submits an order.', obj({
    side: SIDE, asset: ASSET, funder: FUNDER,
    qty: str('Decimal: USDC notional for buys, asset units for sells.', { pattern: DECIMAL }),
    limitPrice: str('Decimal USDC limit price.', { pattern: DECIMAL }),
  }), { readOnlyHint: true, openWorldHint: true }, (deps, a: QuoteArgs) => deps.quote(a)),
  tool('flash_get_order', 'Read a Flash order status and provider-reported fills.', obj({
    orderId: str('Flash order ID.', { pattern: ID }), funder: FUNDER,
  }), { readOnlyHint: true, idempotentHint: true, openWorldHint: true }, (deps, a: OrderLookupArgs) => deps.getOrder(a)),
  tool('flash_submit_order', 'Relay a quote the funder wallet already signed (EIP-712). The server never signs. Rejected while trading is disabled.', obj({
    quoteId: str('Quote ID returned by flash_quote.', { pattern: ID }), funder: FUNDER,
    signature: str('Funder EIP-712 signature over the quoted order.', { pattern: SIG }),
  }), { openWorldHint: true }, (deps, a: SubmitOrderArgs) => deps.submitOrder(a)),
  tool('swipr_seal_fill', 'Seal a fill derived from Flash order status and a Base receipt. Caller claims are never trusted.', obj({
    orderId: str('Flash order ID.', { pattern: ID }), funder: FUNDER,
    txHash: str('Base settlement transaction hash.', { pattern: HASH }),
  }), { idempotentHint: true, openWorldHint: true }, (deps, a: SealFillArgs) => deps.sealFill(a)),
  tool('set_ens_text', 'Prepare unsigned calldata to set an ENS text record. The wallet signs and sends it; nothing is broadcast.', obj({
    name: str('ENS name.', { pattern: '^([a-z0-9-]{1,63}\\.)+eth$', maxLength: 255 }),
    key: str('Text record key.', { pattern: '^[A-Za-z0-9._:-]{1,64}$' }),
    value: str('Text record value.', { maxLength: 1024 }),
  }), { readOnlyHint: true, idempotentHint: true }, (deps, a: EnsTextArgs) => deps.prepareEnsText(a)),
];
const BY_NAME = new Map(TOOLS.map(t => [t.name as string, t]));
export const TOOL_DESCRIPTORS: ToolDescriptor[] = TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }));

/** Returns the first violation as "path: reason", or null when value matches schema. */
export function validate(schema: JsonSchema, value: unknown, path = 'arguments'): string | null {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${path}: expected object`;
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!Object.hasOwn(record, key)) return `${path}.${key}: required`;
    for (const [key, child] of Object.entries(record)) {
      const sub = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
      if (!sub) { if (schema.additionalProperties === false) return `${path}.${key}: unknown property`; continue; }
      const error = validate(sub, child, `${path}.${key}`);
      if (error) return error;
    }
    return null;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${path}: expected array`;
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${path}: too few items`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path}: too many items`;
    for (const [i, item] of value.entries()) {
      const error = schema.items && validate(schema.items, item, `${path}[${i}]`);
      if (error) return error;
    }
    return null;
  }
  if (schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return `${path}: expected integer`;
    if (schema.minimum !== undefined && value < schema.minimum) return `${path}: below minimum`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path}: above maximum`;
  } else {
    if (typeof value !== 'string') return `${path}: expected string`;
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${path}: too short`;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${path}: too long`;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${path}: invalid format`;
  }
  if (schema.enum && !schema.enum.includes(value as string | number)) return `${path}: must be one of ${schema.enum.join(', ')}`;
  return null;
}

const failure = (status: number, code: string, message: string): ToolOutcome => ({ ok: false, status, code, message });
const text = (value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }];
type RpcId = string | number | null;
const rpcError = (id: RpcId, code: number, message: string, data?: unknown) =>
  ({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined && { data }) } });
const rpcResult = (id: RpcId, result: unknown) => ({ jsonrpc: '2.0', id, result });
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const validId = (id: unknown): id is string | number => typeof id === 'string' || (typeof id === 'number' && Number.isInteger(id));

/** Body for a request whose JSON could not be parsed; the host sends it with HTTP 400. */
export const PARSE_ERROR_BODY = rpcError(null, -32700, 'Parse error');

export function createBotGateway(deps: BotGatewayDeps) {
  const descriptors = deps.prepareWalletAction
    ? TOOL_DESCRIPTORS.filter(t => ['swipr_list_bots', 'swipr_prepare_wallet_action', 'flash_quote', 'flash_get_order'].includes(t.name))
    : TOOL_DESCRIPTORS;
  async function dispatch(name: unknown, args: unknown): Promise<ToolOutcome> {
    const def = typeof name === 'string' ? BY_NAME.get(name) : undefined;
    if (!def) return failure(404, 'unknown_tool', 'Unknown tool.');
    const input = args === undefined ? {} : args;
    const invalid = validate(def.inputSchema, input);
    if (invalid) return failure(400, 'invalid_arguments', invalid);
    try {
      return { ok: true, data: await def.run(deps, structuredClone(input)) };
    } catch (error) {
      if (error instanceof ApiError) return failure(error.status, error.code, error.message);
      // Never echo provider payloads, stack traces or credentials to agents.
      const provider = isRecord(error) && 'provider' in error;
      return provider ? failure(502, 'provider_failure', 'The provider could not complete this request.')
        : failure(503, 'service_unavailable', 'The service could not complete this request.');
    }
  }

  async function callTool(name: string, args: unknown): Promise<CallToolResult> {
    const outcome = await dispatch(name, args);
    return outcome.ok ? { content: text(outcome.data), isError: false }
      : { content: text({ error: { code: outcome.code, message: outcome.message } }), isError: true };
  }

  /** POST /api/agent with body { tool, arguments }. */
  async function agent(input: unknown): Promise<GatewayResponse> {
    if (!isRecord(input) || typeof input.tool !== 'string' || Object.keys(input).some(k => k !== 'tool' && k !== 'arguments'))
      return { status: 400, body: { error: { code: 'invalid_request', message: 'Send { "tool": string, "arguments": object }.' } } };
    const outcome = await dispatch(input.tool, input.arguments);
    return outcome.ok ? { status: 200, body: { tool: input.tool, result: outcome.data } }
      : { status: outcome.status, body: { error: { code: outcome.code, message: outcome.message } } };
  }

  async function message(msg: unknown, inBatch: boolean): Promise<object | null> {
    if (!isRecord(msg) || msg.jsonrpc !== '2.0') return rpcError(isRecord(msg) && validId(msg.id) ? msg.id : null, -32600, 'Invalid Request');
    if (typeof msg.method !== 'string') {
      // Client responses (result/error) need no reply.
      return 'id' in msg && ('result' in msg || 'error' in msg) ? null : rpcError(validId(msg.id) ? msg.id : null, -32600, 'Invalid Request');
    }
    if (!('id' in msg)) return null; // Notifications never get a response and never run tools.
    if (!validId(msg.id)) return rpcError(null, -32600, 'Invalid Request');
    const id = msg.id;
    if (msg.params !== undefined && !isRecord(msg.params)) return rpcError(id, -32602, 'Invalid params');
    const params = (msg.params ?? {}) as Record<string, unknown>;
    switch (msg.method) {
      case 'initialize':
        if (inBatch) return rpcError(id, -32600, 'initialize must not be batched');
        return rpcResult(id, {
          protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO,
          instructions: deps.prepareWalletAction
            ? 'Prepare wallet writes with swipr_prepare_wallet_action, then approve and send the returned transaction using the owner/operator wallet on Arkiv Rabdi. API/MCP never signs or broadcasts. Signals are proposals, not orders or fills.'
            : 'Swipr bot tools. Mutations require a wallet-signed SignedBotAction; signals are proposals, not orders or fills. Trading stays disabled until verified gates pass.',
        });
      case 'ping': return rpcResult(id, {});
      case 'tools/list': return rpcResult(id, { tools: descriptors });
      case 'tools/call': {
        if (typeof params.name !== 'string') return rpcError(id, -32602, 'Invalid params: name is required');
        if (!BY_NAME.has(params.name)) return rpcError(id, -32602, `Unknown tool: ${params.name.slice(0, 64)}`);
        return rpcResult(id, await callTool(params.name, params.arguments));
      }
      default: return rpcError(id, -32601, 'Method not found');
    }
  }

  /** POST /mcp with an already-parsed JSON body. 202 without body means nothing to return. */
  async function mcp(input: unknown): Promise<GatewayResponse> {
    if (Array.isArray(input)) {
      if (!input.length || input.length > MAX_BATCH) return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
      const replies = (await Promise.all(input.map(m => message(m, true)))).filter(r => r !== null);
      return replies.length ? { status: 200, body: replies } : { status: 202 };
    }
    const reply = await message(input, false);
    if (!reply) return { status: 202 };
    const invalid = 'error' in reply && (reply.error as { code: number }).code === -32600;
    return { status: invalid ? 400 : 200, body: reply };
  }

  return { mcp, agent, callTool, dispatch, tools: descriptors };
}
export type BotGateway = ReturnType<typeof createBotGateway>;
