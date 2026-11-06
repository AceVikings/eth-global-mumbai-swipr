import { SOCIAL_MAX_TTL_SECONDS } from '../contracts/social';
import type { LeaderboardResponse, LeaderboardRow, SignedSocialAction, SocialAction, SocialResponse } from '../contracts/social';

export type { LeaderboardRow, SignedSocialAction, SocialAction };
export type Role = LeaderboardRow['kind'];
export type Sort = 'percentage' | 'absolute';
export type Scope = 'everyone' | 'following';

export const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const configured = import.meta.env.VITE_API_URL as string | undefined;
const apiBase = configured ? configured.replace(/\/$/, '') : '';

/** uncertain: the server may or may not have applied the write, so the exact envelope must be retried. */
export class SocialError extends Error {
  constructor(message: string, readonly uncertain: boolean) { super(message); }
}

async function request<T>(path: string, token: string | null, init: RequestInit = {}): Promise<T> {
  if (apiBase) {
    const url = new URL(apiBase);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new SocialError('The API URL must use HTTPS.', false);
  }
  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      cache: 'no-store', ...init,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new SocialError(navigator.onLine ? 'The social service could not be reached.' : 'You are offline.', true);
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const detail = record.error ?? record.detail;
    const nested = detail && typeof detail === 'object' ? detail as Record<string, unknown> : {};
    const text = typeof nested.message === 'string' ? nested.message : typeof detail === 'string' && detail ? detail : `Request failed (${response.status}).`;
    throw new SocialError(text, response.status === 503 || response.status === 409 || response.status >= 500);
  }
  return body as T;
}

const isRow = (r: unknown): r is LeaderboardRow => {
  const v = r as Record<string, unknown> | null;
  return !!v && typeof v.address === 'string' && ADDRESS.test(v.address) && typeof v.name === 'string'
    && (v.kind === 'trader' || v.kind === 'copier') && typeof v.netProfitUsd === 'string' && Number.isFinite(Number(v.netProfitUsd))
    && (v.returnPct === null || (typeof v.returnPct === 'string' && Number.isFinite(Number(v.returnPct))))
    && Number.isInteger(v.closedPositions);
};

export async function getLeaderboard(
  q: { role: Role; sort: Sort; scope: Scope; wallet: string | null }, token: string | null, signal: AbortSignal,
): Promise<LeaderboardResponse> {
  const params = new URLSearchParams({ role: q.role, sort: q.sort, scope: q.scope });
  if (q.wallet) params.set('wallet', q.wallet);
  const value = await request<LeaderboardResponse>(`/api/leaderboards?${params}`, token, { signal });
  if (!value || !['ready', 'unavailable'].includes(value.state) || !Array.isArray(value.rows) || !value.rows.every(isRow)
    || value.rows.some(r => r.kind !== q.role)) {
    throw new SocialError('Invalid leaderboard response.', false);
  }
  return value;
}

export async function getSocial(wallet: string, token: string, signal: AbortSignal): Promise<SocialResponse> {
  const value = await request<SocialResponse>(`/api/social?wallet=${wallet}`, token, { signal });
  if (!value || !['ready', 'unavailable'].includes(value.state) || !Array.isArray(value.following)
    || !value.following.every(a => typeof a === 'string' && ADDRESS.test(a)) || typeof value.audience !== 'string') {
    throw new SocialError('Invalid social response.', false);
  }
  return value;
}

export const sendSocialCommand = (signed: SignedSocialAction, token: string) =>
  request<unknown>('/api/social/commands', token, { method: 'POST', body: JSON.stringify(signed) });

export function buildSocialAction(audience: string, action: SocialAction['action'], target: string): SocialAction {
  const issuedAt = Math.floor(Date.now() / 1000);
  return {
    version: 1, audience, chainId: 8453, requestId: crypto.randomUUID(), issuedAt, expiresAt: issuedAt + SOCIAL_MAX_TTL_SECONDS,
    action, target: target.toLowerCase(),
  };
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
export const formatUsd = (v: string) => { const n = Number(v); return `${n > 0 ? '+' : ''}${usd.format(n)}`; };
export const formatPct = (v: string | null) => {
  if (v === null) return '—';
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
};
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
