/**
 * The orchestration ops the sidecar registers from `@jevris/orchestrator` (IPC op registry).
 *
 * Every handler parses its request body as untrusted input and returns a result body that
 * validates against E's surface payload contract (`surfacePayloadContract(op)`). A body that
 * would not validate is never sent: the handler answers `PAYLOAD_INVALID` instead, so a surface
 * never renders an unchecked shape.
 *
 * Ops are added here as each capability lands; `SURFACE_OP_OF` names the payload contract each
 * op answers with.
 */
import {
  ID_PATTERN,
  base64Decode,
  surfacePayloadContract,
  type SidecarOpContext,
  type SidecarOpDefinition,
  type SidecarOpOutcome,
  type SidecarEventSubscriber,
  type SurfaceOperation,
} from '@jevris/contracts';
import type { OpenStoreResult } from '@jevris/store';
import { openWorkspace, type WorkspaceServices } from './workspace.js';
import { approvedManifests, runVerification, stopReportFor, verificationStatus } from './verify/service.js';
import { refreshFreshness, type CompletionReport } from './verify/completion.js';
import { outputRecordOf } from './memory/distill.js';
import { recordEvidenceRead } from './memory/evidence-usage.js';
import { detectIntegrationRevertsInBackground } from './orchestration/integration-reverts.js';
import { receiptScopeOf } from './verify/receipt-scope.js';
import type { RunnerReceipt } from './verify/receipts.js';
import { pendingChecks, scheduleVerification, verificationRunKey, type PendingCheckReason } from './verify/runs.js';
import { completeTask, taskWorkspace } from './orchestration/workers.js';
import { getTask } from './orchestration/tasks.js';
import { isId, isPlain, own, recordKey, redactSecrets, type Rec } from './util.js';
import { continueOwnedWork, engineNow, handOffFirstTry, taskOps } from './ops/task-ops.js';
import { integrationOps } from './ops/integration-ops.js';
import { budgetOps } from './ops/budget-ops.js';
import { controlOps } from './ops/control-ops.js';
import { importCiBundle, requiredCheckReport, type RequiredCheckLine } from './verify/ci-import.js';
import { MEMORY_SURFACE_OPS, memoryOps } from './ops/memory-ops.js';
import { orchestratorSubscriber } from './hooks/subscriber.js';
import { capabilityOps } from './ops/capability-ops.js';

const CONTRACT_ID = new RegExp(ID_PATTERN);
const MAX_EVIDENCE_TEXT = 60_000;
/** What a long text keeps at each end (JEV-0025); two of them and the marker stay under the contract's 65,536. */
const EVIDENCE_KEEP_EACH_END = 28_000;
const EVIDENCE_SNAP_CHARS = 200;
const EVIDENCE_CONTRACT_MAX = 65_000;

/**
 * The surface payload contract each op answers with. Ops without a surface contract yet
 * (`LOCAL_PAYLOAD_OPS`) build their body from validated values only.
 */
export const LOCAL_PAYLOAD_OPS: readonly string[] = ['verify.import-ci', 'verify.required', 'plan.submit', 'task.reconcile', 'capability.advise', 'integration.run', 'integration.get', 'integration.approve', 'budget.get', 'budget.update', 'task.revert-duplicate', 'control.status', 'control.migrate', 'learning.report'];

/** The surface payload contract each op answers with. */
export const SURFACE_OP_OF: { readonly [op: string]: SurfaceOperation } = {
  verify: 'verify',
  'verify.status': 'verify',
  'evidence.get': 'evidence.get',
  'verification.record': 'verification.record',
  'task.get': 'task.get',
  'task.submit': 'task.submit',
  'task.complete': 'task.get',
  'task.cancel': 'task.get',
  ...MEMORY_SURFACE_OPS,
};

type Outcome = SidecarOpOutcome;

function fail(reasonCode: string, message?: string): Outcome {
  return message === undefined ? { ok: false, reasonCode } : { ok: false, reasonCode, message: message.slice(0, 300) };
}

/** Validates a result body against its surface contract before it leaves the sidecar. */
export function respond(ctx: Pick<SidecarOpContext, 'op' | 'trace'>, surface: SurfaceOperation, body: unknown): Outcome {
  const checked = surfacePayloadContract(surface).validate(body);
  if (!checked.ok) {
    ctx.trace({ event: 'orchestrator.payload-invalid', reasonCode: 'PAYLOAD_INVALID', op: ctx.op, path: checked.issues[0]?.path ?? '' });
    return fail('PAYLOAD_INVALID', `the ${ctx.op} result did not match its contract`);
  }
  return { ok: true, body: checked.value };
}

function workspaceOf(ctx: SidecarOpContext): WorkspaceServices | undefined {
  if (ctx.workspace.root === null) return undefined;
  return openWorkspace({
    home: ctx.home,
    workspaceRoot: ctx.workspace.root,
    ...(isId(ctx.workspace.id) ? { workspaceId: ctx.workspace.id } : {}),
    store: ctx.store,
  });
}

function storeOf(ctx: SidecarOpContext): OpenStoreResult | undefined {
  const s = ctx.store;
  return isPlain(s) && own(s, 'ok') === true ? (s as unknown as OpenStoreResult) : undefined;
}

function bodyOf(ctx: SidecarOpContext): Rec | undefined {
  return isPlain(ctx.body) ? ctx.body : undefined;
}

function nullableId(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return isId(value) ? value : undefined;
}

function checkIdsOf(value: unknown): readonly string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 512) return undefined;
  return value.every((v) => typeof v === 'string' && CONTRACT_ID.test(v)) ? (value as string[]) : undefined;
}

// --------------------------------------------------------------------------------- verify

/** A contract reason code for a check that did not pass (from the receipt's outcome reason). */
function checkReasonCode(status: CompletionReport['checks'][number]['status'], reason: string | null): string | null {
  if (status === 'passed') return null;
  if (status === 'missing') return 'NO_RECEIPT';
  if (status === 'stale') return 'STALE';
  if (reason === null) return null;
  const head = reason.split(':')[0] ?? '';
  if (head === 'exit') return 'EXIT_NONZERO';
  const code = head.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : null;
}

/** The last unverified stop report (VER-05), only while the work is still not verified. */
function stopReportView(ws: WorkspaceServices, taskId: string | null, report: Pick<CompletionReport, 'verified'>) {
  if (report.verified) return null;
  const stop = stopReportFor(ws, taskId);
  if (stop === undefined || stop.outcome !== 'unverified') return null;
  return {
    outcome: 'unverified' as const,
    text: stop.text.slice(0, 1000),
    at: stop.at,
    // Evidence entries read `<check id>:<status>`; the payload names the check.
    missingEvidence: [...new Set(stop.missingEvidence.map((e) => e.split(':')[0] ?? ''))].filter((id) => CONTRACT_ID.test(id)).slice(0, 512),
    uncoveredRequirements: stop.uncoveredRequirements.filter((id) => CONTRACT_ID.test(id)).slice(0, 512),
  };
}

/**
 * The workspace's last unverified stop report for the status op (VER-05, US23), cheaply: the
 * stored report plus a receipt-only check. It is dropped once every check it named has a
 * current passing receipt. Null when there is none.
 */
export function statusStopReport(ws: WorkspaceServices): ReturnType<typeof stopReportView> {
  const stop = stopReportFor(ws, null);
  if (stop === undefined || stop.outcome !== 'unverified') return null;
  const missing = [...new Set(stop.missingEvidence.map((e) => e.split(':')[0] ?? ''))].filter((id) => CONTRACT_ID.test(id));
  const latest = ws.receipts.latest(ws.workspaceId, null);
  const settled = missing.length > 0 && missing.every((id) => {
    const row = latest.get(id);
    return row !== undefined && row.validity === 'current' && row.receipt.outcome === 'passed';
  });
  if (settled) return null;
  return {
    outcome: 'unverified' as const,
    text: stop.text.slice(0, 1000),
    at: stop.at,
    missingEvidence: missing.slice(0, 512),
    uncoveredRequirements: stop.uncoveredRequirements.filter((id) => CONTRACT_ID.test(id)).slice(0, 512),
  };
}


/** At most this many failing test ids per check in a verify answer; `failedTestCount` has the total. */
export const VERIFY_FAILED_TESTS_MAX = 20;
const EVIDENCE_HANDLE = /^ev:[0-9a-f]{64}$/;

/**
 * Why a check's receipt did not pass, for a person: the failing test ids and names the runner
 * parsed (bounded, secret-redacted, never message or output text) and the evidence handle that
 * `jevris evidence get` prints. Only for a failed or unknown receipt.
 */
export function failureOf(receipt: RunnerReceipt): { failure?: { failedTests: { id: string; name: string }[]; failedTestCount: number; evidenceHandle: string | null } } {
  if (receipt.outcome !== 'failed' && receipt.outcome !== 'unknown') return {};
  const results = receipt.results;
  const failedTests = (results?.failures ?? []).slice(0, VERIFY_FAILED_TESTS_MAX).map((f) => ({
    id: redactSecrets(f.id).slice(0, 128),
    name: redactSecrets(f.name).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 200),
  }));
  const handle = receipt.rawOutputHandle;
  return {
    failure: {
      failedTests,
      failedTestCount: Math.max(results?.failed ?? 0, failedTests.length),
      evidenceHandle: handle !== null && EVIDENCE_HANDLE.test(handle) ? handle : null,
    },
  };
}

/**
 * The verify answer as its contract accepts it: the per-check `failure` detail is kept only once
 * the verify payload contract names it, so the answer never becomes PAYLOAD_INVALID over it.
 */
export function verifyAnswer(payload: ReturnType<typeof verifyPayload>): unknown {
  if (surfacePayloadContract('verify').validate(payload).ok) return payload;
  return { ...payload, checks: payload.checks.map(({ failure: _failure, ...check }) => check) };
}

export function verifyPayload(
  ws: WorkspaceServices,
  report: Pick<CompletionReport, 'checks' | 'verified'>,
  ran: boolean,
  stop: ReturnType<typeof stopReportView> = null,
  pending: ReadonlyMap<string, PendingCheckReason> = new Map(),
) {
  const approved = approvedManifests(ws);
  const hardwareOf = new Map(approved.map((m) => [m.id, m.hardware]));
  const needs = new Map<string, string>();
  const checks = report.checks
    .filter((c) => CONTRACT_ID.test(c.checkId))
    .slice(0, 512)
    .map((c) => {
      const row = c.receiptId === null ? undefined : ws.receipts.get(ws.workspaceId, c.receiptId);
      const outcome = c.status === 'missing' ? 'not-run' : c.status === 'stale' ? (row?.receipt.outcome ?? 'unknown') : c.status;
      // A check still running or queued says so, never just NO_RECEIPT or STALE (its old receipt).
      const waiting = c.status === 'missing' || c.status === 'stale' ? pending.get(c.checkId) : undefined;
      const reasonCode = waiting ?? checkReasonCode(c.status, c.outcomeReason);
      // A check waits on another environment when its receipt says the hardware was not there,
      // or when it has not run yet and its manifest names hardware this runner lacks.
      const tag = reasonCode === 'HARDWARE_UNAVAILABLE' ? (c.outcomeReason ?? '').slice('hardware-unavailable:'.length) : c.status === 'missing' && waiting === undefined ? (hardwareOf.get(c.checkId) ?? '') : '';
      const environment = tag !== '' && CONTRACT_ID.test(tag) ? tag : null;
      if (c.mandatory && environment !== null && (c.status === 'not-run' || c.status === 'missing')) needs.set(c.checkId, environment);
      return {
        checkId: c.checkId,
        mandatory: c.mandatory,
        outcome,
        receiptId: c.receiptId !== null && CONTRACT_ID.test(c.receiptId) ? c.receiptId : null,
        fresh: c.status !== 'stale' && c.status !== 'missing',
        reasonCode,
        environment,
        ...(row === undefined ? {} : failureOf(row.receipt)),
      };
    });
  // Every mandatory check without a current passing receipt (missing, not-run, failed, stale).
  const missing = [...new Set(report.checks.filter((c) => c.mandatory && c.status !== 'passed').map((c) => c.checkId))].filter((id) => CONTRACT_ID.test(id)).slice(0, 512);
  // needs-environment: nothing but environment-bound mandatory checks is missing, and the
  // software checks (every other check) have current passes. It is still not verified.
  const softwarePassed = report.checks.filter((c) => !needs.has(c.checkId)).every((c) => !c.mandatory || c.status === 'passed');
  const onlyEnvironment = !report.verified && missing.length > 0 && missing.every((id) => needs.has(id)) && softwarePassed;
  return {
    ran,
    readiness: approved.length === 0 ? 'no-checks' : report.verified ? 'verified' : onlyEnvironment ? 'needs-environment' : 'not-verified',
    checks,
    missing,
    ...(needs.size === 0 ? {} : { needsEnvironment: [...needs.keys()].slice(0, 512) }),
    ...(stop === null ? {} : { stopReport: stop }),
  };
}

const HANDOFF_MARGIN_MS = 150;
/**
 * The verify op answers within this share of the client's deadline: 2 s of the CLI's 5 s (A's
 * verify8 run after P5 answered at 4.6 s, too thin a margin on a slower host). Checks still
 * running keep running, and the answer lists them as RUNNING or QUEUED; running `jevris verify`
 * again later shows how they end.
 */
export const VERIFY_ANSWER_SHARE = 0.4;
/**
 * Time kept for the status that follows the run window. The status re-reads the tree (cached
 * hashes since P5) and the receipts; when even that misses the deadline, the answer lists the
 * accepted checks as running or queued instead (never a timeout that reads as "nothing ran").
 */
const STATUS_MARGIN_MS = 750;

/**
 * The approved checks when the status could not be read in time: a check with a receipt shows it
 * as stale (its freshness is unconfirmed), one without reads as not run, and `pending` names each
 * running or queued one. Never verified.
 */
function pendingOnlyReport(ws: WorkspaceServices, taskId: string | null): Pick<CompletionReport, 'checks' | 'verified'> {
  const latest = ws.receipts.latest(ws.workspaceId, taskId);
  return {
    verified: false,
    checks: approvedManifests(ws).map((m) => {
      const known = latest.get(m.id);
      return { checkId: m.id, mandatory: m.mandatory, status: known === undefined ? ('missing' as const) : ('stale' as const), receiptId: known?.receipt.id ?? null, outcomeReason: null };
    }),
  };
}

/**
 * Whether a late answer (the status missed the deadline) says the run ran. A run that finished
 * after its answer window closed, while the status was still being read, has run: an answer that
 * lists no running or queued check and says `ran: false` would read "nothing ran" beside the
 * receipts that run just wrote (the intermittent Windows verify symptom under load).
 */
export function lateAnswerRan(ran: boolean, runDone: boolean): boolean {
  return ran || runDone;
}

/** `work` within `ms`, else undefined (the work keeps running). */
async function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), Math.max(0, ms));
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function handleVerify(ctx: SidecarOpContext): Promise<Outcome> {
  const body = bodyOf(ctx) ?? {};
  const taskId = nullableId(own(body, 'taskId'));
  const checkIds = checkIdsOf(own(body, 'checkIds'));
  if (taskId === undefined || checkIds === undefined) return fail('INVALID_REQUEST');
  const ws = workspaceOf(ctx);
  if (ws === undefined) return fail('WORKSPACE_ROOT_UNKNOWN', 'register the workspace by its root first');
  const startedAt = Date.now();
  /** Time left to answer: the client's deadline, but never past the answer window. */
  const left = (): number => Math.min(ctx.deadline.remainingMs(), ctx.deadline.budgetMs * VERIFY_ANSWER_SHARE - (Date.now() - startedAt));
  const store = storeOf(ctx);
  const request = { taskId, checkIds, ...(store === undefined ? {} : { store }) };
  // An owned task waiting for evidence is verified where its patch is, the task's worktree,
  // and a pass moves it to verified through the store (ORC-05, W01): the same path as
  // task.complete. Any other task id, or none, verifies the workspace itself.
  const owned = taskId === null ? undefined : getTask(ws, taskId);
  const completing = owned !== undefined && ['awaiting-evidence', 'verifying', 'running'].includes(owned.node.state) && taskId !== null;
  const target = completing && taskId !== null ? taskWorkspace(ws, taskId) : ws;
  let ran = false;
  // Set when the run has finished, even after its answer window closed (A's bug 2).
  let runDone = false;
  let pending = new Map<string, PendingCheckReason>();
  const approved = approvedManifests(ws);
  const runKey = verificationRunKey(ws.workspaceId, completing ? taskId : null);
  if (approved.length > 0) {
    // A check id that is not approved is refused by name; it never runs nothing silently.
    const unknown = completing ? [] : checkIds.filter((id) => !approved.some((m) => m.id === id));
    if (unknown.length > 0) return fail('UNKNOWN_CHECK', `no approved check is named ${unknown.slice(0, 8).join(', ')}; jevris verify profile lists the checks`);
    const key = runKey;
    const trace = () => ctx.trace({ event: completing ? 'orchestrator.task-complete-started' : 'orchestrator.verify-started', ...(taskId === null ? {} : { taskId }) });
    // A verified owned task lets its dependents start (W04): the next wave is leased.
    const work = completing && taskId !== null
      ? () => completeTask(ws, taskId, { nowMs: engineNow(ctx.engine) }).then(async (done) => (done.verified ? (await continueOwnedWork(ctx, ws), done) : (await handOffFirstTry(ctx, ws, taskId).catch(() => null), done)))
      : (ids: readonly string[]) =>
          runVerification(ws, { ...request, checkIds: ids }).then((outcome) => {
            // P2: a verification run follows new work, so a reverted integrated task is looked for (off the answer path).
            detectIntegrationRevertsInBackground(ws, { nowMs: engineNow(ctx.engine) });
            return outcome;
          });
    const run = scheduleVerification(key, completing ? [] : checkIds, work, trace);
    void run.then(
      () => {
        runDone = true;
      },
      () => undefined,
    );
    // The run window leaves time for the status after it, so the answer always beats the deadline.
    const settled = (await within(run.then(() => true), Math.max(0, left() - HANDOFF_MARGIN_MS - STATUS_MARGIN_MS))) === true;
    ran = settled;
    // The answer is due before the run ends: each check still running or queued says so.
    if (!settled) pending = pendingChecks(key, approved.map((m) => m.id));
  }
  const readStatus = () =>
    completing && owned !== undefined
      ? verificationStatus(target, { ...request, acceptanceCheckIds: owned.node.acceptanceCheckIds, requirementIds: owned.node.requirementIds })
      : verificationStatus(ws, request);
  const doneBeforeStatus = runDone;
  const status = readStatus();
  let report = await within(status, left() - HANDOFF_MARGIN_MS);
  // A's bug 2: the run missed its answer window but finished before the answer. Its result then
  // counts as run, so the answer never says "running" beside the run's own result. A run that
  // finished during the status read is read again, when time allows, so the report holds it.
  if (!ran && report !== undefined && runDone) {
    if (doneBeforeStatus) ran = true;
    else {
      const again = readStatus();
      const reread = await within(again, left() - HANDOFF_MARGIN_MS);
      if (reread === undefined) void again.catch(() => undefined);
      else [report, ran] = [reread, true];
    }
    if (ran) pending = pendingChecks(runKey, approved.map((m) => m.id));
  }
  if (report === undefined) {
    // Even the status missed the deadline: answer with the accepted checks as running or queued.
    void status.catch(() => undefined);
    const waiting = pendingChecks(runKey, approved.map((m) => m.id));
    ctx.trace({ event: 'orchestrator.verify-status-late', reasonCode: 'STATUS_LATE' });
    return respond(ctx, 'verify', verifyAnswer(verifyPayload(target, pendingOnlyReport(target, taskId), lateAnswerRan(ran, runDone), null, waiting)));
  }
  return respond(ctx, 'verify', verifyAnswer(verifyPayload(target, report, ran, stopReportView(ws, taskId, report), pending)));
}

async function handleVerifyStatus(ctx: SidecarOpContext): Promise<Outcome> {
  const body = bodyOf(ctx) ?? {};
  const taskId = nullableId(own(body, 'taskId'));
  const checkIds = checkIdsOf(own(body, 'checkIds'));
  if (taskId === undefined || checkIds === undefined) return fail('INVALID_REQUEST');
  const ws = workspaceOf(ctx);
  if (ws === undefined) return fail('WORKSPACE_ROOT_UNKNOWN', 'register the workspace by its root first');
  const store = storeOf(ctx);
  // An owned task's receipts belong to its worktree: its status is read there (W01).
  const owned = taskId === null ? undefined : getTask(ws, taskId);
  const target = owned === undefined || taskId === null ? ws : taskWorkspace(ws, taskId);
  const scoped = owned === undefined ? {} : { acceptanceCheckIds: owned.node.acceptanceCheckIds, requirementIds: owned.node.requirementIds };
  const report = await verificationStatus(target, { taskId, checkIds, ...scoped, ...(store === undefined ? {} : { store }) });
  const key = verificationRunKey(ws.workspaceId, owned === undefined ? null : taskId);
  const pending = pendingChecks(key, approvedManifests(ws).map((m) => m.id));
  return respond(ctx, 'verify', verifyAnswer(verifyPayload(target, report, false, stopReportView(ws, taskId, report), pending)));
}

// ---------------------------------------------------------------------------- evidence.get

export function evidencePayload(ws: WorkspaceServices, handle: string) {
  const meta = ws.evidence.metaIn(handle, ws.workspaceId);
  const bytes = meta === undefined ? undefined : ws.evidence.get(handle, ws.workspaceId);
  if (meta === undefined || bytes === undefined) {
    return { handle, found: false, mediaType: null, byteLength: null, text: null, truncated: false };
  }
  if (meta.contentType !== 'text') {
    return { handle, found: true, mediaType: null, byteLength: bytes.length, text: null, truncated: meta.truncated, output: outputViewOf(ws, handle) };
  }
  const full = new TextDecoder().decode(bytes);
  const output = outputViewOf(ws, handle);
  let text = full.length > MAX_EVIDENCE_TEXT ? '' : redactSecrets(full);
  // A long text keeps its start and its end (the failing part is usually last), each piece cut at
  // a line or word boundary and redacted on its own, so redaction only ever reads the kept slices
  // and a secret is never split by the cut. A redacted text that would not fit the contract is cut the same way.
  const sliced = full.length > MAX_EVIDENCE_TEXT || text.length > EVIDENCE_CONTRACT_MAX;
  if (sliced) text = headAndTail(full);
  let mediaType: 'text/plain' | 'application/json' = 'text/plain';
  if (/^\s*[[{]/.test(full)) {
    try {
      JSON.parse(full);
      mediaType = 'application/json';
    } catch {
      mediaType = 'text/plain';
    }
  }
  return { handle, found: true, mediaType, byteLength: bytes.length, text, truncated: meta.truncated || sliced, output };
}

/** The first and last `EVIDENCE_KEEP_EACH_END` characters of `full`, redacted, with a marker for what is between. */
function headAndTail(full: string): string {
  const headEnd = snapBack(full, EVIDENCE_KEEP_EACH_END);
  const tailStart = Math.max(headEnd, snapForward(full, full.length - EVIDENCE_KEEP_EACH_END));
  const omitted = tailStart - headEnd;
  const head = redactSecrets(full.slice(0, headEnd));
  const marker = `... [${String(omitted)} characters omitted from the middle; the full output stays in the local evidence store] ...\n`;
  return `${head}${head.endsWith('\n') ? '' : '\n'}${marker}${redactSecrets(full.slice(tailStart))}`;
}

function isBoundary(code: number): boolean {
  return code === 10 || code === 32 || code === 9 || code === 13;
}

/** A cut at or before `at`, on a newline (else a space) within a short reach, never inside a surrogate pair. */
function snapBack(text: string, at: number): number {
  const floor = Math.max(1, at - EVIDENCE_SNAP_CHARS);
  for (const wanted of [(c: number) => c === 10, isBoundary]) {
    for (let i = at; i >= floor; i--) if (wanted(text.charCodeAt(i - 1))) return i;
  }
  const c = text.charCodeAt(at - 1);
  return c >= 0xd800 && c <= 0xdbff ? at - 1 : at;
}

/** A cut at or after `at`, on a line start (else after a space) within a short reach, never inside a surrogate pair. */
function snapForward(text: string, at: number): number {
  const ceil = Math.min(text.length, at + EVIDENCE_SNAP_CHARS);
  for (const wanted of [(c: number) => c === 10, isBoundary]) {
    for (let i = at; i < ceil; i++) if (wanted(text.charCodeAt(i - 1))) return i;
  }
  const c = text.charCodeAt(at);
  return c >= 0xdc00 && c <= 0xdfff ? at + 1 : at;
}

/** How the stored output was shown to the model (US15), or null when no view was recorded. */
function outputViewOf(ws: WorkspaceServices, handle: string) {
  const rec = outputRecordOf(ws, handle);
  if (rec === undefined) return null;
  return {
    exitCode: rec.exitCode,
    errorState: rec.errorState,
    stderrOffset: rec.stderrOffset,
    mode: rec.mode,
    passthroughReason: rec.passthroughReason,
    keptSpans: rec.keptSpans.slice(0, 256).map((s) => ({ startByte: s.startByte, endByte: s.endByte, startLine: s.startLine, endLine: s.endLine })),
    omittedLines: rec.omittedLines,
    view: redactSecrets(rec.viewText.slice(0, 16_384)).slice(0, 16_384),
  };
}

async function handleEvidenceGet(ctx: SidecarOpContext): Promise<Outcome> {
  const body = bodyOf(ctx);
  const handle = body === undefined ? undefined : own(body, 'handle');
  if (typeof handle !== 'string' || handle.length > 140) return fail('INVALID_REQUEST');
  const ws = workspaceOf(ctx);
  if (ws === undefined) return fail('WORKSPACE_ROOT_UNKNOWN', 'register the workspace by its root first');
  const payload = evidencePayload(ws, handle);
  // P10: a read of stored evidence is kept with the selection that ranked it (ids and ranks only).
  if (payload.found) await recordEvidenceRead(ws, handle, body === undefined ? undefined : own(body, 'selectionId'), Date.now()).catch(() => null);
  return respond(ctx, 'evidence.get', payload);
}

// --------------------------------------------------------------------- verification.record

/**
 * A model call can point a task at a runner receipt; it never creates or edits one (§6.4, US24).
 * The pointer is accepted only for a current receipt of the named check in this workspace.
 */
export async function recordVerificationPointer(ws: WorkspaceServices, receiptId: string, checkId: string, taskId: string | null, nowMs = Date.now()) {
  const row = ws.receipts.get(ws.workspaceId, receiptId);
  const base = { receiptId, receiptCreated: false as const };
  if (row === undefined) return { ...base, accepted: false, reasonCode: 'RECEIPT_NOT_FOUND', outcome: null };
  if (row.receipt.checkId !== checkId) return { ...base, accepted: false, reasonCode: 'CHECK_MISMATCH', outcome: row.receipt.outcome };
  if (row.validity !== 'current') return { ...base, accepted: false, reasonCode: 'RECEIPT_STALE', outcome: row.receipt.outcome };
  if (taskId !== null && row.receipt.taskId !== null && row.receipt.taskId !== taskId) {
    return { ...base, accepted: false, reasonCode: 'TASK_MISMATCH', outcome: row.receipt.outcome };
  }
  if (taskId !== null) {
    await ws.state.transact((tx) =>
      tx.put('task-receipts', recordKey(ws.workspaceId, taskId, checkId), { workspaceId: ws.workspaceId, taskId, checkId, receiptId, at: nowMs }),
    );
  }
  return { ...base, accepted: true, reasonCode: 'RECORDED', outcome: row.receipt.outcome };
}

async function handleVerificationRecord(ctx: SidecarOpContext): Promise<Outcome> {
  const body = bodyOf(ctx);
  if (body === undefined) return fail('INVALID_REQUEST');
  const receiptId = own(body, 'receiptId');
  const checkId = own(body, 'checkId');
  const taskId = nullableId(own(body, 'taskId'));
  if (typeof receiptId !== 'string' || !CONTRACT_ID.test(receiptId) || typeof checkId !== 'string' || !CONTRACT_ID.test(checkId) || taskId === undefined) {
    return fail('INVALID_REQUEST');
  }
  // Refuse unknown fields that try to assert an outcome: the runner is the only source.
  for (const key of Object.keys(body)) if (!['receiptId', 'checkId', 'taskId'].includes(key)) return fail('INVALID_REQUEST');
  const ws = workspaceOf(ctx);
  if (ws === undefined) return fail('WORKSPACE_ROOT_UNKNOWN', 'register the workspace by its root first');
  return respond(ctx, 'verification.record', await recordVerificationPointer(ws, receiptId, checkId, taskId));
}

// ----------------------------------------------------------------------- verify.import-ci

/** Bound on the artifact bytes one import request may carry. */
export const CI_IMPORT_MAX_BYTES = 8 * 1024 * 1024;

/** The result of `verify.import-ci` (no surface contract yet; validated here). */
export interface CiImportPayload {
  readonly accepted: boolean;
  readonly reasonCode: string;
  readonly binding: 'current' | 'historical' | null;
  readonly receiptIds: readonly string[];
}

function base64Bytes(text: string): Uint8Array | undefined {
  if (text.length === 0) return new Uint8Array(0);
  return base64Decode(text) ?? undefined;
}

/**
 * Imports a signed CI receipt bundle (VER-06). CLI only (scope submit): the CLI reads the
 * bundle and artifact files and sends their bytes; the sidecar never opens a path it was given.
 */
async function handleCiImport(ctx: SidecarOpContext): Promise<Outcome> {
  const body = bodyOf(ctx);
  if (body === undefined) return fail('INVALID_REQUEST');
  const bundle = own(body, 'bundle');
  const list = own(body, 'artifacts');
  if (!isPlain(bundle) || !Array.isArray(list) || list.length > 256) return fail('INVALID_REQUEST');
  const artifacts = new Map<string, Uint8Array>();
  let total = 0;
  for (const item of list) {
    if (!isPlain(item)) return fail('INVALID_REQUEST');
    const name = own(item, 'name');
    const data = own(item, 'base64');
    if (typeof name !== 'string' || !/^[A-Za-z0-9._/-]{1,200}$/.test(name) || name.includes('..') || typeof data !== 'string') return fail('INVALID_REQUEST');
    const bytes = base64Bytes(data);
    if (bytes === undefined) return fail('INVALID_REQUEST');
    total += bytes.length;
    if (total > CI_IMPORT_MAX_BYTES) return fail('OVERSIZE', 'the artifacts exceed 8 MiB');
    artifacts.set(name, bytes);
  }
  const ws = workspaceOf(ctx);
  if (ws === undefined) return fail('WORKSPACE_ROOT_UNKNOWN', 'register the workspace by its root first');
  const result = await importCiBundle(ws, { bundle, artifacts: { fetch: async (_issuer, _job, name) => artifacts.get(name) ?? null } });
  const payload: CiImportPayload = result.ok
    ? { accepted: true, reasonCode: result.binding === 'current' ? 'IMPORTED' : 'IMPORTED_HISTORICAL', binding: result.binding, receiptIds: [...result.receiptIds].slice(0, 256) }
    : { accepted: false, reasonCode: result.reasonCode, binding: null, receiptIds: [] };
  ctx.trace({ event: 'orchestrator.ci-import', reasonCode: payload.reasonCode });
  return { ok: true, body: payload };
}

// ----------------------------------------------------------------------- verify.required

export const REQUIRED_CHECKS_MAX = 256;

/** The result of `verify.required` (no surface contract yet; built from validated values). */
export interface RequiredChecksPayload {
  readonly checks: readonly RequiredCheckLine[];
}

/**
 * The W08 readiness report over the store's receipts (VER-06): every named required check as
 * passed, failed, missing or explicitly waived. Read-only; the receipts live in the sidecar's
 * store, so the CLI asks the sidecar instead of reading them itself.
 */
async function handleVerifyRequired(ctx: SidecarOpContext): Promise<Outcome> {
  const body = bodyOf(ctx);
  const ids = body === undefined ? undefined : own(body, 'checkIds');
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > REQUIRED_CHECKS_MAX || !ids.every((id) => isId(id))) return fail('INVALID_REQUEST');
  const ws = workspaceOf(ctx);
  if (ws === undefined) return fail('WORKSPACE_ROOT_UNKNOWN', 'register the workspace by its root first');
  // Freshness first (US17): a receipt whose input scopes, branch or lockfile moved since it ran
  // is invalidated before the report, so it never reads as passed on the new revision.
  const store = storeOf(ctx);
  await refreshFreshness({ workspaceRoot: ws.workspaceRoot, workspaceId: ws.workspaceId, receipts: ws.receipts, state: ws.state, scope: receiptScopeOf(ws), ...(store === undefined ? {} : { store }) });
  const checks = requiredCheckReport(ws, ids as string[]).map((line) => ({
    checkId: line.checkId,
    status: line.status,
    receiptId: line.receiptId,
    issuer: line.issuer === null ? null : line.issuer.slice(0, 128),
    waiverAuthority: line.waiverAuthority === null ? null : line.waiverAuthority.slice(0, 120),
    stale: line.stale,
  }));
  ctx.trace({ event: 'orchestrator.verify-required', reasonCode: checks.every((c) => c.status === 'passed' || c.status === 'waived') ? 'COMPLETE' : 'INCOMPLETE' });
  return { ok: true, body: { checks } satisfies RequiredChecksPayload };
}

// ------------------------------------------------------------------------------- registry

export const sidecarOps: readonly SidecarOpDefinition[] = Object.freeze([
  { op: 'verify', scope: 'submit', budget: 'background', stoppedByKillSwitch: true, handle: handleVerify },
  { op: 'verify.status', scope: 'status', budget: 'hot', handle: handleVerifyStatus },
  { op: 'evidence.get', scope: 'status', budget: 'hot', handle: handleEvidenceGet },
  { op: 'verification.record', scope: 'checkpoint', budget: 'hot', stoppedByKillSwitch: true, handle: handleVerificationRecord },
  { op: 'verify.import-ci', scope: 'submit', budget: 'background', stoppedByKillSwitch: true, handle: handleCiImport },
  { op: 'verify.required', scope: 'status', budget: 'hot', handle: handleVerifyRequired },
  ...taskOps(respond, workspaceOf),
  ...memoryOps(respond, workspaceOf),
  ...capabilityOps(workspaceOf),
  ...integrationOps(workspaceOf),
  ...budgetOps(workspaceOf),
  ...controlOps(workspaceOf),
] satisfies SidecarOpDefinition[]);

export const sidecarEventSubscribers: readonly SidecarEventSubscriber[] = Object.freeze([orchestratorSubscriber]);
