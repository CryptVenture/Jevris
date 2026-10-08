/**
 * M3 research and long-range capabilities (SSOT §12.4 C32, §12.5 C40, §12.8 C62, §12.9 C65-C72;
 * RSH-01..RSH-11). The owner decision puts M3 in scope: each capability ships working code behind
 * its own SSOT guard (the catalogue's feasibility gate or safety condition) and writes its own
 * evidence record (`capability-record`, content-free: ids, hashes, reason codes and counts).
 *
 * Like every capability, each answers with advice: nothing is granted, applied, deployed,
 * merged or certified here. The exceptions are recorded side effects the catalogue asks for:
 * - C32 stores bridge-probe records;
 * - C66 stores a learned-router candidate and its signed review;
 * - C67 writes a proposal to a `jevris/proposals/*` branch (create-only, never HEAD or the
 *   working tree, never live policy);
 * - C68 applies candidate patches only inside Jevris-owned worktrees and removes them.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAbsoluteOnAnyPlatform } from '@jevris/platform';
import {
  learnedRouteAdvice,
  learnedRouterDeployable,
  runPolicyExperiment,
  syntheticRoutingExamples,
  trainLearnedRouter,
  type LabTask,
  type LearnedRouterArtifact,
  type PolicyVariant,
  type RouterExample,
} from '@jevris/core';
import { profileWorkspace, proposeChecks } from '@jevris/languages';
import { listTasks } from '../orchestration/tasks.js';
import { readEffectiveConfig } from '../settings/config.js';
import { approvedManifests, attachedHardware, verificationStatus } from '../verify/service.js';
import { inScopes, nodeGit } from '../verify/revision.js';
import { createWorktree, enforceAllowedPaths, removeWorktree } from '../worktree.js';
import { isPlain, safeText, sha256, type Rec } from '../util.js';
import { consultChoice, consultScore } from './consult.js';
import { abstainAdvice, advice, byScore, type CapabilityAdvice, type CapabilityContext, type CapabilityDefinition, type RankedItem } from './advice.js';
import { listFiles, readBounded } from './repo.js';
import { refuseSecrets, type KeptText } from './screen.js';
import { triageEnvironmentText } from './retrieval.js';

type Consulted = { source: 'jev' | 'rules'; reasonCode: string; decisionId: string | null };
const RULES: Consulted = { source: 'rules', reasonCode: 'RULES', decisionId: null };
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function strOf(input: Rec, key: string, max = 500): string {
  const v = input[key];
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function strsOf(input: Rec, key: string, maxItems = 64, maxLen = 200): string[] {
  const v = input[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, maxItems).map((x) => x.slice(0, maxLen)) : [];
}

function numOf(input: Rec, key: string, min: number, max: number, fallback: number): number {
  const v = input[key];
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
}

function recsOf(input: Rec, key: string, max = 256): Rec[] {
  const v = input[key];
  return Array.isArray(v) ? v.filter(isPlain).slice(0, max) : [];
}

function remaining(cx: CapabilityContext): { remainingMs?: number } {
  return cx.remainingMs === undefined ? {} : { remainingMs: cx.remainingMs };
}

export const CAPABILITY_RECORD_SCHEMA = 'jevris-capability-record-1' as const;

export interface CapabilityGuardResult {
  /** The SSOT condition this capability is gated on. */
  readonly id: string;
  readonly passed: boolean;
  readonly reasonCode: string;
}

/**
 * Writes the capability's own evidence record (content-free) and returns its handle. The record
 * binds the guard result, a hash of the input and the advice outcome.
 */
async function recordOf(cx: CapabilityContext, capabilityId: string, guard: CapabilityGuardResult, input: Rec, outcome: { readonly verb: string; readonly recommendation: string | null; readonly reasonCode: string; readonly counts?: { readonly [k: string]: number } }): Promise<string | null> {
  try {
    const record = {
      schemaVersion: CAPABILITY_RECORD_SCHEMA,
      capabilityId,
      workspaceId: cx.ws.workspaceId,
      taskId: cx.taskId,
      guard,
      inputHash: sha256(JSON.stringify(input)),
      outcome: { verb: outcome.verb, recommendation: outcome.recommendation === null ? null : safeText(outcome.recommendation, 120), reasonCode: outcome.reasonCode, counts: outcome.counts ?? {} },
      recordedAt: new Date(cx.nowMs).toISOString(),
    };
    const meta = await cx.ws.evidence.put({ workspaceId: cx.ws.workspaceId, kind: 'capability-record', bytes: new TextEncoder().encode(JSON.stringify(record)), nowMs: cx.nowMs });
    return meta.handle;
  } catch {
    return null;
  }
}

/** Adds the evidence record to an advice envelope (its handle first in evidenceIds). */
async function withRecord(cx: CapabilityContext, a: CapabilityAdvice, guard: CapabilityGuardResult, input: Rec, counts?: { readonly [k: string]: number }): Promise<CapabilityAdvice> {
  const handle = await recordOf(cx, a.capabilityId, guard, input, { verb: a.verb, recommendation: a.recommendation, reasonCode: a.reasonCode, ...(counts === undefined ? {} : { counts }) });
  return handle === null ? a : { ...a, evidenceIds: [handle, ...a.evidenceIds].slice(0, 64) };
}

/** A JSON payload stored as evidence (plans, proposals, reports) for evidence.get. */
async function putJson(cx: CapabilityContext, kind: string, value: unknown): Promise<string | null> {
  try {
    return (await cx.ws.evidence.put({ workspaceId: cx.ws.workspaceId, kind, bytes: new TextEncoder().encode(JSON.stringify(value)), nowMs: cx.nowMs })).handle;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ C32 native workflow and team

/**
 * Native orchestration each harness documents (SSOT §3.4, S29, S30). Claude Code has dynamic
 * workflows and experimental agent teams; the other harnesses document neither, so a DAG under
 * the SDK-owned scheduler is the only route there.
 */
export const NATIVE_ORCHESTRATION: { readonly [harness: string]: { readonly workflow: boolean; readonly team: boolean; readonly note: string } } = Object.freeze({
  claude: { workflow: true, team: true, note: 'dynamic workflows (agent, pipeline, parallel); agent teams are experimental' },
  codex: { workflow: false, team: false, note: 'no documented native workflow or team runtime' },
  opencode: { workflow: false, team: false, note: 'no documented native workflow or team runtime' },
  kilocode: { workflow: false, team: false, note: 'no documented native workflow or team runtime' },
  antigravity: { workflow: false, team: false, note: 'no documented native workflow or team runtime' },
});

export interface BridgeProbe {
  readonly nonce: string;
  readonly harness: string;
  readonly harnessVersion: string | null;
  readonly status: 'pending' | 'reached' | 'unreachable' | 'expired';
  readonly startedAtMs: number;
  readonly expiresAtMs: number;
  readonly reportedAtMs: number | null;
}

const PROBE_TTL_MS = 10 * 60_000;
const PROBE_VALID_MS = 30 * 86_400_000;

const PROBES = 'bridge-probes';

/**
 * Bridge probes live in the host ledger: whether an isolated workflow script can reach Jev is a
 * property of this machine and harness, not of one project (coordinator, C's machine-wide
 * learning design). Rows an earlier release kept in a workspace ledger are moved to the host
 * ledger on first read, with their times, so a proof keeps its 30-day validity.
 */
async function adoptWorkspaceProbes(cx: CapabilityContext): Promise<void> {
  const old = cx.ws.state.list<BridgeProbe>(PROBES);
  if (old.length === 0) return;
  await cx.ws.host.transact((tx) => {
    for (const p of old) if (typeof p.nonce === 'string' && tx.get<BridgeProbe>(PROBES, p.nonce) === undefined) tx.put(PROBES, p.nonce, p);
  });
  await cx.ws.state.transact((tx) => {
    for (const p of old) if (typeof p.nonce === 'string') tx.delete(PROBES, p.nonce);
  });
}

async function probesFor(cx: CapabilityContext, harness: string): Promise<readonly BridgeProbe[]> {
  await adoptWorkspaceProbes(cx);
  return cx.ws.host.list<BridgeProbe>(PROBES).filter((p) => p.harness === harness).map((p) => (p.status === 'pending' && p.expiresAtMs <= cx.nowMs ? { ...p, status: 'expired' as const } : p));
}

/** E35 feasibility gate: a probe from an isolated workflow script reached Jev within 30 days. */
export function workflowBridgeProven(probes: readonly BridgeProbe[], nowMs: number): boolean {
  return probes.some((p) => p.status === 'reached' && p.reportedAtMs !== null && nowMs - p.reportedAtMs <= PROBE_VALID_MS);
}

const C32: CapabilityDefinition = {
  id: 'C32',
  title: 'Native workflow/team advisory',
  primitive: 'Choice',
  async handle(cx, input) {
    const harness = (strOf(input, 'harness', 32) || 'claude').toLowerCase();
    const native = NATIVE_ORCHESTRATION[harness];
    if (native === undefined) return abstainAdvice(C32, 'UNKNOWN_HARNESS', 'Name one of the supported harnesses: claude, codex, opencode, kilocode or antigravity.');
    const action = strOf(input, 'action', 32) || 'advise';
    if (action === 'probe-start') {
      // The probe script runs inside the harness's isolated workflow runtime and reports back with the nonce.
      const nonce = randomBytes(16).toString('hex');
      const probe: BridgeProbe = { nonce, harness, harnessVersion: strOf(input, 'harnessVersion', 64) || null, status: 'pending', startedAtMs: cx.nowMs, expiresAtMs: cx.nowMs + PROBE_TTL_MS, reportedAtMs: null };
      await cx.ws.host.transact((tx) => tx.put(PROBES, nonce, probe));
      const a = advice(C32, {
        verb: 'report',
        summary: `Bridge probe ${nonce.slice(0, 8)} started for ${harness}. From inside an isolated workflow script, ask Jevris a no-op question and report the result with this nonce within 10 minutes; silence records the bridge as unproven.`,
        recommendation: nonce,
        notes: ['The probe proves reachability only. A probe never grants authority, and Jev calls from a script still pass the sidecar budget and egress checks.'],
        reasonCode: 'PROBE_STARTED',
      });
      return withRecord(cx, a, { id: 'E35-bridge-probe', passed: false, reasonCode: 'PROBE_PENDING' }, { action, harness });
    }
    if (action === 'probe-report') {
      const nonce = strOf(input, 'nonce', 64);
      await adoptWorkspaceProbes(cx);
      const probe = cx.ws.host.get<BridgeProbe>(PROBES, nonce);
      if (probe === undefined || probe.harness !== harness || probe.status !== 'pending') return abstainAdvice(C32, 'UNKNOWN_PROBE', 'No pending bridge probe has that nonce.');
      const status: BridgeProbe['status'] = probe.expiresAtMs <= cx.nowMs ? 'expired' : input['reached'] === true ? 'reached' : 'unreachable';
      await cx.ws.host.transact((tx) => tx.put(PROBES, nonce, { ...probe, status, reportedAtMs: cx.nowMs }));
      const a = advice(C32, { verb: 'report', summary: `Bridge probe recorded for ${harness}: ${status}.`, recommendation: status, reasonCode: `PROBE_${status.toUpperCase()}` });
      return withRecord(cx, a, { id: 'E35-bridge-probe', passed: status === 'reached', reasonCode: `PROBE_${status.toUpperCase()}` }, { action, harness });
    }
    const tasks = listTasks(cx.ws).filter((t) => !['verified', 'cancelled'].includes(t.node.state));
    const edges = tasks.reduce((n, t) => n + t.node.dependencyIds.length, 0);
    const collaborative = input['collaborative'] === true;
    const probes = await probesFor(cx, harness);
    const bridge = workflowBridgeProven(probes, cx.nowMs);
    const options: { [key: string]: string } = { dag: 'Jevris DAG scheduler with SDK-owned workers (always supported).' };
    if (native.workflow) options['native-workflow'] = 'The harness native workflow runtime for predictable fan-out.';
    if (native.team) options['agent-team'] = 'An agent team, for genuinely collaborative work (experimental).';
    const rules = () =>
      collaborative && native.team ? { choice: 'agent-team', reasonCode: 'COLLABORATIVE_TASK' } : native.workflow && tasks.length >= 3 && edges === 0 ? { choice: 'native-workflow', reasonCode: 'INDEPENDENT_FAN_OUT' } : { choice: 'dag', reasonCode: native.workflow || native.team ? 'PREDICTABLE_DEPENDENCIES' : 'NO_NATIVE_SUPPORT' };
    const got = await consultChoice(cx.engine, {
      capabilityId: 'C32',
      specVersion: '1',
      objective: 'Recommend how to coordinate the owned tasks. Only options the harness supports are listed.',
      workspaceId: cx.ws.workspaceId,
      evidenceRevision: sha256(`${harness}:${String(tasks.length)}:${String(edges)}:${String(collaborative)}`).slice(0, 32),
      evidence: [],
      facts: { harness, openTasks: tasks.length, dependencyEdges: edges, collaborative, nativeWorkflow: native.workflow, agentTeam: native.team },
      instructions: 'Which coordination fits these tasks best?',
      options,
      rules,
      ...remaining(cx),
    });
    const inWorkflow = got.value === 'native-workflow' || got.value === 'agent-team';
    const a = advice(
      C32,
      {
        verb: 'rank',
        summary: `${got.value === 'dag' ? 'Use the Jevris DAG scheduler' : got.value === 'native-workflow' ? `Use the ${harness} native workflow` : `Use a ${harness} agent team`} for ${String(tasks.length)} open tasks.${inWorkflow ? (bridge ? ' A recorded bridge probe shows workflow scripts can reach Jev.' : ' Keep Jev decisions in the SDK-owned orchestrator: no bridge probe has shown that isolated workflow scripts can reach Jev.') : ''}`,
        recommendation: got.value,
        ranked: Object.entries(options).map(([id, label]) => ({ id, label, score: id === got.value ? 1 : 0.5, reason: native.note })),
        kept: inWorkflow && !bridge ? ['jev-outside-workflow-scripts'] : [],
        validation: inWorkflow && !bridge ? ['Run a bridge probe (C32 action probe-start, then probe-report from the script).'] : [],
        requiresApproval: got.value === 'agent-team',
        notes: [`${harness}: ${native.note}.`, 'Nothing is started; the recommendation is advice.'],
      },
      got,
    );
    return withRecord(cx, a, { id: 'E35-bridge-probe', passed: bridge, reasonCode: bridge ? 'BRIDGE_PROVEN' : 'BRIDGE_UNPROVEN' }, input, { openTasks: tasks.length, probes: probes.length });
  },
};

// ------------------------------------------------------------ C40 visual-work evidence bridge

const IMAGE_TOOL = /screenshot|visual|playwright|puppeteer|percy|chromatic|storybook|image|snapshot|browser/i;
const VISION_CHECK = /vision|visual-regression|pixel|percy|chromatic|snapshot|image-diff/i;
const SEVERITY = /\b(overlap|overflow|clip|cut off|missing|broken|invisible|contrast|misalign|unreadable|blank|error)\w*/i;

const C40: CapabilityDefinition = {
  id: 'C40',
  title: 'Visual-work evidence bridge',
  primitive: 'Score',
  async handle(cx, input) {
    const findings = recsOf(input, 'findings', 64)
      .map((f) => ({ id: strOf(f, 'id', 64), text: strOf(f, 'text', 500), source: strOf(f, 'source', 32) }))
      .filter((f) => ID.test(f.id) && f.text.trim() !== '' && ['screenshot', 'accessibility-tree', 'vision-model'].includes(f.source));
    const assertions = recsOf(input, 'assertions', 32);
    if (findings.length === 0 && assertions.length === 0) return abstainAdvice(C40, 'NO_FINDINGS', 'Pass textual findings (screenshot, accessibility-tree or vision-model observations) or visual assertions.');
    const manifests = new Map(approvedManifests(cx.ws).map((m) => [m.id, m]));
    const receipt = (id: string) => (id === '' ? undefined : cx.ws.receipts.get(cx.ws.workspaceId, id));
    const passedFrom = (id: string, pattern: RegExp) => {
      const r = receipt(id);
      const m = r === undefined ? undefined : manifests.get(r.receipt.checkId);
      return r !== undefined && r.validity === 'current' && r.receipt.outcome === 'passed' && m !== undefined && pattern.test(`${m.id} ${m.description}`) ? r : undefined;
    };
    // A visual assertion needs an image-capable tool receipt plus a vision or human verification record.
    const judged = assertions.map((a) => {
      const id = strOf(a, 'id', 64);
      const tool = passedFrom(strOf(a, 'toolReceiptId', 64), IMAGE_TOOL);
      const verification = isPlain(a['verification']) ? a['verification'] : {};
      const vision = strOf(verification, 'kind', 16) === 'vision' ? passedFrom(strOf(verification, 'receiptId', 64), VISION_CHECK) : undefined;
      const human = strOf(verification, 'kind', 16) === 'human' && strOf(verification, 'reviewer', 80) !== '' && !Number.isNaN(Date.parse(strOf(verification, 'reviewedAt', 40)));
      const sameRevision = vision === undefined || tool === undefined || vision.receipt.inputRevision.head === tool.receipt.inputRevision.head;
      const status = tool === undefined ? 'unsupported:no-image-tool-receipt' : vision !== undefined && sameRevision ? 'supported:vision-verified' : human ? 'pending:human-attested' : 'unsupported:no-verification';
      return { id: ID.test(id) ? id : `assertion-${sha256(JSON.stringify(a)).slice(0, 8)}`, claim: strOf(a, 'claim', 300), status, evidence: [tool?.receipt.id, vision?.receipt.id].filter((x): x is string => x !== undefined) };
    });
    const ranked: RankedItem[] = findings.map((f) => ({ id: f.id, label: f.text, score: (SEVERITY.test(f.text) ? 0.7 : 0.3) + (f.source === 'accessibility-tree' ? 0.1 : 0), reason: `from ${f.source}` })).sort(byScore);
    let consult: Consulted = { ...RULES, reasonCode: 'SEVERITY_TERMS' };
    const top = ranked[0];
    if (top !== undefined && cx.engine !== undefined) {
      consult = await consultScore(cx.engine, {
        capabilityId: 'C40',
        specVersion: '1',
        sendsWorkspaceText: true,
        objective: 'Rate how severe a textual visual finding is for users. It does not assert anything about pixels.',
        workspaceId: cx.ws.workspaceId,
        evidenceRevision: sha256(top.label).slice(0, 32),
        evidence: [{ id: 'finding', text: top.label, sourceKind: 'tool', priority: 'high' }],
        instructions: 'How severe is this finding for users?',
        anchors: ['Cosmetic: no effect on how the product works.', 'Minor: a small flaw that users can work around.', 'Noticeable defect.', 'Blocks or misleads users.'],
        rules: () => ({ score: Math.round((top.score ?? 0) * 3), reasonCode: 'SEVERITY_TERMS' }),
        ...remaining(cx),
      });
    }
    const unsupported = judged.filter((j) => !j.status.startsWith('supported'));
    const a = advice(
      C40,
      {
        verb: unsupported.length > 0 ? 'pause' : 'rank',
        summary: `${String(findings.length)} textual findings ranked; ${String(judged.length - unsupported.length)} of ${String(judged.length)} visual assertions carry an image-tool receipt and a vision verification.`,
        ranked: [...ranked, ...judged.map((j) => ({ id: j.id, label: j.claim || j.id, score: null, reason: j.status }))],
        kept: ['visual-assertion-needs-image-tool-and-verification'],
        validation: unsupported.map((j) => `${j.id}: ${j.status.split(':')[1] ?? j.status}`),
        requiresApproval: judged.some((j) => j.status === 'pending:human-attested'),
        evidenceIds: judged.flatMap((j) => j.evidence),
        notes: ['Jev ranks text only; no visual claim is accepted from text. A human attestation is recorded but still needs the user to confirm it.'],
      },
      consult,
    );
    return withRecord(cx, a, { id: 'C40-visual-assertion-evidence', passed: unsupported.length === 0, reasonCode: unsupported.length === 0 ? 'ALL_ASSERTIONS_SUPPORTED' : 'UNSUPPORTED_VISUAL_CLAIMS' }, input, { findings: findings.length, assertions: judged.length, unsupported: unsupported.length });
  },
};

// ------------------------------------------------------------ C62 release risk summary

const C62: CapabilityDefinition = {
  id: 'C62',
  title: 'Release risk summary',
  primitive: 'Score',
  async handle(cx, input) {
    const report = await verificationStatus(cx.ws, { taskId: cx.taskId, checkIds: [], git: cx.git, ...(cx.ws.store === undefined ? {} : { store: cx.ws.store }) });
    const risks: RankedItem[] = [];
    // Every risk cites its evidence: a receipt, a missing check, an incident id, the rollout plan or an exception id.
    for (const c of report.checks) if (c.mandatory && c.status !== 'passed') risks.push({ id: `check:${c.checkId}`, label: `${c.checkId} ${c.status}`, score: 1, reason: c.receiptId === null ? `evidence: no receipt for ${c.checkId}` : `evidence: receipt ${c.receiptId}` });
    for (const r of report.uncoveredRequirements.slice(0, 16)) risks.push({ id: `requirement:${r}`, label: `${r} has no check`, score: 0.8, reason: 'evidence: requirement map' });
    for (const i of recsOf(input, 'incidents', 64)) {
      const id = strOf(i, 'id', 64);
      const severity = strOf(i, 'severity', 16);
      if (!ID.test(id) || !['low', 'medium', 'high', 'critical'].includes(severity) || i['resolved'] === true) continue;
      risks.push({ id: `incident:${id}`, label: `unresolved ${severity} incident ${id}`, score: severity === 'critical' ? 1 : severity === 'high' ? 0.85 : severity === 'medium' ? 0.5 : 0.25, reason: `evidence: incident ${id}` });
    }
    const rollout = isPlain(input['rollout']) ? input['rollout'] : null;
    if (rollout !== null) {
      const stages = strsOf(rollout, 'stages', 16, 80);
      if (strOf(rollout, 'rollbackPlan', 500).trim() === '') risks.push({ id: 'rollout:no-rollback', label: 'the rollout plan has no rollback step', score: 0.8, reason: 'evidence: rollout plan' });
      if (stages.length < 2) risks.push({ id: 'rollout:no-canary', label: 'the rollout has no staged or canary step', score: 0.6, reason: 'evidence: rollout plan' });
    } else risks.push({ id: 'rollout:missing', label: 'no rollout plan was given', score: 0.5, reason: 'evidence: none supplied' });
    for (const e of recsOf(input, 'exceptions', 32)) {
      const id = strOf(e, 'id', 64);
      if (ID.test(id) && e['resolved'] !== true) risks.push({ id: `exception:${id}`, label: `unresolved exception ${id}`, score: 0.6, reason: `evidence: exception ${id}` });
    }
    risks.sort(byScore);
    const worst = risks[0]?.score ?? 0;
    let consult: Consulted = { ...RULES, reasonCode: 'EVIDENCE_RULES' };
    let jevLevel = 0;
    if (cx.engine !== undefined && risks.length > 0) {
      const got = await consultScore(cx.engine, {
        capabilityId: 'C62',
        specVersion: '1',
        sendsWorkspaceText: true,
        objective: 'Rate overall release risk from the listed evidence only. It decides nothing about deployment.',
        workspaceId: cx.ws.workspaceId,
        evidenceRevision: sha256(risks.map((r) => r.id).join(',')).slice(0, 32),
        evidence: risks.slice(0, 16).map((r, i) => ({ id: `r${String(i)}`, text: `${r.label} (${r.reason})`, sourceKind: 'receipt' as const, priority: 'high' as const })),
        facts: { risks: risks.length, verified: report.verified },
        instructions: 'How risky is this release given only this evidence?',
        anchors: ['Low: the evidence supports a normal release.', 'Moderate: release with extra monitoring.', 'High: release only with a rollback ready.', 'Do not release.'],
        rules: () => ({ score: Math.round(worst * 3), reasonCode: 'EVIDENCE_RULES' }),
        ...remaining(cx),
      });
      consult = got;
      if (got.source === 'jev') jevLevel = got.value / 3;
    }
    // Jev can raise the level from the evidence, never lower what the rules found.
    const level = Math.max(worst, jevLevel);
    const hold = level >= 0.8 || !report.verified;
    const a = advice(
      C62,
      {
        verb: 'report',
        summary: `${hold ? 'Hold' : 'Proceed with review'}: ${String(risks.length)} evidence-linked risks on ${report.revision.slice(0, 12)}. Deploying and rolling back stay with their owners.`,
        recommendation: hold ? 'hold' : 'proceed-with-review',
        ranked: risks,
        kept: ['deployment-authority-separate', 'rollback-authority-separate', ...report.mandatoryCheckIds],
        validation: report.missingEvidence.slice(0, 16),
        requiresApproval: true,
        evidenceIds: report.checks.map((c) => c.receiptId).filter((x): x is string => x !== null),
        notes: ['Every listed risk names its evidence; nothing without evidence is claimed.'],
      },
      consult,
    );
    return withRecord(cx, a, { id: 'C62-evidence-linked', passed: risks.every((r) => r.reason.startsWith('evidence:')), reasonCode: 'EVIDENCE_LINKED' }, input, { risks: risks.length });
  },
};

// ------------------------------------------------------------ C65 portfolio compute allocation

/** Fields that would profile a person; present fields are ignored and reported. */
const IDENTITY_FIELD = /^(user|userId|author|email|developer|owner|assignee|team|login|name|person)$/i;

export interface AllocationOption {
  readonly taskId: string;
  readonly modelId: string;
  readonly expectedQuality: number;
  readonly costMicroUsd: number;
}

export interface Allocation {
  readonly funded: readonly { readonly taskId: string; readonly modelId: string; readonly costMicroUsd: number; readonly expectedQuality: number; readonly upgraded: boolean }[];
  readonly deferred: readonly { readonly taskId: string; readonly reason: 'NO_OPTION_MEETS_FLOOR' | 'BUDGET_SHORT' }[];
  readonly spentMicroUsd: number;
}

/**
 * Floors first, then discretionary spend: every task gets its cheapest option that meets the
 * quality floor (in priority order until the budget runs out; the rest are deferred, never funded
 * below the floor), then leftover budget buys the upgrades with the best priority-weighted quality
 * gain per micro-dollar.
 */
export function allocateCompute(options: readonly AllocationOption[], priorities: ReadonlyMap<string, number>, floor: number, budgetMicroUsd: number): Allocation {
  const byTask = new Map<string, AllocationOption[]>();
  for (const o of options) byTask.set(o.taskId, [...(byTask.get(o.taskId) ?? []), o]);
  const order = [...byTask.keys()].sort((a, b) => (priorities.get(b) ?? 1) - (priorities.get(a) ?? 1) || (a < b ? -1 : 1));
  const chosen = new Map<string, AllocationOption>();
  const deferred: { taskId: string; reason: 'NO_OPTION_MEETS_FLOOR' | 'BUDGET_SHORT' }[] = [];
  let spent = 0;
  for (const taskId of order) {
    const fit = (byTask.get(taskId) ?? []).filter((o) => o.expectedQuality >= floor).sort((a, b) => a.costMicroUsd - b.costMicroUsd || b.expectedQuality - a.expectedQuality);
    const cheapest = fit[0];
    if (cheapest === undefined) deferred.push({ taskId, reason: 'NO_OPTION_MEETS_FLOOR' });
    else if (spent + cheapest.costMicroUsd > budgetMicroUsd) deferred.push({ taskId, reason: 'BUDGET_SHORT' });
    else {
      chosen.set(taskId, cheapest);
      spent += cheapest.costMicroUsd;
    }
  }
  const upgraded = new Set<string>();
  for (;;) {
    let best: { taskId: string; option: AllocationOption; ratio: number } | null = null;
    for (const [taskId, current] of chosen) {
      for (const o of byTask.get(taskId) ?? []) {
        const extra = o.costMicroUsd - current.costMicroUsd;
        const gain = (o.expectedQuality - current.expectedQuality) * (priorities.get(taskId) ?? 1);
        if (gain <= 0 || extra <= 0 || spent + extra > budgetMicroUsd) continue;
        const ratio = gain / extra;
        if (best === null || ratio > best.ratio || (ratio === best.ratio && taskId < best.taskId)) best = { taskId, option: o, ratio };
      }
    }
    if (best === null) break;
    spent += best.option.costMicroUsd - (chosen.get(best.taskId)?.costMicroUsd ?? 0);
    chosen.set(best.taskId, best.option);
    upgraded.add(best.taskId);
  }
  return {
    funded: [...chosen.values()].map((o) => ({ taskId: o.taskId, modelId: o.modelId, costMicroUsd: o.costMicroUsd, expectedQuality: o.expectedQuality, upgraded: upgraded.has(o.taskId) })).sort((a, b) => (a.taskId < b.taskId ? -1 : 1)),
    deferred,
    spentMicroUsd: spent,
  };
}

const C65: CapabilityDefinition = {
  id: 'C65',
  title: 'Portfolio-level compute allocation',
  primitive: 'Score',
  async handle(cx, input) {
    const owned = listTasks(cx.ws).filter((t) => !['verified', 'cancelled'].includes(t.node.state));
    const ownedIds = new Set(owned.map((t) => t.node.id));
    const raw = recsOf(input, 'options', 512);
    const identityFields = [...new Set(raw.flatMap((o) => Object.keys(o).filter((k) => IDENTITY_FIELD.test(k))))];
    const options: AllocationOption[] = raw
      .map((o) => ({ taskId: strOf(o, 'taskId', 64), modelId: strOf(o, 'modelId', 128), expectedQuality: numOf(o, 'expectedQuality', 0, 1, -1), costMicroUsd: numOf(o, 'costMicroUsd', 0, 1e12, -1) }))
      .filter((o) => ownedIds.has(o.taskId) && ID.test(o.modelId) && o.expectedQuality >= 0 && o.costMicroUsd >= 0);
    if (options.length === 0) return abstainAdvice(C65, 'NO_OPTIONS', 'Pass options { taskId, modelId, expectedQuality, costMicroUsd } for owned open tasks.');
    const floor = numOf(input, 'qualityFloor', 0, 1, 0.8);
    const budget = numOf(input, 'budgetMicroUsd', 0, 1e12, 0);
    // Queue priority from the graph only: a task that unblocks others comes first. No identity is read.
    const dependents = new Map<string, number>();
    for (const t of owned) for (const d of t.node.dependencyIds) dependents.set(d, (dependents.get(d) ?? 0) + 1);
    const priorities = new Map(owned.map((t) => [t.node.id, 1 + (dependents.get(t.node.id) ?? 0)]));
    const plan = allocateCompute(options, priorities, floor, budget);
    const a = advice(C65, {
      verb: 'rank',
      summary: `${String(plan.funded.length)} tasks funded at or above the ${String(floor)} quality floor for ${String(plan.spentMicroUsd)} of ${String(budget)} micro-USD; ${String(plan.deferred.length)} deferred.`,
      recommendation: plan.deferred.length === 0 ? 'fund-all' : 'defer-some',
      ranked: [
        ...plan.funded.map((f) => ({ id: f.taskId, label: `${f.taskId}: ${f.modelId}`, score: f.expectedQuality, reason: `${String(f.costMicroUsd)} micro-USD${f.upgraded ? '; upgraded with discretionary budget' : ''}` })),
        ...plan.deferred.map((d) => ({ id: d.taskId, label: `${d.taskId}: deferred`, score: null, reason: d.reason })),
      ],
      kept: ['quality-floor'],
      notes: [identityFields.length > 0 ? `Ignored identity fields: ${identityFields.join(', ')}. Allocation uses task outcomes, priorities and budget only.` : 'Allocation uses task outcomes, queue priorities and the budget only; no identity is read.', 'Nothing is reserved or launched; reservations happen when a task starts.'],
      reasonCode: identityFields.length > 0 ? 'IDENTITY_FIELDS_IGNORED' : 'FLOORS_FIRST',
    });
    return withRecord(cx, a, { id: 'C65-no-identity-profiling', passed: true, reasonCode: identityFields.length > 0 ? 'IDENTITY_FIELDS_IGNORED' : 'NO_IDENTITY_FIELDS' }, { options: options.length, floor, budget }, { funded: plan.funded.length, deferred: plan.deferred.length });
  },
};

// ------------------------------------------------------------ C66 task-specific learned router

async function calibrationKeysOf(engine: unknown): Promise<ReadonlyMap<string, string>> {
  const e = engine as { calibrationKeys?: () => Promise<ReadonlyMap<string, string>> } | null | undefined;
  try {
    return typeof e?.calibrationKeys === 'function' ? await e.calibrationKeys() : new Map();
  } catch {
    return new Map();
  }
}

const C66: CapabilityDefinition = {
  id: 'C66',
  title: 'Task-specific learned router',
  primitive: 'Offline',
  async handle(cx, input) {
    const action = strOf(input, 'action', 32) || 'status';
    const baselineModelId = strOf(input, 'baselineModelId', 128);
    if (action === 'train' || action === 'synthetic') {
      let train: readonly RouterExample[];
      let holdout: readonly RouterExample[];
      if (action === 'synthetic') {
        const models = recsOf(input, 'models', 8).map((m) => ({ modelId: strOf(m, 'modelId', 128), skill: numOf(m, 'skill', -10, 10, 0), costMicroUsd: numOf(m, 'costMicroUsd', 0, 1e10, 0) })).filter((m) => ID.test(m.modelId));
        const seed = numOf(input, 'seed', 0, 2 ** 31, 1);
        train = syntheticRoutingExamples(seed, numOf(input, 'trainCount', 10, 5000, 600), models);
        holdout = syntheticRoutingExamples(seed + 1, numOf(input, 'holdoutCount', 10, 5000, 300), models);
      } else {
        train = recsOf(input, 'train', 2000) as unknown as RouterExample[];
        holdout = recsOf(input, 'holdout', 2000) as unknown as RouterExample[];
      }
      const trained = trainLearnedRouter(train, holdout, { qualityFloor: numOf(input, 'qualityFloor', 0, 1, 0.8), baselineModelId, trainedAt: new Date(cx.nowMs).toISOString() });
      if (!trained.ok) return withRecord(cx, abstainAdvice(C66, trained.reasonCode, `Training refused: ${trained.reasonCode}${trained.detail === undefined ? '' : ` (${safeText(trained.detail, 60)})`}.`), { id: 'C66-consented-features', passed: false, reasonCode: trained.reasonCode }, { action });
      const artifact = trained.artifact;
      await cx.ws.host.transact((tx) => tx.put('learned-routers', artifact.id, { artifact, review: null }));
      const h = artifact.holdout;
      const a = advice(C66, {
        verb: 'report',
        summary: `Candidate ${artifact.id} trained offline on ${String(artifact.trainingTasks)} tasks; holdout regret ${String(h.learned.regret)} against ${String(h.existingRouter.regret)} for the existing router. It is not deployed: it needs a signed review${h.improvesOnRouter ? '' : ', and it shows no held-out improvement'}.`,
        recommendation: artifact.id,
        ranked: [
          { id: 'learned', label: `learned: success ${String(h.learned.successRate)}, cost ${String(h.learned.meanCostMicroUsd)}`, score: h.learned.successRate, reason: `regret ${String(h.learned.regret)}` },
          { id: 'existing-router', label: `existing router: success ${String(h.existingRouter.successRate)}, cost ${String(h.existingRouter.meanCostMicroUsd)}`, score: h.existingRouter.successRate, reason: `regret ${String(h.existingRouter.regret)}` },
          { id: 'baseline', label: `${artifact.baselineModelId}: success ${String(h.baseline.successRate)}, cost ${String(h.baseline.meanCostMicroUsd)}`, score: h.baseline.successRate, reason: `regret ${String(h.baseline.regret)}` },
        ],
        kept: ['review-before-deployment'],
        validation: ['A reviewer signs a jevris-learned-router-review-1 record for this artifact with a trusted calibration key.'],
        requiresApproval: true,
        notes: [action === 'synthetic' ? 'Synthetic demonstration data; real training needs the consented corpus (EVL-13).' : `Datasets: ${artifact.datasetVersions.join(', ')}.`, 'A downstream estimator, not a Jev fine-tune.'],
        reasonCode: h.improvesOnRouter ? 'CANDIDATE_IMPROVES' : 'CANDIDATE_NO_IMPROVEMENT',
      });
      return withRecord(cx, a, { id: 'C66-review-before-deployment', passed: false, reasonCode: 'NOT_REVIEWED' }, { action, artifactId: artifact.id }, { trainingTasks: artifact.trainingTasks, holdoutTasks: h.tasks });
    }
    const artifactId = strOf(input, 'artifactId', 64);
    const stored = cx.ws.host.get<{ artifact: LearnedRouterArtifact; review: unknown }>('learned-routers', artifactId);
    if (stored === undefined) return abstainAdvice(C66, 'UNKNOWN_ARTIFACT', 'No learned-router candidate has that id.');
    const keys = await calibrationKeysOf(cx.engine);
    if (action === 'review') {
      const review = input['review'];
      const gate = learnedRouterDeployable(stored.artifact, review, keys);
      // Only a correctly signed review of this artifact is stored; a rejection is kept too.
      if (gate.deployable || gate.reasonCode === 'REVIEW_REJECTED' || gate.reasonCode === 'NO_HOLDOUT_IMPROVEMENT') await cx.ws.host.transact((tx) => tx.put('learned-routers', artifactId, { ...stored, review }));
      const a = advice(C66, { verb: 'report', summary: gate.deployable ? `${artifactId} is deployable for advice (review signed by ${gate.keyId}). It still never actuates.` : `${artifactId} is not deployable: ${gate.reasonCode}.`, recommendation: gate.deployable ? 'deployable' : 'not-deployable', reasonCode: gate.deployable ? 'REVIEWED' : gate.reasonCode, requiresApproval: !gate.deployable });
      return withRecord(cx, a, { id: 'C66-review-before-deployment', passed: gate.deployable, reasonCode: gate.deployable ? 'REVIEWED' : gate.reasonCode }, { action, artifactId });
    }
    const features = isPlain(input['features']) ? (input['features'] as { readonly [k: string]: number }) : {};
    const routed = learnedRouteAdvice(stored.artifact, stored.review, keys, features);
    const a =
      routed.outcome === 'abstain'
        ? abstainAdvice(C66, routed.reasonCode, `The learned router gives no advice: ${routed.reasonCode}. The existing router stays in charge.`)
        : advice(C66, { verb: 'rank', summary: `Learned-router advice: ${routed.modelId}. Advice only; the model is not changed.`, recommendation: routed.modelId, ranked: routed.ranked.map((r) => ({ id: r.modelId, label: r.modelId, score: r.predictedSuccess, reason: `mean cost ${String(r.meanCostMicroUsd)} micro-USD` })), reasonCode: routed.reasonCode });
    return withRecord(cx, a, { id: 'C66-review-before-deployment', passed: routed.outcome === 'recommend', reasonCode: routed.reasonCode }, { action, artifactId });
  },
};

// ------------------------------------------------------------ C67 question improvement proposals

export interface QuestionSpecDraft {
  readonly instructions: string;
  readonly options: { readonly [id: string]: string };
  readonly mandatoryEvidence: readonly string[];
  /** A number from 0 to 1, or null for none (an absent or out-of-range value reads as none). A candidate with none where the live draft has one lowers it. */
  readonly threshold: number | null;
}

function specOf(value: unknown): QuestionSpecDraft | null {
  if (!isPlain(value)) return null;
  const options = isPlain(value['options']) ? Object.fromEntries(Object.entries(value['options']).filter(([k, v]) => ID.test(k) && typeof v === 'string').slice(0, 32).map(([k, v]) => [k, String(v).slice(0, 300)])) : {};
  const instructions = strOf(value, 'instructions', 600);
  if (instructions.trim() === '' || Object.keys(options).length < 2) return null;
  const t = value['threshold'];
  return { instructions, options, mandatoryEvidence: strsOf(value, 'mandatoryEvidence', 32, 64), threshold: typeof t === 'number' && t >= 0 && t <= 1 ? t : null };
}

const ABSTAIN_OPTIONS = ['none', 'unknown', 'abstain'];

/** The text of a draft the proposal keeps, under fixed field names (an option key or a caller's own name is never a field name). */
function draftText(name: 'current' | 'candidate', draft: QuestionSpecDraft): KeptText[] {
  return [
    { field: `${name}.instructions`, text: draft.instructions },
    ...Object.entries(draft.options).flatMap(([key, text]) => [{ field: `${name}.options`, text: key }, { field: `${name}.options`, text }]),
    ...draft.mandatoryEvidence.map((text) => ({ field: `${name}.mandatoryEvidence`, text })),
  ];
}

/** The ways a proposal would weaken a safety property of the live spec; any one refuses it. */
export function safetyRegressions(current: QuestionSpecDraft, candidate: QuestionSpecDraft): readonly string[] {
  const out: string[] = [];
  for (const o of ABSTAIN_OPTIONS) if (Object.hasOwn(current.options, o) && !Object.hasOwn(candidate.options, o)) out.push(`removes the ${o} option`);
  for (const e of current.mandatoryEvidence) if (!candidate.mandatoryEvidence.includes(e)) out.push(`drops mandatory evidence ${e}`);
  if (current.threshold !== null && (candidate.threshold === null || candidate.threshold < current.threshold)) out.push('lowers the decision threshold');
  if (/\b(always|never)\s+(choose|answer|pick)|do not abstain|never abstain/i.test(candidate.instructions)) out.push('forbids abstention in its instructions');
  return out;
}

const C67: CapabilityDefinition = {
  id: 'C67',
  title: 'Automatic question improvement proposals',
  primitive: 'Score',
  async handle(cx, input) {
    const specId = strOf(input, 'specId', 64);
    const current = specOf(input['current']);
    const candidate = specOf(input['candidate']);
    if (!ID.test(specId) || current === null || candidate === null) return abstainAdvice(C67, 'SPEC_REQUIRED', 'Pass specId and the current and candidate specs ({ instructions, options, mandatoryEvidence, threshold }).');
    const misses = recsOf(input, 'misclassifications', 128).map((m) => ({ expected: strOf(m, 'expected', 64), got: strOf(m, 'got', 64) })).filter((m) => ID.test(m.expected));
    // The proposal is kept (an evidence blob, a proposals branch) and the drafts are sent to Jev, so the text is screened for
    // credentials first. Request screening does not cover what is only stored, and a request with egress denied withholds the text.
    const refused = refuseSecrets(C67, [{ field: 'specId', text: specId }, ...draftText('current', current), ...draftText('candidate', candidate), ...misses.flatMap((m) => [{ field: 'misclassifications', text: m.expected }, { field: 'misclassifications', text: m.got }])]);
    if (refused !== null) return refused;
    const regressions = safetyRegressions(current, candidate);
    const coveredNow = misses.filter((m) => Object.hasOwn(candidate.options, m.expected) && !Object.hasOwn(current.options, m.expected)).length;
    let consult: Consulted = { ...RULES, reasonCode: 'COVERAGE_RULES' };
    if (regressions.length === 0 && cx.engine !== undefined) {
      consult = await consultScore(cx.engine, {
        capabilityId: 'C67',
        specVersion: '1',
        sendsWorkspaceText: true,
        objective: 'Rate whether the candidate question is clearer than the current one for the listed misclassifications. It changes no live policy.',
        workspaceId: cx.ws.workspaceId,
        evidenceRevision: sha256(JSON.stringify([current, candidate])).slice(0, 32),
        evidence: [
          { id: 'current', text: `${current.instructions} Options: ${Object.keys(current.options).join(', ')}`, sourceKind: 'policy', priority: 'mandatory' },
          { id: 'candidate', text: `${candidate.instructions} Options: ${Object.keys(candidate.options).join(', ')}`, sourceKind: 'policy', priority: 'mandatory' },
        ],
        facts: { misclassifications: misses.length, newlyCovered: coveredNow },
        instructions: 'How much clearer is the candidate question?',
        anchors: ['Worse: the revision is less clear than the current version.', 'No clearer than the current version.', 'Somewhat clearer than the current version.', 'Much clearer than the current version.'],
        rules: () => ({ score: coveredNow > 0 ? 2 : 1, reasonCode: 'COVERAGE_RULES' }),
        ...remaining(cx),
      });
    }
    if (regressions.length > 0) {
      const a = advice(C67, { verb: 'pause', summary: `Proposal refused: it would weaken a safety check (${regressions.join('; ')}).`, recommendation: 'refused', ranked: regressions.map((r, i) => ({ id: `regression-${String(i + 1)}`, label: r, score: null, reason: 'safety check' })), reasonCode: 'SAFETY_REGRESSION' });
      return withRecord(cx, a, { id: 'C67-no-safety-regression', passed: false, reasonCode: 'SAFETY_REGRESSION' }, { specId }, { regressions: regressions.length });
    }
    const proposal = { schemaVersion: 'jevris-question-proposal-1', specId, current, candidate, misclassifications: misses.length, newlyCovered: coveredNow, proposedAt: new Date(cx.nowMs).toISOString(), live: false };
    const proposalId = `${specId}-${sha256(JSON.stringify(proposal)).slice(0, 12)}`;
    let branch: string | null = null;
    if (input['writeBranch'] === true) branch = await writeProposalBranch(cx, proposalId, JSON.stringify(proposal, null, 2));
    const handle = await putJson(cx, 'question-proposal', proposal);
    const a = advice(
      C67,
      {
        verb: 'report',
        summary: branch === null ? `Proposal ${proposalId} prepared; it is not live. ${input['writeBranch'] === true ? 'The proposal branch could not be written.' : 'Pass writeBranch: true to write it to a jevris/proposals branch for review.'}` : `Proposal ${proposalId} written to branch ${branch} for review. Live policy is unchanged.`,
        recommendation: branch ?? proposalId,
        kept: ['live-policy-unchanged', 'held-out-evaluation-before-release'],
        validation: ['Evaluate the candidate on the frozen holdout (policy lab, C71) before any policy release.'],
        requiresApproval: true,
        evidenceIds: handle === null ? [] : [handle],
        notes: [`${String(coveredNow)} of ${String(misses.length)} misclassifications gain an option they needed.`],
      },
      consult,
    );
    return withRecord(cx, a, { id: 'C67-no-safety-regression', passed: true, reasonCode: 'NO_REGRESSION' }, { specId }, { misclassifications: misses.length });
  },
};

/**
 * Writes the proposal as the only file of a parentless commit on `jevris/proposals/<id>`,
 * through a private index, so HEAD, the index and the working tree are untouched. Create-only:
 * an existing branch is never moved.
 */
async function writeProposalBranch(cx: CapabilityContext, proposalId: string, text: string): Promise<string | null> {
  const root = cx.ws.workspaceRoot;
  const dir = join(cx.ws.dataDir, 'tmp', `proposal-${randomBytes(6).toString('hex')}`);
  const branch = `jevris/proposals/${proposalId}`;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, 'proposal.json');
    writeFileSync(file, text, { mode: 0o600 });
    const git = nodeGit(30_000, { GIT_INDEX_FILE: join(dir, 'index'), GIT_AUTHOR_NAME: 'Jevris', GIT_AUTHOR_EMAIL: 'jevris@localhost.invalid', GIT_COMMITTER_NAME: 'Jevris', GIT_COMMITTER_EMAIL: 'jevris@localhost.invalid' });
    const blob = await git.run(['hash-object', '-w', '--', file], root);
    if (!blob.ok) return null;
    if (!(await git.run(['update-index', '--add', '--cacheinfo', `100644,${blob.stdout.trim()},jevris-proposals/${proposalId}.json`], root)).ok) return null;
    const tree = await git.run(['write-tree'], root);
    if (!tree.ok) return null;
    const commit = await git.run(['-c', 'commit.gpgsign=false', 'commit-tree', tree.stdout.trim(), '-m', `Jevris question proposal ${proposalId} (not live)`], root);
    if (!commit.ok) return null;
    return (await git.run(['update-ref', `refs/heads/${branch}`, commit.stdout.trim(), ''], root)).ok ? branch : null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------ C68 safe speculative evaluation

const EXTERNAL_EFFECT = /\b(curl|wget|npm\s+(install|publish)|pip\s+install|git\s+push|docker\s+(push|run)|kubectl|terraform|aws|gcloud|az|ssh|scp)\b/i;

/** How often a candidate that does not come out clean is evaluated afresh before that verdict stands. */
const C68_ATTEMPTS = 3;
const C68_RETRY_PAUSE_MS = 40;
/** Why a removal of a restored speculative worktree can fail for a moment (Windows briefly denies a read or a delete). */
const C68_TRANSIENT_REMOVAL: ReadonlySet<string> = new Set(['DIRTY', 'STATUS_UNKNOWN', 'GIT_FAILED']);
const C68: CapabilityDefinition = {
  id: 'C68',
  title: 'Safe speculative evaluation',
  primitive: 'Choice',
  async handle(cx, input) {
    const candidates = recsOf(input, 'candidates', 4)
      .map((c) => ({ id: strOf(c, 'id', 32), patch: strOf(c, 'patch', 64 * 1024), commands: strsOf(c, 'commands', 8, 300) }))
      .filter((c) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(c.id) && c.patch.trim() !== '');
    if (candidates.length < 2) return abstainAdvice(C68, 'CANDIDATES_REQUIRED', 'Pass two to four candidates { id, patch } to compare.');
    const scopes = strsOf(input, 'allowedPaths', 64, 200);
    // External effects stay out: a candidate that needs one is listed for explicit authorization and never run.
    const external = candidates.filter((c) => c.commands.some((cmd) => EXTERNAL_EFFECT.test(cmd)) || EXTERNAL_EFFECT.test(c.patch.split('\n').filter((l) => l.startsWith('+')).join('\n')));
    const results = await Promise.all(
      candidates.map(async (c) => {
        const created = await createWorktree(cx.ws, { taskId: `spec-${c.id}`, allowedPaths: scopes.length > 0 ? scopes : ['**'] });
        if (!created.ok) return { id: c.id, applies: false, reason: created.reasonCode, changed: 0, violations: 0, removed: false };
        const wt = created.worktree;
        const dir = join(cx.ws.dataDir, 'tmp', `spec-${randomBytes(6).toString('hex')}`);
        try {
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          const patchFile = join(dir, 'candidate.patch');
          writeFileSync(patchFile, c.patch.endsWith('\n') ? c.patch : `${c.patch}\n`, { mode: 0o600 });
          // A verdict other than "applies in scope" is confirmed on a restored tree before it is
          // believed. On a just-written tree git can fail for a moment (Windows briefly denies a
          // read of a freshly written file, and git then reads the file as modified or fails the
          // apply), so one bad read must not rule a sound candidate out. A candidate that really
          // does not apply, or really writes outside scope, gives the same verdict every time.
          let applied = false;
          let scope: Awaited<ReturnType<typeof enforceAllowedPaths>> = { ok: false, changed: [], violations: [], unknown: true };
          for (let attempt = 0; attempt < C68_ATTEMPTS; attempt += 1) {
            if (attempt > 0) await new Promise<void>((resolve) => setTimeout(resolve, C68_RETRY_PAUSE_MS * attempt));
            applied = (await cx.git.run(['apply', '--whitespace=nowarn', '--', patchFile], wt.path)).ok;
            scope = await enforceAllowedPaths(wt, { git: cx.git });
            // Restore the tree so the owned worktree can be removed cleanly, and so a retry starts clean.
            await cx.git.run(['checkout', '--', '.'], wt.path);
            await cx.git.run(['clean', '-fdq'], wt.path);
            if (applied && scope.ok) break;
          }
          // The tree was restored above, so a worktree that reads dirty or unknown, or whose removal git fails, a moment later is the same
          // transient Windows denial as a failed read: it is tried again on a restored tree before it is left behind.
          let removed = await removeWorktree(cx.ws, wt.id, true, { git: cx.git });
          for (let attempt = 1; attempt < C68_ATTEMPTS && !removed.removed && C68_TRANSIENT_REMOVAL.has(removed.reasonCode ?? ''); attempt += 1) {
            await new Promise<void>((resolve) => setTimeout(resolve, C68_RETRY_PAUSE_MS * attempt));
            await cx.git.run(['checkout', '--', '.'], wt.path);
            await cx.git.run(['clean', '-fdq'], wt.path);
            removed = await removeWorktree(cx.ws, wt.id, true, { git: cx.git });
          }
          const reason = !applied ? 'does-not-apply' : scope.unknown ? 'scope-unknown' : scope.ok ? 'applies-in-scope' : 'writes-outside-scope';
          return { id: c.id, applies: applied, reason, changed: scope.changed.length, violations: scope.violations.length, removed: removed.removed };
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }),
    );
    const viable = results.filter((r) => r.reason === 'applies-in-scope' && !external.some((e) => e.id === r.id)).sort((a, b) => a.changed - b.changed || (a.id < b.id ? -1 : 1));
    const options: { [key: string]: string } = { none: 'No candidate is safe to continue with.' };
    // Numbered, so two candidates that change the same number of files are still two different options (equal texts are refused by the question lint).
    viable.forEach((r, i) => {
      options[r.id] = `Candidate ${String(i + 1)} of ${String(viable.length)} applies cleanly in scope, ${String(r.changed)} files changed`;
    });
    const got = await consultChoice(cx.engine, {
      capabilityId: 'C68',
      specVersion: '1',
      objective: 'Choose which isolated candidate path to continue with. Nothing is merged.',
      workspaceId: cx.ws.workspaceId,
      evidenceRevision: sha256(results.map((r) => `${r.id}:${r.reason}:${String(r.changed)}`).join(',')).slice(0, 32),
      evidence: [],
      facts: { candidates: candidates.length, viable: viable.length, external: external.length },
      instructions: 'Which candidate should continue?',
      options,
      rules: () => ({ choice: viable[0]?.id ?? 'none', reasonCode: viable.length > 0 ? 'SMALLEST_VIABLE' : 'NO_VIABLE_CANDIDATE' }),
      ...remaining(cx),
    });
    const a = advice(
      C68,
      {
        verb: 'rank',
        summary: `${String(candidates.length)} candidates evaluated in parallel in isolated worktrees; ${String(viable.length)} viable. Continue with ${got.value}. Nothing was merged or kept.`,
        recommendation: got.value,
        ranked: results.map((r) => ({ id: r.id, label: `${r.id}: ${r.reason}`, score: viable.some((v) => v.id === r.id) ? 1 / (1 + r.changed) : 0, reason: `${String(r.changed)} files changed, ${String(r.violations)} outside scope${r.removed ? '' : '; worktree retained for the user'}` })),
        kept: external.length > 0 ? external.map((e) => `external-effect-needs-authorization:${e.id}`) : [],
        requiresApproval: external.length > 0,
        notes: ['Speculative code stays in Jevris-owned worktrees, which are removed after evaluation; no command with an external effect is run.'],
      },
      got,
    );
    return withRecord(cx, a, { id: 'C68-isolated-and-authorized', passed: external.length === 0, reasonCode: external.length === 0 ? 'ISOLATED' : 'EXTERNAL_EFFECT_NEEDS_AUTHORIZATION' }, { candidates: candidates.map((c) => c.id) }, { candidates: candidates.length, viable: viable.length });
  },
};

// ------------------------------------------------------------ C69 cross-model disagreement triage

const C69: CapabilityDefinition = {
  id: 'C69',
  title: 'Cross-model disagreement triage',
  primitive: 'Score',
  async handle(cx, input) {
    const reports = recsOf(input, 'reports', 16)
      .map((r) => ({ id: strOf(r, 'id', 64), model: strOf(r, 'model', 128), conclusion: strOf(r, 'conclusion', 64), evidenceIds: strsOf(r, 'evidenceIds', 32, 140), sources: strsOf(r, 'sources', 64, 300) }))
      .filter((r) => ID.test(r.id) && r.model !== '' && ID.test(r.conclusion));
    if (reports.length < 2) return abstainAdvice(C69, 'REPORTS_REQUIRED', 'Pass at least two candidate reports { id, model, conclusion, evidenceIds, sources }.');
    // Actual evidence: a handle in this workspace's evidence store or a receipt id.
    const actual = (id: string) => cx.ws.evidence.metaIn(id, cx.ws.workspaceId) !== undefined || cx.ws.receipts.get(cx.ws.workspaceId, id) !== undefined;
    const scored = reports.map((r) => ({ ...r, backed: r.evidenceIds.filter(actual) }));
    const groups = new Map<string, typeof scored>();
    for (const r of scored) groups.set(r.conclusion, [...(groups.get(r.conclusion) ?? []), r]);
    const conclusions = [...groups.keys()].sort();
    const shared = (a: readonly string[], b: readonly string[]) => a.some((s) => b.includes(s));
    // Agreement counts as independent only between reports with disjoint sources.
    const independence = conclusions.map((c) => {
      const rs = groups.get(c) ?? [];
      let independentPairs = 0;
      let sharedPairs = 0;
      for (let i = 0; i < rs.length; i += 1) for (let j = i + 1; j < rs.length; j += 1) if (shared(rs[i]?.sources ?? [], rs[j]?.sources ?? [])) sharedPairs += 1;
      else independentPairs += 1;
      return { conclusion: c, reports: rs.length, backed: rs.filter((r) => r.backed.length > 0).length, independentPairs, sharedPairs };
    });
    const conflict = independence.filter((g) => g.backed > 0).length >= 2;
    const lead = independence.sort((a, b) => b.backed - a.backed || b.independentPairs - a.independentPairs || (a.conclusion < b.conclusion ? -1 : 1))[0];
    const verdict = conflict ? 'escalate' : lead !== undefined && lead.reports > 1 && lead.independentPairs === 0 ? 'agreement-shared-sources' : lead !== undefined && lead.backed === 0 ? 'unsupported' : 'agreement-independent';
    let consult: Consulted = { ...RULES, reasonCode: 'EVIDENCE_CONFLICT_RULES' };
    if (conflict && cx.engine !== undefined) {
      consult = await consultScore(cx.engine, {
        capabilityId: 'C69',
        specVersion: '1',
        objective: 'Rate how material the conflict between evidence-backed conclusions is. It does not pick a winner.',
        workspaceId: cx.ws.workspaceId,
        evidenceRevision: sha256(conclusions.join(',')).slice(0, 32),
        evidence: [],
        facts: { conclusions: conclusions.length, backedConclusions: independence.filter((g) => g.backed > 0).length },
        instructions: 'How material is this disagreement for the task?',
        anchors: ['Immaterial: the reports do not conflict in any way that matters.', 'Minor: the reports differ in a detail that does not change the plan.', 'Material: the reports differ in a way that changes the plan.', 'Blocking: the conflict must be resolved before any work continues.'],
        rules: () => ({ score: 2, reasonCode: 'EVIDENCE_CONFLICT_RULES' }),
        ...remaining(cx),
      });
    }
    const a = advice(
      C69,
      {
        verb: conflict ? 'ask' : 'report',
        summary:
          verdict === 'escalate'
            ? `Evidence-backed reports disagree (${conclusions.join(' vs ')}): escalate to a person or a deterministic check.`
            : verdict === 'agreement-shared-sources'
              ? `The reports agree on ${lead?.conclusion ?? ''}, but they share sources, so the agreement is not independent proof.`
              : verdict === 'unsupported'
                ? 'No report is backed by evidence recorded in this workspace.'
                : `The reports agree on ${lead?.conclusion ?? ''} from independent sources. Agreement is still not a verification.`,
        recommendation: verdict,
        ranked: independence.map((g) => ({ id: g.conclusion, label: `${g.conclusion}: ${String(g.reports)} reports`, score: g.backed / Math.max(1, g.reports), reason: `${String(g.backed)} evidence-backed; ${String(g.independentPairs)} independent and ${String(g.sharedPairs)} shared-source pairs` })),
        question: conflict ? 'Which check or evidence would settle this disagreement?' : null,
        validation: ['Run the check that decides the question; model agreement never replaces it.'],
        evidenceIds: [...new Set(scored.flatMap((r) => r.backed))],
      },
      consult,
    );
    return withRecord(cx, a, { id: 'C69-shared-sources-not-independent', passed: verdict !== 'agreement-shared-sources', reasonCode: verdict.toUpperCase().replace(/-/g, '_') }, { reports: reports.map((r) => r.id) }, { reports: reports.length, conclusions: conclusions.length });
  },
};

// ------------------------------------------------------------ C70 project-wide change campaign

const MODULE_MARKER = /(^|\/)(package\.json|Cargo\.toml|go\.mod|pyproject\.toml|setup\.py|pom\.xml|build\.gradle(\.kts)?|composer\.json|Gemfile|[^/]+\.csproj)$/;
export const CAMPAIGN_MAX_MODULES = 200;
export const CAMPAIGN_MAX_WAVE = 8;

const C70: CapabilityDefinition = {
  id: 'C70',
  title: 'Project-wide change campaign',
  primitive: 'Rules+Choice',
  async handle(cx, input) {
    const campaignId = strOf(input, 'campaignId', 48);
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(campaignId)) return abstainAdvice(C70, 'CAMPAIGN_ID_REQUIRED', 'Name the campaign (campaignId) and the migration contract.');
    const files = await listFiles(cx.git, cx.ws.workspaceRoot) ?? [];
    const named = strsOf(input, 'modules', CAMPAIGN_MAX_MODULES + 1, 200).filter((m) => !m.split(/[\\/]/).includes('..') && !isAbsoluteOnAnyPlatform(m));
    const discovered = [...new Set(files.filter((f) => MODULE_MARKER.test(f) && !/(^|\/)(node_modules|vendor|dist)\//.test(f)).map((f) => f.split('/').slice(0, -1).join('/')).filter((d) => d !== ''))].sort();
    // The plan is kept (an evidence blob) with the module paths and the campaign name a caller gives, so they are screened for credentials first.
    const refused = refuseSecrets(C70, [{ field: 'campaignId', text: campaignId }, ...named.map((text) => ({ field: 'modules', text })), { field: 'canary', text: strOf(input, 'canary', 200) }]);
    if (refused !== null) return refused;
    const modules = named.length > 0 ? named : discovered;
    if (modules.length === 0) return abstainAdvice(C70, 'NO_MODULES', 'No module inventory: name the modules or add module manifests.');
    if (modules.length > CAMPAIGN_MAX_MODULES) return abstainAdvice(C70, 'TOO_MANY_MODULES', `More than ${String(CAMPAIGN_MAX_MODULES)} modules: split the campaign. There is no unbounded agent swarm.`);
    const configured = readEffectiveConfig({ home: cx.home, workspaceRoot: cx.ws.workspaceRoot }).config as unknown as { orchestration?: { maxConcurrentWorkers?: number } };
    const maxWave = Math.max(1, Math.min(CAMPAIGN_MAX_WAVE, configured.orchestration?.maxConcurrentWorkers ?? CAMPAIGN_MAX_WAVE, numOf(input, 'waveSize', 1, CAMPAIGN_MAX_WAVE, CAMPAIGN_MAX_WAVE)));
    const manifests = approvedManifests(cx.ws);
    const size = new Map(modules.map((m) => [m, files.filter((f) => f === m || f.startsWith(`${m}/`)).length]));
    const checksFor = (m: string) => manifests.filter((c) => c.mandatory || inScopes(`${m}/x`, c.inputScopes)).map((c) => c.id); // path-hygiene: allow git-style relative module path, matched against scopes
    // Canary: the smallest module that an approved check covers, unless the caller names one.
    const canaryNamed = strOf(input, 'canary', 200);
    const covered = modules.filter((m) => checksFor(m).length > 0).sort((a, b) => (size.get(a) ?? 0) - (size.get(b) ?? 0) || (a < b ? -1 : 1));
    const options: { [key: string]: string } = {};
    for (const m of covered.slice(0, 8)) options[m.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'root'] = `${m}: ${String(size.get(m) ?? 0)} files, checks ${checksFor(m).join(', ')}`;
    const keyOf = (m: string) => m.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'root';
    let canary = modules.includes(canaryNamed) ? canaryNamed : (covered[0] ?? modules.slice().sort((a, b) => (size.get(a) ?? 0) - (size.get(b) ?? 0))[0] ?? '');
    let consult: Consulted = { ...RULES, reasonCode: covered.length > 0 ? 'SMALLEST_COVERED_MODULE' : 'NO_COVERED_MODULE' };
    if (!modules.includes(canaryNamed) && Object.keys(options).length > 1) {
      const got = await consultChoice(cx.engine, {
        capabilityId: 'C70',
        specVersion: '1',
        sendsWorkspaceText: true,
        objective: 'Pick the canary module for a staged migration: representative, covered by checks, cheap to roll back.',
        workspaceId: cx.ws.workspaceId,
        evidenceRevision: sha256(modules.join(',')).slice(0, 32),
        evidence: [{ id: 'contract', text: strOf(input, 'contract', 1500), sourceKind: 'user', priority: 'mandatory' }],
        instructions: 'Which module should be the canary?',
        options,
        rules: () => ({ choice: keyOf(canary), reasonCode: 'SMALLEST_COVERED_MODULE' }),
        ...remaining(cx),
      });
      canary = covered.find((m) => keyOf(m) === got.value) ?? canary;
      consult = got;
    }
    const rest = modules.filter((m) => m !== canary).sort((a, b) => (size.get(a) ?? 0) - (size.get(b) ?? 0) || (a < b ? -1 : 1));
    const waves: string[][] = [[canary]];
    for (let i = 0; i < rest.length; i += maxWave) waves.push(rest.slice(i, i + maxWave));
    const head = await cx.git.run(['rev-parse', 'HEAD'], cx.ws.workspaceRoot);
    const base = head.ok ? head.stdout.trim() : null;
    const taskId = (w: number, m: string) => `${campaignId}-w${String(w)}-${keyOf(m)}`.slice(0, 64);
    const tasks = waves.flatMap((wave, w) =>
      wave.map((m) => ({
        id: taskId(w, m),
        wave: w,
        module: m,
        writeScopes: [m],
        dependencyIds: w === 0 ? [] : waves[w - 1]?.map((p) => taskId(w - 1, p)) ?? [],
        acceptanceCheckIds: checksFor(m),
      })),
    );
    const plan = {
      schemaVersion: 'jevris-campaign-plan-1',
      campaignId,
      contractHash: sha256(strOf(input, 'contract', 4000)),
      baseCommit: base,
      maxConcurrent: maxWave,
      waves: waves.map((wave, w) => ({ wave: w, canary: w === 0, modules: wave, rollback: { kind: 'git-ref', ref: `refs/jevris/campaign/${campaignId}/wave-${String(w)}-base`, createAtWaveStart: true } })), // path-hygiene: allow git ref name, not a file path
      tasks,
    };
    const handle = await putJson(cx, 'campaign-plan', plan);
    const a = advice(
      C70,
      {
        verb: 'rank',
        summary: `Campaign ${campaignId}: canary ${canary}, then ${String(waves.length - 1)} waves of at most ${String(maxWave)} modules. Each wave waits for the previous one to verify and has a rollback ref. Submit the plan (evidence handle) through plan.submit to run it.`,
        recommendation: canary,
        ranked: tasks.slice(0, 64).map((t) => ({ id: t.id, label: `wave ${String(t.wave)}: ${t.module}`, score: null, reason: t.acceptanceCheckIds.length > 0 ? `checks ${t.acceptanceCheckIds.join(', ')}` : 'no approved check covers it' })),
        kept: ['canary-first', 'bounded-concurrency', 'rollback-per-wave'],
        validation: tasks.filter((t) => t.acceptanceCheckIds.length === 0).slice(0, 16).map((t) => `${t.module}: add an approved check before its wave`),
        requiresApproval: true,
        evidenceIds: handle === null ? [] : [handle],
      },
      consult,
    );
    return withRecord(cx, a, { id: 'C70-bounded-staged-waves', passed: maxWave <= CAMPAIGN_MAX_WAVE && modules.length <= CAMPAIGN_MAX_MODULES, reasonCode: 'BOUNDED' }, { campaignId, modules: modules.length }, { modules: modules.length, waves: waves.length });
  },
};

// ------------------------------------------------------------ C71 policy-evaluation laboratory

const C71: CapabilityDefinition = {
  id: 'C71',
  title: 'Autonomous policy-evaluation laboratory',
  primitive: 'Offline',
  async handle(cx, input) {
    const train = recsOf(input, 'train', 2000) as unknown as LabTask[];
    const test = recsOf(input, 'test', 2000) as unknown as LabTask[];
    const variants = recsOf(input, 'variants', 16).map((v) => ({ id: strOf(v, 'id', 64), qualityFloor: numOf(v, 'qualityFloor', -1, 2, -1), ...(Array.isArray(v['allowedModels']) ? { allowedModels: strsOf(v, 'allowedModels', 16, 128) } : {}) })) as PolicyVariant[];
    const result = runPolicyExperiment({
      train,
      test,
      variants,
      baselineModelId: strOf(input, 'baselineModelId', 128),
      frozenHoldoutIds: strsOf(input, 'frozenHoldoutIds', 5000, 128),
      evaluationBudget: numOf(input, 'evaluationBudget', 0, 1e6, 0),
    });
    if (!result.ok) {
      const failed = result.contamination?.checks.filter((c) => !c.passed).map((c) => `${c.id} (${String(c.findings)})`) ?? [];
      const a = advice(C71, { verb: 'pause', summary: `Experiment refused: ${result.reasonCode}${failed.length > 0 ? `: ${failed.join(', ')}` : ''}.`, recommendation: 'refused', reasonCode: result.reasonCode });
      return withRecord(cx, a, { id: 'C71-contamination-checks', passed: false, reasonCode: result.reasonCode }, { train: train.length, test: test.length }, { failedChecks: failed.length });
    }
    const report = result.report;
    const handle = await putJson(cx, 'policy-lab-report', report);
    const a = advice(C71, {
      verb: 'report',
      summary: `Experiment ${report.experimentId}: ${String(report.variants.length)} variants on ${String(test.length)} frozen test tasks, contamination checks passed. The report is for review; no policy changed.`,
      recommendation: report.experimentId,
      ranked: report.variants.map((v) => ({ id: v.id, label: `${v.id}: success ${String(v.metrics.successRate)}, cost ${String(v.metrics.meanCostMicroUsd)}`, score: v.metrics.successRate, reason: `regret ${String(v.metrics.regret)}` })).sort(byScore),
      kept: ['contamination-checks-mandatory', 'review-before-policy-release'],
      requiresApproval: true,
      evidenceIds: handle === null ? [] : [handle],
      reasonCode: 'CONTAMINATION_CHECKED',
    });
    return withRecord(cx, a, { id: 'C71-contamination-checks', passed: true, reasonCode: 'CONTAMINATION_CHECKED' }, { experimentId: report.experimentId }, { variants: report.variants.length, evaluations: report.evaluations });
  },
};

// ------------------------------------------------------------ C72 resource-constrained development

const C72: CapabilityDefinition = {
  id: 'C72',
  title: 'Resource-constrained and embedded development',
  primitive: 'Choice',
  async handle(cx, input) {
    const profile = profileWorkspace(cx.ws.workspaceRoot, { platform: cx.platform });
    const proposal = proposeChecks(profile, cx.ws.workspaceRoot, cx.platform);
    const manifests = approvedManifests(cx.ws);
    const attached = new Set(attachedHardware(cx.ws));
    const latest = cx.ws.receipts.latest(cx.ws.workspaceId, cx.taskId);
    const hardwareChecks = [...manifests.filter((m) => m.hardware !== null).map((m) => ({ id: m.id, hardware: m.hardware as string, approved: true })), ...proposal.checks.filter((c) => c.hardware !== undefined && !manifests.some((m) => m.id === c.id)).map((c) => ({ id: c.id, hardware: c.hardware as string, approved: false }))];
    const hostChecks = manifests.filter((m) => m.hardware === null);
    const hostPassed = hostChecks.filter((m) => latest.get(m.id)?.receipt.outcome === 'passed' && latest.get(m.id)?.validity === 'current');
    const hostFailed = hostChecks.map((m) => latest.get(m.id)).filter((r) => r !== undefined && r.receipt.outcome === 'failed');
    const deviceStatus = hardwareChecks.map((c) => {
      const r = latest.get(c.id);
      const status = r === undefined ? (attached.has(c.hardware) ? 'not-run' : 'needs-hardware-runner') : r.receipt.outcome === 'not-run' ? 'needs-hardware-runner' : r.receipt.outcome;
      return { ...c, status, receiptId: r?.receipt.id ?? null };
    });
    const diagnostics = hostFailed.flatMap((r) => (r === undefined ? [] : triageEnvironmentText(r.receipt.outcomeReason)));
    const unverifiedDevice = deviceStatus.filter((d) => d.status !== 'passed');
    // Each option names the facts it is the answer to. Measured live (jev-1.13.0, 2026-10-04): with the bare actions as the
    // options, a project with no approved check (approvedChecks 0, so only one step is possible) was answered declare-checks
    // at confidence 0.19 to 0.26; with the conditions beside the actions every case, including host failures and
    // unverified device checks, was answered at 1.0. The conditions repeat the rules' own order, so Jev is not asked to invent them.
    const options: { [key: string]: string } = {
      'host-triage': 'The host build or analyzer reported failures (hostFailed is above 0): triage those diagnostics first.',
      'hardware-runner': 'The approved checks exist and the host has no failures, but device checks are not yet verified (deviceUnverified is above 0): run them on a runner that declares the hardware.',
      'declare-checks': 'No check is approved yet (approvedChecks is 0), so nothing can be built or tested: approve a command manifest or a reviewed analyzer first.',
    };
    const rules = () => (manifests.length === 0 ? { choice: 'declare-checks', reasonCode: 'NO_APPROVED_CHECKS' } : hostFailed.length > 0 ? { choice: 'host-triage', reasonCode: 'HOST_FAILURES' } : unverifiedDevice.length > 0 ? { choice: 'hardware-runner', reasonCode: 'DEVICE_UNVERIFIED' } : { choice: 'host-triage', reasonCode: 'NOTHING_PENDING' });
    const got = await consultChoice(cx.engine, {
      capabilityId: 'C72',
      specVersion: '1',
      objective: 'Route the next step for a constrained or embedded project. Text never stands in for a build, a simulator or a device test.',
      workspaceId: cx.ws.workspaceId,
      evidenceRevision: sha256(JSON.stringify(deviceStatus) + String(hostFailed.length)).slice(0, 32),
      evidence: diagnostics.slice(0, 6).map((d, i) => ({ id: `d${String(i)}`, text: `${d.kind} ${d.subject}: ${d.excerpt}`, sourceKind: 'tool' as const, priority: 'high' as const })),
      facts: { approvedChecks: manifests.length, hostFailed: hostFailed.length, deviceChecks: deviceStatus.length, deviceUnverified: unverifiedDevice.length, attachedHardware: attached.size },
      instructions: 'What should happen next?',
      options,
      rules,
      ...remaining(cx),
    });
    const a = advice(
      C72,
      {
        verb: 'rank',
        summary: `Verified on this host: ${String(hostPassed.length)} of ${String(hostChecks.length)} checks. ${unverifiedDevice.length > 0 ? `Device behaviour is unverified: ${String(unverifiedDevice.length)} checks need a runner with the hardware (${[...new Set(unverifiedDevice.map((d) => d.hardware))].join(', ')}).` : 'No device check is pending.'} Next: ${got.value}.`,
        recommendation: got.value,
        ranked: deviceStatus.map((d) => ({ id: d.id, label: `${d.id} on ${d.hardware}: ${d.status}`, score: null, reason: d.approved ? 'approved check' : 'proposed check, not approved' })),
        kept: ['hardware-checks-run-on-declared-runners', 'no-inferred-binary-correctness'],
        validation: unverifiedDevice.map((d) => `${d.id} on a runner declaring ${d.hardware}`),
        evidenceIds: deviceStatus.map((d) => d.receiptId).filter((x): x is string => x !== null),
        notes: [profile.stacks.length === 0 ? 'No certified analyzer for this stack: build and test semantics are unverified until a command manifest is approved (W12).' : `Stacks: ${profile.stacks.map((s) => s.stack).join(', ')}.`],
      },
      got,
    );
    return withRecord(cx, a, { id: 'C72-declared-hardware-runner', passed: unverifiedDevice.length === 0, reasonCode: unverifiedDevice.length === 0 ? 'DEVICE_VERIFIED_OR_NONE' : 'DEVICE_UNVERIFIED' }, input, { hostChecks: hostChecks.length, deviceChecks: deviceStatus.length });
  },
};

export const RESEARCH_CAPABILITIES: readonly CapabilityDefinition[] = [C32, C40, C62, C65, C66, C67, C68, C69, C70, C71, C72];
