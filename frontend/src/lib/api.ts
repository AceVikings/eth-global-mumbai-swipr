import type { RuntimeStatus } from '../../../shared/types';
const configured = import.meta.env.VITE_API_URL as string | undefined;
const base = configured ? configured.replace(/\/$/, '') : '';
export async function getRuntime(signal: AbortSignal): Promise<RuntimeStatus> {
  if (base && new URL(base).protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(new URL(base).hostname)) {
    throw new Error('The API URL must use HTTPS.');
  }
  const response = await fetch(`${base}/api/runtime`, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error('The live service is unavailable.');
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || !('integrations' in value) || !Array.isArray(value.integrations)) throw new Error('Invalid service response.');
  const runtime = value as RuntimeStatus;
  if (runtime.tradingEnabled !== false || !runtime.integrations.every(i => typeof i.name === 'string' && typeof i.configured === 'boolean' && typeof i.verified === 'boolean' && typeof i.detail === 'string')) throw new Error('Invalid service response.');
  return runtime;
}
