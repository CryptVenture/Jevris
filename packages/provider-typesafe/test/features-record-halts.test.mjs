// JEV-0072: a run of the Jev feature suite that a cap or a status stops still writes its record. The record is checked against an allow-list before it is
// written (`recordViolations`, JEV-0049), and `spent.halted` (the code the run stopped with) was not on it, so a capped run exited 1 with no record at all. These
// tests run every way the run can stop through the suite's own runner and the record builder the script uses, and keep the allow-list in step with a record
// that holds a value at every field: a field that is listed needs an example here, and an example that is not listed is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const provider = await import('../dist/index.js');
const { RECORD_STRING_PATHS, createCallMeter, createMockFetch, createSidecarEngine, recordViolations, runFeatureSuite, spentRecord } = provider;

const FREE_TEXT = 'stopped: the cap of /home/me/work was reached';

/** The record the script writes around the engine part (the sidecar parts are skipped here), built with the script's own `spentRecord`. */
const recordOf = (engine, meter) => ({
  schemaVersion: 'jev-features-suite-1',
  kind: 'jev-features-suite',
  mode: 'mock',
  producedAt: '2026-10-05T12:02:11.914Z',
  pinnedModel: 'jev-1.13.0',
  engine,
  spent: spentRecord(meter, null),
  failures: [...engine.failures],
  passed: false,
  applied: false,
  version: '1.2.0',
  commit: null,
  environment: { os: 'darwin', arch: 'arm64', node: 'v22.14.0' },
});

const status = (code) => async () => new Response(JSON.stringify({ error: { type: 'a-free-text-type', message: 'a message the API sent, with a sentence in it' } }), { status: code, headers: { 'content-type': 'application/json' } });

async function haltedRun(t, { fetch = createMockFetch({ scenario: 'valid' }), limits = {}, abortAfterEngines } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-features-halts-'));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3 }));
  const meter = createCallMeter(fetch, { maxCalls: 400, maxMicroUsd: 100_000, ...limits });
  let engines = 0;
  const createEngine = async ({ egress }) => {
    engines += 1;
    // The suite's own abort: the meter is told to stop after some engines were made.
    if (abortAfterEngines !== undefined && engines > abortAfterEngines) meter.halt('OPERATOR_STOP');
    return createSidecarEngine({ home, credential: 'test-key-not-a-secret', fetch: meter.fetch, env: {}, budgetLimitMicroUsd: 5_000_000, sourceEgress: () => ({ provenance: 'administrator', sourceEgress: egress ? 'approved-scoped' : 'deny-until-approved' }) });
  };
  const createProbeEngine = async ({ fetch: probeFetch, clock }) => {
    const probeHome = mkdtempSync(join(tmpdir(), 'jevris-features-halts-probe-'));
    t.after(() => rmSync(probeHome, { recursive: true, force: true, maxRetries: 3 }));
    return createSidecarEngine({ home: probeHome, credential: 'test-key-not-a-secret', fetch: probeFetch, clock, env: {}, budgetLimitMicroUsd: 5_000_000 });
  };
  const engine = await runFeatureSuite({ meter, createEngine, createProbeEngine, cold: 2, cached: 1 });
  return { engine, meter, record: recordOf(engine, meter) };
}

// Every way a run stops early: a call cap, a spend cap, the first 401, 402 or 403, three 429s in a row, and the suite's own abort.
const WAYS = [
  ['a call cap', 'CALL_CAP', { limits: { maxCalls: 5 } }],
  ['a spend cap', 'SPEND_CAP', { limits: { maxMicroUsd: 100 } }],
  ['the first 401', 'HTTP_401', { fetch: createMockFetch({ scenario: 'http-401' }) }],
  ['the first 402', 'HTTP_402', { fetch: status(402) }],
  ['the first 403', 'HTTP_403', { fetch: createMockFetch({ scenario: 'http-403' }) }],
  ['three 429s in a row', 'HTTP_429_STORM', { fetch: createMockFetch({ scenario: 'http-429' }) }],
  ['the suite\'s own abort', 'OPERATOR_STOP', { abortAfterEngines: 3 }],
];

for (const [way, code, options] of WAYS) {
  test(`a run stopped by ${way} has a record that validates: spent.halted and engine.halted are ${code}, the cases left unrun are listed, and the failure is HALTED_${code}`, async (t) => {
    const { engine, record } = await haltedRun(t, options);
    assert.equal(engine.halted, code);
    assert.equal(record.spent.halted, code);
    assert.ok(engine.skipped.length > 0, 'the cases the stop left unrun are listed');
    assert.ok(record.failures.includes(`HALTED_${code}`), JSON.stringify(record.failures));
    assert.equal(engine.passed, false);
    // Nothing the stop touches holds text: the engine rows a refused call fell back in, the skipped ids, the failure codes and the halt code itself.
    assert.deepEqual(recordViolations(record), []);
    // And the remote body the 402 and the others carried (a message, a type) is nowhere in the record.
    assert.equal(JSON.stringify(record).includes('a message the API sent'), false);
    assert.equal(JSON.stringify(record).includes('a-free-text-type'), false);
  });
}

test('a call cap holds exactly and a spend cap stops one call past it, so the record says how far the run got', async (t) => {
  const calls = await haltedRun(t, { limits: { maxCalls: 5 } });
  assert.equal(calls.record.spent.engineCalls, 5);
  assert.deepEqual(calls.record.failures, ['HALTED_CALL_CAP']);
  const spend = await haltedRun(t, { limits: { maxMicroUsd: 100 } });
  assert.deepEqual(spend.record.failures, ['HALTED_SPEND_CAP']);
  assert.ok(spend.record.spent.engineMicroUsd >= 100 && spend.record.spent.engineMicroUsd < 300, `${String(spend.record.spent.engineMicroUsd)} micro-USD`);
});

test('a run that was not stopped has halted null, and its spent part validates', () => {
  const meter = createCallMeter(createMockFetch({ scenario: 'valid' }), { maxCalls: 400, maxMicroUsd: 100_000 });
  const spent = spentRecord(meter, 2540);
  assert.equal(spent.halted, null);
  assert.equal(spent.sidecarMicroUsd, 2540);
  assert.deepEqual(recordViolations({ spent }), []);
});

test('a free-text halt reason is still refused, at both fields that hold one, and never quoted back', () => {
  for (const path of ['spent.halted', 'engine.halted']) {
    const [head, tail] = path.split('.');
    const found = recordViolations({ [head]: { [tail]: FREE_TEXT } });
    assert.equal(found.length, 1, `${path}: ${JSON.stringify(found)}`);
    assert.match(found[0], new RegExp(`^${head}\\.${tail}: not the code or label this field holds`));
    assert.equal(found.join('\n').includes('/home/me'), false, 'the violation quotes the value');
  }
  for (const text of ['call cap', 'call_cap', 'HTTP 401', 'CALL_CAP\nSPEND_CAP', `C${'A'.repeat(64)}`, '/tmp/x']) assert.equal(recordViolations({ spent: { halted: text } }).length, 1, text);
  for (const code of ['CALL_CAP', 'SPEND_CAP', 'HTTP_401', 'HTTP_402', 'HTTP_403', 'HTTP_429_STORM', 'OPERATOR_STOP']) assert.deepEqual(recordViolations({ spent: { halted: code }, engine: { halted: code } }), [], code);
  assert.deepEqual(recordViolations({ spent: { halted: null }, engine: { halted: null } }), []);
});

// ------------------------------------------------------------------------------------------------ every string field

/** One value at every field a string is listed for, as a run stopped by a 429 storm writes them (a refused call fell back, cases skipped, failures named). */
const example = () => ({
  schemaVersion: 'jev-features-suite-1',
  kind: 'jev-features-suite',
  mode: 'mock',
  producedAt: '2026-10-05T12:02:11.914Z',
  pinnedModel: 'jev-1.13.0',
  version: '1.2.0',
  commit: 'a'.repeat(40),
  failures: ['HALTED_HTTP_429_STORM'],
  environment: { os: 'darwin', arch: 'arm64', node: 'v22.14.0' },
  spent: { engineCalls: 3, engineMicroUsd: 120, engineInputTokens: 900, engineOutputTokens: 40, statuses: { 200: 1, 429: 2, none: 1 }, sidecarMicroUsd: null, halted: 'HTTP_429_STORM' },
  engine: {
    schemaVersion: 'jev-features-suite-1',
    pinnedModel: 'jev-1.13.0',
    halted: 'HTTP_429_STORM',
    failures: ['HALTED_HTTP_429_STORM', 'PROVIDER_CALL_FAILED'],
    skipped: ['slice-docs-only', 'c51-benign'],
    totals: { calls: 3, refused: 1, statuses: { 200: 1, 429: 2, none: 1 } },
    groups: [{ group: 'slice', cases: 2, rows: 3, fallbackReasons: { SLICE_JEV_PROVIDER_ERROR: 1 }, cold: { n: 1, p50: 5 } }],
    rows: [
      {
        group: 'slice',
        id: 'slice-feature',
        spec: 'slice-classify',
        phase: 'cold',
        repeat: 0,
        expected: 'feature|bugfix',
        got: 'rules,none>p1',
        rulesGot: 'feature',
        jevGot: 'bugfix',
        source: 'rules',
        reasonCode: 'SLICE_JEV_PROVIDER_ERROR',
        failureKind: 'INVALID_RESPONSE',
        answers: [{ id: 'slice', type: 'choice', p1: 0.9, p2: 0.1, confidence: 0.8, value: null }],
        detail: { risk: 'high', order: 'a,b', transport: 'conformance-mock', asked: 2 },
      },
    ],
  },
  capabilities: {
    passes: [{ part: 'a', egress: 'denied', cases: 1, knownDefects: ['C25'], knownLeaks: ['C26'] }],
    rows: [
      {
        id: 'C25',
        title: 'Suggest a dependency between two planned tasks',
        part: 'a',
        egress: 'approved',
        source: 'jev',
        reasonCode: 'not-verified',
        decisionId: 'd-8f6be3fa-bdf8-42bd-9aee-03f5abce6b4a',
        verb: 'handoff.export',
        failure: 'step plan.submit: KILL_SWITCH_ACTIVE',
        jevReasonCodes: ['DECISION_ADVISORY'],
        answerProbabilities: [{ id: 'q', type: 'noul', probability: 0.9 }],
        ok: false,
        requests: 0,
      },
    ],
  },
  hot: {
    firstRequest: { op: 'route', phase: 'first', source: 'none', reasonCode: 'UNAVAILABLE', decisionId: null },
    route: { cold: { n: 1 }, reasonCounts: { UNAVAILABLE: 1 }, rowsCold: [{ op: 'route', phase: 'cold', source: 'jev', reasonCode: 'SLICE_HIGH_RISK', decisionId: 'd-8f6be3fa-bdf8-42bd-9aee-03f5abce6b4a' }] },
    plan: { rowsCached: [{ op: 'plan', phase: 'cached', source: 'rules', reasonCode: 'FAILED' }] },
    burst: { rows: [{ op: 'route', phase: 'burst', source: 'none', reasonCode: 'SLICE_HIGH_RISK', decisionId: null }] },
  },
  hotEngine: { 'check-ranking': { cold: { p50: 5 }, reasonCounts: { SLICE_JEV_PROVIDER_ERROR: 2 } } },
  passed: false,
  applied: false,
});

const TITLES = ['Suggest a dependency between two planned tasks'];

/** The path of every string in a value, as `a.b[].c`, once per path. */
function stringPaths(value, path = '', into = new Set()) {
  if (typeof value === 'string') into.add(path);
  else if (Array.isArray(value)) for (const item of value) stringPaths(item, `${path}[]`, into);
  else if (value !== null && typeof value === 'object') for (const [key, inner] of Object.entries(value)) stringPaths(inner, path === '' ? key : `${path}.${key}`, into);
  return into;
}

/** A copy with the string at `path` replaced (every list is one element long here). */
function withText(value, path, text) {
  const copy = structuredClone(value);
  const steps = path.split('.');
  let at = copy;
  steps.forEach((step, i) => {
    const isList = step.endsWith('[]');
    const key = isList ? step.slice(0, -2) : step;
    const last = i === steps.length - 1;
    if (last) {
      if (isList) at[key][0] = text;
      else at[key] = text;
    } else at = isList ? at[key][0] : at[key];
  });
  return copy;
}

test('the allow-list and the example record are in step: every listed field has a value here, and the example validates', () => {
  const rec = example();
  assert.deepEqual(recordViolations(rec, { titles: TITLES }), []);
  const held = stringPaths(rec);
  const missing = RECORD_STRING_PATHS.filter((p) => !held.has(p));
  assert.deepEqual(missing, [], 'a field is listed in features-record.ts and has no example here: add one, with its shape');
});

test('every string field is refused when it holds text, named by its path and never quoted: no field can carry a message, a path or a sentence', () => {
  const rec = example();
  const paths = [...stringPaths(rec)];
  assert.ok(paths.length > 60, `${String(paths.length)} string fields in the example`);
  for (const path of paths) {
    const found = recordViolations(withText(rec, path, FREE_TEXT), { titles: TITLES });
    assert.ok(found.length >= 1 && found.every((line) => line.startsWith(`${path}: `)), `${path}: ${JSON.stringify(found)}`);
    assert.equal(found.join('\n').includes('/home/me'), false, `${path}: the violation quotes the value`);
  }
});

test('a field that is not listed is refused, whatever it holds, so a new field has to be listed with its shape', () => {
  for (const [at, rec] of [
    ['spent.note', { ...example(), spent: { ...example().spent, note: 'CALL_CAP' } }],
    ['engine.haltedBecause', { ...example(), engine: { ...example().engine, haltedBecause: 'CALL_CAP' } }],
    ['hot.route.error', { ...example(), hot: { route: { error: 'ECONNREFUSED' } } }],
  ]) {
    const found = recordViolations(rec, { titles: TITLES });
    assert.ok(found.some((line) => line.startsWith(`${at}: a string where the record holds numbers and codes`)), `${at}: ${JSON.stringify(found)}`);
  }
});

test('the keys of a map are codes too: a status, a reason code and a detail name pass, a phrase or a path as a key is refused and not quoted', () => {
  assert.deepEqual(recordViolations({ spent: { statuses: { 200: 3, 429: 2, none: 1 } }, hot: { route: { reasonCounts: { SLICE_HIGH_RISK: 1, none: 2, 'DEADLINE_EXCEEDED:late': 1 } } } }), []);
  for (const key of ['the sidecar at /home/me is down', 'unavailable: could not start', '', 'a'.repeat(81)]) {
    const found = recordViolations({ hot: { route: { reasonCounts: { [key]: 1 } } } });
    assert.equal(found.length, 1, JSON.stringify(key));
    assert.match(found[0], /^hot\.route\.reasonCounts: a key that is not a code \(\d+ characters\)$/);
    assert.equal(found[0].includes('/home/me'), false);
  }
});
