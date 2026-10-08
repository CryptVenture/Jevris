/**
 * The decision engine's `event` subscriber (DEC-08, DEC-10, E's hook outcome convention).
 *
 * For each hook event the sidecar records, this subscriber:
 *   1. normalizes the harness event into a domain EventEnvelope and drops duplicate deliveries;
 *   2. runs the deterministic trigger filter (no call on reads, keystrokes or status renders);
 *   3. on a trigger, asks the handlers registered for it for proposals, within a bounded slice
 *      of the hot deadline (slow work goes to the background queue);
 *   4. answers `{ hookOutcome, certified }`, where the strongest proposal wins
 *      (route > context > explain > observe). `context` and `route` render only when a signed
 *      certification covers the harness, its installed version and the feature; otherwise they
 *      are downgraded to `explain` (a visible message that changes nothing) or `observe`.
 *      The effective mode narrows it too (`modeAllows`): below bounded-auto a route is explained,
 *      in observe the decisions are recorded and nothing is shown, and in off nothing runs.
 */
import {
  certificationCovers,
  modeAllows,
  type CertificationContext,
  type CertificationRecord,
  type HookOutcome,
  type NormalizedHarnessEvent,
  type OperatingSystem,
  type SidecarEventSubscriber,
  type SidecarOpContext,
} from '@jevris/contracts';
import { DecisionQueues, EventDeduper, TriggerFilter, UNKNOWN_SESSION_ID, WRITE_TOOL_NAMES, WorkspaceRevisions, noteSubagentRoute, toEventEnvelope, type DecisionEngine, type FailureHints, type FailureObservation, type TriggerKind } from '@jevris/core';
import type { EventEnvelope } from '@jevris/contracts';
import { engineOf } from './engine-of.js';
import { parseFailureFeatures } from './failure-advice.js';
import { PENDING_ADVICE, type PendingAdviceStore } from './pending-advice.js';

/**
 * Certification feature ids for model-visible outcomes (F's shared vocabulary; switch to the
 * contracts constant once it lands).
 */
export const ROUTE_FEATURE = 'hooks.route';
export const CONTEXT_FEATURE = 'hooks.context';

/**
 * The feature a proposal needs. A route always needs ROUTE_FEATURE, whatever the proposal names
 * (B's security review, LOW): a handler cannot certify its own route under another feature.
 * Otherwise the proposal's own feature, else the one its outcome kind implies.
 */
export function featureFor(proposal: Pick<HookProposal, 'hookOutcome' | 'featureId'>): string | null {
  if (proposal.hookOutcome.kind === 'route') return ROUTE_FEATURE;
  if (proposal.featureId !== undefined) return proposal.featureId;
  if (proposal.hookOutcome.kind === 'context') return CONTEXT_FEATURE;
  return null;
}

export interface HookProposal {
  readonly hookOutcome: HookOutcome;
  /** The certification feature a `context` or `route` outcome needs; defaults by outcome kind. */
  readonly featureId?: string;
  /** Text to show instead when the outcome is not certified. */
  readonly fallbackText?: string;
  /**
   * A `route` proposal only (owner decision 2026-10-08, "rewrite plus instruct"): the short note
   * addressed to the model, delivered as a `context` outcome when the route itself cannot be applied
   * (hooks.route uncertified, or a mode below bounded-auto) and `hooks.context` is certified; else the
   * `fallbackText` explain stands. Never in observe, where nothing is shown.
   */
  readonly fallbackContext?: string;
  readonly reasonCode: string;
  readonly decisionId?: string;
  /**
   * The proposal's consuming effect (for example, marking advice shown). The subscriber runs it
   * synchronously as its last step, only when this proposal gives the answer and the answer is
   * still wanted (`ctx.signal` not aborted), so a missed subscriber slice leaves the effect
   * unspent for the next event (US14; D 1608a3d). False means another delivery already spent it:
   * the answer falls back to observe.
   */
  readonly commit?: () => boolean;
}

export interface TriggerHandlerInput {
  readonly ctx: SidecarOpContext;
  readonly envelope: EventEnvelope;
  readonly event: NormalizedHarnessEvent;
  readonly trigger: TriggerKind;
  readonly engine: DecisionEngine | null;
  readonly queues: DecisionQueues;
  /**
   * DEC-12, US31: the workspace revision when this event arrived (the reported revision plus the
   * writes seen since), and the revision now. A decision that finishes after it moved is stale.
   */
  readonly revision?: string;
  readonly currentRevision?: () => string;
  /** Whether no newer event of the same trigger in this session has arrived since this one. */
  readonly stillUseful?: () => boolean;
  /**
   * What the trigger filter knows about a failure when the trigger is a failure one: how many times
   * it was seen in the session and how it compares with the previous one (counts and flags only).
   */
  readonly failure?: FailureObservation;
  /**
   * Whether a signed certification covers this event's harness, its installed version and this OS for
   * `featureId` now (the subscriber's own source, so a handler never reads a different one). Used by
   * the subagent route for the HARNESS_ALIAS proof (hooks.route certified). Absent: not certified.
   */
  readonly certified?: (featureId: string) => Promise<boolean>;
}

export type TriggerHandler = (input: TriggerHandlerInput) => Promise<HookProposal | null> | HookProposal | null;

/** Answers whether a signed certification covers this harness, version, OS, feature and time. */
export interface CertificationSource {
  covers(home: string, context: CertificationContext): Promise<CertificationAnswer>;
}

export interface CertificationAnswer {
  readonly certified: boolean;
  readonly reasonCode: string | null;
}

export interface SubscriberResult {
  readonly hookOutcome: HookOutcome;
  readonly certified: boolean;
  readonly trigger: TriggerKind | null;
  readonly reasonCode: string;
  readonly decisionIds: readonly string[];
}

const STRENGTH: Readonly<Record<HookOutcome['kind'], number>> = { observe: 0, explain: 1, context: 2, route: 3 };

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function harnessEvent(body: unknown): NormalizedHarnessEvent | null {
  const candidate = plain(body) && plain(body['envelope']) ? body['envelope'] : body;
  if (!plain(candidate)) return null;
  if (candidate['schemaVersion'] !== '1.0' || typeof candidate['kind'] !== 'string' || typeof candidate['harness'] !== 'string') return null;
  if (typeof candidate['nativeEventName'] !== 'string' || typeof candidate['dedupKey'] !== 'string') return null;
  if (!plain(candidate['payload'])) return null;
  return candidate as unknown as NormalizedHarnessEvent;
}

function observe(reasonCode: string, trigger: TriggerKind | null = null): SubscriberResult {
  return { hookOutcome: { kind: 'observe' }, certified: false, trigger, reasonCode, decisionIds: [] };
}

/** A source over already-loaded records, using the contracts rule `certificationCovers`. */
export function recordsCertificationSource(load: (home: string) => Promise<readonly CertificationRecord[]>): CertificationSource {
  return {
    async covers(home, context) {
      let records: readonly CertificationRecord[];
      try {
        records = await load(home);
      } catch {
        return { certified: false, reasonCode: 'CERTIFICATIONS_UNAVAILABLE' };
      }
      let reasonCode = 'NO_RECORD';
      for (const record of records) {
        const check = certificationCovers(record, context);
        if (check.ok) return { certified: true, reasonCode: null };
        if (record.harness === context.harness) reasonCode = check.reasonCode;
      }
      return { certified: false, reasonCode };
    },
  };
}

/**
 * Default: F's contract- and signature-checked records and its `coveringCertification` rule,
 * through `@jevris/cli/certifications`. The import is a string literal so the runtime bundle
 * includes it. Without the CLI, or on any error, nothing is certified.
 */
export const cliCertificationSource: CertificationSource = {
  async covers(home, context) {
    try {
      const mod = await import('@jevris/cli/certifications');
      if (typeof mod.loadCertifications !== 'function' || typeof mod.coveringCertification !== 'function') {
        return { certified: false, reasonCode: 'CERTIFICATIONS_UNAVAILABLE' };
      }
      const result = mod.coveringCertification(await mod.loadCertifications(home), context);
      return { certified: result.covered !== null && result.covered !== undefined, reasonCode: result.reasonCode };
    } catch {
      return { certified: false, reasonCode: 'CERTIFICATIONS_UNAVAILABLE' };
    }
  },
};

/**
 * What the sidecar's `event` op adds to the context of each subscriber it calls. A subscriber whose
 * answer takes something off a queue (a waiting advice line) calls `holdCommit` with that take instead
 * of running it. The sidecar runs it once every subscriber has answered, only when this subscriber's
 * answer is among what the launcher renders and its request is still wanted, and replaces the
 * answer with an `observe` when the take fails (the line was shown meanwhile). Otherwise the line
 * stays queued, with its expiry, for the session's next event. Absent in a direct call, where the
 * take runs at once, as before.
 */
export interface HoldsCommit {
  readonly holdCommit?: (commit: () => boolean) => void;
}

export interface SubscriberOptions {
  readonly handlers?: Partial<Record<TriggerKind, readonly TriggerHandler[]>>;
  readonly certifications?: CertificationSource;
  readonly queues?: DecisionQueues;
  readonly now?: () => number;
  readonly operatingSystem?: OperatingSystem;
  /** Installed harness version when the event body carries none (for example the host ledger). */
  readonly harnessVersionOf?: (home: string, harness: string) => string | null;
  /** DEC-12: the revision tracker; the registered subscriber shares core's WORKSPACE_REVISIONS. */
  readonly revisions?: WorkspaceRevisions;
  /** Where detached advice (repeated failure, new task) waits for the next event; the handlers share it. */
  readonly pending?: PendingAdviceStore;
}

/**
 * The events a waiting piece of detached advice may be handed to: a prompt, the tool events of the
 * turn and, for Antigravity (whose tool events show nothing), the start of an invocation. Never a
 * session start or end, a compaction or a model switch, whose answers other subscribers own. Each
 * harness shows an explain only on some of these (`showsExplain`); the rest leave the line queued.
 */
const DELIVERY_KINDS: ReadonlySet<string> = new Set(['task.requested', 'tool.proposed', 'tool.finished', 'tool.failed', 'invocation.started']);

/** Whether a signed record covers this harness, version, OS and feature now. Unknown version or OS: no. */
export async function isCertified(
  source: CertificationSource,
  home: string,
  input: { readonly harness: string; readonly harnessVersion: string | null; readonly operatingSystem: OperatingSystem | null; readonly featureId: string; readonly nowMs: number },
): Promise<CertificationAnswer> {
  if (input.harnessVersion === null) return { certified: false, reasonCode: 'HARNESS_VERSION_UNKNOWN' };
  if (input.operatingSystem === null) return { certified: false, reasonCode: 'OS_UNKNOWN' };
  try {
    return await source.covers(home, { harness: input.harness, harnessVersion: input.harnessVersion, operatingSystem: input.operatingSystem, featureId: input.featureId, nowMs: input.nowMs });
  } catch {
    return { certified: false, reasonCode: 'CERTIFICATIONS_UNAVAILABLE' };
  }
}

/** Tools whose completion changes the working tree (as the trigger filter counts them). */

export function createDecisionSubscriber(options: SubscriberOptions = {}): SidecarEventSubscriber & { readonly filter: TriggerFilter; readonly queues: DecisionQueues } {
  const filter = new TriggerFilter();
  const deduper = new EventDeduper();
  const queues = options.queues ?? new DecisionQueues();
  const certifications = options.certifications ?? cliCertificationSource;
  const now = options.now ?? (() => Date.now());
  const handlers = options.handlers ?? {};
  const pending = options.pending ?? PENDING_ADVICE;
  let sequence = 0;
  // DEC-12: the workspace revision as the sidecar sees it (shared with the ops when registered).
  const revisions = options.revisions ?? new WorkspaceRevisions();
  const latestTrigger = new Map<string, number>();
  const MAX_TRACKED = 1024;

  /**
   * The oldest waiting detached advice of this session as an `explain` proposal, or null. Only on an
   * event that can show it, in a mode that shows advice, while the answer is still wanted. Nothing
   * is taken until the proposal's commit runs, which the caller does only when this answer is used.
   */
  function deliveryProposal(ctx: SidecarOpContext, envelope: EventEnvelope, mode: NonNullable<SidecarOpContext['mode']>): HookProposal | null {
    if (!DELIVERY_KINDS.has(envelope.kind) || !modeAllows(mode, 'show-advice')) return null;
    // An event with no usable session id belongs to no session: it is given no one's waiting advice.
    if (envelope.sessionId === UNKNOWN_SESSION_ID) return null;
    // G2: the harness says whether it shows an answer on this event; where it does not, nothing is spent.
    if (plain(ctx.body) && ctx.body['showsExplain'] === false) return null;
    if ((ctx.signal as { readonly aborted?: boolean }).aborted === true) return null;
    const waiting = pending.peek(envelope.workspaceId, envelope.sessionId);
    if (waiting === null) return null;
    // A model-tier line (owner decisions 2026-10-08, step 3) is addressed to the model, as the subagent advice is: a context where
    // `hooks.context` is certified, else the same line as a message to the person (an explain, without the model-only note).
    const toModel = waiting.kind === 'model-tier';
    return {
      hookOutcome: toModel ? { kind: 'context', text: waiting.text } : { kind: 'explain', text: waiting.text },
      ...(toModel ? { fallbackText: waiting.personText ?? waiting.text } : {}),
      reasonCode: 'PENDING_ADVICE_DELIVERED',
      ...(waiting.decisionId === null ? {} : { decisionId: waiting.decisionId }),
      commit: () => pending.consume(envelope.workspaceId, envelope.sessionId, waiting),
    };
  }

  async function handle(ctx: SidecarOpContext): Promise<SubscriberResult> {
    if (ctx.killSwitchStopped) return observe('KILL_SWITCH');
    // The sidecar resolves the mode for every event; a direct call without one is not narrowed here.
    const mode = ctx.mode ?? 'bounded-auto';
    if (!modeAllows(mode, 'record')) return observe('MODE_OFF');
    const event = harnessEvent(ctx.body);
    if (event === null) return observe('NOT_A_HARNESS_EVENT');
    const body = plain(ctx.body) ? ctx.body : {};
    const nowMs = now();
    const revision = typeof body['revision'] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(body['revision']) ? body['revision'] : 'r0';
    const built = toEventEnvelope({
      event,
      workspaceId: ctx.workspace.id,
      sequence: (sequence += 1),
      occurredAt: new Date(nowMs).toISOString(),
      expectedRevision: revision,
      deadlineAt: new Date(nowMs + Math.max(1, ctx.deadline.remainingMs())).toISOString(),
      ...(typeof body['taskId'] === 'string' ? { taskId: body['taskId'] } : {}),
    });
    if (!built.ok) return observe(built.reasonCode);
    if (!deduper.accept(built.envelope)) return observe('DUPLICATE_DELIVERY');
    const written = built.envelope.kind === 'tool.finished' && WRITE_TOOL_NAMES.has(typeof event.toolName === 'string' ? event.toolName : '');
    revisions.observe(ctx.workspace.id, { revision: typeof body['revision'] === 'string' ? body['revision'] : null, wrote: written });
    // The adapter's content-free failure features, parsed strictly; the filter tells failures apart by them.
    const features = built.envelope.kind === 'tool.failed' ? parseFailureFeatures(body['failure']) : null;
    const hints: FailureHints = features === null ? {} : { signature: features.signature, commandDigest: features.commandDigest, shape: { exitClass: features.exitClass, environmental: features.environmental, elapsed: features.elapsed, present: features.present } };
    const classified = filter.classify(built.envelope, hints);
    const trigger: TriggerKind | null = classified.trigger;
    // Detached advice that finished since the last event is handed over now, when this event can show
    // it. Its commit takes it off the queue, and only when this answer is the one used.
    const delivery = deliveryProposal(ctx, built.envelope, mode);
    if (trigger === null && delivery === null) return observe(classified.reasonCode);
    const atRevision = revisions.current(ctx.workspace.id);
    const workspaceId = ctx.workspace.id;
    const currentRevision = (): string => revisions.current(workspaceId);
    let stillUseful = (): boolean => true;
    if (trigger !== null) {
      const triggerKey = `${ctx.workspace.id}\n${built.envelope.sessionId}\n${trigger}`;
      const mySequence = built.envelope.sequence;
      latestTrigger.delete(triggerKey);
      latestTrigger.set(triggerKey, mySequence);
      if (latestTrigger.size > MAX_TRACKED) {
        const first = latestTrigger.keys().next();
        if (first.done !== true) latestTrigger.delete(first.value);
      }
      stillUseful = (): boolean => (latestTrigger.get(triggerKey) ?? mySequence) === mySequence;
    }
    const list = trigger === null ? [] : (handlers[trigger] ?? []);
    if (trigger !== null && list.length === 0 && delivery === null) return observe('NO_HANDLER', trigger);
    const engine = engineOf(ctx);
    const proposals: HookProposal[] = [];
    const harnessVersion = typeof body['harnessVersion'] === 'string' ? body['harnessVersion'] : null;
    const platform = (globalThis as { process?: { platform?: string } }).process?.platform ?? '';
    const operatingSystem = options.operatingSystem ?? (['darwin', 'linux', 'win32'].includes(platform) ? (platform as OperatingSystem) : null);
    const certifiedHere = async (featureId: string): Promise<boolean> =>
      (await isCertified(certifications, ctx.home, { harness: event.harness, harnessVersion: harnessVersion ?? options.harnessVersionOf?.(ctx.home, event.harness) ?? null, operatingSystem, featureId, nowMs })).certified;
    if (trigger !== null) {
      for (const handler of list) {
        if (ctx.deadline.expired()) break;
        try {
          const proposal = await handler({ ctx, envelope: built.envelope, event, trigger, engine, queues, revision: atRevision, currentRevision, stillUseful, certified: certifiedHere, ...(classified.trigger !== null && classified.failure !== undefined ? { failure: classified.failure } : {}) });
          if (proposal !== null) proposals.push(proposal);
        } catch {
          // A failing handler never blocks the hook; it contributes nothing.
        }
      }
    }
    // Last, so that it never shadows a proposal of this event's own trigger: the first of equal strength wins.
    if (delivery !== null) proposals.push(delivery);
    let best: SubscriberResult = observe('NO_PROPOSAL', trigger);
    let winner: HookProposal | null = null;
    for (const proposal of proposals) {
      let outcome = proposal.hookOutcome;
      let certified = false;
      if (outcome.kind === 'context' || outcome.kind === 'route') {
        const featureId = featureFor(proposal);
        certified =
          featureId !== null &&
          (await isCertified(certifications, ctx.home, { harness: event.harness, harnessVersion: harnessVersion ?? options.harnessVersionOf?.(ctx.home, event.harness) ?? null, operatingSystem, featureId, nowMs })).certified;
        // Owner decision 0eb319de: a route is an actuation, so below bounded-auto it is explained
        // as advice, as an uncertified one is.
        if (!certified || (outcome.kind === 'route' && !modeAllows(mode, 'actuate'))) {
          const text = proposal.fallbackText ?? (outcome.kind === 'context' ? outcome.text : null);
          // Owner decision 2026-10-08: advice about a model for a subagent is addressed to the model
          // (a PreToolUse context), not shown only to the person, where hooks.context is certified.
          const modelNote = outcome.kind === 'route' && modeAllows(mode, 'show-advice') ? proposal.fallbackContext : undefined;
          const contextCertified = modelNote !== undefined && (await certifiedHere(CONTEXT_FEATURE));
          if (modelNote !== undefined && contextCertified) {
            outcome = { kind: 'context', text: modelNote };
            certified = true;
          } else outcome = text === null || text === undefined ? { kind: 'observe' } : { kind: 'explain', text };
        }
        // P13: a subagent route proposal is rendered when certified and the mode actuates, else explained (D's SubagentStart record).
        if (trigger === 'worker-creation' && proposal.hookOutcome.kind === 'route' && modeAllows(mode, 'show-advice')) {
          const subagentType = plain(event.payload) && typeof event.payload['subagentType'] === 'string' ? event.payload['subagentType'] : null;
          if (subagentType !== null) noteSubagentRoute({ workspaceId: ctx.workspace.id, sessionId: built.envelope.sessionId, subagentType, reasonCode: proposal.reasonCode, outcome: outcome.kind === 'route' ? 'rendered' : 'explained', atMs: nowMs });
        }
      }
      const candidate: SubscriberResult = {
        hookOutcome: outcome,
        certified,
        trigger,
        reasonCode: proposal.reasonCode,
        decisionIds: proposal.decisionId === undefined ? [] : [proposal.decisionId],
      };
      if (STRENGTH[candidate.hookOutcome.kind] > STRENGTH[best.hookOutcome.kind]) {
        best = { ...candidate, decisionIds: [...best.decisionIds, ...candidate.decisionIds] };
        winner = proposal;
      } else {
        best = { ...best, decisionIds: [...best.decisionIds, ...candidate.decisionIds] };
      }
    }
    // observe records the decisions above (the counterfactual) and shows nothing; nothing is spent.
    if (!modeAllows(mode, 'show-advice')) return observe('MODE_DOES_NOT_ADVISE', trigger);
    // The winning proposal's consuming effect, last and synchronously, only while its answer is
    // still wanted: nothing asynchronous follows, so a committed effect is one whose answer is used.
    if (winner?.commit !== undefined) {
      if ((ctx.signal as { readonly aborted?: boolean }).aborted === true) return observe('ANSWER_NOT_WANTED', trigger);
      // Run under the sidecar's event op, the take is handed over instead: the other subscribers answer on their own,
      // and the launcher renders only the strongest outcome among all of them (a certified context, such as the
      // orientation line, beats an explain), so whether this answer is the one shown is known only when every
      // subscriber has answered. The sidecar takes the line then, or leaves it held for the next event.
      const hold = (ctx as SidecarOpContext & HoldsCommit).holdCommit;
      if (hold !== undefined) hold(winner.commit);
      else if (!winner.commit()) return observe('ALREADY_SHOWN', trigger);
    }
    return best;
  }

  return { name: 'decision-engine', handle, filter, queues };
}
