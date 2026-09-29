import test from 'node:test';
import assert from 'node:assert/strict';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');
const { createDeadline } = await import('@jevris/platform');
const { createSdkTransport, createNativeReferenceTransport, createMockFetch, runConformance, CONFORMANCE_CASES, CONFORMANCE_REQUEST } = provider;

const KEY = 'test-key-not-a-secret';

test('PRV-04: the mock returns reproducible, Jev-shaped answers for all three primitives', async () => {
  const fetch = createMockFetch();
  const client = new core.JevClient({ transport: createSdkTransport({ apiKey: KEY, fetch }) });
  const first = await client.ask({ request: CONFORMANCE_REQUEST, lane: 'interactive', deadline: createDeadline(2000) });
  const second = await client.ask({ request: CONFORMANCE_REQUEST, lane: 'interactive', deadline: createDeadline(2000) });
  assert.equal(first.ok, true);
  assert.deepEqual(first.answers, second.answers);
  assert.equal(first.answers.taskFamily.type, 'choice');
  assert.equal(first.answers.changeRisk.type, 'score');
  assert.equal(first.answers.compatibilityEvidenceMissing.type, 'noul');
  assert.equal(first.model, 'jev-1.13.0');
  assert.ok(first.usage.inputTokens > 0);
  assert.ok(first.elapsedMs >= 0);
  assert.equal(fetch.calls, 2);
});

test('PRV-04/PRV-05/PRV-06: the SDK port and the native reference check give identical outcomes for every fixture', async () => {
  const sdk = await runConformance((fetch) => createSdkTransport({ apiKey: KEY, fetch }));
  const native = await runConformance((fetch) => createNativeReferenceTransport({ apiKey: KEY, fetch }));
  assert.equal(sdk.length, CONFORMANCE_CASES.length);
  for (const outcome of sdk) assert.equal(outcome.passed, true, `sdk ${outcome.scenario}: ${JSON.stringify(outcome)}`);
  for (const outcome of native) assert.equal(outcome.passed, true, `native ${outcome.scenario}: ${JSON.stringify(outcome)}`);
  const strip = (list) => list.map(({ scenario, ok, reasonCode, failure, schemaFailure }) => ({ scenario, ok, reasonCode, failure, schemaFailure }));
  assert.deepEqual(strip(sdk), strip(native));
  const scenarios = new Set(sdk.map((o) => o.scenario));
  for (const required of ['valid', 'invalid-distribution', 'late', 'late-body', 'late-deaf', 'http-401', 'http-422', 'http-429', 'http-529', 'aborted', 'oversize']) assert.ok(scenarios.has(required), required);
});

test('PRV-05: the SDK port posts to the API root with a bearer key, no retries and no logging', async () => {
  const seen = [];
  const fetch = createMockFetch({ scenario: 'http-429', onRequest: (body, headers) => seen.push({ body, auth: headers.get('authorization') }) });
  const transport = createSdkTransport({ apiKey: KEY, fetch });
  const logged = [];
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const name of Object.keys(original)) console[name] = (...args) => logged.push(args);
  let result;
  try {
    result = await transport.call(CONFORMANCE_REQUEST, { timeoutMs: 500 });
  } finally {
    Object.assign(console, original);
  }
  assert.equal(result.ok, false);
  assert.equal(result.failure, 'rate-limited');
  assert.equal(result.retryAfterMs, 1000);
  assert.equal(fetch.calls, 1, 'maxRetries is 0');
  assert.equal(seen[0].auth, `Bearer ${KEY}`);
  assert.equal(seen[0].body.model, 'jev-1.13.0');
  assert.equal(logged.length, 0);
  assert.throws(() => createSdkTransport({ apiKey: 'a\nb' }), /PROVIDER_KEY_INVALID/);
  assert.throws(() => createSdkTransport({ apiKey: KEY, baseURL: 'https://api.typesafe.ai/v1' }), /PROVIDER_BASE_URL/);
});

test('PRV-05: the per-attempt timeout stays below the remaining budget and cancel aborts the request', async () => {
  const late = createMockFetch({ scenario: 'late', lateMs: 10_000 });
  const sdk = createSdkTransport({ apiKey: KEY, fetch: late });
  const timeouts = [];
  const spy = { route: sdk.route, providerId: sdk.providerId, accountId: sdk.accountId, get calls() { return sdk.calls; }, call: (request, options) => { timeouts.push(options.timeoutMs); return sdk.call(request, options); } };
  const client = new core.JevClient({ transport: spy });
  const started = performance.now();
  const result = await client.ask({ request: CONFORMANCE_REQUEST, lane: 'interactive', deadline: createDeadline(300) });
  const took = performance.now() - started;
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'DEADLINE');
  assert.equal(timeouts.length, 1, 'the hot lane makes one attempt');
  assert.ok(timeouts[0] > 0 && timeouts[0] < 300, `the child timeout (${timeouts[0]} ms) is shorter than the remaining budget`);
  assert.ok(took < 5000, 'hang guard: the 10 s response was not awaited');
  const hang = createMockFetch({ scenario: 'aborted' });
  const controller = new AbortController();
  const pending = new core.JevClient({ transport: createSdkTransport({ apiKey: KEY, fetch: hang }) }).ask({
    request: CONFORMANCE_REQUEST,
    lane: 'interactive',
    deadline: createDeadline(5000),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 10);
  const cancelled = await pending;
  assert.equal(cancelled.reasonCode, 'CANCELLED');
  assert.equal(cancelled.sent, true);
});

test('PRV-03: an over-limit request is repacked once or refused, and is never sent oversize', async () => {
  const fetch = createMockFetch();
  const client = new core.JevClient({ transport: createSdkTransport({ apiKey: KEY, fetch }) });
  const big = { model: 'jev-1.13.0', state: Array.from({ length: 70_000 }, () => '1').join(' '), questions: { q: { type: 'noul', instructions: 'Is it empty?' } } };
  let repacks = 0;
  const refused = await client.ask({ request: big, lane: 'interactive', deadline: createDeadline(2000), repack: () => { repacks += 1; return null; } });
  assert.equal(refused.reasonCode, 'REQUEST_TOO_LARGE');
  assert.equal(repacks, 1);
  assert.equal(fetch.calls, 0);
  const small = { ...big, state: 'short packet' };
  const repacked = await client.ask({ request: big, lane: 'interactive', deadline: createDeadline(2000), repack: () => { repacks += 1; return small; } });
  assert.equal(repacked.ok, true);
  assert.equal(repacked.repacked, true);
  assert.equal(repacks, 2);
  assert.equal(fetch.calls, 1);
  const noRepack = await client.ask({ request: big, lane: 'interactive', deadline: createDeadline(2000) });
  assert.equal(noRepack.reasonCode, 'REQUEST_TOO_LARGE');
  assert.equal(fetch.calls, 1);
});
