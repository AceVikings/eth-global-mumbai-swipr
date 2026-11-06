import { createPublicClient, createWalletClient, ExpirationTime } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { defineSchema, str, u64, bytes, addr } from '@arkiv-network/sdk/schema';
import { and, eq, asc } from '@arkiv-network/sdk/query';
import { http, hexToBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const PROJECT = 'swipr-mumbai26';
export const EngineEventSchema = defineSchema('swipr.engine-event.v1', {
  project: str().indexed(), stream: str().indexed(), revision: u64().indexed(),
  eventId: str().indexed(), body: bytes(),
});
export type JournalEvent = { revision: number; id: string; at: number; command: unknown };
export type JournalSnapshot = { events: JournalEvent[]; nonce: number; blockNumber: bigint; timestampMs: number };
export interface Journal {
  readonly canWrite: boolean;
  read(): Promise<JournalSnapshot>;
  append(event: JournalEvent, expectedNonce: number): Promise<void>;
  close(): Promise<void>;
}
// All stores sharing this writer must serialize read/plan/append together.
// This gate holds no product state; the chain nonce still fences other processes.
const writeGates = new WeakMap<Journal, Promise<unknown>>();
export function withJournalWrite<T>(journal: Journal, operation: () => Promise<T>): Promise<T> {
  const run = (writeGates.get(journal) ?? Promise.resolve()).then(operation);
  const settled = run.catch(() => undefined);
  writeGates.set(journal, settled);
  void settled.then(() => { if (writeGates.get(journal) === settled) writeGates.delete(journal); });
  return run;
}

export class JournalError extends Error {
  constructor(public code: 'unavailable' | 'pending' | 'conflict' | 'incomplete' | 'read_only' | 'ambiguous' | 'invalid' | 'expiring' | 'stale_clock', message: string) { super(message); }
}
export type Block = { number: bigint; hash: string; timestamp: bigint };
export type StoredEvent = { event: JournalEvent; creator: string; owner: string; readonly: boolean; expiresAt: bigint; createdAt: bigint };
export interface ArkivPort {
  readonly canWrite: boolean;
  chainId(): Promise<number>;
  block(number?: bigint): Promise<Block>;
  nonce(block: bigint | 'pending'): Promise<number>;
  page(offset: number): Promise<{ rows: StoredEvent[]; blockNumber: bigint }>;
  send(event: JournalEvent, nonce: number): Promise<Hex>;
  confirm(hash: Hex, confirmations: number): Promise<void>;
}
function encodeEvent(event: JournalEvent) {
  const text = JSON.stringify(event, (key, value) => {
    if (/signature|secret|private|password|mnemonic|seed|authorization|bearer|api_?key|access_?key|signedTransaction/i.test(key) || (typeof value === 'string' && (/^0x[0-9a-f]{130}$/i.test(value) || /^-----BEGIN [A-Z ]+KEY-----/.test(value) || /^eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+$/.test(value) || (/^0x(?:0[1-4])?f8[0-9a-f]+$/i.test(value) && value.length > 200)))) throw new JournalError('invalid', 'Secrets and signed payloads cannot be stored on Arkiv.');
    return value;
  });
  if (Buffer.byteLength(text) > 32768) throw new JournalError('invalid', 'Engine event exceeds 32 KiB.');
  return new TextEncoder().encode(text);
}

/** No SQL or local persistence. A dedicated account's transaction nonce fences
 * every append. One confirmed transaction = one event; never use this account
 * for unrelated transactions or another stream. Missing/expired history blocks writes. */
export class ArkivJournal implements Journal {
  readonly canWrite: boolean;
  constructor(private port: ArkivPort, private writer: string, private confirmations = 2, private now: () => number = Date.now) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(writer) || !Number.isSafeInteger(confirmations) || confirmations < 1 || confirmations > 20) throw new JournalError('invalid', 'Invalid writer or confirmations.');
    this.canWrite = port.canWrite;
  }
  async read(): Promise<JournalSnapshot> {
    if (await this.port.chainId() !== 7794095) throw new JournalError('unavailable', 'Arkiv endpoint is not Rabdi.');
    const tip = await this.port.block();
    const height = tip.number - BigInt(this.confirmations - 1);
    if (height < 0n) throw new JournalError('pending', 'Waiting for confirmations.');
    const anchor = await this.port.block(height);
    if (Math.abs(this.now() - Number(anchor.timestamp) * 1000) > 30000) throw new JournalError('stale_clock', 'Confirmed chain clock is stale; new commands are blocked.');
    const nonce = await this.port.nonce(height);
    if (!Number.isSafeInteger(nonce) || nonce < 0) throw new JournalError('invalid', 'Invalid account nonce.');
    if (await this.port.nonce('pending') !== nonce) throw new JournalError('pending', 'Writer has an unconfirmed transaction; reconcile before writing.');
    const events: JournalEvent[] = [];
    let lastQueryBlock = height;
    for (let offset = 0; ; offset += 100) {
      const page = await this.port.page(offset);
      if (page.blockNumber < lastQueryBlock) throw new JournalError('pending', 'Arkiv query index is behind the anchor.');
      lastQueryBlock = page.blockNumber;
      for (const row of page.rows) {
        if (row.createdAt > anchor.number) throw new JournalError('conflict', 'Writer advanced while reading; wait for confirmation.');
        if (row.expiresAt > tip.number && row.expiresAt <= tip.number + 43200n) throw new JournalError('expiring', 'Journal renewal is required before new entries.');
        if (row.creator.toLowerCase() !== this.writer.toLowerCase() || row.owner.toLowerCase() !== this.writer.toLowerCase() || !row.readonly || row.expiresAt <= tip.number) throw new JournalError('incomplete', 'Untrusted or unconfirmed engine history.');
        const event = row.event;
        if (event.revision !== events.length + 1 || typeof event.id !== 'string' || !event.id || !Number.isSafeInteger(event.at) || event.at < 0 || event.at > Number(anchor.timestamp) * 1000) throw new JournalError('incomplete', 'Engine event sequence is invalid.');
        encodeEvent(event); events.push(event);
      }
      if (page.rows.length < 100) break;
      if (events.length > nonce) throw new JournalError('conflict', 'Journal advanced while reading.');
    }
    const after = await this.port.block();
    const canonical = await this.port.block(height);
    if (canonical.hash !== anchor.hash || await this.port.nonce(after.number) !== nonce || await this.port.nonce('pending') !== nonce) throw new JournalError('conflict', 'Writer changed during read; re-read confirmed state.');
    if (lastQueryBlock > after.number) throw new JournalError('unavailable', 'Query and chain endpoints disagree.');
    if (events.length !== nonce) throw new JournalError('incomplete', 'Engine history is missing. Restore verified history; never reset budgets.');
    return { events, nonce, blockNumber: height, timestampMs: Number(anchor.timestamp) * 1000 };
  }
  async append(event: JournalEvent, expectedNonce: number) {
    if (!this.canWrite) throw new JournalError('read_only', 'Only the engine worker can write.');
    encodeEvent(event);
    const before = await this.read();
    if (before.nonce !== expectedNonce || event.revision !== expectedNonce + 1) throw new JournalError('conflict', 'Stale writer revision.');
    if (!Number.isSafeInteger(event.at) || event.at > before.timestampMs || this.now() - event.at > 30000) throw new JournalError('invalid', 'Event timestamp must come from confirmed chain state.');
    try {
      const hash = await this.port.send(event, expectedNonce);
      await this.port.confirm(hash, this.confirmations);
      const after = await this.read();
      if (JSON.stringify(after.events[expectedNonce]) !== JSON.stringify(event)) throw new Error('The receipt belongs to a competing event.');
    } catch {
      // A broadcast may have succeeded. Never retry automatically or release a reservation.
      throw new JournalError('ambiguous', 'Arkiv write outcome uncertain; reconcile the event id before retrying.');
    }
  }
  async close() { /* HTTP clients have no durable local state to close. */ }
}

export type ArkivOptions = { rpcUrl?: string; accessKey?: string; writerAddress: string; privateKey?: string; stream?: string; confirmations?: number };
export function createArkivJournal(options: ArkivOptions): ArkivJournal {
  const chain = rabdi({ accessKey: options.accessKey || '' });
  const transport = http(options.rpcUrl, { retryCount: 0, timeout: 10000 });
  const publicClient = createPublicClient({ chain, transport });
  const account = options.privateKey ? privateKeyToAccount(options.privateKey as Hex) : undefined;
  const writer = options.writerAddress.toLowerCase() as Address;
  if (account && account.address.toLowerCase() !== writer) throw new JournalError('invalid', 'Writer key does not match the configured address.');
  const wallet = account ? createWalletClient({ chain, transport, account }) : null;
  const stream = options.stream || 'swipr-engine-v1';
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(stream)) throw new JournalError('invalid', 'Invalid engine stream.');
  const port: ArkivPort = {
    canWrite: !!wallet,
    chainId: () => publicClient.getChainId(),
    async block(number) {
      const b = await publicClient.getBlock(number === undefined ? { blockTag: 'latest' } : { blockNumber: number });
      if (b.number === null || b.hash === null) throw new JournalError('unavailable', 'Unmined block returned.');
      return { number: b.number, hash: b.hash, timestamp: b.timestamp };
    },
    nonce: block => publicClient.getTransactionCount({ address: writer, ...(block === 'pending' ? { blockTag: 'pending' } : { blockNumber: block }) }),
    async page(offset) {
      const page = await publicClient.query(and(eq('arkiv.schema', str('swipr.engine-event.v1')), eq('project', str(PROJECT)), eq('stream', str(stream)), eq('$creator', addr(writer))), { limit: 100, offset, orderBy: asc('revision', 'u64') });
      return { blockNumber: page.blockNumber, rows: page.entities.map(row => {
        const attrs = row.$attributes;
        if (attrs.body?.type !== 'bytes' || attrs.revision?.type !== 'u64' || attrs.eventId?.type !== 'str') throw new JournalError('incomplete', 'Invalid event attributes.');
        const event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(hexToBytes(attrs.body.value))) as JournalEvent;
        if (BigInt(event.revision) !== attrs.revision.value || event.id !== attrs.eventId.value) throw new JournalError('incomplete', 'Event index disagrees with body.');
        return { event, creator: row.$creator, owner: row.$owner, readonly: row.$creationFlags.readonly, expiresAt: row.$expiresAt, createdAt: row.$createdAt };
      }) };
    },
    async send(event, nonce) {
      if (!wallet) throw new JournalError('read_only', 'Writer not configured.');
      const result = await wallet.executeBatch({ creates: [{ schema: EngineEventSchema,
        values: { project: PROJECT, stream, revision: u64(BigInt(event.revision)), eventId: event.id, body: encodeEvent(event) },
        expiration: ExpirationTime.fromDays(180), flags: { readonly: true, permissionlessExtension: true },
      }] }, { nonce });
      return result.txHash;
    },
    async confirm(hash, confirmations) {
      const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations, timeout: 60000 });
      if (receipt.status !== 'success' || receipt.from.toLowerCase() !== writer) throw new JournalError('ambiguous', 'Arkiv receipt was not the expected successful writer transaction.');
    },
  };
  return new ArkivJournal(port, writer, options.confirmations ?? 2);
}
