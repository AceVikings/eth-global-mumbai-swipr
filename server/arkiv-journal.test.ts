import { describe, expect, it } from 'vitest';
import { ArkivJournal, type ArkivPort, type JournalEvent, type StoredEvent } from './arkiv-journal';
import type { Hex } from 'viem';
const writer = `0x${'1'.repeat(40)}`;
// Protocol-contract double only. Runtime always uses Rabdi; no local DB fallback.
function fixture() {
  const epoch = BigInt(Math.floor(Date.now() / 1000)) - 100n;
  const state = { count: 0, tip: 100n, rows: [] as StoredEvent[], pending: false, lostAck: false, sends: [] as number[] };
  const port: ArkivPort = {
    canWrite: true,
    async chainId() { return 7794095; },
    async block(number = state.tip) { return { number, hash: `block-${number}`, timestamp: epoch + number }; },
    async nonce(which) { return state.count + (which === 'pending' && state.pending ? 1 : 0); },
    async page(offset) { return { rows: state.rows.slice(offset, offset + 100), blockNumber: state.tip }; },
    async send(event, nonce) {
      state.sends.push(nonce);
      if (nonce !== state.count) throw new Error('nonce too low');
      state.count++;
      state.rows.push({ event: structuredClone(event), creator: writer, owner: writer, readonly: true, expiresAt: 1000000n, createdAt: state.tip });
      state.tip += 3n;
      if (state.lostAck) throw new Error('broadcast acknowledgement lost');
      return `0x${'a'.repeat(64)}` as Hex;
    },
    async confirm() {},
  };
  const journal = new ArkivJournal(port, writer);
  const event = async (id = 'event-1'): Promise<JournalEvent> => ({ id, revision: state.count + 1, at: (await journal.read()).timestampMs, command: { type: 'test' } });
  return { state, port, journal, event };
}
describe('Arkiv nonce-fenced journal', () => {
  it('reads confirmed state and appends with the explicit account nonce', async () => {
    const f = fixture();
    expect((await f.journal.read()).events).toEqual([]);
    const event = await f.event(); await f.journal.append(event, 0);
    expect((await f.journal.read()).events).toEqual([event]);
    expect(f.state.sends).toEqual([0]);
  });
  it('fences concurrent processes without claiming an in-memory mutex is distributed', async () => {
    const f = fixture(), other = new ArkivJournal(f.port, writer);
    const event = await f.event();
    const results = await Promise.allSettled([f.journal.append(event, 0), other.append({ ...event, id: 'other' }, 0)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(f.state.rows).toHaveLength(1);
  });
  it('preserves an uncertain committed operation across process restart', async () => {
    const f = fixture(); const event = await f.event(); f.state.lostAck = true;
    await expect(f.journal.append(event, 0)).rejects.toMatchObject({ code: 'ambiguous' });
    const recovered = await new ArkivJournal(f.port, writer).read();
    expect(recovered.events[0].id).toBe(event.id);
    expect(f.state.sends).toHaveLength(1); // no automatic resend
  });
  it('blocks stale writes and waits for unconfirmed writer transactions', async () => {
    const f = fixture(), event = await f.event();
    f.state.pending = true;
    await expect(f.journal.read()).rejects.toMatchObject({ code: 'pending' });
    f.state.pending = false;
    await f.journal.append(event, 0);
    await expect(f.journal.append({ ...event, id: 'stale' }, 0)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('fails closed on missing, expired or altered-authority records', async () => {
    const f = fixture(); await f.journal.append(await f.event(), 0);
    f.state.count = 2;
    await expect(f.journal.read()).rejects.toMatchObject({ code: 'incomplete' });
    f.state.count = 1; f.state.rows[0].expiresAt = 1n;
    await expect(f.journal.read()).rejects.toMatchObject({ code: 'incomplete' });
    f.state.rows[0].expiresAt = 100000n; f.state.rows[0].readonly = false;
    await expect(f.journal.read()).rejects.toMatchObject({ code: 'incomplete' });
    f.state.rows[0].readonly = true; f.state.rows[0].owner = `0x${'2'.repeat(40)}`;
    await expect(f.journal.read()).rejects.toMatchObject({ code: 'incomplete' });
  });
  it('does not accept a wrong chain or lagging query index', async () => {
    const f = fixture(); f.port.chainId = async () => 8453;
    await expect(f.journal.read()).rejects.toMatchObject({ code: 'unavailable' });
    f.port.chainId = async () => 7794095;
    f.port.page = async () => ({ rows: [], blockNumber: 1n });
    await expect(f.journal.read()).rejects.toMatchObject({ code: 'pending' });
  });
  it('rejects writes on the API reader and rejects secrets before any broadcast', async () => {
    const f = fixture(); const event = await f.event();
    const reader = new ArkivJournal({ ...f.port, canWrite: false }, writer);
    await expect(reader.append(event, 0)).rejects.toMatchObject({ code: 'read_only' });
    await expect(f.journal.append({ ...event, command: { userSignature: 'secret' } }, 0)).rejects.toMatchObject({ code: 'invalid' });
    expect(f.state.sends).toEqual([]);
  });
  it('rejects a nonce change during pagination rather than replaying a torn budget', async () => {
    const f = fixture();
    f.port.page = async () => { f.state.count++; return { rows: [], blockNumber: f.state.tip }; };
    await expect(f.journal.read()).rejects.toMatchObject({ code: 'conflict' });
  });
});

it('blocks near-expiry history before it disappears', async () => {
  const f = fixture(); await f.journal.append(await f.event(), 0);
  f.state.rows[0].expiresAt = f.state.tip + 43200n;
  await expect(f.journal.read()).rejects.toMatchObject({ code: 'expiring' });
});
it('rejects secret-shaped values in ordinary public fields before broadcasting', async () => {
  const f = fixture(), event = await f.event();
  for (const value of [`0x${'a'.repeat(130)}`, '-----BEGIN PRIVATE KEY-----', 'eyJhbGci.eyJzdWI.signature', `0x02f8${'a'.repeat(220)}`]) {
    await expect(f.journal.append({ ...event, command: { label: value } }, 0)).rejects.toMatchObject({ code: 'invalid' });
  }
  await expect(f.journal.append({ ...event, command: { accessKey: 'value' } }, 0)).rejects.toMatchObject({ code: 'invalid' });
  expect(f.state.sends).toEqual([]);
});
it('rejects a reorg of the confirmed anchor', async () => {
  const f = fixture(); let anchors = 0; const block = f.port.block;
  f.port.block = async number => ({ ...await block(number), ...(number === 99n && ++anchors > 1 ? { hash: 'reorg' } : {}) });
  await expect(f.journal.read()).rejects.toMatchObject({ code: 'conflict' });
});
it('reads multiple pages and rejects regressing query heights', async () => {
  const f = fixture(), event = await f.event(); f.state.count = 101;
  f.state.rows = Array.from({ length: 101 }, (_, i) => ({ event: { ...event, revision: i + 1, id: `event-${i}` }, creator: writer, owner: writer, readonly: true, expiresAt: 1000000n, createdAt: 1n }));
  expect((await f.journal.read()).events).toHaveLength(101);
  const page = f.port.page;
  f.port.page = async offset => ({ ...await page(offset), blockNumber: offset ? 99n : 100n });
  await expect(f.journal.read()).rejects.toMatchObject({ code: 'pending' });
});
it('rejects future query heights and treats unconfirmed rows as a read conflict', async () => {
  const f = fixture(); const page = f.port.page;
  f.port.page = async offset => ({ ...await page(offset), blockNumber: 101n });
  await expect(f.journal.read()).rejects.toMatchObject({ code: 'unavailable' });
  f.port.page = page; await f.journal.append(await f.event(), 0);
  f.state.rows[0].createdAt = f.state.tip + 1n;
  await expect(f.journal.read()).rejects.toMatchObject({ code: 'conflict' });
});
it('blocks a stalled confirmed chain clock', async () => {
  const f = fixture();
  const journal = new ArkivJournal(f.port, writer, 2, () => Date.now() + 60000);
  await expect(journal.read()).rejects.toMatchObject({ code: 'stale_clock' });
});
