import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');
const contracts = await import('@jevris/contracts');
const { createDeadline, jevrisPaths } = await import('@jevris/platform');
const { sidecarOps, createSidecarEngine, calibrationKeysOverride, bundledCalibrationPath, TEST_CALIBRATION_KEYS_ENV, TEST_BUNDLED_CALIBRATION_ENV } = provider;

const ops = Object.fromEntries(sidecarOps.map((def) => [def.op, def]));
const SLICE = 'bounded-edit';
const ACCOUNT = 'acct-route-1';
const KEYS = generateKeyPairSync('ed25519');
const PRIVATE = KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' });
const PUBLIC = KEYS.publicKey.export({ type: 'spki', format: 'pem' });
const KEY_ID = 'calibration-route-test';

const QUALITIES = [
  { modelId: 'claude-opus-5', sliceId: SLICE, lower: 0.9, point: 0.94, upper: 0.97, sampleSize: 60 },
  { modelId: 'claude-sonnet-5', sliceId: SLICE, lower: 0.86, point: 0.9, upper: 0.94, sampleSize: 60 },
];

/**
 * One pinned clock for every route decision in this file: the ops read it from the engine
 * (`engine.now`), the sidecar engine is built with it, and release() signs at it. The real bundled
 * registry's retirement dates then never change a result as the real date moves.
 */
// pinned-clock: release() signs at T by default, and every engine and op here runs at T.
const T = Date.parse('2026-09-26T12:00:00Z');
const CLOCK = { now: () => T };
/** A stand-in engine for the ops: no provider, only the pinned clock (and any recorder given). */
const clocked = (extra = {}) => ({ decide: async () => ({ abstained: true }), lookup: async () => null, now: CLOCK.now, ...extra });

/**
 * The real bundled registry, account-checked for ACCOUNT. These cases were written against an Opus
 * 5.5 baseline (the bundled one until 2026-10-08, when it moved to Sonnet 5.5), so the placed
 * registry keeps it: an administrator's registry names its own baseline. The bundled baseline has its own cases below.
 */
const OPUS_BASELINE = { baselineModelId: 'claude-opus-5-5', harnessDefaults: core.BUNDLED_MODEL_REGISTRY.harnessDefaults.map((row) => (row.harness === 'claude' ? { ...row, baselineModelId: 'claude-opus-5-5' } : row)) };
const CHECKED_REGISTRY = { ...core.BUNDLED_MODEL_REGISTRY, ...OPUS_BASELINE, entries: core.BUNDLED_MODEL_REGISTRY.entries.map((e) => ({ ...e, accountEligibility: [{ accountId: ACCOUNT, eligible: true, checkedAt: '2026-09-22T00:00:00Z' }] })) };

/** A marked test home that trusts KEY_ID for calibration, with the account-checked bundled registry. */
function home(t, { marker = true, registry = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-route-eval-'));
  const previous = process.env[TEST_CALIBRATION_KEYS_ENV];
  t.after(() => {
    if (previous === undefined) delete process.env[TEST_CALIBRATION_KEYS_ENV];
    else process.env[TEST_CALIBRATION_KEYS_ENV] = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const paths = jevrisPaths({ home: dir });
  if (marker) {
    mkdirSync(paths.state, { recursive: true });
    const file = join(paths.state, 'test-home.json');
    writeFileSync(file, JSON.stringify({ schemaVersion: 'jevris-test-home-1' }));
    chmodSync(file, 0o600);
  }
  const keys = join(dir, 'test-keys.json');
  writeFileSync(keys, JSON.stringify({ schemaVersion: 1, keys: [{ keyId: KEY_ID, role: 'calibration', publicKeyPem: PUBLIC }] }));
  process.env[TEST_CALIBRATION_KEYS_ENV] = keys;
  mkdirSync(paths.config, { recursive: true });
  if (registry) writeFileSync(join(paths.config, 'model-registry.json'), JSON.stringify(CHECKED_REGISTRY));
  return dir;
}

// `nowMs` is the clock the release is signed against, T unless a test evaluates at another pinned
// time, so the release is never issued after the test's now.
function release(dir, overrides = {}, file = core.calibrationFileFor(dir), nowMs = T) {
  const context = core.workerCalibrationContext({ sliceId: SLICE, nowMs });
  const unsigned = Object.fromEntries(
    Object.entries({
      id: 'cal-route-test',
      schemaVersion: '1.0',
      releaseState: 'released',
      decisionSpecId: context.decisionSpecId,
      decisionSpecVersion: context.decisionSpecVersion,
      dataset: { id: 'synthetic-routing', version: 'v1', contentHash: `sha256:${'d'.repeat(64)}` },
      questionHash: context.questionHash,
      model: { modelId: context.modelId, revisionHash: context.modelRevisionHash },
      encoderHash: context.encoderHash,
      threshold: { metric: 'noul-probability', value: 0.8, errorBudget: 0.05 },
      permittedSlices: [{ sliceId: SLICE, calibrationSampleSize: 120, holdoutSampleSize: 60 }],
      uncertaintyInterval: { lower: 0.82, upper: 0.93, confidenceLevel: 0.95, method: 'wilson' },
      reviewer: { id: 'reviewer-1', reviewedAt: new Date(nowMs - 2 * 86_400_000).toISOString() },
      issuedAt: new Date(nowMs - 86_400_000).toISOString(),
      expiresAt: new Date(nowMs + 30 * 86_400_000).toISOString(),
      expiryConditions: ['model-revision-changed'],
      modelQualities: QUALITIES,
      ...overrides,
    }).filter(([, value]) => value !== undefined),
  );
  const artifact = contracts.signRecord(unsigned, PRIVATE, KEY_ID);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(artifact));
  return artifact;
}

function ctx(op, body, dir, e = null, workspaceId = 'w-route') {
  return {
    op, client: 'cli', scopes: ['status', 'advice'], workspace: { id: workspaceId, root: null }, body, home: dir,
    signal: new AbortController().signal, deadline: createDeadline(2000), store: undefined, killSwitchStopped: false, engine: e ?? clocked(), trace() {},
  };
}

async function route(dir, body, e = null, workspaceId) {
  const out = await ops.route.handle(ctx('route', body, dir, e, workspaceId));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(contracts.surfacePayloadContract('route').validate(out.body).ok, true, JSON.stringify(out.body));
  return out.body;
}

const BIG = { inputTokens: 2_000_000, outputTokens: 200_000 };

test('RTE-03, C09, C10: without a slice or a release the route op names why and changes nothing', async (t) => {
  const dir = home(t);
  const noSlice = await route(dir, { currentModel: 'claude-opus-5' });
  assert.deepEqual([noSlice.main.outcome, noSlice.main.reasonCode, noSlice.worker.reasonCode], ['abstain', 'UNKNOWN_SLICE', 'UNKNOWN_SLICE']);
  const noReleaseRecords = [];
  const noReleaseRecorder = clocked({ recordAdvice: async (input) => (noReleaseRecords.push(input), { ok: true, decisionId: 'd-none' }) });
  const noRelease = await route(dir, { currentModel: 'claude-opus-5', sliceId: SLICE }, noReleaseRecorder);
  assert.equal(noReleaseRecords[0]?.calibration ?? null, null, 'no release: the record names no calibration');
  assert.deepEqual([noRelease.main.outcome, noRelease.main.reasonCode, noRelease.worker.outcome, noRelease.worker.reasonCode], ['abstain', 'NO_CALIBRATION', 'abstain', 'NO_CALIBRATION']);
  assert.match(noRelease.main.text, /\(NO_CALIBRATION\)/);
  release(dir, { modelQualities: undefined });
  const noQuality = await route(dir, { currentModel: 'claude-opus-5', sliceId: SLICE });
  assert.deepEqual([noQuality.main.reasonCode, noQuality.worker.reasonCode], ['NO_EVALUATED_QUALITY', 'NO_EVALUATED_QUALITY']);
  // RTE-10: the slices asked for that no release covers are listed for status.
  assert.ok(provider.unknownRouteSlices().includes(SLICE));
  release(dir);
  await route(dir, { currentModel: 'claude-opus-5', sliceId: SLICE });
  assert.equal(provider.unknownRouteSlices().includes(SLICE), false, 'covered once the release carries its qualities');
  await route(dir, { currentModel: 'claude-opus-5', sliceId: 'refactor' });
  assert.ok(provider.unknownRouteSlices().includes('refactor'));
  assert.equal(noRelease.applied, false);
});

test('RTE-03, RTE-05, C09, C10, US03, US10: a released calibration with model qualities gives an evaluated selection; the switch guard prices the warm prefix', async (t) => {
  const dir = home(t);
  release(dir);
  const base = { currentModel: 'claude-opus-5', sliceId: SLICE, remaining: BIG };
  // The worker gets the router's choice: a new worker moves no warm cache.
  const unpriced = await route(dir, base);
  assert.deepEqual([unpriced.worker.outcome, unpriced.worker.recommendedModel, unpriced.worker.reasonCode], ['recommend', 'claude-sonnet-5', 'LOWEST_UTILITY_WITHIN_FLOOR']);
  assert.match(unpriced.worker.text, /release cal-route-test/);
  // The session did not report its warm prefix: the switch cannot be priced, so the model stays.
  assert.deepEqual([unpriced.main.outcome, unpriced.main.reasonCode, unpriced.main.recommendedModel], ['keep', 'TRANSITION_COST_UNKNOWN', null]);
  // Owner decision 2026-10-01: the reason names what to supply, in the text and as `needs`.
  assert.match(unpriced.main.text, /pass session\.warmPrefixTokens/);
  assert.deepEqual(unpriced.needs?.length, 1);
  assert.match(unpriced.needs[0], /^session\.warmPrefixTokens/);
  // At a boundary with a cold start the saving clears the minimum benefit: a recommendation, never applied.
  const cold = await route(dir, { ...base, session: { warmPrefixTokens: 0, atBoundary: true } }, null, 'w-route-cold');
  assert.deepEqual([cold.main.outcome, cold.main.recommendedModel, cold.main.reasonCode, cold.main.costBasis], ['recommend', 'claude-sonnet-5', 'LOWEST_UTILITY_WITHIN_FLOOR', 'api-list-price']);
  assert.match(cold.main.text, /Change the model yourself if you agree/);
  // Serving hosts R55: with the harness named, the advice shows the host the session goes through
  // and the one the recommendation would be written through there (kept: the maker's own API).
  const served = await route(dir, { ...base, harness: 'claude', session: { warmPrefixTokens: 0, atBoundary: true } }, null, 'w-route-served');
  assert.deepEqual([served.main.outcome, served.main.recommendedModel], ['recommend', 'claude-sonnet-5']);
  assert.deepEqual(served.main.serving, {
    spelling: 'claude-opus-5', provider: 'anthropic', modelId: 'claude-opus-5', servingHost: 'anthropic', via: 'maker',
    targetSpelling: 'claude-sonnet-5', targetProvider: 'anthropic', targetModelId: 'claude-sonnet-5', targetServingHost: 'anthropic', targetVia: 'maker',
    hostDecision: 'kept', hostReasonCode: null, seenHosts: [], tariffBasis: 'host', tariffSource: null, consent: { host: null, maker: 'signed-in-default' },
  });
  assert.equal(Object.hasOwn(cold.main, 'serving'), false, 'no harness: no host lines');
  assert.equal(cold.applied, false);
  // A large warm prefix on a mid-sized remaining task: moving it costs more than the switch saves.
  const recorded = [];
  const recorder = clocked({ decide: async () => ({ abstained: true, reasonCode: 'UNUSED' }), recordAdvice: async (input) => (recorded.push(input), { ok: true, decisionId: 'd-recorded' }) });
  const warm = await route(dir, { ...base, remaining: { inputTokens: 100_000, outputTokens: 10_000 }, session: { warmPrefixTokens: 150_000, cacheWarm: true } }, recorder, 'w-route-warm');
  assert.deepEqual([warm.main.outcome, warm.main.reasonCode], ['keep', 'BELOW_MINIMUM_BENEFIT']);
  // The recorded main-route decision names the release it rests on, so explain reports it.
  assert.deepEqual([recorded.length, recorded[0]?.specId, recorded[0]?.calibration], [1, 'main-route', { id: 'cal-route-test', version: 'v1' }]);
  assert.match(warm.main.text, /^Keep Opus 5\. .*Transition cost \$0\.\d{4} \(warm prefix moved to the new model\)/);
  // Mid-step: never.
  const midStep = await route(dir, { ...base, session: { warmPrefixTokens: 0, atBoundary: false } }, null, 'w-route-mid');
  assert.equal(midStep.main.reasonCode, 'NOT_AT_BOUNDARY');
  // A pin is kept whatever the evidence says.
  const pinned = await route(dir, { ...base, modelPin: 'claude-opus-5', session: { warmPrefixTokens: 0 } }, null, 'w-route-pin');
  assert.deepEqual([pinned.main.outcome, pinned.main.reasonCode, pinned.worker.recommendedModel, pinned.worker.reasonCode], ['keep', 'PIN_RESPECTED', 'claude-opus-5', 'MODEL_PINNED']);
  // Malformed facts are refused, not guessed.
  for (const bad of [{ remaining: { inputTokens: -1, outputTokens: 1 } }, { session: { cacheWarm: true } }, { session: { warmPrefixTokens: 1, extra: 1 } }, { contextTokens: 'x' }]) {
    assert.equal((await ops.route.handle(ctx('route', { ...base, ...bad }, dir))).reasonCode, 'INVALID_REQUEST', JSON.stringify(bad));
  }
});

test('RTE-01, RTE-05, US10: a zero-data-retention workspace is never routed to Fable 5.1; a 1-hour cache prices the switch at the 1-hour write', async (t) => {
  const dir = home(t);
  release(dir, { modelQualities: [...QUALITIES, { modelId: 'claude-fable-5-1', sliceId: SLICE, lower: 0.97, point: 0.99, upper: 1, sampleSize: 60 }] });
  const input = { role: 'worker', home: dir, registry: CHECKED_REGISTRY, trustedKeys: new Map([[KEY_ID, PUBLIC]]), killSwitchStopped: false, sliceId: SLICE, currentModel: null, pins: { modelPin: null, effortPin: null }, volume: BIG, nowMs: T };
  const run = async () => (await core.evaluateRoute(input)).selection;
  const standard = await run();
  assert.equal(standard.eliminated.some((e) => e.modelId === 'claude-fable-5-1' && e.gate === 'data-retention'), false);
  assert.ok(standard.scored.some((c) => c.modelId === 'claude-fable-5-1'), 'a standard workspace scores Fable 5.1');
  writeFileSync(core.routingPolicyFile(dir), JSON.stringify({ schemaVersion: '1.0', zeroDataRetention: true }));
  const zdr = await run();
  assert.deepEqual(zdr.eliminated.find((e) => e.modelId === 'claude-fable-5-1'), { modelId: 'claude-fable-5-1', gate: 'data-retention' });
  assert.notEqual(zdr.modelId, 'claude-fable-5-1');
  writeFileSync(core.routingPolicyFile(dir), JSON.stringify({ schemaVersion: '1.0', zeroDataRetention: 'yes' }));
  assert.equal((await core.evaluateRoute(input)).reasonCode, 'ROUTING_POLICY_INVALID');
  rmSync(core.routingPolicyFile(dir));
  // The same warm switch, Opus 5 to Sonnet 5 with 150K warm tokens: 5-minute write $0.30, 1-hour write $0.525.
  const base = { currentModel: 'claude-opus-5', sliceId: SLICE, remaining: { inputTokens: 100_000, outputTokens: 10_000 } };
  const fiveMinute = await route(dir, { ...base, session: { warmPrefixTokens: 150_000, cacheWarm: true } }, null, 'w-ttl-5m');
  const oneHour = await route(dir, { ...base, session: { warmPrefixTokens: 150_000, cacheWarm: true, cacheTtl: '1h' } }, null, 'w-ttl-1h');
  assert.match(fiveMinute.main.text, /Transition cost \$0\.3000/);
  assert.match(oneHour.main.text, /Transition cost \$0\.5250/);
  // The session's billing mode labels the figure: a subscription pays in usage, not dollars.
  const subscription = await route(dir, { ...base, session: { warmPrefixTokens: 150_000, cacheWarm: true, cacheTtl: '1h', authMode: 'subscription' } }, null, 'w-ttl-sub');
  assert.match(subscription.main.text, /Transition cost \$0\.5250 \(warm prefix moved to the new model\), an API-equivalent estimate \(a subscription has no per-token charge/);
  assert.equal(subscription.main.authMode, 'subscription', 'the auth mode is echoed for the cost-basis line');
  assert.equal(fiveMinute.main.authMode, undefined);
  assert.equal((await ops.route.handle(ctx('route', { ...base, session: { warmPrefixTokens: 1, authMode: 'oauth' } }, dir))).reasonCode, 'INVALID_REQUEST');
  assert.equal((await ops.route.handle(ctx('route', { ...base, session: { warmPrefixTokens: 1, cacheTtl: '2h' } }, dir))).reasonCode, 'INVALID_REQUEST');
});

test('RTE-01: on the real bundled registry, a passed "not sooner than" date only warns and the model still routes; a firm retiresOn refuses it from that day', async (t) => {
  const dir = home(t);
  // pinned-clock: the release is signed at the earlier date and valid for 30 days, covering both evaluations.
  const before = Date.parse('2027-06-29T00:00:00Z');
  // pinned-clock: evaluateRoute runs here, two days after the release was signed.
  const nowMs = Date.parse('2027-07-01T00:00:00Z');
  release(dir, {}, core.calibrationFileFor(dir), before);
  const sonnet = CHECKED_REGISTRY.entries.find((e) => e.modelId === 'claude-sonnet-5');
  assert.deepEqual([sonnet.lifecycle.retirementNotBefore, sonnet.lifecycle.retiresOn], ['2027-06-30T00:00:00Z', null], 'the bundled registry dates Sonnet 5 "not sooner than" 2027-06-30');
  const input = { role: 'worker', home: dir, registry: CHECKED_REGISTRY, trustedKeys: new Map([[KEY_ID, PUBLIC]]), killSwitchStopped: false, sliceId: SLICE, currentModel: null, pins: { modelPin: null, effortPin: null }, volume: BIG, nowMs };
  // Paired: past its "not sooner than" date Sonnet 5 still routes, with MODEL_RETIREMENT_DUE (DOMAINS 9d1e7eb).
  const due = await core.evaluateRoute(input);
  assert.ok(due.selection, JSON.stringify(due));
  assert.equal(due.selection.eliminated.some((e) => e.modelId === 'claude-sonnet-5'), false);
  assert.equal(due.selection.modelId, 'claude-sonnet-5');
  assert.deepEqual(due.selection.lifecycleWarnings.find((w) => w.modelId === 'claude-sonnet-5'), { modelId: 'claude-sonnet-5', warning: 'MODEL_RETIREMENT_DUE' });
  // With a firm retiresOn of 2027-07-01 the vendor has retired it: refused from that day, routed the day before.
  const firm = { ...CHECKED_REGISTRY, entries: CHECKED_REGISTRY.entries.map((e) => (e.modelId === 'claude-sonnet-5' ? { ...e, lifecycle: { ...e.lifecycle, retiresOn: '2027-07-01T00:00:00Z' } } : e)) };
  const after = (await core.evaluateRoute({ ...input, registry: firm })).selection;
  assert.deepEqual(after.eliminated.find((e) => e.modelId === 'claude-sonnet-5'), { modelId: 'claude-sonnet-5', gate: 'lifecycle' });
  assert.notEqual(after.modelId, 'claude-sonnet-5');
  const earlier = (await core.evaluateRoute({ ...input, registry: firm, nowMs: before })).selection;
  assert.equal(earlier.eliminated.some((e) => e.modelId === 'claude-sonnet-5'), false);
});

test('RTE-01 found gone: a model found gone on this machine is never recommended, explored or launched; not accessible stays scoped to its harness and sign-in; a clear restores it', async (t) => {
  const dir = home(t);
  release(dir);
  const SONNET = 'claude-sonnet-5';
  const input = { role: 'worker', home: dir, registry: CHECKED_REGISTRY, trustedKeys: new Map([[KEY_ID, PUBLIC]]), killSwitchStopped: false, sliceId: SLICE, currentModel: null, pins: { modelPin: null, effortPin: null }, volume: BIG, nowMs: T };
  const selected = async () => (await core.evaluateRoute(input)).selection;
  assert.equal((await selected()).modelId, SONNET, 'Sonnet 5 is the choice before anything is found gone');
  // A structured signal (the Claude API's 404 not_found_error) is enough: one entry.
  assert.equal(core.classifyModelUnavailable({ port: 'claude-api', signal: 'http-404-not-found-error' }), 'MODEL_GONE');
  const recorded = await core.recordModelUnavailable({ home: dir, modelId: SONNET, reasonCode: 'MODEL_GONE', port: 'claude-api', authMode: 'api-key', source: 'provider-call', nowMs: T, registry: CHECKED_REGISTRY });
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  const gone = await selected();
  assert.notEqual(gone.modelId, SONNET);
  assert.deepEqual(gone.eliminated.find((e) => e.modelId === SONNET), { modelId: SONNET, gate: 'lifecycle' });
  assert.deepEqual(gone.unavailable, [{ modelId: SONNET, reasonCode: 'MODEL_GONE' }]);
  // The owned-worker route never launches it, on any harness.
  const engine = await createSidecarEngine({ home: dir, credential: null, env: {}, clock: CLOCK });
  const launches = [];
  const launch = async ({ model }) => {
    launches.push(model);
    return { status: 'completed', requestedModel: model, actualModel: model, usage: { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, costUsd: null };
  };
  const request = (mode, taskId, extra = {}) => ({ taskId, workspaceId: 'w-gone', sliceId: SLICE, mode, killSwitchStopped: () => false, launch, volume: BIG, ...extra });
  const auto = await engine.routeManagedWorker(request('bounded-auto', 'task-gone', { harness: 'opencode', authMode: 'subscription' }));
  assert.notEqual(auto.selection?.modelId, SONNET, JSON.stringify(auto));
  assert.equal(launches.includes(SONNET), false, 'a gone model is never launched');
  // The explain, status and doctor line names it and how it comes back.
  const entries = await core.loadModelAvailability(dir, CHECKED_REGISTRY);
  assert.match(core.modelAvailabilityLines(entries)[0], /^claude-sonnet-5 is not recommended: found gone on this machine \(MODEL_GONE/);
  // A refreshed registry (a new snapshot) leaves the entry out; a manual clear removes it.
  assert.deepEqual(await core.loadModelAvailability(dir, { snapshotId: 'anthropic-2099-01-01' }), []);
  assert.deepEqual(await core.clearModelAvailability(dir, SONNET), { ok: true, removed: 1 });
  assert.equal((await selected()).modelId, SONNET, 'cleared: routed again');
  // Scope (ii): not accessible from Codex on a subscription narrows only that harness and sign-in.
  await core.recordModelUnavailable({ home: dir, modelId: SONNET, reasonCode: 'MODEL_NOT_ACCESSIBLE', port: 'codex', authMode: 'subscription', source: 'launch', nowMs: T, registry: CHECKED_REGISTRY });
  assert.equal((await selected()).modelId, SONNET, 'the advice path (no harness) is not narrowed');
  const on = async (harness, authMode, taskId) => (await engine.routeManagedWorker(request('observe', taskId, { harness, authMode }))).selection.modelId;
  assert.notEqual(await on('codex', 'subscription', 'task-codex-sub'), SONNET);
  assert.equal(await on('codex', 'api-key', 'task-codex-key'), SONNET);
  assert.equal(await on('claude', 'subscription', 'task-claude-sub'), SONNET);
  assert.equal((await engine.routeManagedWorker(request('observe', 'task-unscoped'))).selection.modelId, SONNET);
});

test('P5: delivered main-route advice is opened for adherence with its decision; advice this session did not follow twice is not repeated, and a new session starts again', async (t) => {
  const dir = home(t);
  release(dir);
  const opened = [];
  const ignored = new Map();
  const adviceAdherence = {
    open: (input) => (opened.push(input), true),
    overrides: (input) => ignored.get(input.sessionId) ?? 0,
  };
  const recorder = clocked({ recordAdvice: async () => ({ ok: true, decisionId: 'd-advice-1' }) });
  const ask = async (sessionId, workspaceId) => {
    const out = await ops.route.handle({ ...ctx('route', { currentModel: 'claude-opus-5', sliceId: SLICE, sessionId, remaining: BIG, session: { warmPrefixTokens: 0, atBoundary: true } }, dir, recorder, workspaceId), adviceAdherence });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(contracts.surfacePayloadContract('route').validate(out.body).ok, true, JSON.stringify(out.body));
    return out.body.main;
  };
  const shown = await ask('sess-a', 'w-p5-a');
  assert.deepEqual([shown.outcome, shown.recommendedModel], ['recommend', 'claude-sonnet-5']);
  assert.deepEqual(opened, [{ decisionId: 'd-advice-1', sessionId: 'sess-a', adviceKind: 'main-route', slice: SLICE, advisedModel: 'claude-sonnet-5', currentModel: 'claude-opus-5', atMs: T }]);
  // Ignored twice in this session (overridden or left unchanged): the advice is not repeated, and nothing new is opened.
  ignored.set('sess-b', 2);
  const quiet = await ask('sess-b', 'w-p5-b');
  assert.deepEqual([quiet.outcome, quiet.recommendedModel, quiet.reasonCode], ['abstain', null, 'ADVICE_NOT_FOLLOWED']);
  assert.match(quiet.text, /does not repeat its advice to switch to claude-sonnet-5 in this session/);
  assert.equal(opened.length, 1);
  // Once is not enough to stop it, and another session starts at 0.
  ignored.set('sess-c', 1);
  assert.equal((await ask('sess-c', 'w-p5-c')).outcome, 'recommend');
  assert.equal((await ask('sess-d', 'w-p5-d')).outcome, 'recommend');
  assert.equal(opened.length, 3);
});

test('account eligibility from local evidence (DOMAINS 3f090fa): on a default install with no placed registry, a model becomes eligible on a harness and sign-in once it ran there or the harness lists it; found gone overrides; an administrator registry wins', async (t) => {
  const dir = home(t, { registry: false });
  release(dir);
  const SONNET = 'claude-sonnet-5';
  const OPUS5 = 'claude-opus-5';
  // The bundled registry with the Opus 5.5 baseline these cases were written against (see OPUS_BASELINE).
  const registry = { ...(await core.loadModelRegistry({ home: dir })), ...OPUS_BASELINE };
  assert.equal(registry.snapshotId, core.BUNDLED_MODEL_REGISTRY.snapshotId, 'the bundled registry: no account checks');
  const evaluate = async (harness, authMode) => (await core.evaluateRoute({ role: 'worker', home: dir, registry, trustedKeys: new Map([[KEY_ID, PUBLIC]]), killSwitchStopped: false, sliceId: SLICE, currentModel: null, pins: { modelPin: null, effortPin: null }, volume: BIG, nowMs: T, harness, authMode })).selection;
  // No evidence: every model fails the account gate, and the baseline stays (fail-closed).
  const none = await evaluate('claude', 'subscription');
  assert.deepEqual([none.outcome, none.reasonCode], ['keep-baseline', 'NO_QUALIFIED_CANDIDATE']);
  // Every model with a region the default policy allows ('global') fails the account gate; the
  // others (xAI, Z.ai, Moonshot, DeepSeek) fail residency first.
  const regionOk = (id) => registry.entries.find((m) => m.modelId === id).regions.includes('global');
  assert.ok(none.eliminated.every((e) => e.gate === (regionOk(e.modelId) ? 'account-eligibility' : 'residency')), JSON.stringify(none.eliminated));
  // Claude Code has no listing: its models become eligible once they have run there, on that sign-in only.
  for (const modelId of [SONNET, OPUS5]) assert.equal(await core.recordModelRun(dir, { harness: 'claude', authMode: 'subscription', modelId, nowMs: T }), true);
  assert.equal((await evaluate('claude', 'subscription')).modelId, SONNET);
  assert.equal((await evaluate('claude', 'api-key')).reasonCode, 'NO_QUALIFIED_CANDIDATE', 'another sign-in has no evidence');
  assert.equal((await evaluate('opencode', 'subscription')).reasonCode, 'NO_QUALIFIED_CANDIDATE', 'another harness has no evidence');
  // A harness listing counts where the registry's harness map gives that harness the provider.
  assert.equal(await core.recordModelListing(dir, { harness: 'opencode', authMode: 'api-key', result: { ok: true, version: '1.4.0', models: [SONNET, OPUS5, 'not a model id'] }, nowMs: T }), true);
  assert.equal(await core.recordModelListing(dir, { harness: 'codex', authMode: 'api-key', result: { ok: true, version: '0.157.1', models: [SONNET, OPUS5] }, nowMs: T }), true);
  assert.equal((await evaluate('opencode', 'api-key')).modelId, SONNET);
  assert.equal((await evaluate('codex', 'api-key')).reasonCode, 'NO_QUALIFIED_CANDIDATE', 'Codex is not mapped to Anthropic: a listing alone is not proof');
  const offer = await core.readModelOffer(dir);
  assert.deepEqual(offer.listings.find((l) => l.harness === 'opencode').models, [SONNET, OPUS5], 'an invalid id is dropped');
  const scope = { harness: 'codex', authMode: 'api-key' };
  const codex = core.modelEligibility({ registry, accountId: null, offer, scope });
  assert.equal(codex.find((e) => e.modelId === SONNET).reasonCode, 'NOT_ON_HARNESS');
  assert.match(core.modelEligibilityLines(codex, scope).find((l) => l.startsWith(SONNET)), /not eligible: the registry's harness map gives codex no access to its provider/);
  // A failed refresh keeps the last listing and records why.
  assert.equal(await core.recordModelListing(dir, { harness: 'opencode', authMode: 'api-key', result: { ok: false, reasonCode: 'LISTING_TIMEOUT' }, nowMs: T + 1000 }), true);
  const kept = (await core.readModelOffer(dir)).listings.find((l) => l.harness === 'opencode');
  assert.deepEqual([kept.models.length, kept.reasonCode, kept.observedAt], [2, 'LISTING_TIMEOUT', new Date(T).toISOString()]);
  // Found gone overrides both kinds of evidence.
  await core.recordModelUnavailable({ home: dir, modelId: SONNET, reasonCode: 'MODEL_NOT_ACCESSIBLE', port: 'opencode', authMode: 'api-key', source: 'launch', nowMs: T, registry });
  assert.notEqual((await evaluate('opencode', 'api-key')).modelId, SONNET);
  assert.equal((await evaluate('claude', 'subscription')).modelId, SONNET, 'not accessible stays scoped to its harness and sign-in');
  // The owned-worker route acts on it: bounded-auto launches Sonnet 5 on Claude Code; without a known harness nothing is eligible.
  const engine = await createSidecarEngine({ home: dir, credential: null, env: {}, clock: CLOCK });
  const launches = [];
  const launch = async ({ model }) => {
    launches.push(model);
    return { status: 'completed', requestedModel: model, actualModel: model, usage: { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, costUsd: null };
  };
  const request = (taskId, extra = {}) => ({ taskId, workspaceId: 'w-eligible', sliceId: SLICE, approvedModelId: 'claude-opus-5-5', mode: 'bounded-auto', killSwitchStopped: () => false, launch, volume: BIG, ...extra });
  const routed = await engine.routeManagedWorker(request('task-claude', { harness: 'claude', authMode: 'subscription' }));
  assert.deepEqual([routed.launched, routed.selection?.modelId], [true, SONNET], JSON.stringify(routed));
  const unknown = await engine.routeManagedWorker(request('task-unknown'));
  assert.equal(unknown.launched, false);
  assert.deepEqual(launches, [SONNET]);
  // An administrator's registry with account checks wins over local evidence.
  const admin = { ...core.BUNDLED_MODEL_REGISTRY, snapshotId: 'admin-2026-09-26', entries: core.BUNDLED_MODEL_REGISTRY.entries.map((e) => ({ ...e, accountEligibility: [{ accountId: ACCOUNT, eligible: e.modelId !== SONNET, checkedAt: '2026-09-22T00:00:00Z' }] })) };
  writeFileSync(join(jevrisPaths({ home: dir }).config, 'model-registry.json'), JSON.stringify(admin));
  const placed = await core.loadModelRegistry({ home: dir });
  const adminPick = (await core.evaluateRoute({ role: 'worker', home: dir, registry: placed, trustedKeys: new Map([[KEY_ID, PUBLIC]]), killSwitchStopped: false, sliceId: SLICE, currentModel: null, pins: { modelPin: null, effortPin: null }, volume: BIG, nowMs: T, harness: 'claude', authMode: 'subscription' })).selection;
  assert.notEqual(adminPick.modelId, SONNET, 'the account check says Sonnet 5 is not eligible, though it ran here');
  assert.deepEqual(adminPick.eliminated.find((e) => e.modelId === SONNET), { modelId: SONNET, gate: 'account-eligibility' });
  assert.equal(core.modelEligibility({ registry: placed, accountId: ACCOUNT, offer, scope }).find((e) => e.modelId === SONNET).reasonCode, 'ACCOUNT_NOT_ELIGIBLE');
});

test('G20: main-route advice is scoped to the harness and sign-in; a current model outside the registry abstains; provider/model and [1m] ids resolve', async (t) => {
  const dir = home(t, { registry: false });
  release(dir);
  const SONNET = 'claude-sonnet-5';
  const OPUS5 = 'claude-opus-5';
  // Local evidence only (a default install): both models ran on Claude Code with a subscription.
  for (const modelId of [SONNET, OPUS5]) assert.equal(await core.recordModelRun(dir, { harness: 'claude', authMode: 'subscription', modelId, nowMs: T }), true);
  let n = 0;
  const ask = async (extra) => route(dir, { currentModel: OPUS5, sliceId: SLICE, remaining: BIG, session: { warmPrefixTokens: 0, atBoundary: true }, ...extra }, null, `w-g20-${(n += 1)}`);
  const recommendation = (body) => [body.main.outcome, body.main.recommendedModel];
  // No harness named: evidence from any harness on this machine counts, as before.
  assert.deepEqual(recommendation(await ask({})), ['recommend', SONNET]);
  assert.deepEqual(recommendation(await ask({ harness: 'claude', authMode: 'subscription' })), ['recommend', SONNET]);
  // MEDIUM 9 (E 7dc96df): the advice names the providers it was limited to. A Claude Code session
  // with no stored consent is signed in to Anthropic only; Kimi and DeepSeek never count.
  assert.deepEqual((await ask({ harness: 'claude', authMode: 'subscription' })).main.consentedProviders, ['anthropic']);
  // Another sign-in or harness has no evidence: nothing is recommended there.
  const apiKey = await ask({ harness: 'claude', authMode: 'api-key' });
  assert.notEqual(apiKey.main.outcome, 'recommend', JSON.stringify(apiKey.main));
  // The session's auth mode scopes when there is no top-level one.
  assert.notEqual((await ask({ harness: 'claude', session: { warmPrefixTokens: 0, authMode: 'api-key' } })).main.outcome, 'recommend');
  // Kilo and OpenCode report provider/model; Claude Code may report the [1m] variant. Both resolve to the registry id.
  const openCode = await ask({ harness: 'opencode', authMode: 'api-key', currentModel: `anthropic/${OPUS5}` });
  assert.deepEqual([openCode.main.currentModel, openCode.main.outcome === 'recommend'], [OPUS5, false], 'OpenCode on an API key has no evidence for Sonnet 5');
  // 8c1f85d, the bare-id signed-in fix: the session's provider is read from its own spelling, so an
  // OpenCode session on anthropic/... counts as signed in to Anthropic.
  assert.deepEqual(openCode.main.consentedProviders, ['anthropic']);
  const oneM = await ask({ harness: 'claude', authMode: 'subscription', currentModel: `${OPUS5}[1m]` });
  assert.deepEqual([oneM.main.currentModel, ...recommendation(oneM)], [OPUS5, 'recommend', SONNET]);
  // Owner decisions 8c1f85d: a gateway id is not the maker's model. Until host support lands it is
  // unregistered on every path, so it gets no advice under Anthropic's name (the bare segment is
  // shown only as the model the session named).
  for (const [harness, gateway] of [['kilocode', `openrouter/anthropic/${OPUS5}`], ['opencode', `openrouter/anthropic/${OPUS5}`], [null, `openrouter/anthropic/${OPUS5}`], ['opencode', `nvidia/${OPUS5}`]]) {
    const nested = await ask({ ...(harness === null ? {} : { harness }), currentModel: gateway });
    assert.deepEqual([nested.main.outcome, nested.main.reasonCode, nested.main.recommendedModel, nested.main.currentModel], ['abstain', 'CURRENT_MODEL_UNREGISTERED', null, OPUS5], `${harness} ${gateway}`);
  }
  // Codex reports a model the registry does not hold: no fallback to the Claude baseline, no advice.
  const codex = await ask({ harness: 'codex', authMode: 'api-key', currentModel: 'gpt-6.1-codex' });
  assert.deepEqual([codex.main.outcome, codex.main.reasonCode, codex.main.recommendedModel, codex.main.currentModel], ['abstain', 'CURRENT_MODEL_UNREGISTERED', null, 'gpt-6.1-codex']);
  assert.match(codex.main.text, /gpt-6\.1-codex: it is not in the model registry/);
  assert.equal(codex.worker.outcome, 'recommend', 'a new worker is still routed: Jevris dispatches it to a harness that runs its provider');
  const google = await ask({ harness: 'antigravity', currentModel: 'google/gemini-4-pro' });
  assert.deepEqual([google.main.reasonCode, google.main.currentModel], ['CURRENT_MODEL_UNREGISTERED', 'gemini-4-pro']);
  // A Codex session with no reported model is never told to switch to a Claude model.
  assert.notEqual((await ask({ harness: 'codex', currentModel: null })).main.outcome, 'recommend');
  // A pin is kept even when the current model is unregistered.
  const pinned = await ask({ harness: 'codex', currentModel: 'gpt-6.1-codex', modelPin: 'openai/gpt-6.1-codex' });
  assert.deepEqual([pinned.main.outcome, pinned.main.reasonCode, pinned.main.modelPin], ['keep', 'PIN_RESPECTED', 'gpt-6.1-codex']);
  // Malformed harness, sign-in or model ids are refused, not guessed.
  const base = { currentModel: OPUS5, sliceId: SLICE };
  for (const bad of [{ harness: 'vscode' }, { authMode: 'oauth' }, { currentModel: 'Anthropic/claude-opus-5' }, { currentModel: 'a/b/c/claude-opus-5' }, { currentModel: 'claude-opus-5[2m]' }]) {
    assert.equal((await ops.route.handle(ctx('route', { ...base, ...bad }, dir))).reasonCode, 'INVALID_REQUEST', JSON.stringify(bad));
  }
});

test('RTE-02, US11: the routing policy restricts before scoring; an invalid policy file abstains', async (t) => {
  const dir = home(t);
  release(dir);
  const policyFile = core.routingPolicyFile(dir);
  writeFileSync(policyFile, JSON.stringify({ schemaVersion: '1.0', managedAllowlist: ['claude-opus-5', 'claude-haiku-4-5-20251001'] }));
  const restricted = await route(dir, { currentModel: 'claude-opus-5', sliceId: SLICE, remaining: BIG, session: { warmPrefixTokens: 0 } });
  assert.notEqual(restricted.worker.recommendedModel, 'claude-sonnet-5');
  assert.equal(restricted.main.recommendedModel, null);
  writeFileSync(policyFile, JSON.stringify({ schemaVersion: '1.0', managedAllowlist: 'all' }));
  const invalid = await route(dir, { currentModel: 'claude-opus-5', sliceId: SLICE });
  assert.deepEqual([invalid.main.reasonCode, invalid.worker.reasonCode], ['ROUTING_POLICY_INVALID', 'ROUTING_POLICY_INVALID']);
  // Without an account eligibility check nothing is eligible, so the baseline stays.
  rmSync(policyFile);
  rmSync(join(jevrisPaths({ home: dir }).config, 'model-registry.json'));
  const unchecked = await route(dir, { currentModel: 'claude-opus-5', sliceId: SLICE, remaining: BIG });
  assert.deepEqual([unchecked.worker.recommendedModel, unchecked.worker.reasonCode], ['claude-sonnet-5-5', 'NO_QUALIFIED_CANDIDATE'], 'the bundled baseline (Sonnet 5.5, Claude Code\'s default since 2026-10-08)');
  // The worker evaluation names no harness for its eligibility, but the baseline is still the asking harness's default (it used to be the registry's, whatever the harness).
  for (const [harness, baseline] of [['claude', 'claude-sonnet-5-5'], ['codex', 'gpt-6.1-sol'], ['antigravity', 'gemini-3.8-flash'], ['opencode', 'claude-sonnet-5-5']]) {
    const asked = await route(dir, { currentModel: 'claude-opus-5', sliceId: SLICE, remaining: BIG, harness, authMode: 'api-key' });
    assert.equal(asked.worker.recommendedModel, baseline, `${harness}: the worker baseline is that harness's default`);
  }
});

test('the test calibration-key override needs JEVRIS_TEST=1 and the test-home marker; otherwise only shipped keys count', async (t) => {
  const marked = home(t);
  assert.equal(calibrationKeysOverride(marked).ok, true);
  assert.match(calibrationKeysOverride(marked).diagnostic, /test calibration keys active/);
  assert.equal(calibrationKeysOverride(marked, { ...process.env, JEVRIS_TEST: '0' }).reasonCode, 'NOT_TEST_MODE');
  assert.equal(calibrationKeysOverride(marked, { ...process.env, [TEST_CALIBRATION_KEYS_ENV]: 'relative.json' }).reasonCode, 'KEYS_NOT_ABSOLUTE');
  assert.deepEqual(calibrationKeysOverride(marked, {}), { active: false });
  const unmarked = home(t, { marker: false });
  assert.equal(calibrationKeysOverride(unmarked).reasonCode, 'NO_TEST_HOME_MARKER');
  release(unmarked);
  const refused = await route(unmarked, { currentModel: 'claude-opus-5', sliceId: SLICE });
  assert.equal(refused.worker.reasonCode, 'CALIBRATION_UNKNOWN_KEY');
});

test('C16 day 1: the package ships the signed baseline; tests never read the real package file, only a named one in a marked test home', async (t) => {
  const dir = home(t);
  const shipped = join(dir, 'package-assets', 'calibration-release.json');
  const previous = process.env[TEST_BUNDLED_CALIBRATION_ENV];
  t.after(() => {
    if (previous === undefined) delete process.env[TEST_BUNDLED_CALIBRATION_ENV];
    else process.env[TEST_BUNDLED_CALIBRATION_ENV] = previous;
  });
  // Outside a test the path is the package's own asset; under JEVRIS_TEST=1 it is never read unless named.
  const real = bundledCalibrationPath(dir, { PATH: '' });
  assert.ok(real !== null && real.endsWith(join('assets', 'calibration', 'calibration-release.json')), real);
  assert.equal(bundledCalibrationPath(dir, { JEVRIS_TEST: '1' }), null);
  assert.equal(bundledCalibrationPath(dir, { JEVRIS_TEST: '1', [TEST_BUNDLED_CALIBRATION_ENV]: shipped }), shipped);
  assert.equal(bundledCalibrationPath(dir, { JEVRIS_TEST: '1', [TEST_BUNDLED_CALIBRATION_ENV]: 'relative.json' }), null);
  const unmarked = home(t, { marker: false });
  assert.equal(bundledCalibrationPath(unmarked, { JEVRIS_TEST: '1', [TEST_BUNDLED_CALIBRATION_ENV]: shipped }), null);
  // Nothing in either place: status says there is no signed baseline in this package.
  process.env[TEST_BUNDLED_CALIBRATION_ENV] = shipped;
  const none = await ops['calibration.status'].handle(ctx('calibration.status', {}, dir));
  assert.deepEqual([none.body.applies, none.body.reasonCode], [false, 'NO_CALIBRATION']);
  assert.match(none.body.note, /no signed baseline release in this package/);
  // The bundled release alone applies, and routes the worker, with no file in the config folder.
  release(dir, { id: 'cal-bundled' }, shipped);
  const bundled = await ops['calibration.status'].handle(ctx('calibration.status', {}, dir));
  assert.deepEqual([bundled.body.applies, bundled.body.source, bundled.body.artifacts[0].id], [true, 'bundled', 'cal-bundled']);
  assert.match(bundled.body.note, /signed baseline release in this package applies/);
  const routed = await route(dir, { currentModel: 'claude-opus-5', sliceId: SLICE });
  assert.notEqual(routed.worker.reasonCode, 'NO_CALIBRATION', JSON.stringify(routed.worker));
  // The config folder's release overrides it.
  release(dir, { id: 'cal-config' });
  const config = await ops['calibration.status'].handle(ctx('calibration.status', {}, dir));
  assert.deepEqual([config.body.source, config.body.artifacts[0].id], ['config', 'cal-config']);
});

test('C16 no baseline (1.2): a fresh workspace with no release still learns from its first route; explain shows cost and time per verified task against the default', async (t) => {
  const dir = home(t);
  const engine = await createSidecarEngine({ home: dir, credential: null, env: {}, clock: CLOCK });
  const launches = [];
  const launch = async ({ model }) => {
    launches.push(model);
    return { status: 'completed', requestedModel: model, actualModel: model, usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, costUsd: null };
  };
  const routed = await engine.routeManagedWorker({ taskId: 'task-1', workspaceId: 'w-fresh', sliceId: SLICE, mode: 'bounded-auto', killSwitchStopped: () => false, launch, risk: 'low' });
  // The route carries a learning note, so its outcome is recorded: advice only, the default unless it explored.
  assert.equal(routed.learning.sliceMode, 'advise');
  assert.equal(routed.learning.policyVersion, 0);
  const x = routed.learning.exploration;
  if (x.explored) assert.deepEqual([routed.launched, launches.length], [true, 1]);
  else assert.deepEqual([routed.launched, routed.reasonCode, x.modelId, x.effort, x.reasonCode, launches.length], [false, 'CALIBRATION_NO_RELEASE', 'claude-opus-5-5', null, 'DEFAULT', 0]);
  // Outcomes on the default: explain's trace carries the cost and wall time per verified task against it.
  for (const [i, kind] of ['verified-pass', 'verified-pass', 'verified-fail'].entries()) {
    const r = await core.learnFromOutcome({ home: dir, workspaceId: 'w-fresh', baselineModelId: 'claude-opus-5-5', eligibleModelIds: ['claude-opus-5-5'], now: '2026-09-26T01:00:00Z', event: { eventId: `ev-${i}`, routeId: `route-${i}`, sliceId: SLICE, modelId: 'claude-opus-5-5', rulesModelId: null, policyVersion: 0, kind, labelSource: 'verification-receipt', receiptId: `rc-${i}`, explored: false, propensity: 0.95, risk: 'low', costMicroUsd: 1_000_000, latencyMs: 120_000, at: `2026-09-26T00:0${i}:00Z`, authMode: 'api-key' } });
    assert.equal(r.recorded, true);
  }
  // The route op records its (abstaining) advice as a decision; explain it with the slice.
  const recorded = [];
  const recorder = new Proxy(engine, { get: (target, key) => (key === 'recordAdvice' ? async (input) => { const r = await target.recordAdvice(input); recorded.push(r); return r; } : Reflect.get(target, key)) });
  await route(dir, { currentModel: 'claude-opus-5-5', sliceId: SLICE }, recorder, 'w-fresh');
  assert.equal(recorded[0]?.ok, true, JSON.stringify(recorded));
  const explained = await ops.explain.handle(ctx('explain', { decisionId: recorded[0].decisionId, sliceId: SLICE }, dir, engine, 'w-fresh'));
  assert.ok(explained.body, JSON.stringify(explained));
  assert.ok(explained.body.trace.learning.lines.includes('Per verified task claude-opus-5-5: $1.5000 billed, 3.0 min wall time, 2 verified over 3 routes (the default).'), JSON.stringify(explained.body.trace.learning.lines));
});

test('RTE-04: calibration.status reports the installed release and whether it applies', async (t) => {
  const dir = home(t);
  const idle = await ops['cost.report'].handle(ctx('cost.report', {}, dir, await createSidecarEngine({ home: dir, credential: null, env: {}, clock: CLOCK })));
  assert.equal(idle.body.billing.apiEquivalentEstimate, 'unmeasured');
  const none = await ops['calibration.status'].handle(ctx('calibration.status', {}, dir));
  assert.deepEqual([none.body.applies, none.body.reasonCode], [false, 'NO_CALIBRATION']);
  release(dir);
  const all = await ops['calibration.status'].handle(ctx('calibration.status', {}, dir));
  assert.deepEqual([all.body.applies, all.body.reasonCode, all.body.artifacts[0].id, all.body.artifacts[0].modelQualities], [true, 'CALIBRATION_APPLIES', 'cal-route-test', 2]);
  const other = await ops['calibration.status'].handle(ctx('calibration.status', { sliceId: 'refactor' }, dir));
  assert.deepEqual([other.body.applies, other.body.reasonCode], [false, 'CALIBRATION_SLICE_NOT_PERMITTED']);
  assert.equal((await ops['calibration.status'].handle(ctx('calibration.status', { sliceId: 'bad id' }, dir))).reasonCode, 'INVALID_REQUEST');
});

test('RTE-12: engine.routeManagedWorker records the counterfactual in observe mode and launches the selection in bounded-auto', async (t) => {
  const dir = home(t);
  release(dir);
  const engine = await createSidecarEngine({ home: dir, credential: null, env: {}, clock: CLOCK });
  assert.equal(typeof engine.routeManagedWorker, 'function');
  // The engine's clock is the one it was built with; its route and the ops read the time from it.
  assert.equal(engine.now(), T);
  // B's sidecar wraps the engine in a Proxy whose get returns wrapped methods; the property must allow that.
  const mirrored = new Proxy(engine, { get: (target, key) => { const value = Reflect.get(target, key); return typeof value === 'function' ? (...args) => value.apply(target, args) : value; } });
  assert.equal(typeof mirrored.routeManagedWorker, 'function');
  // C66: signed calibration-authority records (a learned-router review) are checked against the home's trusted keys.
  // The shipped trust store may already list real calibration keys; the test key is added beside them.
  const trusted = await mirrored.calibrationKeys();
  assert.equal(trusted.get(KEY_ID), PUBLIC);
  const launches = [];
  const launch = async ({ model, maxBudgetUsd, reservationId }) => {
    launches.push({ model, maxBudgetUsd, reservationId });
    return { status: 'completed', requestedModel: model, actualModel: model, usage: { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, costUsd: null };
  };
  const request = (mode, taskId, extra = {}) => ({ taskId, workspaceId: 'w-route', sliceId: SLICE, mode, killSwitchStopped: () => false, launch, volume: BIG, ...extra });
  const observed = await engine.routeManagedWorker(request('observe', 'task-observe'));
  assert.deepEqual([observed.launched, observed.reasonCode, observed.selection.modelId], [false, 'OBSERVE_MODE', 'claude-sonnet-5']);
  const record = await engine.lookup(observed.decisionId);
  assert.deepEqual(record.proposedAction, { kind: 'route-worker', taskId: 'task-observe', modelId: 'claude-sonnet-5', profileId: 'managed-worker' });
  assert.deepEqual(launches, []);
  const auto = await engine.routeManagedWorker(request('bounded-auto', 'task-auto'));
  assert.equal(auto.launched, true, JSON.stringify(auto));
  assert.deepEqual(launches.map((l) => l.model), ['claude-sonnet-5']);
  assert.ok(auto.settledMicroUsd > 0);
  // EVL-08: the settled owned-worker usage is the API list-price equivalent in cost.report; never a saving.
  const cost = await ops['cost.report'].handle(ctx('cost.report', {}, dir, engine));
  assert.deepEqual([cost.body.billing.apiEquivalentEstimate, cost.body.billing.counterfactualHypothetical, cost.body.billing.savingMicroUsd], [auto.settledMicroUsd, 'hypothetical', null]);
  // The task's own model list bounds the choice.
  const bounded = await engine.routeManagedWorker(request('observe', 'task-bounded', { eligibleModels: ['claude-opus-5'] }));
  assert.notEqual(bounded.selection.modelId, 'claude-sonnet-5');
  const unsliced = await engine.routeManagedWorker(request('bounded-auto', 'task-x', { sliceId: null }));
  assert.deepEqual([unsliced.launched, unsliced.reasonCode], [false, 'UNKNOWN_SLICE']);
  const stopped = await engine.routeManagedWorker(request('bounded-auto', 'task-y', { killSwitchStopped: () => true }));
  assert.deepEqual([stopped.launched, stopped.reasonCode], [false, 'KILL_SWITCH']);
  assert.equal(launches.length, 1);
  // C16: explain with a slice says how route learning stands there; nothing learned is advice only.
  const plainExplain = await ops.explain.handle(ctx('explain', { decisionId: observed.decisionId }, dir, engine));
  assert.equal(plainExplain.body.trace.learning, undefined);
  const noState = await ops.explain.handle(ctx('explain', { decisionId: observed.decisionId, sliceId: SLICE }, dir, engine));
  // The account-checked registry decides eligibility, and explain says so (DOMAINS 3f090fa).
  assert.deepEqual(noState.body.trace.learning, { sliceId: SLICE, mode: 'advise', version: 0, lines: ['advice only; no local outcomes yet', "Account eligibility comes from the administrator's registry account checks; local evidence is not used."] });
  assert.equal((await ops.explain.handle(ctx('explain', { decisionId: observed.decisionId, sliceId: '../x' }, dir, engine))).reasonCode, 'INVALID_REQUEST');
  // C16: with the workspace's learning state on disk, the result carries the learning note with the
  // harness's auth mode; a usage-limited model is not launched.
  const state = core.emptyLearningState({ workspaceId: 'w-route', now: '2026-09-26T00:00:00Z' });
  const limitedState = core.recordRouteOutcome(state, { eventId: 'lim-1', routeId: 'gen-task-old', sliceId: SLICE, modelId: 'claude-sonnet-5', rulesModelId: null, policyVersion: 0, kind: 'usage-limited', labelSource: 'harness-limit', receiptId: null, explored: false, propensity: null, risk: 'unknown', costMicroUsd: null, latencyMs: null, at: new Date(T - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'), limitResetAt: new Date(T + 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'), authMode: 'subscription' });
  assert.equal(limitedState.ok, true);
  assert.deepEqual(await core.saveLearningState(dir, limitedState.state), { ok: true });
  const learned = await engine.routeManagedWorker(request('bounded-auto', 'task-learn', { authMode: 'subscription', risk: 'high' }));
  assert.equal(learned.launched, false);
  assert.equal(learned.reasonCode, 'MODEL_USAGE_LIMITED');
  assert.equal(learned.learning.authMode, 'subscription');
  assert.equal(learned.learning.usageLimit.modelId, 'claude-sonnet-5');
  const withState = await ops.explain.handle(ctx('explain', { decisionId: observed.decisionId, sliceId: SLICE }, dir, engine));
  assert.equal(withState.body.trace.learning.mode, 'advise');
  assert.match(withState.body.trace.learning.lines.join('\n'), /1 usage-limit hits/);
  assert.equal(launches.length, 1);
});

test('C16 baseline release: a signed beta-posterior baseline shapes the posterior, but a low-risk slice switches only once both arms have local outcomes; high risk keeps the baseline', async (t) => {
  const dir = home(t);
  // The baseline: Opus 5.5 (the registry baseline) at 68% and Sonnet 5 at 80%, 30 outcomes each.
  release(dir, {
    id: 'cal-baseline-day1',
    uncertaintyInterval: { lower: 0.6, upper: 0.85, confidenceLevel: 0.9, method: 'beta-posterior' },
    modelQualities: [
      { modelId: 'claude-opus-5-5', effort: 'medium', sliceId: SLICE, lower: 0.54, point: 0.68, upper: 0.8, sampleSize: 30 },
      { modelId: 'claude-sonnet-5', effort: 'high', sliceId: SLICE, lower: 0.67, point: 0.8, upper: 0.9, sampleSize: 30 },
      // An effort arm of the baseline model (C16 1fc41b9), not supported here: the prior is behind.
      { modelId: 'claude-opus-5-5', effort: 'low', sliceId: SLICE, lower: 0.4, point: 0.55, upper: 0.7, sampleSize: 12 },
    ],
    // The holdout report (§18.3 as amended): the seed arms each quality is built from.
    baselineSources: [
      ['claude-opus-5-5', 'medium', 20, 30],
      ['claude-sonnet-5', 'high', 24, 30],
      ['claude-opus-5-5', 'low', 7, 12],
    ].map(([modelId, effort, successes, trials]) => ({
      kind: 'seed',
      sourceId: 'seed-test',
      priorSliceId: 'issue-fix',
      sliceId: SLICE,
      modelId,
      effort,
      successes,
      trials,
      benchmark: 'synthetic seed',
      url: 'https://example.invalid/seed',
      publishedOn: '2026-09-26',
      fetchedOn: '2026-09-26',
      selectionHash: `sha256:${'a'.repeat(64)}`,
      runsHash: `sha256:${'b'.repeat(64)}`,
    })),
  });
  const engine = await createSidecarEngine({ home: dir, credential: null, env: {}, clock: CLOCK });
  const launches = [];
  const launch = async ({ model }) => {
    launches.push(model);
    return { status: 'completed', requestedModel: model, actualModel: model, usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, costUsd: null };
  };
  const request = (taskId, risk) => ({ taskId, workspaceId: 'w-day1', sliceId: SLICE, mode: 'bounded-auto', killSwitchStopped: () => false, launch, risk });
  assert.equal(await core.loadLearningState({ home: dir, workspaceId: 'w-day1' }), null, 'no local state before the first route');
  const high = await engine.routeManagedWorker(request('task-high', 'high'));
  assert.deepEqual([high.launched, launches], [false, []]);
  // The baseline supports Sonnet 5, but no switch without local outcomes (DOMAINS 223a21f): the slice
  // stays advise-only; a route launches only when it explores (10% while advise-only).
  const first = await engine.routeManagedWorker(request('task-first', 'low'));
  assert.equal(first.learning.sliceMode, 'advise');
  assert.equal(first.launched, first.learning.exploration.explored, JSON.stringify(first));
  const snapshot = await core.loadLearningState({ home: dir, workspaceId: 'w-day1' });
  assert.deepEqual(snapshot.versions.map((v) => [v.version, v.reason]), [[0, 'bundled-default']]);
  assert.equal(snapshot.baseline[SLICE].releaseId, 'cal-baseline-day1');
  // The workspace's own randomized outcomes: the locked minimum on each arm.
  let n = 0;
  for (const [modelId, passes, cost] of [['claude-opus-5-5', 8, 2_000_000], ['claude-sonnet-5', 10, 1_000_000]]) {
    for (let i = 0; i < core.MIN_LOCAL_PER_ARM; i += 1) {
      n += 1;
      const r = await core.learnFromOutcome({ home: dir, workspaceId: 'w-day1', baselineModelId: 'claude-opus-5-5', eligibleModelIds: ['claude-opus-5-5', 'claude-sonnet-5'], now: '2026-09-26T02:00:00Z', registry: core.BUNDLED_MODEL_REGISTRY, event: { eventId: `lo-${n}`, routeId: `lr-${n}`, sliceId: SLICE, modelId, rulesModelId: null, policyVersion: 0, kind: i < passes ? 'verified-pass' : 'verified-fail', labelSource: 'verification-receipt', receiptId: `lc-${n}`, explored: modelId !== 'claude-opus-5-5', propensity: modelId === 'claude-opus-5-5' ? 0.9 : 0.05, risk: 'low', costMicroUsd: cost, latencyMs: 60_000, at: `2026-09-26T01:${String(n).padStart(2, '0')}:00Z`, authMode: 'api-key' } });
      assert.equal(r.recorded, true);
    }
  }
  const low = await engine.routeManagedWorker(request('task-low', 'low'));
  assert.equal(low.learning.sliceMode, 'auto');
  const highLater = await engine.routeManagedWorker(request('task-high-2', 'high'));
  assert.deepEqual([highLater.launched, highLater.reasonCode], [false, 'LEARNING_ADVISE']);
  assert.equal(low.launched, true, JSON.stringify(low));
  // Once switched, the engine explores at 5% with a cryptographic random: an explored route names its model.
  const exploration = low.learning.exploration;
  assert.equal(launches.at(-1), exploration.explored ? exploration.modelId : 'claude-sonnet-5', JSON.stringify(exploration));
  if (!exploration.explored) assert.equal(low.selection.modelId, 'claude-sonnet-5');
  const state = await core.loadLearningState({ home: dir, workspaceId: 'w-day1' });
  assert.deepEqual(state.versions.map((v) => [v.version, v.reason, v.reasonCode]), [[0, 'bundled-default', 'ADVISE_ONLY_DEFAULT'], [1, 'promotion', 'POSTERIOR_NON_INFERIOR']]);
  // explain --slice carries the signed baseline prior and the posterior as numbers, apart from local evidence.
  const recorded = await engine.routeManagedWorker({ ...request('task-observe', 'low'), mode: 'observe' });
  const explained = await ops.explain.handle(ctx('explain', { decisionId: recorded.decisionId, sliceId: SLICE }, dir, engine, 'w-day1'));
  assert.equal(explained.ok, true, JSON.stringify(explained));
  assert.equal(contracts.surfacePayloadContract('explain').validate(explained.body).ok, true, JSON.stringify(explained.body));
  const learning = explained.body.trace.learning;
  assert.deepEqual([learning.mode, learning.version, learning.baseline.releaseId], ['auto', 1, 'cal-baseline-day1']);
  assert.deepEqual(learning.baseline.priors.map((p) => [p.modelId, p.effort ?? null, p.rate, p.pseudoCount, p.sampleSize]), [['claude-opus-5-5', null, 0.68, 30, 30], ['claude-sonnet-5', null, 0.8, 30, 30], ['claude-opus-5-5', 'low', 0.55, 12, 12]]);
  // Two efforts of one model are two arms, told apart by armId and effort.
  assert.deepEqual(learning.posteriors.map((p) => [p.armId, p.modelId, p.effort]), [['claude-opus-5-5', 'claude-opus-5-5', null], ['claude-opus-5-5@low', 'claude-opus-5-5', 'low'], ['claude-sonnet-5', 'claude-sonnet-5', null]]);
  const sonnet = learning.posteriors.find((p) => p.modelId === 'claude-sonnet-5');
  assert.deepEqual(sonnet.local, { successes: 10, failures: 2 });
  assert.ok(sonnet.harmVsBaseline < 0.1);
  // A threshold (wilson) release carries no priors: a fresh workspace gets no learning state from it.
  const other = home(t);
  release(other);
  const engine2 = await createSidecarEngine({ home: other, credential: null, env: {}, clock: CLOCK });
  await engine2.routeManagedWorker({ ...request('task-x', 'low'), workspaceId: 'w-other' });
  assert.equal(await core.loadLearningState({ home: other, workspaceId: 'w-other' }), null);
});

test('P11: an owned-worker route with no reported size reserves for the larger of the default, the slice\'s measured p90 and D\'s measure', async (t) => {
  const dir = home(t);
  release(dir);
  const engine = await createSidecarEngine({ home: dir, credential: null, env: {}, clock: CLOCK });
  const launch = async ({ model }) => ({ status: 'completed', requestedModel: model, actualModel: model, usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, costUsd: null });
  const route = (workspaceId, extra = {}) => engine.routeManagedWorker({ taskId: `task-${workspaceId}`, workspaceId, sliceId: SLICE, mode: 'bounded-auto', killSwitchStopped: () => false, launch, ...extra });
  const plain = await route('wPlain');
  assert.equal(plain.launched, true, JSON.stringify(plain));
  // Twenty routes of this slice used 4.4M tokens each: ten times the default 440k.
  const at = new Date(T - 60_000).toISOString();
  let state = core.emptyLearningState({ workspaceId: 'wBig', now: at });
  for (let i = 0; i < 20; i += 1) {
    const recorded = core.recordRouteOutcome(state, {
      eventId: `ev-${i}`, routeId: `route-${i}`, sliceId: SLICE, modelId: plain.selection.modelId, rulesModelId: plain.selection.modelId, policyVersion: 0,
      kind: 'verified-pass', labelSource: 'verification-receipt', receiptId: `rcpt-${i}`, explored: false, propensity: null, risk: 'low',
      costMicroUsd: null, latencyMs: null, at, tokens: 4_400_000,
    });
    assert.equal(recorded.ok, true, JSON.stringify(recorded));
    state = recorded.state;
  }
  assert.equal((await core.saveLearningState(dir, state)).ok, true);
  const big = await route('wBig');
  assert.equal(big.launched, true, JSON.stringify(big));
  // The same reservation as reporting the p90 (4.4M, in the default's 10:1 split) outright.
  const asReported = await route('wBig', { taskId: 'task-as-reported', volume: { inputTokens: 4_000_000, outputTokens: 400_000 } });
  assert.equal(big.reservedMicroUsd, asReported.reservedMicroUsd);
  assert.ok(big.reservedMicroUsd > plain.reservedMicroUsd * 5, `${big.reservedMicroUsd} vs ${plain.reservedMicroUsd}`);
  // D's per-field measure raises it per field, exactly as if reported; a smaller one changes nothing.
  const d = await route('wD', { taskVolume: { inputTokens: 8_000_000, outputTokens: 30_000, n: 5 } });
  assert.equal(d.reservedMicroUsd, (await route('wD', { taskId: 'task-d-reported', volume: { inputTokens: 8_000_000, outputTokens: 40_000 } })).reservedMicroUsd);
  assert.ok(d.reservedMicroUsd > plain.reservedMicroUsd);
  const small = await route('wSmall', { taskVolume: { inputTokens: 10, outputTokens: 10, n: 5 } });
  assert.equal(small.reservedMicroUsd, plain.reservedMicroUsd);
  // A reported size still wins, as before.
  const reported = await route('wBig', { taskId: 'task-reported', volume: { inputTokens: 400_000, outputTokens: 40_000 } });
  assert.ok(reported.reservedMicroUsd < big.reservedMicroUsd);
});

test('R52: through engine.routeManagedWorker, a worker whose session goes through a pinned host is priced and gated there: an unknown host tariff or an uncertified harness launches nothing; certified with consent it launches; no host is as before', async (t) => {
  const dir = home(t);
  release(dir);
  // Every maker and OpenRouter granted; the other pinned hosts have no row.
  const consent = (party) => (party === 'kilo' || party === 'nvidia' ? { granted: false, reasonCode: 'PROVIDER_CONSENT_MISSING' } : { granted: true, provider: party, textVersion: 'v', grantedAtMs: 1 });
  const engine = await createSidecarEngine({ home: dir, credential: null, env: {}, clock: CLOCK, providerConsent: consent });
  const launches = [];
  const launch = async ({ model }) => {
    launches.push(model);
    return { status: 'completed', requestedModel: model, actualModel: model, usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, costUsd: null };
  };
  const request = (taskId, extra = {}) => ({ taskId, workspaceId: 'w-route', sliceId: SLICE, mode: 'bounded-auto', killSwitchStopped: () => false, launch, volume: BIG, harness: 'opencode', authMode: 'api-key', ...extra });
  const unpriced = await engine.routeManagedWorker(request('task-nvidia', { servingHost: 'nvidia', hostRouteCertified: true }));
  assert.deepEqual([unpriced.launched, unpriced.reasonCode], [false, core.HOST_TARIFF_UNKNOWN], JSON.stringify(unpriced));
  const uncertified = await engine.routeManagedWorker(request('task-uncert', { servingHost: 'openrouter', hostRouteCertified: false }));
  assert.deepEqual([uncertified.launched, uncertified.reasonCode], [false, 'ROUTE_HOST_NOT_CERTIFIED'], JSON.stringify(uncertified));
  const unsaid = await engine.routeManagedWorker(request('task-unsaid', { servingHost: 'openrouter' }));
  assert.deepEqual([unsaid.launched, unsaid.reasonCode], [false, 'ROUTE_HOST_NOT_CERTIFIED'], 'no certification answer is not certified');
  // The engine's consent reader reaches the host gate: OpenRouter revoked refuses the pair.
  const revokedEngine = await createSidecarEngine({ home: dir, credential: null, env: {}, clock: CLOCK, providerConsent: (party) => (party === 'openrouter' ? { granted: false, reasonCode: 'PROVIDER_CONSENT_REVOKED' } : consent(party)) });
  const revoked = await revokedEngine.routeManagedWorker(request('task-revoked', { servingHost: 'openrouter', hostRouteCertified: true }));
  assert.deepEqual([revoked.launched, revoked.reasonCode], [false, 'HOST_CONSENT_REVOKED'], JSON.stringify(revoked));
  assert.deepEqual(launches, [], 'nothing launched through a host that was not priced, certified and consented');
  const through = await engine.routeManagedWorker(request('task-openrouter', { servingHost: 'openrouter', hostRouteCertified: true }));
  assert.equal(through.launched, true, JSON.stringify(through));
  const direct = await engine.routeManagedWorker(request('task-direct'));
  assert.equal(direct.launched, true, JSON.stringify(direct));
  assert.equal(launches.length, 2);
});
