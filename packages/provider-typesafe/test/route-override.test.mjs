import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');
const contracts = await import('@jevris/contracts');
const { createDeadline } = await import('@jevris/platform');
const { createMockFetch, createSidecarEngine, readProviderOverride, providerOverrideDiagnostic, sidecarOps, CONFORMANCE_REQUEST, RULES_ONLY_DIAGNOSTIC } = provider;

const STORED = 'stored-keychain-key-not-for-tests';
const TEST_KEY = 'mock-provider-test-key';

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-route-op-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function env(url, key = TEST_KEY) {
  return { JEVRIS_TEST_PROVIDER_URL: url, ...(key === null ? {} : { JEVRIS_TEST_PROVIDER_KEY: key }) };
}

test('a loopback http override with a test key is honoured; each other form is refused with a reason', () => {
  for (const url of ['http://127.0.0.1:8787', 'http://localhost:9000/', 'http://[::1]:7000']) {
    const override = readProviderOverride(env(url));
    assert.equal(override.active, true, url);
    assert.equal(override.ok, true, url);
    assert.equal(override.apiKey, TEST_KEY);
    assert.match(override.baseURL, /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/);
    assert.match(override.diagnostic, /test provider override active/);
    assert.equal(override.diagnostic.includes(TEST_KEY), false, 'the key is never in the diagnostic');
  }
  const refused = (url, key) => readProviderOverride(env(url, key)).reasonCode;
  assert.equal(refused('https://api.typesafe.ai'), 'PROVIDER_OVERRIDE_NOT_LOOPBACK');
  assert.equal(refused('http://10.0.0.5:8787'), 'PROVIDER_OVERRIDE_NOT_LOOPBACK');
  assert.equal(refused('http://127.0.0.1.evil.example:8787'), 'PROVIDER_OVERRIDE_NOT_LOOPBACK');
  assert.equal(refused('https://127.0.0.1:8787'), 'PROVIDER_OVERRIDE_NOT_HTTP');
  assert.equal(refused('http://127.0.0.1:8787/v1'), 'PROVIDER_OVERRIDE_INVALID_URL');
  assert.equal(refused('http://user:pw@127.0.0.1:8787'), 'PROVIDER_OVERRIDE_INVALID_URL');
  assert.equal(refused('http://127.0.0.1'), 'PROVIDER_OVERRIDE_INVALID_URL');
  assert.equal(refused('not a url'), 'PROVIDER_OVERRIDE_INVALID_URL');
  assert.equal(refused('http://127.0.0.1:8787', null), 'PROVIDER_OVERRIDE_NO_KEY');
  assert.deepEqual(readProviderOverride({}), { active: false });
  assert.equal(providerOverrideDiagnostic({}), null);
  assert.match(providerOverrideDiagnostic(env('http://10.0.0.5:1')), /refused \(PROVIDER_OVERRIDE_NOT_LOOPBACK\)/);
});

function request() {
  const compiled = core.compileDecisionSpec({ id: 'task-profile', version: 'v1', questions: CONFORMANCE_REQUEST.questions, evidenceRequirements: ['e1'], deadlineMs: 60_000, fallback: 'rules-only' }); // A real engine does durable journal writes before it sends, which take seconds on a loaded Windows runner: the deadline is not what this test is about, so it is long.
  return {
    spec: compiled.spec,
    questions: CONFORMANCE_REQUEST.questions,
    workspaceId: 'w-test',
    evidenceRevision: 'rev-1',
    packet: {
      objective: 'Add an optional display label to an existing response',
      trustedPolicy: { compatibilityRequired: true },
      facts: { publicApiChanged: true },
      evidence: [{ id: 'e1', text: 'Existing consumers deserialize this response.', sourceKind: 'file', priority: 'mandatory' }],
    },
  };
}

test('with an override the engine calls the loopback URL with the test key, never the stored credential', async (t) => {
  const home = temp(t);
  const urls = [];
  const auth = [];
  const mock = createMockFetch({ onRequest: (_body, headers) => auth.push(headers.get('authorization')) });
  const fetch = (url, init) => {
    urls.push(String(url));
    return mock(url, init);
  };
  const lines = [];
  const e = await createSidecarEngine({ home, credential: STORED, fetch, env: env('http://127.0.0.1:8787'), log: (line) => lines.push(line) });
  const outcome = await core.decide(request(), e);
  assert.equal(outcome.abstained, false, JSON.stringify(outcome));
  assert.deepEqual(urls, ['http://127.0.0.1:8787/v1/systemone']);
  assert.deepEqual(auth, [`Bearer ${TEST_KEY}`]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /test provider override active/);
  assert.equal(lines.join('\n').includes(STORED), false);
});

test('without an override the engine uses the stored credential against production', async (t) => {
  const home = temp(t);
  const urls = [];
  const auth = [];
  const mock = createMockFetch({ onRequest: (_body, headers) => auth.push(headers.get('authorization')) });
  const fetch = (url, init) => {
    urls.push(String(url));
    return mock(url, init);
  };
  const lines = [];
  const e = await createSidecarEngine({ home, credential: STORED, fetch, env: {}, log: (line) => lines.push(line) });
  const outcome = await core.decide(request(), e);
  assert.equal(outcome.abstained, false);
  assert.deepEqual(urls, ['https://api.typesafe.ai/v1/systemone']);
  assert.deepEqual(auth, [`Bearer ${STORED}`]);
  assert.deepEqual(lines, []);
});

test('a refused override is rules-only: nothing goes to the override or to production', async (t) => {
  const home = temp(t);
  const mock = createMockFetch();
  const lines = [];
  const e = await createSidecarEngine({ home, credential: STORED, fetch: mock, env: env('https://evil.example:443'), log: (line) => lines.push(line) });
  assert.equal(e.providerConfigured, false);
  const outcome = await core.decide(request(), e);
  assert.equal(outcome.reasonCode, 'PROVIDER_NOT_CONFIGURED');
  assert.equal(mock.calls, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /PROVIDER_OVERRIDE_NOT_LOOPBACK/);
  assert.equal(lines.includes(RULES_ONLY_DIAGNOSTIC), false, 'one diagnostic line, not two');
});

function ctx(body, { home, killSwitchStopped = false } = {}) {
  return {
    op: 'route', client: 'cli', scopes: ['status', 'advice'], workspace: { id: 'w-test', root: null }, body, home,
    signal: new AbortController().signal, deadline: createDeadline(900), store: undefined, killSwitchStopped, engine: undefined, trace() {},
  };
}

const route = Object.fromEntries(sidecarOps.map((def) => [def.op, def])).route;

test('RTE-06: the route op answers in the RoutePayload contract, keeps a pin, and never applies', async (t) => {
  const home = temp(t);
  assert.equal(route.scope, 'advice');
  const pinned = await route.handle(ctx({ currentModel: 'claude-opus-5', modelPin: 'claude-opus-5', effortPin: null, taskId: 't1' }, { home }));
  assert.equal(pinned.ok, true, JSON.stringify(pinned));
  assert.equal(contracts.surfacePayloadContract('route').validate(pinned.body).ok, true);
  assert.deepEqual([pinned.body.main.outcome, pinned.body.main.pinState, pinned.body.main.reasonCode, pinned.body.main.recommendedModel], ['keep', 'pinned', 'PIN_RESPECTED', null]);
  assert.equal(pinned.body.applied, false);
  const open = await route.handle(ctx({ currentModel: 'claude-opus-5', modelPin: null, effortPin: null, taskId: null }, { home }));
  assert.equal(contracts.surfacePayloadContract('route').validate(open.body).ok, true);
  assert.deepEqual([open.body.main.outcome, open.body.main.pinState, open.body.main.recommendedModel], ['abstain', 'unpinned', null]);
  assert.deepEqual([open.body.worker.outcome, open.body.worker.reasonCode], ['abstain', 'UNKNOWN_SLICE']);
  const sliced = await route.handle(ctx({ currentModel: null, modelPin: null, effortPin: null, taskId: null, sliceId: 'bounded-edit' }, { home }));
  assert.equal(sliced.body.worker.reasonCode, 'NO_CALIBRATION');
  const stopped = await route.handle(ctx({ currentModel: null, modelPin: null, effortPin: null, taskId: null, sliceId: 'bounded-edit' }, { home, killSwitchStopped: true }));
  assert.equal(stopped.body.worker.reasonCode, 'KILL_SWITCH');
});

test('RTE-06: the route op refuses malformed input and an invalid registry file gives no advice', async (t) => {
  const home = temp(t);
  for (const body of [null, { currentModel: 7 }, { currentModel: 'bad model id' }, { currentModel: null, extra: 1 }]) {
    assert.equal((await route.handle(ctx(body, { home }))).reasonCode, 'INVALID_REQUEST', JSON.stringify(body));
  }
  const file = core.modelRegistryFile(home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ schemaVersion: '1.0', entries: [] }));
  const broken = await route.handle(ctx({ currentModel: 'claude-opus-5', modelPin: null, effortPin: null, taskId: null }, { home }));
  assert.equal(contracts.surfacePayloadContract('route').validate(broken.body).ok, true);
  // The advice names why the placed registry was refused, and never falls back to the bundled one.
  assert.deepEqual([broken.body.main.outcome, broken.body.main.reasonCode, broken.body.worker.reasonCode], ['abstain', 'MODEL_REGISTRY_INVALID', 'MODEL_REGISTRY_INVALID']);
  assert.match(broken.body.main.text, /does not match the registry schema \(MODEL_REGISTRY_INVALID\)/);
  writeFileSync(file, '{ not json');
  const notJson = await route.handle(ctx({ currentModel: 'claude-opus-5', modelPin: null, effortPin: null, taskId: null }, { home }));
  assert.equal(notJson.body.main.reasonCode, 'MODEL_REGISTRY_NOT_JSON');
  writeFileSync(file, Buffer.alloc(core.MODEL_REGISTRY_MAX_BYTES + 1, 32));
  assert.equal((await core.loadModelRegistryChecked({ home })).reasonCode, 'MODEL_REGISTRY_TOO_LARGE');
  rmSync(file);
  assert.equal((await core.loadModelRegistryChecked({ home })).registry, core.BUNDLED_MODEL_REGISTRY, 'no file: the bundled registry');
});
