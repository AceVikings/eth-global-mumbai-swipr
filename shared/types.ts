export type Mode = 'tap' | 'auto';
export type Asset = 'WETH' | 'cbBTC';
export type Terms = {
  perTradeUsd: number;
  tradeCount: number;
  durationDays: 1 | 7 | 30;
  mode: Mode;
  breakupUsd: number;
  safetyNetBps: number;
  profitShareBps: number;
  liquidateOnBreakup: boolean;
};
export const DEFAULT_TERMS: Terms = {
  perTradeUsd: 10, tradeCount: 5, durationDays: 7, mode: 'tap',
  breakupUsd: 10, safetyNetBps: 500, profitShareBps: 500,
  liquidateOnBreakup: false,
};
export type Trader = {
  id: string; name: string; ens: string; bio: string;
  style: 'Steady' | 'Balanced' | 'Spicy'; avatar: string;
  kind: 'human' | 'agent'; owner?: string; source?: 'registered';
  operator?: string; profileId?: string;
};
export type Ghost = {
  traderId: string; startedAt: number; perTradeUsd: number;
  expiresAt: number; includedSignalId: string | null;
};
export type IntegrationStatus = {
  name: string; configured: boolean; verified: boolean; detail: string;
};
export type RuntimeStatus = {
  mode: 'preview' | 'live'; integrations: IntegrationStatus[];
  tradingEnabled: false;
};
