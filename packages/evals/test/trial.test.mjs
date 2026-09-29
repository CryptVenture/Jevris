import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const e = await import('../dist/index.js');
const contracts = await import('@jevris/contracts');

const ARMS = ['native', 'static', 'rules-only', 'jev-routed', 'routing-only', 'memory-only', 'log-reduction-only', 'combined'];
const COST = { native: 1_000_000, static: 900_000, 'rules-only': 800_000, 'jev-routed': 500_000, 'routing-only': 550_000, 'memory-only': 850_000, 'log-reduction-only': 700_000, combined: 480_000, generative: 1_200_000 };
const WALL = { native: 60_000, static: 58_000, 'rules-only': 55_000, 'jev-routed': 40_000, 'routing-only': 42_000, 'memory-only': 56_000, 'log-reduction-only': 50_000, combined: 39_000, generative: 70_000 };
const unit = (text) => parseInt(createHash('sha256').update(text).digest('hex').slice(0, 8), 16) / 0xffffffff;

/** Mock provider: counts calls and reports usage; it never touches the network. */
function mockProvider() {
  return {
    calls: 0,
    async generate({ arm, taskId }) {
      this.calls += 1;
      const tokens = 2_000 + Math.round(unit(taskId + arm) * 3_000);
      return { inputTokens: tokens, outputTokens: Math.round(tokens / 10) };
    },
  };
}

/** Mock harness driver: deterministic outcomes per task and arm. */
function mockDriver(provider, options = {}) {
  return {
    async run({ task, arm, sandbox }) {
      if (options.checkSandbox) {
        assert.equal(existsSync(join(sandbox.path, 'marker')), false, 'every run gets a fresh sandbox');
        assert.equal(existsSync(join(sandbox.path, 'README.md')), true, 'the fixture repository is copied in');
        writeFileSync(join(sandbox.path, 'marker'), arm);
      }
      if (options.failOn?.(task, arm)) throw new Error('harness crashed');
      const usage = await provider.generate({ arm, taskId: task.taskId });
      const u = unit(task.taskId);
      const noise = unit(task.taskId + arm);
      const verified = (u > 0.2) !== (arm !== 'native' && noise < 0.03);
      return {
        completed: true,
        receipts: [{ id: `receipt-${task.taskId}-${arm}`, passed: verified }],
        retries: noise < 0.1 ? 1 : 0,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costMicroUsd: Math.round(COST[arm] * (0.8 + 0.4 * noise)),
        costSource: 'provider-reported',
        estimatedCostMicroUsd: COST[arm],
        wallMs: Math.round(WALL[arm] * (0.8 + 0.4 * noise)),
        humanMinutes: 5,
        defectEscaped: false,
        abandoned: false,
        safetyFailures: [],
        measuredComponents: ['retries', 'cache', 'verification', 'human-minutes'],
      };
    },
  };
}

const memorySandboxes = { async create() { return { path: 'memory', async dispose() {} }; } };
const tasksFrom = (rows) => rows.map((r, i) => ({ taskId: r.taskId, repository: r.repository, sliceId: r.sliceId, difficulty: ['easy', 'medium', 'hard'][i % 3] }));

test('EVL-05: every task runs under every arm in a fresh sandbox; a crashed run stays in the analysis (intent-to-treat)', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'jevris-trial-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const template = join(base, 'fixture-repo');
  mkdirSync(template);
  writeFileSync(join(template, 'README.md'), 'fixture\n');
  const work = join(base, 'runs');
  mkdirSync(work);
  const tasks = tasksFrom(e.syntheticCorpus({ tasks: 12, slices: ['bounded-edit', 'docs'] }));
  const provider = mockProvider();
  let clock = Date.parse('2026-09-25T00:00:00Z');
  const trial = await e.runTrial({
    tasks, arms: [...ARMS, 'generative'], driver: mockDriver(provider, { checkSandbox: true, failOn: (task, arm) => task.taskId === tasks[3].taskId && arm === 'jev-routed' }),
    sandboxes: e.directorySandboxes(work, template), preRegistrationLockedAt: '2026-09-24T00:00:00Z', seed: 9, now: () => (clock += 1_000),
  });
  assert.equal(trial.ok, true, JSON.stringify(trial));
  assert.equal(trial.rows.length, 12 * 9);
  assert.equal(provider.calls, 12 * 9 - 1);
  assert.deepEqual(readdirSync(work), [], 'every sandbox is removed after its run');
  const crashed = trial.rows.find((r) => r.taskId === tasks[3].taskId && r.arm === 'jev-routed');
  assert.deepEqual([crashed.errorCode, crashed.verified, crashed.abandoned], ['DRIVER_ERROR', false, true]);
  assert.deepEqual(trial.postAssignmentExclusions, []);
  const summary = e.summarizeArm(trial.rows, 'jev-routed');
  assert.equal(summary.tasks, 12, 'the crashed task is still in the denominator');
  assert.equal(summary.abandoned, 1);
  // The arm order is randomized per task, and the same seed reproduces it.
  const orders = new Set(tasks.map((task) => trial.rows.filter((r) => r.taskId === task.taskId).sort((a, b) => a.order - b.order).map((r) => r.arm).join(',')));
  assert.ok(orders.size > 1);
  assert.equal(e.armBalance(trial.rows).balanced, true);
  for (const field of ['completed', 'receipts', 'retries', 'inputTokens', 'outputTokens', 'costMicroUsd', 'wallMs', 'humanMinutes', 'defectEscaped']) assert.ok(field in trial.rows[0], field);
});

test('EVL-05/EVL-12: a trial is refused before the pre-registration is locked, and without every required arm', async () => {
  const tasks = tasksFrom(e.syntheticCorpus({ tasks: 3, slices: ['docs'] }));
  const base = { tasks, arms: ARMS, driver: mockDriver(mockProvider()), sandboxes: memorySandboxes, seed: 1, now: () => Date.parse('2026-09-25T00:00:00Z') };
  assert.deepEqual(await e.runTrial({ ...base, preRegistrationLockedAt: '2026-09-25T00:00:00Z' }), { ok: false, reasonCode: 'PRE_REGISTRATION_NOT_LOCKED' });
  assert.deepEqual(await e.runTrial({ ...base, preRegistrationLockedAt: 'not a time' }), { ok: false, reasonCode: 'PRE_REGISTRATION_NOT_LOCKED' });
  const missing = await e.runTrial({ ...base, arms: ['native', 'jev-routed'], preRegistrationLockedAt: '2026-09-01T00:00:00Z' });
  assert.equal(missing.reasonCode, 'ARMS_MISSING');
  assert.match(missing.detail, /rules-only/);
  assert.equal((await e.runTrial({ ...base, preRegistrationLockedAt: '2026-09-01T00:00:00Z' })).ok, true);
});

test('EVL-12: the power calculation sets the minimum task count, never below the corpus floor', () => {
  const p = e.powerCalculation({ margin: 0.05, alpha: 0.025, power: 0.8, expectedSuccessRate: 0.8 });
  // (1.95996 + 0.84162)^2 * 2 * 0.8 * 0.2 / 0.05^2 = 1004.7
  assert.equal(p.requiredTasks, 1005);
  assert.equal(p.minTasks, 1005);
  assert.equal(e.powerCalculation({ margin: 0.2, alpha: 0.05, power: 0.8, expectedSuccessRate: 0.8 }).minTasks, 300);
  assert.throws(() => e.powerCalculation({ margin: 0, alpha: 0.05, power: 0.8, expectedSuccessRate: 0.8 }), /POWER_INPUT/);
});

const VERSION = '1.2.0';
const NOW = Date.parse('2026-10-01T12:00:00Z');
const owner = generateKeyPairSync('ed25519');
const OWNER = { privateKeyPem: owner.privateKey.export({ type: 'pkcs8', format: 'pem' }), keyId: 'owner-synthetic' };
const TRUSTED_OWNER = new Map([['owner-synthetic', owner.publicKey.export({ type: 'spki', format: 'pem' })]]);
const SLICES = ['bounded-edit', 'test-repair', 'docs', 'refactor'];
const START = '2026-01-01T00:00:00Z';

async function syntheticRelease() {
  const corpus = e.syntheticCorpus({ tasks: 1000, slices: SLICES, start: START, repositories: 20 });
  const split = e.splitCorpus(corpus, { holdoutFrom: new Date(Date.parse(START) + 12 * 7 * 86_400_000).toISOString() });
  const holdout = e.holdoutManifest(split.holdout, { holdoutId: 'synthetic-holdout', releasedAt: '2026-09-01T00:00:00Z' });
  const { record: pre, power } = e.preRegistrationRecord(
    { primaryMetric: 'verified-success-difference', primaryCostMetric: 'median-full-cost-per-verified-task', statisticalTest: 'paired-bootstrap-non-inferiority', margin: 0.1, alpha: 0.05, power: 0.8, expectedSuccessRate: 0.8, latencyTail: { percentile: 95, maxMs: 120_000 }, holdoutHash: holdout.contentHash, lockedAt: '2026-09-10T00:00:00Z' },
    { id: 'prereg-synthetic', producedAt: '2026-09-10T00:00:00Z', version: VERSION, tool: 'evals-synthetic' },
    OWNER,
  );
  let clock = Date.parse('2026-09-20T00:00:00Z');
  const trial = await e.runTrial({ tasks: tasksFrom(split.holdout), arms: ARMS, driver: mockDriver(mockProvider()), sandboxes: memorySandboxes, preRegistrationLockedAt: pre.payload.lockedAt, seed: 4, now: () => (clock += 10) });
  assert.equal(trial.ok, true);
  const comparison = e.compareArms(trial.rows, 'jev-routed', 'rules-only', { resamples: 1000 });
  const protocol = { schemaVersion: '1.0', kind: 'evaluation-protocol', frozenBaseline: ['rules-only', 'native'], splitPolicy: 'repository-and-time', annotationInstruction: 'Verified means an independent test receipt passed.', sourceCorpus: false, trainer: false, holdoutId: holdout.holdoutId, labelledCorpus: true, nonInferiorityMargin: 0.1 };
  const quality = e.qualityTrialRecord({ trial, comparison, preRegistration: pre, protocol, holdout, corpus: e.summarizeCorpus(corpus), mandatoryChecksChanged: false, meta: { id: 'trial-synthetic', producedAt: '2026-09-30T00:00:00Z', version: VERSION, tool: 'evals-synthetic' } });
  const economics = e.economicsRecord({ trial, comparison, packDisableDrills: [{ packId: 'jevris.skill-advice', disabled: true, independent: true, passed: true }], meta: { id: 'economics-synthetic', producedAt: '2026-09-30T00:00:00Z', version: VERSION, tool: 'evals-synthetic' } });
  return { corpus, split, holdout, pre, power, trial, comparison, quality, economics };
}

const release = await syntheticRelease();
// The release gates read the signed baseline release and the seed economics now (A's gate
// records, 7ce08ba); the trial records are checked here at the record level only.

test('EVL-05/EVL-12: the synthetic pre-registration, quality-trial and economics records are valid, bound and pass the quality evaluation', () => {
  const { pre, quality, economics, power } = release;
  for (const record of [pre, quality, economics]) assert.equal(contracts.ReleaseEvidenceContract.validate(record).ok, true, `${record.kind}: ${JSON.stringify(contracts.ReleaseEvidenceContract.validate(record).issues)}`);
  assert.equal(pre.payload.minTasks, power.minTasks);
  assert.ok(quality.payload.tasks >= pre.payload.minTasks, `${quality.payload.tasks} tasks`);
  assert.equal(quality.payload.evaluation.protocol.preRegistrationHash, pre.payloadHash);
  assert.equal(quality.payload.preRegistrationHash, pre.payloadHash);
  assert.equal(contracts.evaluateQualityGate(quality.payload.evaluation).verdict, 'passed', JSON.stringify(contracts.evaluateQualityGate(quality.payload.evaluation)));
  assert.equal(contracts.verifyRecordSignature(pre, TRUSTED_OWNER).ok, true);
  assert.ok(economics.payload.includes.length > 1, JSON.stringify(economics.payload.includes));
  assert.equal(e.lockedBeforeTrial(pre, quality.payload.startedAt), true);
});

test('EVL-12: an unsigned pre-registration, or a trial that began before the lock, does not pass', () => {
  const { pre, quality, economics } = release;
  const { signature, ...unsigned } = pre;
  assert.ok(signature);
  assert.equal(contracts.verifyRecordSignature(unsigned, TRUSTED_OWNER).ok, false);
  const early = contracts.releaseEvidence({ kind: 'quality-trial', id: 'trial-early', producedAt: '2026-09-30T00:00:00Z', version: VERSION, tool: 'evals-synthetic', payload: { ...quality.payload, startedAt: '2026-09-09T00:00:00Z' } });
  assert.equal(e.lockedBeforeTrial(pre, early.payload.startedAt), false);
  assert.equal(economics.kind, 'economics-report');
});

test('EVL-06: the benchmark report carries every §18.6 field, publishes negative results and flags a costly pack', () => {
  const report = e.buildBenchmarkReport(release.trial, {
    datasetProvenance: { corpusId: 'synthetic-1000', holdoutId: release.holdout.holdoutId, holdoutHash: release.holdout.contentHash, consent: 'synthetic' },
    exclusions: release.split.excluded,
    modelVersions: { worker: 'mock-model-1' }, harnessVersions: { claude: 'mock-driver-1' }, questionPolicyHashes: { 'worker-readiness': `sha256:${'a'.repeat(64)}` },
    billingAssumptions: 'API list prices from cost-registry 2026-09-25; synthetic costs.',
    testEnvironment: { os: process.platform, node: process.version, sandbox: 'memory' },
    taskSuccessDefinition: 'An independent verification receipt passed.',
    knownLimitations: ['Synthetic tasks and mock driver: not a measured result.'],
    treatment: 'jev-routed', baselines: ['rules-only', 'native'],
    packs: [{ packId: 'memory-pack', arm: 'memory-only' }, { packId: 'log-pack', arm: 'log-reduction-only' }, { packId: 'absent-pack', arm: 'generative' }],
  });
  assert.deepEqual(e.missingReportFields(report), []);
  assert.equal(report.intentToTreat, true);
  assert.equal(report.subgroupResults.length, SLICES.length);
  assert.equal(report.ablationResults.length, 4);
  assert.deepEqual(report.packsToDisable.map((p) => p.packId), ['memory-pack', 'absent-pack']);
  assert.match(report.packsToDisable[0].reason, /costs more than rules-only/);
  const memory = report.negativeResults.filter((n) => n.comparison === 'memory-only vs rules-only');
  assert.ok(memory.some((n) => /higher cost per verified task/.test(n.finding)), JSON.stringify(memory));
  assert.ok(report.negativeResults.some((n) => /no demonstrated quality difference/.test(n.finding)), 'a null quality result is published');
  assert.equal(report.actualVersusEstimatedCost.length, ARMS.length);
  assert.deepEqual(e.missingReportFields({ ...report, knownLimitations: undefined }), ['knownLimitations']);
});
