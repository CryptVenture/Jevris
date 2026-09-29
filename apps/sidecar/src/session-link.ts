/**
 * `session.link` and `session.unlink` (owner decision 29423b6; coordinator c065d52; B's security
 * conditions, agreed with D and E). A Kilo or OpenCode main session may be switched per turn only
 * while it is linked to its task. D's approvedScopeFor reads the link (`sessionLinkFor`); this
 * module makes and removes it.
 *
 * Both are admin ops (the CLI key only; never MCP or a hook). Linking widens what a turn may do,
 * and a model's shell can read the CLI key, so:
 * - `session.link` needs `channel: 'terminal'` (the CLI checks for an interactive terminal, as
 *   for a consent grant) and a clear kill switch. `replace` needs the same.
 * - The session comes from the sidecar's own records, never from the client: a named session must
 *   be a recorded, active session of that harness in this workspace, matched exactly. With no
 *   name, exactly one such session may have been seen in the last 10 minutes, and no session of
 *   another turn harness may have been; otherwise the answer is `ambiguous` with the candidates.
 *   With no harness, the turn harnesses (Kilo, OpenCode) are the ones meant.
 * - The task must exist and be leased or running.
 * - `session.unlink` only tightens, so it works from any CLI channel and while stopped.
 * - Every link and unlink is audited (`session.link`, `session.unlink`), and the answer always
 *   names the session, so a wrong guess is visible. A terminal link may say it came from a
 *   handoff import (`via: 'handoff'`, the same gate); `plan` links are made only by the
 *   sidecar's own paths, never through this op.
 */
import * as contracts from '@jevris/contracts';
import { HARNESS_IDS, TURN_HARNESSES, type SidecarOpContext, type SidecarOpDefinition, type SidecarOpOutcome } from '@jevris/contracts';
import type { OpenedStore } from '@jevris/store';
import { bodyRecord, ok, refuse } from './ops.js';

type StoreModule = typeof import('@jevris/store');

export const SESSION_LINK_OP_NAMES = ['session.link', 'session.unlink'] as const;

/** How recently a session must have been seen to be linked without naming it. */
export const SESSION_LINK_RECENT_MS = 10 * 60_000;
/** The most candidates an ambiguous answer lists. */
export const SESSION_LINK_MAX_CANDIDATES = 8;

const SESSION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const TASK = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/;
const KEYS_LINK = new Set(['taskId', 'harness', 'session', 'replace', 'channel', 'actor', 'via']);
/**
 * The provenance a person at the terminal may name: `route` (`jevris route --task --link`, the
 * default) or `handoff` (`jevris handoff import --link`). It is a label for status and explain
 * only; the gate is the same. `plan` is never taken from a client.
 */
const CLIENT_VIA: readonly string[] = ['route', 'handoff'];
const KEYS_UNLINK = new Set(['harness', 'session', 'channel', 'actor']);

export interface SessionLinkOpsDeps {
  readonly api: () => StoreModule | undefined;
  /** The task's state in D's ledger: `active` (leased or running), `inactive`, or `unknown`. */
  readonly taskState: (ctx: SidecarOpContext, taskId: string) => 'active' | 'inactive' | 'unknown';
  readonly nowMs?: () => number;
}

interface Candidate {
  readonly harness: string;
  readonly sessionId: string;
  readonly lastSeenAtMs: number;
}

type Resolved = { readonly kind: 'one'; readonly harness: string; readonly sessionId: string } | { readonly kind: 'ambiguous'; readonly candidates: readonly Candidate[] } | { readonly kind: 'refused'; readonly outcome: SidecarOpOutcome };

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checked(body: unknown): SidecarOpOutcome {
  const contract: unknown = Reflect.get(contracts, 'SessionLinkResultContract');
  const validate: unknown = plain(contract) ? Reflect.get(contract, 'validate') : undefined;
  if (typeof validate !== 'function') return ok(body);
  const result: unknown = validate.call(contract, body);
  return plain(result) && result['ok'] === true ? ok(body) : refuse('PAYLOAD_INVALID', 'The session link answer did not match its contract.');
}

/**
 * The session a request means, from the store only: a name matched exactly, or the one recent
 * session of that harness when no other recent turn-harness session could be meant.
 */
function resolveSession(store: OpenedStore, api: StoreModule, harness: string | undefined, named: string | undefined, nowMs: number): Resolved {
  const which = harness ?? 'turn-harness';
  if (named !== undefined) {
    const row = api.getSession(store, named);
    const fits = row !== undefined && (harness === undefined ? (TURN_HARNESSES as readonly string[]).includes(row.harness) : row.harness === harness);
    if (row === undefined || !fits) return { kind: 'refused', outcome: refuse('UNKNOWN_SESSION', `No ${which} session ${named} is recorded in this workspace.`) };
    if (row.state !== 'active') return { kind: 'refused', outcome: refuse('SESSION_ENDED', `The ${row.harness} session ${named} has ended.`) };
    return { kind: 'one', harness: row.harness, sessionId: named };
  }
  const recent = api.listActiveSessions(store, { sinceMs: Math.max(0, nowMs - SESSION_LINK_RECENT_MS) });
  if (!Array.isArray(recent)) return { kind: 'refused', outcome: refuse('STORE_UNAVAILABLE', 'The Jevris store could not be read.') };
  // Every recent session of a turn harness could be meant, and so could one of the named harness.
  const relevant = (recent as readonly Candidate[]).filter((s) => s.harness === harness || (TURN_HARNESSES as readonly string[]).includes(s.harness));
  const mine = relevant.filter((s) => harness === undefined || s.harness === harness);
  if (mine.length === 0) return { kind: 'refused', outcome: refuse('UNKNOWN_SESSION', `No active ${which} session was seen in this workspace in the last 10 minutes; name one with --session.`) };
  const only = mine[0];
  if (relevant.length === 1 && only !== undefined) return { kind: 'one', harness: only.harness, sessionId: only.sessionId };
  return { kind: 'ambiguous', candidates: relevant.slice(0, SESSION_LINK_MAX_CANDIDATES).map((s) => ({ harness: s.harness, sessionId: s.sessionId, lastSeenAtMs: s.lastSeenAtMs })) };
}

function actorOf(body: Record<string, unknown>): string {
  const actor = body['actor'];
  return typeof actor === 'string' && ACTOR.test(actor) ? actor : 'cli';
}

export function sessionLinkOps(deps: SessionLinkOpsDeps): SidecarOpDefinition[] {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const held = (ctx: SidecarOpContext): { readonly store: OpenedStore; readonly api: StoreModule } | undefined => {
    const api = deps.api();
    const store = ctx.store as OpenedStore | undefined;
    return api === undefined || store === undefined || store === null ? undefined : { store, api };
  };
  return [
    {
      op: 'session.link',
      scope: 'admin',
      budget: 'hot',
      handle(ctx) {
        const body = bodyRecord(ctx);
        if (Object.keys(body).some((key) => !KEYS_LINK.has(key))) return refuse('INVALID_REQUEST', 'send { taskId, harness?, session?, replace?, via?, channel }');
        if (body['channel'] !== 'terminal') return refuse('CHANNEL_REFUSED', 'Linking a session to a task needs an interactive terminal.');
        if (ctx.killSwitchStopped) return refuse('KILL_SWITCH_ACTIVE', 'The kill switch is on; no session can be linked.');
        const harness = body['harness'];
        const taskId = body['taskId'];
        const named = body['session'];
        const replace = body['replace'] ?? false;
        const via = body['via'] ?? 'route';
        if (typeof via !== 'string' || !CLIENT_VIA.includes(via)) return refuse('INVALID_REQUEST', "via must be 'route' or 'handoff'");
        if (harness !== undefined && (typeof harness !== 'string' || !(HARNESS_IDS as readonly string[]).includes(harness))) return refuse('INVALID_REQUEST', 'harness must be a harness id');
        if (typeof taskId !== 'string' || !TASK.test(taskId)) return refuse('INVALID_REQUEST', 'taskId must be a task id');
        if (named !== undefined && (typeof named !== 'string' || !SESSION.test(named))) return refuse('INVALID_REQUEST', 'session must be a session id');
        if (typeof replace !== 'boolean') return refuse('INVALID_REQUEST', 'replace must be true or false');
        const h = held(ctx);
        if (h === undefined) return refuse('STORE_UNAVAILABLE', 'The Jevris store is not open for this workspace.');
        const task = deps.taskState(ctx, taskId);
        if (task === 'unknown') return refuse('TASK_UNKNOWN', `No task ${taskId} in this workspace.`);
        if (task === 'inactive') return refuse('TASK_NOT_ACTIVE', `Task ${taskId} is not leased or running.`);
        const now = nowMs();
        const resolved = resolveSession(h.store, h.api, harness as string | undefined, named as string | undefined, now);
        if (resolved.kind === 'refused') return resolved.outcome;
        if (resolved.kind === 'ambiguous') return checked({ result: 'ambiguous', candidates: resolved.candidates });
        const linkedHarness = resolved.harness;
        const linked = h.api.linkSession(h.store, { sessionId: resolved.sessionId, harness: linkedHarness, taskId, via: via as 'route' | 'handoff', replace, actor: actorOf(body), channel: 'terminal', atMs: now });
        if (!linked.ok) {
          if ('refusal' in linked) {
            if (linked.refusal === 'session-already-linked') return refuse('SESSION_ALREADY_LINKED', `Session ${resolved.sessionId} is linked to another task; pass --replace to change it.`);
            if (linked.refusal === 'session-ended') return refuse('SESSION_ENDED', `The ${linkedHarness} session ${resolved.sessionId} has ended.`);
            return refuse('UNKNOWN_SESSION', `No ${linkedHarness} session ${resolved.sessionId} is recorded in this workspace.`);
          }
          return refuse('STORE_REFUSED', `The store refused the link (${linked.reason}).`);
        }
        return checked({ result: linked.result, harness: linkedHarness, sessionId: linked.link.sessionId, taskId: linked.link.taskId, lastSeenAtMs: linked.lastSeenAtMs, via: linked.link.via });
      },
    },
    {
      op: 'session.unlink',
      scope: 'admin',
      budget: 'hot',
      handle(ctx) {
        const body = bodyRecord(ctx);
        if (Object.keys(body).some((key) => !KEYS_UNLINK.has(key))) return refuse('INVALID_REQUEST', 'send { harness, session? }');
        const harness = body['harness'];
        const named = body['session'];
        if (harness !== undefined && (typeof harness !== 'string' || !(HARNESS_IDS as readonly string[]).includes(harness))) return refuse('INVALID_REQUEST', 'harness must be a harness id');
        if (named !== undefined && (typeof named !== 'string' || !SESSION.test(named))) return refuse('INVALID_REQUEST', 'session must be a session id');
        const h = held(ctx);
        if (h === undefined) return refuse('STORE_UNAVAILABLE', 'The Jevris store is not open for this workspace.');
        let sessionId: string;
        let unlinkedHarness: string;
        if (typeof named === 'string') {
          // Unlinking an ended session is fine (it only tightens): any recorded session of the harness.
          const row = h.api.getSession(h.store, named);
          if (row === undefined || (harness !== undefined && row.harness !== harness)) return refuse('UNKNOWN_SESSION', `No ${typeof harness === 'string' ? `${harness} ` : ''}session ${named} is recorded in this workspace.`);
          sessionId = named;
          unlinkedHarness = row.harness;
        } else {
          const resolved = resolveSession(h.store, h.api, harness as string | undefined, undefined, nowMs());
          if (resolved.kind === 'refused') return resolved.outcome;
          if (resolved.kind === 'ambiguous') return checked({ result: 'ambiguous', candidates: resolved.candidates });
          sessionId = resolved.sessionId;
          unlinkedHarness = resolved.harness;
        }
        const channel = body['channel'] === 'terminal' ? 'terminal' : 'cli';
        const removed = h.api.unlinkSession(h.store, { sessionId, actor: actorOf(body), channel, atMs: nowMs() });
        if (!removed.ok) return refuse('STORE_REFUSED', `The store refused the unlink (${removed.reason}).`);
        return checked({ result: removed.result, harness: unlinkedHarness, sessionId });
      },
    },
  ];
}
