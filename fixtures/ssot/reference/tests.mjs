import test from 'node:test';
import assert from 'node:assert/strict';
import { JevClient, JevError, validateRequest, validateResponse } from './dist/jev-client.js';
import { checkIntent } from './dist/policy-guard.js';

const request = () => ({
  model: 'jev-1.13.0', state: { diagnostic: 'A test failed; no source code is included.' },
  questions: {
    family: { type: 'choice', instructions: 'Which listed family matches the observed diagnostic?',
      criteria: { test: 'A test assertion failed.', unknown: 'Evidence is insufficient.' } },
    scope: { type: 'score', instructions: 'How much evidence is available?', criteria: ['None', 'Partial', 'Complete'] },
    repeated: { type: 'noul', instructions: 'Is there evidence of repeated failure?' }
  }
});
const response = () => ({ model: 'jev-1.13.0', answers: {
  family: { type: 'choice', choice: 'test', probabilities: { test: 0.8, unknown: 0.2 }, confidence: 0.6 },
  scope: { type: 'score', score: 1.05, probabilities: { '0': 0, '1': 0.95, '2': 0.05 },
    legend: { '0': 'None', '1': 'Partial', '2': 'Complete' }, confidence: 0.92 },
  repeated: { type: 'noul', noul: 0.3 }
}, usage: { input_tokens: 426, output_tokens: 73 } });
const errorCode = code => e => e instanceof JevError && e.code === code;
const fakeResponse = (data = response(), status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json' }
});
const makeClient = (fetchImpl = async () => fakeResponse(), extra = {}) => new JevClient({
  apiKey: 'offline-fixture-not-a-real-key', fetchImpl, ...extra
});

test('request validation serializes the supported native shape', () => {
  assert.deepEqual(JSON.parse(validateRequest(request())), request());
});
test('valid response retains all primitives and nonzero free output token counts', () => {
  assert.deepEqual(validateResponse(request(), response()), response());
});
for (const [name, mutate] of [
  ['unknown question answer', r => { r.answers.surprise = { type: 'noul', noul: 1 }; }],
  ['missing question answer', r => { delete r.answers.repeated; }],
  ['answer type mismatch', r => { r.answers.repeated.type = 'boolean'; }],
  ['unknown selected option', r => { r.answers.family.choice = 'shell-command'; }],
  ['selected option is not highest probability', r => { r.answers.family.choice = 'unknown'; }],
  ['distribution does not sum to one', r => { r.answers.family.probabilities.test = 0.5; }],
  ['negative probability', r => { r.answers.family.probabilities.test = -0.1; }],
  ['extra distribution key', r => { r.answers.family.probabilities.other = 0; }],
  ['nonfinite confidence', r => { r.answers.family.confidence = NaN; }],
  ['Noul outside probability interval', r => { r.answers.repeated.noul = 1.01; }],
  ['Score not consistent with distribution', r => { r.answers.scope.score = 2; }],
  ['Score rubric description changed', r => { r.answers.scope.legend['1'] = 'Different'; }],
  ['negative input usage', r => { r.usage.input_tokens = -1; }],
  ['fractional output usage', r => { r.usage.output_tokens = 0.5; }]
]) {
  test(`rejects ${name}`, () => {
    const r = response(); mutate(r);
    assert.throws(() => validateResponse(request(), r), errorCode('INVALID_RESPONSE'));
  });
}
test('model mismatch invalidates the evaluated policy version', () => {
  const r = response(); r.model = 'jev-next';
  assert.throws(() => validateResponse(request(), r), errorCode('MODEL_MISMATCH'));
});
for (const [name, mutate] of [
  ['moving model alias', r => { r.model = 'jev-latest'; }],
  ['empty question map', r => { r.questions = {}; }],
  ['unbounded instructions', r => { r.questions.family.instructions = 'x'.repeat(9000); }],
  ['one-level Score', r => { r.questions.scope.criteria = ['Only']; }],
  ['more than 255 Choice options', r => { r.questions.family.criteria = Object.fromEntries(Array.from({ length: 256 }, (_, i) => ['x' + i, 'X'])); }],
  ['null top-level state', r => { r.state = null; }],
  ['non-JSON state', r => { r.state = { fn: () => 1 }; }],
  ['dangerous map key', r => { r.questions = JSON.parse('{"__proto__":{"type":"noul","instructions":"Q?"}}'); }],
  ['cyclic state', r => { const obj = {}; obj.self = obj; r.state = obj; }],
  ['accessor state', r => { r.state = Object.defineProperty({}, 'secret', { enumerable: true, get() { throw new Error('getter executed'); } }); }]
]) {
  test(`rejects request with ${name}`, () => {
    const r = request(); mutate(r);
    assert.throws(() => validateRequest(r), errorCode('INVALID_REQUEST'));
  });
}
test('native HTTP bridge uses pinned endpoint and disables redirects', async () => {
  let observed;
  const client = makeClient(async (url, init) => { observed = { url, init }; return fakeResponse(); });
  assert.deepEqual(await client.evaluate(request()), response());
  assert.equal(observed.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(observed.init.redirect, 'error');
  assert.equal(observed.init.method, 'POST');
  assert.equal(observed.init.headers.Authorization, 'Bearer offline-fixture-not-a-real-key');
});
test('missing credentials fail before transport', () => {
  assert.throws(() => new JevClient({ apiKey: '' }), errorCode('CONFIGURATION'));
});
test('expired deadline makes no provider call', async () => {
  let calls = 0;
  const client = makeClient(async () => { calls++; return fakeResponse(); });
  await assert.rejects(client.evaluate(request(), { deadlineAtMs: Date.now() - 1 }), errorCode('DEADLINE'));
  assert.equal(calls, 0);
});
test('already cancelled request makes no provider call', async () => {
  const ac = new AbortController(); ac.abort();
  let calls = 0;
  const client = makeClient(async () => { calls++; return fakeResponse(); });
  await assert.rejects(client.evaluate(request(), { signal: ac.signal }), errorCode('CANCELLED'));
  assert.equal(calls, 0);
});
test('deadline bounds a stalled response body, not just response headers', async () => {
  const body = new ReadableStream({ start() {} });
  const client = makeClient(async () => new Response(body, { headers: { 'content-type': 'application/json' } }));
  await assert.rejects(client.evaluate(request(), { timeoutMs: 20 }), errorCode('DEADLINE'));
});
test('cancellation propagates while fetch is pending', async () => {
  const ac = new AbortController();
  const client = makeClient(async () => new Promise(() => {}));
  const promise = client.evaluate(request(), { signal: ac.signal, timeoutMs: 500 });
  setTimeout(() => ac.abort(), 5);
  await assert.rejects(promise, errorCode('CANCELLED'));
});
for (const status of [401, 422, 429, 529]) {
  test(`HTTP ${status} is sanitized and is not internally retried`, async () => {
    let calls = 0;
    const client = makeClient(async () => { calls++; return fakeResponse({ error: 'private-source-must-not-leak' }, status); });
    await assert.rejects(client.evaluate(request()), e => e instanceof JevError && e.code === 'HTTP' &&
      e.status === status && e.retryable === [429, 529].includes(status) && !e.message.includes('private-source'));
    assert.equal(calls, 1);
  });
}
test('response byte limit is enforced before parsing', async () => {
  const client = makeClient(async () => fakeResponse(), { maxResponseBytes: 20 });
  await assert.rejects(client.evaluate(request()), errorCode('RESPONSE_TOO_LARGE'));
});
test('request byte limit rejects before transport', async () => {
  const client = makeClient(async () => { assert.fail('transport should not run'); }, { maxRequestBytes: 20 });
  await assert.rejects(client.evaluate(request()), errorCode('REQUEST_TOO_LARGE'));
});
test('non-JSON response is not treated as a decision', async () => {
  const client = makeClient(async () => new Response('oops', { headers: { 'content-type': 'text/html' } }));
  await assert.rejects(client.evaluate(request()), errorCode('INVALID_RESPONSE'));
});
test('network errors do not leak transport error text', async () => {
  const client = makeClient(async () => { throw new Error('secret from a malicious proxy'); });
  await assert.rejects(client.evaluate(request()), e => errorCode('NETWORK')(e) && !e.message.includes('secret'));
});

const intent = () => ({ id: 'a1', decisionId: 'd1', expectedRevision: 'r1', expiresAt: '2030-01-01T00:00:00.000Z',
  capabilityId: 'route', reservationId: 'b1', action: { kind: 'route-worker', taskId: 't1', modelId: 'evaluated-model', profileId: 'local-refactor' } });
const context = () => ({ nowMs: Date.parse('2026-09-22T00:00:00Z'), mode: 'bounded-auto', revision: 'r1',
  authorizedActionKinds: new Set(['route-worker']), ownedTaskIds: new Set(['t1']), ownedLeaseIds: new Set(),
  capabilities: new Set(['route']), approvedModelIds: new Set(['evaluated-model']),
  userPinnedModelId: undefined, calibrationApproved: true, reservationValid: true });
test('eligible route passes the planning guard only', () => {
  assert.deepEqual(checkIntent(intent(), context()), { allowed: true, reason: 'ELIGIBLE_NOT_AUTHORIZATION' });
});
for (const [name, mutate, reason] of [
  ['off mode', c => { c.mode = 'off'; }, 'MODE'],
  ['observe mode', c => { c.mode = 'observe'; }, 'MODE'],
  ['advice-only mode', c => { c.mode = 'advise'; }, 'MODE'],
  ['stale repository revision', c => { c.revision = 'r2'; }, 'STALE'],
  ['missing capability', c => { c.capabilities.clear(); }, 'CAPABILITY'],
  ['missing host authority', c => { c.authorizedActionKinds.clear(); }, 'AUTHORITY'],
  ['unowned task', c => { c.ownedTaskIds.clear(); }, 'OWNERSHIP'],
  ['ineligible model', c => { c.approvedModelIds.clear(); }, 'MODEL'],
  ['conflicting user pin', c => { c.userPinnedModelId = 'user-choice'; }, 'USER_PIN'],
  ['unevaluated semantic route', c => { c.calibrationApproved = false; }, 'CALIBRATION'],
  ['missing reservation', c => { c.reservationValid = false; }, 'BUDGET'],
  ['expired decision', c => { c.nowMs = Date.parse('2031-01-01'); }, 'EXPIRED']
]) {
  test(`planning guard rejects ${name}`, () => {
    const c = context(); mutate(c);
    assert.deepEqual(checkIntent(intent(), c), { allowed: false, reason });
  });
}
test('untrusted runtime action kind is rejected rather than executed', () => {
  const i = intent(); i.action = { kind: 'grant-permission', command: 'anything' };
  assert.deepEqual(checkIntent(i, context()), { allowed: false, reason: 'ACTION_KIND' });
});
test('sparse arrays are not silently serialized into different evidence', () => {
  const r = request(); r.questions.scope.criteria = Array(2);
  assert.throws(() => validateRequest(r), errorCode('INVALID_REQUEST'));
});
test('transport validates against the sent snapshot, not later caller mutations', async () => {
  const r = request();
  const client = makeClient(async () => { r.questions.family.criteria.test = 'Mutated after dispatch'; r.model = 'jev-9.9.9'; return fakeResponse(); });
  assert.deepEqual(await client.evaluate(r), response());
});
