/**
 * Memory and recovery ops for the sidecar: `checkpoint`, `recover`, `evidence.select`,
 * `handoff.export` and `handoff.import`. Every result body is validated against E's payload
 * contract before it leaves (`respond`).
 */
import { CAPSULE_ITEM_KINDS, ID_PATTERN, HARNESS_IDS, modeAllows, type HarnessId, type SidecarOpContext, type SidecarOpOutcome, type SurfaceOperation } from '@jevris/contracts';
import type { WorkspaceServices } from '../workspace.js';
import { readEffectiveConfig } from '../settings/config.js';
import { declare, latestCapsule, writeCapsuleDecided, type CapsuleItem } from '../memory/capsule.js';
import { exportPortable, importPortable, type PortableCapability } from '../memory/handoff.js';
import { assessLoop, DEFAULT_LOOP_BUDGETS, recordRejectedApproach } from '../orchestration/loops.js';
import { approvedManifests } from '../verify/service.js';
import { CONTEXT_FEATURE, isCertified } from '../hooks/certification.js';
import { isPlain, own, recordKey, safeText, tokens } from '../util.js';
import { adviseBoundedEscalation } from '@jevris/core';
import { relaunchEscalated, type EscalationState } from './task-ops.js';

type EscalationRecord = ReturnType<typeof adviseBoundedEscalation>;
import { shortlistSkills } from '../capabilities/retrieval.js';
import { recordEvidenceSelection } from '../memory/evidence-usage.js';

const CONTRACT_ID = new RegExp(ID_PATTERN);

export type Respond = (ctx: SidecarOpContext, surface: SurfaceOperation, body: unknown) => SidecarOpOutcome;
export type WorkspaceOf = (ctx: SidecarOpContext) => WorkspaceServices | undefined;

function str(body: unknown, key: string): string | null {
  if (!isPlain(body)) return null;
  const v = own(body, key);
  return typeof v === 'string' ? v : null;
}

function idOrNull(body: unknown, key: string): string | null | undefined {
  if (!isPlain(body)) return null;
  const v = own(body, key);
  if (v === undefined || v === null) return null;
  return typeof v === 'string' && CONTRACT_ID.test(v) ? v : undefined;
}

function strings(body: unknown, key: string, max: number, len: number): string[] {
  if (!isPlain(body)) return [];
  const v = own(body, key);
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).slice(0, max).map((s) => s.slice(0, len));
}

const PAYLOAD_KIND: { readonly [K in CapsuleItem['kind']]?: (typeof CAPSULE_ITEM_KINDS)[number] } = {
  objective: 'objective',
  constraint: 'constraint',
  decision: 'decision',
  'changed-file': 'changed-file',
  'open-check': 'open-check',
  unresolved: 'unresolved',
  'rejected-approach': 'rejected-approach',
  hypothesis: 'hypothesis',
  'next-action': 'next-action',
  'running-work': 'unresolved',
  'source-handle': 'next-action',
};

function egressApproved(ctx: SidecarOpContext, ws: WorkspaceServices): boolean {
  return readEffectiveConfig({ home: ctx.home, workspaceRoot: ws.workspaceRoot }).config.privacy.sourceEgress === 'approved-scoped';
}

async function handleCheckpoint(ctx: SidecarOpContext, respond: Respond, ws: WorkspaceServices): Promise<SidecarOpOutcome> {
  const taskId = idOrNull(ctx.body, 'taskId');
  if (taskId === undefined) return { ok: false, reasonCode: 'INVALID_REQUEST' };
  const objective = str(ctx.body, 'objective');
  const constraints = strings(ctx.body, 'constraints', 64, 1000);
  await declare(ws, taskId, { ...(objective === null || objective.trim() === '' ? {} : { objective: objective.slice(0, 4000) }), constraints });
  const { capsule, decisionId } = await writeCapsuleDecided(ws, { taskId, engine: ctx.engine, egressApproved: egressApproved(ctx, ws), remainingMs: ctx.deadline.remainingMs() - 200 });
  const count = (k: CapsuleItem['kind']) => capsule.items.filter((i) => i.kind === k).length;
  const items = capsule.items
    .filter((i) => PAYLOAD_KIND[i.kind] !== undefined)
    .slice(0, 128)
    .map((i) => ({ kind: PAYLOAD_KIND[i.kind] as (typeof CAPSULE_ITEM_KINDS)[number], text: safeText(i.text, 1000) }));
  ctx.trace({ event: 'orchestrator.checkpoint', reasonCode: 'CAPSULE_WRITTEN', ...(taskId === null ? {} : { taskId }) });
  return respond(ctx, 'checkpoint', {
    capsuleId: capsule.id,
    handle: `capsule:${capsule.id}`,
    written: true,
    retained: {
      constraints: count('constraint'),
      changedFiles: count('changed-file'),
      openChecks: count('open-check'),
      unresolved: count('unresolved'),
      hypotheses: count('hypothesis'),
    },
    items,
    compactionTriggered: false,
    decisionId,
  });
}

async function handleRecover(ctx: SidecarOpContext, respond: Respond, ws: WorkspaceServices): Promise<SidecarOpOutcome> {
  const taskId = idOrNull(ctx.body, 'taskId');
  if (taskId === undefined) return { ok: false, reasonCode: 'INVALID_REQUEST' };
  const signals = isPlain(ctx.body) ? own(ctx.body, 'signals') : undefined;
  const fingerprints = strings(signals, 'fingerprints', 64, 2000);
  // signals.environment (a caller's claim) is not used: the environment family comes from
  // the failure text itself (RET-06, C38).
  for (const text of strings(ctx.body, 'rejectedApproaches', 32, 500)) await recordRejectedApproach(ws, { taskId, text, evidence: [], source: 'user' });
  const config = readEffectiveConfig({ home: ctx.home, workspaceRoot: ws.workspaceRoot }).config;
  const assessment = await assessLoop(ws, {
    taskId,
    fingerprints,
    engine: ctx.engine,
    remainingMs: ctx.deadline.remainingMs() - 200,
    budgets: { ...DEFAULT_LOOP_BUDGETS, perTask: config.orchestration.maxRepairAttempts + 1 },
  });
  ctx.trace({ event: 'orchestrator.recover', reasonCode: assessment.classification.toUpperCase().replace(/-/g, '_'), ...(assessment.decisionId === null ? {} : { decisionId: assessment.decisionId }) });
  const escalation = await boundedEscalation(ctx, ws, taskId, assessment, fingerprints, config);
  if (escalation !== null) ctx.trace({ event: 'orchestrator.escalation', reasonCode: escalation.blocked ? 'BLOCKED_REPORT' : escalation.escalated ? 'ESCALATED_ONCE' : escalation.nextStep.toUpperCase().replace(/-/g, '_') });
  return respond(ctx, 'recover', {
    classification: assessment.classification,
    action: assessment.action,
    advice: safeText(escalation === null ? assessment.advice : `${assessment.advice} ${escalationText(escalation)}`, 1000),
    signals: assessment.signals,
    rejectedApproaches: assessment.rejectedApproaches.slice(-32).map((r) => safeText(r, 500)),
    decisionId: assessment.decisionId,
  });
}

/**
 * W02: a repeated failure goes through C's bounded escalation (C29). An environment failure
 * asks for environment evidence and is never escalated; a source defect with evidence, the
 * repair budget spent and a qualified owned worker is escalated once per task (recorded); a
 * second time it is a blocked report with the rejected approaches. Nothing is launched here:
 * the record is advice, and success still needs a new current receipt.
 */
const RELAUNCH_TEXT: Readonly<Record<EscalationState['state'], string>> = {
  recorded: 'Escalation recorded.',
  launched: 'A stronger owned worker was launched once with the compact history.',
  exhausted: 'The bounded escalation failed; the task is blocked.',
  'no-stronger-worker': 'No stronger approved model remains for this task.',
  'not-relaunchable': 'The task was not relaunched (it is not a failed owned task, or workers are not automatic).',
};

/** C's escalation sentence plus what the orchestrator did with it. */
function escalationText(escalation: EscalationRecord & { readonly relaunch: EscalationState | null }): string {
  const relaunch = escalation.relaunch;
  if (relaunch === null) return escalation.text;
  const core = relaunch.state === 'launched' ? escalation.text.replace(' No worker was launched.', '') : escalation.text;
  return `${core} ${RELAUNCH_TEXT[relaunch.state]}${relaunch.toModel === null ? '' : ` (${relaunch.toModel})`}`;
}

async function boundedEscalation(
  ctx: SidecarOpContext,
  ws: WorkspaceServices,
  taskId: string | null,
  assessment: Awaited<ReturnType<typeof assessLoop>>,
  fingerprints: readonly string[],
  config: ReturnType<typeof readEffectiveConfig>['config'],
): Promise<(EscalationRecord & { readonly relaunch: EscalationState | null }) | null> {
  const sourceEvidence = fingerprints.length > 0;
  const diagnostic = assessment.classification === 'environment-failure' ? 'missing-service' : assessment.classification === 'repeated-failure' ? 'source-defect' : null;
  if (diagnostic === null) return null;
  const key = recordKey(ws.workspaceId, taskId ?? '-');
  const prior = ws.state.get<{ readonly atMs: number }>('escalations', key) !== undefined;
  const record = adviseBoundedEscalation({
    diagnostic,
    repairAttemptsUsed: assessment.signals.failures,
    maxRepairAttempts: config.orchestration.maxRepairAttempts,
    workerQualified: config.orchestration.enabled && modeAllows(config.routing.managedWorkers, 'actuate'),
    sourceEvidence: sourceEvidence || assessment.signals.distinctFingerprints > 0 ? 'present' : 'absent',
    priorEscalation: prior,
    rejectedApproaches: assessment.rejectedApproaches.slice(-32),
  });
  if (!record.escalated || prior) return { ...record, relaunch: null };
  // The one escalation: a failed owned task relaunches with the next stronger approved model.
  if (taskId !== null) {
    const relaunch = await relaunchEscalated(ctx, ws, taskId, { failures: fingerprints, rejectedApproaches: assessment.rejectedApproaches });
    ctx.trace({ event: 'orchestrator.escalation-relaunch', taskId, reasonCode: relaunch.state.toUpperCase().replace(/-/g, '_') });
    return { ...record, relaunch };
  }
  await ws.state.transact((tx) => tx.put('escalations', key, { atMs: Date.now(), fromModel: null, toModel: null, state: 'recorded' } satisfies EscalationState));
  return { ...record, relaunch: null };
}

function safeId(raw: string): string {
  const s = raw.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 128);
  return s.length > 0 ? s : 'item';
}

async function handleEvidenceSelect(ctx: SidecarOpContext, respond: Respond, ws: WorkspaceServices): Promise<SidecarOpOutcome> {
  const intent = (str(ctx.body, 'intent') ?? '').slice(0, 500);
  const maxRaw = isPlain(ctx.body) ? own(ctx.body, 'maxItems') : undefined;
  const maxItems = typeof maxRaw === 'number' && Number.isInteger(maxRaw) ? Math.max(1, Math.min(maxRaw, 64)) : 8;
  const want = new Set(tokens(intent.toLowerCase()));
  type Cand = { readonly id: string; readonly kind: 'evidence' | 'receipt' | 'capsule'; readonly label: string; readonly reason: string; readonly text: string; readonly boost: number };
  const cands: Cand[] = [];
  const capsule = latestCapsule(ws, null);
  if (capsule !== undefined) cands.push({ id: capsule.id, kind: 'capsule', label: safeText(`Capsule: ${capsule.objective}`, 300), reason: 'The latest checkpoint for this workspace.', text: `${capsule.objective} ${capsule.items.map((i) => i.text).join(' ')}`, boost: 0.5 });
  const latest = ws.receipts.latest(ws.workspaceId, null);
  for (const m of approvedManifests(ws)) {
    const row = latest.get(m.id);
    if (row === undefined) continue;
    const fresh = row.validity === 'current';
    cands.push({
      id: safeId(row.receipt.id),
      kind: 'receipt',
      label: safeText(`Check ${m.id}: ${row.receipt.outcome}${fresh ? '' : ' (stale)'}`, 300),
      reason: row.receipt.outcome === 'failed' ? 'A failing check result.' : 'A check result for this workspace.',
      text: `${m.id} ${m.description} ${row.receipt.outcome} ${row.receipt.outcomeReason}`,
      boost: row.receipt.outcome === 'failed' ? 0.4 : 0,
    });
    if (row.receipt.rawOutputHandle !== null) {
      cands.push({ id: safeId(row.receipt.rawOutputHandle.replace(':', '-')), kind: 'evidence', label: safeText(`Raw output of ${m.id}: ${row.receipt.rawOutputHandle}`, 300), reason: 'The full output behind a check result.', text: `${m.id} output log ${row.receipt.outcome}`, boost: row.receipt.outcome === 'failed' ? 0.2 : -0.2 });
    }
  }
  // Installed skills (C33, RET-01): metadata only, rules-ranked on the hot path; roots a client
  // sends over MCP are searched too. `none` is implied when no skill item appears.
  const roots = strings(ctx.body, 'roots', 8, 4096);
  const skills = intent.trim() === '' ? null : await shortlistSkills({ ws, home: ctx.home, env: process.env, platform: process.platform, engine: undefined }, intent, roots, 4, false);
  const skillItems = (skills?.ranked ?? []).filter((r) => r.id !== 'none').map((r) => ({ id: safeId(r.id), kind: 'skill' as const, label: safeText(r.label, 300), reason: safeText(`Installed skill (${r.reason}); load it only if it fits.`, 300), score: r.score ?? 0 }));
  const scored = cands.map((c) => {
    const have = tokens(c.text.toLowerCase());
    const overlap = want.size === 0 ? 0 : have.filter((t) => want.has(t)).length / want.size;
    return { c, score: overlap + c.boost };
  });
  scored.sort((a, b) => b.score - a.score || (a.c.id < b.c.id ? -1 : 1));
  const seen = new Set<string>();
  const items: { id: string; kind: 'skill' | 'evidence' | 'receipt' | 'capsule'; label: string; reason: string }[] = [];
  const merged = [...scored.map(({ c, score }) => ({ id: c.id, kind: c.kind, label: c.label, reason: c.reason, score })), ...skillItems].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  for (const c of merged) {
    if (seen.has(c.id) || items.length >= maxItems) continue;
    seen.add(c.id);
    items.push({ id: c.id, kind: c.kind, label: c.label, reason: c.reason });
  }
  const missing: string[] = [];
  if (capsule === undefined) missing.push('No checkpoint yet: run checkpoint to save the task state.');
  const approved = approvedManifests(ws);
  if (approved.length === 0) missing.push('No approved checks: add jevris.checks.json and approve it with `jevris verify approve`.');
  for (const m of approved) if (!latest.has(m.id)) missing.push(`Check ${m.id} has not run.`);
  // P10: the ranking is kept (its handle ids, bounded) so later reads can be measured against it.
  // A client passes the selection id back on evidence.get, so its reads join this ranking (E 31b83d7).
  const selectionId = await recordEvidenceSelection(ws, merged.map((c) => c.id), Date.now()).catch(() => null);
  return respond(ctx, 'evidence.select', { intent: safeText(intent, 500), items, missing: missing.slice(0, 32).map((m) => safeText(m, 300)), truncated: merged.length > items.length, ...(selectionId === null ? {} : { selectionId }) });
}

function harnessOf(ctx: SidecarOpContext): HarnessId | null {
  const h = str(ctx.body, 'harness');
  return h !== null && (HARNESS_IDS as readonly string[]).includes(h) ? (h as HarnessId) : null;
}

async function handleExport(ctx: SidecarOpContext, respond: Respond, ws: WorkspaceServices): Promise<SidecarOpOutcome> {
  const capsuleId = idOrNull(ctx.body, 'capsuleId');
  const taskId = idOrNull(ctx.body, 'taskId');
  if (capsuleId === undefined || taskId === undefined) return { ok: false, reasonCode: 'INVALID_REQUEST' };
  const result = exportPortable(ws, { capsuleId, taskId, sourceHarness: harnessOf(ctx), toolRefs: strings(ctx.body, 'toolRefs', 64, 64) });
  if (!result.ok) {
    ctx.trace({ event: 'orchestrator.handoff-export', reasonCode: result.reasonCode });
    return respond(ctx, 'handoff.export', { capsuleId, found: false, capsule: null, contentHash: null });
  }
  return respond(ctx, 'handoff.export', { capsuleId: result.capsuleId, found: true, capsule: result.envelope, contentHash: result.contentHash });
}

async function handleImport(ctx: SidecarOpContext, respond: Respond, ws: WorkspaceServices): Promise<SidecarOpOutcome> {
  const envelope = isPlain(ctx.body) ? own(ctx.body, 'capsule') : undefined;
  const target = harnessOf(ctx);
  const capabilities: PortableCapability[] = ['verify-runner', 'task-ledger'];
  if (target !== null && (await isCertified({ home: ctx.home, harness: target, featureId: CONTEXT_FEATURE, nowMs: Date.now() })).certified) capabilities.push('context-injection');
  const result = await importPortable(ws, { envelope, contentHash: str(ctx.body, 'contentHash'), target: { harness: target, capabilities } });
  ctx.trace({ event: 'orchestrator.handoff-import', reasonCode: result.reasonCode.slice(0, 64) });
  return respond(ctx, 'handoff.import', {
    accepted: result.mode !== 'blocked',
    reasonCode: result.reasonCode,
    capsuleId: result.capsuleId,
    facts: result.facts,
    unresolved: result.unresolved,
    authorityGranted: false,
    mode: result.mode,
    missingCapabilities: [...result.missingCapabilities],
  });
}

type Handler = (ctx: SidecarOpContext, respond: Respond, ws: WorkspaceServices) => Promise<SidecarOpOutcome>;

export function memoryOps(respond: Respond, workspaceOf: WorkspaceOf) {
  const wrap = (fn: Handler) => async (ctx: SidecarOpContext): Promise<SidecarOpOutcome> => {
    const ws = workspaceOf(ctx);
    if (ws === undefined) return { ok: false, reasonCode: 'WORKSPACE_ROOT_UNKNOWN' };
    return fn(ctx, respond, ws);
  };
  return [
    { op: 'checkpoint', scope: 'checkpoint' as const, budget: 'background' as const, stoppedByKillSwitch: true as const, handle: wrap(handleCheckpoint) },
    { op: 'recover', scope: 'advice' as const, budget: 'background' as const, handle: wrap(handleRecover) },
    { op: 'evidence.select', scope: 'status' as const, budget: 'hot' as const, handle: wrap(handleEvidenceSelect) },
    { op: 'handoff.export', scope: 'checkpoint' as const, budget: 'background' as const, handle: wrap(handleExport) },
    { op: 'handoff.import', scope: 'checkpoint' as const, budget: 'background' as const, stoppedByKillSwitch: true as const, handle: wrap(handleImport) },
  ];
}

export const MEMORY_SURFACE_OPS: { readonly [op: string]: SurfaceOperation } = {
  checkpoint: 'checkpoint',
  recover: 'recover',
  'evidence.select': 'evidence.select',
  'handoff.export': 'handoff.export',
  'handoff.import': 'handoff.import',
};
