import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { load, story } from './lib.mjs';

// US35: a pack claims to cut cost. The release evaluation (evals runTrial, the §18.6 report and
// the economics record) runs every task under the native and rules-only baselines alongside the
// Jevris arms, keeps task-level rows, and counts retries, verification receipts, cache and human
// minutes in the cost it compares. The harness runs are a deterministic stand-in driver here:
// the product driver (F's apps/cli trial driver) runs real harness sessions only in the live,
// opt-in trial (RLS-08), never in npm test.

const unit = (text) => parseInt(createHash('sha256').update(text).digest('hex').slice(0, 8), 16) / 0xffffffff;
const COST = { native: 1_000_000, static: 900_000, 'rules-only': 800_000, 'jev-routed': 500_000, 'routing-only': 550_000, 'memory-only': 850_000, 'log-reduction-only': 700_000, combined: 480_000 };

const driver = {
  async run({ task, arm }) {
    const noise = unit(task.taskId + arm);
    return {
      completed: true,
      receipts: [{ id: `tests-${task.taskId}-${arm}`, passed: unit(task.taskId) > 0.2 }],
      retries: noise < 0.1 ? 1 : 0,
      inputTokens: 3_000,
      outputTokens: 300,
      costMicroUsd: Math.round(COST[arm] * (0.8 + 0.4 * noise)),
      costSource: 'provider-reported',
      estimatedCostMicroUsd: COST[arm],
      wallMs: 40_000 + Math.round(noise * 20_000),
      humanMinutes: arm === 'native' ? 6 : 4,
      defectEscaped: false,
      abandoned: false,
      safetyFailures: [],
      measuredComponents: ['retries', 'cache', 'verification', 'human-minutes'],
    };
  },
};
const sandboxes = { async create() { return { path: 'memory', async dispose() {} }; } };

story('US35', async ({ then, evidence }) => {
  const evals = await load('evals');
  const corpus = evals.syntheticCorpus({ tasks: 60, slices: ['bounded-edit', 'docs'] });
  const tasks = corpus.map((row, i) => ({ taskId: row.taskId, repository: row.repository, sliceId: row.sliceId, difficulty: ['easy', 'medium', 'hard'][i % 3] }));
  let clock = Date.parse('2026-09-20T00:00:00Z');
  const base = { tasks, driver, sandboxes, preRegistrationLockedAt: '2026-09-10T00:00:00Z', seed: 7, now: () => (clock += 10) };
  const withoutBaselines = await evals.runTrial({ ...base, arms: ['jev-routed', 'routing-only', 'memory-only', 'log-reduction-only', 'combined', 'static'] });
  const trial = await evals.runTrial({ ...base, arms: [...evals.REQUIRED_ARMS] });
  const comparison = evals.compareArms(trial.rows, 'jev-routed', 'rules-only', { resamples: 500 });
  const economics = evals.economicsRecord({ trial, comparison, packDisableDrills: [{ packId: 'jevris.skill-advice', disabled: true, independent: true, passed: true }], meta: { id: 'economics-us35', producedAt: new Date().toISOString(), version: '1.2.0', tool: 'acceptance' } });
  const report = evals.buildBenchmarkReport(trial, {
    datasetProvenance: { corpusId: 'synthetic-60', holdoutId: 'synthetic-holdout', holdoutHash: `sha256:${'f'.repeat(64)}`, consent: 'synthetic' },
    exclusions: [], modelVersions: { worker: 'stand-in' }, harnessVersions: { claude: 'stand-in' }, questionPolicyHashes: {},
    billingAssumptions: 'Synthetic costs.', testEnvironment: { os: process.platform, node: process.version, sandbox: 'memory' },
    taskSuccessDefinition: 'An independent verification receipt passed.', knownLimitations: ['Stand-in driver.'],
    treatment: 'jev-routed', baselines: ['rules-only', 'native'], packs: [{ packId: 'memory-pack', arm: 'memory-only' }],
  });
  const rulesOnly = evals.summarizeArm(trial.rows, 'rules-only');
  evidence({ refused: withoutBaselines, rows: trial.rows.length, includes: economics.payload?.includes, baselines: report.baselines, rulesOnly });

  await then('It includes rules-only and native baselines, task-level quality, retries, verification, cache effects and human effort', () => {
    // A trial without the baselines is refused before any run.
    assert.equal(withoutBaselines.ok, false);
    assert.equal(withoutBaselines.reasonCode, 'ARMS_MISSING');
    assert.match(withoutBaselines.detail, /native/);
    assert.match(withoutBaselines.detail, /rules-only/);
    assert.equal(trial.ok, true);
    assert.deepEqual(report.baselines, ['rules-only', 'native']);
    // Task level: one row per task and arm, each verified only by its receipt.
    assert.equal(trial.rows.length, tasks.length * evals.REQUIRED_ARMS.length);
    for (const arm of ['native', 'rules-only']) assert.equal(trial.rows.filter((r) => r.arm === arm).length, tasks.length);
    assert.ok(trial.rows.every((r) => r.verified === r.receipts.some((x) => x.passed)));
    // Retries, verification, cache and human minutes are in the compared cost.
    assert.ok(rulesOnly.retries > 0);
    assert.ok(rulesOnly.humanMinutes > 0);
    assert.deepEqual([...economics.payload.includes].sort(), ['cache', 'human-minutes', 'retries', 'verification']);
    assert.deepEqual(evals.missingReportFields(report), []);
  });
});
