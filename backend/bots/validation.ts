import {
  BOT_ACTIONS, BOT_ASSETS, BOT_CHAIN_ID, BOT_LIMITS, BOT_MAX_TTL_SECONDS, BOT_STRATEGIES, BOT_STYLES,
  type BotAction, type BotAsset, type ProfileHaltData, type ProfileUpsertData, type SignalPublishData, type SignedBotAction,
} from '../contracts/bots';

export type BotErrorCode = 'invalid' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'expired'
  | 'halted' | 'limit' | 'read_only' | 'unavailable' | 'ambiguous';
const STATUS: Record<BotErrorCode, number> = { invalid: 400, unauthorized: 401, forbidden: 403, not_found: 404,
  conflict: 409, expired: 400, halted: 409, limit: 429, read_only: 503, unavailable: 503, ambiguous: 503 };

export class BotError extends Error {
  readonly status: number;
  constructor(readonly code: BotErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BotError';
    this.status = STATUS[code];
  }
}
export function check(ok: unknown, message: string, code: BotErrorCode = 'invalid'): asserts ok {
  if (!ok) throw new BotError(code, message);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Mirrors the Arkiv encoder's secret filters so bad text fails as `invalid`, not at broadcast.
const SECRETISH = /0x[0-9a-f]{130}|-----BEGIN [A-Z ]+KEY-----|eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/i;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/;
const DECIMAL = /^(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const extra = Object.keys(value).filter(k => !allowed.includes(k));
  check(!extra.length, `${label} has unsupported fields: ${extra.slice(0, 3).join(', ')}`);
}

export const uuid = (value: unknown, label: string): string => {
  check(typeof value === 'string' && UUID.test(value), `${label} must be a UUID`);
  return value.toLowerCase();
};

export function address(value: unknown, label: string): string {
  check(typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value), `${label} must be a 0x address`);
  const lower = value.toLowerCase();
  check(!/^0x0{40}$/.test(lower), `${label} cannot be the zero address`);
  return lower;
}

/** Single-line text by default; bios keep newlines but collapse runs of spaces. */
function text(value: unknown, label: string, min: number, max: number, multiline = false): string {
  check(typeof value === 'string', `${label} must be text`);
  check(!CONTROL.test(multiline ? value.replace(/\r?\n/g, '') : value), `${label} contains control characters`);
  check(!SECRETISH.test(value), `${label} looks like a key, token or signature`);
  const normalized = (multiline
    ? value.normalize('NFC').split(/\r?\n/).map(l => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n')
    : value.normalize('NFC').replace(/\s+/g, ' ')).trim();
  const length = [...normalized].length;
  check(length >= min && length <= max, `${label} must be ${min}-${max} characters`);
  return normalized;
}

function oneOf<T extends string>(value: unknown, options: readonly T[], label: string): T {
  check(typeof value === 'string' && (options as readonly string[]).includes(value), `${label} must be one of ${options.join(', ')}`);
  return value as T;
}

function decimal(value: unknown, label: string): string {
  check(typeof value === 'string' && DECIMAL.test(value), `${label} must be a plain decimal string`);
  check(/[1-9]/.test(value), `${label} must be positive`);
  return value;
}

export function assets(value: unknown): BotAsset[] {
  check(Array.isArray(value) && value.length > 0 && value.length <= 8, 'assets must list WETH and/or cbBTC');
  const set = new Set(value.map(a => oneOf(a, BOT_ASSETS, 'asset')));
  return BOT_ASSETS.filter(a => set.has(a));
}

/** Normalized profile data. `profileId` is required here (store resolves creates first). */
export function profileUpsert(raw: unknown): ProfileUpsertData & { profileId: string } {
  check(isRecord(raw), 'data must be an object');
  onlyKeys(raw, ['profileId', 'operator', 'name', 'bio', 'style', 'strategy', 'assets', 'publicSeats', 'privateSeats'], 'profile');
  const publicSeats = raw.publicSeats ?? 20, privateSeats = raw.privateSeats ?? 0;
  check(Number.isSafeInteger(publicSeats) && Number(publicSeats) >= 0 && Number(publicSeats) <= 100, 'Public seats must be 0-100');
  check(Number.isSafeInteger(privateSeats) && Number(privateSeats) >= 0 && Number(privateSeats) <= 100, 'Private seats must be 0-100');
  return {
    ...(raw.publicSeats === undefined ? {} : { publicSeats: Number(publicSeats) }),
    ...(raw.privateSeats === undefined ? {} : { privateSeats: Number(privateSeats) }),
    profileId: uuid(raw.profileId, 'profileId'), operator: address(raw.operator, 'operator'),
    name: text(raw.name, 'name', BOT_LIMITS.nameMin, BOT_LIMITS.nameMax),
    bio: text(raw.bio ?? '', 'bio', 0, BOT_LIMITS.bioMax, true),
    style: oneOf(raw.style, BOT_STYLES, 'style'), strategy: oneOf(raw.strategy, BOT_STRATEGIES, 'strategy'),
    assets: assets(raw.assets),
  };
}

export function profileHalt(raw: unknown): ProfileHaltData {
  check(isRecord(raw), 'data must be an object');
  onlyKeys(raw, ['profileId'], 'halt');
  return { profileId: uuid(raw.profileId, 'profileId') };
}

/** A proposal only: there is no order type, slippage, account or execution field to set. */
export function signalPublish(raw: unknown): SignalPublishData {
  check(isRecord(raw), 'data must be an object');
  onlyKeys(raw, ['profileId', 'asset', 'side', 'quantity', 'limitPrice', 'thesis'], 'signal');
  const thesis = raw.thesis === undefined ? '' : text(raw.thesis, 'thesis', 0, BOT_LIMITS.thesisMax, true);
  return {
    profileId: uuid(raw.profileId, 'profileId'), asset: oneOf(raw.asset, BOT_ASSETS, 'asset'),
    side: oneOf(raw.side, ['buy', 'sell'] as const, 'side'),
    quantity: decimal(raw.quantity, 'quantity'), limitPrice: decimal(raw.limitPrice, 'limitPrice'),
    ...(thesis ? { thesis } : {}),
  };
}

/**
 * Structural check of a client envelope before signature recovery. Data keeps its
 * signed form here (the signature covers it); normalization happens after recovery.
 */
export function parseEnvelope(raw: unknown, audience: string): SignedBotAction {
  let size = Infinity;
  try { size = Buffer.byteLength(JSON.stringify(raw) ?? ''); } catch { /* cyclic or bigint */ }
  check(size <= BOT_LIMITS.envelopeBytes, `envelope must be at most ${BOT_LIMITS.envelopeBytes} bytes of JSON`);
  check(isRecord(raw), 'envelope must be an object');
  onlyKeys(raw, ['payload', 'signature'], 'envelope');
  check(typeof raw.signature === 'string' && /^0x[0-9a-fA-F]{130}$/.test(raw.signature), 'signature must be 65-byte hex');
  const p = raw.payload;
  check(isRecord(p), 'payload must be an object');
  onlyKeys(p, ['version', 'audience', 'chainId', 'requestId', 'issuedAt', 'expiresAt', 'action', 'data'], 'payload');
  check(p.version === 1, 'unsupported version');
  check(p.audience === audience, 'payload audience does not match this service');
  check(p.chainId === BOT_CHAIN_ID, `chainId must be ${BOT_CHAIN_ID}`);
  check(typeof p.requestId === 'string' && UUID.test(p.requestId), 'requestId must be a UUID');
  check(Number.isSafeInteger(p.issuedAt) && Number.isSafeInteger(p.expiresAt) && (p.issuedAt as number) > 0, 'issuedAt/expiresAt must be unix seconds');
  const ttl = (p.expiresAt as number) - (p.issuedAt as number);
  check(ttl > 0 && ttl <= BOT_MAX_TTL_SECONDS, `expiresAt must be within ${BOT_MAX_TTL_SECONDS}s of issuedAt`);
  oneOf(p.action, BOT_ACTIONS, 'action');
  check(isRecord(p.data), 'data must be an object');
  return { payload: p as unknown as BotAction, signature: raw.signature as `0x${string}` };
}

/** Freshness is judged against confirmed chain time, never the client clock. */
export function checkFresh(issuedAt: number, expiresAt: number, nowMs: number) {
  const now = Math.floor(nowMs / 1000);
  check(issuedAt <= now + 30, 'action is issued in the future', 'expired');
  check(expiresAt > now && now - issuedAt <= BOT_MAX_TTL_SECONDS, 'action has expired; sign a new one', 'expired');
}
