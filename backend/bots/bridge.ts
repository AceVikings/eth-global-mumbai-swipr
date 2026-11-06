import { ApiError } from '../auth';

/** Cloud Run IAM protects transport; wallet signatures authorize each command.
 * The public API never receives a journal signing key. */
export function createWorkerBridge(options: { url?: string; production?: boolean; fetcher?: typeof fetch; path?: '/internal/bots' | '/internal/social' | '/internal/gas' | '/internal/ens' | '/internal/trading' }) {
  const fetcher = options.fetcher ?? fetch;
  let target: URL | null = null;
  if (options.url) {
    target = new URL(options.url);
    const local = ['127.0.0.1', 'localhost', '[::1]', 'worker'].includes(target.hostname);
    const cloud = target.protocol === 'https:' && target.hostname.endsWith('.run.app');
    if (target.username || target.password || target.search || target.hash || target.pathname !== '/' || (!cloud && !(local && !options.production && target.protocol === 'http:'))) {
      throw new Error('Worker URL must be a Cloud Run origin or a local development origin.');
    }
  }
  return async (input: unknown): Promise<unknown> => {
    if (!target) throw new ApiError(503, 'writer_unavailable', 'Publishing needs the Arkiv worker connection. Your change has not been saved.');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (target.protocol === 'https:') {
      const token = await fetcher(`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(target.origin)}&format=full`, {
        headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(4000), redirect: 'error',
      });
      if (!token.ok) throw new ApiError(503, 'worker_identity_unavailable', 'Worker authentication is unavailable.');
      const value = await token.text();
      if (value.length > 8192 || !/^eyJ[\w.-]+$/.test(value)) throw new ApiError(503, 'worker_identity_unavailable', 'Worker authentication is unavailable.');
      headers.authorization = `Bearer ${value}`;
    }
    let response: Response;
    try {
      response = await fetcher(new URL(options.path ?? '/internal/bots', target), {
        method: 'POST', headers, body: JSON.stringify(input), signal: AbortSignal.timeout(25000), redirect: 'error',
      });
    } catch {
      // The commit may have succeeded. Reconcile the SAME request ID.
      throw new ApiError(503, 'write_uncertain', 'Worker response unavailable. Retry the same signed request to reconcile its outcome.');
    }
    const result = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    if (!response.ok) {
      const code = result?.error?.code, message = result?.error?.message;
      throw new ApiError([400, 401, 403, 404, 409, 422, 429, 503].includes(response.status) ? response.status : 503,
        typeof code === 'string' && /^[a-z_]+$/.test(code) ? code : 'worker_unavailable',
        typeof message === 'string' && message.length < 350 ? message : 'Worker could not confirm this command.');
    }
    return result;
  };
}
