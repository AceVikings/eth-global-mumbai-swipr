import { expect, it } from 'vitest';
import { renewJournal, type ExpiringEntity, type MaintenancePort } from './arkiv-maintenance';
const writer = `0x${'1'.repeat(40)}`, maintainer = `0x${'2'.repeat(40)}`;
const row: ExpiringEntity = { key: `0x${'a'.repeat(64)}`, creator: writer, owner: writer, expiresAt: 200n, readonly: true, extendable: true };
function fixture() {
  const extended: string[][] = [];
  const port: MaintenancePort = { writer, maintainer, head: async () => 100n,
    page: async () => [row, { ...row, key: `0x${'b'.repeat(64)}`, expiresAt: 10000000n }],
    extend: async keys => { extended.push(keys); } };
  return { port, extended };
}
it('renews expiring readonly records through a separate account', async () => {
  const f = fixture();
  expect(await renewJournal(f.port)).toEqual({ renewed: 1 });
  expect(f.extended).toEqual([[row.key]]);
});
it('refuses to consume the engine nonce or renew untrusted records', async () => {
  const f = fixture();
  await expect(renewJournal({ ...f.port, maintainer: writer })).rejects.toThrow('separate');
  await expect(renewJournal({ ...f.port, page: async () => [{ ...row, readonly: false }] })).rejects.toThrow('authority');
  await expect(renewJournal({ ...f.port, page: async () => [{ ...row, expiresAt: 1n }] })).rejects.toThrow('expired');
  expect(f.extended).toEqual([]);
});
it('does not retry an uncertain extension', async () => {
  const f = fixture(); let calls = 0;
  await expect(renewJournal({ ...f.port, extend: async () => { calls++; throw new Error('timeout'); } })).rejects.toThrow('timeout');
  expect(calls).toBe(1);
});
