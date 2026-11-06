import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SignedBotAction } from '../contracts/bots';
import { BotRequestError, buildAction, isUncertain, sendCommand, snippets } from './bots';

const integration = { audience: 'swipr-test', apiUrl: 'https://api.example.com', mcpUrl: 'https://api.example.com/mcp', tools: [], tradingEnabled: false as const };
const signed: SignedBotAction = { payload: buildAction('swipr-test', 'profile.halt', { profileId: 'p' }), signature: '0x12' };
const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

afterEach(() => vi.unstubAllGlobals());

describe('snippets', () => {
  it('appends /api/bots paths to the bare API origin', () => {
    const s = snippets(integration);
    expect(s.curl).toContain('curl -s https://api.example.com/api/bots\n');
    expect(s.curl).toContain('https://api.example.com/api/bots/integration');
    expect(s.curl).toContain('POST https://api.example.com/api/bots/wallet-transaction');
    expect(s.curl).not.toContain('Bearer');
    expect(s.example).toContain('eth_sendTransaction');
    expect(s.curl).not.toContain('/api/api');
    expect(s.example).toContain("fetch('https://api.example.com/api/bots/wallet-transaction'");
    expect(JSON.parse(s.mcp).mcpServers.swipr.url).toBe('https://api.example.com/mcp');
  });
});

describe('sendCommand', () => {
  it('sends the envelope with a Bearer token', async () => {
    const fetch = reply(200, { ok: true });
    vi.stubGlobal('fetch', fetch);
    await sendCommand(signed, 'tok');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/bots/commands');
    expect(init.headers).toMatchObject({ authorization: 'Bearer tok', 'content-type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual(signed);
  });

  it('parses nested error { code, message }', async () => {
    vi.stubGlobal('fetch', reply(403, { error: { code: 'forbidden', message: 'not the owner' }, requestId: 'r' }));
    const error = await sendCommand(signed, 'tok').catch(e => e);
    expect(error).toBeInstanceOf(BotRequestError);
    expect(error).toMatchObject({ status: 403, code: 'forbidden', message: 'not the owner' });
    expect(isUncertain(error)).toBe(false);
  });

  it('marks network failures, 503 and replay conflicts as uncertain', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('failed to fetch'); }));
    const network = await sendCommand(signed, 'tok').catch(e => e);
    expect(network).toMatchObject({ status: 0, code: 'write_uncertain' });
    expect(isUncertain(network)).toBe(true);

    vi.stubGlobal('fetch', reply(503, { error: { code: 'ambiguous', message: 'write may have landed' } }));
    expect(isUncertain(await sendCommand(signed, 'tok').catch(e => e))).toBe(true);
    vi.stubGlobal('fetch', reply(409, { error: { code: 'conflict', message: 'replay' } }));
    expect(isUncertain(await sendCommand(signed, 'tok').catch(e => e))).toBe(true);
    vi.stubGlobal('fetch', reply(409, { error: { code: 'halted', message: 'halted' } }));
    expect(isUncertain(await sendCommand(signed, 'tok').catch(e => e))).toBe(false);
  });

  it('falls back to a status message for non-JSON errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status: 500 })));
    await expect(sendCommand(signed, 'tok')).rejects.toMatchObject({ status: 500, code: 'request_failed', message: 'Request failed (500).' });
  });
});
