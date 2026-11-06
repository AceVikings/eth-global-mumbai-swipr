import { rabdi } from '@arkiv-network/sdk/chains';
import { ApiError } from './auth';

const READ_METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBalance', 'eth_getTransactionCount',
  'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_estimateGas', 'eth_call',
  'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getTransactionReceipt', 'eth_getTransactionByHash',
  'eth_getLogs', 'arkiv_getEntity', 'arkiv_getBlockTiming']);

/** Only authenticated reads use the service RPC key. Signing and broadcasting stay in the user's wallet. */
export function createArkivRpc(options: { accessKey?: string; rpcUrl?: string }, fetcher: typeof fetch = fetch) {
  const endpoint = options.rpcUrl || rabdi({ accessKey: options.accessKey || '' }).rpcUrls.default.http[0];
  return async (input: Record<string, unknown>) => {
    if (input.jsonrpc !== '2.0' || typeof input.method !== 'string' || !READ_METHODS.has(input.method)
      || !Array.isArray(input.params) || !['string', 'number'].includes(typeof input.id)) throw new ApiError(400, 'rpc_method_denied', 'This RPC method is not available.');
    const response = await fetcher(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: input.id, method: input.method, params: input.params }),
      signal: AbortSignal.timeout(10000), redirect: 'error' });
    if (!response.ok || !response.body) throw new ApiError(503, 'rpc_unavailable', 'Account storage could not be reached.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 1048576) throw new ApiError(413, 'rpc_response_large', 'The storage response is too large.');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  };
}
