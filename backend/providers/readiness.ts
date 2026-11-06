// Honest capability report. Configuration is not verification: nothing here ever
// reports a live integration; live acceptance gates are recorded elsewhere.
export type ReadinessState = 'missing_config' | 'configured_unverified' | 'unsupported';
export type Capability = 'flash' | 'baseRpc' | 'bee' | 'arkiv' | 'ens' | 'privy';
export interface Readiness { state: ReadinessState; detail: string }

const has = (env: Record<string, string | undefined>, k: string) => Boolean(env[k]?.trim());
const needs = (env: Record<string, string | undefined>, keys: string[], what: string): Readiness => {
  const missing = keys.filter((k) => !has(env, k));
  return missing.length
    ? { state: 'missing_config', detail: `missing ${missing.join(', ')}` }
    : { state: 'configured_unverified', detail: `${what}; not yet proven by a live acceptance run` };
};

export function providerReadiness(env: Record<string, string | undefined>): Record<Capability, Readiness> {
  env = { ...env, FLASH_API_KEY: env.FLASH_KEY_EXEC || env.FLASH_API_KEY, BASE_RPC: env.BASE_RPC || env.BASE_RPC_URL };
  return {
    flash: env.FLASH_API_KEY?.startsWith('dpka_513a2bd7')
      ? { state: 'missing_config', detail: 'FLASH_API_KEY is the public dev key; orders refused' }
      : needs(env, ['FLASH_API_KEY'], 'quote/order/status/cancel relay for user-signed orders'),
    baseRpc: needs(env, ['BASE_RPC'], 'receipt reads and transfer-leg decoding'),
    bee: needs(env, ['BEE_URL', 'SWARM_BATCH_ID'], 'pinned media upload/download with BMT integrity verification'),
    arkiv: { state: 'unsupported', detail: 'no Arkiv adapter in this build' },
    ens: { state: 'configured_unverified', detail: 'ENSv2 Sepolia resolution and wallet-signed text publication; live write acceptance is separate' },
    privy: { state: 'unsupported', detail: 'no Privy signer adapter; no autonomous signing' },
  };
}
