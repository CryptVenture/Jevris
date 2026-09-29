/**
 * Access limits seen in interactive sessions (R71; design `.planning/research/access-limits.md`
 * sections 6.1 and 9.1).
 *
 * - A failed turn (`turn.failed`, and `worker.failed` for a child session) whose payload carries
 *   an access signal is classified here, in the sidecar, and recorded with `source: 'session'`
 *   under the scope of the model that failed. A child session's limit is recorded under its own
 *   model. A `turn.stopped` that carries a signal (Antigravity's Stop on an error) is a failed turn
 *   too. The session's model is the one SessionStart or a finished message named, or the one a
 *   made switch (`model.changed`, PostModelSwitch) moved to; a requested switch never moves it.
 * - An Antigravity Stop is a success when it has no `errored` flag (F fac99271): Antigravity sends no
 *   prompt event, so a clean stop after the stop that ended a failed turn is a later turn's.
 * - A success clears the scope: a Kilo or OpenCode assistant message that finished with no error
 *   (its fixed `errored` flag is not true), or a Claude Code `Stop`. An errored message with no
 *   signal is neither: it records nothing and clears nothing.
 * - A success never clears a pause its own turn recorded: once a session's turn has failed (a
 *   failed kind or an errored message), no success of that session clears anything until its next
 *   turn starts (`task.requested`). The background writes run one at a time in event order, so a
 *   clear queued before a failure never lands after it.
 *
 * All of it runs in the background, never on the hook's answer path. The sign-in of an
 * interactive session is not known here, so it is recorded and cleared as `unknown`, which matches
 * both sign-ins (design 4.1: fail toward pausing). Nothing of the signal is kept but the row id,
 * the class and the times.
 */
import { HARNESS_IDS, type HarnessId } from '@jevris/contracts';
import { BUNDLED_MODEL_REGISTRY, accessScopeOf, classifyAccessSignal, loadModelRegistry, recordAccessLimit, recordAccessSuccess } from '@jevris/core';
import { accessCertified, limitCooldownHoursOf, wireSignalOf } from '../orchestration/access-limits.js';

/** What the subscriber passes: the envelope's fields this module reads. */
export interface SessionAccessEvent {
  readonly harness: string;
  readonly kind: string;
  readonly sessionId: string | null;
  readonly agentId: string | null;
  readonly model: string | null;
  readonly payload: { readonly [key: string]: unknown };
}

/** Where the event came from, for its trust and timing (OP-4, OP-11). */
export interface SessionAccessContext {
  /** The workspace whose learning setting `limitCooldownHours` times a pause with no reported reset. */
  readonly workspaceId?: string;
  /** The harness version the session forwarded (its hook payload), else the installed one is used. */
  readonly harnessVersion?: string | null;
}

/** A model spelling as a hook payload carries it (bounded; ids only). */
const MODEL_SPELLING = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;
/** Kinds that end a turn on an error (design 6.1). */
const FAILED_KINDS: ReadonlySet<string> = new Set(['turn.failed', 'worker.failed']);
/** Harnesses whose finished assistant message names its model and says whether it failed (Kilo, OpenCode). */
const MESSAGE_HARNESSES: ReadonlySet<string> = new Set(['kilocode', 'opencode']);

const writes = new Set<Promise<unknown>>();
/** The background writes run in event order, one at a time. */
let chain: Promise<unknown> = Promise.resolve();
/** The model each session (or child session) last reported, so a failure that names none is scoped. */
const lastModel = new Map<string, string>();
const LAST_MODEL_MAX = 256;
/** A success clears a scope at most once in this window (a read of the record each time otherwise). */
const recentSuccess = new Map<string, number>();
const SUCCESS_EVERY_MS = 10_000;
/** When each session's current turn started, and when a turn of it last failed. */
const turnStartedAt = new Map<string, number>();
const turnFailedAt = new Map<string, number>();
/** When a stop last ended each session's turn (Antigravity has no prompt event to start one). */
const turnStoppedAt = new Map<string, number>();

const sessionKey = (e: SessionAccessEvent): string => `${e.harness}|${e.sessionId ?? '-'}|${e.agentId ?? '-'}`;

function remember(map: Map<string, string | number>, key: string, value: string | number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > LAST_MODEL_MAX) map.delete(map.keys().next().value as string);
}

function inBackground(work: () => Promise<unknown>): void {
  const run = chain.then(work).catch(() => false);
  chain = run;
  writes.add(run);
  void run.finally(() => writes.delete(run));
}

/** Waits for the background session access writes (tests and orderly shutdown). */
export async function drainSessionAccess(): Promise<void> {
  while (writes.size > 0) await Promise.allSettled([...writes]);
}

/**
 * Notes one hook event (R71). Returns what it did, for the subscriber's trace: `ACCESS_QUEUED`
 * (a limit is being recorded), `ACCESS_SUCCESS_QUEUED` (a success is clearing its scope), or null.
 */
export function noteSessionAccess(home: string, event: SessionAccessEvent, nowMs: number, context: SessionAccessContext = {}): 'ACCESS_QUEUED' | 'ACCESS_SUCCESS_QUEUED' | null {
  if (!(HARNESS_IDS as readonly string[]).includes(event.harness)) return null;
  const harness = event.harness as HarnessId;
  const key = sessionKey(event);
  if (event.model !== null && (event.kind === 'session.started' || event.kind === 'message.completed')) remember(lastModel as Map<string, string | number>, key, event.model);
  // A switch the harness made (Claude Code's PostModelSwitch): the session's scope moves to the new
  // model. Never the requested switch (`model.change.requested`, PreModelSwitch): it can be refused.
  const switched = event.kind === 'model.changed' ? event.payload['toModel'] : undefined;
  if (typeof switched === 'string' && MODEL_SPELLING.test(switched)) remember(lastModel as Map<string, string | number>, key, switched);
  if (event.kind === 'task.requested') {
    remember(turnStartedAt as Map<string, string | number>, key, nowMs);
    return null;
  }
  const signal = wireSignalOf(event.payload['accessSignal']);
  // The adapters' fixed flag for a turn that ended on an error: a failed Kilo or OpenCode assistant
  // message (F c511bae9), and an Antigravity Stop with terminationReason "error" (F fac99271).
  const errored = (event.kind === 'message.completed' || event.kind === 'turn.stopped') && event.payload['errored'] === true;
  // A stop that carries a signal (Antigravity's Stop with terminationReason "error", F's launcher)
  // is a failed turn: recorded like turn.failed, and never a success.
  const failed = FAILED_KINDS.has(event.kind) || ((event.kind === 'message.completed' || event.kind === 'turn.stopped') && (signal !== null || errored));
  // The stop that ended this session's previous turn, read before this stop replaces it.
  const priorStop = turnStoppedAt.get(key);
  if (event.kind === 'turn.stopped') remember(turnStoppedAt as Map<string, string | number>, key, nowMs);
  if (failed) {
    remember(turnFailedAt as Map<string, string | number>, key, nowMs);
    const model = event.model ?? lastModel.get(key) ?? null;
    if (signal === null || model === null) return null;
    inBackground(
      async () => {
        const registry = (await loadModelRegistry({ home }).catch(() => null)) ?? BUNDLED_MODEL_REGISTRY;
        const scope = accessScopeOf(registry, harness, model, 'unknown');
        // OP-4: the session channel is trusted only when the harness's signed record certifies
        // access.session (F's K19, K20) at the session's version; uncertified, a text-only credit or
        // blocked signal is held as a timed pause.
        const certified = await accessCertified({ home, harness, featureId: 'access.session', nowMs, ...(context.harnessVersion === undefined ? {} : { harnessVersion: context.harnessVersion }) });
        // OP-11: a pause with no reported reset is timed from the workspace's limitCooldownHours.
        const baseHours = await limitCooldownHoursOf(home, context.workspaceId);
        const classification = classifyAccessSignal({ ...signal, certified }, 'unknown', nowMs, baseHours === undefined ? {} : { baseHours });
        if (scope === null || classification === null) return false;
        return recordAccessLimit({ home, scope, classification, source: 'session', nowMs, ...(baseHours === undefined ? {} : { baseHours }) });
      },
    );
    return 'ACCESS_QUEUED';
  }
  const success =
    (event.kind === 'message.completed' && MESSAGE_HARNESSES.has(harness)) ||
    (event.kind === 'turn.stopped' && (harness === 'claude' || harness === 'antigravity') && event.agentId === null);
  if (!success) return null;
  const failedAt = turnFailedAt.get(key);
  const startedAt = turnStartedAt.get(key);
  // An Antigravity stop ends its turn, and Antigravity sends no prompt event: a clean stop after the
  // stop that ended a failed turn belongs to a later turn.
  const failedTurnOver = harness === 'antigravity' && priorStop !== undefined && failedAt !== undefined && priorStop >= failedAt;
  if (failedAt !== undefined && (startedAt === undefined || failedAt >= startedAt) && !failedTurnOver) return null;
  const model = event.model ?? lastModel.get(key) ?? null;
  if (model === null) return null;
  const successKey = `${home}|${harness}|${model}`;
  const last = recentSuccess.get(successKey);
  if (last !== undefined && nowMs - last >= 0 && nowMs - last < SUCCESS_EVERY_MS) return null;
  remember(recentSuccess as Map<string, string | number>, successKey, nowMs);
  inBackground(async () => {
    const registry = (await loadModelRegistry({ home }).catch(() => null)) ?? BUNDLED_MODEL_REGISTRY;
    const scope = accessScopeOf(registry, harness, model, 'unknown');
    return scope === null ? false : recordAccessSuccess(home, scope, nowMs);
  });
  return 'ACCESS_SUCCESS_QUEUED';
}
