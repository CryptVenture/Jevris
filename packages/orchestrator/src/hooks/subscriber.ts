/**
 * The orchestrator's sidecar event subscriber (hook outcome convention, HKR-01).
 *
 * The launcher forwards each normalized harness event to the sidecar `event` op; every
 * subscriber answers `{ hookOutcome, certified }`. This one:
 * - records loop signals from `tool.finished` and `tool.failed` (ORC-11) and, the first time a
 *   loop is recognised, proposes an `explain` with the bounded recovery advice;
 * - writes a capsule on `context.compacting` (PreCompact: only session id, transcript path and
 *   trigger are known; the transcript is never read) and queues its mandatory items for one
 *   restore (MEM-02, MEM-06);
 * - on `session.started` after a compaction or a resume, proposes the rehydrated capsule as
 *   `context`, exactly once per capsule and session, and only when a signed certification
 *   record covers the harness, its installed version and the `hooks.context` feature
 *   (MEM-09). Uncertified, it answers `observe` and leaves the restore pending;
 * - on `turn.stopped` (Stop), reads the completion verdict from the store for the session's
 *   task (else the workspace) and runs the stop continuation (VER-05): one reminder per task
 *   and unchanged missing-evidence condition, none while `stop_hook_active`, then an explicit
 *   unverified report. It is proposed as `explain` (shown to the person), and a reminder also
 *   carries `stopContinuation` for a launcher that can continue a certified stop;
 * - on `worker.started` and `worker.finished` (SubagentStart, SubagentStop), records the
 *   subagent's type, times and ids in the background (P13) and answers `observe`;
 * - answers `observe` for a duplicate delivery and for everything else.
 * Nothing here allows, denies or asks on a tool call.
 */
import { HARNESS_IDS, type HarnessId, type PendingCheckState, type SidecarEventSubscriber, type SidecarOpContext } from '@jevris/contracts';
import { BUNDLED_MODEL_REGISTRY, loadModelRegistry, recordModelRun } from '@jevris/core';
import { resolveRunSpelling } from '../orchestration/model-spelling.js';
import { noteSessionAccess } from './session-access.js';
import type { WorkspaceServices } from '../workspace.js';
import { openWorkspace } from '../workspace.js';
import { assessLoop, recordSignals, signalsFrom } from '../orchestration/loops.js';
import { latestCapsule, writeCapsule } from '../memory/capsule.js';
import { commitRestore, queueRestore, restoreState } from '../memory/audit.js';
import { rehydrate } from '../memory/rehydrate.js';
import { noteRestoreFailure, noteRestoreReask, noteRestoreVerified, recordRestore, restoreInBackground } from '../memory/restore-outcomes.js';
import { learnSubagentOutcomes, noteSubagentModel, noteSubagentParentVerified, noteSubagentStart, noteSubagentStop, subagentInBackground, type SubagentVerdict } from '../orchestration/subagent-runs.js';
import { CONTEXT_FEATURE, isCertified } from './certification.js';
import { orientationFor, startsFreshSession } from './orientation.js';
import { approvedScopeFor, linkPlannedSession } from '../orchestration/approved-scope.js';
import { getTask } from '../orchestration/tasks.js';
import { taskWorkspace } from '../orchestration/workers.js';
import { approvedManifests, verificationStatus } from '../verify/service.js';
import { decideStop } from '../verify/completion.js';
import { orderIsInformed, orderMissingEvidence, rankForStop } from '../verify/relevance.js';
import { pendingChecks, verificationRunKey } from '../verify/runs.js';
import { queueMissingChecksAtStop } from './stop-autoverify.js';
import { readEffectiveConfig } from '../settings/config.js';
import { isId, isPlain, own, recordKey, sha256 } from '../util.js';
import type { GitPort } from '../verify/revision.js';

export type HookOutcomeResult =
  | { readonly hookOutcome: { readonly kind: 'observe' }; readonly certified: boolean; readonly reasonCode: string }
  | {
      readonly hookOutcome: { readonly kind: 'context' | 'explain'; readonly text: string };
      readonly certified: boolean;
      readonly reasonCode: string;
      /**
       * Stop only: the one reminder that asks the agent to continue and produce the evidence.
       * `certified` is the hooks.context certification for this harness and version (the launcher
       * continues only a certified stop); `missingEvidence` holds check ids only, so a launcher can
       * build its reason text without any workspace text. `pending` names the missing checks a
       * background verification run is still producing (RUNNING) or will next (QUEUED), so the
       * reason can say they are running instead of asking for them again.
       */
      readonly stopContinuation?: {
        readonly text: string;
        readonly certified: boolean;
        readonly missingEvidence: readonly string[];
        readonly pending?: { readonly [checkId: string]: PendingCheckState };
      };
    };

const observe = (reasonCode: string, certified = false): HookOutcomeResult => ({ hookOutcome: { kind: 'observe' }, certified, reasonCode });

/**
 * Whether the sidecar will still use this subscriber's answer: its `signal` aborts with the
 * request and when the subscriber's slice ends (B's state.ts). A consuming effect (a restore
 * taken, a reminder spent, an explanation marked shown) is committed only while this holds, in
 * the answer's last transaction with nothing asynchronous after it, so it happens exactly when
 * the answer is used (US14). A missed slice leaves it for the next event.
 *
 * G2: the launcher says whether the harness shows an answer on this event (`showsExplain`,
 * F's showsExplainOn). Where it does not (Kilo and OpenCode outside compaction, Antigravity
 * today), nothing is consumed either: the restore, reminder or explanation waits for an event
 * that shows it. A body without the field (an older launcher) is treated as showing it.
 * `shownAnyway` is for a Stop whose reminder reaches the agent as the harness's own
 * continuation rather than as displayed text (Antigravity's Stop `continue`, G6).
 */
function answerWanted(ctx: SidecarOpContext, shownAnyway = false): () => boolean {
  const hidden = !shownAnyway && isPlain(ctx.body) && own(ctx.body, 'showsExplain') === false;
  return () => !hidden && (ctx.signal as { readonly aborted?: boolean }).aborted !== true;
}

/** The harnesses whose Stop continues the agent with the reminder (docs/verification.md §5). */
const STOP_CONTINUATION_HARNESSES: ReadonlySet<string> = new Set(['claude', 'codex', 'antigravity']);

interface Envelope {
  readonly harness: string;
  readonly kind: string;
  readonly sessionId: string | null;
  /** The subagent's id on a subagent's event (the parent session is `sessionId`). */
  readonly agentId: string | null;
  /** The model the harness reports for the session, when it does (Claude Code's SessionStart). */
  readonly model: string | null;
  readonly toolName: string | null;
  readonly trigger: string | null;
  readonly cwd: string | null;
  readonly payload: { readonly [k: string]: unknown };
}

function envelopeOf(body: unknown): { readonly envelope: Envelope; readonly deliveryKey: string } | null {
  if (!isPlain(body)) return null;
  const env = own(body, 'envelope');
  if (!isPlain(env)) return null;
  const kind = own(env, 'kind');
  const harness = own(env, 'harness');
  if (typeof kind !== 'string' || typeof harness !== 'string') return null;
  const str = (k: string) => {
    const v = own(env, k);
    return typeof v === 'string' && v.length <= 4096 ? v : null;
  };
  const payload = own(env, 'payload');
  const key = own(body, 'deliveryKey');
  const dedup = own(env, 'dedupKey');
  const deliveryKey = typeof key === 'string' && key.length > 0 ? key : typeof dedup === 'string' ? dedup : sha256(JSON.stringify(env));
  return {
    envelope: { harness, kind, sessionId: str('sessionId'), agentId: str('agentId'), model: str('model'), toolName: str('toolName'), trigger: str('trigger'), cwd: str('cwd'), payload: isPlain(payload) ? payload : {} },
    deliveryKey,
  };
}

/** Test seam: git port for capsule assembly in tests. */
let gitPort: GitPort | undefined;
export function setSubscriberGit(git: GitPort | undefined): void {
  gitPort = git;
}

function workspaceFor(ctx: SidecarOpContext): WorkspaceServices | undefined {
  if (ctx.workspace.root === null) return undefined;
  return openWorkspace({ home: ctx.home, workspaceRoot: ctx.workspace.root, ...(isId(ctx.workspace.id) ? { workspaceId: ctx.workspace.id } : {}), store: ctx.store });
}

/**
 * How long a delivery key marks a repeat as a redelivery. A harness retries a hook within
 * seconds; a later event with the same key is a new event (a second compaction of one session
 * carries no turn id, so its key can repeat), and it is handled, not dropped.
 */
export const DELIVERY_DEDUP_WINDOW_MS = 5 * 60_000;
/** At most this many delivery keys are remembered in this process; the oldest are dropped first. */
export const DELIVERY_RECORDS_MAX = 2048;

/** Test seam: the subscriber's clock. */
let clock: () => number = () => Date.now();
export function setSubscriberClock(now: (() => number) | undefined): void {
  clock = now ?? (() => Date.now());
}

/** Delivery keys seen in this process, in time order (a key seen again is deleted and set anew). */
const seenDeliveries = new Map<string, number>();

/**
 * First delivery wins within the dedup window; a repeat inside it is a duplicate. In memory only
 * (sidecar concurrency audit P1, owner decision DOMAINS ededdba): the sidecar already dedups every
 * delivery durably in the store's event table before any subscriber runs, so this is only a guard
 * for a direct caller, and it costs no ledger transaction or fsync on the hook path. Keys expire
 * with the window and at most DELIVERY_RECORDS_MAX are kept.
 */
export function firstDelivery(workspaceId: string, deliveryKey: string, nowMs: number): boolean {
  for (const [key, atMs] of seenDeliveries) {
    if (nowMs >= atMs && nowMs - atMs < DELIVERY_DEDUP_WINDOW_MS) break;
    seenDeliveries.delete(key);
  }
  const key = recordKey(workspaceId, sha256(deliveryKey).slice(0, 32));
  const prior = seenDeliveries.get(key);
  if (prior !== undefined && nowMs >= prior && nowMs - prior < DELIVERY_DEDUP_WINDOW_MS) return false;
  seenDeliveries.delete(key);
  seenDeliveries.set(key, nowMs);
  while (seenDeliveries.size > DELIVERY_RECORDS_MAX) {
    const first = seenDeliveries.keys().next();
    if (first.done === true) break;
    seenDeliveries.delete(first.value);
  }
  return true;
}

/** Delivery keys remembered now (tests: the bound). */
export function deliveryRecordCount(): number {
  return seenDeliveries.size;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * The identity a failed call carries (a one-way digest of its input, from the adapter), or null for
 * an event from a launcher that sends only names and sizes. The event holds no command text, so the
 * label can say only which tool and which input: two failures with the same digest are the same call.
 */
function failureIdentityOf(env: Envelope): { readonly key: string; readonly label: string } | null {
  const digest = env.payload['toolInputDigest'];
  if (typeof digest !== 'string' || !/^[0-9a-f]{16}$/.test(digest)) return null;
  const name = env.toolName ?? '';
  const tool = /^[A-Za-z0-9_.:-]{1,64}$/.test(name) ? name : 'tool';
  return { key: `${tool}\n${digest}`, label: `${tool} call ${digest.slice(0, 8)} (same input each time)` };
}

async function onTool(ctx: SidecarOpContext, ws: WorkspaceServices, env: Envelope, nowMs: number): Promise<HookOutcomeResult> {
  const failed = env.kind === 'tool.failed';
  const keys = Array.isArray(env.payload['toolInputKeys']) ? (env.payload['toolInputKeys'] as unknown[]).filter((k) => typeof k === 'string').join(',') : '';
  // The normalized event carries sizes and names only, never output. A failed call also carries a
  // one-way digest of its input: two failures are the same approach only when the digests match.
  // Without a digest (an older launcher) the tool, its input shape and sizes are all there is, and
  // those repeat for unrelated calls, so no rejected approach is kept from them.
  const shape = `${env.toolName ?? 'tool'}(${keys}) in=${String(num(env.payload['toolInputBytes']))} out=${String(num(env.payload['toolResponseBytes']))}`;
  const identity = failed ? failureIdentityOf(env) : null;
  const signals = signalsFrom(ws.workspaceId, { taskId: null, atMs: nowMs, command: `${env.toolName ?? 'tool'}(${keys}) in=${String(num(env.payload['toolInputBytes']))}`, failed, output: failed ? `error: ${shape}` : shape, diffHash: null, ...(identity === null ? {} : { identity }) });
  await recordSignals(ws, signals);
  if (!failed) return observe('SIGNAL_RECORDED');
  // P9: a failure after a restore, and whether its family was seen before it (hashes only; in the background).
  restoreInBackground(noteRestoreFailure(ws, env.sessionId, signals.find((s) => s.kind === 'diagnostic')?.hash ?? null));
  const assessment = await assessLoop(ws, { taskId: null, nowMs });
  if (!['repeated-failure', 'environment-failure', 'patch-oscillation'].includes(assessment.classification)) return observe('SIGNAL_RECORDED');
  const key = recordKey(ws.workspaceId, assessment.classification, sha256(identity?.key ?? shape).slice(0, 16));
  // Marked shown only when this answer is used; a missed slice explains it at the next failure.
  const wanted = answerWanted(ctx);
  const first = await ws.hook.transact((tx) => {
    if (tx.get<number>('loop-explained', key) !== undefined) return 'shown';
    if (!wanted()) return 'not-wanted';
    tx.put('loop-explained', key, nowMs);
    return 'first';
  });
  if (first === 'shown') return observe('ALREADY_EXPLAINED');
  if (first === 'not-wanted') return observe('ANSWER_NOT_WANTED');
  // `explain` only shows advice; it changes nothing, so it needs no certification.
  return { hookOutcome: { kind: 'explain', text: `Jevris: ${assessment.advice}` }, certified: false, reasonCode: `LOOP_${assessment.classification.toUpperCase().replace(/-/g, '_')}` };
}

/**
 * G3: the harnesses whose compaction hook adds the answer's context to the compaction itself
 * (the Kilo and OpenCode plugins' `experimental.session.compacting` appends `output.context`).
 * They send no SessionStart after a compaction, so the restore goes out here.
 */
const COMPACTION_CONTEXT_HARNESSES: ReadonlySet<string> = new Set(['kilocode', 'opencode']);

async function onCompacting(ctx: SidecarOpContext, ws: WorkspaceServices, env: Envelope, nowMs: number): Promise<HookOutcomeResult> {
  const capsule = await writeCapsule(ws, { taskId: null, nowMs, ...(gitPort === undefined ? {} : { git: gitPort }) });
  if (env.sessionId !== null) {
    await queueRestore(ws, capsule.id, env.sessionId, capsule.items.filter((i) => i.mandatory).map((i) => i.id), nowMs);
  }
  // Claude's PreCompact cannot add context, and native compaction is never deferred without a
  // certified signal. Kilo and OpenCode take the capsule as compaction context (G3).
  if (env.sessionId === null || !COMPACTION_CONTEXT_HARNESSES.has(env.harness)) return observe('CAPSULE_WRITTEN');
  const delivered = await deliverRestore(ctx, ws, env, env.sessionId, capsule, nowMs);
  return delivered.reasonCode === 'CAPSULE_RESTORED' ? delivered : { ...delivered, reasonCode: `CAPSULE_WRITTEN_${delivered.reasonCode}`.slice(0, 64) };
}

const sessionModelWrites = new Set<Promise<unknown>>();
/** `harness|model` recorded lately, so a model seen on every message is written once in a while. */
const recentSessionModels = new Map<string, number>();
const SESSION_MODEL_REWRITE_MS = 10 * 60_000;

/**
 * Owner decision c065d52 (RAN_HERE) and routing design R12: a model a harness here reports running
 * is local evidence that the harness runs that provider's model, the evidence a Claude Code
 * subscription user is signed in by after their first observed session. Two reports count:
 * - a main session's model on session.started (Claude Code, Codex); a subagent's is not the
 *   session's, and is not recorded;
 * - the model that answered, on message.completed (Kilo and OpenCode name it on each assistant
 *   message, in a main session or a child one).
 * The harness's id is resolved to its registry model and serving host (R42, `resolveRunSpelling`:
 * `[1m]` and a maker's provider segments resolve) and recorded in C's model offer with the raw
 * spelling, as reported, under an unknown sign-in, in the background,
 * never on the hook's answer path, at most once per harness and model every 10 minutes. An
 * unknown harness and an id no registry model matches are not recorded.
 */
function noteSessionModel(ctx: SidecarOpContext, env: Envelope, nowMs: number): void {
  if (env.model === null || !(HARNESS_IDS as readonly string[]).includes(env.harness)) return;
  if (env.kind === 'session.started' && env.agentId !== null) return;
  if (env.kind !== 'session.started' && env.kind !== 'message.completed') return;
  const key = `${ctx.home}|${env.harness}|${env.model}`;
  const last = recentSessionModels.get(key);
  if (last !== undefined && nowMs - last >= 0 && nowMs - last < SESSION_MODEL_REWRITE_MS) return;
  recentSessionModels.set(key, nowMs);
  if (recentSessionModels.size > 256) recentSessionModels.delete(recentSessionModels.keys().next().value as string);
  const harness = env.harness as HarnessId;
  const reported = env.model;
  const write = (async () => {
    const registry = (await loadModelRegistry({ home: ctx.home }).catch(() => null)) ?? BUNDLED_MODEL_REGISTRY;
    const run = resolveRunSpelling(registry, harness, reported);
    if (run === null) return false;
    return recordModelRun(ctx.home, { harness, authMode: 'unknown', modelId: run.modelId, nowMs, raw: run.raw, servingHost: run.servingHost, source: 'reported' });
  })().catch(() => false);
  sessionModelWrites.add(write);
  void write.finally(() => sessionModelWrites.delete(write));
}

/** Waits for the background session-model records (tests and orderly shutdown). */
export async function drainSessionModels(): Promise<void> {
  while (sessionModelWrites.size > 0) await Promise.allSettled([...sessionModelWrites]);
}

async function onSessionStart(ctx: SidecarOpContext, ws: WorkspaceServices, env: Envelope, nowMs: number): Promise<HookOutcomeResult> {
  if (startsFreshSession(env.trigger)) {
    // A fresh session gets the one orientation line; a compaction or resume gets the capsule below.
    const line = await orientationFor(ctx, env, nowMs);
    return line.kind === 'context' ? { hookOutcome: { kind: 'context', text: line.text }, certified: true, reasonCode: 'ORIENTATION' } : observe(line.reasonCode);
  }
  if (env.sessionId === null) return observe('NO_SESSION');
  const capsule = latestCapsule(ws, null);
  if (capsule === undefined) return observe('NO_CAPSULE');
  if (restoreState(ws, capsule.id, env.sessionId) === 'taken') {
    // P9: the session asks again after its restore went out.
    restoreInBackground(noteRestoreReask(ws, env.sessionId, capsule.id));
    return observe('ALREADY_RESTORED');
  }
  return deliverRestore(ctx, ws, env, env.sessionId, capsule, nowMs);
}

/**
 * The capsule's restore for a session, as `context`: only where a signed certification record
 * covers the harness's `hooks.context` (MEM-09), exactly once per capsule and session, and taken
 * only while the sidecar still wants the answer and the harness shows it (US14, G2).
 */
async function deliverRestore(ctx: SidecarOpContext, ws: WorkspaceServices, env: Envelope, sessionId: string, capsule: NonNullable<ReturnType<typeof latestCapsule>>, nowMs: number): Promise<HookOutcomeResult> {
  // P9: how the restore went, recorded in the background so nothing asynchronous follows the take (US14).
  const note = (reasonCode: string, delivered: boolean, rehydration?: Awaited<ReturnType<typeof rehydrate>>): void => {
    restoreInBackground(recordRestore(ws, { sessionId, capsule, reasonCode, delivered, nowMs, ...(rehydration === undefined ? {} : { rehydration }) }));
  };
  const harness = env.harness as Parameters<typeof isCertified>[0]['harness'];
  const forwarded = isPlain(ctx.body) ? own(ctx.body, 'harnessVersion') : undefined;
  const cert = await isCertified({ home: ctx.home, harness, featureId: CONTEXT_FEATURE, nowMs, ...(typeof forwarded === 'string' ? { harnessVersion: forwarded } : {}) });
  if (!cert.certified) {
    note(cert.reasonCode ?? 'NOT_CERTIFIED', false);
    return observe(cert.reasonCode ?? 'NOT_CERTIFIED');
  }
  await queueRestore(ws, capsule.id, sessionId, capsule.items.filter((i) => i.mandatory).map((i) => i.id), nowMs);
  if (restoreState(ws, capsule.id, sessionId) !== 'pending') return observe('ALREADY_RESTORED', true);
  // The context is built first; the restore is taken last, and only while the sidecar still
  // wants this answer. A missed slice leaves it pending for the next SessionStart (US14).
  const restored = await rehydrate(ws, { taskId: null, capsuleId: capsule.id, nowMs, ...(gitPort === undefined ? {} : { git: gitPort }), remainingMs: ctx.deadline.remainingMs() });
  if (restored.additionalContext === null) {
    note('NO_CAPSULE', false, restored);
    return observe('NO_CAPSULE', true);
  }
  const taken = await commitRestore(ws, capsule, sessionId, answerWanted(ctx));
  if (taken.state === 'not-wanted') {
    note('ANSWER_NOT_WANTED', false, restored);
    return observe('ANSWER_NOT_WANTED', true);
  }
  if (taken.state !== 'taken') return observe('ALREADY_RESTORED', true);
  note('CAPSULE_RESTORED', true, restored);
  return { hookOutcome: { kind: 'context', text: restored.additionalContext }, certified: true, reasonCode: 'CAPSULE_RESTORED' };
}

/**
 * The parent's verdict from its mandatory checks' receipts: a pass when every mandatory check has a
 * current passing receipt, a fail when one has a failing receipt; otherwise none (missing or stale
 * evidence is no verdict).
 */
function subagentVerdict(completion: { readonly verified: boolean; readonly checks: readonly { readonly mandatory: boolean; readonly status: string; readonly receiptId: string | null }[] }): SubagentVerdict | null {
  const mandatory = completion.checks.filter((c) => c.mandatory);
  const failed = mandatory.find((c) => c.status === 'failed' && c.receiptId !== null);
  if (failed !== undefined) return { kind: 'verified-fail', receiptId: failed.receiptId as string };
  const passed = mandatory.find((c) => c.status === 'passed' && c.receiptId !== null);
  return completion.verified && passed !== undefined ? { kind: 'verified-pass', receiptId: passed.receiptId as string } : null;
}

/** Bound for a stop reminder or report, in characters. */
export const STOP_TEXT_CHARS = 1_000;

async function onStop(ctx: SidecarOpContext, ws: WorkspaceServices, env: Envelope, nowMs: number): Promise<HookOutcomeResult> {
  // Nothing to verify against: no approved checks, no continuation.
  if (approvedManifests(ws).length === 0) return observe('NO_CHECKS');
  const scope = approvedScopeFor(ws, env.sessionId);
  const task = scope === null ? undefined : getTask(ws, scope.taskId);
  const target = task === undefined ? ws : taskWorkspace(ws, task.node.id);
  // Asked up front (it never throws), so its read overlaps the evidence work: the whole Stop
  // answer has to fit the sidecar's subscriber slice.
  const forwarded = isPlain(ctx.body) ? own(ctx.body, 'harnessVersion') : undefined;
  const certification = isCertified({ home: ctx.home, harness: env.harness as Parameters<typeof isCertified>[0]['harness'], featureId: CONTEXT_FEATURE, nowMs, ...(typeof forwarded === 'string' ? { harnessVersion: forwarded } : {}) });
  const ids = approvedManifests(ws).map((m) => m.id);
  const pendingNow = (): Map<string, PendingCheckState> => new Map([...pendingChecks(ws.workspaceId, ids), ...(task === undefined ? [] : pendingChecks(verificationRunKey(ws.workspaceId, task.node.id), ids))]);
  let pending = pendingNow();
  const completion = await verificationStatus(target, {
    taskId: task?.node.id ?? null,
    checkIds: [],
    ...(task === undefined ? {} : { acceptanceCheckIds: task.node.acceptanceCheckIds, requirementIds: task.node.requirementIds }),
    ...(ws.store === undefined ? {} : { store: ws.store }),
  });
  // `verification.backgroundAtStop` (off by default): a main-session Stop queues the missing approved
  // checks in the background and goes on; the answer below then says they are running.
  // Check ranking (owner decision 2026-10-01): with two or more checks missing, they are named, and
  // any background run starts them, most relevant first. Advice about order only: every check is
  // still named and still needed, and the reminder is spent for the same condition (`conditionKey`
  // is read before this, from the checks as they are).
  const ranking = await rankForStop(ctx, ws, { completion, root: target.workspaceRoot, taskId: task?.node.id ?? null, sessionId: env.sessionId, ...(gitPort === undefined ? {} : { git: gitPort }) });
  if (ranking !== null) ctx.trace({ event: 'orchestrator.checks-ranked', reasonCode: ranking.reasonCode, checks: ranking.order.length, source: ranking.source, ...(ranking.decisionId === null ? {} : { decisionId: ranking.decisionId }) });
  const ordered = ranking === null ? completion : { ...completion, missingEvidence: orderMissingEvidence(completion.missingEvidence, ranking.order) };
  const queued = await queueMissingChecksAtStop({ ctx, ws, agentId: env.agentId, taskScoped: task !== undefined, completion, ...(ranking === null ? {} : { order: ranking.order }), ...(gitPort === undefined ? {} : { git: gitPort }) });
  if (queued.queued.length > 0) pending = pendingNow();
  // Everything asynchronous comes before decideStop: its transaction spends the one reminder
  // only while the sidecar still wants this answer, and nothing waits after it (US14, US23).
  const cert = await certification;
  const report = await decideStop({
    workspaceId: ws.workspaceId,
    taskId: task?.node.id ?? null,
    completion: ordered,
    ...(ranking === null || !orderIsInformed(ranking) ? {} : { orderNote: ranking.text }),
    stopHookActive: env.payload['stopHookActive'] === true,
    // Stop reminders and reports are hook-path records (P2): no directory lock on the Stop answer.
    state: ws.hook,
    nowMs,
    maxContinuations: readEffectiveConfig({ home: ctx.home, workspaceRoot: ws.workspaceRoot }).config.orchestration.maxStopContinuationsPerCondition,
    // A check a background run is producing is not asked for again (US23): the stop says it is running.
    pending,
    answerWanted: answerWanted(ctx, STOP_CONTINUATION_HARNESSES.has(env.harness)),
  });
  // R20: a verdict from a mandatory check's receipt labels the session's stopped subagents (in the background).
  const verdict = subagentVerdict(completion);
  if (verdict !== null) subagentInBackground(learnSubagentOutcomes(ws, { harness: env.harness, sessionId: env.sessionId, taskId: task?.node.id ?? null, risk: scope?.risk ?? 'unknown', verdict, nowMs }));
  if (report.outcome === 'verified') {
    // P9: the session verified after its restore (in the background).
    restoreInBackground(noteRestoreVerified(ws, env.sessionId, nowMs));
    // P13: the session's stopped subagents are marked as followed by a verified Stop.
    subagentInBackground(noteSubagentParentVerified(ws, env.harness, env.sessionId, nowMs));
    return observe('VERIFIED');
  }
  const text = report.text.slice(0, STOP_TEXT_CHARS);
  // A reminder the sidecar will not deliver was not spent; the next stop gets it.
  if (report.outcome === 'remind' && !report.continuationScheduled) return observe('ANSWER_NOT_WANTED');
  if (report.outcome === 'remind') {
    // Check ids only (a missing-evidence entry is `<checkId>:<status>`; check ids carry no ':').
    const missingEvidence = [...new Set(report.missingEvidence.map((m) => m.split(':')[0] ?? m).filter((id) => isId(id)))].slice(0, 32);
    // The missing checks a background run is producing, so the Stop block can say so (US23).
    const running: Record<string, PendingCheckState> = {};
    for (const id of missingEvidence) {
      const state = pending.get(id);
      if (state !== undefined) running[id] = state;
    }
    const stopContinuation = { text, certified: cert.certified, missingEvidence, ...(Object.keys(running).length === 0 ? {} : { pending: running }) };
    return { hookOutcome: { kind: 'explain', text }, certified: false, reasonCode: 'STOP_REMINDER', stopContinuation };
  }
  return { hookOutcome: { kind: 'explain', text }, certified: false, reasonCode: 'STOP_UNVERIFIED' };
}

/**
 * P13: a subagent's start and stop (every harness's `worker.started` and `worker.finished`) are
 * recorded as timing only (harness, type, times, ids), off the answer path. Nothing is proposed and nothing feeds learning.
 */
function onSubagent(ws: WorkspaceServices, env: Envelope, nowMs: number): HookOutcomeResult {
  const input = { harness: env.harness, sessionId: env.sessionId, agentId: env.agentId, agentType: env.payload['agentType'], nowMs };
  subagentInBackground(env.kind === 'worker.started' ? noteSubagentStart(ws, input) : noteSubagentStop(ws, input));
  return observe('SUBAGENT_RECORDED');
}

/**
 * G4, G5 (routing design R31): the harnesses that show an answer only on some events: Kilo and
 * OpenCode on a person's message (the system prompt of that turn) and at compaction, Antigravity
 * before each invocation (an ephemeral message). An answer due on an event they do not show is
 * queued for the session and goes out on its next event that shows one.
 */
const DEFERRED_DISPLAY_HARNESSES: ReadonlySet<string> = new Set(['kilocode', 'opencode', 'antigravity']);
const DISPLAY_QUEUE = 'display-queue';
/** At most this many queued answers per session; the oldest go first. */
export const DISPLAY_QUEUE_MAX = 4;
/** A queued answer older than this is dropped rather than shown. */
export const DISPLAY_QUEUE_TTL_MS = 60 * 60_000;
/** Bound for the text of one flushed answer (one context line in the Kilo and OpenCode shims). */
export const DISPLAY_TEXT_CHARS = 7_500;

interface QueuedDisplay {
  readonly sessionId: string;
  readonly kind: 'context' | 'explain';
  readonly text: string;
  readonly certified: boolean;
  readonly reasonCode: string;
  readonly atMs: number;
}

function hiddenHere(ctx: SidecarOpContext): boolean {
  return isPlain(ctx.body) && own(ctx.body, 'showsExplain') === false;
}

function queuedFor(ws: WorkspaceServices, sessionId: string, nowMs: number): readonly (readonly [string, QueuedDisplay])[] {
  return ws.hook
    .list<QueuedDisplay>(DISPLAY_QUEUE)
    .map((q) => [displayKey(ws, q.sessionId, q.atMs, q.reasonCode), q] as const)
    .filter(([, q]) => q.sessionId === sessionId && nowMs - q.atMs <= DISPLAY_QUEUE_TTL_MS)
    .sort((a, b) => a[1].atMs - b[1].atMs);
}

function displayKey(ws: WorkspaceServices, sessionId: string, atMs: number, reasonCode: string): string {
  return recordKey(ws.workspaceId, sha256(`${sessionId}\n${String(atMs)}\n${reasonCode}`).slice(0, 32));
}

/** Queues an answer the harness does not show on this event (G4, G5); keeps the newest few per session. */
async function queueDisplay(ws: WorkspaceServices, sessionId: string, result: HookOutcomeResult, nowMs: number): Promise<void> {
  if (result.hookOutcome.kind === 'observe') return;
  const item: QueuedDisplay = { sessionId, kind: result.hookOutcome.kind, text: result.hookOutcome.text.slice(0, DISPLAY_TEXT_CHARS), certified: result.certified, reasonCode: result.reasonCode.slice(0, 64), atMs: nowMs };
  await ws.hook.transact((tx) => {
    const all = tx.list<QueuedDisplay>(DISPLAY_QUEUE);
    // Expired answers of any session go (a session that never showed one again).
    for (const old of all.filter((q) => nowMs - q.atMs > DISPLAY_QUEUE_TTL_MS)) tx.delete(DISPLAY_QUEUE, displayKey(ws, old.sessionId, old.atMs, old.reasonCode));
    const mine = all.filter((q) => q.sessionId === sessionId && nowMs - q.atMs <= DISPLAY_QUEUE_TTL_MS).sort((a, b) => a.atMs - b.atMs);
    for (const old of mine.slice(0, Math.max(0, mine.length - (DISPLAY_QUEUE_MAX - 1)))) tx.delete(DISPLAY_QUEUE, displayKey(ws, old.sessionId, old.atMs, old.reasonCode));
    tx.put(DISPLAY_QUEUE, displayKey(ws, sessionId, nowMs, item.reasonCode), item);
  });
}

/**
 * The session's queued answers as one, taken only while the sidecar still wants this answer
 * (US14). Queued restores (context) go first, on their own, so an uncertified explanation never
 * holds back a certified restore; the explanations follow on the next showing event.
 */
async function flushDisplay(ctx: SidecarOpContext, ws: WorkspaceServices, sessionId: string, nowMs: number): Promise<HookOutcomeResult | null> {
  const all = queuedFor(ws, sessionId, nowMs);
  const contexts = all.filter(([, q]) => q.kind === 'context');
  const queued = contexts.length > 0 ? contexts : all;
  if (queued.length === 0) return null;
  const wanted = answerWanted(ctx);
  const taken = await ws.hook.transact((tx) => {
    if (!wanted()) return false;
    for (const [key] of queued) tx.delete(DISPLAY_QUEUE, key);
    return true;
  });
  if (!taken) return observe('ANSWER_NOT_WANTED');
  const items = queued.map(([, q]) => q);
  const text = items.map((q) => q.text).join('\n\n').slice(0, DISPLAY_TEXT_CHARS);
  return { hookOutcome: { kind: contexts.length > 0 ? 'context' : 'explain', text }, certified: items.every((q) => q.certified), reasonCode: 'DISPLAY_FLUSHED' };
}

export async function handleHookEvent(ctx: SidecarOpContext): Promise<HookOutcomeResult> {
  const parsed = envelopeOf(ctx.body);
  if (parsed === null) return observe('NO_ENVELOPE');
  const ws = workspaceFor(ctx);
  if (ws === undefined) return observe('NO_WORKSPACE');
  const nowMs = clock();
  if (!firstDelivery(ws.workspaceId, parsed.deliveryKey, nowMs)) return observe('DUPLICATE_DELIVERY');
  const env = parsed.envelope;
  const deferred = env.sessionId !== null && DEFERRED_DISPLAY_HARNESSES.has(env.harness);
  if (!deferred) return handleEnvelope(ctx, ws, env, nowMs);
  const sessionId = env.sessionId as string;
  if (hiddenHere(ctx)) {
    // Produced as if shown (so it is taken once), then held for the session's next showing event.
    const shown = { ...ctx, body: { ...(ctx.body as object), showsExplain: true } };
    const result = await handleEnvelope(shown, ws, env, nowMs);
    // A Stop reminder that continues the agent itself (Antigravity, G6) is not shown again.
    if (result.hookOutcome.kind === 'observe' || 'stopContinuation' in result) return result;
    try {
      await queueDisplay(ws, sessionId, result, nowMs);
    } catch {
      ctx.trace({ event: 'orchestrator.subscriber-failed', reasonCode: 'DISPLAY_QUEUE_FAILED' });
      return observe('DISPLAY_QUEUE_FAILED', result.certified);
    }
    return observe('DISPLAY_QUEUED', result.certified);
  }
  const result = await handleEnvelope(ctx, ws, env, nowMs);
  if (result.hookOutcome.kind !== 'observe') return result;
  try {
    return (await flushDisplay(ctx, ws, sessionId, nowMs)) ?? result;
  } catch {
    return result;
  }
}

async function handleEnvelope(ctx: SidecarOpContext, ws: WorkspaceServices, env: Envelope, nowMs: number): Promise<HookOutcomeResult> {
  try {
    // Owner decision 29423b6: the first event of a Kilo or OpenCode session an owned worker
    // started links it to its task (via plan); a map lookup for any other event.
    const planned = linkPlannedSession(ws, env, nowMs);
    if (planned !== null) ctx.trace({ event: 'orchestrator.plan-link', reasonCode: planned });
    // R71: an access limit a session's turn failed on is recorded, and a success clears its
    // scope, in the background.
    const forwardedVersion = isPlain(ctx.body) ? own(ctx.body, 'harnessVersion') : undefined;
    const access = noteSessionAccess(ctx.home, env, nowMs, { workspaceId: ws.workspaceId, ...(typeof forwardedVersion === 'string' ? { harnessVersion: forwardedVersion } : {}) });
    switch (env.kind) {
      case 'tool.finished':
      case 'tool.failed':
        return await onTool(ctx, ws, env, nowMs);
      case 'context.compacting':
        return await onCompacting(ctx, ws, env, nowMs);
      case 'session.started':
        noteSessionModel(ctx, env, nowMs);
        return await onSessionStart(ctx, ws, env, nowMs);
      case 'turn.stopped':
        return await onStop(ctx, ws, env, nowMs);
      case 'worker.started':
      case 'worker.finished':
        return onSubagent(ws, env, nowMs);
      case 'message.completed':
        noteSessionModel(ctx, env, nowMs);
        // R20: a Kilo or OpenCode child names the model it ran; kept on its subagent run.
        if (env.agentId !== null) subagentInBackground(noteSubagentModel(ws, { harness: env.harness, sessionId: env.sessionId, agentId: env.agentId, model: env.model, nowMs }));
        return observe('NOT_SUBSCRIBED');
      case 'turn.failed':
      case 'worker.failed':
        return observe(access ?? 'NO_ACCESS_SIGNAL');
      default:
        return observe('NOT_SUBSCRIBED');
    }
  } catch {
    ctx.trace({ event: 'orchestrator.subscriber-failed', reasonCode: 'SUBSCRIBER_FAILED' });
    return observe('SUBSCRIBER_FAILED');
  }
}

export const orchestratorSubscriber: SidecarEventSubscriber = { name: 'orchestrator', handle: handleHookEvent };
