import { BOT_ASSETS, BOT_LIMITS, BOT_MAX_TTL_SECONDS, BOT_STRATEGIES, BOT_STYLES, botMessage } from '../contracts/bots';
import type { BotAction, BotAsset, BotProfile, BotsListResponse, BotStrategy, BotStyle, ProfileUpsertData, SignedBotAction } from '../contracts/bots';

export type { BotProfile, BotsListResponse as BotsResponse };
export type BotTool = string | { name: string; description?: string };
/** apiUrl is the bare API origin (no /api suffix). */
export type Integration = { audience: string; mcpUrl: string; apiUrl: string; tools: BotTool[]; tradingEnabled: false };
/** profileId is absent for a new bot; the service assigns the creating requestId as its stable id. */
export type ProfileDraft = {
  profileId?: string; operator: string; name: string; bio: string;
  style: BotStyle; strategy: BotStrategy; assets: BotAsset[];
  publicSeats?: number; privateSeats?: number;
};

export const STYLES = BOT_STYLES;
export const STRATEGIES = BOT_STRATEGIES;
export const ASSETS = BOT_ASSETS;
export const LIMITS = BOT_LIMITS;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const configured = import.meta.env.VITE_API_URL as string | undefined;
export const apiBase = configured ? configured.replace(/\/$/, '') : '';
export const absoluteBase = () => apiBase || window.location.origin;

/** status 0 + write_uncertain: the request may or may not have reached the service. */
export class BotRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'BotRequestError';
  }
}

/** Retrying the exact signed envelope is the only safe follow-up: the write may have landed. */
export const isUncertain = (e: unknown) =>
  e instanceof BotRequestError && (e.status === 0 || e.status === 503 || (e.status === 409 && e.code !== 'halted'));

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (apiBase) {
    const url = new URL(apiBase);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('The API URL must use HTTPS.');
  }
  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}`, { cache: 'no-store', ...init, headers: { 'content-type': 'application/json', ...init.headers } });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new BotRequestError(0, 'write_uncertain', navigator.onLine ? 'The bot service could not be reached.' : 'You are offline.');
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : null;
    const nested = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : null;
    const message = nested?.message ?? error ?? (body as { detail?: unknown } | null)?.detail;
    throw new BotRequestError(response.status, typeof nested?.code === 'string' ? nested.code : 'request_failed',
      typeof message === 'string' && message ? message : `Request failed (${response.status}).`);
  }
  return body as T;
}

export async function getBots(signal: AbortSignal): Promise<BotsListResponse> {
  const value = await request<BotsListResponse>('/api/bots', { signal });
  if (!value || !Array.isArray(value.profiles) || !Array.isArray(value.signals) || !['ready', 'unavailable'].includes(value.state)) {
    throw new Error('Invalid bot service response.');
  }
  return value;
}

export async function getIntegration(signal: AbortSignal): Promise<Integration> {
  const value = await request<Integration>('/api/bots/integration', { signal });
  if (!value || typeof value.audience !== 'string' || !Array.isArray(value.tools) || value.tradingEnabled !== false) {
    throw new Error('Invalid integration response.');
  }
  return value;
}

/** Owner management (upsert/halt) requires the Google session's Bearer token; the server matches it to the signer. */
export const sendCommand = (signed: SignedBotAction, accessToken: string) =>
  request<unknown>('/api/bots/commands', { method: 'POST', body: JSON.stringify(signed), headers: { authorization: `Bearer ${accessToken}` } });

export function buildAction(audience: string, action: BotAction['action'], data: BotAction['data']): BotAction {
  const issuedAt = Math.floor(Date.now() / 1000);
  return { version: 1, audience, chainId: 8453, requestId: crypto.randomUUID(), issuedAt, expiresAt: issuedAt + BOT_MAX_TTL_SECONDS, action, data };
}

/** Signs botMessage(payload) with the session wallet; the signature lives only in memory until sent. */
export async function signAction(payload: BotAction, sign: (message: string) => Promise<{ signature: `0x${string}` }>): Promise<SignedBotAction> {
  const { signature } = await sign(botMessage(payload));
  return { payload, signature };
}

export function validateDraft(d: ProfileDraft): Partial<Record<keyof ProfileDraft, string>> {
  const errors: Partial<Record<keyof ProfileDraft, string>> = {};
  if (!ADDRESS.test(d.operator.trim())) errors.operator = 'Enter a 0x operator address (40 hex characters).';
  const name = d.name.trim().length;
  if (name < BOT_LIMITS.nameMin || name > BOT_LIMITS.nameMax) errors.name = `Name must be ${BOT_LIMITS.nameMin}–${BOT_LIMITS.nameMax} characters.`;
  if (d.bio.trim().length > BOT_LIMITS.bioMax) errors.bio = `Bio must be ${BOT_LIMITS.bioMax} characters or fewer.`;
  if (!d.assets.length) errors.assets = 'Choose at least one asset.';
  for (const key of ['publicSeats', 'privateSeats'] as const) if (!Number.isSafeInteger(d[key] ?? (key === 'publicSeats' ? 20 : 0)) || Number(d[key]) < 0 || Number(d[key]) > 100) errors[key] = 'Choose 0–100 seats.';
  return errors;
}

/** Exact upsert payload: only contract keys, profileId only when editing. */
export const upsertData = (d: ProfileDraft): ProfileUpsertData => ({
  ...(d.profileId ? { profileId: d.profileId } : {}),
  operator: d.operator.trim().toLowerCase(), name: d.name.trim(), bio: d.bio.trim(),
  style: d.style, strategy: d.strategy, assets: BOT_ASSETS.filter(a => d.assets.includes(a)),
  ...(d.publicSeats === undefined ? {} : { publicSeats: d.publicSeats }),
  ...(d.privateSeats === undefined ? {} : { privateSeats: d.privateSeats }),
});

export const emptyDraft = (operator = ''): ProfileDraft =>
  ({ operator, name: '', bio: '', style: 'Balanced', strategy: 'rule-based', assets: ['WETH'], publicSeats: 20, privateSeats: 0 });

export const draftFrom = (p: BotProfile): ProfileDraft =>
  ({ profileId: p.id, operator: p.operator, name: p.name, bio: p.bio, style: p.style, strategy: p.strategy, assets: [...p.assets], publicSeats: p.publicSeats ?? 20, privateSeats: p.privateSeats ?? 0 });

const DRAFT_KEY = 'swipr.bot-draft.v1';
export function loadLocalDraft(): ProfileDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    const d = raw ? (JSON.parse(raw) as ProfileDraft) : null;
    return d && !d.profileId && typeof d.name === 'string' && Array.isArray(d.assets) ? d : null;
  } catch { return null; }
}
export function saveLocalDraft(d: ProfileDraft | null) {
  try { d ? localStorage.setItem(DRAFT_KEY, JSON.stringify(d)) : localStorage.removeItem(DRAFT_KEY); } catch { /* storage unavailable */ }
}

export const toolName = (t: BotTool) => (typeof t === 'string' ? t : t.name);
export const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

export function snippets(i: Integration | null) {
  const origin = (i?.apiUrl || absoluteBase()).replace(/\/$/, '');
  const mcp = i?.mcpUrl || `${origin}/mcp`;
  const signal = { wallet: '<operator wallet address>', action: 'signal.publish',
    data: { profileId: '<Arkiv profile entity key>', asset: 'WETH', side: 'buy', quantity: '0.01', limitPrice: '3000', thesis: 'optional rationale' } };
  return {
    curl: [
      `curl -s ${origin}/api/bots`,
      `curl -s ${origin}/api/bots/integration`,
      '# Prepare an unsigned wallet transaction. This request does not publish anything.',
      `curl -s -X POST ${origin}/api/bots/wallet-transaction -H 'content-type: application/json' -d @wallet-action.json`,
      '# Send the returned transaction through the registered operator wallet on Arkiv Rabdi.',
    ].join('\n\n'),
    mcp: JSON.stringify({ mcpServers: { swipr: { type: 'http', url: mcp } } }, null, 2),
    example: [
      '// The registered operator wallet owns its signal records on Arkiv Rabdi.',
      '// Signals are proposals; publishing never places a trade.',
      `const action = ${JSON.stringify(signal, null, 2)};`,
      `const response = await fetch('${origin}/api/bots/wallet-transaction', {`,
      "  method: 'POST',",
      "  headers: { 'content-type': 'application/json' },",
      '  body: JSON.stringify(action),',
      '});',
      "if (!response.ok) throw new Error('Transaction could not be prepared.');",
      'const { transaction } = await response.json();',
      '// Use your wallet provider; the platform never asks for its private key.',
      "await provider.request({",
      "  method: 'wallet_switchEthereumChain',",
      "  params: [{ chainId: transaction.chainId }],",
      "});",
      "const txHash = await provider.request({",
      "  method: 'eth_sendTransaction',",
      "  params: [transaction],",
      "});",
      '// Wait for two confirmations, then refresh GET /api/bots.',
    ].join('\n'),
  };
}
