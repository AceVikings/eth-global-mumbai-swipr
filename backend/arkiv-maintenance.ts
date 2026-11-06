import { createPublicClient, createWalletClient, ExpirationTime } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { and, eq, asc } from '@arkiv-network/sdk/query';
import { addr, str } from '@arkiv-network/sdk/schema';
import { http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PROJECT, type ArkivOptions } from './arkiv-journal';
const RENEW_WINDOW = 30n * 86400n / 2n; // SDK 1.0.1 Rabdi block time: 2 seconds.
export type ExpiringEntity = { key: Hex; creator: string; owner: string; expiresAt: bigint; readonly: boolean; extendable: boolean };
export interface MaintenancePort {
  writer: string; maintainer: string;
  head(): Promise<bigint>;
  page(offset: number): Promise<ExpiringEntity[]>;
  extend(keys: Hex[]): Promise<void>;
}
export async function renewJournal(port: MaintenancePort) {
  if (port.writer.toLowerCase() === port.maintainer.toLowerCase()) throw new Error('Maintainer must use a separate account.');
  const head = await port.head();
  let renewed = 0;
  for (let offset = 0; ; offset += 100) {
    const rows = await port.page(offset);
    const keys: Hex[] = [];
    for (const row of rows) {
      if (row.creator.toLowerCase() !== port.writer.toLowerCase() || row.owner.toLowerCase() !== port.writer.toLowerCase() || !row.readonly || !row.extendable) throw new Error('Unexpected engine journal authority or flags.');
      if (row.expiresAt <= head) throw new Error('History already expired; renewal cannot restore it.');
      if (row.expiresAt <= head + RENEW_WINDOW) keys.push(row.key);
    }
    for (let i = 0; i < keys.length; i += 10) {
      await port.extend(keys.slice(i, i + 10)); renewed += Math.min(10, keys.length - i);
    }
    if (rows.length < 100) break;
  }
  return { renewed };
}
export function createArkivMaintainer(options: ArkivOptions, privateKey: string) {
  const chain = rabdi({ accessKey: options.accessKey || '' });
  const transport = http(options.rpcUrl, { retryCount: 0, timeout: 10000 });
  const client = createPublicClient({ chain, transport });
  const account = privateKeyToAccount(privateKey as Hex);
  if (account.address.toLowerCase() === options.writerAddress.toLowerCase()) throw new Error('Engine writer cannot renew its own journal.');
  const wallet = createWalletClient({ chain, transport, account });
  return () => renewJournal({
    writer: options.writerAddress, maintainer: account.address,
    async head() {
      if (await client.getChainId() !== 7794095) throw new Error('Not Rabdi.');
      return client.getBlockNumber();
    },
    async page(offset) {
      const result = await client.query(and(eq('arkiv.schema', str('swipr.engine-event.v1')), eq('project', str(PROJECT)),
        eq('stream', str(options.stream || 'swipr-engine-v1')), eq('$creator', addr(options.writerAddress))),
      { offset, limit: 100, orderBy: asc('revision', 'u64') });
      return result.entities.map(r => ({ key: r.$key, owner: r.$owner, creator: r.$creator, expiresAt: r.$expiresAt,
        readonly: r.$creationFlags.readonly, extendable: r.$creationFlags.permissionlessExtension }));
    },
    async extend(keys) {
      // No retries; a timeout may already have extended the entities. Next scan
      // reads their current expiry. Never consume the engine writer's nonce.
      const nonce = await client.getTransactionCount({ address: account.address, blockTag: 'latest' });
      if (await client.getTransactionCount({ address: account.address, blockTag: 'pending' }) !== nonce) throw new Error('Maintainer has a pending transaction.');
      const result = await wallet.executeBatch({ extensions: keys.map(entityKey => ({ entityKey, expiration: ExpirationTime.fromDays(180) })) }, { nonce });
      const receipt = await client.waitForTransactionReceipt({ hash: result.txHash, confirmations: options.confirmations ?? 2, timeout: 60000 });
      if (receipt.status !== 'success') throw new Error('Extension unconfirmed.');
    },
  });
}
