import { expect, it } from 'vitest';
import { runJob } from './worker';
import type { Job } from './ledger';
const job = { kind: 'probe-base' } as Job;
it('verifies Base chain identity before completing a probe', async () => {
  const fetcher = async () => Response.json({ jsonrpc: '2.0', id: 1, result: '0x2105' });
  await expect(runJob(job, 'https://rpc.example', fetcher)).resolves.toBeUndefined();
  await expect(runJob(job, 'https://rpc.example', async () => Response.json({ result: '0x1' }))).rejects.toThrow('base_chain_mismatch');
});
it('does not dispatch unsupported jobs or unconfigured providers', async () => {
  await expect(runJob(job)).rejects.toThrow('base_rpc_unconfigured');
  await expect(runJob({ ...job, kind: 'submit-order' })).rejects.toThrow('unsupported_job_kind');
});
