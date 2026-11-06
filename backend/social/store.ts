import { randomUUID } from 'node:crypto';
import { keccak256, recoverMessageAddress, stringToBytes } from 'viem';
import {
  SOCIAL_ACTIONS, SOCIAL_CHAIN_ID, SOCIAL_LIMITS, SOCIAL_MAX_TTL_SECONDS, socialMessage,
  type SocialAction, type SocialActionType,
} from '../contracts/social';
import { JournalError, withJournalWrite, type Journal, type JournalEvent, type JournalSnapshot } from '../arkiv-journal';
import { address, BotError, check, checkFresh, uuid } from '../bots/validation';

export const SOCIAL_COMMAND = 'project.social';

/** What lands on Arkiv: recovered actor, normalized target and message digest. Never the signature. */
export type SocialCommand = {
  type: typeof SOCIAL_COMMAND; version: 1; actor: string; requestId: string; digest: string;
  action: SocialActionType; target: string; issuedAt: number; expiresAt: number;
};
export type SocialExecuteResult = { following: string[]; replayed: boolean };
export type SocialState = {
  at: number; following: Map<string, Set<string>>; requests: Map<string, { digest: string; actor: string }>; writes: number[];
};

const KEYS = ['type', 'version', 'actor', 'requestId', 'digest', 'action', 'target', 'issuedAt', 'expiresAt'];
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export const isSocialCommand = (raw: unknown) => isRecord(raw) && raw.type === SOCIAL_COMMAND;

function timing(issuedAt: unknown, expiresAt: unknown) {
  check(Number.isSafeInteger(issuedAt) && Number.isSafeInteger(expiresAt) && (issuedAt as number) > 0, 'issuedAt/expiresAt must be unix seconds');
  const ttl = (expiresAt as number) - (issuedAt as number);
  check(ttl > 0 && ttl <= SOCIAL_MAX_TTL_SECONDS, `expiresAt must be within ${SOCIAL_MAX_TTL_SECONDS}s of issuedAt`);
}

/** Shape-validates a stored command exactly as the write path built it. Extra or non-normalized fields fail closed. */
export function validateSocialCommand(raw: unknown): SocialCommand {
  check(isSocialCommand(raw), 'not a social command');
  const c = raw as Record<string, unknown>;
  check(Object.keys(c).length === KEYS.length && KEYS.every(k => k in c), 'social command fields invalid');
  check(c.version === 1, 'social command version invalid');
  check(typeof c.action === 'string' && (SOCIAL_ACTIONS as readonly string[]).includes(c.action), 'social action invalid');
  check(typeof c.digest === 'string' && /^0x[0-9a-f]{64}$/.test(c.digest), 'social digest invalid');
  timing(c.issuedAt, c.expiresAt);
  const command: SocialCommand = {
    type: SOCIAL_COMMAND, version: 1, actor: address(c.actor, 'actor'), requestId: uuid(c.requestId, 'requestId'),
    digest: c.digest as string, action: c.action as SocialActionType, target: address(c.target, 'target'),
    issuedAt: c.issuedAt as number, expiresAt: c.expiresAt as number,
  };
  check(command.actor === c.actor && command.requestId === c.requestId && command.target === c.target, 'social command is not normalized');
  return command;
}

export const emptySocialState = (): SocialState => ({ at: 0, following: new Map(), requests: new Map(), writes: [] });

const list = (state: SocialState, actor: string) => [...(state.following.get(actor) ?? [])].sort();

/** Applies one validated command at confirmed chain time. The write path runs this before appending; replay re-runs it. */
export function applySocial(state: SocialState, command: SocialCommand, at: number): void {
  check(!state.requests.has(command.requestId), 'requestId already used', 'conflict');
  checkFresh(command.issuedAt, command.expiresAt, at);
  check(command.actor !== command.target, 'you cannot follow yourself');
  while (state.writes.length && state.writes[0] <= at - 3_600_000) state.writes.shift();
  check(state.writes.length < SOCIAL_LIMITS.writesPerHour, 'social write limit reached; try again later', 'limit');
  const set = state.following.get(command.actor) ?? new Set<string>();
  if (command.action === 'follow') {
    check(!set.has(command.target), 'already following this wallet', 'conflict');
    check(set.size < SOCIAL_LIMITS.followingPerActor, `at most ${SOCIAL_LIMITS.followingPerActor} follows per wallet`, 'limit');
    set.add(command.target);
    state.following.set(command.actor, set);
  } else {
    check(set.delete(command.target), 'not following this wallet', 'not_found');
  }
  state.requests.set(command.requestId, { digest: command.digest, actor: command.actor });
  state.writes.push(at);
  state.at = Math.max(state.at, at);
}

/** Folds only `project.social` events out of the shared journal; every other namespace is skipped. Fails closed. */
export function replaySocial(events: readonly JournalEvent[]): SocialState {
  const state = emptySocialState();
  for (const event of events) {
    if (!isSocialCommand(event.command)) continue;
    try {
      applySocial(state, validateSocialCommand(event.command), event.at);
    } catch (cause) {
      throw new BotError('unavailable', `social journal invalid at revision ${event.revision}`, { cause });
    }
  }
  return state;
}

/** Strict envelope parse before signature recovery. */
function parseEnvelope(raw: unknown, audience: string): { payload: SocialAction; signature: `0x${string}` } {
  let size = Infinity;
  try { size = Buffer.byteLength(JSON.stringify(raw) ?? ''); } catch { /* cyclic or bigint */ }
  check(size <= SOCIAL_LIMITS.envelopeBytes, `envelope must be at most ${SOCIAL_LIMITS.envelopeBytes} bytes of JSON`);
  check(isRecord(raw) && Object.keys(raw).every(k => k === 'payload' || k === 'signature'), 'envelope must be {payload, signature}');
  check(typeof raw.signature === 'string' && /^0x[0-9a-fA-F]{130}$/.test(raw.signature), 'signature must be 65-byte hex');
  const p = raw.payload;
  const fields = ['version', 'audience', 'chainId', 'requestId', 'issuedAt', 'expiresAt', 'action', 'target'];
  check(isRecord(p) && Object.keys(p).every(k => fields.includes(k)), 'payload has unsupported fields');
  check(p.version === 1, 'unsupported version');
  check(p.audience === audience, 'payload audience does not match this service');
  check(p.chainId === SOCIAL_CHAIN_ID, `chainId must be ${SOCIAL_CHAIN_ID}`);
  uuid(p.requestId, 'requestId');
  timing(p.issuedAt, p.expiresAt);
  check(typeof p.action === 'string' && (SOCIAL_ACTIONS as readonly string[]).includes(p.action), 'action must be follow or unfollow');
  address(p.target, 'target');
  return { payload: p as unknown as SocialAction, signature: raw.signature as `0x${string}` };
}

/** Recovers the EOA that personal_signed socialMessage(payload). The signature is dropped here. */
export async function verifySocialAction(raw: unknown, audience: string) {
  const { payload, signature } = parseEnvelope(raw, audience);
  const message = socialMessage(payload);
  let actor: string;
  try {
    actor = (await recoverMessageAddress({ message, signature })).toLowerCase();
  } catch (cause) {
    throw new BotError('unauthorized', 'signature could not be verified', { cause });
  }
  if (/^0x0{40}$/.test(actor)) throw new BotError('unauthorized', 'signature could not be verified');
  return { payload, actor, digest: keccak256(stringToBytes(message)) };
}

/** Event-sourced follow graph on the shared Arkiv journal. No cache, no SQL, no memory fallback. */
export class SocialStore {
  constructor(private readonly journal: Journal, private readonly audience: string) {
    check(typeof audience === 'string' && audience.length > 0 && audience.length <= 200 && !/[\r\n]/.test(audience), 'audience is required');
  }

  private async snapshot(): Promise<{ snapshot: JournalSnapshot; state: SocialState }> {
    let snapshot: JournalSnapshot;
    try { snapshot = await this.journal.read(); } catch (cause) {
      throw new BotError('unavailable', 'social graph is unavailable', { cause });
    }
    return { snapshot, state: replaySocial(snapshot.events) };
  }

  async following(actor: string): Promise<string[]> {
    const wallet = address(actor, 'address');
    return list((await this.snapshot()).state, wallet);
  }

  /** Verifies the wallet signature, then writes one event fenced by the journal nonce via the shared write queue. */
  async execute(envelope: unknown): Promise<SocialExecuteResult> {
    const { payload, actor, digest } = await verifySocialAction(envelope, this.audience);
    if (!this.journal.canWrite) throw new BotError('read_only', 'social commands are accepted by the worker only');
    return withJournalWrite(this.journal, async () => {
      const { snapshot, state } = await this.snapshot();
      const requestId = payload.requestId.toLowerCase();
      const prior = state.requests.get(requestId);
      if (prior) {
        // Exact replays succeed even after expiry; anything else under this requestId conflicts.
        check(prior.digest === digest && prior.actor === actor, 'requestId was already used for a different action', 'conflict');
        return { following: list(state, actor), replayed: true };
      }
      const command: SocialCommand = { type: SOCIAL_COMMAND, version: 1, actor, requestId, digest, action: payload.action,
        target: address(payload.target, 'target'), issuedAt: payload.issuedAt, expiresAt: payload.expiresAt };
      const at = Math.max(snapshot.timestampMs, state.at);
      applySocial(state, command, at); // domain errors surface before any append
      try {
        await this.journal.append({ revision: snapshot.nonce + 1, id: randomUUID(), at, command }, snapshot.nonce);
      } catch (cause) {
        // Never auto-retry. Clients resend the same signed envelope; an exact replay reconciles.
        if (cause instanceof JournalError && cause.code === 'conflict') throw new BotError('conflict', 'another write landed first; resend the same signed action', { cause });
        if (cause instanceof JournalError && cause.code === 'invalid') throw new BotError('invalid', cause.message, { cause });
        throw new BotError(cause instanceof JournalError && cause.code === 'ambiguous' ? 'ambiguous' : 'unavailable',
          'social write was not confirmed; resend the same signed action to reconcile', { cause });
      }
      return { following: list(state, actor), replayed: false };
    });
  }
}
