import test from 'node:test';
import assert from 'node:assert/strict';

const c = await import('../dist/index.js');

const envelope = (command, result) => ({
  schemaVersion: '1.0',
  command,
  mode: 'reduced',
  sidecar: { state: 'not-running', reasonCode: 'SIDECAR_UNAVAILABLE', message: 'Run jevris sidecar start, then retry.' },
  workspace: { id: 'ws-0123456789abcdef', root: '/work/repo' },
  summary: 'A summary.',
  result,
});

const statusPayload = {
  jevrisMode: 'observe',
  killSwitch: 'clear',
  decisionHealth: 'unknown',
  degradedReason: 'The sidecar is not running.',
  routing: { modelPin: null, pinned: false },
  activeWorkers: [],
  budget: { state: 'unknown', reservedMicroUsd: null, limitMicroUsd: null },
  recentDecisions: [],
  unknownSlices: [],
  store: { state: 'absent', diagnostic: null },
};

test('every surface operation has a payload and a result contract (CMD-04)', () => {
  assert.equal(c.SURFACE_OPERATIONS.length, 16);
  for (const op of c.SURFACE_OPERATIONS) {
    assert.equal(typeof c.surfacePayloadContract(op).validate, 'function', op);
    assert.equal(typeof c.surfaceResultContract(op).validate, 'function', op);
  }
  for (const name of c.PUBLIC_COMMAND_NAMES) assert.equal(c.isPublicCommandName(name), true);
  assert.equal(c.isPublicCommandName('install'), false);
  assert.deepEqual(c.COMMAND_EXIT_CODES, { ok: 0, negative: 1, usage: 2 });
});

test('a status result validates, and an extra or wrong field is refused', () => {
  const contract = c.surfaceResultContract('status');
  assert.equal(contract.validate(envelope('status', statusPayload)).ok, true);
  assert.equal(contract.validate(envelope('route', statusPayload)).ok, false);
  assert.equal(contract.validate({ ...envelope('status', statusPayload), permissionDecision: 'allow' }).ok, false);
  assert.equal(contract.validate(envelope('status', { ...statusPayload, jevrisMode: 'god' })).ok, false);
  assert.equal(c.surfacePayloadContract('status').validate(statusPayload).ok, true);
});

test('route advice can never be applied, checkpoint never compacts, record never creates a receipt', () => {
  const route = {
    main: {
      currentModel: 'claude-opus-5-5',
      modelPin: 'claude-opus-5-5',
      pinState: 'pinned',
      outcome: 'keep',
      recommendedModel: null,
      reasonCode: 'PIN_RESPECTED',
      costBasis: 'unknown',
      text: 'Keep the pinned model.',
      adviceKey: null,
    },
    worker: { outcome: 'abstain', recommendedModel: null, reasonCode: 'NO_CALIBRATION', text: 'No worker advice.' },
    applied: false,
  };
  assert.equal(c.surfacePayloadContract('route').validate(route).ok, true);
  assert.equal(c.surfacePayloadContract('route').validate({ ...route, applied: true }).ok, false);
  const checkpoint = {
    capsuleId: 'cap-1',
    handle: 'capsule:cap-1',
    written: true,
    retained: { constraints: 1, changedFiles: 0, openChecks: 0, unresolved: 0, hypotheses: 0 },
    items: [{ kind: 'constraint', text: 'Keep the public API stable.' }],
    compactionTriggered: false,
  };
  assert.equal(c.surfacePayloadContract('checkpoint').validate(checkpoint).ok, true);
  assert.equal(c.surfacePayloadContract('checkpoint').validate({ ...checkpoint, compactionTriggered: true }).ok, false);
  const record = { receiptId: 'r-1', accepted: false, reasonCode: 'RECEIPT_NOT_FOUND', outcome: null, receiptCreated: false };
  assert.equal(c.surfacePayloadContract('verification.record').validate(record).ok, true);
  assert.equal(c.surfacePayloadContract('verification.record').validate({ ...record, receiptCreated: true }).ok, false);
});

test('text fields refuse a credential or a URL', () => {
  const secret = { ...statusPayload, degradedReason: 'key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
  assert.equal(c.surfacePayloadContract('status').validate(secret).ok, false);
  const url = { ...statusPayload, degradedReason: 'see https://example.com' };
  assert.equal(c.surfacePayloadContract('status').validate(url).ok, false);
});

test('evidence.get may carry how the output was shown: exit code, error state and kept spans of the original (US15, MEM-08)', () => {
  const check = c.surfacePayloadContract('evidence.get');
  const base = { handle: `ev:${'a'.repeat(64)}`, found: true, mediaType: 'text/plain', byteLength: 120, text: 'FAIL test/a.test.js\n', truncated: false };
  assert.equal(check.validate(base).ok, true, 'the field is optional');
  assert.equal(check.validate({ ...base, output: null }).ok, true);
  const output = {
    exitCode: 1,
    errorState: 'failed',
    stderrOffset: 100,
    mode: 'distilled',
    passthroughReason: null,
    keptSpans: [{ startByte: 0, endByte: 20, startLine: 0, endLine: 1 }],
    omittedLines: 42,
    view: 'FAIL test/a.test.js',
  };
  assert.equal(check.validate({ ...base, output }).ok, true);
  assert.equal(check.validate({ ...base, output: { ...output, errorState: 'passed' } }).ok, false, 'error state is a closed set');
  assert.equal(check.validate({ ...base, output: { ...output, view: 'token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' } }).ok, false, 'the view refuses a credential');
  assert.equal(check.validate({ ...base, output: { ...output, keptSpans: [{ startByte: -1, endByte: 2, startLine: 0, endLine: 1 }] } }).ok, false);
  assert.equal(check.validate({ ...base, output: { ...output, summary: 'all good' } }).ok, false, 'no free-text summary field');
});

test('handoff.import may name the negotiated mode and the missing capabilities, and still never grants authority (MEM-10)', () => {
  const check = c.surfacePayloadContract('handoff.import');
  const base = { accepted: true, reasonCode: 'IMPORTED_ADVICE_ONLY_CAPABILITY', capsuleId: 'cap-0123456789abcdef', facts: 3, unresolved: [], authorityGranted: false };
  assert.equal(check.validate(base).ok, true, 'the fields are optional');
  assert.equal(check.validate({ ...base, mode: 'advice-only', missingCapabilities: ['context-injection'] }).ok, true);
  assert.deepEqual([...c.HANDOFF_CAPABILITIES], ['context-injection', 'verify-runner', 'task-ledger', 'owned-workers']);
  assert.equal(check.validate({ ...base, mode: 'full' }).ok, false);
  assert.equal(check.validate({ ...base, missingCapabilities: ['root'] }).ok, false);
  assert.equal(check.validate({ ...base, missingCapabilities: ['task-ledger', 'task-ledger'] }).ok, false);
  assert.equal(check.validate({ ...base, authorityGranted: true }).ok, false);
});

test('task.get may carry the latest worker run: requested and observed model apart, cost only when reported (W01, RTE-11)', () => {
  const check = c.surfacePayloadContract('task.get');
  const base = { taskId: 'task-1', found: false, task: null, receipts: [] };
  assert.equal(check.validate(base).ok, true, 'the field is optional');
  assert.equal(check.validate({ ...base, worker: null }).ok, true);
  const worker = { requestedModel: 'claude-sonnet-5', actualModel: null, status: 'completed', costMicroUsd: null, costBasis: 'unknown', durationMs: 1200 };
  assert.equal(check.validate({ ...base, worker }).ok, true);
  assert.equal(check.validate({ ...base, worker: { ...worker, actualModel: 'claude-haiku-4-5', costMicroUsd: 1500, costBasis: 'reported' } }).ok, true);
  assert.equal(check.validate({ ...base, worker: { ...worker, status: 'done' } }).ok, false);
  assert.equal(check.validate({ ...base, worker: { ...worker, costMicroUsd: 0.5 } }).ok, false, 'cost is whole micro-USD');
  assert.equal(check.validate({ ...base, worker: { ...worker, costBasis: 'estimated' } }).ok, false);
});

test('task.get may count late worker results, kept as history (W04, ORC-07)', () => {
  const check = c.surfacePayloadContract('task.get');
  const base = { taskId: 'task-1', found: false, task: null, receipts: [] };
  assert.equal(check.validate(base).ok, true, 'the field is optional');
  assert.equal(check.validate({ ...base, lateResults: 0 }).ok, true);
  assert.equal(check.validate({ ...base, lateResults: 2 }).ok, true);
  assert.equal(check.validate({ ...base, lateResults: -1 }).ok, false);
  assert.equal(check.validate({ ...base, lateResults: 1.5 }).ok, false);
  assert.equal(check.validate({ ...base, lateResults: null }).ok, false, 'a count, never null');
});

test('status may carry the test worker port line, and only as bounded text (ORC-03)', () => {
  const check = c.surfacePayloadContract('status');
  assert.equal(check.validate(statusPayload).ok, true, 'the field is optional');
  assert.equal(check.validate({ ...statusPayload, testWorkerPort: null }).ok, true);
  assert.equal(check.validate({ ...statusPayload, testWorkerPort: 'test worker port refused (NOT_TEST_MODE): owned workers use the Agent SDK' }).ok, true);
  assert.equal(check.validate({ ...statusPayload, testWorkerPort: 'x'.repeat(501) }).ok, false);
});

test('explain trace.learning carries the baseline prior and the posteriors apart from the lines, bounded (C16)', () => {
  const contract = c.surfacePayloadContract('explain');
  const trace = {
    outcome: 'advisory',
    reasonCodes: ['KEEP_CURRENT'],
    resolvedModel: null,
    usage: { known: false, inputTokens: null, outputTokens: null },
    uncertainty: 'No calibration applies.',
    policyVersion: null,
    applied: false,
    rendered: 'Kept the current model.',
  };
  const learning = {
    sliceId: 'bounded-edit',
    mode: 'auto',
    version: 3,
    lines: ['Slice bounded-edit: active.'],
    baseline: { releaseId: 'rel-2026-09', priors: [{ modelId: 'claude-sonnet-5', rate: 0.9, pseudoCount: 30, sampleSize: 60, sourceId: 'rel-2026-09' }] },
    posteriors: [{ modelId: 'claude-sonnet-5', alpha: 31.5, beta: 3.5, mean: 0.9, prior: { rate: 0.9, pseudoCount: 30, sourceId: 'rel-2026-09' }, local: { successes: 4, failures: 1 }, harmVsBaseline: 0.04 }],
  };
  const payload = (l) => ({ decisionId: 'd-1', found: true, trace: { ...trace, learning: l } });
  assert.equal(contract.validate(payload(learning)).ok, true);
  const { baseline: _b, posteriors: _p, ...linesOnly } = learning;
  assert.equal(contract.validate(payload(linesOnly)).ok, true, 'both are optional');
  assert.equal(contract.validate(payload({ ...learning, baseline: null })).ok, true, 'no signed baseline for the slice');
  for (const bad of [
    { ...learning, mode: 'automatic' },
    { ...learning, baseline: { ...learning.baseline, priors: [{ ...learning.baseline.priors[0], rate: 1.5 }] } },
    { ...learning, posteriors: [{ ...learning.posteriors[0], harmVsBaseline: -0.1 }] },
    { ...learning, posteriors: [{ ...learning.posteriors[0], local: { successes: 1.5, failures: 0 } }] },
    { ...learning, posteriors: Array.from({ length: 17 }, () => learning.posteriors[0]) },
    { ...learning, extra: 1 },
  ]) {
    assert.equal(contract.validate(payload(bad)).ok, false, JSON.stringify(bad).slice(0, 120));
  }
});

test('explain trace.learning tells two efforts of one model apart: effort on priors and posteriors, armId on posteriors (C16, C 1fc41b9)', () => {
  const contract = c.surfacePayloadContract('explain');
  const trace = { outcome: 'advisory', reasonCodes: ['KEEP_CURRENT'], resolvedModel: null, usage: { known: false, inputTokens: null, outputTokens: null }, uncertainty: 'No calibration applies.', policyVersion: null, applied: false, rendered: 'Kept the current model.' };
  const posterior = (armId, effort) => ({ modelId: 'claude-opus-5-5', armId, effort, alpha: 20, beta: 4, mean: 0.83, prior: { rate: 0.85, pseudoCount: 20, sourceId: 'rel-2026-09' }, local: { successes: 3, failures: 1 }, harmVsBaseline: armId === 'claude-opus-5-5' ? null : 0.06 });
  const learning = {
    sliceId: 'bounded-edit',
    mode: 'auto',
    version: 2,
    lines: ['Slice bounded-edit: active, claude-opus-5-5 at low effort.'],
    baseline: { releaseId: 'rel-2026-09', priors: [{ modelId: 'claude-opus-5-5', effort: null, rate: 0.85, pseudoCount: 20, sampleSize: 40, sourceId: 'rel-2026-09' }, { modelId: 'claude-opus-5-5', effort: 'low', rate: 0.82, pseudoCount: 20, sampleSize: 40, sourceId: 'rel-2026-09' }] },
    posteriors: [posterior('claude-opus-5-5', null), posterior('claude-opus-5-5@low', 'low')],
  };
  const payload = (l) => ({ decisionId: 'd-1', found: true, trace: { ...trace, learning: l } });
  assert.equal(contract.validate(payload(learning)).ok, true);
  const bare = { ...learning, baseline: { ...learning.baseline, priors: learning.baseline.priors.map(({ effort: _e, ...p }) => p) }, posteriors: learning.posteriors.map(({ effort: _e, armId: _a, ...p }) => p) };
  assert.equal(contract.validate(payload(bare)).ok, true, 'effort and armId are optional: a trace from before effort arms still validates');
  for (const bad of [
    { ...learning, posteriors: [{ ...learning.posteriors[1], effort: 'extreme' }] },
    { ...learning, posteriors: [{ ...learning.posteriors[1], armId: 'claude-opus-5-5@extreme' }] },
    { ...learning, posteriors: [{ ...learning.posteriors[1], armId: 'claude-opus-5-5@low@high' }] },
    { ...learning, baseline: { ...learning.baseline, priors: [{ ...learning.baseline.priors[1], effort: 'LOW' }] } },
  ]) {
    assert.equal(contract.validate(payload(bad)).ok, false, JSON.stringify(bad).slice(0, 160));
  }
});

test('configure effective source egress names host policy as its source and keeps the config preference apart (SET-02, GOV-01)', () => {
  const contract = c.surfacePayloadContract('configure');
  const effective = { mode: 'observe', sourceEgress: 'deny-until-approved', remoteTelemetry: 'off', mainSession: 'advice-only', managedWorkers: 'observe', orchestrationEnabled: false };
  const payload = (e) => ({ source: 'file', path: '/home/.config/jevris/jevris.config.json', valid: true, issues: [], effective: e, changed: [], nativePermissionsChanged: false });
  assert.equal(contract.validate(payload(effective)).ok, true, 'both fields are optional');
  const full = { ...effective, sourceEgressSource: 'host-policy', sourceEgressPreference: 'approved-scoped' };
  assert.equal(contract.validate(payload(full)).ok, true);
  assert.equal(contract.validate(payload({ ...full, sourceEgressPreference: null })).ok, true, 'no file sets it');
  for (const bad of [
    { ...full, sourceEgressSource: 'config-file' },
    { ...full, sourceEgressSource: null },
    { ...full, sourceEgressPreference: 'allowed' },
    { ...full, sourceEgress: 'approved' },
  ]) {
    assert.equal(contract.validate(payload(bad)).ok, false, JSON.stringify(bad));
  }
});

test('explain trace.learning carries each arm\'s economics per verified task against the default, money in integer micro-USD (C16, §22.2, C 6750120)', () => {
  const contract = c.surfacePayloadContract('explain');
  const trace = { outcome: 'advisory', reasonCodes: ['KEEP_CURRENT'], resolvedModel: null, usage: { known: false, inputTokens: null, outputTokens: null }, uncertainty: 'No calibration applies.', policyVersion: null, applied: false, rendered: 'Kept the current model.' };
  const arm = {
    armId: 'claude-opus-5-5',
    modelId: 'claude-opus-5-5',
    effort: null,
    isDefault: true,
    routes: 4,
    verified: 3,
    costPerVerifiedMicroUsd: 2_666_667,
    apiEquivalentPerVerifiedMicroUsd: 2_666_667,
    tokensPerVerified: null,
    usagePerVerified: null,
    wallMsPerVerified: 80_000,
    costRatioVsDefault: 1,
    usageRatioVsDefault: null,
    wallRatioVsDefault: 1,
  };
  const cheaper = { ...arm, armId: 'claude-sonnet-5@low', modelId: 'claude-sonnet-5', effort: 'low', isDefault: false, verified: 0, costPerVerifiedMicroUsd: null, apiEquivalentPerVerifiedMicroUsd: null, wallMsPerVerified: null, costRatioVsDefault: null, wallRatioVsDefault: null };
  const economics = { defaultArmId: 'claude-opus-5-5', minVerified: 5, arms: [arm, cheaper] };
  const learning = { sliceId: 'bounded-edit', mode: 'auto', version: 2, lines: ['Per verified task claude-opus-5-5: $2.6667 billed.'], economics };
  const payload = (l) => ({ decisionId: 'd-1', found: true, trace: { ...trace, learning: l } });
  assert.equal(contract.validate(payload(learning)).ok, true);
  assert.equal(contract.validate(payload({ ...learning, economics: { ...economics, arms: [] } })).ok, true, 'no arm has run');
  const { economics: _e, ...without } = learning;
  assert.equal(contract.validate(payload(without)).ok, true, 'economics is optional');
  for (const bad of [
    { ...economics, arms: [{ ...arm, costPerVerifiedMicroUsd: 2.5 }] },
    { ...economics, arms: [{ ...arm, apiEquivalentPerVerifiedMicroUsd: -1 }] },
    { ...economics, arms: [{ ...arm, costRatioVsDefault: -0.5 }] },
    { ...economics, arms: [{ ...arm, effort: 'turbo' }] },
    { ...economics, arms: [{ ...arm, extra: 1 }] },
    { ...economics, arms: Array.from({ length: 17 }, () => arm) },
    { ...economics, minVerified: -1 },
    { defaultArmId: 'claude-opus-5-5', arms: [] },
  ]) {
    assert.equal(contract.validate(payload({ ...learning, economics: bad })).ok, false, JSON.stringify(bad).slice(0, 160));
  }
});

test('explain trace.learning posteriors may carry the machine-wide part: the other workspaces\' counts, rate, pseudo-count and contributors (C16, C 7bea448)', () => {
  const contract = c.surfacePayloadContract('explain');
  const trace = { outcome: 'advisory', reasonCodes: ['KEEP_CURRENT'], resolvedModel: null, usage: { known: false, inputTokens: null, outputTokens: null }, uncertainty: 'No calibration applies.', policyVersion: null, applied: false, rendered: 'Kept the current model.' };
  const machine = { successes: 27, failures: 3, rate: 0.9, pseudoCount: 30, contributors: 2 };
  const posterior = { modelId: 'claude-sonnet-5', armId: 'claude-sonnet-5', effort: null, alpha: 31.5, beta: 3.5, mean: 0.9, prior: { rate: null, pseudoCount: 0, sourceId: null }, local: { successes: 4, failures: 1 }, harmVsBaseline: 0.04, machine };
  const payload = (p) => ({ decisionId: 'd-1', found: true, trace: { ...trace, learning: { sliceId: 'bounded-edit', mode: 'auto', version: 1, lines: ['Machine prior claude-sonnet-5: 90.0%.'], posteriors: [p] } } });
  assert.equal(contract.validate(payload(posterior)).ok, true);
  assert.equal(contract.validate(payload({ ...posterior, machine: null })).ok, true, 'no other workspace ran the arm');
  const { machine: _m, ...without } = posterior;
  assert.equal(contract.validate(payload(without)).ok, true, 'machine is optional');
  for (const bad of [{ ...machine, rate: 1.5 }, { ...machine, successes: 1.5 }, { ...machine, contributors: -1 }, { ...machine, workspaceId: 'ws-a' }, { successes: 1, failures: 0, rate: 1, pseudoCount: 1 }]) {
    assert.equal(contract.validate(payload({ ...posterior, machine: bad })).ok, false, JSON.stringify(bad));
  }
});

test('verify checks may carry a failure: failing test ids and names (at most 20), the total count and an ev: handle (D 837da7e)', () => {
  const contract = c.surfacePayloadContract('verify');
  const handle = `ev:${'a'.repeat(64)}`;
  const failure = { failedTests: [{ id: 'packages/adapter-codex/test/conformance.test.mjs', name: 'stale revision is refused' }], failedTestCount: 1, evidenceHandle: handle };
  const check = { checkId: 'test', mandatory: true, outcome: 'failed', receiptId: 'r-1', fresh: true, reasonCode: 'EXIT_NONZERO', environment: null, failure };
  const payload = (x) => ({ ran: true, readiness: 'not-verified', checks: [x], missing: ['test'] });
  assert.equal(contract.validate(payload(check)).ok, true);
  const { failure: _f, ...without } = check;
  assert.equal(contract.validate(payload(without)).ok, true, 'failure is optional');
  assert.equal(contract.validate(payload({ ...check, failure: { failedTests: [], failedTestCount: 0, evidenceHandle: null } })).ok, true, 'nothing parsed, no handle');
  assert.equal(contract.validate(payload({ ...check, failure: { ...failure, failedTests: Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, name: '' })), failedTestCount: 2131 } })).ok, true);
  for (const bad of [
    { ...failure, failedTests: Array.from({ length: 21 }, (_, i) => ({ id: `t${i}`, name: 'x' })) },
    { ...failure, failedTests: [{ id: 'x'.repeat(129), name: 'n' }] },
    { ...failure, failedTests: [{ id: '', name: 'n' }] },
    { ...failure, failedTests: [{ id: 't', name: 'n'.repeat(201) }] },
    { ...failure, failedTests: [{ id: 't', name: 'n', message: 'expected 1' }] },
    { ...failure, failedTestCount: 1.5 },
    { ...failure, evidenceHandle: 'output:abc123' },
    { ...failure, evidenceHandle: `ev:${'A'.repeat(64)}` },
    { failedTests: [], failedTestCount: 0 },
  ]) {
    assert.equal(contract.validate(payload({ ...check, failure: bad })).ok, false, JSON.stringify(bad).slice(0, 160));
  }
});

test('route learning gone --json: a list of the models found gone on this machine, or a clear result, and nothing else (C f5b19ab)', () => {
  const contract = c.RouteLearningGoneContract;
  const entry = { modelId: 'claude-opus-5-5', reasonCode: 'MODEL_GONE', port: 'claude-api', authMode: 'api-key', source: 'launch', firstSeenAt: '2026-09-27T08:00:00.000Z', lastSeenAt: '2026-09-27T09:00:00.000Z', count: 2, registrySnapshotId: 'anthropic-2026-09-26' };
  const list = { schemaVersion: '1.0', command: 'route learning gone list', registrySnapshotId: 'anthropic-2026-09-26', entries: [entry], lines: ['claude-opus-5-5 is not recommended: found gone on this machine.'] };
  const clear = { schemaVersion: '1.0', command: 'route learning gone clear', target: 'all', changed: true, reasonCode: 'CHANGED', removed: 1 };
  assert.equal(contract.validate(list).ok, true);
  assert.equal(contract.validate({ ...list, entries: [], lines: [] }).ok, true, 'nothing found gone');
  assert.equal(contract.validate(clear).ok, true);
  assert.equal(contract.validate({ ...clear, target: 'claude-opus-5-5', changed: false, reasonCode: 'NOTHING_TO_CLEAR', removed: 0 }).ok, true);
  for (const bad of [
    { ...list, command: 'route learning gone show' },
    { ...list, entries: [{ ...entry, authMode: 'oauth' }] },
    { ...list, entries: [{ ...entry, source: 'guess' }] },
    { ...list, entries: [{ ...entry, count: 1.5 }] },
    { ...list, entries: [{ ...entry, message: 'model not found' }] },
    { ...list, entries: Array.from({ length: 65 }, () => entry) },
    { ...list, target: 'all' },
    { ...clear, reasonCode: 'DONE' },
    { ...clear, removed: -1 },
    { ...clear, entries: [] },
  ]) {
    assert.equal(contract.validate(bad).ok, false, JSON.stringify(bad).slice(0, 160));
  }
});

test('a path in a result is not screened for the high-entropy heuristic, only for known credential formats (JEV-0017)', () => {
  const longName = '/private/var/folders/xx/T/jev-e2e-cli-memory-recover-Ab3xYz9Qw7Lk2Mn/work';
  const result = envelope('status', statusPayload);
  const check = (root) => c.surfaceResultContract('status').validate({ ...result, workspace: { id: 'ws-0123456789abcdef', root } });
  assert.equal(check(longName).ok, true);
  // A path that carries a provider credential is still refused.
  assert.equal(check('/work/sk-ant-api03-abcdef/repo').ok, false);
  assert.equal(check('/work/ghp_abcdefghijklmnopqrstuvwxyz0123456789/repo').ok, false);
  // Identifiers and reason codes keep the full screening, heuristic included.
  const entropy = 'Ab3xYz9Qw7Lk2MnPq5Rs8Tu1Vw4Xy6Za';
  assert.equal(c.containsSecret(entropy), true);
  assert.equal(new RegExp(c.PROVIDER_SECRET_PATTERNS.join('|'), 'u').test(entropy), false);
  assert.equal(c.SECRET_PATTERNS.length, c.PROVIDER_SECRET_PATTERNS.length + 1);
});
