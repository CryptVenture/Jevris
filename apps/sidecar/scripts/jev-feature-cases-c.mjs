/**
 * Jev feature cases, part C: the research and long-range capabilities (C32, C40, C62, C65 to C72),
 * the memory functions (C18 to C24) and the loop advice (C29).
 *
 * A case is one capability's setup and the one call that makes its handler ask Jev (see
 * `jev-feature-driver.mjs`). The workspace files are in `FILES`; the aggregator commits them before
 * any case runs. Text meant to be caught in a request carries `MARKER`-style tokens: free text uses
 * `ZZMARKER-<id>`; file and folder NAMES use `ZZPATHMARK-<id>`, a second token that no other part
 * writes, so a request that lists this part's paths cannot be mistaken for another part's leak.
 * File contents never hold a marker (other parts' capabilities read files).
 *
 * Conventions this part adds to the driver's case shape (everything else is as documented there):
 *
 * - `capability`: the catalogue id the case covers (`id` may be more specific, `C68-b`).
 * - `egressNeeded: true` with `egressVia`: which switch opens the consult. 'preference' is the user preference
 *   `privacy.sourceEgress` in jevris.config.json that the checkpoint op reads (C18); 'host' is host policy
 *   (host.json), which the engine's transport guard reads and which opens the consults flagged
 *   `sendsWorkspaceText` (C70). With egress denied such a case sends nothing and the rules answer.
 * - `noDecision: true`: the question is not asked and no decision is built (the advice carries no decision id).
 * - `unreachable: true`: no product op reaches the Jev consult at `site` (the function has no caller,
 *   or its caller never passes the engine). The call is the op the capability registry points that
 *   capability at (or the nearest one), with `expectAsked: false`: it proves that op stays rules-only.
 *   The offline test checks the consult site itself by calling the function with a recording engine.
 * - `setup.*` pseudo-ops in `steps` (`setup.approve-checks`, `setup.revoke-checks`): changes only a
 *   person makes (approving a check manifest needs a person at a terminal; there is no sidecar op for
 *   it). `runSetupOp` performs them in process, exactly as the CLI does after a person answers y,
 *   and `withSetupOps(sidecar)` wraps a sidecar client so `runCases` can run them. They are marked
 *   `optional`, so a driver that does not know them skips them and the case then stays rules-only.
 *
 * `KNOWN_LEAKS` and `KNOWN_DEFECTS` are measured findings (privacy and question design) that the offline
 * test asserts as they are today. Fixing the product makes the matching assertion fail with a message
 * to delete the entry. Both are empty now: the anchors, duplicate option texts, one-option Choices and the
 * workspace text in two questions that earlier runs found are fixed in the product. What stays is
 * `WORKSPACE_TEXT`, the one place a case's workspace text is allowed to ride, and only with egress approved.
 *
 * To run this part in a fresh sandbox (the live script): `writeWorkspace(work, FILES)` from the driver, then
 * `preparePart({ home, work, egress, mode })` before the sidecar starts, then run `CASES` through the driver
 * with `wrapSidecar(sidecar)` as the client.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const CASE_PART = 'c';

/** Free-text marker: placed in every free-text field a capability might forward as evidence. */
export const TEXT_MARK = 'ZZMARKER';
/** Path marker: placed in file and folder names this part commits or edits. */
export const PATH_MARK = 'ZZPATHMARK';

// ------------------------------------------------------------------------------------ workspace

export const FILES = {
  'caseC/README.md': '# Case C workspace\n\nA small synthetic project for the research and memory capability cases.\n',
  'caseC/notes.md': '# notes\n',
  'caseC/src/calc.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
  'caseC/ZZPATHMARK-C70-alpha/package.json': '{\n  "name": "alpha",\n  "version": "1.0.0"\n}\n',
  'caseC/ZZPATHMARK-C70-alpha/index.ts': 'export const alpha = 1;\n',
  'caseC/ZZPATHMARK-C70-beta/package.json': '{\n  "name": "beta",\n  "version": "1.0.0"\n}\n',
};

/** A changed file that is not committed: an optional capsule item (C18). The next case commits it. */
const DIRTY = { 'caseC/dirty-ZZPATHMARK-C18.txt': 'work in progress\n' };

// ------------------------------------------------------------------------------- shared inputs

/** Two candidate patches against `FILES`: one touches one file, the other two (so their option texts differ). */
const PATCH_CALC = ['diff --git a/caseC/src/calc.ts b/caseC/src/calc.ts', '--- a/caseC/src/calc.ts', '+++ b/caseC/src/calc.ts', '@@ -1,3 +1,4 @@', ' export function add(a: number, b: number): number {', '+  // ZZMARKER-C68 candidate patch', '   return a + b;', ' }', ''].join('\n');
const PATCH_NOTES = ['diff --git a/caseC/notes.md b/caseC/notes.md', '--- a/caseC/notes.md', '+++ b/caseC/notes.md', '@@ -1 +1,2 @@', ' # notes', '+ZZMARKER-C68 candidate note', ''].join('\n');
const PATCH_CALC_OTHER = PATCH_CALC.replace('candidate patch', 'other candidate patch');

/** A policy experiment small enough to pass its contamination checks (C71); its report is stored as evidence. */
const outcome = (verified) => ({ verified, costMicroUsd: 100 });
const labTask = (taskId, repository, createdAt, summary) => ({ taskId, repository, createdAt, summary, sliceId: 'slice-a', consentId: 'consent-1', datasetVersion: 'ds-1', features: { files: 2, tests: 1 }, outcomes: { m1: outcome(true), m2: outcome(false) } });
export const LAB = {
  train: [labTask('t1', 'repo-a', '2026-01-01T00:00:00Z', 'rename a helper in the parser module')],
  test: [labTask('t2', 'repo-b', '2026-02-01T00:00:00Z', 'fix the rounding bug in the invoice totals')],
  variants: [{ id: 'v1', qualityFloor: 0.5 }],
  baselineModelId: 'm1',
  frozenHoldoutIds: [],
  evaluationBudget: 10,
};

/**
 * The evidence handle the C71 run above stores its report under: `ev:` and the sha256 of the report's JSON.
 * The report is a pure function of `LAB`, so C69 can cite a handle that exists in the workspace after the
 * C71 step (the handle is recomputed, never pinned; the offline test checks the C71 answer lists it).
 */
const core = await import('@jevris/core');
const experiment = core.runPolicyExperiment(LAB);
if (!experiment.ok) throw new Error(`the C71 experiment is refused: ${experiment.reasonCode}`);
export const LAB_HANDLE = `ev:${createHash('sha256').update(JSON.stringify(experiment.report)).digest('hex')}`;

const CHECK_NODE = { argv: ['node', '--version'], mandatory: false, timeoutMs: 30000 };
const NOISY = "for (let i = 0; i < 1500; i += 1) console.log('noisy line number ' + i + ' of the check output');";

// -------------------------------------------------------------------------------- setup pseudo-ops

export const SETUP_PREFIX = 'setup.';

/**
 * Performs a `setup.*` pseudo-op in process. `request` is what the driver would send a sidecar
 * (`{ home, op, workspace, body }`). Throws when the setup did not take, so a case never runs on a
 * state it did not ask for. Answers like a sidecar client: `{ ok: true, result }`.
 */
export async function runSetupOp(request) {
  const orchestrator = await import('@jevris/orchestrator');
  const ws = orchestrator.openWorkspace({ home: request.home, workspaceRoot: request.workspace, platform: process.platform });
  if (request.op === 'setup.approve-checks') {
    const record = await orchestrator.approveProposal(ws, { schemaVersion: 'jevris-checks-1', checks: request.body?.checks ?? [] }, 'cli');
    if (record.ok === false) throw new Error(`setup.approve-checks refused: ${record.reason}`);
    return { ok: true, result: { approved: Object.keys(record.hashes).sort() } };
  }
  if (request.op === 'setup.revoke-checks') {
    return { ok: true, result: { revoked: await orchestrator.revokeApproval(ws, []) } };
  }
  throw new Error(`unknown setup op ${request.op}`);
}

/** A sidecar client that also performs the `setup.*` pseudo-ops; every other op goes to `sidecar`. */
export function withSetupOps(sidecar) {
  return {
    ...sidecar,
    async sidecarRequest(request) {
      if (typeof request.op === 'string' && request.op.startsWith(SETUP_PREFIX)) return runSetupOp(request);
      return sidecar.sidecarRequest(request);
    },
  };
}

/** The client the live script runs this part through: the sidecar client plus the `setup.*` pseudo-ops. */
export const wrapSidecar = withSetupOps;

/** The host policy document a `host.json` needs (the contract's required fields); `egress` and `mode` vary. */
function hostPolicy(egress, mode) {
  return {
    schemaVersion: '1.0',
    mode,
    egress: egress === 'approved' ? 'approved-scoped' : 'deny-until-approved',
    retention: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 },
    budget: { maxRequestBytes: 65536 },
    pin: { model: 'jev-1.13.0', respectHumanPins: true },
    packPrivileges: [],
    credentialRef: 'host-secret:typesafe-primary',
    installerEnvName: 'JEVRIS_INSTALLER_KEY',
    allowUncalibratedActuation: false,
  };
}

/**
 * What this part needs in the Jevris home before its sidecar starts (call it after the caller wrote the
 * workspace with `writeWorkspace(work, FILES)`; `work` is the workspace root and is only read).
 *
 * - The host policy file (`host.json`) with `egress` 'denied' or 'approved' and the host `mode`. Only the
 *   host policy approves source egress for the engine's transport guard.
 * - With 'approved', also the user preference `privacy.sourceEgress: approved-scoped` in
 *   `jevris.config.json`. The checkpoint op reads that preference (not host policy) before it ranks optional
 *   capsule items with Jev (C18), so the case needs both switches.
 *
 * Both files are written inside `home` only, owner-only, through the product's own path rules. Approving
 * checks stays in the `setup.*` pseudo-ops. Returns what it wrote.
 */
export async function preparePart({ home, work, egress, mode }) {
  if (egress !== 'denied' && egress !== 'approved') throw new Error(`preparePart: egress must be denied or approved, not ${String(egress)}`);
  if (typeof home !== 'string' || typeof work !== 'string') throw new Error('preparePart: home and work are required');
  const { jevrisPaths } = await import('@jevris/platform');
  const orchestrator = await import('@jevris/orchestrator');
  const config = jevrisPaths({ home }).config;
  mkdirSync(config, { recursive: true, mode: 0o700 });
  writeFileSync(join(config, 'host.json'), `${JSON.stringify(hostPolicy(egress, mode ?? 'advise'), null, 2)}\n`, { mode: 0o600 });
  let preference = false;
  if (egress === 'approved') {
    const file = orchestrator.configFilePath({ home });
    const current = orchestrator.readEffectiveConfig({ home }).config;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify({ ...current, privacy: { ...current.privacy, sourceEgress: 'approved-scoped' } }, null, 2)}\n`, { mode: 0o600 });
    preference = true;
  }
  return { hostPolicy: join(config, 'host.json'), egress, mode: mode ?? 'advise', preference };
}

const approve = (...checks) => ({ op: 'setup.approve-checks', scope: 'cli', optional: true, body: { checks } });
const revoke = () => ({ op: 'setup.revoke-checks', scope: 'cli', optional: true, body: {} });

// ------------------------------------------------------------------------------------ summaries

const idOf = (r) => (typeof r?.decisionId === 'string' ? r.decisionId : null);
/** checkpoint: the payload names the Jev decision that ranked an item (null when rules did), not a source. */
const summarizeCheckpoint = (r) => ({ source: null, reasonCode: r?.written === true ? 'CAPSULE_WRITTEN' : null, decisionId: idOf(r), verb: 'checkpoint', recommendation: null });
/** recover: the classification and action, and the decision id. */
const summarizeRecover = (r) => ({ source: null, reasonCode: null, decisionId: idOf(r), verb: typeof r?.action === 'string' ? r.action : null, recommendation: typeof r?.classification === 'string' ? r.classification : null });
const summarizeExport = (r) => ({ source: null, reasonCode: r?.found === true ? 'EXPORTED' : 'NOT_FOUND', decisionId: null, verb: 'handoff.export', recommendation: null });
const summarizeVerify = (r) => ({ source: null, reasonCode: typeof r?.readiness === 'string' ? r.readiness : null, decisionId: null, verb: 'verify', recommendation: null });
const summarizeSelect = (r) => ({ source: null, reasonCode: null, decisionId: null, verb: 'evidence.select', recommendation: Array.isArray(r?.items) && r.items.length > 0 ? String(r.items[0].id) : null });

/**
 * Why an unreachable case calls evidence.select: the registry points C19, C20, C23 and C24 at checkpoint,
 * but a checkpoint also asks the C18 capsule ranking whenever an optional item exists and egress is
 * approved, which would hide this site's silence behind another site's request. evidence.select hands no
 * engine to anything, so it is quiet in every workspace state.
 */
const NO_CALLER = 'No product op reaches this consult. ';

const advise = (capabilityId, input) => ({ op: 'capability.advise', scope: 'mcp', body: { capabilityId, input } });

// --------------------------------------------------------------------------------------- cases

export const CASES = [
  {
    id: 'C18-capsule',
    capability: 'C18',
    title: 'Rank optional capsule items',
    site: 'packages/orchestrator/src/memory/capsule.ts:284',
    steps: [{ files: DIRTY }],
    call: { op: 'checkpoint', scope: 'mcp', body: { taskId: null, objective: 'Keep the invoice totals exact ZZMARKER-C18', constraints: ['C1: do not change the public API ZZMARKER-C18'] } },
    expectAsked: true,
    egressNeeded: true,
    egressVia: 'preference',
    summarize: summarizeCheckpoint,
    notes:
      'The checkpoint op writes a capsule; the optional items (here the uncommitted changed file) are scored one Jev Score question each, at most 12, only when the effective config says privacy.sourceEgress approved-scoped (jevris.config.json, a user preference: memory-ops.ts:61) and 1.5 s remain. Host policy (host.json) alone does not open it. ' +
      'The item text is the path and a content hash, sent as evidence only when host policy approves egress; otherwise the engine withholds it. The uncommitted file is committed by the next case. The payload names no source: read the decision record.',
  },
  {
    id: 'C19-readiness',
    capability: 'C19',
    title: 'Compaction readiness boundary',
    site: 'packages/orchestrator/src/memory/readiness.ts:84',
    steps: [{ files: DIRTY, commit: true }],
    call: { op: 'evidence.select', scope: 'mcp', body: { intent: 'compaction readiness boundary ZZMARKER-C19' } },
    expectAsked: false,
    unreachable: true,
    summarize: summarizeSelect,
    notes: NO_CALLER + 'compactionReadiness has no caller in the product: no op or hook reads context use and asks it (the compaction hook only writes a capsule). The call is the nearest read-only memory op.',
  },
  {
    id: 'C20-audit',
    capability: 'C20',
    title: 'Omission audit of a compaction summary',
    site: 'packages/orchestrator/src/memory/audit.ts:100',
    steps: [],
    call: { op: 'evidence.select', scope: 'mcp', body: { intent: 'decisions a compaction summary dropped ZZMARKER-C20' } },
    expectAsked: false,
    unreachable: true,
    summarize: summarizeSelect,
    notes: NO_CALLER + 'auditOmissions has no caller outside tests (the SessionStart restore path uses queueRestore and commitRestore, not the audit). The call is the nearest read-only memory op.',
  },
  {
    id: 'C21-rehydrate',
    capability: 'C21',
    title: 'Pick the capsule that continues a resumed session',
    site: 'packages/orchestrator/src/memory/rehydrate.ts:72',
    steps: [
      { op: 'checkpoint', scope: 'mcp', body: { taskId: 'T-c21-a', objective: 'First task objective ZZMARKER-C21' } },
      { op: 'checkpoint', scope: 'mcp', body: { taskId: 'T-c21-b', objective: 'Second task objective ZZMARKER-C21' } },
    ],
    call: { op: 'handoff.export', scope: 'mcp', body: { capsuleId: null, taskId: null, harness: 'claude' } },
    expectAsked: false,
    unreachable: true,
    summarize: summarizeExport,
    notes: 'The consult needs rehydrate() called with no task and no capsule id and two or more capsules; the only caller (the SessionStart subscriber) passes the capsule id, so the Choice is never asked. The registry points C21 at handoff.import, which has no consult. Two capsules exist after the steps; handoff.export of the latest answers without Jev. The consult is flagged sendsWorkspaceText (the capsule objectives are the option texts): asked only with egress approved, which the offline test checks by calling the function with a denied and an approved engine.',
  },
  {
    id: 'C22-distill',
    capability: 'C22',
    title: 'Rank spans of long tool output',
    site: 'packages/orchestrator/src/memory/distill.ts:301',
    steps: [approve({ id: 'c22-noisy', ...CHECK_NODE, argv: ['node', '-e', NOISY] })],
    call: { op: 'verify', scope: 'cli', body: { taskId: null, checkIds: [] } },
    expectAsked: false,
    unreachable: true,
    summarize: summarizeVerify,
    notes: 'The verify op runs the approved check and builds a distilled view of its long output (the 1,500 line output exceeds the view budget), but verify/service.ts:251 passes no engine, so the span scores (Jev Score, max 8 per output) are never asked, with or without egress. The only other caller, distillOutput in apps/cli/src/trial-jevris.ts, passes no engine either. The step approves the check as a person would.',
  },
  {
    id: 'C23-facts',
    capability: 'C23',
    title: 'Semantic contradiction between remembered facts',
    site: 'packages/orchestrator/src/memory/facts.ts:141',
    steps: [],
    call: { op: 'evidence.select', scope: 'mcp', body: { intent: 'contradicting facts about the timeout ZZMARKER-C23' } },
    expectAsked: false,
    unreachable: true,
    summarize: summarizeSelect,
    notes: NO_CALLER + 'triageContradictions has no caller outside tests; nothing records a fact (recordFact is called only by resolveContradiction). The call is the nearest read-only memory op.',
  },
  {
    id: 'C24-memory',
    capability: 'C24',
    title: 'Rescore project memory for a query',
    site: 'packages/orchestrator/src/memory/facts.ts:269',
    steps: [],
    call: { op: 'evidence.select', scope: 'mcp', body: { intent: 'sqlite storage decision ZZMARKER-C24' } },
    expectAsked: false,
    unreachable: true,
    summarize: summarizeSelect,
    notes: NO_CALLER + 'retrieveProjectMemory has no caller outside tests and nothing admits project memory (admitProjectMemory has no caller). The nearest product retrieval is evidence.select, which ranks by rules only.',
  },
  {
    id: 'C29',
    capability: 'C29',
    title: 'Loop advice: progress or looping',
    site: 'packages/orchestrator/src/orchestration/loops.ts:349',
    steps: [],
    call: {
      op: 'recover',
      scope: 'mcp',
      body: { taskId: null, signals: { fingerprints: ['AssertionError: expected total to equal 42 (ZZMARKER-C29 alpha)', 'TypeError: cannot read properties of undefined (ZZMARKER-C29 beta)'], artifacts: ['stack-trace'] }, rejectedApproaches: ['Retried the same call ZZMARKER-C29'] },
    },
    expectAsked: true,
    summarize: summarizeRecover,
    notes: 'Two different failures that are not environmental, each seen once, are a "progress" the rules are not sure of (decisive false), so the Choice (six options) is asked. The failure text is evidence (withheld without egress); the facts carry counts, family codes and artifact vocabulary ids only. The payload names no source: read the decision record.',
  },
  {
    id: 'C32',
    capability: 'C32',
    title: 'Native workflow or team advisory',
    site: 'packages/orchestrator/src/capabilities/research.ts:217',
    steps: [],
    call: advise('C32', { harness: 'claude', collaborative: false, note: 'ZZMARKER-C32' }),
    expectAsked: true,
    notes: 'Always asks for a harness that has native orchestration: claude lists three options (the others list one, which a Choice cannot ask). No tasks are needed (counts only). The note field is ignored by the handler.',
  },
  {
    id: 'C32-b',
    capability: 'C32',
    title: 'Native workflow or team advisory: a harness with no native orchestration',
    site: 'packages/orchestrator/src/capabilities/research.ts:217',
    steps: [],
    call: advise('C32', { harness: 'codex' }),
    expectAsked: false,
    noDecision: true,
    notes: 'Codex, OpenCode, Kilocode and Antigravity list one option (the DAG scheduler). A Choice of fewer than two options is not asked at all (consult.ts): no request, and no decision is built, refused or journaled (the advice carries no decision id). Earlier builds built the Choice and left a refused QUESTION_LINT/LINT_EMPTY_OPTIONS record on each call.',
  },
  {
    id: 'C40',
    capability: 'C40',
    title: 'Visual-work evidence bridge',
    site: 'packages/orchestrator/src/capabilities/research.ts:287',
    steps: [],
    call: advise('C40', { findings: [{ id: 'f1', text: 'The button overlaps the footer ZZMARKER-C40', source: 'screenshot' }] }),
    expectAsked: true,
    notes: 'One textual finding is enough: the top finding is scored by a Jev Score question. The finding text is evidence. (Its anchors were refused by the question lint until they were lengthened.)',
  },
  {
    id: 'C62',
    capability: 'C62',
    title: 'Release risk summary',
    site: 'packages/orchestrator/src/capabilities/research.ts:352',
    steps: [],
    call: advise('C62', { incidents: [{ id: 'INC-1', severity: 'high', resolved: false }], rollout: { stages: ['canary', 'full'], rollbackPlan: 'Revert the release ZZMARKER-C62' }, exceptions: [{ id: 'EXC-1', resolved: false }] }),
    expectAsked: true,
    notes: 'Any listed risk reaches the Score question (an unresolved incident, a missing rollout plan, an unapproved check); no setup is needed. The risk labels are evidence. (Its anchors were refused by the question lint until they were lengthened.)',
  },
  {
    id: 'C65',
    capability: 'C65',
    title: 'Portfolio compute allocation',
    site: 'packages/orchestrator/src/capabilities/research.ts:455 (no Jev consult in this handler)',
    steps: [],
    call: advise('C65', { options: [{ taskId: 'T1', modelId: 'm1', expectedQuality: 0.9, costMicroUsd: 100 }], budgetMicroUsd: 1000 }),
    expectAsked: false,
    notes: 'The handler allocates by rules (floors first, then upgrades) and never asks Jev, though the catalogue lists a Score primitive. The options name no owned task, so it abstains with NO_OPTIONS (owned tasks need a root budget and a person-minted authorization).',
  },
  {
    id: 'C66',
    capability: 'C66',
    title: 'Task-specific learned router',
    site: 'packages/orchestrator/src/capabilities/research.ts:502 (no Jev consult in this handler)',
    steps: [],
    call: advise('C66', { action: 'status' }),
    expectAsked: false,
    notes: 'Offline estimator: trains and reviews a candidate router from consented examples; no Jev question exists. The status call has no artifact id, so it abstains with UNKNOWN_ARTIFACT.',
  },
  {
    id: 'C67',
    capability: 'C67',
    title: 'Question improvement proposal',
    site: 'packages/orchestrator/src/capabilities/research.ts:609',
    steps: [],
    call: advise('C67', {
      specId: 'spec-c67',
      current: { instructions: 'Pick the best option ZZMARKER-C67', options: { none: 'No option fits ZZMARKER-C67', a: 'The first option' }, mandatoryEvidence: [], threshold: null },
      candidate: { instructions: 'Pick the single best option for the task ZZMARKER-C67', options: { none: 'No option fits', a: 'The first option', b: 'The second option ZZMARKER-C67' }, mandatoryEvidence: [], threshold: null },
      misclassifications: [{ expected: 'b', got: 'a' }],
    }),
    expectAsked: true,
    notes: 'Both specs need an instruction and two options, and the candidate must keep the "none" option and any mandatory evidence (or the proposal is refused before the question). writeBranch is left off, so no git branch is written. The two specs are evidence. (Its anchors were refused by the question lint until they were lengthened.)',
  },
  {
    id: 'C68',
    capability: 'C68',
    title: 'Safe speculative evaluation: choose a candidate',
    site: 'packages/orchestrator/src/capabilities/research.ts:738',
    steps: [],
    call: advise('C68', { candidates: [{ id: 'cand-a', patch: PATCH_CALC }, { id: 'cand-b', patch: PATCH_CALC + PATCH_NOTES }] }),
    expectAsked: true,
    notes: 'Needs a git repository with a commit (owned worktrees) and two or more candidates whose patches apply cleanly in scope; candidates touching a different number of files give different option texts. The patches stay in temporary worktrees that are removed. The options are the question criteria: "none" and one numbered text per viable candidate.',
  },
  {
    id: 'C68-b',
    capability: 'C68',
    title: 'Safe speculative evaluation: two candidates of the same size',
    site: 'packages/orchestrator/src/capabilities/research.ts:737',
    steps: [],
    call: advise('C68', { candidates: [{ id: 'cand-a', patch: PATCH_CALC }, { id: 'cand-c', patch: PATCH_CALC_OTHER }] }),
    expectAsked: true,
    notes: 'Two viable candidates that change the same number of files, the usual case. The option texts are numbered ("Candidate 1 of 2 applies cleanly in scope, 1 files changed"), so they differ and the question is asked; earlier builds sent identical texts, which the question lint refused as DUPLICATE_CRITERIA.',
  },
  {
    id: 'C69',
    capability: 'C69',
    title: 'Cross-model disagreement triage',
    site: 'packages/orchestrator/src/capabilities/research.ts:800',
    steps: [advise('C71', LAB)],
    call: advise('C69', {
      reports: [
        { id: 'r1', model: 'model-a', conclusion: 'concl-x', evidenceIds: [LAB_HANDLE], sources: ['src-a'], note: 'ZZMARKER-C69' },
        { id: 'r2', model: 'model-b', conclusion: 'concl-y', evidenceIds: [LAB_HANDLE], sources: ['src-b'] },
      ],
    }),
    expectAsked: true,
    notes: 'Two reports with different conclusions must each cite evidence that exists in this workspace. The C71 step stores a deterministic report as evidence; its handle (recomputed in this file) is what both reports cite. The question carries counts only (no evidence text). (Its anchors were refused by the question lint until they were lengthened.)',
  },
  {
    id: 'C70',
    capability: 'C70',
    title: 'Project-wide change campaign: pick the canary',
    site: 'packages/orchestrator/src/capabilities/research.ts:871',
    steps: [
      approve(
        { id: 'c70-alpha', ...CHECK_NODE, inputScopes: ['caseC/ZZPATHMARK-C70-alpha'] },
        { id: 'c70-beta', ...CHECK_NODE, inputScopes: ['caseC/ZZPATHMARK-C70-beta'] },
      ),
    ],
    call: advise('C70', { campaignId: 'camp-c70', contract: 'Rename the helper everywhere ZZMARKER-C70', modules: ['caseC/ZZPATHMARK-C70-alpha', 'caseC/ZZPATHMARK-C70-beta'] }),
    expectAsked: true,
    egressNeeded: true,
    egressVia: 'host',
    notes: 'The Choice is asked only when two or more named modules are covered by an approved check and no canary is named. Approving checks is a person-only change, done by the setup pseudo-op (non-mandatory checks scoped to this part\'s two module folders; approval replaces the workspace\'s approved set, and the last case of this part revokes it). The module paths are the option keys and texts, so the consult is flagged sendsWorkspaceText: with source egress not approved by host policy nothing is sent and the rules pick the canary (SMALLEST_COVERED_MODULE); with it approved the question is asked.',
  },
  {
    id: 'C71',
    capability: 'C71',
    title: 'Policy-evaluation laboratory',
    site: 'packages/orchestrator/src/capabilities/research.ts:932 (no Jev consult in this handler)',
    steps: [],
    call: advise('C71', LAB),
    expectAsked: false,
    notes: 'Offline experiment: contamination checks, then per-variant metrics, stored as a policy-lab-report evidence record. No Jev question exists. C69 uses its report handle.',
  },
  {
    id: 'C72',
    capability: 'C72',
    title: 'Resource-constrained and embedded development',
    site: 'packages/orchestrator/src/capabilities/research.ts:994',
    steps: [revoke()],
    call: advise('C72', { note: 'ZZMARKER-C72' }),
    expectAsked: true,
    notes: 'Always asks (no precondition): the three options are fixed. Failing host checks add evidence (diagnostic excerpts) when a receipt failed; none is needed. The first step revokes the checks the earlier cases of this part approved, so this part leaves the workspace without approved checks.',
  },
];

// ----------------------------------------------------------------------------------- findings

/**
 * Requests that carry a marker while source egress is denied or only a user preference approves it.
 * Each value names the field and where the product builds it. The offline test exempts exactly these
 * ids from "no marker in any request" and asserts the leak is still there. Empty: the two leaks found
 * earlier (C70 module paths, C21 capsule objectives in a question) are fixed, the consults are flagged
 * `sendsWorkspaceText` and are not asked while egress is not approved.
 */
export const KNOWN_LEAKS = {};

/** Where a known leak sits (a JSON pointer prefix into the request); see `KNOWN_LEAKS`. */
export const LEAK_FIELDS = {};

/**
 * Question designs the engine refuses before sending anything (decision record: QUESTION_LINT plus the
 * code), measured through the real sidecar; `codes` are the record's reason codes. Empty: the rubric
 * anchors (C40, C62, C67, C69, and C22 and C24 whose consults no op reaches) were lengthened and the C68
 * option texts numbered. An entry is asserted as it reproduces, so a fix makes the test say to delete it.
 */
export const KNOWN_DEFECTS = {};

/**
 * Where a case's workspace text may ride in a request, and only while source egress is approved: the
 * question's own criteria (a question the transport guard does not screen as evidence). With egress denied
 * these consults are not asked. Every other marker may be only in `/state/untrustedEvidence`.
 */
export const WORKSPACE_TEXT = {
  C70: '/questions/q/criteria',
  'C21-rehydrate': '/questions/q/criteria',
};
