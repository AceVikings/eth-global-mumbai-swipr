// Follow graph + leaderboard contract shared by browser, API and worker. Browser-safe: no node imports.

export const SOCIAL_CHAIN_ID = 8453;
export const SOCIAL_MAX_TTL_SECONDS = 300;
export const SOCIAL_ACTIONS = ['follow', 'unfollow'] as const;
export const SOCIAL_LIMITS = { envelopeBytes: 2048, followingPerActor: 200, writesPerHour: 500 } as const;

export type SocialActionType = typeof SOCIAL_ACTIONS[number];

/** Target is any wallet address (trader or copier). The actor is always the recovered signer. */
export type SocialAction = {
  version: 1; audience: string; chainId: 8453; requestId: string;
  issuedAt: number; expiresAt: number; action: SocialActionType; target: string;
};
export type SignedSocialAction = { payload: SocialAction; signature: `0x${string}` };

export type SocialProfile = { address: string; name: string; kind: 'trader' | 'copier' };
/** Built only from verified closed fills. netProfitUsd/returnPct are signed decimal strings. */
export type LeaderboardRow = SocialProfile & { netProfitUsd: string; returnPct: string | null; closedPositions: number };
export type LeaderboardResponse = { state: 'ready' | 'unavailable'; detail: string; rows: LeaderboardRow[]; asOf: string | null };
export type SocialResponse = { following: string[]; state: 'ready' | 'unavailable'; detail: string; audience: string };

/** Exact text the wallet signs with personal_sign (EIP-191). Only these fields, in this order. */
export function socialMessage(payload: SocialAction): string {
  return [
    'Swipr social v1 (no funds move)',
    `version: ${payload.version}`,
    `audience: ${payload.audience}`,
    `chainId: ${payload.chainId}`,
    `requestId: ${payload.requestId}`,
    `issuedAt: ${payload.issuedAt}`,
    `expiresAt: ${payload.expiresAt}`,
    `action: ${payload.action}`,
    `target: ${payload.target}`,
  ].join('\n');
}
