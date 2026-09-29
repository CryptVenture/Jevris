import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * RLS-01, QA-02: every gate passes on valid synthetic evidence and fails, with a named
 * predicate, on missing, stale, foreign, unsigned or invalid evidence. Paired tests only:
 * no test asserts that a gate stays not-a-pass for its own sake.
 */

const root = fileURLToPath(new URL('../../..', import.meta.url));
const contracts = await import('../../../packages/contracts/dist/index.js');
const gates = await import('../dist/gate-records.js');
const evals = await import('../../../packages/evals/dist/index.js');
const core = await import('../../../packages/core/dist/index.js');

const VERSION = '1.2.0';
const COMMIT = 'a'.repeat(40);
const NOW = Date.parse('2026-10-01T12:00:00Z');
const OSES = ['darwin', 'linux', 'win32'];
const HARNESSES = ['claude', 'kilocode', 'codex', 'opencode', 'antigravity'];
// Every shipped harness.json lists worker.route, so each is advertised with owned-worker routing.
const MATRIX = HARNESSES.map((harness) => ({ harness, os: OSES, routing: true }));
// The shipped packs, as loadPackIds lists them (sorted by folder): each needs a disable drill.
const PACKS = ['jevris.memory', 'jevris.observability', 'jevris.skill-advice'];
const HASH = `sha256:${'b'.repeat(64)}`;
// Lifecycle facts with nothing retiring near NOW, for the runs that must pass on other grounds.
const SAFE_MODELS = [{ modelId: 'claude-opus-5-5', displayName: 'Opus 5.5', status: 'active', notBefore: '2027-09-22T00:00:00Z', retiresOn: null, referenced: true }];

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

const owner = keyPair();
const reviewer = keyPair();
const certifier = keyPair();
const calibrator = keyPair();
const stranger = keyPair();
const TRUST = [
  { keyId: 'owner-1', role: 'owner', publicKeyPem: owner.publicPem },
  { keyId: 'reviewer-1', role: 'security-reviewer', publicKeyPem: reviewer.publicPem },
  { keyId: 'cert-1', role: 'certification', publicKeyPem: certifier.publicPem },
  { keyId: 'calib-1', role: 'calibration', publicKeyPem: calibrator.publicPem },
];

let serial = 0;
function ev(kind, payload, extra = {}) {
  serial += 1;
  return contracts.releaseEvidence({
    kind,
    id: `${kind}-${serial}`,
    producedAt: extra.producedAt ?? '2026-09-30T12:00:00Z',
    version: extra.version ?? VERSION,
    commit: extra.commit === undefined ? COMMIT : extra.commit,
    tool: 'synthetic',
    os: extra.os ?? null,
    payload,
  });
}

const signed = (record, key, keyId) => contracts.signRecord(record, key.privatePem, keyId);

function apiPayload(overrides = {}) {
  return {
    schemaVersion: 'jevris.live-suite/1',
    mode: 'live',
    passed: true,
    applied: false,
    primitives: { choice: true, score: true, noul: true, noulHasConfidence: true },
    cancellation: { cancelled: true, reasonCode: 'CANCELLED' },
    errors: [
      { probe: 'invalid-model', failure: 'invalid-request', status: 400, reasonCode: 'INVALID_REQUEST', elapsedMs: 210, expected: 'INVALID_REQUEST', matched: true },
      { probe: 'invalid-schema', failure: 'invalid-request', status: 400, reasonCode: 'INVALID_REQUEST', elapsedMs: 190, expected: 'INVALID_REQUEST', matched: true },
      { probe: 'invalid-key', failure: 'auth', status: 401, reasonCode: 'PROVIDER_DISABLED', elapsedMs: 150, expected: 'PROVIDER_DISABLED', matched: true },
    ],
    caps: { underCapSent: true, overTokenCapRefused: true, overTokenCapSent: false, overCapLimit: 'tokens' },
    usage: { calls: 34, inputTokens: 9000, outputTokens: 1200, estimateAlwaysConservative: true, maxReportedToEstimateRatio: 0.9 },
    latency: {
      calls: 30,
      okCalls: 30,
      p50Ms: 300,
      p95Ms: 700,
      p99Ms: 850,
      maxMs: 900,
      budgetMs: 900,
      withinBudget: 30,
      withinBudgetFraction: 1,
      measureTimeoutMs: 10_000,
      p95TargetMs: 800,
      p95WithinTarget: true,
      failedCalls: 0,
      reasonCounts: {},
      samples: Array.from({ length: 30 }, (_, i) => ({ elapsedMs: 280 + i * 20, ok: true, failure: null, status: null, reasonCode: null })),
    },
    ...overrides,
  };
}

function certification(harness) {
  return contracts.signRecord(
    {
      id: `cert-${harness}`,
      schemaVersion: '1.0',
      harness,
      actuatorId: `${harness}-hooks`,
      harnessVersionRange: { minimum: '1.0.0', maximumExclusive: '99.0.0' },
      operatingSystems: OSES,
      models: [],
      tools: [],
      limitations: [],
      fixtureSuiteHash: HASH,
      features: [
        { featureId: 'hooks.observe', status: 'certified', reasonCode: null },
        { featureId: 'worker.route', status: 'certified', reasonCode: null },
        { featureId: 'hooks.route', status: 'certified', reasonCode: null },
        { featureId: 'worker.actual-model', status: 'certified', reasonCode: null },
        { featureId: 'session.route', status: 'certified', reasonCode: null },
        { featureId: 'models.list-hosts', status: 'certified', reasonCode: null },
        { featureId: 'route.host', status: 'certified', reasonCode: null },
        { featureId: 'access.detect', status: 'certified', reasonCode: null },
        { featureId: 'access.session', status: 'certified', reasonCode: null },
        { featureId: 'access.usage-read', status: 'certified', reasonCode: null },
      ],
      certifiedAt: '2026-09-01T00:00:00Z',
      expiresAt: '2027-03-01T00:00:00Z',
    },
    certifier.privatePem,
    'cert-1',
  );
}

// The owner's seed (quality-trial plan §3): one task selection and one set of run records.
const SEL = `sha256:${'5'.repeat(64)}`;
const RUNS = `sha256:${'6'.repeat(64)}`;

function seedRow(modelId, effort, successes, trials, extra = {}) {
  return {
    priorSliceId: 'issue-fix', modelId, effort, successRate: Math.round((successes / trials) * 10_000) / 10_000, successes, trials,
    benchmark: 'swe-bench-live@b51a8642 (full, after 2026-02-01)', harness: 'claude-code', sourceId: 'seed:swe-bench-live@2026-09',
    url: 'https://huggingface.co/datasets/SWE-bench-Live/SWE-bench-Live', publishedOn: '2026-09-28', fetchedOn: '2026-09-28',
    meanTokens: 9_000_000, meanApiEquivalentUsd: 7.85, selectionHash: SEL, runsHash: RUNS, ...extra,
  };
}

/** The signed beta-posterior baseline release (§18.3 as amended), built the way baseline-release.mjs builds it. */
function baselineArtifact({ seed, key = calibrator, keyId = 'calib-1', expiresAt = '2027-01-01T00:00:00Z' } = {}) {
  const context = core.workerCalibrationContext({ sliceId: '-', nowMs: NOW });
  const proposed = evals.proposeBaselineRelease({
    id: 'baseline-2026-09',
    issuedAt: '2026-09-28T00:00:00Z',
    expiresAt,
    context: {
      decisionSpecId: context.decisionSpecId,
      decisionSpecVersion: context.decisionSpecVersion,
      questionHash: context.questionHash,
      model: { modelId: context.modelId, revisionHash: context.modelRevisionHash },
      encoderHash: context.encoderHash,
    },
    published: core.BUNDLED_PUBLIC_PRIORS,
    seed: seed ?? [seedRow('claude-opus-5-5', 'medium', 7, 12), seedRow('claude-sonnet-5', 'high', 8, 12)],
    defaultEffort: (modelId) => core.registryModel(core.BUNDLED_MODEL_REGISTRY, modelId)?.defaultEffort ?? null,
  });
  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  const released = evals.releaseProposal(proposed.proposal, { reviewerId: 'reviewer-1', reviewedAt: '2026-09-28T00:00:00Z', approved: true }, { privateKeyPem: key.privatePem, keyId });
  assert.equal(released.ok, true, JSON.stringify(released));
  return released.artifact;
}

const baselineEvidence = (options) => ev('baseline-release', baselineArtifact(options), { commit: null, version: '1.2.3' });

/** The package's shipped assets/calibration/calibration-release.json: the same signed baseline. */
let shipped;
const bundledBaseline = () => (shipped ??= baselineArtifact());

/** The seed economics record: candidate against baseline on the same 12 tasks, owner-signed. */
function economicsPayload(overrides = {}) {
  return {
    tasks: 12,
    costPerVerifiedTask: {
      treatment: { point: 520000, lower: 400000, upper: 700000 },
      baseline: { point: 1120000, lower: 900000, upper: 1400000 },
      ratio: { point: 0.46, lower: 0.35, upper: 0.62 },
    },
    timePerVerifiedTask: { ratio: { point: 0.8, lower: 0.65, upper: 1.02 } },
    includes: [...contracts.ECONOMICS_COMPONENTS],
    packDisableDrills: PACKS.map((packId) => ({ packId, disabled: true, independent: true, passed: true })),
    sample: {
      source: 'seed-run',
      planId: 'seed:swe-bench-live@2026-09',
      selectionHash: SEL,
      runsHash: RUNS,
      tasks: 12,
      runs: 24,
      baseline: { modelId: 'claude-opus-5-5', effort: 'medium' },
      candidate: { modelId: 'claude-sonnet-5', effort: 'high' },
      costBases: ['list-price-estimate'],
      confidence: 0.95,
    },
    ...overrides,
  };
}

const economicsEvidence = (payload = economicsPayload(), key = owner, keyId = 'owner-1') => signed(ev('economics-report', payload, { commit: null }), key, keyId);

/** The release run's runtime-gate report: every named test, passed unless `failed` names it. */
function runtimeEvidence(failed = () => false) {
  return ev('runtime-gate-report', { tests: gates.RUNTIME_GATE_TESTS.map((test) => ({ gate: test.gate, file: test.file, name: test.name, passed: !failed(test) })) });
}

/** A complete, valid evidence set for release candidate 1.2.0 at COMMIT. */
function fullSet() {
  const records = [
    ev('api-live-suite', apiPayload()),
    ...HARNESSES.flatMap((harness) =>
      OSES.map((os) =>
        ev('harness-conformance', {
          harness,
          os,
          harnessVersion: '2.1.0',
          realBinary: true,
          fixtureSuiteHash: HASH,
          cases: contracts.CONFORMANCE_CASES.map((id) => ({ id, passed: true, reasonCode: null })),
          workerCases: contracts.CONFORMANCE_CASES.map((id) => ({ id, passed: true, reasonCode: null })),
        }, { os }),
      ),
    ),
    ...HARNESSES.map((harness) => ev('certification-record', certification(harness), { commit: null })),
    ...OSES.map((os) => ev('installed-e2e', { ok: true, full: true, npx: true, steps: [{ id: 'install', ok: true }] }, { os })),
    signed(
      ev('p0-register', {
        questions: contracts.P0_QUESTIONS.map((id) => ({ id, answer: 'Decided and recorded.', decidedBy: 'owner', decidedAt: '2026-09-01T00:00:00Z' })),
        procurement: { status: 'approved', retention: 'Zero retention.', trainingUse: 'No training.', region: 'EU', subprocessors: 'Listed in the contract.' },
      }, { commit: null }),
      owner,
      'owner-1',
    ),
    signed(
      ev('security-review', {
        reviewer: { name: 'Independent Reviewer', organization: 'Review Co', independent: true },
        reportSha256: HASH,
        reportLocation: 'reports/security-review-1.2.pdf',
        reviewedVersion: '1.2.0',
        scope: [...contracts.SECURITY_SCOPE],
        findings: [{ id: 'F-1', severity: 'medium', status: 'fixed' }],
      }, { commit: null }),
      reviewer,
      'reviewer-1',
    ),
    ...OSES.map((os) =>
      ev('threat-model-suite', {
        os,
        cases: contracts.THREAT_CASES.map((id) => ({ id, passed: id !== 'pipe-squat' || os === 'win32', notApplicable: id === 'pipe-squat' && os !== 'win32' })),
      }, { os }),
    ),
    baselineEvidence(),
    economicsEvidence(),
    ...OSES.map((os) =>
      ev('operations-drills', {
        os,
        ranAgainst: 'installed-tarball',
        drills: contracts.OPERATIONS_DRILLS.map((id) => ({ id, passed: true, recordHash: HASH })),
      }, { os }),
    ),
    ev('story-report', {
      stories: gates.STORY_IDS.map((id) => ({ id, passed: true, thenClauses: 2, failures: [] })),
    }),
    ev('workflow-report', { workflows: gates.WORKFLOW_IDS.map((id) => ({ id, passed: true, evidence: [HASH] })) }),
    runtimeEvidence(),
    loadEvidence(),
  ];
  return records;
}

/** A sidecar load run on the reference machine that meets every target (at the limit itself). */
function loadEvidence({ machine = gates.SIDECAR_LOAD_REFERENCE, quick = false, measures = gates.SIDECAR_LOAD_TARGETS.map((t) => ({ id: t.id, value: t.limit })) } = {}) {
  return ev('sidecar-load', { machine: { ...machine }, quick, loadAverage: 3.5, measures }, { os: machine.os });
}

function context(records, overrides = {}) {
  return {
    version: VERSION,
    commit: COMMIT,
    nowMs: NOW,
    evidence: records.map((record) => ({ file: `${record.id}.json`, record })),
    trust: TRUST,
    matrix: MATRIX,
    packs: PACKS,
    bundledBaseline: bundledBaseline(),
    ...overrides,
  };
}

function evaluate(records, overrides) {
  return gates.evaluateGates(context(records, overrides));
}

function gate(report, id) {
  return id === 'acceptance' ? report.acceptance : report.gates.find((item) => item.gate === id);
}

function failing(report, id) {
  return gate(report, id).predicates.filter((item) => !item.ok).map((item) => item.id);
}

test('every synthetic record is a valid ReleaseEvidence record', () => {
  for (const record of fullSet()) {
    const checked = contracts.ReleaseEvidenceContract.validate(record);
    assert.equal(checked.ok, true, `${record.kind}: ${JSON.stringify(checked.issues)}`);
  }
});

test('every gate and the acceptance suites pass on a complete valid evidence set (RLS-01, RLS-12)', () => {
  const report = evaluate(fullSet());
  for (const item of [...report.gates, report.acceptance]) {
    assert.equal(item.verdict, 'pass', `${item.gate}: ${JSON.stringify(item.predicates.filter((p) => !p.ok))}`);
  }
  assert.equal(report.verdict, 'pass');
  assert.deepEqual(report.gates.map((item) => item.gate), [...gates.GATES]);
  assert.match(gates.formatGatesReport(report), /^JEVRIS_GATES pass version 1\.2\.0/);
});

test('perf gate: only a full run on the reference machine counts, and every locked target must be met (owner decision DOMAINS ededdba)', () => {
  const base = fullSet().filter((record) => record.kind !== 'sidecar-load');
  assert.equal(gate(evaluate([...base, loadEvidence()]), 'perf').verdict, 'pass');
  assert.match(gate(evaluate([...base, loadEvidence()]), 'perf').predicates[0].detail, /all 13 load targets met on the reference machine \(darwin arm64, Apple M4 Max, 16 cores, 64 GB\)/);

  const none = gate(evaluate(base), 'perf');
  assert.deepEqual(none.predicates.map((p) => [p.id, p.ok]), [['perf.sidecar-concurrency', false]]);
  assert.match(none.predicates[0].detail, /no accepted sidecar-load record from the reference machine \(darwin arm64, Apple M4 Max, 16 cores, 64 GB\).*npm run bench:load/);

  // A run on another machine is reported, never judged against the absolute targets.
  const linux = gate(evaluate([...base, loadEvidence({ machine: { os: 'linux', arch: 'x64', cpuModel: 'CI runner', cores: 4, memoryGb: 16 } })]), 'perf');
  assert.equal(linux.verdict, 'fail');
  assert.match(linux.predicates[0].detail, /1 run\(s\) on other machines are not judged/);
  const otherCores = gate(evaluate([...base, loadEvidence({ machine: { ...gates.SIDECAR_LOAD_REFERENCE, cores: 12 } })]), 'perf');
  assert.equal(otherCores.verdict, 'fail');

  // Over a limit, or a measure missing: the failing targets are named with their values.
  const slow = loadEvidence({ measures: gates.SIDECAR_LOAD_TARGETS.map((t) => ({ id: t.id, value: t.id === 'load.subagents20.hook-p99-ms' ? 1012 : t.limit })) });
  const judged = gate(evaluate([...base, slow]), 'perf');
  assert.equal(judged.verdict, 'fail');
  assert.match(judged.predicates[0].detail, /load\.subagents20\.hook-p99-ms 1012 > 250/);
  const missing = loadEvidence({ measures: gates.SIDECAR_LOAD_TARGETS.filter((t) => t.id !== 'load.history.p50-ratio').map((t) => ({ id: t.id, value: t.limit })) });
  assert.match(gate(evaluate([...base, missing]), 'perf').predicates[0].detail, /load\.history\.p50-ratio not measured > 1\.5/);
  const nulled = loadEvidence({ measures: gates.SIDECAR_LOAD_TARGETS.map((t) => ({ id: t.id, value: t.id === 'load.lifecycle.queued' ? null : t.limit })) });
  assert.equal(gate(evaluate([...base, nulled]), 'perf').verdict, 'fail');

  // A --quick run is not a measurement; a run for another version or commit does not count.
  assert.match(gate(evaluate([...base, loadEvidence({ quick: true })]), 'perf').predicates[0].detail, /--quick run, which is not a measurement/);
  const foreign = ev('sidecar-load', loadEvidence().payload, { commit: 'c'.repeat(40), os: 'darwin' });
  assert.match(gate(evaluate([...base, foreign]), 'perf').predicates[0].detail, /COMMIT_MISMATCH/);

  // The judge itself: at the limit passes, just over fails.
  const verdicts = gates.judgeSidecarLoad(gates.SIDECAR_LOAD_TARGETS.map((t) => ({ id: t.id, value: t.limit + (t.id === 'load.subagents50.deadline-rate' ? 0.001 : 0) })));
  assert.deepEqual(verdicts.filter((v) => !v.ok).map((v) => v.target.id), ['load.subagents50.deadline-rate']);
});

test('with no evidence every gate fails and names what is missing (QA-02 pair)', () => {
  const report = evaluate([]);
  assert.equal(report.verdict, 'fail');
  for (const item of [...report.gates, report.acceptance]) {
    assert.equal(item.verdict, 'fail', item.gate);
    assert.equal(item.predicates.every((p) => p.detail.length > 0), true);
  }
  assert.match(gates.formatGatesReport(report), /^JEVRIS_GATES not-a-pass/);
});

const without = (records, predicate) => records.filter((record) => !predicate(record));
const replace = (records, kind, make) => records.map((record) => (record.kind === kind ? make(record) : record));

test('api gate: mock mode, too few calls, missing primitive, missing cancellation each fail (RLS-06)', () => {
  const base = without(fullSet(), (r) => r.kind === 'api-live-suite');
  const mock = evaluate([...base, ev('api-live-suite', apiPayload({ mode: 'mock' }))]);
  assert.deepEqual(failing(mock, 'api'), ['api.live-suite']);
  assert.match(gate(mock, 'api').predicates[0].detail, /mock-mode record/);
  const few = evaluate([...base, ev('api-live-suite', apiPayload({ latency: { ...apiPayload().latency, okCalls: 29 } }))]);
  assert.deepEqual(failing(few, 'api'), ['api.latency-sample', 'api.latency-envelope'], 'an unmeasured call leaves the envelope unknown');
  const primitive = evaluate([...base, ev('api-live-suite', apiPayload({ primitives: { choice: true, score: false, noul: true } }))]);
  assert.deepEqual(failing(primitive, 'api'), ['api.primitives']);
  const cancel = evaluate([...base, ev('api-live-suite', apiPayload({ cancellation: { cancelled: false, reasonCode: null } }))]);
  assert.deepEqual(failing(cancel, 'api'), ['api.cancellation']);
  const caps = evaluate([...base, ev('api-live-suite', apiPayload({ caps: { underCapSent: true, overTokenCapRefused: false, overTokenCapSent: true } }))]);
  assert.deepEqual(failing(caps, 'api'), ['api.budget-caps']);
  const errors = evaluate([...base, ev('api-live-suite', apiPayload({ errors: apiPayload().errors.slice(0, 2) }))]);
  assert.deepEqual(failing(errors, 'api'), ['api.error-taxonomy']);
});

test('api-live-suite evidence records every latency call as numbers and codes only (PRV-10)', () => {
  const valid = (payload) => contracts.ReleaseEvidenceContract.validate(ev('api-live-suite', payload)).ok;
  assert.equal(valid(apiPayload()), true);
  const { samples: _samples, ...noSamples } = apiPayload().latency;
  assert.equal(valid(apiPayload({ latency: noSamples })), false, 'every call is recorded');
  const { reasonCounts: _counts, ...noCounts } = apiPayload().latency;
  assert.equal(valid(apiPayload({ latency: noCounts })), false, 'failures are counted per reason code');
  const failed = { elapsedMs: 4950, ok: false, failure: 'timeout', status: null, reasonCode: 'DEADLINE' };
  const withFailure = apiPayload({ latency: { ...apiPayload().latency, okCalls: 29, failedCalls: 1, reasonCounts: { DEADLINE: 1 }, samples: [...apiPayload().latency.samples.slice(1), failed] } });
  assert.equal(valid(withFailure), true);
  const leaky = apiPayload({ latency: { ...apiPayload().latency, samples: [{ ...failed, detail: 'remote body text' }] } });
  assert.equal(valid(leaky), false, 'a sample row is closed: no room for a body or remote text');
  const prose = apiPayload({ latency: { ...apiPayload().latency, reasonCounts: { 'upstream said no': 1 } } });
  assert.equal(valid(prose), false, 'reason counts are keyed by reason codes only');
  const textCode = apiPayload({ latency: { ...apiPayload().latency, samples: [{ ...failed, reasonCode: 'the provider said: bad key' }] } });
  assert.equal(valid(textCode), false);
});

test('api gate: a timed-out or mismatched error probe shows no taxonomy (RLS-06)', () => {
  const base = without(fullSet(), (r) => r.kind === 'api-live-suite');
  const [model, schema, key] = apiPayload().errors;
  const timedOut = { ...model, failure: 'timeout', status: null, reasonCode: 'DEADLINE', elapsedMs: 5000, matched: false };
  const deadline = evaluate([...base, ev('api-live-suite', apiPayload({ errors: [timedOut, schema, key] }))]);
  assert.deepEqual(failing(deadline, 'api'), ['api.error-taxonomy']);
  assert.match(gate(deadline, 'api').predicates.find((p) => p.id === 'api.error-taxonomy').detail, /invalid-model DEADLINE, not the expected code/);
  // A legacy record without `matched` still cannot count a DEADLINE as a taxonomy answer.
  const { expected: _e, matched: _m, ...legacy } = timedOut;
  const old = evaluate([...base, ev('api-live-suite', apiPayload({ errors: [legacy, schema, key] }))]);
  assert.deepEqual(failing(old, 'api'), ['api.error-taxonomy']);
  const wrong = evaluate([...base, ev('api-live-suite', apiPayload({ errors: [model, schema, { ...key, failure: 'forbidden', status: 403, reasonCode: 'PROVIDER_ERROR', matched: false }] }))]);
  assert.deepEqual(failing(wrong, 'api'), ['api.error-taxonomy']);
});

test('api gate: the latency envelope is judged visibly: pass inside the targets, WARN outside, never silent (RLS-06, SSOT §17.4)', () => {
  const base = without(fullSet(), (r) => r.kind === 'api-live-suite');
  const envelope = (report) => gate(report, 'api').predicates.find((p) => p.id === 'api.latency-envelope');
  const inside = evaluate([...base, ev('api-live-suite', apiPayload())]);
  assert.equal(gate(inside, 'api').verdict, 'pass');
  assert.equal(envelope(inside).warning, undefined);
  assert.match(envelope(inside).detail, /p95 700 ms within the 800 ms target; 30 of 30 calls \(100%\) within the 900 ms budget, measured with a 10000 ms timeout/);
  const slowTail = evaluate([...base, ev('api-live-suite', apiPayload({ latency: { ...apiPayload().latency, p95Ms: 4623, p99Ms: 4623, maxMs: 4623, withinBudget: 24, withinBudgetFraction: 0.8, p95WithinTarget: false } }))]);
  assert.equal(gate(slowTail, 'api').verdict, 'pass', 'the targets are unmeasured engineering targets, not SLOs');
  assert.equal(envelope(slowTail).ok, true);
  assert.equal(envelope(slowTail).warning, true, 'printed WARN, so it cannot pass silently');
  assert.match(envelope(slowTail).detail, /p95 4623 ms over the 800 ms target; 24 of 30 calls \(80%\) within the 900 ms budget/);
  assert.match(envelope(slowTail).detail, /release owner decides/);
  const manyOver = evaluate([...base, ev('api-live-suite', apiPayload({ latency: { ...apiPayload().latency, withinBudget: 27, withinBudgetFraction: 0.9 } }))]);
  assert.equal(envelope(manyOver).warning, true, 'p95 inside the target, but too few calls inside the budget');
  const { measureTimeoutMs: _t, ...censored } = apiPayload().latency;
  assert.equal(contracts.ReleaseEvidenceContract.validate(ev('api-live-suite', apiPayload({ latency: censored }))).ok, false, 'a record says how it measured');
});

test('api gate: the failed live run at 2092f52e, recorded with diagnostics, fails every row it should (RLS-06)', () => {
  const base = without(fullSet(), (r) => r.kind === 'api-live-suite');
  const samples = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? { elapsedMs: 241 + i, ok: true, failure: null, status: null, reasonCode: null } : { elapsedMs: 4950, ok: false, failure: 'timeout', status: null, reasonCode: 'DEADLINE' }));
  const [model, schema, key] = apiPayload().errors;
  const failed = apiPayload({
    passed: false,
    errors: [{ ...model, failure: 'timeout', status: null, reasonCode: 'DEADLINE', elapsedMs: 5000, matched: false }, schema, { ...key, failure: 'timeout', status: null, reasonCode: 'DEADLINE', elapsedMs: 5000, matched: false }],
    usage: { ...apiPayload().usage, calls: 16 },
    latency: { ...apiPayload().latency, okCalls: 15, failedCalls: 15, p95Ms: 4623, withinBudget: 12, withinBudgetFraction: 0.4, p95WithinTarget: false, reasonCounts: { DEADLINE: 15 }, samples },
  });
  const report = evaluate([...base, ev('api-live-suite', failed)]);
  assert.deepEqual(failing(report, 'api'), ['api.suite-passed', 'api.error-taxonomy', 'api.usage-reconciled', 'api.latency-sample', 'api.latency-envelope']);
  assert.match(gate(report, 'api').predicates.find((p) => p.id === 'api.latency-sample').detail, /15 of 30 calls measured.*failed: DEADLINE 15/);
});

test('freshness, version, commit and payload provenance exclude a record (RLS-01)', () => {
  const base = without(fullSet(), (r) => r.kind === 'api-live-suite');
  const stale = evaluate([...base, ev('api-live-suite', apiPayload(), { producedAt: '2026-08-01T00:00:00Z' })]);
  assert.match(gate(stale, 'api').predicates[0].detail, /STALE/);
  const future = evaluate([...base, ev('api-live-suite', apiPayload(), { producedAt: '2026-10-02T00:00:00Z' })]);
  assert.match(gate(future, 'api').predicates[0].detail, /FROM_THE_FUTURE/);
  const version = evaluate([...base, ev('api-live-suite', apiPayload(), { version: '1.1.9' })]);
  assert.match(gate(version, 'api').predicates[0].detail, /VERSION_MISMATCH/);
  const commit = evaluate([...base, ev('api-live-suite', apiPayload(), { commit: 'c'.repeat(40) })]);
  assert.match(gate(commit, 'api').predicates[0].detail, /COMMIT_MISMATCH/);
  const tampered = ev('api-live-suite', apiPayload());
  const edited = { ...tampered, payload: { ...tampered.payload, passed: true, mode: 'live', usage: { ...tampered.payload.usage, calls: 99 } } };
  assert.equal(contracts.ReleaseEvidenceContract.validate(edited).ok, false, 'the contract refuses a payload hash mismatch');
  assert.equal(gates.exclusionReason(edited, context([])), 'PAYLOAD_HASH_MISMATCH');
  // Without a candidate commit, commit binding is not applied; the version still is.
  const noCommit = evaluate([...base, ev('api-live-suite', apiPayload(), { commit: 'c'.repeat(40) })], { commit: null });
  assert.equal(gate(noCommit, 'api').verdict, 'pass');
});

test('harness gate needs a passing real-binary run for every advertised harness and OS (HCF-02)', () => {
  const records = fullSet();
  const missing = evaluate(without(records, (r) => r.kind === 'harness-conformance' && r.payload.harness === 'codex' && r.payload.os === 'win32'));
  assert.deepEqual(failing(missing, 'harness'), ['harness.codex.win32', 'harness.codex.worker.win32']);
  const fixtureOnly = evaluate(replace(records, 'harness-conformance', (r) => (r.payload.harness === 'kilocode' && r.payload.os === 'linux' ? ev('harness-conformance', { ...r.payload, realBinary: false }, { os: 'linux' }) : r)));
  assert.deepEqual(failing(fixtureOnly, 'harness'), ['harness.kilocode.linux', 'harness.kilocode.worker.linux']);
  const caseFails = evaluate(replace(records, 'harness-conformance', (r) =>
    r.payload.harness === 'claude' && r.payload.os === 'darwin'
      ? ev('harness-conformance', { ...r.payload, cases: r.payload.cases.map((c) => (c.id === 'user-pin' ? { ...c, passed: false, reasonCode: 'PIN_CHANGED' } : c)) }, { os: 'darwin' })
      : r,
  ));
  assert.deepEqual(failing(caseFails, 'harness'), ['harness.claude.darwin']);
  // A narrower support matrix is judged on what it advertises, never on more.
  const narrow = evaluate(without(records, (r) => r.kind === 'harness-conformance' && r.payload.harness === 'antigravity'), {
    matrix: MATRIX.filter((entry) => entry.harness !== 'antigravity'),
  });
  assert.equal(gate(narrow, 'harness').verdict, 'pass');
});

test('security gate: unsigned or foreign-signed register, open procurement, open high finding, missing OS suite (RLS-05, RLS-07)', () => {
  const records = fullSet();
  const unsigned = evaluate(replace(records, 'p0-register', (r) => {
    const { signature, ...rest } = r;
    return rest;
  }));
  assert.match(gate(unsigned, 'security').predicates.find((p) => p.id === 'security.p0-register').detail, /SIGNATURE_MISSING_SIGNATURE/);
  const foreign = evaluate(replace(records, 'p0-register', (r) => {
    const { signature, ...rest } = r;
    return signed(rest, stranger, 'owner-1');
  }));
  assert.match(gate(foreign, 'security').predicates.find((p) => p.id === 'security.p0-register').detail, /SIGNATURE_BAD_SIGNATURE/);
  const reviewerSignedRegister = evaluate(replace(records, 'p0-register', (r) => {
    const { signature, ...rest } = r;
    return signed(rest, reviewer, 'reviewer-1');
  }));
  assert.match(gate(reviewerSignedRegister, 'security').predicates.find((p) => p.id === 'security.p0-register').detail, /UNKNOWN_KEY/);
  const open = evaluate(replace(records, 'p0-register', (r) => {
    const { signature, ...rest } = r;
    return signed(ev('p0-register', { ...rest.payload, procurement: { ...rest.payload.procurement, status: 'open' } }, { commit: null }), owner, 'owner-1');
  }));
  assert.deepEqual(failing(open, 'security'), ['security.procurement-closed']);
  const finding = evaluate(replace(records, 'security-review', (r) => {
    const { signature, ...rest } = r;
    return signed(ev('security-review', { ...rest.payload, findings: [{ id: 'F-9', severity: 'high', status: 'open' }] }, { commit: null }), reviewer, 'reviewer-1');
  }));
  assert.deepEqual(failing(finding, 'security'), ['security.findings-closed']);
  const noWindows = evaluate(without(records, (r) => r.kind === 'threat-model-suite' && r.payload.os === 'win32'));
  assert.deepEqual(failing(noWindows, 'security'), ['security.threat-model.win32']);
  const pipeOnPosixOnly = evaluate(replace(records, 'threat-model-suite', (r) =>
    r.payload.os === 'win32'
      ? ev('threat-model-suite', { os: 'win32', cases: r.payload.cases.map((c) => (c.id === 'pipe-squat' ? { ...c, passed: false, notApplicable: true } : c)) }, { os: 'win32' })
      : r,
  ));
  assert.deepEqual(failing(pipeOnPosixOnly, 'security'), ['security.threat-model.win32'], 'pipe squat is never not-applicable on Windows');
});

test('quality gate: the signed beta-posterior baseline release, trusted, released, unexpired, backed by the 24-run seed (§18.3, §22.2 as amended 6d7222a)', () => {
  const records = fullSet();
  const base = without(records, (r) => r.kind === 'baseline-release');
  const pass = gate(evaluate(records), 'quality');
  assert.equal(pass.verdict, 'pass');
  assert.deepEqual(pass.predicates.map((p) => p.id), ['quality.baseline-release', 'quality.baseline-method', 'quality.baseline-shipped', 'quality.baseline-seed', 'quality.learning-gate']);
  assert.match(pass.predicates[2].detail, /^assets\/calibration\/calibration-release\.json is the baseline record's payload \(sha256:/);
  assert.match(pass.predicates[3].detail, /24 seed runs \(need 24\)/);
  // No 300-task trial or pre-registration is asked for any more.
  assert.equal(pass.predicates.some((p) => /trial|pre-registration/.test(p.id)), false);

  const missing = evaluate(base);
  assert.deepEqual(failing(missing, 'quality'), ['quality.baseline-release']);
  // Signed by a key that is not a trusted calibration key.
  const foreign = evaluate([...base, baselineEvidence({ key: stranger, keyId: 'calib-1' })]);
  assert.match(gate(foreign, 'quality').predicates[0].detail, /BASELINE_SIGNATURE_BAD_SIGNATURE/);
  const unknown = evaluate([...base, baselineEvidence({ key: stranger, keyId: 'someone-else' })]);
  assert.match(gate(unknown, 'quality').predicates[0].detail, /BASELINE_SIGNATURE_UNKNOWN_KEY/);
  // The certification key does not sign a baseline.
  const wrongRole = evaluate([...base, baselineEvidence({ key: certifier, keyId: 'cert-1' })]);
  assert.match(gate(wrongRole, 'quality').predicates[0].detail, /BASELINE_SIGNATURE_UNKNOWN_KEY/);
  // Expired, or bound to another major.minor.
  const expired = evaluate(records, { nowMs: Date.parse('2027-01-01T00:00:01Z') });
  assert.match(gate(expired, 'quality').predicates[0].detail, /BASELINE_EXPIRED/);
  const other = evaluate([...base, ev('baseline-release', baselineArtifact(), { commit: null, version: '1.3.0' })]);
  assert.match(gate(other, 'quality').predicates[0].detail, /VERSION_MISMATCH/);
  // A tampered artifact fails its signature; a draft is not a release.
  const good = records.find((r) => r.kind === 'baseline-release');
  const tampered = evaluate([...base, ev('baseline-release', { ...good.payload, expiresAt: '2027-06-01T00:00:00Z' }, { commit: null })]);
  assert.match(gate(tampered, 'quality').predicates[0].detail, /BASELINE_SIGNATURE_/);
  const { signature: _s, ...unsignedDraft } = { ...good.payload, releaseState: 'draft' };
  const draft = evaluate([...base, ev('baseline-release', contracts.signRecord(unsignedDraft, calibrator.privatePem, 'calib-1'), { commit: null })]);
  assert.match(gate(draft, 'quality').predicates[0].detail, /BASELINE_DRAFT/);
});

test('quality gate: the seed must be at least 24 runs from one selection and one set of run records (§22.2)', () => {
  const base = without(fullSet(), (r) => r.kind === 'baseline-release');
  const smallRecord = baselineEvidence({ seed: [seedRow('claude-opus-5-5', 'medium', 5, 10), seedRow('claude-sonnet-5', 'high', 6, 10)] });
  const small = evaluate([...base, smallRecord], { bundledBaseline: smallRecord.payload });
  assert.deepEqual(failing(small, 'quality'), ['quality.baseline-seed']);
  assert.match(gate(small, 'quality').predicates[3].detail, /20 seed runs \(need 24\)/);
  // The builder refuses mixed seeds (SEED_HASH_MISMATCH); a hand-signed release can still carry them.
  const { signature: _sig, ...unsignedArtifact } = baselineArtifact();
  const mixed = { ...unsignedArtifact, baselineSources: unsignedArtifact.baselineSources.map((source, index) => (index === 1 ? { ...source, runsHash: `sha256:${'7'.repeat(64)}` } : source)) };
  assert.equal(contracts.CalibrationArtifactContract.validate({ ...mixed, signature: _sig }).ok, true);
  const splitRecord = ev('baseline-release', contracts.signRecord(mixed, calibrator.privatePem, 'calib-1'), { commit: null });
  const split = evaluate([...base, splitRecord], { bundledBaseline: splitRecord.payload });
  assert.deepEqual(failing(split, 'quality'), ['quality.baseline-seed']);
  assert.match(gate(split, 'quality').predicates[3].detail, /do not share one selectionHash and runsHash/);
});

test('quality gate: the package ships the gated baseline as its day-1 baseline, the same signed artifact (C ba96731)', async (t) => {
  const records = fullSet();
  assert.equal(gates.BUNDLED_BASELINE_PATH, core.BUNDLED_CALIBRATION_PARTS.join('/'), 'the gate checks the file route learning loads');
  assert.equal(gate(evaluate(records), 'quality').verdict, 'pass');
  // Not shipped: the baseline checks do not apply (827fc87), whatever baseline record is present.
  for (const absent of [null, undefined]) {
    const none = gate(evaluate(records, { bundledBaseline: absent }), 'quality');
    assert.equal(none.verdict, 'pass');
    assert.deepEqual(none.predicates.map((p) => p.id), ['quality.default-start', 'quality.learning-gate']);
    assert.match(none.predicates[0].detail, /no assets\/calibration\/calibration-release\.json in the package: every workspace starts on the approved default/);
  }
  // Shipped, but another artifact: a different signed release, or the right one edited.
  const other = gate(evaluate(records, { bundledBaseline: baselineArtifact({ expiresAt: '2027-02-01T00:00:00Z' }) }), 'quality');
  assert.deepEqual(other.predicates.filter((p) => !p.ok).map((p) => p.id), ['quality.baseline-shipped']);
  assert.match(other.predicates[2].detail, /is not the baseline record's payload/);
  const edited = gate(evaluate(records, { bundledBaseline: { ...bundledBaseline(), id: 'baseline-edited' } }), 'quality');
  assert.equal(edited.verdict, 'fail');
  // Key order and whitespace do not matter: the check is the canonical content hash.
  const reordered = Object.fromEntries(Object.entries(bundledBaseline()).reverse());
  assert.equal(gate(evaluate(records, { bundledBaseline: reordered }), 'quality').verdict, 'pass');

  // The gates command reads the file from the package root, and treats an unreadable one as absent.
  const pkg = mkdtempSync(join(tmpdir(), 'jevris-gates-pkg-'));
  t.after(() => rmSync(pkg, { recursive: true, force: true }));
  assert.equal(await gates.loadBundledBaseline(pkg), null);
  mkdirSync(join(pkg, 'assets', 'calibration'), { recursive: true });
  writeFileSync(join(pkg, 'assets', 'calibration', 'calibration-release.json'), '{ not json');
  assert.equal(await gates.loadBundledBaseline(pkg), null);
  writeFileSync(join(pkg, 'assets', 'calibration', 'calibration-release.json'), `${JSON.stringify(bundledBaseline(), null, 2)}\n`);
  assert.deepEqual(await gates.loadBundledBaseline(pkg), bundledBaseline());
});

test('a release without a seed (827fc87): quality is the run-time learning gate, economics the in-use reporting, each proven by its named tests in the release run', () => {
  const noSeed = without(fullSet(), (r) => r.kind === 'baseline-release' || r.kind === 'economics-report');
  const report = evaluate(noSeed, { bundledBaseline: null });
  const quality = gate(report, 'quality');
  const economics = gate(report, 'economics');
  assert.equal(quality.verdict, 'pass', JSON.stringify(quality.predicates));
  assert.equal(economics.verdict, 'pass', JSON.stringify(economics.predicates));
  assert.deepEqual(economics.predicates.map((p) => p.id), ['economics.in-use', 'economics.pack-disable']);
  const counts = (check) => gates.RUNTIME_GATE_TESTS.filter((test) => test.check === check).length;
  for (const check of ['quality.learning-gate', 'economics.in-use', 'economics.pack-disable']) assert.ok(counts(check) > 0, check);
  assert.match(quality.predicates[1].detail, new RegExp(`^${counts('quality.learning-gate')} named test\\(s\\) of the run-time learning gate`));
  // The named tests exist, verbatim, in the files they name: a rename fails this, not only the gate.
  for (const test of gates.RUNTIME_GATE_TESTS) {
    const text = readFileSync(join(root, test.file), 'utf8');
    assert.ok(text.includes(test.name) || text.includes(test.name.replaceAll("'", "\\'")), `${test.file}: ${test.name}`);
  }

  // No report, a failed or skipped test, or a report from another commit: the gates fail and name it.
  const withoutReport = without(noSeed, (r) => r.kind === 'runtime-gate-report');
  const missing = evaluate(withoutReport, { bundledBaseline: null });
  assert.deepEqual(failing(missing, 'quality'), ['quality.learning-gate']);
  assert.deepEqual(failing(missing, 'economics'), ['economics.in-use', 'economics.pack-disable']);
  assert.match(gate(missing, 'quality').predicates[1].detail, /no accepted runtime-gate-report record/);
  const first = gates.RUNTIME_GATE_TESTS.find((test) => test.check === 'quality.learning-gate');
  const oneFailed = evaluate([...withoutReport, runtimeEvidence((test) => test === first)], { bundledBaseline: null });
  assert.deepEqual(failing(oneFailed, 'quality'), ['quality.learning-gate']);
  assert.ok(gate(oneFailed, 'quality').predicates[1].detail.includes(`failed, skipped or missing: ${first.file}: ${first.name}`));
  assert.equal(gate(oneFailed, 'economics').verdict, 'pass');
  const inUse = gates.RUNTIME_GATE_TESTS.find((test) => test.check === 'economics.in-use');
  const renamed = ev('runtime-gate-report', { tests: gates.RUNTIME_GATE_TESTS.map((test) => ({ gate: test.gate, file: test.file, name: test === inUse ? `${test.name} (renamed)` : test.name, passed: true })) });
  assert.deepEqual(failing(evaluate([...withoutReport, renamed], { bundledBaseline: null }), 'economics'), ['economics.in-use']);
  const stale = evaluate([...withoutReport, ev('runtime-gate-report', runtimeEvidence().payload, { commit: 'b'.repeat(40) })], { bundledBaseline: null });
  assert.match(gate(stale, 'quality').predicates[1].detail, /COMMIT_MISMATCH/);

  // A seed economics record, when present, is still judged as before; a rejected one is named.
  const seeded = evaluate([...noSeed, economicsEvidence()], { bundledBaseline: null });
  assert.equal(gate(seeded, 'economics').predicates.some((p) => p.id === 'economics.sample-size'), true);
  const unsigned = evaluate([...noSeed, ev('economics-report', economicsPayload(), { commit: null })], { bundledBaseline: null });
  assert.deepEqual(failing(unsigned, 'economics'), ['economics.report']);
  // A shipped baseline brings the baseline checks back: here with no baseline record, it fails.
  const shippedNoRecord = evaluate(noSeed, { bundledBaseline: bundledBaseline() });
  assert.deepEqual(failing(shippedNoRecord, 'quality'), ['quality.baseline-release']);
});

test('economics gate: owner-signed seed record, intervals, full cost components, improvement surviving the interval, pack disable drills (RLS-09)', () => {
  const records = fullSet();
  const base = without(records, (r) => r.kind === 'economics-report');
  const swap = (overrides) => [...base, economicsEvidence(economicsPayload(overrides))];
  assert.equal(gate(evaluate(records), 'economics').verdict, 'pass');
  const noHuman = evaluate(swap({ includes: ['retries', 'cache', 'verification'] }));
  assert.deepEqual(failing(noHuman, 'economics'), ['economics.full-cost']);
  const noSurvive = evaluate(swap({
    costPerVerifiedTask: { ...economicsPayload().costPerVerifiedTask, ratio: { point: 0.95, lower: 0.8, upper: 1.1 } },
    timePerVerifiedTask: { ratio: { point: 0.97, lower: 0.85, upper: 1.05 } },
  }));
  assert.deepEqual(failing(noSurvive, 'economics'), ['economics.improvement']);
  const badInterval = evaluate(swap({ timePerVerifiedTask: { ratio: { point: 0.9, lower: 0.95, upper: 1.0 } } }));
  assert.deepEqual(failing(badInterval, 'economics'), ['economics.intervals']);
  const undrilled = evaluate(records, { packs: [...PACKS, 'second-pack'] });
  assert.deepEqual(failing(undrilled, 'economics'), ['economics.pack-disable']);
  // The owner signs it; unsigned or foreign-signed does not count.
  const unsigned = evaluate([...base, ev('economics-report', economicsPayload(), { commit: null })]);
  assert.deepEqual(failing(unsigned, 'economics'), ['economics.report']);
  assert.match(gate(unsigned, 'economics').predicates[0].detail, /SIGNATURE_/);
  const foreign = evaluate([...base, economicsEvidence(economicsPayload(), stranger, 'owner-1')]);
  assert.deepEqual(failing(foreign, 'economics'), ['economics.report']);
});

test('economics gate: the sample is the 24-run seed on 12 paired tasks, the same seed as the baseline release (owner decision 2d1c6a0)', () => {
  const records = fullSet();
  const base = without(records, (r) => r.kind === 'economics-report');
  const withSample = (sample) => evaluate([...base, economicsEvidence(economicsPayload({ sample: { ...economicsPayload().sample, ...sample } }))]);
  const pass = gate(evaluate(records), 'economics');
  assert.match(pass.predicates.find((p) => p.id === 'economics.sample-size').detail, /12 paired tasks \(need 12\), 24 runs \(need 24\), 95% intervals/);
  assert.match(pass.predicates.find((p) => p.id === 'economics.seed-bound').detail, /the seed of baseline baseline-2026-09/);
  assert.deepEqual(failing(withSample({ tasks: 11 }), 'economics'), ['economics.sample-size']);
  assert.deepEqual(failing(withSample({ runs: 23 }), 'economics'), ['economics.sample-size']);
  // Another seed than the one the baseline was built from.
  assert.deepEqual(failing(withSample({ runsHash: `sha256:${'8'.repeat(64)}` }), 'economics'), ['economics.seed-bound']);
  assert.deepEqual(failing(withSample({ selectionHash: `sha256:${'9'.repeat(64)}` }), 'economics'), ['economics.seed-bound']);
  // A record with no seed sample (the retired trial path) does not count as the seed.
  const { sample: _sample, ...trialShaped } = economicsPayload();
  const noSample = evaluate([...base, economicsEvidence(trialShaped)]);
  assert.deepEqual(failing(noSample, 'economics'), ['economics.sample-size', 'economics.seed-bound']);
  // Without an accepted baseline there is nothing to bind the seed to.
  const noBaseline = evaluate(without(records, (r) => r.kind === 'baseline-release'));
  assert.deepEqual(failing(noBaseline, 'economics'), ['economics.seed-bound']);
});

test('operations gate needs every drill on every OS against the installed tarball (OBS-05)', () => {
  const records = fullSet();
  const source = evaluate(replace(records, 'operations-drills', (r) => (r.payload.os === 'linux' ? ev('operations-drills', { ...r.payload, ranAgainst: 'source-tree' }, { os: 'linux' }) : r)));
  assert.deepEqual(failing(source, 'operations'), ['operations.drills.linux']);
  const diskFull = evaluate(replace(records, 'operations-drills', (r) =>
    r.payload.os === 'darwin' ? ev('operations-drills', { ...r.payload, drills: r.payload.drills.filter((d) => d.id !== 'disk-full') }, { os: 'darwin' }) : r,
  ));
  assert.match(gate(diskFull, 'operations').predicates.find((p) => p.id === 'operations.drills.darwin').detail, /disk-full/);
});

test('harness gate: a harness advertised with routing also needs the nine §15.4 cases under <harness>.worker (worker.route, DOMAINS 72ff950)', () => {
  const records = fullSet();
  const workerRow = (r, make) => (r.payload.harness === 'opencode' && r.payload.os === 'linux' ? ev('harness-conformance', make(r.payload), { os: 'linux' }) : r);
  // A run from before worker.route: the hooks pass, the worker actuator is unproven.
  const hooksOnly = evaluate(replace(records, 'harness-conformance', (r) => workerRow(r, ({ workerCases, ...rest }) => rest)));
  assert.deepEqual(failing(hooksOnly, 'harness'), ['harness.opencode.worker.linux']);
  assert.match(gate(hooksOnly, 'harness').predicates.find((p) => p.id === 'harness.opencode.worker.linux').detail, /no opencode\.worker cases; run jevris certify --harness opencode on linux/);
  const cancel = evaluate(replace(records, 'harness-conformance', (r) =>
    workerRow(r, (p) => ({ ...p, workerCases: p.workerCases.map((c) => (c.id === 'cancellation' ? { ...c, passed: false, reasonCode: 'NOT_CANCELLED' } : c)) })),
  ));
  assert.deepEqual(failing(cancel, 'harness'), ['harness.opencode.worker.linux']);
  assert.match(gate(cancel, 'harness').predicates.find((p) => p.id === 'harness.opencode.worker.linux').detail, /cancellation/);
  const partial = evaluate(replace(records, 'harness-conformance', (r) => workerRow(r, (p) => ({ ...p, workerCases: p.workerCases.slice(0, 8) }))));
  assert.deepEqual(failing(partial, 'harness'), ['harness.opencode.worker.linux']);
  // No run at all names both actuators.
  const none = evaluate(without(records, (r) => r.kind === 'harness-conformance' && r.payload.harness === 'codex' && r.payload.os === 'darwin'));
  assert.deepEqual(failing(none, 'harness'), ['harness.codex.darwin', 'harness.codex.worker.darwin']);
  // Passing: every advertised harness, version and OS has its worker predicate, with the version named.
  const pass = gate(evaluate(records), 'harness');
  assert.equal(pass.verdict, 'pass');
  const workerIds = pass.predicates.filter((p) => p.id.includes('.worker.')).map((p) => p.id);
  assert.equal(workerIds.length, HARNESSES.length * OSES.length);
  assert.match(pass.predicates.find((p) => p.id === 'harness.kilocode.worker.win32').detail, /kilocode\.worker on kilocode 2\.1\.0 passed all 9/);
  // A harness not advertised with routing is judged on its hooks alone.
  const noRouting = evaluate(replace(records, 'harness-conformance', (r) => workerRow(r, ({ workerCases, ...rest }) => rest)), {
    matrix: MATRIX.map((entry) => (entry.harness === 'opencode' ? { harness: entry.harness, os: entry.os } : entry)),
  });
  assert.equal(gate(noRouting, 'harness').verdict, 'pass');
  assert.equal(gate(noRouting, 'harness').predicates.some((p) => p.id.startsWith('harness.opencode.worker.')), false);
});

test('portability gate: a harness advertised with routing needs a published record carrying worker.route certified (worker.route, §22.2)', () => {
  const records = fullSet();
  const withFeatures = (harness, features) =>
    replace(records, 'certification-record', (r) => {
      if (r.payload.harness !== harness) return r;
      const { signature, ...unsignedCert } = r.payload;
      return ev('certification-record', contracts.signRecord({ ...unsignedCert, features }, certifier.privatePem, 'cert-1'), { commit: null });
    });
  const hooksOnly = evaluate(withFeatures('codex', [{ featureId: 'hooks.observe', status: 'certified', reasonCode: null }]));
  assert.deepEqual(
    failing(hooksOnly, 'portability'),
    OSES.flatMap((os) => [`portability.worker-route.codex.${os}`, `portability.worker-actual-model.codex.${os}`, `portability.access-detect.codex.${os}`, `portability.access-usage-read.codex.${os}`]),
  );
  assert.match(gate(hooksOnly, 'portability').predicates.find((p) => p.id === 'portability.worker-route.codex.darwin').detail, /does not carry worker\.route/);
  const demoted = evaluate(withFeatures('claude', [
    { featureId: 'hooks.observe', status: 'certified', reasonCode: null },
    { featureId: 'hooks.route', status: 'certified', reasonCode: null },
    { featureId: 'worker.route', status: 'unsupported', reasonCode: 'WORKER_FLAG_MISSING' },
    { featureId: 'access.detect', status: 'certified', reasonCode: null },
    { featureId: 'access.session', status: 'certified', reasonCode: null },
  ]));
  assert.deepEqual(failing(demoted, 'portability'), OSES.map((os) => `portability.worker-route.claude.${os}`));
  assert.match(gate(demoted, 'portability').predicates.find((p) => p.id === 'portability.worker-route.claude.linux').detail, /unsupported \(WORKER_FLAG_MISSING\)/);
  // Passing: one worker-route predicate per advertised harness and OS.
  const pass = gate(evaluate(records), 'portability');
  assert.equal(pass.predicates.filter((p) => p.id.startsWith('portability.worker-route.')).every((p) => p.ok), true);
  assert.equal(pass.predicates.filter((p) => p.id.startsWith('portability.worker-route.')).length, HARNESSES.length * OSES.length);
  // Without routing advertised, worker.route is not required.
  const noRouting = evaluate(withFeatures('codex', [{ featureId: 'hooks.observe', status: 'certified', reasonCode: null }]), {
    matrix: MATRIX.map((entry) => (entry.harness === 'codex' ? { harness: entry.harness, os: entry.os, routing: false } : entry)),
  });
  assert.equal(gate(noRouting, 'portability').verdict, 'pass');
});

test('portability gate: a harness advertised with routing needs each route actuator that applies to it certified (R33: hooks.route, worker.actual-model, session.route; R57: models.list-hosts, route.host; R69: access.detect, access.session; K21: access.usage-read)', () => {
  const records = fullSet();
  const withFeatures = (harness, features) =>
    replace(records, 'certification-record', (r) => {
      if (r.payload.harness !== harness) return r;
      const { signature, ...unsignedCert } = r.payload;
      return ev('certification-record', contracts.signRecord({ ...unsignedCert, features }, certifier.privatePem, 'cert-1'), { commit: null });
    });
  const cert = (featureId, status = 'certified', reasonCode = null) => ({ featureId, status, reasonCode });
  // Which harness needs which: Antigravity (no custom endpoint) needs none of them.
  assert.deepEqual(
    gates.ROUTED_FEATURES.map((f) => [f.featureId, f.slug, [...f.harnesses]]),
    [
      // 1.2 does not require Codex subagent routing for release (coordinator's decision after RC5).
      ['hooks.route', 'hooks-route', ['claude', 'kilocode', 'opencode']],
      ['worker.actual-model', 'worker-actual-model', ['codex', 'kilocode', 'opencode']],
      ['session.route', 'session-route', ['kilocode', 'opencode']],
      ['models.list-hosts', 'models-list-hosts', ['kilocode', 'opencode']],
      ['route.host', 'route-host', ['kilocode', 'opencode']],
      ['access.detect', 'access-detect', ['claude', 'codex', 'kilocode', 'opencode']],
      ['access.session', 'access-session', ['claude', 'kilocode', 'opencode']],
      ['access.usage-read', 'access-usage-read', ['codex']],
    ],
  );
  const pass = gate(evaluate(records), 'portability');
  assert.equal(pass.verdict, 'pass');
  for (const [slug, count] of [['hooks-route', 3], ['worker-actual-model', 3], ['session-route', 2], ['models-list-hosts', 2], ['route-host', 2], ['access-detect', 4], ['access-session', 3], ['access-usage-read', 1]]) {
    assert.equal(pass.predicates.filter((p) => p.id.startsWith(`portability.${slug}.`)).length, count * OSES.length, slug);
  }
  assert.equal(pass.predicates.some((p) => /^portability\.(hooks-route|worker-actual-model|session-route|models-list-hosts|route-host|access-detect|access-session)\.antigravity\./.test(p.id)), false);
  assert.equal(pass.predicates.some((p) => /^portability\.access-session\.codex\./.test(p.id)), false);
  assert.equal(pass.predicates.some((p) => /^portability\.(models-list-hosts|route-host)\.(claude|codex)\./.test(p.id)), false);
  assert.equal(pass.predicates.some((p) => /^portability\.access-usage-read\.(claude|kilocode|opencode|antigravity)\./.test(p.id)), false);
  // K21 (DOMAINS 3298853d): the Codex usage read passes as unsupported only on win32, only with
  // ACCESS_USAGE_ISOLATION_UNAVAILABLE; on macOS and Linux only a certified isolated run passes.
  const codexBase = [cert('hooks.observe'), cert('worker.route'), cert('hooks.route'), cert('worker.actual-model'), cert('access.detect')];
  const noIsolation = evaluate(withFeatures('codex', [...codexBase, cert('access.usage-read', 'unsupported', 'ACCESS_USAGE_ISOLATION_UNAVAILABLE')]));
  assert.deepEqual(failing(noIsolation, 'portability'), OSES.filter((os) => os !== 'win32').map((os) => `portability.access-usage-read.codex.${os}`));
  assert.match(gate(noIsolation, 'portability').predicates.find((p) => p.id === 'portability.access-usage-read.codex.win32').detail, /unsupported \(ACCESS_USAGE_ISOLATION_UNAVAILABLE\): a documented gap/);
  assert.match(gate(noIsolation, 'portability').predicates.find((p) => p.id === 'portability.access-usage-read.codex.linux').detail, /access\.usage-read unsupported \(ACCESS_USAGE_ISOLATION_UNAVAILABLE\)$/);
  for (const reason of ['ACCESS_USAGE_READ_CASE_FAILED', 'ACCESS_USAGE_ISOLATION_VIOLATED', 'ACCESS_SESSION_EVENT_ABSENT']) {
    const blocked = evaluate(withFeatures('codex', [...codexBase, cert('access.usage-read', 'unsupported', reason)]));
    assert.deepEqual(failing(blocked, 'portability'), OSES.map((os) => `portability.access-usage-read.codex.${os}`), reason);
  }
  // 1.2 does not require Codex subagent routing: a Codex record whose K2 failed (hooks.route
  // unsupported, ROUTE_CASE_FAILED) or that lacks hooks.route passes the portability gate.
  const codexNoRoute = [cert('hooks.observe'), cert('worker.route'), cert('worker.actual-model'), cert('access.detect'), cert('access.usage-read')];
  assert.equal(gate(evaluate(withFeatures('codex', [...codexNoRoute, cert('hooks.route', 'unsupported', 'ROUTE_CASE_FAILED')])), 'portability').verdict, 'pass');
  assert.equal(gate(evaluate(withFeatures('codex', codexNoRoute)), 'portability').verdict, 'pass');
  assert.equal(pass.predicates.some((p) => /^portability\.hooks-route\.codex\./.test(p.id)), false);
  const noRead = evaluate(withFeatures('codex', codexBase));
  assert.deepEqual(failing(noRead, 'portability'), OSES.map((os) => `portability.access-usage-read.codex.${os}`));
  // A Kilo record without session.route, as today: the gate says to certify again.
  const access = [cert('access.detect'), cert('access.session'), cert('route.host')];
  const noSession = evaluate(withFeatures('kilocode', [cert('hooks.observe'), cert('worker.route'), cert('hooks.route'), cert('worker.actual-model'), cert('models.list-hosts'), ...access]));
  assert.deepEqual(failing(noSession, 'portability'), OSES.map((os) => `portability.session-route.kilocode.${os}`));
  assert.match(gate(noSession, 'portability').predicates.find((p) => p.id === 'portability.session-route.kilocode.linux').detail, /does not carry session\.route; run jevris certify --harness kilocode on linux again/);
  // An OpenCode record whose route actuator is unsupported names the reason.
  const unsupported = evaluate(withFeatures('opencode', [cert('hooks.observe'), cert('worker.route'), cert('hooks.route', 'unsupported', 'ACTUATOR_UNSUPPORTED'), cert('worker.actual-model'), cert('session.route'), cert('models.list-hosts'), ...access]));
  // K13 (R57): a listing case that did not run (routing.modelListing off, or no listing) is never a pass.
  const notRun = evaluate(withFeatures('opencode', [cert('hooks.observe'), cert('worker.route'), cert('hooks.route'), cert('worker.actual-model'), cert('session.route'), cert('models.list-hosts', 'unsupported', 'MODELS_LIST_HOSTS_NOT_RUN'), ...access]));
  assert.deepEqual(failing(notRun, 'portability'), OSES.map((os) => `portability.models-list-hosts.opencode.${os}`));
  assert.match(gate(notRun, 'portability').predicates.find((p) => p.id === 'portability.models-list-hosts.opencode.linux').detail, /models\.list-hosts unsupported \(MODELS_LIST_HOSTS_NOT_RUN\)/);
  // models.list-hosts is its own predicate: a certified models.list does not stand in for it.
  const listOnly = evaluate(withFeatures('kilocode', [cert('hooks.observe'), cert('worker.route'), cert('hooks.route'), cert('worker.actual-model'), cert('session.route'), cert('models.list'), ...access]));
  assert.deepEqual(failing(listOnly, 'portability'), OSES.map((os) => `portability.models-list-hosts.kilocode.${os}`));
  // R69: access.session passes as unsupported only with ACCESS_SESSION_EVENT_ABSENT (a binary that never sends the event).
  const claudeBase = [cert('hooks.observe'), cert('worker.route'), cert('hooks.route'), cert('access.detect')];
  const absent = evaluate(withFeatures('claude', [...claudeBase, cert('access.session', 'unsupported', 'ACCESS_SESSION_EVENT_ABSENT')]));
  assert.equal(gate(absent, 'portability').verdict, 'pass');
  assert.match(gate(absent, 'portability').predicates.find((p) => p.id === 'portability.access-session.claude.linux').detail, /unsupported \(ACCESS_SESSION_EVENT_ABSENT\): a documented gap/);
  // Every other access reason blocks: a failed case, a case that did not run, hooks not running, or a missing feature.
  for (const reason of ['ACCESS_SESSION_CASE_FAILED', 'ACCESS_SESSION_CASE_NOT_RUN', 'ACCESS_SESSION_NEEDS_HOOKS']) {
    const blocked = evaluate(withFeatures('claude', [...claudeBase, cert('access.session', 'unsupported', reason)]));
    assert.deepEqual(failing(blocked, 'portability'), OSES.map((os) => `portability.access-session.claude.${os}`), reason);
  }
  for (const reason of ['ACCESS_DETECT_CASE_FAILED', 'ACCESS_DETECT_CASE_NOT_RUN']) {
    const blocked = evaluate(withFeatures('codex', [cert('hooks.observe'), cert('worker.route'), cert('hooks.route'), cert('worker.actual-model'), cert('access.detect', 'unsupported', reason), cert('access.usage-read')]));
    assert.deepEqual(failing(blocked, 'portability'), OSES.map((os) => `portability.access-detect.codex.${os}`), reason);
  }
  // The accepted pair is for access.session only: access.detect never passes as unsupported.
  const detectAbsent = evaluate(withFeatures('claude', [cert('hooks.observe'), cert('worker.route'), cert('hooks.route'), cert('access.detect', 'unsupported', 'ACCESS_SESSION_EVENT_ABSENT'), cert('access.session')]));
  assert.deepEqual(failing(detectAbsent, 'portability'), OSES.map((os) => `portability.access-detect.claude.${os}`));
  // R50: route.host blocks with each certify reason; host routes stay advice without it.
  for (const reason of ['ROUTE_HOST_NEEDS_SESSION_ROUTE', 'ROUTE_HOST_CASE_NOT_RUN', 'ROUTE_HOST_CASE_FAILED']) {
    const blocked = evaluate(withFeatures('kilocode', [cert('hooks.observe'), cert('worker.route'), cert('hooks.route'), cert('worker.actual-model'), cert('session.route'), cert('models.list-hosts'), cert('access.detect'), cert('access.session'), cert('route.host', 'unsupported', reason)]));
    assert.deepEqual(failing(blocked, 'portability'), OSES.map((os) => `portability.route-host.kilocode.${os}`), reason);
    assert.match(gate(blocked, 'portability').predicates.find((p) => p.id === 'portability.route-host.kilocode.linux').detail, new RegExp(`route\\.host unsupported \\(${reason}\\)`));
  }
  const noAccess = evaluate(withFeatures('opencode', [cert('hooks.observe'), cert('worker.route'), cert('hooks.route'), cert('worker.actual-model'), cert('session.route'), cert('models.list-hosts'), cert('route.host')]));
  assert.deepEqual(failing(noAccess, 'portability').sort(), OSES.flatMap((os) => [`portability.access-detect.opencode.${os}`, `portability.access-session.opencode.${os}`]).sort());
  assert.deepEqual(failing(unsupported, 'portability'), OSES.map((os) => `portability.hooks-route.opencode.${os}`));
  assert.match(gate(unsupported, 'portability').predicates.find((p) => p.id === 'portability.hooks-route.opencode.darwin').detail, /hooks\.route unsupported \(ACTUATOR_UNSUPPORTED\)/);
  // Antigravity with only worker.route still passes; without routing advertised nothing is required.
  const agy = evaluate(withFeatures('antigravity', [cert('hooks.observe'), cert('worker.route')]));
  assert.equal(gate(agy, 'portability').verdict, 'pass');
  const noRouting = evaluate(withFeatures('opencode', [cert('hooks.observe')]), {
    matrix: MATRIX.map((entry) => (entry.harness === 'opencode' ? { harness: entry.harness, os: entry.os, routing: false } : entry)),
  });
  assert.equal(gate(noRouting, 'portability').verdict, 'pass');
});

test('portability gate: signed unexpired certification per advertised combination and the installed e2e per OS (RLS-10, RLS-04)', () => {
  const records = fullSet();
  const expired = evaluate(records, { nowMs: Date.parse('2027-03-01T00:00:01Z') });
  assert.equal(gate(expired, 'portability').predicates.filter((p) => p.id.startsWith('portability.certified.')).every((p) => !p.ok), true);
  const forged = evaluate(replace(records, 'certification-record', (r) => {
    const { signature, ...unsignedCert } = r.payload;
    return ev('certification-record', contracts.signRecord(unsignedCert, stranger.privatePem, 'cert-1'), { commit: null });
  }));
  assert.match(gate(forged, 'portability').predicates[0].detail, /CERTIFICATION_SIGNATURE_BAD_SIGNATURE/);
  const noE2e = evaluate(without(records, (r) => r.kind === 'installed-e2e' && r.environment.os === 'win32'));
  assert.deepEqual(failing(noE2e, 'portability'), ['portability.installed-e2e.win32']);
  const quick = evaluate(replace(records, 'installed-e2e', (r) => (r.environment.os === 'linux' ? ev('installed-e2e', { ...r.payload, full: false }, { os: 'linux' }) : r)));
  assert.deepEqual(failing(quick, 'portability'), ['portability.installed-e2e.linux']);
});

test('acceptance: every story US01..US40 and workflow W01..W12 must pass (RLS-02, RLS-03)', () => {
  const records = fullSet();
  const story = records.find((r) => r.kind === 'story-report');
  const oneFails = evaluate(replace(records, 'story-report', () => ev('story-report', { stories: story.payload.stories.map((s) => (s.id === 'US07' ? { ...s, passed: false, failures: ['Then clause 2'] } : s)) })));
  assert.match(oneFails.acceptance.predicates[0].detail, /US07/);
  assert.equal(oneFails.verdict, 'fail');
  const missingFlow = evaluate(replace(records, 'workflow-report', () => ev('workflow-report', { workflows: gates.WORKFLOW_IDS.slice(0, 11).map((id) => ({ id, passed: true, evidence: [] })) })));
  assert.match(missingFlow.acceptance.predicates[1].detail, /W12/);
});

function writeEvidence(dir, records) {
  mkdirSync(dir, { recursive: true });
  for (const record of records) writeFileSync(join(dir, `${record.id}.json`), JSON.stringify(record));
}

test('runGatesCommand: exit 0 on a passing set, 1 on a failing one, 2 on usage errors; --json and --out (RLS-12)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-gates-'));
  try {
    writeEvidence(join(dir, 'evidence'), fullSet());
    let text = '';
    const write = (chunk) => {
      text += chunk;
    };
    const code = await gates.runGatesCommand(['--evidence', join(dir, 'evidence'), '--commit', COMMIT, '--json', '--out', join(dir, 'out')], write, {
      nowMs: NOW,
      trust: TRUST,
      root,
      bundledBaseline: bundledBaseline(),
      models: SAFE_MODELS,
    });
    const report = JSON.parse(text);
    assert.equal(code, 0, JSON.stringify(report.gates.filter((g) => g.verdict !== 'pass')));
    assert.equal(report.verdict, 'pass');
    assert.equal(JSON.parse(readFileSync(join(dir, 'out', 'gates-report.json'), 'utf8')).verdict, 'pass');
    assert.match(readFileSync(join(dir, 'out', 'gates-report.txt'), 'utf8'), /^JEVRIS_GATES pass/);

    // The shipped trust store holds no key yet: signed human evidence cannot pass by default.
    text = '';
    assert.equal(await gates.runGatesCommand(['--evidence', join(dir, 'evidence')], write, { nowMs: NOW, root }), 1);
    assert.match(text, /SIGNATURE_UNKNOWN_KEY/);

    text = '';
    assert.equal(await gates.runGatesCommand(['--nope'], write, { root }), 2);
    assert.match(text, /^Usage: jevris gates/);
    assert.equal(await gates.runGatesCommand(['--commit', 'short'], write, { root }), 2);
    assert.equal(await gates.runGatesCommand(['--help'], write, { root }), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gates --out is confined: inside a Jevris private directory or through a symlink it is refused with exit 2 and nothing written; an ordinary folder is written (GOV-11)', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-gates-out-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeEvidence(join(dir, 'evidence'), fullSet());
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const { jevrisPaths } = await import('../../../packages/platform/dist/index.js');
  const privateDir = join(jevrisPaths({ home }).data, 'reports');
  let refusals = '';
  const run = (out) => gates.runGatesCommand(['--evidence', join(dir, 'evidence'), '--commit', COMMIT, '--home', home, '--out', out], () => {}, { nowMs: NOW, trust: TRUST, root, bundledBaseline: bundledBaseline(), models: SAFE_MODELS, cwd: dir, env: {}, err: (line) => { refusals += line; } });

  assert.equal(await run(privateDir), 2);
  assert.match(refusals, /^gates: --out refused \(OUTPUT_PRIVATE_DIR\): /);
  assert.equal(existsSync(join(privateDir, 'gates-report.json')), false);

  const real = join(dir, 'real');
  mkdirSync(real);
  symlinkSync(real, join(dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  refusals = '';
  assert.equal(await run(join(dir, 'linked', 'reports')), 2);
  assert.match(refusals, /\(OUTPUT_SYMLINK\)/);
  assert.deepEqual(readdirSync(real), [], 'nothing was written through the link');

  refusals = '';
  assert.equal(await run(join(dir, 'reports')), 0);
  assert.equal(refusals, '');
  assert.equal(JSON.parse(readFileSync(join(dir, 'reports', 'gates-report.json'), 'utf8')).verdict, 'pass');
});

test('quality.model-retirement warns on an upcoming date, a passed "not sooner than" date and a deprecated model, and never fails on them (owner decisions 3ff4c0f, 9d1e7eb)', () => {
  const at = (iso) => Date.parse(iso);
  const facts = gates.modelLifecycleFacts();
  const quality = (nowMs, models = facts) => gate(evaluate(fullSet(), { nowMs, models }), 'quality');
  const retirement = (nowMs, models = facts) => quality(nowMs, models).predicates.find((p) => p.id === 'quality.model-retirement');
  const fact = (modelId, extra) => ({ modelId, displayName: modelId, status: 'active', notBefore: null, retiresOn: null, referenced: false, ...extra });

  // The bundled registry names the baselines (each harness's default, OD-3) and the public priors' models.
  assert.deepEqual(facts.filter((m) => m.referenced).map((m) => m.modelId).sort(), ['claude-fable-5-1', 'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5', 'gemini-3.8-flash', 'gpt-6-sol']);

  // Within 30 days: pinned 2026-09-27, Haiku 4.5's "not sooner than" 2026-10-15 is 18 days away.
  const now = at('2026-09-27T00:00:00Z');
  assert.deepEqual(gates.retiringModels(facts, now).map((m) => [m.modelId, m.daysLeft, m.warning]), [['claude-haiku-4-5-20251001', 18, null]]);
  const warned = retirement(now);
  assert.deepEqual([warned.ok, warned.warning], [true, true]);
  assert.match(warned.detail, /^warning: Haiku 4\.5 \(claude-haiku-4-5-20251001\) may retire from 2026-10-15, in 18 day\(s\); the router recommends it until retired\. Refresh the bundled registry by the model refresh procedure \(RELEASING\.md, model retirement\), then npm run registry:check$/);
  // At the evidence set's own time (NOW, 13 days out) the whole quality gate passes, printed WARN.
  assert.equal(quality(NOW).verdict, 'pass', JSON.stringify(quality(NOW).predicates.filter((p) => !p.ok)));
  const text = gates.formatGatesReport(evaluate(fullSet(), { nowMs: NOW, models: facts }));
  assert.match(text, /\n  WARN quality\.model-retirement: warning: Haiku 4\.5/);
  assert.match(text, /^JEVRIS_GATES pass /);

  // 31 days before Sonnet 5's date is clean and names it next; 30 days before warns.
  const sonnet = at('2027-06-30T00:00:00Z');
  const later = facts.filter((m) => m.modelId !== 'claude-haiku-4-5-20251001');
  const clear = retirement(sonnet - 31 * 86_400_000, later);
  assert.deepEqual([clear.ok, clear.warning], [true, undefined]);
  assert.match(clear.detail, /^no recommended model may retire within 30 days \(\d+ recommended; next: Sonnet 5 \(claude-sonnet-5\) may retire from 2027-06-30, in 31 day\(s\)\)$/);
  assert.deepEqual([retirement(sonnet - 30 * 86_400_000, later).ok, retirement(sonnet - 30 * 86_400_000, later).warning], [true, true]);

  // A passed "not sooner than" date only warns (MODEL_RETIREMENT_DUE): the bundled Haiku 4.5 on 2026-10-16,
  // and at NOW a named model whose "not sooner than" date passed the day before.
  const due = retirement(at('2026-10-16T00:00:00Z'));
  assert.deepEqual([due.ok, due.warning], [true, true]);
  assert.match(due.detail, /Haiku 4\.5 \(claude-haiku-4-5-20251001\) may be retired any day: its "not sooner than" date 2026-10-15 has passed \(MODEL_RETIREMENT_DUE\)/);
  const dueNamed = [...later, fact('claude-due', { referenced: true, notBefore: '2026-09-30T00:00:00Z' })];
  assert.equal(quality(NOW, dueNamed).verdict, 'pass');
  // A deprecated model warns (MODEL_DEPRECATED), even far from any date.
  const deprecated = retirement(NOW, [...later, fact('claude-old', { status: 'deprecated', notBefore: '2028-01-01T00:00:00Z' })]);
  assert.deepEqual([deprecated.ok, deprecated.warning], [true, true]);
  assert.match(deprecated.detail, /claude-old \(claude-old\) is deprecated \(MODEL_DEPRECATED\), may retire from 2028-01-01/);
  // Without lifecycle facts the evaluator adds no such check; jevris gates always supplies them.
  assert.equal(gate(evaluate(fullSet(), { nowMs: now }), 'quality').predicates.some((p) => p.id === 'quality.model-retirement'), false);
});

test('quality.model-retirement fails only on inconsistent release data: a retired model shipped data names, a stale entry past its firm date, a shipped baseline prior that is retired (owner decision 9d1e7eb)', () => {
  const later = gates.modelLifecycleFacts().filter((m) => m.modelId !== 'claude-haiku-4-5-20251001');
  const fact = (modelId, extra) => ({ modelId, displayName: modelId, status: 'active', notBefore: null, retiresOn: null, referenced: false, ...extra });
  const failing = (models, overrides = {}) => gate(evaluate(fullSet(), { nowMs: NOW, models, ...overrides }), 'quality').predicates.filter((p) => !p.ok);
  const only = (models, overrides) => {
    const bad = failing(models, overrides);
    assert.deepEqual(bad.map((p) => p.id), ['quality.model-retirement']);
    return bad[0].detail;
  };
  // (a) The baseline (or a prior's model) retired: by status, or by a firm date already passed.
  assert.match(only([...later, fact('claude-named', { referenced: true, status: 'retired' })]), /^the release data is inconsistent: claude-named \(claude-named\) is retired, yet shipped data still names it\. Refresh the bundled registry by /);
  assert.match(only([...later, fact('claude-named', { referenced: true, status: 'deprecated', retiresOn: '2026-09-30T00:00:00Z' })]), /claude-named \(claude-named\) retired on 2026-09-30, yet shipped data still names it/);
  // (b) An entry still active, or deprecated, past its firm date, named or not: stale registry data.
  assert.match(only([...later, fact('claude-stale', { retiresOn: '2026-09-30T00:00:00Z' })]), /claude-stale \(claude-stale\) still says active although its retirement date 2026-09-30 has passed/);
  assert.match(only([...later, fact('claude-stale', { status: 'deprecated', retiresOn: '2026-09-30T00:00:00Z' })]), /claude-stale \(claude-stale\) still says deprecated although its retirement date 2026-09-30 has passed/);
  // (c) The shipped signed baseline uses a retired model as a prior.
  const prior = bundledBaseline().modelQualities[0].modelId;
  const withPrior = [...later.filter((m) => m.modelId !== prior), fact(prior, { status: 'retired' })];
  assert.match(only(withPrior), new RegExp(`the shipped baseline assets/calibration/calibration-release\\.json uses the retired ${prior} \\(${prior}\\) as a prior`));
  // Not a failure: a retired model nothing names (the router already refuses it), a firm date still ahead,
  // and the same retired prior when the package ships no baseline.
  assert.deepEqual(failing([...later, fact('claude-gone', { status: 'retired' }), fact('claude-soon', { referenced: true, retiresOn: '2027-01-01T00:00:00Z' })]), []);
  const noBaseline = gate(evaluate(fullSet().filter((r) => r.kind !== 'baseline-release'), { nowMs: NOW, models: withPrior.map((m) => (m.modelId === prior ? { ...m, referenced: false } : m)), bundledBaseline: null }), 'quality');
  assert.equal(noBaseline.predicates.find((p) => p.id === 'quality.model-retirement').ok, true);
});

test('the gate composes core: its references are shippedModelReferences, and retiredAt and staleAt equal lifecycleStatus for every bundled model, date edge and status (C f5b19ab)', () => {
  const registry = core.BUNDLED_MODEL_REGISTRY;
  const named = new Set(core.shippedModelReferences(registry).map((ref) => ref.modelId));
  assert.ok(named.has(registry.baselineModelId));
  assert.deepEqual(gates.modelLifecycleFacts().filter((m) => m.referenced).map((m) => m.modelId).sort(), registry.entries.map((m) => m.modelId).filter((id) => named.has(id)).sort());
  // Each bundled entry as shipped, and with each status and a firm date, around every date it carries.
  const firm = '2026-11-02T00:00:00Z';
  const variants = registry.entries.flatMap((model) => [
    model,
    ...['active', 'deprecated', 'retired'].map((status) => ({ ...model, lifecycle: { ...model.lifecycle, status, retiresOn: firm } })),
  ]);
  const edges = (model) => [model.lifecycle?.retiresOn, model.lifecycle?.retirementNotBefore].filter((d) => typeof d === 'string').flatMap((d) => [Date.parse(d) - 1, Date.parse(d), Date.parse(d) + 1]);
  let compared = 0;
  for (const model of variants) {
    const [fact] = gates.modelLifecycleFacts({ ...registry, entries: [model] }, []);
    for (const nowMs of [NOW, ...edges(model)]) {
      const status = core.lifecycleStatus(model, nowMs);
      assert.equal(gates.retiredAt(fact, nowMs), status.retired, `${model.modelId} ${model.lifecycle?.status} retired at ${new Date(nowMs).toISOString()}`);
      assert.equal(gates.staleAt(fact, nowMs), status.stale, `${model.modelId} ${model.lifecycle?.status} stale at ${new Date(nowMs).toISOString()}`);
      compared += 1;
    }
  }
  assert.ok(compared >= variants.length * 4);
});

test('jevris gates reads the bundled registry: at a pinned 2026-10-01 it passes with a WARN for Haiku 4.5, and on 2026-10-16 it warns MODEL_RETIREMENT_DUE (quality.model-retirement)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-gates-retire-'));
  try {
    writeEvidence(join(dir, 'evidence'), fullSet());
    const run = async (nowMs) => {
      let text = '';
      const code = await gates.runGatesCommand(['--evidence', join(dir, 'evidence'), '--commit', COMMIT], (chunk) => (text += chunk), { nowMs, trust: TRUST, root, bundledBaseline: bundledBaseline() });
      return { code, text };
    };
    const soon = await run(NOW);
    assert.equal(soon.code, 0, soon.text);
    assert.match(soon.text, /\n  WARN quality\.model-retirement: warning: Haiku 4\.5 .* in 13 day\(s\)/);
    // Later the evidence set itself is stale, but the retirement line is still only a warning.
    const due = await run(Date.parse('2026-10-16T00:00:00Z'));
    assert.match(due.text, /\n  WARN quality\.model-retirement: warning: Haiku 4\.5 .*MODEL_RETIREMENT_DUE/);
    assert.doesNotMatch(due.text, /FAIL quality\.model-retirement/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadEvidence rejects non-JSON, invalid, oversize and symlinked files with a reason and counts none of them', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-evidence-'));
  try {
    const [one] = fullSet();
    writeEvidence(join(dir, 'nested', 'deeper'), [one]);
    writeFileSync(join(dir, 'broken.json'), '{not json');
    writeFileSync(join(dir, 'invalid.json'), JSON.stringify({ ...one, kind: 'made-up' }));
    writeFileSync(join(dir, 'tampered.json'), JSON.stringify({ ...one, payloadHash: HASH }));
    writeFileSync(join(dir, 'big.json'), ' '.repeat(gates.EVIDENCE_FILE_BYTES + 1));
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
    let linked = true;
    try {
      symlinkSync(join(dir, 'broken.json'), join(dir, 'link.json'));
    } catch {
      linked = false;
    }
    const loaded = await gates.loadEvidence(dir);
    assert.deepEqual(loaded.accepted.map((item) => item.file), [`nested/deeper/${one.id}.json`]);
    const reasons = Object.fromEntries(loaded.rejected.map((item) => [item.file, item.reasonCode]));
    assert.equal(reasons['broken.json'], 'NOT_JSON');
    assert.match(reasons['invalid.json'], /^INVALID_/);
    assert.equal(reasons['tampered.json'], 'INVALID_PAYLOAD_HASH_MISMATCH');
    assert.equal(reasons['big.json'], 'OVERSIZE');
    if (linked) assert.equal(reasons['link.json'], 'SYMLINK');
    else t.diagnostic('symlinks unavailable here; the symlink refusal is covered on POSIX');
    assert.deepEqual(await gates.loadEvidence(join(dir, 'missing')), { accepted: [], rejected: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the shipped support matrix advertises all five harnesses on three OSes and the trust store parses', async () => {
  const matrix = await gates.loadMatrix(join(root, 'assets', 'support-matrix.json'));
  assert.deepEqual(matrix.map((entry) => entry.harness).sort(), [...HARNESSES].sort());
  for (const entry of matrix) assert.deepEqual([...entry.os].sort(), OSES);
  // With the package root, each harness whose harness.json lists worker.route is advertised with routing.
  const routed = await gates.loadMatrix(join(root, 'assets', 'support-matrix.json'), root);
  assert.deepEqual(routed.map((entry) => [entry.harness, entry.routing]).sort(), [...HARNESSES].sort().map((harness) => [harness, true]));
  assert.equal(gates.WORKER_ROUTE_FEATURE, 'worker.route');
  assert.equal(contracts.CERTIFICATION_FEATURES.includes(gates.WORKER_ROUTE_FEATURE), true);
  // A harness.json without worker.route, or none at all, is not advertised with routing.
  const dir = mkdtempSync(join(tmpdir(), 'jevris-matrix-'));
  try {
    mkdirSync(join(dir, 'plugins', 'claude'), { recursive: true });
    writeFileSync(join(dir, 'plugins', 'claude', 'harness.json'), JSON.stringify({ harness: 'claude', features: ['hooks.observe'] }));
    writeFileSync(join(dir, 'matrix.json'), JSON.stringify({ advertised: [{ harness: 'claude', os: ['linux'] }, { harness: 'codex', os: ['linux'] }] }));
    assert.deepEqual(await gates.loadMatrix(join(dir, 'matrix.json'), dir), [
      { harness: 'claude', os: ['linux'], routing: false },
      { harness: 'codex', os: ['linux'], routing: false },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // Every listed key loads (none is skipped as malformed): a known role, a unique id, an Ed25519 public key.
  const trustFile = join(root, 'assets', 'trust', 'release-keys.json');
  const listed = JSON.parse(readFileSync(trustFile, 'utf8')).keys;
  const trusted = await gates.loadTrust(trustFile);
  assert.equal(trusted.length, listed.length);
  assert.equal(new Set(trusted.map((key) => key.keyId)).size, trusted.length);
  for (const key of trusted) {
    assert.equal(['owner', 'security-reviewer', 'certification', 'calibration'].includes(key.role), true, key.keyId);
    assert.equal(createPublicKey(key.publicKeyPem).asymmetricKeyType, 'ed25519', key.keyId);
  }
  assert.deepEqual(await gates.loadPackIds(root), PACKS);
});
