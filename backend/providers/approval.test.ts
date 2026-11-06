import { describe, it, expect, vi } from 'vitest';
import { encodeFunctionData, erc20Abi } from 'viem';
import { createFlashClient, FLASH_DOMAIN, TOKENS, validateApproval, type OrderIntent } from './flash';
const intent: OrderIntent = { side: 'buy', asset: 'WETH', qty: '5', funder: `0x${'12'.repeat(20)}`, orderType: 'limit', sharedPrice: '1000', limitNotionalPrice: '1000' };
const transaction = (amount = 5000000n, spender: `0x${string}` = FLASH_DOMAIN.verifyingContract) => ({ to: TOKENS.USDC.address,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }) });
describe('Flash authorization bounds', () => {
  it('accepts only the reviewed token, exact function and bounded settlement allowance', () => {
    expect(validateApproval(transaction(), intent, 5000000n)).toMatchObject({ chainId: 8453, amount: '5000000' });
    for (const tx of [transaction(2n ** 256n - 1n), transaction(5000000n, intent.funder as `0x${string}`),
      { ...transaction(), to: TOKENS.WETH.address }, { ...transaction(), value: '0x1' },
      { ...transaction(), data: transaction().data + '00' }]) expect(() => validateApproval(tx, intent, 5000000n)).toThrow();
  });
  it('requests a short expiry and direct minimal approvals from the provider', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'test ends before signing' }), { status: 400 }));
    const client = createFlashClient({ apiKey: 'private-test-key', fetch: fetcher });
    const before = Date.now();
    await expect(client.quote(intent)).rejects.toThrow();
    const body = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ evmUsePermit2: false, forceMinimalAllowance: true });
    expect(Date.parse(body.expireTime)).toBeGreaterThan(before);
    expect(Date.parse(body.expireTime)).toBeLessThanOrEqual(Date.now() + 900000);
    await expect(client.quote({ ...intent, expireTime: new Date(Date.now() + 3600000).toISOString() })).rejects.toThrow('15 minutes');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects excessive price impact and slippage before requesting a quote', async () => {
    const fetcher = vi.fn(); const client = createFlashClient({ apiKey: 'private-test-key', fetch: fetcher });
    await expect(client.quote({ ...intent, maxPriceImpact: '0.06' })).rejects.toThrow('5%');
    await expect(client.quote({ ...intent, maxSlippage: '1' })).rejects.toThrow('5%');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
