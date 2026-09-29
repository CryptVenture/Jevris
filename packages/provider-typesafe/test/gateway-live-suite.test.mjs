import test from 'node:test';
import assert from 'node:assert/strict';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');
const { createDeadline } = await import('@jevris/platform');
const { createGatewayTransport, normalizeGatewayAnswers, GATEWAYS, createSdkTransport, createMockFetch, runLiveSuite, CONFORMANCE_REQUEST } = provider;

const KEY = 'test-key-not-a-secret';

/** Native answers from the conformance mock, used as the certification reference. */
async function nativeAnswers() {
  const fetch = createMockFetch();
  const response = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(CONFORMANCE_REQUEST),
  });
  return (await response.json()).answers;
}

test('PRV-09: gateways ship disabled and each declares its limits', () => {
  for (const id of ['vercel', 'cloudflare', 'netlify']) {
    assert.equal(GATEWAYS[id].enabledByDefault, false);
    assert.throws(() => createGatewayTransport(id, async () => ({}), { enabled: false }), /GATEWAY_DISABLED/);
  }
  assert.equal(GATEWAYS.cloudflare.requestTokenLimit, 32_000);
});

test('PRV-09: Vercel Noul `probability` normalizes to the native meaning; a flattened Boolean is refused', async () => {
  const native = await nativeAnswers();
  const vercelShape = {
    taskFamily: { ...native.taskFamily },
    changeRisk: { ...native.changeRisk },
    compatibilityEvidenceMissing: { probability: native.compatibilityEvidenceMissing.noul, result: true },
  };
  const normalized = normalizeGatewayAnswers('vercel', CONFORMANCE_REQUEST, vercelShape);
  assert.equal(normalized.ok, true);
  assert.deepEqual(normalized.answers, native, 'certification fixture: same meaning as native');
  const flattened = normalizeGatewayAnswers('vercel', CONFORMANCE_REQUEST, { ...vercelShape, compatibilityEvidenceMissing: { result: true } });
  assert.equal(flattened.ok, false);
  assert.equal(flattened.reasonCode, 'GATEWAY_NOUL_FLATTENED');
});

test('PRV-09: a gateway keeps the resolved model, and without a visible model the answer is advisory-only', async () => {
  const native = await nativeAnswers();
  const usage = { input_tokens: 300, output_tokens: 39 };
  const visible = createGatewayTransport('netlify', async () => ({ status: 200, model: 'jev-1.13.0', answers: native, usage }), { enabled: true });
  const hidden = createGatewayTransport('cloudflare', async () => ({ status: 200, model: null, answers: native, usage: null }), { enabled: true });
  const a = await new core.JevClient({ transport: visible }).ask({ request: CONFORMANCE_REQUEST, lane: 'interactive', deadline: createDeadline(2000) });
  assert.equal(a.ok, true);
  assert.equal(a.automation, true);
  assert.equal(a.model, 'jev-1.13.0');
  assert.equal(a.route, 'gateway-netlify');
  assert.deepEqual(a.usage, { inputTokens: 300, outputTokens: 39 });
  const b = await new core.JevClient({ transport: hidden }).ask({ request: CONFORMANCE_REQUEST, lane: 'interactive', deadline: createDeadline(2000) });
  assert.equal(b.ok, true);
  assert.equal(b.automation, false, 'advisory-only');
  assert.equal(b.usage, null, 'unknown usage stays unknown');
  const truncated = { ...native, taskFamily: { ...native.taskFamily, probabilities: { documentation: 0.5 } } };
  const lossy = createGatewayTransport('vercel', async () => ({ status: 200, model: 'jev-1.13.0', answers: truncated, usage }), { enabled: true });
  const c = await new core.JevClient({ transport: lossy }).ask({ request: CONFORMANCE_REQUEST, lane: 'interactive', deadline: createDeadline(2000) });
  assert.equal(c.ok, false, 'a truncated distribution is refused, never repaired');
  const err = createGatewayTransport('vercel', async () => ({ status: 429, model: null, answers: null, usage: null, retryAfterMs: 1500 }), { enabled: true });
  const d = await err.call(CONFORMANCE_REQUEST, { timeoutMs: 1000 });
  assert.equal(d.failure, 'rate-limited');
  assert.equal(d.retryAfterMs, 1500);
});

test('PRV-10: the API suite runs green against the conformance mock (the regular CI path)', async () => {
  const record = await runLiveSuite({
    transport: createSdkTransport({ apiKey: KEY, fetch: createMockFetch() }),
    badKeyTransport: createSdkTransport({ apiKey: KEY, fetch: createMockFetch({ scenario: 'http-401' }) }),
    cancelTransport: createSdkTransport({ apiKey: KEY, fetch: createMockFetch({ scenario: 'aborted' }) }),
    latencyCalls: 30,
    mode: 'mock',
  });
  assert.equal(record.passed, true, JSON.stringify(record));
  assert.deepEqual(record.primitives, { choice: true, score: true, noul: true, noulHasConfidence: false });
  assert.equal(record.cancellation.cancelled, true);
  assert.equal(record.caps.overTokenCapRefused, true);
  assert.equal(record.caps.overTokenCapSent, false);
  assert.equal(record.usage.estimateAlwaysConservative, true);
  assert.equal(record.latency.okCalls, 30);
  assert.ok(record.latency.p95Ms !== null);
  assert.equal(record.latency.samples.length, 30, 'every latency call is recorded');
  for (const sample of record.latency.samples) {
    assert.deepEqual(Object.keys(sample).sort(), ['elapsedMs', 'failure', 'ok', 'reasonCode', 'status']);
    assert.ok(Number.isInteger(sample.elapsedMs) && sample.elapsedMs >= 0);
    assert.equal(sample.ok, true);
  }
  assert.equal(record.latency.failedCalls, 0);
  assert.deepEqual(record.latency.reasonCounts, {});
  assert.equal(record.latency.measureTimeoutMs, 10_000, 'the sample is measured under the SDK default timeout, not the hot budget');
  assert.equal(record.latency.budgetMs, 900);
  assert.equal(record.latency.p95TargetMs, 800);
  assert.equal(record.latency.withinBudgetFraction, 1);
  assert.equal(record.latency.p95WithinTarget, true);
  assert.deepEqual(record.errors.map((e) => [e.expected, e.matched]), [['INVALID_REQUEST', true], ['INVALID_REQUEST', true], ['PROVIDER_DISABLED', true]]);
  for (const error of record.errors) assert.ok(Number.isInteger(error.elapsedMs) && error.elapsedMs >= 0, `${error.probe} records its elapsed time`);
  assert.deepEqual(record.errors.map((e) => e.failure), ['invalid-request', 'invalid-request', 'auth']);
  assert.deepEqual(record.errors.map((e) => e.reasonCode), ['INVALID_REQUEST', 'INVALID_REQUEST', 'PROVIDER_DISABLED']);
  assert.equal(JSON.stringify(record).includes(KEY), false, 'no key in the evidence record');
  assert.equal(record.applied, false);
  const { releaseEvidence, ReleaseEvidenceContract } = await import('@jevris/contracts');
  const envelope = releaseEvidence({ kind: 'api-live-suite', id: 'api-live-suite-test', producedAt: '2026-09-25T00:00:00.000Z', version: '1.2.0', tool: 'jevris-smoke-jev', run: 'mock', payload: JSON.parse(JSON.stringify(record)) });
  assert.equal(ReleaseEvidenceContract.validate(envelope).ok, true, 'the suite record is a valid api-live-suite payload');
});

test('PRV-10: a failed latency call is recorded with its elapsed time, failure, status and reason code, and counted', async () => {
  // Calls 1-3 on the transport: the combined request and the two taxonomy probes. Then 30 latency calls.
  const latency = [];
  for (let i = 0; i < 10; i += 1) latency.push('valid', 'http-500', 'http-429');
  const record = await runLiveSuite({
    transport: createSdkTransport({ apiKey: KEY, fetch: createMockFetch({ scenario: ['valid', 'valid', 'valid', ...latency] }) }),
    badKeyTransport: createSdkTransport({ apiKey: KEY, fetch: createMockFetch({ scenario: 'http-401' }) }),
    cancelTransport: createSdkTransport({ apiKey: KEY, fetch: createMockFetch({ scenario: 'aborted' }) }),
    latencyCalls: 30,
    mode: 'mock',
  });
  assert.equal(record.passed, false, 'a failed latency call fails the suite');
  assert.equal(record.latency.calls, 30);
  assert.equal(record.latency.okCalls, 10);
  assert.equal(record.latency.failedCalls, 20);
  assert.deepEqual(record.latency.reasonCounts, { PROVIDER_ERROR: 20 });
  assert.deepEqual(
    record.latency.samples.map(({ ok, failure, status, reasonCode }) => ({ ok, failure, status, reasonCode })).slice(0, 3),
    [
      { ok: true, failure: null, status: null, reasonCode: null },
      { ok: false, failure: 'server', status: 500, reasonCode: 'PROVIDER_ERROR' },
      { ok: false, failure: 'rate-limited', status: 429, reasonCode: 'PROVIDER_ERROR' },
    ],
  );
  assert.ok(record.latency.samples.every((sample) => Number.isInteger(sample.elapsedMs)));
  const text = JSON.stringify(record);
  assert.equal(text.includes(KEY), false);
  assert.equal(/server error|rate limited/.test(text), false, 'no response body text in the record');
  const { releaseEvidence, ReleaseEvidenceContract } = await import('@jevris/contracts');
  const envelope = releaseEvidence({ kind: 'api-live-suite', id: 'api-live-suite-failed', producedAt: '2026-09-25T00:00:00.000Z', version: '1.2.0', tool: 'jevris-smoke-jev', run: 'mock', payload: JSON.parse(JSON.stringify(record)) });
  assert.equal(ReleaseEvidenceContract.validate(envelope).ok, true, 'a failed run still makes a valid, diagnosable record');
});

test('PRV-10: a call slower than the hot budget is measured, not cut off, and counted outside the budget; the suite still passes', async () => {
  // Every third latency call answers after 120 ms; a 50 ms comparison budget stands in for 900 ms.
  const latency = [];
  for (let i = 0; i < 10; i += 1) latency.push('valid', 'valid', 'late');
  const record = await runLiveSuite({
    transport: createSdkTransport({ apiKey: KEY, fetch: createMockFetch({ scenario: ['valid', 'valid', 'valid', ...latency], lateMs: 120 }) }),
    badKeyTransport: createSdkTransport({ apiKey: KEY, fetch: createMockFetch({ scenario: 'http-401' }) }),
    cancelTransport: createSdkTransport({ apiKey: KEY, fetch: createMockFetch({ scenario: 'aborted' }) }),
    latencyCalls: 30,
    hotBudgetMs: 50,
    mode: 'mock',
  });
  assert.equal(record.latency.okCalls, 30, 'no slow call became a DEADLINE');
  assert.deepEqual(record.latency.reasonCounts, {});
  assert.ok(record.latency.maxMs >= 120, `the slow tail is in the distribution (max ${record.latency.maxMs} ms)`);
  assert.ok(record.latency.withinBudget <= 20, `${record.latency.withinBudget} calls within the 50 ms budget`);
  assert.equal(record.latency.withinBudgetFraction, Math.round((record.latency.withinBudget / 30) * 1000) / 1000);
  assert.equal(record.latency.budgetMs, 50);
  assert.equal(record.passed, true, 'the §17.4 targets are recorded, not a pass bar');
});

test('PRV-10: an error probe gets the measuring timeout, so a 401 slower than 900 ms is still a 401', async () => {
  const slow401 = createMockFetch({ scenario: 'http-401' });
  const slowFetch = async (input, init) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return slow401(input, init);
  };
  const record = await runLiveSuite({
    transport: createSdkTransport({ apiKey: KEY, fetch: createMockFetch() }),
    badKeyTransport: createSdkTransport({ apiKey: KEY, fetch: slowFetch }),
    cancelTransport: createSdkTransport({ apiKey: KEY, fetch: createMockFetch({ scenario: 'aborted' }) }),
    latencyCalls: 30,
    mode: 'mock',
  });
  const key = record.errors.find((e) => e.probe === 'invalid-key');
  assert.equal(key.reasonCode, 'PROVIDER_DISABLED');
  assert.equal(key.status, 401);
  assert.equal(key.matched, true);
  assert.ok(key.elapsedMs >= 900, `measured past the hot budget (${key.elapsedMs} ms)`);
  assert.equal(record.passed, true);
});

test('PRV-10: a probe that times out is recorded as not matching its expected code, and fails the suite', async () => {
  const record = await runLiveSuite({
    transport: createSdkTransport({ apiKey: KEY, fetch: createMockFetch() }),
    badKeyTransport: createSdkTransport({ apiKey: KEY, fetch: createMockFetch({ scenario: 'late-deaf' }) }),
    cancelTransport: createSdkTransport({ apiKey: KEY, fetch: createMockFetch({ scenario: 'aborted' }) }),
    latencyCalls: 30,
    measureTimeoutMs: 200,
    mode: 'mock',
  });
  const key = record.errors.find((e) => e.probe === 'invalid-key');
  assert.equal(key.reasonCode, 'DEADLINE');
  assert.equal(key.expected, 'PROVIDER_DISABLED');
  assert.equal(key.matched, false);
  assert.equal(record.passed, false);
});
