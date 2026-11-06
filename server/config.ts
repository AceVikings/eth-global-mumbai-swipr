export type Config = ReturnType<typeof readConfig>;
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const port = Number(env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const origins = (env.ALLOWED_ORIGINS || 'http://127.0.0.1:5173,http://localhost:5173').split(',').map(x => x.trim());
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid ALLOWED_ORIGINS');
    if (env.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('Production origins require HTTPS');
  }
  return { port, origins, databaseUrl: env.DATABASE_URL,
    privyAppId: env.PRIVY_APP_ID || env.VITE_PRIVY_APP_ID,
    privySecret: env.PRIVY_APP_SECRET, privyVerificationKey: env.PRIVY_VERIFICATION_KEY,
    flashKey: env.FLASH_KEY_EXEC || env.FLASH_API_KEY,
    baseRpc: env.BASE_RPC, sepoliaRpc: env.SEPOLIA_RPC,
    beeUrl: env.BEE_URL, swarmBatchId: env.SWARM_BATCH_ID,
  };
}
