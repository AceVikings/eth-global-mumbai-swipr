// Trader-owned bot contract shared by browser, API, MCP and worker. Browser-safe: no node imports.
import type { Asset } from './types';

export const BOT_CHAIN_ID = 8453;
export const BOT_MAX_TTL_SECONDS = 300;
export const BOT_STYLES = ['Steady', 'Balanced', 'Spicy'] as const;
export const BOT_STRATEGIES = ['rule-based', 'llm', 'manual'] as const;
export const BOT_ASSETS = ['WETH', 'cbBTC'] as const satisfies readonly Asset[];
export const BOT_ACTIONS = ['profile.upsert', 'profile.halt', 'signal.publish'] as const;
export const BOT_LIMITS = {
  nameMin: 2, nameMax: 40, bioMax: 280, thesisMax: 280,
  envelopeBytes: 4096, profilesPerOwner: 5, profilesTotal: 500,
  signalsPerProfilePerDay: 100, listSignals: 200,
} as const;

export type BotStyle = typeof BOT_STYLES[number];
export type BotStrategy = typeof BOT_STRATEGIES[number];
export type BotAsset = typeof BOT_ASSETS[number];
export type BotActionType = typeof BOT_ACTIONS[number];

/** No ERC-8004/ENS verification is implied: owner/operator are recovered signer addresses only. */
export type BotProfile = {
  id: string; owner: string; operator: string; name: string; bio: string;
  style: BotStyle; strategy: BotStrategy; assets: BotAsset[];
  status: 'active' | 'halted'; createdAt: string; updatedAt: string;
  storage?: 'wallet';
};

/** A published proposal. Never an executable order, a fill, or performance evidence. */
export type BotSignal = {
  id: string; profileId: string; operator: string; asset: BotAsset; side: 'buy' | 'sell';
  quantity: string; limitPrice: string; thesis?: string; kind: 'proposal'; createdAt: string;
};

/** Omit profileId to create; the new profile id is the creating requestId. */
export type ProfileUpsertData = {
  profileId?: string; operator: string; name: string; bio: string;
  style: BotStyle; strategy: BotStrategy; assets: BotAsset[];
};
export type ProfileHaltData = { profileId: string };
export type SignalPublishData = {
  profileId: string; asset: BotAsset; side: 'buy' | 'sell'; quantity: string; limitPrice: string; thesis?: string;
};

export type BotAction = {
  version: 1; audience: string; chainId: 8453; requestId: string;
  issuedAt: number; expiresAt: number; action: BotActionType;
  data: ProfileUpsertData | ProfileHaltData | SignalPublishData | Record<string, unknown>;
};
export type SignedBotAction = { payload: BotAction; signature: `0x${string}` };

export type BotsListResponse = {
  profiles: BotProfile[]; signals: BotSignal[]; state: 'ready' | 'unavailable'; detail: string;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Exact text the wallet signs with personal_sign (EIP-191). Data is sorted-key JSON. */
export function botMessage(payload: BotAction): string {
  return [
    'Swipr bot action (no funds move; signals are proposals only)',
    `version: ${payload.version}`,
    `audience: ${payload.audience}`,
    `chainId: ${payload.chainId}`,
    `requestId: ${payload.requestId}`,
    `issuedAt: ${payload.issuedAt}`,
    `expiresAt: ${payload.expiresAt}`,
    `action: ${payload.action}`,
    `data: ${canonical(payload.data)}`,
  ].join('\n');
}
