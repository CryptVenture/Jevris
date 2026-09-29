import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = join(root, 'scripts', 'release-evidence.mjs');
const COMMIT = 'a'.repeat(40);

function run(args) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', shell: false });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

test('release-evidence refuses incomplete commands before reading anything (RLS-05, RLS-07, RLS-08)', async () => {
  const { UsageError, parseArgs } = await import(pathToFileURL(script).href);
  const refused = (argv, message) => assert.throws(() => parseArgs(argv), (error) => error instanceof UsageError && message.test(error.message), argv.join(' '));
  refused([], /commands: keygen/);
  refused(['publish'], /commands: keygen/);
  refused(['keygen', '--key-id', 'k1'], /--role must be one of owner, security-reviewer, certification/);
  refused(['keygen', '--role', 'owner'], /--key-id is required/);
  refused(['keygen', '--role', 'owner', '--key-id', '../x'], /--key-id is required/);
  refused(['p0-register', '--key-id', 'k1', '--answers', 'a.json'], /--key <private key PEM> is required/);
  refused(['p0-register', '--key-id', 'k1', '--key', 'k.pem'], /--answers <file> is required/);
  refused(['security-review', '--key-id', 'k1', '--key', 'k.pem', '--review', 'r.json'], /--review <file> and --report <file> are required/);
  refused(['pre-registration', '--key-id', 'k1', '--key', 'k.pem'], /--input <file> is required/);
  // The economics come from the owner's seed (DOMAINS 2d1c6a0), owner-signed; the trial path is retired.
  refused(['economics', '--trial', 't.json', '--drills', 'd.json', '--key', 'k.pem', '--key-id', 'k1'], /--seed-dir and --drills are required/);
  refused(['economics', '--seed-dir', 'seed', '--drills', 'd.json', '--key-id', 'k1'], /--key <private key PEM> is required/);
  refused(['baseline'], /--release <calibration-release.json> is required/);
  refused(['check'], /check takes one record file/);
  refused(['check', 'a.json', '--token', 'x'], /unknown option --token/);
  refused(['keygen', '--role', 'owner', '--key-id'], /--key-id needs a value/);
  assert.equal(parseArgs(['keygen', '--role', 'owner', '--key-id', 'owner-2026']).addTrust, false);
});

test('release-evidence signs the owner and reviewer records, which the gates exclude until the key is trusted (RLS-05, RLS-07, RLS-08)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-evidence-'));
  try {
    const keys = join(dir, 'keys');
    const out = join(dir, 'evidence');
    const trustBefore = readFileSync(join(root, 'assets', 'trust', 'release-keys.json'), 'utf8');

    const owner = run(['keygen', '--role', 'owner', '--key-id', 'owner-test', '--out', keys]);
    assert.equal(owner.code, 0, owner.out);
    const ownerKey = join(keys, 'owner-test.pem');
    assert.match(readFileSync(ownerKey, 'utf8'), /^-----BEGIN PRIVATE KEY-----/);
    if (process.platform !== 'win32') assert.equal(statSync(ownerKey).mode & 0o777, 0o600, 'the private key is owner-only');
    assert.match(owner.out, /"role": "owner"/);
    assert.equal(owner.out.includes(readFileSync(ownerKey, 'utf8').split('\n')[1]), false, 'the private key is printed');
    assert.equal(run(['keygen', '--role', 'owner', '--key-id', 'owner-test', '--out', keys]).code, 2, 'an existing key is overwritten');
    const reviewer = run(['keygen', '--role', 'security-reviewer', '--key-id', 'reviewer-test', '--out', keys]);
    assert.equal(reviewer.code, 0, reviewer.out);

    const answers = join(dir, 'p0.json');
    writeFileSync(answers, JSON.stringify({
      questions: [{ id: 'approval-authority', answer: 'The release owner approves automation.', decidedBy: 'owner', decidedAt: '2026-09-25T00:00:00.000Z' }],
      procurement: { status: 'approved', retention: '30 days', trainingUse: 'none', region: 'eu', subprocessors: 'none' },
    }));
    const common = ['--version', '1.2.0', '--commit', COMMIT, '--out', out];
    const p0 = run(['p0-register', '--answers', answers, '--key', ownerKey, '--key-id', 'owner-test', ...common]);
    assert.equal(p0.code, 0, p0.out);
    assert.match(p0.out, /not in assets\/trust\/release-keys\.json as an owner key, so the gates exclude the record/);
    const p0Record = JSON.parse(readFileSync(join(out, 'p0-register.json'), 'utf8'));
    assert.equal(p0Record.kind, 'p0-register');
    assert.deepEqual(p0Record.subject, { package: '@webventures/jevris', version: '1.2.0', commit: COMMIT });

    const report = join(dir, 'report.pdf');
    writeFileSync(report, 'independent review report');
    const review = join(dir, 'review.json');
    writeFileSync(review, JSON.stringify({ reviewer: { name: 'R. Viewer', organization: 'Example Security', independent: true }, reportLocation: 'https://example.invalid/report.pdf', scope: ['credential-leakage', 'source-leakage'], findings: [{ id: 'F-1', severity: 'low', status: 'fixed' }] }));
    const sec = run(['security-review', '--review', review, '--report', report, '--key', join(keys, 'reviewer-test.pem'), '--key-id', 'reviewer-test', ...common]);
    assert.equal(sec.code, 0, sec.out);
    const secRecord = JSON.parse(readFileSync(join(out, 'security-review.json'), 'utf8'));
    assert.equal(secRecord.payload.reportSha256, `sha256:${createHash('sha256').update('independent review report').digest('hex')}`);
    assert.equal(secRecord.payload.reviewedVersion, '1.2.0');

    const prereg = join(dir, 'prereg.json');
    writeFileSync(prereg, JSON.stringify({ primaryMetric: 'verified-success', primaryCostMetric: 'cost-per-verified-task', statisticalTest: 'two-proportion-non-inferiority', margin: 0.05, alpha: 0.05, power: 0.8, expectedSuccessRate: 0.7, latencyTail: { percentile: 95, maxMs: 2000 }, holdoutHash: `sha256:${'b'.repeat(64)}`, lockedAt: '2026-09-25T00:00:00.000Z' }));
    const pre = run(['pre-registration', '--input', prereg, '--key', ownerKey, '--key-id', 'owner-test', ...common]);
    assert.equal(pre.code, 0, pre.out);
    assert.match(pre.out, /minimum tasks per arm from the power calculation: \d+/);
    assert.equal(existsSync(join(out, 'pre-registration.json')), true);

    // check verifies against the committed trust store, which does not hold the test keys.
    for (const kind of ['p0-register', 'security-review', 'pre-registration']) {
      const checked = run(['check', join(out, `${kind}.json`)]);
      assert.equal(checked.code, 1, checked.out);
      assert.match(checked.out, new RegExp(`valid ${kind} record, but \\S+: no trusted`));
    }
    // A tampered payload is invalid, whatever key signed it.
    const tampered = join(dir, 'tampered.json');
    writeFileSync(tampered, JSON.stringify({ ...p0Record, payload: { ...p0Record.payload, procurement: { ...p0Record.payload.procurement, status: 'open' } } }));
    const bad = run(['check', tampered]);
    assert.equal(bad.code, 1, bad.out);
    assert.equal(readFileSync(join(root, 'assets', 'trust', 'release-keys.json'), 'utf8'), trustBefore, 'the trust store changed without --add-trust');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('release-evidence turns a saved trial into the quality-trial record, and signs a calibration release (RLS-08, RLS-11)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-evidence-'));
  try {
    const evals = await import(pathToFileURL(join(root, 'packages', 'evals', 'dist', 'index.js')).href);
    const keys = join(dir, 'keys');
    const out = join(dir, 'evidence');
    const common = ['--version', '1.2.0', '--commit', COMMIT, '--out', out];
    assert.equal(run(['keygen', '--role', 'owner', '--key-id', 'owner-test', '--out', keys]).code, 0);
    assert.equal(run(['keygen', '--role', 'calibration', '--key-id', 'calibration-test', '--out', keys]).code, 0);

    // A synthetic corpus and holdout, and a pre-registration locked before the trial.
    const corpus = evals.syntheticCorpus({ tasks: 400, slices: ['docs', 'bounded-edit'], start: '2026-01-01T00:00:00Z', repositories: 10 });
    const split = evals.splitCorpus(corpus, { holdoutFrom: '2026-03-01T00:00:00Z' });
    const holdout = evals.holdoutManifest(split.holdout, { holdoutId: 'synthetic-holdout', releasedAt: '2026-09-01T00:00:00Z' });
    const prereg = join(dir, 'prereg.json');
    writeFileSync(prereg, JSON.stringify({ primaryMetric: 'verified-success-difference', primaryCostMetric: 'median-full-cost-per-verified-task', statisticalTest: 'paired-bootstrap-non-inferiority', margin: 0.1, alpha: 0.05, power: 0.8, expectedSuccessRate: 0.8, latencyTail: { percentile: 95, maxMs: 120000 }, holdoutHash: holdout.contentHash, lockedAt: '2026-09-10T00:00:00.000Z' }));
    assert.equal(run(['pre-registration', '--input', prereg, '--key', join(keys, 'owner-test.pem'), '--key-id', 'owner-test', ...common]).code, 0);
    const preRecord = join(out, 'pre-registration.json');

    // The trial ran elsewhere with a real driver; here a deterministic stand-in writes its TrialResult.
    const unit = (text) => createHash('sha256').update(text).digest()[0] / 255;
    const driver = {
      async run({ task, arm }) {
        const noise = unit(task.taskId + arm);
        return { completed: true, receipts: [{ id: `r-${task.taskId}-${arm}`, passed: unit(task.taskId) > 0.2 }], retries: 0, inputTokens: 1000, outputTokens: 100, costMicroUsd: arm === 'jev-routed' ? 900 + Math.round(noise * 100) : 1000 + Math.round(noise * 100), costSource: 'provider-reported', estimatedCostMicroUsd: 1000, wallMs: 1000 + Math.round(noise * 200), humanMinutes: 5, defectEscaped: false, abandoned: false, safetyFailures: [], measuredComponents: ['retries', 'cache', 'verification', 'human-minutes'] };
      },
    };
    // pinned-clock: the trial's own timestamps, checked only against the pre-registration lock; the calibration release below signs and expires on the real clock.
    let clock = Date.parse('2026-09-20T00:00:00Z');
    const tasks = split.holdout.map((row, i) => ({ taskId: row.taskId, repository: row.repository, sliceId: row.sliceId, difficulty: ['easy', 'medium', 'hard'][i % 3] }));
    const trial = await evals.runTrial({ tasks, arms: ['native', 'static', 'rules-only', 'jev-routed', 'routing-only', 'memory-only', 'log-reduction-only', 'combined'], driver, sandboxes: { async create() { return { path: 'memory', async dispose() {} }; } }, preRegistrationLockedAt: '2026-09-10T00:00:00.000Z', seed: 4, now: () => (clock += 10) });
    assert.equal(trial.ok, true, JSON.stringify(trial).slice(0, 200));
    const files = {
      trial: join(dir, 'trial.json'),
      protocol: join(dir, 'protocol.json'),
      holdout: join(dir, 'holdout.json'),
      corpus: join(dir, 'corpus.json'),
      drills: join(dir, 'drills.json'),
    };
    writeFileSync(files.trial, JSON.stringify(trial));
    writeFileSync(files.protocol, JSON.stringify({ schemaVersion: '1.0', kind: 'evaluation-protocol', frozenBaseline: ['rules-only', 'native'], splitPolicy: 'repository-and-time', annotationInstruction: 'Verified means an independent test receipt passed.', sourceCorpus: false, trainer: false, holdoutId: holdout.holdoutId, labelledCorpus: true, nonInferiorityMargin: 0.1 }));
    writeFileSync(files.holdout, JSON.stringify(holdout));
    writeFileSync(files.corpus, JSON.stringify(corpus));
    writeFileSync(files.drills, JSON.stringify([{ packId: 'jevris.skill-advice', disabled: true, independent: true, passed: true }]));

    const quality = run(['quality-trial', '--trial', files.trial, '--pre-registration', preRecord, '--protocol', files.protocol, '--holdout', files.holdout, '--corpus', files.corpus, ...common]);
    assert.equal(quality.code, 0, quality.out);
    assert.match(quality.out, /jev-routed against rules-only on \d+ tasks/);
    const qualityRecord = JSON.parse(readFileSync(join(out, 'quality-trial.json'), 'utf8'));
    assert.equal(qualityRecord.payload.preRegistrationHash, JSON.parse(readFileSync(preRecord, 'utf8')).payloadHash);
    assert.deepEqual([qualityRecord.payload.comparison.treatment, qualityRecord.payload.comparison.baseline], ['jev-routed', 'rules-only']);

    // A trial that started before the pre-registration was locked is refused.
    const early = join(dir, 'early.json');
    writeFileSync(early, JSON.stringify({ ...trial, startedAt: '2026-09-01T00:00:00.000Z' }));
    const refused = run(['quality-trial', '--trial', early, '--pre-registration', preRecord, '--protocol', files.protocol, '--holdout', files.holdout, '--corpus', files.corpus, ...common]);
    assert.equal(refused.code, 2, refused.out);
    assert.match(refused.out, /not locked before the trial started/);

    // --run-config runs the trial with the product driver; without the live gates it refuses
    // before starting anything, and no trial.json appears.
    const config = join(dir, 'trial-config.json');
    writeFileSync(config, JSON.stringify({ schema: 'jevris.trial-config/1', harness: 'claude-sdk', defaultModel: 'claude-sonnet-5', staticModels: { easy: 'claude-haiku-5', medium: 'claude-sonnet-5', hard: 'claude-opus-5' }, allowedTools: ['Read', 'Edit'], maxTurns: 5, maxBudgetUsd: 1, runTimeoutMs: 60000, checkTimeoutMs: 30000, prices: { 'claude-sonnet-5': { inputPerMTokUsd: 3, outputPerMTokUsd: 15 } }, tasks: [{ taskId: 'fix-sum', prompt: 'Make sum.mjs add.', checks: [{ id: 'test', argv: [process.execPath, 'check.mjs'] }] }] }));
    writeFileSync(join(dir, 'trial-tasks.json'), JSON.stringify([{ taskId: 'fix-sum', repository: 'r', sliceId: 'docs', difficulty: 'easy' }]));
    const liveOut = join(dir, 'live');
    const offline = { ...process.env };
    for (const key of ['JEVRIS_LIVE_HARNESS', 'JEVRIS_LIVE_JEV', 'ANTHROPIC_API_KEY']) delete offline[key];
    const live = spawnSync(process.execPath, [script, 'quality-trial', '--run-config', config, '--tasks', join(dir, 'trial-tasks.json'), '--sandbox-dir', join(dir, 'sandboxes'), '--pre-registration', preRecord, '--protocol', files.protocol, '--holdout', files.holdout, '--corpus', files.corpus, '--version', '1.2.0', '--commit', COMMIT, '--out', liveOut], { cwd: root, encoding: 'utf8', env: offline });
    assert.equal(live.status, 2, `${live.stdout}${live.stderr}`);
    assert.match(live.stderr, /the product harness driver cannot run this trial/);
    assert.equal(existsSync(join(liveOut, 'trial.json')), false, 'a refused driver still wrote a trial');
    assert.equal(existsSync(join(dir, 'sandboxes')), false, 'a refused driver created sandboxes');
    assert.equal(run(['quality-trial', '--trial', files.trial, '--run-config', config, '--pre-registration', preRecord, '--protocol', files.protocol, '--holdout', files.holdout, '--corpus', files.corpus]).code, 2, '--trial and --run-config together');


    // Calibration: cases per split, a proposal, the reviewer's key. The script signs the release at
    // the real clock, so its expiry is a year from now, never a fixed date that one day precedes it.
    const cases = (n, seed) => Array.from({ length: n }, (_, i) => { const probability = Math.round(unit(`${seed}${i}`) * 100) / 100; return JSON.stringify({ sliceId: 'docs', probability, outcome: probability > 0.3 }); }).join('\n');
    writeFileSync(join(dir, 'cal.jsonl'), `${cases(300, 'c')}\n`);
    writeFileSync(join(dir, 'hold.jsonl'), `${cases(200, 'h')}\n\n`);
    const hash = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
    writeFileSync(join(dir, 'proposal.json'), JSON.stringify({ id: 'cal-docs-1', decisionSpecId: 'route-readiness', decisionSpecVersion: '1', dataset: { id: 'corpus', version: '1', contentHash: hash('corpus') }, questionHash: hash('q'), model: { modelId: 'noul-1', revisionHash: hash('m') }, encoderHash: hash('e'), errorBudget: 0.05, minimumSliceSamples: 50, expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString() }));
    const calibration = run(['calibration', '--proposal', join(dir, 'proposal.json'), '--calibration', join(dir, 'cal.jsonl'), '--holdout-cases', join(dir, 'hold.jsonl'), '--reviewer', 'reviewer-1', '--key', join(keys, 'calibration-test.pem'), '--key-id', 'calibration-test', '--out', out]);
    assert.equal(calibration.code, 0, calibration.out);
    const artifact = JSON.parse(readFileSync(join(out, 'calibration-release.json'), 'utf8'));
    assert.equal(artifact.releaseState, 'released');
    assert.equal(artifact.reviewer.id, 'reviewer-1');
    assert.equal(artifact.signature.keyId, 'calibration-test');
    assert.match(calibration.out, /not in assets\/trust\/release-keys\.json as a calibration key/);
    const contracts = await import(pathToFileURL(join(root, 'packages', 'contracts', 'dist', 'index.js')).href);
    assert.equal(contracts.CalibrationArtifactContract.validate(artifact).ok, true);

    const bad = run(['calibration', '--proposal', join(dir, 'proposal.json'), '--calibration', files.drills, '--holdout-cases', join(dir, 'hold.jsonl'), '--reviewer', 'reviewer-1', '--key', join(keys, 'calibration-test.pem'), '--key-id', 'calibration-test', '--out', out]);
    assert.equal(bad.code, 2, bad.out);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('release-evidence makes the owner-signed economics record and the baseline-release record from one seed, and the gates bind them (RLS-08, RLS-09; §22.2 as amended)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-seed-evidence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const load = (...parts) => import(pathToFileURL(join(root, ...parts)).href);
  const evals = await load('packages', 'evals', 'dist', 'index.js');
  const contracts = await load('packages', 'contracts', 'dist', 'index.js');
  const gates = await load('apps', 'cli', 'dist', 'gate-records.js');
  const evalScripts = join(root, 'packages', 'evals', 'scripts');
  const node = (file, argv) => spawnSync(process.execPath, [file, ...argv], { cwd: root, env: { ...process.env, JEVRIS_TEST: '1' }, encoding: 'utf8' });
  const keys = join(dir, 'keys');
  const out = join(dir, 'evidence');
  const seed = join(dir, 'seed');
  const common = ['--version', '1.2.0', '--commit', COMMIT, '--out', out];
  assert.equal(run(['keygen', '--role', 'owner', '--key-id', 'owner-test', '--out', keys]).code, 0);
  assert.equal(run(['keygen', '--role', 'calibration', '--key-id', 'calibration-test', '--out', keys]).code, 0);

  // The owner's seed folder, as seed-run.mjs leaves it: 12 tasks on both arms, then its evaluation.
  const { mkdirSync } = await import('node:fs');
  mkdirSync(seed);
  const ids = Array.from({ length: 12 }, (_, i) => `org__repo${i}-${i}`);
  const body = { planId: evals.SEED_PLAN.id, dataset: evals.SEED_PLAN.dataset, revision: evals.SEED_PLAN.revision, instanceIds: ids };
  writeFileSync(join(seed, 'selection.json'), JSON.stringify({ ...body, selectionHash: contracts.contentHash(body) }));
  const runs = ids.flatMap((id, i) => evals.SEED_PLAN.arms.map((arm) => ({
    runId: `${id}__${arm.modelId}`, instanceId: id, modelId: arm.modelId, effort: arm.effort, status: 'completed', reason: 'success', actualModel: arm.modelId,
    apiEquivalentUsd: arm.modelId === 'claude-sonnet-5' ? 3 + (i % 3) : 8 + (i % 2), costUsd: null, costBasis: 'list-price-estimate',
    usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 8000, cacheCreationInputTokens: 900 }, tokens: 10_000,
    durationMs: arm.modelId === 'claude-sonnet-5' ? 400_000 + i : 700_000 + i, authMode: 'subscription', patchBytes: 1, patch: 'p', at: '2026-09-30T00:00:00.000Z',
  })));
  writeFileSync(join(seed, 'runs.jsonl'), `${runs.map((r) => JSON.stringify(r)).join('\n')}\n`);
  writeFileSync(join(seed, 'opus.json'), JSON.stringify({ resolved_ids: ids.slice(0, 7) }));
  writeFileSync(join(seed, 'sonnet.json'), JSON.stringify({ resolved_ids: ids.slice(0, 8) }));
  const reports = ['--report', `claude-opus-5-5=${join(seed, 'opus.json')}`, '--report', `claude-sonnet-5=${join(seed, 'sonnet.json')}`];
  for (const step of ['priors', 'economics']) assert.equal(node(join(evalScripts, 'seed-run.mjs'), [step, '--out', seed, ...reports]).status, 0, step);
  assert.equal(node(join(evalScripts, 'baseline-release.mjs'), ['build', '--seed-dir', seed, '--out', seed, '--id', 'baseline-test', '--expires', '2099-01-01']).status, 0);
  const signedBaseline = node(join(evalScripts, 'baseline-release.mjs'), ['sign', '--proposal', join(seed, 'baseline-proposal.json'), '--key', join(keys, 'calibration-test.pem'), '--key-id', 'calibration-test', '--reviewer', 'owner', '--out', seed]);
  assert.equal(signedBaseline.status, 0, signedBaseline.stderr);
  writeFileSync(join(dir, 'drills.json'), JSON.stringify(['jevris.memory', 'jevris.observability', 'jevris.skill-advice'].map((packId) => ({ packId, disabled: true, independent: true, passed: true }))));

  const economics = run(['economics', '--seed-dir', seed, '--drills', join(dir, 'drills.json'), '--key', join(keys, 'owner-test.pem'), '--key-id', 'owner-test', ...common]);
  assert.equal(economics.code, 0, economics.out);
  assert.match(economics.out, /12 paired tasks, 24 runs; cost per verified task ratio/);
  assert.match(economics.out, /not in assets\/trust\/release-keys\.json as an owner key/);
  const baseline = run(['baseline', '--release', join(seed, 'calibration-release.json'), '--seed-dir', seed, ...common]);
  assert.equal(baseline.code, 0, baseline.out);
  const economicsRecord = JSON.parse(readFileSync(join(out, 'economics-report.json'), 'utf8'));
  const baselineRecord = JSON.parse(readFileSync(join(out, 'baseline-release.json'), 'utf8'));
  for (const record of [economicsRecord, baselineRecord]) assert.equal(contracts.ReleaseEvidenceContract.validate(record).ok, true, record.kind);
  const sample = economicsRecord.payload.sample;
  assert.deepEqual([sample.source, sample.tasks, sample.runs, sample.costBases, sample.baseline.modelId, sample.candidate.modelId], ['seed-run', 12, 24, ['list-price-estimate'], 'claude-opus-5-5', 'claude-sonnet-5']);
  assert.equal(sample.runsHash, evals.seedRunsHash(runs));
  assert.ok(baselineRecord.payload.baselineSources.filter((s) => s.kind === 'seed').every((s) => s.runsHash === sample.runsHash && s.selectionHash === sample.selectionHash));
  // The candidate costs about half per verified task; its interval stays below 1.
  assert.ok(economicsRecord.payload.costPerVerifiedTask.ratio.upper < 1, JSON.stringify(economicsRecord.payload.costPerVerifiedTask));

  // With both keys trusted, the quality gate and the economics seed checks pass on these records.
  const pem = (name) => import('node:crypto').then(({ createPublicKey }) => createPublicKey(readFileSync(join(keys, name), 'utf8')).export({ type: 'spki', format: 'pem' }).toString());
  const trust = [{ keyId: 'owner-test', role: 'owner', publicKeyPem: await pem('owner-test.pem') }, { keyId: 'calibration-test', role: 'calibration', publicKeyPem: await pem('calibration-test.pem') }];
  const report = gates.evaluateGates({ version: '1.2.0', commit: COMMIT, nowMs: Date.now(), evidence: [economicsRecord, baselineRecord].map((record) => ({ file: `${record.kind}.json`, record })), trust, matrix: [], packs: ['jevris.memory', 'jevris.observability', 'jevris.skill-advice'], bundledBaseline: JSON.parse(readFileSync(join(seed, 'calibration-release.json'), 'utf8')) });
  const quality = report.gates.find((g) => g.gate === 'quality');
  // Every baseline check passes; the learning gate's own tests come from the release run's report.
  assert.deepEqual(quality.predicates.filter((p) => !p.ok).map((p) => p.id), ['quality.learning-gate'], JSON.stringify(quality.predicates));
  const seedChecks = report.gates.find((g) => g.gate === 'economics').predicates.filter((p) => ['economics.report', 'economics.sample-size', 'economics.seed-bound', 'economics.full-cost'].includes(p.id) || p.id === 'economics.intervals');
  assert.equal(seedChecks.every((p) => p.ok), true, JSON.stringify(seedChecks));

  // The release commit ships this signed file as the package's day-1 baseline; check:pack accepts it
  // only when the package's own trust file lists its calibration key (else installs refuse it).
  const { BUNDLED_BASELINE, TRUST_FILE, bundledBaselineProblems } = await load('scripts', 'check-pack.mjs');
  const shippedBytes = readFileSync(join(seed, 'calibration-release.json'));
  const trustBytes = (keys) => Buffer.from(JSON.stringify({ schemaVersion: 1, keys }));
  const files = (overrides = {}) => ({ [BUNDLED_BASELINE]: shippedBytes, [TRUST_FILE]: trustBytes(trust), ...overrides });
  const pack = (entries) => bundledBaselineProblems(Object.keys(entries), (path) => entries[path], contracts);
  assert.deepEqual(pack(files()), []);
  assert.deepEqual(pack({ [TRUST_FILE]: trustBytes(trust) }), [], 'no shipped baseline is not a pack problem (the quality gate requires it)');
  assert.match(pack(files({ [TRUST_FILE]: trustBytes(trust.filter((key) => key.role !== 'calibration')) })).join('\n'), /not signed by a calibration key in assets\/trust\/release-keys\.json \(UNKNOWN_KEY\)/);
  assert.match(pack(files({ [TRUST_FILE]: trustBytes(trust.map((key) => ({ ...key, role: 'owner' }))) })).join('\n'), /UNKNOWN_KEY/, 'an owner key does not sign the baseline');
  const artifact = JSON.parse(shippedBytes.toString('utf8'));
  assert.match(pack(files({ [BUNDLED_BASELINE]: Buffer.from(JSON.stringify({ ...artifact, expiresAt: '2099-06-01T00:00:00Z' })) })).join('\n'), /BAD_SIGNATURE/);
  assert.match(pack(files({ [BUNDLED_BASELINE]: Buffer.from('{ not json') })).join('\n'), /is not JSON/);
  assert.match(pack(files({ [BUNDLED_BASELINE]: Buffer.from(JSON.stringify({ id: 'x' })) })).join('\n'), /is not a calibration artifact/);
  assert.equal(gates.BUNDLED_BASELINE_PATH, BUNDLED_BASELINE);
  // Built but not shipped: the baseline checks do not apply (827fc87); the package starts on the default.
  const unshipped = gates.evaluateGates({ version: '1.2.0', commit: COMMIT, nowMs: Date.now(), evidence: [baselineRecord].map((record) => ({ file: 'b.json', record })), trust, matrix: [], packs: [], bundledBaseline: null });
  assert.deepEqual(unshipped.gates.find((g) => g.gate === 'quality').predicates.map((p) => p.id), ['quality.default-start', 'quality.learning-gate']);

  // Run records changed after the economics were computed, or another seed folder, are refused.
  writeFileSync(join(seed, 'runs.jsonl'), `${runs.slice(1).map((r) => JSON.stringify(r)).join('\n')}\n`);
  const tampered = run(['economics', '--seed-dir', seed, '--drills', join(dir, 'drills.json'), '--key', join(keys, 'owner-test.pem'), '--key-id', 'owner-test', ...common]);
  assert.equal(tampered.code, 2, tampered.out);
  assert.match(tampered.out, /runsHash differs/);
  const otherSeed = run(['baseline', '--release', join(seed, 'calibration-release.json'), '--seed-dir', seed, ...common]);
  assert.equal(otherSeed.code, 2, otherSeed.out);
  assert.match(otherSeed.out, /names other run records/);
});
