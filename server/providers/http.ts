export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type ErrorCode = 'timeout' | 'network' | 'http' | 'bad_response' | 'invalid' | 'not_configured';

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly code: ErrorCode,
    message: string,
    readonly opts: { status?: number; retryable?: boolean; ambiguous?: boolean; retryAfterMs?: number } = {},
  ) {
    super(`${provider}: ${message}`);
    this.name = 'ProviderError';
  }
  get status() { return this.opts.status; }
  get retryable() { return this.opts.retryable ?? false; }
  /** A POST that may have executed remotely: reconcile, never resend blindly. */
  get ambiguous() { return this.opts.ambiguous ?? false; }
}

/** Masks known secrets, ≥ 32-byte hex (signatures, keys) and bearer/API-key looking tokens. */
export function redact(text: string, secrets: string[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('[redacted]');
  return out
    .replace(/(0x)?[0-9a-fA-F]{64,}/g, '[redacted-hex]')
    .replace(/(bearer\s+)[\w.-]+/gi, '$1[redacted]')
    .replace(/\bdpka_[\w]+/g, '[redacted]')
    .slice(0, 300);
}

export interface HttpOptions {
  provider: string;
  fetch: FetchLike;
  timeoutMs?: number;
  minIntervalMs?: number;
  retries?: number;
  secrets?: string[];
  sleep?: (ms: number) => Promise<void>;
}

export function createHttp(o: HttpOptions) {
  const timeoutMs = o.timeoutMs ?? 8000;
  const retries = o.retries ?? 2;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let gate: Promise<void> = Promise.resolve();
  let last = 0;

  // Serialise starts so each key stays under the provider's per-second quota.
  const pace = () => {
    const turn = gate.then(async () => {
      const wait = last + (o.minIntervalMs ?? 0) - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
    });
    gate = turn.catch(() => {});
    return turn;
  };

  async function once(url: string, init: RequestInit, write: boolean): Promise<Response> {
    await pace();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await o.fetch(url, { ...init, signal: ctl.signal });
      if (res.ok) return res;
      const body = redact(await res.text().catch(() => ''), o.secrets);
      const ra = Number(res.headers.get('retry-after'));
      throw new ProviderError(o.provider, 'http', `HTTP ${res.status} ${body}`, {
        status: res.status,
        retryable: res.status === 429 || res.status >= 500,
        ambiguous: write && res.status >= 500,
        retryAfterMs: Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10_000) : undefined,
      });
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      const timedOut = ctl.signal.aborted;
      throw new ProviderError(o.provider, timedOut ? 'timeout' : 'network',
        timedOut ? `timed out after ${timeoutMs}ms` : redact(String((e as Error)?.message ?? e), o.secrets),
        { retryable: true, ambiguous: write });
    } finally {
      clearTimeout(timer);
    }
  }

  /** `retry` must only be true for reads and quotes: execution POSTs are never resent. */
  async function raw(url: string, init: RequestInit = {}, { retry = false } = {}): Promise<Response> {
    const write = !retry && (init.method ?? 'GET') !== 'GET';
    for (let attempt = 0; ; attempt++) {
      try {
        return await once(url, init, write);
      } catch (e) {
        const err = e as ProviderError;
        if (!retry || !err.retryable || attempt >= retries) throw err;
        await sleep(err.opts.retryAfterMs ?? 250 * 2 ** attempt);
      }
    }
  }

  async function json<T = any>(url: string, init: RequestInit = {}, opts: { retry?: boolean } = {}): Promise<T> {
    const res = await raw(url, init, opts);
    try {
      return (await res.json()) as T;
    } catch {
      throw new ProviderError(o.provider, 'bad_response', 'response was not JSON', {
        ambiguous: !opts.retry && (init.method ?? 'GET') !== 'GET',
      });
    }
  }

  return { raw, json };
}
