import { describe, it, expect } from 'vitest';
import { str, bytes } from '@arkiv-network/sdk/schema';
import type { FullEntity } from '@arkiv-network/sdk';
import type { BotProfile } from '../contracts/bots';
import { DEFAULT_TERMS } from '../contracts/types';
import { parsePassRequest, parsePassTerms, passRequestHash } from '../contracts/passes';
import { WALLET_PASS_SCHEMA, WALLET_PASS_DECISION_SCHEMA, WALLET_PROFILE_PROJECT } from '../contracts/wallet-profile';
import { resolveWalletPasses } from './wallet';
const owner = `0x${'12'.repeat(20)}`, traderOwner = `0x${'34'.repeat(20)}`, outsider = `0x${'56'.repeat(20)}`;
const key = (n: string) => `0x${n.repeat(64)}` as `0x${string}`;
const request = { traderId: key('a'), traderOwner, terms: DEFAULT_TERMS };
const profiles = [{ id: request.traderId, owner: traderOwner, status: 'active' }] as BotProfile[];
const encoded = (v: unknown) => bytes(new TextEncoder().encode(JSON.stringify(v)));
const entity = (schema: string, wallet: string, block: bigint, attributes: Record<string, unknown>) => ({
  $key: key(String(block)), $owner: wallet, $createdAt: block, $attributes: {
    'arkiv.schema': str(schema), project: str(WALLET_PROFILE_PROJECT), ...attributes,
  },
}) as unknown as FullEntity;
const row = () => entity(WALLET_PASS_SCHEMA, owner, 1n, { request: encoded(request), status: str('pending') });
const answer = (decision = 'accepted', wallet = traderOwner, block = 2n, hash = passRequestHash(request)) =>
  entity(WALLET_PASS_DECISION_SCHEMA, wallet, block, { requestId: str(key('1')),
    decision: encoded({ requestId: key('1'), requestHash: hash, decision }) });
const times = new Map([[1n, 1700000000000], [2n, 1700000001000], [3n, 1700000002000]]);
const resolve = (answers: FullEntity[], rows = [row()], wallet = owner, now = 1700000003000) => resolveWalletPasses(rows, answers, profiles, times, wallet, now);
describe('mutual wallet-owned passes', () => {
  it('stays pending without a native trader-owned response', () => {
    expect(resolve([])[0].status).toBe('pending');
    expect(resolve([answer('accepted', outsider)])[0].status).toBe('pending');
    expect(resolve([answer()], [row()], outsider)).toEqual([]);
    expect(resolve([answer()], [row()], traderOwner)[0].status).toBe('accepted');
  });
  it('binds acceptance to frozen terms, never to a client claim', () => {
    expect(resolve([answer()])[0].status).toBe('accepted');
    const original = row(); const changed = { ...original, $attributes: { ...original.$attributes, request: encoded({ ...request, terms: { ...DEFAULT_TERMS, perTradeUsd: 50 } }) } };
    expect(resolve([answer()], [changed])[0].status).toBe('pending');
    expect(() => parsePassRequest({ ...request, status: 'active' })).toThrow();
    expect(() => parsePassTerms({ ...DEFAULT_TERMS, profitShareBps: 10000 })).toThrow();
    expect(() => parsePassTerms({ ...DEFAULT_TERMS, perTradeUsd: 5.5 })).toThrow();
  });
  it('cannot replace a decline, restart an ended pass or extend its expiry', () => {
    expect(resolve([answer('declined'), answer('accepted', traderOwner, 3n)])[0].status).toBe('declined');
    expect(resolve([answer(), answer('ended', traderOwner, 3n)])[0].status).toBe('ended');
    expect(resolve([answer()], [row()], owner, times.get(2n)! + 7 * 86400000)[0].status).toBe('expired');
    const original = row(); const cancelled = { ...original, $attributes: { ...original.$attributes, status: str('cancelled') } };
    expect(resolve([answer()], [cancelled])[0].status).toBe('cancelled');
  });
  it('does not allow self-copy or wrong native profile ownership', () => {
    expect(resolveWalletPasses([row()], [answer()], [{ ...profiles[0], owner: outsider }], times, owner, 0)).toEqual([]);
    const self = { ...row(), $owner: traderOwner as `0x${string}` };
    expect(resolve([answer()], [self], traderOwner)).toEqual([]);
  });
});
