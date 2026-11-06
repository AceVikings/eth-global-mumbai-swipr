import { expect, it, vi } from 'vitest';
import { createArkivRpc } from './arkiv-rpc';

it('never proxies wallet signing, transaction submission, or arbitrary RPC methods', async () => {
  const fetcher = vi.fn();
  const rpc = createArkivRpc({ rpcUrl: 'https://rpc.example' }, fetcher);
  for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'personal_sign', 'debug_traceTransaction']) {
    await expect(rpc({ jsonrpc: '2.0', id: 1, method, params: [] })).rejects.toMatchObject({ code: 'rpc_method_denied' });
  }
  expect(fetcher).not.toHaveBeenCalled();
});
