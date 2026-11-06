import { describe, expect, it } from 'vitest';
import { rankClosedPositions, type VerifiedClosedPosition } from './rankings';

const A = `0x${'a'.repeat(40)}`, B = `0x${'b'.repeat(40)}`, C = `0x${'c'.repeat(40)}`;
const usd = (n: number) => String(Math.round(n * 1_000_000));
let seq = 0;
const tx = () => `0x${(++seq).toString(16).padStart(64, '0')}`;
function pos(wallet: string, cost: number, proceeds: number, extra: Partial<VerifiedClosedPosition> = {}): VerifiedClosedPosition {
  return { id: `p${++seq}`, wallet, role: 'trader', name: `w-${wallet.slice(2, 4)}`, costUsdMicros: usd(cost), proceedsUsdMicros: usd(proceeds),
    feesUsdMicros: '0', profitShareUsdMicros: '0', closedAt: '2026-11-01T00:00:00.000Z', entryTx: tx(), exitTx: tx(), ...extra };
}

describe('rankClosedPositions', () => {
  it('aggregates net of fees and profit share, ranks by percentage or absolute with exact decimals', () => {
    const rows = [
      pos(A, 100, 130, { feesUsdMicros: usd(1), profitShareUsdMicros: usd(2.5) }), // +26.5
      pos(A, 300, 290),                                                           // -10  → +16.5 / 400 = 4.125%
      pos(B, 1000, 1100),                                                         // +100 / 1000 = 10%
      pos(C, 50, 40),                                                             // -10 / 50 = -20%
    ];
    expect(rankClosedPositions(rows, { role: 'trader', sort: 'percentage' })).toEqual([
      { address: B, name: 'w-bb', kind: 'trader', netProfitUsd: '100.00', returnPct: '10.00', closedPositions: 1 },
      { address: A, name: 'w-aa', kind: 'trader', netProfitUsd: '16.50', returnPct: '4.13', closedPositions: 2 },
      { address: C, name: 'w-cc', kind: 'trader', netProfitUsd: '-10.00', returnPct: '-20.00', closedPositions: 1 },
    ]);
    expect(rankClosedPositions(rows, { role: 'trader', sort: 'absolute' }).map(r => r.address)).toEqual([B, A, C]);
  });

  it('filters by role, following and since; dedupes ids; breaks ties by wallet', () => {
    const dup = pos(B, 10, 11);
    const rows = [
      pos(C, 10, 11), dup, { ...dup }, pos(A, 10, 11),
      pos(A, 10, 50, { role: 'copier' }),
      pos(A, 10, 50, { closedAt: '2026-10-01T00:00:00.000Z' }),
    ];
    const all = rankClosedPositions(rows, { role: 'trader', sort: 'percentage', since: '2026-10-15T00:00:00.000Z' });
    expect(all.map(r => [r.address, r.returnPct, r.closedPositions])).toEqual([[A, '10.00', 1], [B, '10.00', 1], [C, '10.00', 1]]);
    expect(rankClosedPositions(rows, { role: 'copier', sort: 'absolute' })).toEqual([
      { address: A, name: 'w-aa', kind: 'copier', netProfitUsd: '40.00', returnPct: '400.00', closedPositions: 1 }]);
    expect(rankClosedPositions(rows, { role: 'trader', sort: 'absolute', following: [C.toUpperCase().replace('0X', '0x')], since: '2026-10-15T00:00:00Z' })
      .map(r => r.address)).toEqual([C]);
    expect(rankClosedPositions(rows, { role: 'trader', sort: 'absolute', following: [] })).toEqual([]);
  });

  it('excludes invalid and non-positive-cost records instead of guessing', () => {
    const bad: VerifiedClosedPosition[] = [
      pos(A, 0, 10), pos(A, 10, 11, { costUsdMicros: '-5' }), pos(A, 10, 11, { proceedsUsdMicros: '1.5' }),
      pos(A, 10, 11, { feesUsdMicros: '01' }), pos('0x123', 10, 11), pos(`0x${'0'.repeat(40)}`, 10, 11),
      pos(A, 10, 11, { entryTx: '0x12' }), pos(A, 10, 11, { exitTx: 'nope' }), pos(A, 10, 11, { closedAt: 'yesterday' }),
      pos(A, 10, 11, { role: 'ghost' as 'trader' }), pos(A, 10, 11, { id: '' }), null as unknown as VerifiedClosedPosition,
    ];
    expect(rankClosedPositions(bad, { role: 'trader', sort: 'percentage' })).toEqual([]);
    const valid = pos(B, 3, 4);
    expect(rankClosedPositions([...bad, valid], { role: 'trader', sort: 'percentage' })[0].returnPct).toBe('33.33');
  });

  it('rounds half away from zero, keeps tiny values signed correctly, and handles large totals', () => {
    const rows = [pos(A, 3, 1, { costUsdMicros: '3000000', proceedsUsdMicros: '2999995' }), pos(B, 1e12, 2e12)];
    const [b, a] = rankClosedPositions(rows, { role: 'trader', sort: 'absolute' });
    expect(a).toMatchObject({ address: A, netProfitUsd: '0.00', returnPct: '0.00' }); // never "-0.00"
    expect(b).toMatchObject({ netProfitUsd: '1000000000000.00', returnPct: '100.00' });
    expect(rankClosedPositions([pos(C, 1, 1, { costUsdMicros: '200', proceedsUsdMicros: '199' })], { role: 'trader', sort: 'absolute' })[0])
      .toMatchObject({ netProfitUsd: '0.00', returnPct: '-0.50' });
  });

  it('rejects invalid options', () => {
    expect(() => rankClosedPositions([], { role: 'bot' as 'trader', sort: 'absolute' })).toThrow(TypeError);
    expect(() => rankClosedPositions([], { role: 'trader', sort: 'median' as 'absolute' })).toThrow(TypeError);
    expect(() => rankClosedPositions([], { role: 'trader', sort: 'absolute', since: 'later' })).toThrow(TypeError);
  });
});
