import { ExpirationTime } from '@arkiv-network/sdk';
import type { Session } from '../auth/Session';
import type { Ghost } from '../contracts/types';
import { parseWalletGhost, activeWalletGhosts, type WalletGhostRecord } from '../contracts/ghosts';
import { WalletGhostSchema, WALLET_PROFILE_PROJECT, walletJson } from '../contracts/wallet-profile';
import { accountRequest, arkivConnection, fundArkivWrite } from './arkiv';
import { loadGhosts, saveGhosts, startGhost } from './ghosts';
export async function readWalletGhosts(session: Session): Promise<WalletGhostRecord[]> {
  if (!session.address) throw new Error('Sign in to save ghosts.');
  const response = await accountRequest(session, `/api/ghosts?wallet=${session.address}`);
  if (!Array.isArray(response.records)) throw new Error('Ghosts could not be loaded.');
  return response.records.map((row: WalletGhostRecord) => {
    if (!/^0x[0-9a-f]{64}$/i.test(row.entityKey) || !['active', 'removed'].includes(row.status)) throw new Error('Invalid ghost record.');
    return { ...row, ghost: parseWalletGhost(row.ghost) };
  });
}
async function confirmedIndex(session: Session, matches: (records: WalletGhostRecord[]) => boolean) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const records = await readWalletGhosts(session);
    if (matches(records)) return records;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error('Your ghost transaction was confirmed. Refresh shortly to see the updated records.');
}
export function walletGhostIO(getSession: () => Session) {
  return {
    read: () => readWalletGhosts(getSession()),
    async start(traderId: string, amount: number) {
      const session = getSession();
      const records = await readWalletGhosts(session);
      if (activeWalletGhosts(records).some(g => g.traderId === traderId)) return { records, existed: true };
      // An explicit Ghost-copy action can import that trader's old local parameters.
      const legacy = loadGhosts().find(g => g.traderId === traderId);
      const ghost = parseWalletGhost(legacy ?? startGhost([], traderId, amount)[0]);
      const { client, address } = await arkivConnection(session);
      if (address.toLowerCase() !== session.address?.toLowerCase()) throw new Error('Your account changed. Try again.');
      await fundArkivWrite(session, address);
      const result = await client.createEntity(WalletGhostSchema, {
        project: WALLET_PROFILE_PROJECT, ghost: walletJson(ghost), status: 'active',
      }, { expiration: ExpirationTime.fromDays(30) });
      await client.waitForTransactionReceipt({ hash: result.txHash, confirmations: 2 });
      const saved = await confirmedIndex(session, rows => rows.some(r => r.entityKey === result.entityKey && r.status === 'active' && r.ghost.startedAt === ghost.startedAt));
      if (legacy) saveGhosts(loadGhosts().filter(g => g.traderId !== traderId));
      return { records: saved, existed: false };
    },
    async remove(traderId: string) {
      const session = getSession();
      const records = await readWalletGhosts(session);
      const targets = records.filter(r => r.ghost.traderId === traderId && r.status === 'active');
      if (!targets.length) return records;
      const { client, address } = await arkivConnection(session);
      if (address.toLowerCase() !== session.address?.toLowerCase()) throw new Error('Your account changed. Try again.');
      await fundArkivWrite(session, address);
      for (let offset = 0; offset < targets.length; offset += 100) {
        const result = await client.executeBatch({ patches: targets.slice(offset, offset + 100).map(r => ({ schema: WalletGhostSchema, entityKey: r.entityKey, set: { status: 'removed' } })) });
        await client.waitForTransactionReceipt({ hash: result.txHash, confirmations: 2 });
      }
      return confirmedIndex(session, rows => !rows.some(r => targets.some(t => t.entityKey === r.entityKey) && r.status === 'active'));
    },
  };
}
export type GhostIO = ReturnType<typeof walletGhostIO>;
export type AccountGhostSnapshot = { ghosts: Ghost[]; loading: boolean; busy: boolean; error: string };
/** Account-scoped memory view. Failed writes never fall back to browser persistence. */
export function createAccountGhostStore(io: GhostIO) {
  let snapshot: AccountGhostSnapshot = { ghosts: [], loading: true, busy: false, error: '' };
  let tail: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(next: AccountGhostSnapshot) => void>();
  const publish = (patch: Partial<AccountGhostSnapshot>) => { snapshot = { ...snapshot, ...patch }; listeners.forEach(l => l(snapshot)); };
  const run = <T>(action: () => Promise<T>) => {
    const task = tail.then(action);
    tail = task.catch(() => {});
    return task;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: (next: AccountGhostSnapshot) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh: () => run(async () => {
      try { publish({ ghosts: activeWalletGhosts(await io.read()), loading: false, error: '' }); }
      catch (e) { publish({ loading: false, error: e instanceof Error ? e.message : 'Ghosts could not be loaded.' }); }
    }),
    start: (traderId: string, amount: number) => run(async () => {
      publish({ busy: true, error: '' });
      try { const result = await io.start(traderId, amount); publish({ ghosts: activeWalletGhosts(result.records), loading: false }); return result; }
      finally { publish({ busy: false }); }
    }),
    remove: (traderId: string) => run(async () => {
      publish({ busy: true, error: '' });
      try { publish({ ghosts: activeWalletGhosts(await io.remove(traderId)) }); }
      finally { publish({ busy: false }); }
    }),
  };
}
