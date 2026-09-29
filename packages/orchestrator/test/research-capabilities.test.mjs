// M3 research capabilities (C32, C40, C62, C65-C72; RSH-01..RSH-11) through adviseCapability:
// real workspace state (git, store receipts, tasks, worktrees), a stub decision engine, the
// capability's own evidence record, and guard flags that never grant, apply or certify.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signRecord } from '@jevris/contracts';
import { syntheticRoutingExamples } from '@jevris/core';
import { adviseCapability, allocateCompute, approveManifests, manifestHash, openWorkspace, parseManifest, runVerification, safetyRegressions, submitPlan } from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function write(root, rel, text) {
  const full = join(root, ...rel.split('/'));
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
}

async function fixture(files = {}) {
  const dir = tempDir('jv-rsh-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  write(repo, 'README.md', '# app\n');
  for (const [rel, text] of Object.entries(files)) write(repo, rel, text);
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  const advise = (capabilityId, input = {}, extra = {}) => adviseCapability(ws, { capabilityId, input, home, env: { HOME: home }, ...extra });
  return {
    dir, home, repo, store, ws, advise,
    done: () => {
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function approve(ws, specs) {
  const ms = specs.map((s) => parseManifest(s).manifest);
  await approveManifests(ws, ms, Object.fromEntries(ms.map((m) => [m.id, manifestHash(m)])), 'test');
  return ms;
}

function engine(answers, extra = {}) {
  const calls = [];
  return {
    calls,
    ...extra,
    async decide(req) {
      calls.push(req);
      const a = answers[req.packet.trustedPolicy.capability];
      if (a === undefined) return { abstained: true, reasonCode: 'STUB_ABSTAIN' };
      return { decisionId: `dec-${req.packet.trustedPolicy.capability.toLowerCase()}`, result: { answers: { q: a } } };
    },
  };
}

function ok(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  const a = result.advice;
  assert.deepEqual(a.guards, { applied: false, authorityGranted: false, verified: false, permissionChanged: false, executed: false, allowlistExpanded: false, certified: false });
  return a;
}

/** The capability's own evidence record: the first evidence id, content-free. */
function recordOf(f, a) {
  const bytes = f.ws.evidence.get(a.evidenceIds[0], f.ws.workspaceId);
  assert.ok(bytes, 'an evidence record was written');
  const record = JSON.parse(new TextDecoder().decode(bytes));
  assert.equal(record.schemaVersion, 'jevris-capability-record-1');
  assert.equal(record.capabilityId, a.capabilityId);
  assert.match(record.inputHash, /^[0-9a-f]{64}$/);
  return record;
}

const TASK = (id, extra = {}) => ({ id, title: `task ${id}`, requirementIds: ['R1'], acceptanceCheckIds: ['unit'], expectedOutputs: ['patch'], writeScopes: [`src/${id}`], ...extra });
const UNIT = { id: 'unit', argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code', mandatory: true };

test('every research capability resolves through capability.advise (RSH-01..RSH-11)', async () => {
  const f = await fixture();
  try {
    for (const id of ['C32', 'C40', 'C62', 'C65', 'C66', 'C67', 'C68', 'C69', 'C70', 'C71', 'C72']) {
      const r = await f.advise(`CAP-${id.slice(1)}`);
      assert.equal(ok(r).capabilityId, id);
    }
  } finally {
    f.done();
  }
});

test('C32 recommends only what the harness supports; Jev stays out of workflow scripts until a bridge probe reaches it (RSH-01)', async () => {
  const f = await fixture();
  try {
    await approve(f.ws, [UNIT]);
    await submitPlan(f.ws, { tasks: [TASK('a'), TASK('b'), TASK('c')], ownerId: 'alice', rootBudget: { id: 'b1', limitMicroUsd: 1_000_000 } });
    const fanOut = ok(await f.advise('C32', { harness: 'claude' }));
    assert.equal(fanOut.recommendation, 'native-workflow', 'three independent tasks fan out');
    assert.deepEqual(fanOut.kept, ['jev-outside-workflow-scripts']);
    assert.deepEqual(recordOf(f, fanOut).guard, { id: 'E35-bridge-probe', passed: false, reasonCode: 'BRIDGE_UNPROVEN' });
    const codex = ok(await f.advise('C32', { harness: 'codex', collaborative: true }));
    assert.equal(codex.recommendation, 'dag', 'codex documents no workflow or team runtime');
    assert.deepEqual(codex.ranked.map((r) => r.id), ['dag']);
    const team = ok(await f.advise('C32', { harness: 'claude', collaborative: true }));
    assert.deepEqual([team.recommendation, team.requiresApproval], ['agent-team', true]);
    const invented = ok(await f.advise('C32', { harness: 'codex' }, { engine: engine({ C32: { choice: 'agent-team' } }) }));
    assert.equal(invented.recommendation, 'dag', 'an unsupported option from Jev is ignored');
    // The bridge probe: a pending probe proves nothing; a report with the nonce records the result.
    const started = ok(await f.advise('C32', { harness: 'claude', action: 'probe-start' }));
    const nonce = started.recommendation;
    assert.match(nonce, /^[0-9a-f]{32}$/);
    assert.equal(ok(await f.advise('C32', { harness: 'claude', action: 'probe-report', nonce: 'f'.repeat(32), reached: true })).reasonCode, 'UNKNOWN_PROBE');
    const reached = ok(await f.advise('C32', { harness: 'claude', action: 'probe-report', nonce, reached: true }));
    assert.equal(reached.recommendation, 'reached');
    assert.equal(recordOf(f, reached).guard.passed, true);
    assert.equal(ok(await f.advise('C32', { harness: 'claude', action: 'probe-report', nonce, reached: true })).reasonCode, 'UNKNOWN_PROBE', 'a nonce reports once');
    const proven = ok(await f.advise('C32', { harness: 'claude' }));
    assert.deepEqual(proven.kept, []);
    assert.match(proven.summary, /bridge probe shows workflow scripts can reach Jev/);
    // A probe that is not reported in time expires.
    const late = ok(await f.advise('C32', { harness: 'codex', action: 'probe-start' }));
    const expired = ok(await f.advise('C32', { harness: 'codex', action: 'probe-report', nonce: late.recommendation, reached: true }, { nowMs: Date.now() + 11 * 60_000 }));
    assert.equal(expired.recommendation, 'expired');
    assert.equal(ok(await f.advise('C32', { harness: 'emacs' })).reasonCode, 'UNKNOWN_HARNESS');
  } finally {
    f.done();
  }
});

test('C32 bridge probes are per machine: a proof in one project serves another, and a row an earlier release kept in a workspace is adopted with its 30-day validity (coordinator, machine-wide learning)', async () => {
  const f = await fixture();
  try {
    const other = join(f.dir, 'repo2');
    mkdirSync(other, { recursive: true });
    write(other, 'README.md', '# other\n');
    git(other, 'init', '-q');
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'init');
    const ws2 = openWorkspace({ home: f.home, workspaceRoot: other, env: { HOME: f.home }, store: f.store });
    const advise2 = (input, extra = {}) => adviseCapability(ws2, { capabilityId: 'C32', input, home: f.home, env: { HOME: f.home }, ...extra });
    const proven = (a, ws = f.ws) => {
      const bytes = ws.evidence.get(a.evidenceIds[0], ws.workspaceId);
      return JSON.parse(new TextDecoder().decode(bytes)).guard.passed;
    };
    assert.equal(proven(ok(await advise2({ harness: 'claude' })), ws2), false);
    // Proven from the first project: the second sees it; the rows are in the host ledger only.
    const nonce = ok(await f.advise('C32', { harness: 'claude', action: 'probe-start' })).recommendation;
    // A nonce started in one project may be reported from another (same machine).
    assert.equal(ok(await advise2({ harness: 'claude', action: 'probe-report', nonce, reached: true })).recommendation, 'reached');
    assert.equal(proven(ok(await advise2({ harness: 'claude' })), ws2), true);
    assert.equal(proven(ok(await f.advise('C32', { harness: 'claude' }))), true);
    assert.deepEqual([f.ws.state.list('bridge-probes').length, ws2.state.list('bridge-probes').length, f.ws.host.list('bridge-probes').length], [0, 0, 1]);
    // Adoption: rows an earlier release wrote to a workspace ledger move to the host ledger on
    // first read, keeping their times: 29 days old still proves, 31 days old does not.
    const now = Date.now();
    const day = 86_400_000;
    const row = (n, reportedAtMs, harness) => ({ nonce: n, harness, harnessVersion: null, status: 'reached', startedAtMs: reportedAtMs - 60_000, expiresAtMs: reportedAtMs + 540_000, reportedAtMs });
    await ws2.state.transact((tx) => {
      tx.put('bridge-probes', 'a'.repeat(32), row('a'.repeat(32), now - 29 * day, 'opencode'));
      tx.put('bridge-probes', 'b'.repeat(32), row('b'.repeat(32), now - 31 * day, 'kilocode'));
    });
    assert.equal(proven(ok(await f.advise('C32', { harness: 'opencode' }, { nowMs: now }))), false, 'another project has not read its rows yet');
    assert.equal(proven(ok(await advise2({ harness: 'opencode' }, { nowMs: now })), ws2), true);
    assert.equal(proven(ok(await advise2({ harness: 'kilocode' }, { nowMs: now })), ws2), false, 'the 30-day validity is kept');
    assert.deepEqual([ws2.state.list('bridge-probes').length, f.ws.host.list('bridge-probes').length], [0, 3]);
    assert.equal(proven(ok(await f.advise('C32', { harness: 'opencode' }, { nowMs: now }))), true, 'once adopted, every project on the machine sees it');
    assert.equal(proven(ok(await f.advise('C32', { harness: 'opencode' }, { nowMs: now + 2 * day }))), false, 'and it still lapses 30 days after its report');
  } finally {
    f.done();
  }
});

test('C40 ranks textual findings; a visual assertion needs an image-tool receipt plus a vision or human verification (RSH-02)', async () => {
  const f = await fixture();
  try {
    await approve(f.ws, [
      { id: 'screenshot-capture', argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code', description: 'Playwright screenshots of the pages' },
      { id: 'visual-regression', argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code', description: 'pixel diff against the baseline' },
      UNIT,
    ]);
    await runVerification(f.ws, { taskId: null, checkIds: [] });
    const latest = f.ws.receipts.latest(f.ws.workspaceId, null);
    const shot = latest.get('screenshot-capture').receipt.id;
    const vision = latest.get('visual-regression').receipt.id;
    const unit = latest.get('unit').receipt.id;
    const findings = [
      { id: 'f1', text: 'The footer text is slightly lighter than the spec', source: 'vision-model' },
      { id: 'f2', text: 'The submit button overlaps the email field on narrow screens', source: 'screenshot' },
      { id: 'f3', text: 'no source', source: 'guess' },
    ];
    const supported = ok(await f.advise('C40', { findings, assertions: [{ id: 'a1', claim: 'The layout matches the design', toolReceiptId: shot, verification: { kind: 'vision', receiptId: vision } }] }));
    assert.equal(supported.verb, 'rank');
    assert.deepEqual(supported.ranked.slice(0, 2).map((r) => r.id), ['f2', 'f1'], 'the overlap outranks a shade; a finding without a source is dropped');
    assert.equal(supported.ranked.find((r) => r.id === 'a1').reason, 'supported:vision-verified');
    assert.equal(recordOf(f, supported).guard.passed, true);
    const unsupported = ok(await f.advise('C40', {
      findings,
      assertions: [
        { id: 'a2', claim: 'looks right', toolReceiptId: unit, verification: { kind: 'vision', receiptId: vision } },
        { id: 'a3', claim: 'looks right', toolReceiptId: shot },
        { id: 'a4', claim: 'looks right', toolReceiptId: shot, verification: { kind: 'human', reviewer: 'Dana', reviewedAt: '2026-09-26T10:00:00Z' } },
      ],
    }));
    assert.equal(unsupported.verb, 'pause');
    assert.deepEqual(unsupported.ranked.filter((r) => r.id.startsWith('a')).map((r) => r.reason), ['unsupported:no-image-tool-receipt', 'unsupported:no-verification', 'pending:human-attested']);
    assert.equal(unsupported.requiresApproval, true, 'a human attestation still needs the user');
    assert.deepEqual(recordOf(f, unsupported).guard, { id: 'C40-visual-assertion-evidence', passed: false, reasonCode: 'UNSUPPORTED_VISUAL_CLAIMS' });
  } finally {
    f.done();
  }
});

test('C62 gives an evidence-linked release recommendation; deployment and rollback authority stay separate (RSH-03)', async () => {
  const f = await fixture();
  try {
    await approve(f.ws, [UNIT]);
    await runVerification(f.ws, { taskId: null, checkIds: [] });
    const clean = ok(await f.advise('C62', { incidents: [{ id: 'INC-1', severity: 'high', resolved: true }], rollout: { stages: ['canary', 'all'], rollbackPlan: 'redeploy the previous tag' } }));
    assert.deepEqual([clean.recommendation, clean.requiresApproval], ['proceed-with-review', true]);
    assert.ok(clean.kept.includes('deployment-authority-separate') && clean.kept.includes('rollback-authority-separate'));
    assert.ok(clean.evidenceIds.length >= 2, 'the record and the unit receipt');
    const risky = ok(await f.advise('C62', { incidents: [{ id: 'INC-2', severity: 'critical', resolved: false }, { id: 'bad id', severity: 'critical' }], rollout: { stages: ['all'] }, exceptions: [{ id: 'EX-1' }] }));
    assert.equal(risky.recommendation, 'hold');
    assert.deepEqual(risky.ranked.map((r) => r.id), ['incident:INC-2', 'rollout:no-rollback', 'exception:EX-1', 'rollout:no-canary']);
    assert.ok(risky.ranked.every((r) => r.reason.startsWith('evidence:')), 'every risk names its evidence');
    assert.equal(recordOf(f, risky).guard.passed, true);
    // Jev can raise the level from evidence, never lower what the rules found.
    const lowered = ok(await f.advise('C62', { incidents: [{ id: 'INC-3', severity: 'critical', resolved: false }] }, { engine: engine({ C62: { score: 0 } }) }));
    assert.equal(lowered.recommendation, 'hold');
  } finally {
    f.done();
  }
});

test('C65 funds quality floors first, spends the discretionary budget on the best gain, and never profiles people (RSH-04)', async () => {
  const f = await fixture();
  try {
    await approve(f.ws, [UNIT]);
    await submitPlan(f.ws, { tasks: [TASK('t1'), TASK('t2', { dependencyIds: ['t1'] })], ownerId: 'alice', rootBudget: { id: 'b1', limitMicroUsd: 1_000_000 } });
    const opts = (task) => [
      { taskId: task, modelId: 'haiku', expectedQuality: 0.7, costMicroUsd: 1 },
      { taskId: task, modelId: 'sonnet', expectedQuality: 0.85, costMicroUsd: 3 },
      { taskId: task, modelId: 'opus', expectedQuality: 0.95, costMicroUsd: 8 },
    ];
    const tight = ok(await f.advise('C65', { qualityFloor: 0.8, budgetMicroUsd: 8, options: [...opts('t1'), ...opts('t2')] }));
    assert.deepEqual(tight.ranked.map((r) => r.label), ['t1: sonnet', 't2: sonnet'], 'the cheapest option at the floor; haiku is below it');
    const roomy = ok(await f.advise('C65', { qualityFloor: 0.8, budgetMicroUsd: 11, options: [...opts('t1'), ...opts('t2')] }));
    assert.deepEqual(roomy.ranked.map((r) => r.label), ['t1: opus', 't2: sonnet'], 't1 unblocks t2, so the discretionary upgrade goes to it');
    const short = ok(await f.advise('C65', { qualityFloor: 0.8, budgetMicroUsd: 4, options: [...opts('t1'), ...opts('t2')] }));
    assert.deepEqual(short.ranked.map((r) => [r.id, r.reason]), [['t1', '3 micro-USD'], ['t2', 'BUDGET_SHORT']], 'deferred, never funded below the floor');
    const profiled = ok(await f.advise('C65', { qualityFloor: 0.8, budgetMicroUsd: 8, options: [...opts('t1').map((o) => ({ ...o, author: 'alice' })), { taskId: 'not-owned', modelId: 'opus', expectedQuality: 1, costMicroUsd: 1 }] }));
    assert.equal(profiled.reasonCode, 'IDENTITY_FIELDS_IGNORED');
    assert.deepEqual(profiled.ranked.map((r) => r.id), ['t1'], 'an option for a task Jevris does not own is ignored');
    assert.deepEqual(allocateCompute([{ taskId: 'x', modelId: 'm', expectedQuality: 0.5, costMicroUsd: 1 }], new Map(), 0.8, 100).deferred, [{ taskId: 'x', reason: 'NO_OPTION_MEETS_FLOOR' }]);
  } finally {
    f.done();
  }
});

test('C66 trains a downstream estimator offline, evaluates it on the holdout, and gives advice only after a signed review (RSH-05)', async () => {
  const f = await fixture();
  try {
    const models = [{ modelId: 'opus', skill: 2.5, costMicroUsd: 2_650_000 }, { modelId: 'sonnet', skill: 1.5, costMicroUsd: 1_060_000 }, { modelId: 'haiku', skill: 0.3, costMicroUsd: 530_000 }];
    const trained = ok(await f.advise('C66', { action: 'synthetic', seed: 7, trainCount: 600, holdoutCount: 300, qualityFloor: 0.7, baselineModelId: 'opus', models }));
    assert.equal(trained.reasonCode, 'CANDIDATE_IMPROVES');
    assert.deepEqual(trained.kept, ['review-before-deployment']);
    const artifactId = trained.recommendation;
    const features = { contextK: 20, filesTouched: 1, failingTests: 0, python: 1 };
    assert.equal(ok(await f.advise('C66', { action: 'advise', artifactId, features })).reasonCode, 'NOT_REVIEWED', 'an unreviewed candidate never routes');
    const keys = generateKeyPairSync('ed25519');
    const pem = keys.publicKey.export({ type: 'spki', format: 'pem' });
    const signer = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const trusted = engine({}, { calibrationKeys: async () => new Map([['cal-owner', pem]]) });
    const review = (extra = {}) => signRecord({ schemaVersion: 'jevris-learned-router-review-1', artifactId, decision: 'approve', reviewer: 'owner', reviewedAt: '2026-09-26T12:00:00Z', ...extra }, signer, 'cal-owner');
    const untrusted = ok(await f.advise('C66', { action: 'review', artifactId, review: review() }));
    assert.equal(untrusted.reasonCode, 'REVIEW_SIGNATURE', 'without the engine, no key is trusted');
    const otherArtifact = ok(await f.advise('C66', { action: 'review', artifactId, review: review({ artifactId: 'lr-other' }) }, { engine: trusted }));
    assert.equal(otherArtifact.reasonCode, 'REVIEW_FOR_OTHER_ARTIFACT');
    const approved = ok(await f.advise('C66', { action: 'review', artifactId, review: review() }, { engine: trusted }));
    assert.deepEqual([approved.recommendation, recordOf(f, approved).guard.passed], ['deployable', true]);
    const routed = ok(await f.advise('C66', { action: 'advise', artifactId, features }, { engine: trusted }));
    assert.equal(routed.verb, 'rank');
    assert.ok(['haiku', 'sonnet'].includes(routed.recommendation), 'an easy task goes to a cheaper model that meets the floor');
    // A candidate with no held-out improvement is never deployable, even when approved.
    const flat = ok(await f.advise('C66', { action: 'synthetic', seed: 7, trainCount: 600, holdoutCount: 300, qualityFloor: 0.9, baselineModelId: 'opus', models }));
    assert.equal(flat.reasonCode, 'CANDIDATE_NO_IMPROVEMENT');
    const flatReview = signRecord({ schemaVersion: 'jevris-learned-router-review-1', artifactId: flat.recommendation, decision: 'approve', reviewer: 'owner', reviewedAt: '2026-09-26T12:00:00Z' }, signer, 'cal-owner');
    assert.equal(ok(await f.advise('C66', { action: 'review', artifactId: flat.recommendation, review: flatReview }, { engine: trusted })).reasonCode, 'NO_HOLDOUT_IMPROVEMENT');
    // Outcome or identity features are refused before training.
    const leaky = syntheticRoutingExamples(1, 40, models).map((e) => ({ ...e, features: { ...e.features, authorId: 3 } }));
    assert.equal(ok(await f.advise('C66', { action: 'train', train: leaky.slice(0, 30), holdout: leaky.slice(30), baselineModelId: 'opus' })).reasonCode, 'FORBIDDEN_FEATURE');
  } finally {
    f.done();
  }
});

test('C67 writes a proposal to a jevris/proposals branch without touching HEAD or live policy, and refuses a weaker safety check (RSH-06)', async () => {
  const f = await fixture();
  try {
    const current = { instructions: 'Which family fits the request?', options: { bugfix: 'A defect fix.', feature: 'New behaviour.', none: 'No family fits.' }, mandatoryEvidence: ['request'], threshold: 0.7 };
    const candidate = { ...current, options: { ...current.options, refactor: 'Restructure without behaviour change.' } };
    const head = git(f.repo, 'rev-parse', 'HEAD').trim();
    const written = ok(await f.advise('C67', { specId: 'triage', current, candidate, misclassifications: [{ expected: 'refactor', got: 'feature' }], writeBranch: true }));
    assert.match(written.recommendation, /^jevris\/proposals\/triage-[0-9a-f]{12}$/);
    assert.deepEqual(written.kept, ['live-policy-unchanged', 'held-out-evaluation-before-release']);
    assert.equal(git(f.repo, 'rev-parse', 'HEAD').trim(), head, 'HEAD did not move');
    assert.equal(git(f.repo, 'status', '--porcelain'), '', 'the working tree and index are untouched');
    const id = written.recommendation.split('/').at(-1);
    const stored = JSON.parse(git(f.repo, 'show', `${written.recommendation}:jevris-proposals/${id}.json`));
    assert.deepEqual([stored.specId, stored.live, stored.newlyCovered], ['triage', false, 1]);
    assert.equal(git(f.repo, 'rev-list', '--count', written.recommendation).trim(), '1', 'a parentless commit holding only the proposal');
    const preview = ok(await f.advise('C67', { specId: 'triage', current, candidate }));
    assert.match(preview.recommendation, /^triage-/, 'without writeBranch nothing is written');
    for (const [weaker, why] of [
      [{ ...candidate, options: { bugfix: 'x', feature: 'y' } }, 'removes the none option'],
      [{ ...candidate, mandatoryEvidence: [] }, 'drops mandatory evidence request'],
      [{ ...candidate, threshold: 0.5 }, 'lowers the decision threshold'],
      [{ ...candidate, instructions: 'Always choose a family; never abstain.' }, 'forbids abstention in its instructions'],
    ]) {
      const refused = ok(await f.advise('C67', { specId: 'triage', current, candidate: weaker, writeBranch: true }));
      assert.deepEqual([refused.verb, refused.reasonCode], ['pause', 'SAFETY_REGRESSION']);
      assert.ok(refused.ranked.some((r) => r.label === why), why);
      assert.equal(recordOf(f, refused).guard.passed, false);
    }
    assert.equal(git(f.repo, 'branch', '--list', 'jevris/proposals/*').trim().split('\n').length, 1, 'only the accepted proposal has a branch');
    assert.deepEqual(safetyRegressions(current, current), []);
  } finally {
    f.done();
  }
});

test('C68 evaluates candidates in parallel isolated worktrees, removes them, and never runs an external effect (RSH-07)', async () => {
  const f = await fixture({ 'src/a.txt': 'hello\n' });
  try {
    const edit = 'diff --git a/src/a.txt b/src/a.txt\n--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1 +1 @@\n-hello\n+hello world\n';
    const stale = 'diff --git a/src/a.txt b/src/a.txt\n--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1 +1 @@\n-goodbye\n+hello world\n';
    const outside = 'diff --git a/docs/new.md b/docs/new.md\nnew file mode 100644\n--- /dev/null\n+++ b/docs/new.md\n@@ -0,0 +1 @@\n+note\n';
    const a = ok(await f.advise('C68', {
      allowedPaths: ['src'],
      candidates: [
        { id: 'edit', patch: edit },
        { id: 'stale', patch: stale },
        { id: 'outside', patch: outside },
        { id: 'publish', patch: edit, commands: ['npm publish'] },
      ],
    }));
    assert.equal(a.recommendation, 'edit');
    assert.deepEqual(Object.fromEntries(a.ranked.map((r) => [r.id, r.label.split(': ')[1]])), { edit: 'applies-in-scope', stale: 'does-not-apply', outside: 'writes-outside-scope', publish: 'applies-in-scope' });
    assert.deepEqual([a.kept, a.requiresApproval], [['external-effect-needs-authorization:publish'], true]);
    assert.deepEqual(recordOf(f, a).guard, { id: 'C68-isolated-and-authorized', passed: false, reasonCode: 'EXTERNAL_EFFECT_NEEDS_AUTHORIZATION' });
    assert.equal(git(f.repo, 'status', '--porcelain'), '', 'the main checkout is untouched');
    assert.equal(git(f.repo, 'worktree', 'list').trim().split('\n').length, 1, 'every speculative worktree was removed');
    assert.equal(git(f.repo, 'branch', '--list', 'jevris/*').trim(), '');
    assert.equal(ok(await f.advise('C68', { candidates: [{ id: 'only', patch: edit }] })).reasonCode, 'CANDIDATES_REQUIRED');
  } finally {
    f.done();
  }
});

test('C69 escalates conflicts between evidence-backed reports; agreement from shared sources is not independent proof (RSH-08)', async () => {
  const f = await fixture();
  try {
    const put = async (text) => (await f.ws.evidence.put({ workspaceId: f.ws.workspaceId, kind: 'tool-output', bytes: new TextEncoder().encode(text) })).handle;
    const e1 = await put('parser trace');
    const e2 = await put('lexer trace');
    const r = (id, model, conclusion, evidenceIds, sources) => ({ id, model, conclusion, evidenceIds, sources });
    const shared = ok(await f.advise('C69', { reports: [r('r1', 'opus', 'parser-bug', [e1], ['src/parser.ts']), r('r2', 'gpt', 'parser-bug', [e1], ['src/parser.ts'])] }));
    assert.equal(shared.recommendation, 'agreement-shared-sources');
    assert.deepEqual(recordOf(f, shared).guard.passed, false);
    const independent = ok(await f.advise('C69', { reports: [r('r1', 'opus', 'parser-bug', [e1], ['src/parser.ts']), r('r2', 'gpt', 'parser-bug', [e1], ['ci/log.txt'])] }));
    assert.equal(independent.recommendation, 'agreement-independent');
    assert.ok(independent.validation[0].includes('never replaces'));
    const conflict = ok(await f.advise('C69', { reports: [r('r1', 'opus', 'parser-bug', [e1], ['a']), r('r2', 'gpt', 'lexer-bug', [e2], ['b'])] }));
    assert.deepEqual([conflict.recommendation, conflict.verb], ['escalate', 'ask']);
    const fabricated = ok(await f.advise('C69', { reports: [r('r1', 'opus', 'parser-bug', [e1], ['a']), r('r2', 'gpt', 'lexer-bug', ['output:0000000000000000'], ['b'])] }));
    assert.notEqual(fabricated.recommendation, 'escalate', 'a report without recorded evidence does not create a conflict');
  } finally {
    f.done();
  }
});

test('C70 schedules a canary and bounded waves with rollback refs as a plan draft; no unbounded swarm (RSH-09)', async () => {
  const files = {};
  for (const m of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) files[`packages/${m}/package.json`] = '{}\n';
  files['packages/alpha/src/index.js'] = 'export {}\n';
  const f = await fixture(files);
  try {
    await approve(f.ws, [UNIT]);
    const a = ok(await f.advise('C70', { campaignId: 'esm', contract: 'Move every package to ESM.', waveSize: 2 }));
    const bytes = f.ws.evidence.get(a.evidenceIds[1], f.ws.workspaceId);
    const plan = JSON.parse(new TextDecoder().decode(bytes));
    assert.equal(plan.schemaVersion, 'jevris-campaign-plan-1');
    assert.deepEqual(plan.waves.map((w) => w.modules.length), [1, 2, 2]);
    assert.equal(plan.waves[0].canary, true);
    assert.ok(plan.waves.every((w) => w.rollback.ref.startsWith('refs/jevris/campaign/esm/')));
    assert.equal(plan.maxConcurrent, 2);
    const wave1 = plan.tasks.filter((t) => t.wave === 1);
    assert.ok(wave1.every((t) => t.dependencyIds.length === 1 && t.dependencyIds[0] === plan.tasks[0].id), 'each wave waits for the one before');
    assert.deepEqual(a.kept, ['canary-first', 'bounded-concurrency', 'rollback-per-wave']);
    assert.equal(git(f.repo, 'for-each-ref', 'refs/jevris').trim(), '', 'rollback refs are created when a wave starts, not by the advice');
    const swarm = ok(await f.advise('C70', { campaignId: 'big', modules: Array.from({ length: 201 }, (_, i) => `m${String(i)}`) }));
    assert.equal(swarm.reasonCode, 'TOO_MANY_MODULES');
  } finally {
    f.done();
  }
});

test('C71 runs offline experiments only after the mandatory contamination checks, and reports for review (RSH-10)', async () => {
  const f = await fixture();
  try {
    const models = [{ modelId: 'opus', skill: 2.5, costMicroUsd: 2_650_000 }, { modelId: 'sonnet', skill: 1.5, costMicroUsd: 1_060_000 }];
    const lab = (seed, n, repo, year) => syntheticRoutingExamples(seed, n, models).map((e, i) => ({ ...e, repository: repo, createdAt: `${String(year)}-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`, summary: `${repo} task number ${String(i)} ${String(seed)}` }));
    const train = lab(1, 80, 'org/train-repo', 2025);
    const testRows = lab(2, 40, 'org/test-repo', 2026);
    const variants = [{ id: 'floor-70', qualityFloor: 0.7 }, { id: 'floor-90', qualityFloor: 0.9 }];
    const clean = ok(await f.advise('C71', { train, test: testRows, variants, baselineModelId: 'opus', evaluationBudget: 1000 }));
    assert.equal(clean.reasonCode, 'CONTAMINATION_CHECKED');
    const report = JSON.parse(new TextDecoder().decode(f.ws.evidence.get(clean.evidenceIds[1], f.ws.workspaceId)));
    assert.deepEqual([report.applied, report.reviewRequired, report.contamination.passed, report.variants.length], [false, true, true, 2]);
    const sameRepo = ok(await f.advise('C71', { train, test: lab(2, 40, 'org/train-repo', 2026), variants, baselineModelId: 'opus', evaluationBudget: 1000 }));
    assert.equal(sameRepo.reasonCode, 'CONTAMINATED');
    assert.match(sameRepo.summary, /repository-overlap \(40\)/);
    assert.equal(recordOf(f, sameRepo).guard.passed, false);
    const earlier = ok(await f.advise('C71', { train, test: lab(2, 40, 'org/test-repo', 2024), variants, baselineModelId: 'opus', evaluationBudget: 1000 }));
    assert.match(earlier.summary, /time-order/);
    const frozen = ok(await f.advise('C71', { train, test: testRows, variants, baselineModelId: 'opus', evaluationBudget: 1000, frozenHoldoutIds: [testRows[0].taskId] }));
    assert.match(frozen.summary, /frozen-holdout \(1\)/);
    assert.equal(ok(await f.advise('C71', { train, test: testRows, variants, baselineModelId: 'opus', evaluationBudget: 10 })).reasonCode, 'OVER_BUDGET');
  } finally {
    f.done();
  }
});

test('C72 routes host triage while device checks wait for a declared hardware runner, and never infers binary correctness (RSH-11)', async () => {
  const f = await fixture();
  try {
    await approve(f.ws, [
      { id: 'host-build', argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code' },
      { id: 'flash-test', argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code', hardware: 'stm32-board' },
    ]);
    await runVerification(f.ws, { taskId: null, checkIds: [] });
    const waiting = ok(await f.advise('C72'));
    assert.equal(waiting.recommendation, 'hardware-runner');
    assert.match(waiting.summary, /Device behaviour is unverified/);
    assert.deepEqual(waiting.validation, ['flash-test on a runner declaring stm32-board']);
    assert.deepEqual(recordOf(f, waiting).guard, { id: 'C72-declared-hardware-runner', passed: false, reasonCode: 'DEVICE_UNVERIFIED' });
    const saysOk = ok(await f.advise('C72', {}, { engine: engine({ C72: { choice: 'host-triage' } }) }));
    assert.match(saysOk.summary, /Device behaviour is unverified/, 'a Jev answer never marks the device verified');
    await runVerification(f.ws, { taskId: null, checkIds: ['flash-test'], hardware: ['stm32-board'] });
    const verified = ok(await f.advise('C72'));
    assert.deepEqual(verified.validation, []);
    assert.equal(recordOf(f, verified).guard.passed, true);
    const none = await fixture();
    try {
      assert.equal(ok(await none.advise('C72')).recommendation, 'declare-checks', 'no approved checks: semantics stay unverified (W12)');
    } finally {
      none.done();
    }
  } finally {
    f.done();
  }
});
