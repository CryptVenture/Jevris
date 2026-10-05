// The engine-level Jev feature suite, run offline against the conformance mock: every case runs through
// the real handler, engine and packet builders; the rows hold numbers and codes only; a case that must
// not send (egress denied, a fake secret, a prompt too short) sends nothing; a run stops at a cap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const provider = await import('../dist/index.js');
const { createCallMeter, createMockFetch, createSidecarEngine, engineCases, runFeatureSuite, suiteFailures, ENGINE_GROUPS, FAKE_SECRET, FEATURE_INVENTORY } = provider;

function harness(t, { fetch = createMockFetch({ scenario: 'valid' }), limits = { maxCalls: 400, maxMicroUsd: 100_000 } } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-features-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const meter = createCallMeter(fetch, limits);
  const createEngine = async ({ egress }) => createSidecarEngine({ home, credential: 'test-key-not-a-secret', fetch: meter.fetch, env: {}, budgetLimitMicroUsd: 5_000_000, sourceEgress: () => ({ provenance: 'administrator', sourceEgress: egress ? 'approved-scoped' : 'deny-until-approved' }) });
  // The health-probe case drives the circuit breaker, which persists under its home: an engine of its own, on the fetch and the clock the case gives it.
  const createProbeEngine = async ({ fetch: probeFetch, clock }) => {
    const probeHome = mkdtempSync(join(tmpdir(), 'jevris-features-probe-'));
    t.after(() => rmSync(probeHome, { recursive: true, force: true }));
    return createSidecarEngine({ home: probeHome, credential: 'test-key-not-a-secret', fetch: probeFetch, clock, env: {}, budgetLimitMicroUsd: 5_000_000 });
  };
  return { meter, createEngine, createProbeEngine };
}

test('the case list covers every group, with unique ids and the fixed task shapes', () => {
  const cases = engineCases();
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length, 'case ids are unique');
  assert.deepEqual([...new Set(cases.map((c) => c.group))].sort(), [...ENGINE_GROUPS].sort());
  const slices = cases.filter((c) => c.group === 'slice');
  assert.ok(slices.length >= 12, `${String(slices.length)} slice shapes (the brief asks for about 12)`);
  for (const id of ['slice-docs-only', 'slice-tests-only', 'slice-bugfix-with-test', 'slice-refactor', 'slice-feature', 'slice-migration', 'slice-ci-config', 'slice-secrets-path', 'slice-run-only', 'slice-ambiguous', 'slice-empty']) assert.ok(slices.some((c) => c.id === id), id);
  assert.ok(cases.find((c) => c.id === 'plan-6-tasks'), 'a six-task plan with one declared slice');
  assert.equal(cases.filter((c) => c.group === 'check-ranking').length >= 5, true, 'eight approved checks across five or more change shapes');
  for (const id of ['new-task-clear-bugfix', 'new-task-ambiguous-speed', 'new-task-fake-secret', 'new-task-egress-denied']) assert.ok(cases.some((c) => c.id === id), id);
  assert.match(FAKE_SECRET, /^ghp_/, 'a credential-shaped token that belongs to no service');
});

test('the whole suite runs offline: Jev-asking cases repeat cold and cached, refusals send nothing, nothing private is in a request', async (t) => {
  const { meter, createEngine, createProbeEngine } = harness(t);
  const lines = [];
  const record = await runFeatureSuite({ meter, createEngine, createProbeEngine, cold: 2, cached: 2, progress: (l) => lines.push(l) });
  assert.equal(record.schemaVersion, 'jev-features-suite-1');
  assert.deepEqual(record.failures, []);
  assert.equal(record.passed, true);
  assert.equal(record.halted, null);
  assert.deepEqual(record.skipped, []);
  // The inventory's claim (JEV-0067): the suite covers each engine-level entry, so every spec the inventory lists that is not a
  // capability (those run through a sidecar: see jev-feature-inventory-coverage.test.mjs) has a row of its own spec in the record.
  const rowSpecs = new Set(record.rows.map((r) => r.spec));
  assert.deepEqual(FEATURE_INVENTORY.filter((e) => !/^d-c\d{2}$/.test(e.spec) && !rowSpecs.has(e.spec)).map((e) => e.spec), [], 'an inventory entry with no case in the record');
  assert.deepEqual(record.rows.filter((r) => r.spec === 'health-probe').map((r) => [r.group, r.id, r.phase, r.got]), [['health-probe', 'health-probe-half-open', 'cold', 'PROBE_OK']], 'the probe runs once, not repeated cold and cached');
  assert.equal(lines.length, new Set(record.rows.map((r) => r.id)).size, 'one progress line per case');
  assert.deepEqual([...new Set(record.groups.map((g) => g.group))].sort(), [...ENGINE_GROUPS].sort());
  const rowsOf = (id) => record.rows.filter((r) => r.id === id);
  // Rules-sure shapes and gates make no request: one row, phase gate.
  for (const id of ['slice-docs-only', 'slice-run-only', 'slice-empty', 'new-task-fake-secret', 'new-task-egress-denied', 'new-task-too-short', 'c01-triage-denied', 'c02-ambiguity-denied', 'c02-objective-with-fake-secret', 'slice-migration', 'slice-ci-config', 'slice-secrets-path']) {
    const rows = rowsOf(id);
    assert.deepEqual(rows.map((r) => [r.phase, r.calls]), [['gate', 0]], `${id} sends nothing`);
  }
  // A case that asks Jev: two cold runs that each made one request, then two cached runs from the decision cache.
  const feature = rowsOf('slice-feature');
  assert.deepEqual(feature.map((r) => [r.phase, r.calls > 0]), [['cold', true], ['cold', true], ['cached', false], ['cached', false]]);
  assert.ok(feature.filter((r) => r.phase === 'cached').every((r) => r.cacheHit === true || r.asked), 'a cached run is answered by the cache');
  // Numbers: tokens, cost and the answers' shape are recorded for the runs that sent a request.
  const cold = feature[0];
  assert.ok(cold.inputTokens > 0 && cold.costMicroUsd > 0 && cold.networkMs !== null);
  assert.ok(cold.answers.some((a) => a.type === 'choice') && cold.answers.some((a) => a.type === 'score'));
  assert.equal(record.rows.reduce((n, r) => n + r.leaks, 0), 0, 'no title, path, prompt or tool text was in a request');
  assert.ok(record.totals.calls > 0 && record.totals.costMicroUsd > 0);
  assert.ok(record.distributions.choiceConfidence.n > 0 && record.distributions.scoreConfidence.n > 0 && record.distributions.noulCertainty.n > 0);
  // The record is numbers and codes: no key, no request text, no fake secret.
  const text = JSON.stringify(record);
  assert.equal(text.includes('test-key-not-a-secret'), false);
  assert.equal(text.includes(FAKE_SECRET), false, 'the refused token is not in the record');
  assert.equal(text.includes('Bearer'), false);
  // The check-ranking rows keep every check in the order exactly once.
  for (const r of record.rows.filter((x) => x.group === 'check-ranking' && x.calls > 0)) assert.equal(r.detail.permutation, true, r.id);
});

test('the repeated-failure cases: which artifact comes next is never asked, with source egress denied or approved; only the same-failure Noul reaches Jev', async (t) => {
  const { meter, createEngine } = harness(t);
  const record = await runFeatureSuite({ meter, createEngine, cold: 2, cached: 1, groups: ['repeated-failure'] });
  assert.equal(record.passed, true, JSON.stringify(record.failures));
  const rowsOf = (id) => record.rows.filter((r) => r.id === id);
  assert.ok(provider.FAILURE_NO_REQUEST_IDS.includes('failure-equal-2-nothing-known') && provider.FAILURE_NO_REQUEST_IDS.includes('failure-equal-2-nothing-known-egress'), 'the same failure with egress denied and with egress approved');
  assert.equal(provider.FAILURE_NO_REQUEST_IDS.includes('failure-unequal-3-same-call'), false);
  for (const id of provider.FAILURE_NO_REQUEST_IDS) {
    assert.deepEqual(rowsOf(id).map((r) => [r.phase, r.calls, r.asked]), [['gate', 0, false]], `${id} makes no request`);
    assert.equal(rowsOf(id)[0].agree, true, `${id} names the rules' artifact`);
  }
  assert.equal(rowsOf('failure-equal-2-nothing-known')[0].reasonCode, 'REPEATED_FAILURE_NEXT_RULES');
  // The one question: the content-free same-failure Noul. Two cold runs that each made a request, then a cached run.
  const same = rowsOf('failure-unequal-3-same-call');
  assert.deepEqual(same.map((r) => [r.phase, r.calls > 0]), [['cold', true], ['cold', true], ['cached', false]]);
  assert.ok(same.every((r) => r.answers.every((a) => a.type === 'noul')), 'only Noul answers: no Choice is asked');
  // A failure case that sends a request is a failed run.
  assert.deepEqual(suiteFailures([{ id: 'failure-equal-2-nothing-known', leaks: 0, calls: 1, failureKind: null, failedCalls: 0 }], null), ['REFUSED_CASE_SENT_A_REQUEST']);
  assert.deepEqual(suiteFailures([{ id: 'failure-unequal-3-same-call', leaks: 0, calls: 1, failureKind: null, failedCalls: 0 }], null), []);
});

test('the health probe (JEV-0067): the case opens the circuit with failures, lets the cool-down pass on an injected clock, and the probe it asks restores the circuit; nothing reaches the metered transport', async (t) => {
  const { meter, createEngine, createProbeEngine } = harness(t);
  const record = await runFeatureSuite({ meter, createEngine, createProbeEngine, cold: 3, cached: 2, groups: ['health-probe'] });
  assert.equal(record.passed, true, JSON.stringify(record.failures));
  assert.equal(record.rows.length, 1, 'one run: a repeat of a case that builds its own engine and clock measures nothing new');
  const [row] = record.rows;
  assert.deepEqual([row.group, row.id, row.spec, row.phase, row.expected, row.got, row.agree, row.source, row.reasonCode, row.asked, row.answered], ['health-probe', 'health-probe-half-open', 'health-probe', 'cold', 'PROBE_OK', 'PROBE_OK', true, 'none', 'PROBE_OK', true, true]);
  // The states the engine went through, read from its own circuit, and the counts of the requests the mock saw.
  assert.deepEqual(
    { ...row.detail, failuresToOpen: typeof row.detail.failuresToOpen },
    { transport: 'conformance-mock', failuresToOpen: 'number', stateOpened: 'open', refusedWithoutCall: true, stateAfterCooldown: 'half-open', probeRequests: 4, probesAnswered: 4, secondProbeInInterval: 'PROBE_RATE_LIMITED', stateAfterFirstProbe: 'observe-only', stateAfterRestore: 'closed', probeCarriesTaskText: false },
  );
  assert.ok(row.detail.failuresToOpen >= 1 && row.detail.failuresToOpen <= 8, `the outage opened the circuit after ${String(row.detail.failuresToOpen)} failed decisions`);
  // Nothing went through the suite's metered transport (the live API in a live run), so the row spends nothing and the meter saw no call.
  assert.deepEqual([row.calls, row.costMicroUsd, row.inputTokens, row.leaks, meter.totals().calls], [0, 0, 0, 0, 0]);
  // The record holds numbers and codes only.
  for (const [key, value] of Object.entries(row.detail)) assert.ok(typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value)), `${key}: a number, a flag, or a code`);
  assert.equal(JSON.stringify(record).includes('Pick a helper'), false, 'the probe case\'s own task text is not in the record');
  assert.deepEqual(record.groups.map((g) => [g.group, g.cases, g.rows, g.calls]), [['health-probe', 1, 1, 0]]);
});

test('without an engine for the probe the case says so and the run does not pass; a probe that did not restore the circuit is its own failure code', async (t) => {
  const { meter, createEngine } = harness(t);
  const record = await runFeatureSuite({ meter, createEngine, cold: 1, cached: 0, groups: ['health-probe'] });
  assert.equal(record.rows[0].reasonCode, 'PROBE_ENGINE_NOT_SUPPLIED');
  assert.equal(record.passed, false);
  assert.deepEqual(record.failures, ['HEALTH_PROBE_NOT_RESTORED']);
  const row = (over) => ({ id: 'health-probe-half-open', spec: 'health-probe', got: 'PROBE_OK', leaks: 0, calls: 0, failureKind: null, failedCalls: 0, ...over });
  assert.deepEqual(suiteFailures([row({})], null), []);
  assert.deepEqual(suiteFailures([row({ got: 'PROBE_RESTORE_INCOMPLETE' })], null), ['HEALTH_PROBE_NOT_RESTORED']);
  assert.deepEqual(suiteFailures([row({ got: 'COOLDOWN' })], null), ['HEALTH_PROBE_NOT_RESTORED']);
});

test('groups and cases can be selected, and a case that needs no model is a gate row', async (t) => {
  const { meter, createEngine } = harness(t);
  const record = await runFeatureSuite({ meter, createEngine, cold: 1, cached: 0, groups: ['security'], cases: ['c51-benign', 'c51-plain-text', 'c49-npm-install'] });
  assert.deepEqual(record.rows.map((r) => [r.id, r.phase]), [['c51-benign', 'cold'], ['c51-plain-text', 'gate'], ['c49-npm-install', 'cold']]);
  assert.equal(record.passed, true);
});

test('a call cap halts the run: the cases left are skipped, nothing more is sent and the run does not pass', async (t) => {
  const { meter, createEngine, createProbeEngine } = harness(t, { limits: { maxCalls: 3, maxMicroUsd: 100_000 } });
  const record = await runFeatureSuite({ meter, createEngine, createProbeEngine, cold: 2, cached: 1 });
  assert.equal(record.halted, 'CALL_CAP');
  assert.equal(record.totals.calls, 3);
  assert.ok(record.skipped.length > 0, 'cases that did not run are listed');
  assert.equal(record.passed, false);
  assert.ok(record.failures.includes('HALTED_CALL_CAP'));
});

test('a provider that answers 401 halts at the first call and the suite reports it without looping', async (t) => {
  const { meter, createEngine, createProbeEngine } = harness(t, { fetch: createMockFetch({ scenario: 'http-401' }) });
  const record = await runFeatureSuite({ meter, createEngine, createProbeEngine, cold: 3, cached: 2 });
  assert.equal(record.halted, 'HTTP_401');
  assert.ok(record.totals.calls <= 2, `${String(record.totals.calls)} calls after a 401`);
  assert.equal(record.passed, false);
});

test('suiteFailures names each way a run fails, by code', () => {
  const row = (over) => ({ id: 'x', leaks: 0, calls: 0, failureKind: null, failedCalls: 0, ...over });
  assert.deepEqual(suiteFailures([row({})], null), []);
  assert.deepEqual(suiteFailures([row({ leaks: 1 })], null), ['REQUEST_CARRIED_PRIVATE_TEXT']);
  assert.deepEqual(suiteFailures([row({ id: 'new-task-fake-secret', calls: 1 })], null), ['REFUSED_CASE_SENT_A_REQUEST']);
  assert.deepEqual(suiteFailures([row({ failureKind: 'INVALID_RESPONSE' })], null), ['PROVIDER_ANSWER_REJECTED_BY_VALIDATOR']);
  assert.deepEqual(suiteFailures([row({ failedCalls: 1 })], null), ['PROVIDER_CALL_FAILED']);
  assert.deepEqual(suiteFailures([row({ failedCalls: 0, calls: 1 })], 'HTTP_429_STORM'), ['HALTED_HTTP_429_STORM']);
});
