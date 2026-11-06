import { randomUUID } from 'node:crypto';
import { BOT_ACTIONS, BOT_LIMITS, BOT_MAX_TTL_SECONDS, type BotActionType, type BotProfile, type BotSignal } from '../contracts/bots';
import { withJournalWrite, JournalError, type Journal, type JournalEvent, type JournalSnapshot } from '../arkiv-journal';
import { verifyBotAction } from './auth';
import { address, BotError, check, checkFresh, profileHalt, profileUpsert, signalPublish, uuid } from './validation';

export const PROJECT_COMMAND = 'project.bot';

/** What lands on Arkiv: recovered actor and normalized data. Never the signature. */
export type ProjectCommand = {
  type: typeof PROJECT_COMMAND; version: 1; actor: string; requestId: string; digest: string;
  action: BotActionType; issuedAt: number; expiresAt: number; data: Record<string, unknown>;
};
export type ExecuteResult = { profile?: BotProfile; signal?: BotSignal; replayed: boolean };
type Prior = { digest: string; actor: string; result: Omit<ExecuteResult, 'replayed'> };
export type ProjectState = {
  at: number; writeTimes: number[]; profiles: Map<string, BotProfile>; signals: BotSignal[]; requests: Map<string, Prior>;
};

export const isProjectCommand = (raw: unknown) =>
  !!raw && typeof raw === 'object' && (raw as { type?: unknown }).type === PROJECT_COMMAND;

const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted((value as Record<string, unknown>)[k])]))
    : value;
const same = (a: unknown, b: unknown) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

function normalizeData(action: BotActionType, data: unknown): Record<string, unknown> {
  if (action === 'profile.upsert') return profileUpsert(data);
  if (action === 'profile.halt') return profileHalt(data);
  return signalPublish(data);
}

/**
 * Shape-validates a stored project command exactly as the write path built it. The host
 * Ledger calls this for `type: 'project.bot'` and otherwise ignores project events.
 * Non-normalized or extra fields fail closed.
 */
export function validateProjectCommand(raw: unknown): ProjectCommand {
  check(isProjectCommand(raw), 'not a project command');
  const c = raw as Record<string, unknown>;
  const keys = ['type', 'version', 'actor', 'requestId', 'digest', 'action', 'issuedAt', 'expiresAt', 'data'];
  check(Object.keys(c).every(k => keys.includes(k)), 'project command has unsupported fields');
  check(c.version === 1, 'project command version invalid');
  check(typeof c.action === 'string' && (BOT_ACTIONS as readonly string[]).includes(c.action), 'project action invalid');
  check(typeof c.digest === 'string' && /^0x[0-9a-f]{64}$/.test(c.digest), 'project digest invalid');
  check(Number.isSafeInteger(c.issuedAt) && Number.isSafeInteger(c.expiresAt)
    && (c.expiresAt as number) > (c.issuedAt as number) && (c.expiresAt as number) - (c.issuedAt as number) <= BOT_MAX_TTL_SECONDS, 'project timing invalid');
  const action = c.action as BotActionType;
  const command: ProjectCommand = {
    type: PROJECT_COMMAND, version: 1, actor: address(c.actor, 'actor'), requestId: uuid(c.requestId, 'requestId'),
    digest: c.digest as string, action, issuedAt: c.issuedAt as number, expiresAt: c.expiresAt as number,
    data: normalizeData(action, c.data),
  };
  check(command.actor === c.actor && command.requestId === c.requestId && same(command.data, c.data), 'project command is not normalized');
  return command;
}

export const emptyProjectState = (): ProjectState => ({ at: 0, writeTimes: [], profiles: new Map(), signals: [], requests: new Map() });

const clone = <T>(value: T): T => structuredClone(value);

/** Applies one validated command. The write path runs this before appending; replay re-runs it. */
export function applyProject(state: ProjectState, command: ProjectCommand, at: number): Omit<ExecuteResult, 'replayed'> {
  check(!state.requests.has(command.requestId), 'requestId already used', 'conflict');
  checkFresh(command.issuedAt, command.expiresAt, at);
  state.writeTimes = state.writeTimes.filter(time => time > at - 3_600_000);
  check(state.writeTimes.length < 500, 'hourly registry write limit reached', 'limit');
  const iso = new Date(at).toISOString();
  const { actor } = command;
  let result: Omit<ExecuteResult, 'replayed'>;
  if (command.action === 'signal.publish') {
    const data = command.data as ReturnType<typeof signalPublish>;
    const profile = state.profiles.get(data.profileId);
    check(profile, 'bot profile not found', 'not_found');
    check(profile.status === 'active', 'bot is halted; it cannot publish signals', 'halted');
    check(actor === profile.operator, 'only the registered operator can publish signals', 'forbidden');
    check(profile.assets.includes(data.asset), 'asset is not enabled for this bot');
    const since = at - 86_400_000;
    const recent = state.signals.filter(s => s.profileId === profile.id && Date.parse(s.createdAt) > since).length;
    check(recent < BOT_LIMITS.signalsPerProfilePerDay, 'daily signal limit reached', 'limit');
    const signal: BotSignal = { id: command.requestId, ...data, operator: actor, kind: 'proposal', createdAt: iso };
    state.signals.push(signal);
    result = { signal: clone(signal) };
  } else {
    const data = command.data as { profileId: string } & Partial<ReturnType<typeof profileUpsert>>;
    const existing = state.profiles.get(data.profileId);
    if (command.action === 'profile.halt') {
      check(existing, 'bot profile not found', 'not_found');
      check(actor === existing.owner, 'only the owner can halt this bot', 'forbidden');
      existing.status = 'halted';
      existing.updatedAt = iso;
      result = { profile: clone(existing) };
    } else {
      const fields = command.data as ReturnType<typeof profileUpsert>;
      const { profileId: _id, ...rest } = fields;
      if (existing) {
        check(actor === existing.owner, 'only the owner can edit this bot', 'forbidden');
        check(existing.status === 'active', 'halted bots cannot be edited; register a new bot', 'halted');
        Object.assign(existing, rest, { updatedAt: iso });
        result = { profile: clone(existing) };
      } else {
        check(fields.profileId === command.requestId, 'bot profile not found', 'not_found');
        const owned = [...state.profiles.values()].filter(p => p.owner === actor && p.status === 'active').length;
        check(owned < BOT_LIMITS.profilesPerOwner, `at most ${BOT_LIMITS.profilesPerOwner} bots per owner`, 'limit');
        check([...state.profiles.values()].filter(p => p.status === 'active').length < BOT_LIMITS.profilesTotal, 'bot registry is full', 'limit');
        const createdToday = [...state.profiles.values()].filter(p => p.owner === actor && Date.parse(p.createdAt) > at - 86_400_000).length;
        check(createdToday < 10, 'daily bot creation limit reached', 'limit');
        const profile: BotProfile = { id: fields.profileId, owner: actor, ...rest, status: 'active', createdAt: iso, updatedAt: iso };
        state.profiles.set(profile.id, profile);
        result = { profile: clone(profile) };
      }
    }
  }
  state.writeTimes.push(at);
  state.requests.set(command.requestId, { digest: command.digest, actor, result: clone(result) });
  state.at = Math.max(state.at, at);
  return result;
}

/** Folds project events out of the shared journal; core events are skipped. Fails closed. */
export function replayProject(events: readonly JournalEvent[]): ProjectState {
  const state = emptyProjectState();
  for (const event of events) {
    if (!isProjectCommand(event.command)) continue;
    try {
      applyProject(state, validateProjectCommand(event.command), event.at);
    } catch (cause) {
      throw new BotError('unavailable', `project journal invalid at revision ${event.revision}`, { cause });
    }
  }
  return state;
}

/** Event-sourced bot registry on the shared Arkiv journal. No cache, no SQL, no memory fallback. */
export class ProjectStore {
  

  constructor(private readonly journal: Journal, private readonly audience: string) {
    check(typeof audience === 'string' && audience.length > 0 && audience.length <= 200, 'audience is required');
  }

  private async snapshot(): Promise<{ snapshot: JournalSnapshot; state: ProjectState }> {
    let snapshot: JournalSnapshot;
    try { snapshot = await this.journal.read(); } catch (cause) {
      throw new BotError('unavailable', 'bot registry is unavailable', { cause });
    }
    return { snapshot, state: replayProject(snapshot.events) };
  }

  async list(): Promise<{ profiles: BotProfile[]; signals: BotSignal[] }> {
    const { state } = await this.snapshot();
    return { profiles: [...state.profiles.values()], signals: state.signals.slice(-BOT_LIMITS.listSignals).reverse() };
  }

  /** Verifies the wallet signature, then writes one event fenced by the journal nonce. */
  async execute(envelope: unknown): Promise<ExecuteResult> {
    const { payload, actor, digest } = await verifyBotAction(envelope, this.audience);
    if (!this.journal.canWrite) throw new BotError('read_only', 'bot commands are accepted by the worker only');
    const run = withJournalWrite(this.journal, async (): Promise<ExecuteResult> => {
      const { snapshot, state } = await this.snapshot();
      const requestId = payload.requestId.toLowerCase();
      const prior = state.requests.get(requestId);
      if (prior) {
        check(prior.digest === digest && prior.actor === actor, 'requestId was already used for a different action', 'conflict');
        return { ...clone(prior.result), replayed: true };
      }
      const data = payload.action === 'profile.upsert'
        ? { ...payload.data, profileId: (payload.data as { profileId?: unknown }).profileId ?? requestId } : payload.data;
      const command: ProjectCommand = { type: PROJECT_COMMAND, version: 1, actor, requestId, digest, action: payload.action,
        issuedAt: payload.issuedAt, expiresAt: payload.expiresAt, data: normalizeData(payload.action, data) };
      const at = Math.max(snapshot.timestampMs, state.at);
      const result = applyProject(state, command, at); // domain errors surface before any append
      try {
        await this.journal.append({ revision: snapshot.nonce + 1, id: randomUUID(), at, command }, snapshot.nonce);
      } catch (cause) {
        // Never auto-retry. Clients resend the same signed envelope; an exact replay returns the stored result.
        if (cause instanceof JournalError && cause.code === 'conflict') throw new BotError('conflict', 'another write landed first; resend the same signed action', { cause });
        if (cause instanceof JournalError && cause.code === 'invalid') throw new BotError('invalid', cause.message, { cause });
        throw new BotError(cause instanceof JournalError && cause.code === 'ambiguous' ? 'ambiguous' : 'unavailable',
          'bot registry write was not confirmed; resend the same signed action to reconcile', { cause });
      }
      return { ...result, replayed: false };
    });
    return run;
  }
}
