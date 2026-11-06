export type Config = ReturnType<typeof readConfig>;
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const mode = env.APP_MODE || 'preview';
  if (mode !== 'preview' && mode !== 'live') throw new Error('Invalid APP_MODE');
  const port = Number(env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const origins = (env.ALLOWED_ORIGINS || (env.NODE_ENV === 'production' ? '' : 'http://127.0.0.1:5173,http://localhost:5173')).split(',').map(x => x.trim()).filter(Boolean);
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid ALLOWED_ORIGINS');
    if (env.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('Production origins require HTTPS');
  }
  const confirmations = Number(env.ARKIV_CONFIRMATIONS || 2);
  if (!Number.isSafeInteger(confirmations) || confirmations < 1 || confirmations > 20) throw new Error('Invalid ARKIV_CONFIRMATIONS');
  return { port, origins, mode,
    arkiv: { rpcUrl: env.ARKIV_RPC_URL, accessKey: env.ARKIV_ACCESS_KEY,
      writerAddress: env.ARKIV_WRITER_ADDRESS || '', privateKey: env.ARKIV_RELAYER_PK,
      stream: env.ARKIV_ENGINE_STREAM || 'swipr-engine-v1', confirmations },
    privyAppId: env.PRIVY_APP_ID || env.VITE_PRIVY_APP_ID,
    privySecret: env.PRIVY_APP_SECRET, privyVerificationKey: env.PRIVY_VERIFICATION_KEY,
    flashKey: env.FLASH_KEY_EXEC || env.FLASH_API_KEY,
    baseRpc: env.BASE_RPC, sepoliaRpc: env.SEPOLIA_RPC,
    arkivMaintainerKey: env.ARKIV_MAINTAINER_PK,
    beeUrl: env.BEE_URL, swarmBatchId: env.SWARM_BATCH_ID,
  };
}
