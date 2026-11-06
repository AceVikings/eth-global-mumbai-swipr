import { describe, expect, it, vi } from 'vitest';
import {
  cancelMessage, checkRef, createBaseRpc, createBee, createFlashClient, createHttp, decodeTransferLegs, FLASH_DOMAIN,
  FLASH_ORDER_FIELDS, FLASH_ORDER_TYPES, FLASH_DOMAIN_TYPES, flashFromEnv, providerReadiness, redact, TOKENS, TRANSFER_TOPIC, validateTypedData,
  type OrderIntent, type Receipt,
} from './providers/index.ts';

const FUNDER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const SIG = '0x' + 'ab'.repeat(65);
const KEY = 'secret_flash_key_123';
const NOW = 1_800_000_000;
const policy = { now: NOW, maxDeadline: NOW + 3600, expectedVault: OTHER };
const buy: OrderIntent = { side: 'buy', asset: 'WETH', qty: '10', funder: FUNDER, orderType: 'limit', limitNotionalPrice: '3412.5', sharedPrice: '3412.5' };
const noSleep = async () => {};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const typedData = (msg: Record<string, unknown> = {}, domain: Record<string, unknown> = {}) => ({
  domain: { ...FLASH_DOMAIN, chainId: '8453', ...domain },
  primaryType: 'FlashOrder',
  types: { FlashOrder: [...FLASH_ORDER_TYPES], EIP712Domain: [...FLASH_DOMAIN_TYPES] },
  message: { swapper: FUNDER, vault: OTHER, recipient: FUNDER, fromToken: TOKENS.USDC.address, toToken: TOKENS.WETH.address,
    fromAmount: '10000000', salt: '1', deadline: String(NOW + 900), ...msg },
});

describe('flash typed data checks', () => {
  it('accepts the expected order', () => expect(() => validateTypedData(typedData(), buy, policy)).not.toThrow());
  it.each([
    ['wrong contract', typedData({}, { verifyingContract: OTHER })],
    ['wrong chain', typedData({}, { chainId: 1 })],
    ['wrong name', typedData({}, { name: 'Other' })],
    ['other recipient', typedData({ recipient: OTHER })],
    ['wrong vault', typedData({ vault: FUNDER })],
    ['numeric amount', typedData({ fromAmount: 10000000 })],
    ['hex amount', typedData({ fromAmount: '0x989680' })],
    ['oversized amount', typedData({ fromAmount: '50000000' })],
    ['swapped tokens', typedData({ fromToken: TOKENS.WETH.address, toToken: TOKENS.USDC.address })],
    ['expired', typedData({ deadline: String(NOW - 1) })],
    ['deadline past pass', typedData({ deadline: String(NOW + 7200) })],
  ])('rejects %s', (_, td) => expect(() => validateTypedData(td as any, buy, policy)).toThrow(/flash/));
  it('rejects altered type fields', () => {
    const td = typedData();
    td.types.FlashOrder.push({ name: 'extra', type: 'address' });
    expect(() => validateTypedData(td as any, buy, policy)).toThrow(/fields/);
  });
});

describe('flash client', () => {
  const quoteBody = { quoteId: 'q1', evm: { orderTypedData: JSON.stringify(typedData()) } };

  it('quotes with key header and validates intent before any network call', async () => {
    const fetch = vi.fn(async () => json(quoteBody));
    const c = createFlashClient({ apiKey: KEY, fetch, sleep: noSleep });
    const q = await c.quote(buy);
    expect(q.typedData.primaryType).toBe('FlashOrder');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/quote$/);
    expect((init.headers as Record<string, string>)['x-definitive-api-key']).toBe(KEY);
    expect(JSON.parse(init.body as string)).toMatchObject({ targetChain: 'base', side: 'buy', limitNotionalPrice: '3412.5' });
    for (const bad of [{ ...buy, limitNotionalPrice: '3500' }, { ...buy, orderType: 'market' as const }, { ...buy, qty: '51' }, { ...buy, qty: '4.99' }, { ...buy, asset: 'DOGE' as any }])
      await expect(c.quote(bad)).rejects.toThrow(/invalid|shared|\$5|asset/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries quotes on 429 but never resends an order submission', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ error: 'slow' }, 429, { 'retry-after': '1' }))
      .mockResolvedValueOnce(json(quoteBody))
      .mockResolvedValueOnce(json({ error: 'boom' }, 502));
    const c = createFlashClient({ apiKey: KEY, fetch, sleep: noSleep });
    const q = await c.quote(buy);
    const err = await c.submitOrder({ intent: buy, quote: q, userSignature: SIG, policy }).catch((e) => e);
    expect(err.ambiguous).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('refuses to relay a signature over mismatched typed data', async () => {
    const fetch = vi.fn(async () => json({ quoteId: 'q', evm: { orderTypedData: typedData({ recipient: OTHER }) } }));
    const c = createFlashClient({ apiKey: KEY, fetch, sleep: noSleep });
    const q = await c.quote(buy);
    await expect(c.submitOrder({ intent: buy, quote: q, userSignature: SIG, policy })).rejects.toThrow(/recipient/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('submits, reads status and sends the signed cancel message', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ orderId: 'ord-1' }))
      .mockResolvedValueOnce(json({ order: { status: 'ACCEPTED', fills: [] } }))
      .mockResolvedValueOnce(json({ ok: true }));
    const c = createFlashClient({ apiKey: KEY, fetch, sleep: noSleep });
    const quote = { quoteId: 'q1', typedDataRaw: JSON.stringify(typedData()), typedData: typedData() as any, raw: {} };
    expect(await c.submitOrder({ intent: buy, quote, userSignature: SIG, policy })).toEqual({ orderId: 'ord-1' });
    expect((await c.getOrder('ord-1', FUNDER)).status).toBe('ACCEPTED');
    await c.cancelOrder('ord-1', SIG);
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ cancelMessage: cancelMessage('ord-1'), userSignature: SIG });
    await expect(c.getOrder('../x', FUNDER)).rejects.toThrow(/order id/);
    await expect(c.cancelOrder('ord-1', '0x12')).rejects.toThrow(/signature/);
  });

  it('times out and redacts the key from errors', async () => {
    const hang = vi.fn((_: string, init?: RequestInit) => new Promise<Response>((_r, reject) =>
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))));
    const c = createFlashClient({ apiKey: KEY, fetch: hang, timeoutMs: 10, sleep: noSleep });
    await expect(c.cancelOrder('ord-1', SIG)).rejects.toMatchObject({ code: 'timeout', ambiguous: true });
    expect(hang).toHaveBeenCalledTimes(1);
    const leak = createFlashClient({ apiKey: KEY, fetch: async () => json({ msg: `bad key ${KEY} sig ${SIG}` }, 401), sleep: noSleep });
    const e = await leak.getOrder('o', FUNDER).catch((x) => x);
    expect(e.message).not.toContain(KEY);
    expect(e.message).not.toContain(SIG.slice(2));
  });

  it('builds only from a real key', () => {
    expect(flashFromEnv({}, fetch).ok).toBe(false);
    expect(flashFromEnv({ FLASH_API_KEY: 'dpka_513a2bd7_x' }, fetch).ok).toBe(false);
    expect(flashFromEnv({ FLASH_API_KEY: KEY }, fetch).ok).toBe(true);
  });
});

describe('http pacing', () => {
  it('spaces calls by minIntervalMs', async () => {
    const waits: number[] = [];
    const http = createHttp({ provider: 't', fetch: async () => json({}), minIntervalMs: 200, sleep: async (ms) => { waits.push(ms); } });
    await Promise.all([http.json('u', {}, { retry: true }), http.json('u', {}, { retry: true })]);
    expect(waits.length).toBe(1);
    expect(waits[0]).toBeGreaterThan(150);
  });
  it('redacts bearer tokens and long hex', () => expect(redact('Bearer abc.def 0x' + 'f'.repeat(64))).toBe('Bearer [redacted] [redacted-hex]'));
});

const pad = (a: string) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const transfer = (token: string, from: string, to: string, value: bigint) =>
  ({ address: token, topics: [TRANSFER_TOPIC, pad(from), pad(to)], data: '0x' + value.toString(16) });
const receipt = (logs: Receipt['logs'], status = '0x1'): Receipt => ({ transactionHash: '0x' + '1'.repeat(64), status, blockNumber: '0x1', from: FUNDER, logs });

describe('notary transfer decoder', () => {
  it('decodes a USDC → WETH buy at the leg ratio', () => {
    const r = decodeTransferLegs(receipt([
      transfer(TOKENS.USDC.address, FUNDER, OTHER, 10_000_000n),
      transfer(TOKENS.WETH.address, OTHER, FUNDER, 2_930_402_930_402_930n),
    ]), FUNDER.toUpperCase().replace('0X', '0x'));
    expect(r).toMatchObject({ ok: true, side: 'buy', asset: 'WETH', usdcMicros: 10_000_000n, price: '3412.500000' });
  });
  it('decodes a cbBTC sell', () => {
    const r = decodeTransferLegs(receipt([
      transfer(TOKENS.cbBTC.address, FUNDER, OTHER, 10_000n),
      transfer(TOKENS.USDC.address, OTHER, FUNDER, 9_000_000n),
    ]), FUNDER);
    expect(r).toMatchObject({ ok: true, side: 'sell', asset: 'cbBTC', price: '90000.000000' });
  });
  it.each([
    ['reverted', receipt([], '0x0'), /reverted/],
    ['two USDC legs', receipt([transfer(TOKENS.USDC.address, FUNDER, OTHER, 1n), transfer(TOKENS.USDC.address, FUNDER, OTHER, 1n), transfer(TOKENS.WETH.address, OTHER, FUNDER, 1n)]), /one USDC/],
    ['unsupported asset', receipt([transfer(TOKENS.USDC.address, FUNDER, OTHER, 1n), transfer(OTHER, OTHER, FUNDER, 1n)]), /WETH or cbBTC/],
    ['same direction', receipt([transfer(TOKENS.USDC.address, OTHER, FUNDER, 1n), transfer(TOKENS.WETH.address, OTHER, FUNDER, 1n)]), /direction/],
    ['legs of another wallet', receipt([transfer(TOKENS.USDC.address, OTHER, OTHER, 1n)]), /one USDC/],
  ])('rejects %s', (_, r, reason) => expect(decodeTransferLegs(r, FUNDER)).toMatchObject({ ok: false, reason: expect.stringMatching(reason) }));

  it('reads receipts via JSON-RPC and surfaces rpc errors', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ jsonrpc: '2.0', id: 1, result: receipt([]) }))
      .mockResolvedValueOnce(json({ jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'x' } }));
    const rpc = createBaseRpc({ url: 'https://rpc.example/key123456', fetch });
    expect((await rpc.getReceipt('0x' + '1'.repeat(64)))?.status).toBe('0x1');
    expect(JSON.parse(fetch.mock.calls[0][1].body).method).toBe('eth_getTransactionReceipt');
    await expect(rpc.getReceipt('0x' + '1'.repeat(64))).rejects.toThrow(/rpc error/);
    await expect(rpc.getReceipt('0x12')).rejects.toThrow(/tx hash/);
  });
});

describe('bee archive', () => {
  const BATCH = 'b'.repeat(64);
  const REF = 'c'.repeat(64);
  it('uploads pinned with the batch and never claims BMT verification', async () => {
    const fetch = vi.fn(async () => json({ reference: REF }, 201));
    const bee = createBee({ url: 'http://bee:1633/', batchId: BATCH, fetch });
    expect(await bee.upload(new Uint8Array([1, 2]), 'application/json')).toEqual({ ref: REF, size: 2, pinned: true, bmt: 'unverified' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://bee:1633/bytes');
    expect(init.headers).toMatchObject({ 'swarm-postage-batch-id': BATCH, 'swarm-pin': 'true' });
  });
  it('downloads by 64-hex ref only', async () => {
    const bee = createBee({ url: 'http://bee', batchId: BATCH, fetch: async () => new Response(new Uint8Array([7])) });
    expect(await bee.download(REF)).toMatchObject({ bytes: new Uint8Array([7]), bmt: 'unverified' });
    expect(() => checkRef('a'.repeat(128))).toThrow(/encrypted/);
    await expect(bee.download('../etc')).rejects.toThrow(/64 hex/);
    expect(() => createBee({ url: 'http://bee', batchId: 'x', fetch })).toThrow(/batch/);
  });
});

describe('readiness', () => {
  it('never reports a live integration', () => {
    const r = providerReadiness({ FLASH_API_KEY: KEY, BEE_URL: 'http://bee' });
    expect(r.flash.state).toBe('configured_unverified');
    expect(r.bee).toEqual({ state: 'missing_config', detail: 'missing SWARM_BATCH_ID' });
    expect([r.arkiv.state, r.ens.state, r.privy.state]).toEqual(['unsupported', 'unsupported', 'unsupported']);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
});
