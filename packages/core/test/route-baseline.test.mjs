// OD-3 (SPEC §8.1 amended): a route's baseline is the task's approved model when registered, else
// the harness's default; Sonnet 5.5 is the Claude Code default (it was Opus 5.5 until 2026-10-08). R11 and R30: D's candidateScopes
// leave out a model no harness reaches, and give the signed-in providers of OD-4's default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const core = await import('../dist/index.js');
const { BUNDLED_MODEL_REGISTRY: R, routeBaseline, routeAccessGates, signedInProvidersOf, filterCandidates, routeManagedWorker, explainSliceLearning } = core;

// pinned-clock: the routing time every route here runs at.
const NOW = Date.parse('2026-09-28T00:00:00Z');

test('OD-3: each harness has its baseline; an approved registered model wins; an unregistered one does not', () => {
  assert.equal(routeBaseline(R, 'claude'), 'claude-sonnet-5-5');
  assert.equal(routeBaseline(R, 'codex'), 'gpt-6.1-sol');
  assert.equal(routeBaseline(R, 'antigravity'), 'gemini-3.8-flash');
  assert.equal(routeBaseline(R, 'opencode'), 'claude-sonnet-5-5', 'OpenCode has no default of its own: the registry fallback, used only when the session model is unknown');
  assert.equal(routeBaseline(R, 'kilocode'), 'claude-sonnet-5-5', 'Kilo has no default of its own either');
  assert.equal(routeBaseline(R, null), 'claude-sonnet-5-5');
  // Kilo and OpenCode use the session's own model and provider: a registered non-Anthropic session
  // model is its own baseline, and nothing falls back to the registry's Anthropic one.
  for (const harness of ['opencode', 'kilocode']) {
    assert.equal(routeBaseline(R, harness, 'gpt-6.1-sol'), 'gpt-6.1-sol', `${harness}: a GPT session keeps GPT as its baseline`);
    assert.equal(routeBaseline(R, harness, 'gemini-3.8-flash'), 'gemini-3.8-flash', `${harness}: a Gemini session keeps Gemini as its baseline`);
    assert.equal(routeBaseline(R, harness, 'claude-opus-5-5'), 'claude-opus-5-5', `${harness}: an Opus session is its own baseline`);
    assert.equal(routeBaseline(R, harness, 'not-a-registered-model'), 'claude-sonnet-5-5', `${harness}: an unknown session model falls back to the registry baseline`);
  }
  assert.equal(routeBaseline(R, 'codex', 'gpt-6-luna'), 'gpt-6-luna');
  assert.equal(routeBaseline(R, 'codex', 'gpt-6-sol'), 'gpt-6-sol', 'the superseded GPT-6 Sol is still a registered model a task may approve');
  assert.equal(routeBaseline(R, 'codex', 'gpt-5.2'), 'gpt-6.1-sol', 'a model outside the registry is not a baseline');
  // A default naming no registered model is skipped.
  const broken = { ...R, harnessDefaults: [{ harness: 'codex', baselineModelId: 'gpt-0' }] };
  assert.equal(routeBaseline(broken, 'codex'), 'claude-sonnet-5-5');
});

test('OD-3: an owned worker on Codex reconciles against GPT-6.1 Sol, on Antigravity against Gemini 3.8 Flash, and explain names that default', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'jevris-route-baseline-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const route = (harness, taskId, extra = {}) => routeManagedWorker(
    { taskId, workspaceId: 'w-base', sliceId: 'bounded-edit', mode: 'bounded-auto', risk: 'high', harness, authMode: 'api-key', killSwitchStopped: () => false, launch: async () => { throw new Error('never launched'); }, ...extra },
    { home, trustedKeys: new Map(), bundledCalibration: null, nowMs: () => NOW, random: () => 0.99 },
  );
  const codex = await route('codex', 'task-codex');
  assert.equal(codex.learning?.baselineModelId, 'gpt-6.1-sol', JSON.stringify(codex));
  const agy = await route('antigravity', 'task-agy');
  assert.equal(agy.learning?.baselineModelId, 'gemini-3.8-flash', JSON.stringify(agy));
  const claude = await route('claude', 'task-claude');
  assert.equal(claude.learning?.baselineModelId, 'claude-sonnet-5-5');
  const approved = await route('codex', 'task-approved', { approvedModelId: 'gpt-6-luna' });
  assert.equal(approved.learning?.baselineModelId, 'gpt-6-luna');
  // Explain with no reconciled slice baseline names the harness's default as the default arm.
  const state = core.emptyLearningState({ workspaceId: 'w-none', now: new Date(NOW).toISOString() });
  const lines = (on) => explainSliceLearning(state, 'bounded-edit', [], { registry: R, harness: on }).lines.join('\n');
  assert.match(lines('codex'), /gpt-6\.1-sol/);
  assert.doesNotMatch(lines('codex'), /claude-sonnet-5-5/);
  assert.match(lines('claude'), /claude-sonnet-5-5/);
});

test('R11, R30: a null scope leaves the model out (no-harness); signed-in providers pass consent unless revoked; marked ones need a grant', () => {
  const scopes = {
    'claude-opus-5-5': { harness: 'claude', authMode: 'subscription' },
    'gpt-6-sol': { harness: 'codex', authMode: 'api-key' },
    'gemini-3.8-flash': { harness: 'antigravity', authMode: 'unknown' },
    'kimi-k3': { harness: 'opencode', authMode: 'api-key' },
    'grok-4.7': null,
  };
  assert.deepEqual(signedInProvidersOf(R, scopes), ['anthropic', 'moonshot', 'openai']);
  const gates = routeAccessGates(R, { candidateScopes: scopes }, (p) => (p === 'openai' ? { granted: false, reasonCode: 'PROVIDER_CONSENT_REVOKED' } : { granted: false, reasonCode: 'PROVIDER_CONSENT_MISSING' }));
  assert.deepEqual(gates, { consentedProviders: ['anthropic'], unreachableModels: ['grok-4.7'] });
  const policy = {
    managedAllowlist: null, allowedRegions: ['global', 'cn', 'sg', 'us', 'unspecified', 'eu'], requiredContextTokens: 1, requiredCapabilities: [], pins: { modelPin: null, effortPin: null },
    riskFloorFamilies: null, accountId: null, locallyEligible: R.entries.map((e) => e.modelId), nowMs: NOW, ...gates,
  };
  const gateOf = (id) => filterCandidates(R, policy).eliminated.find((e) => e.modelId === id)?.gate ?? 'eligible';
  assert.equal(gateOf('grok-4.7'), 'no-harness');
  assert.equal(gateOf('claude-opus-5-5'), 'eligible');
  assert.equal(gateOf('gpt-6-sol'), 'provider-consent', 'revoked while signed in');
  assert.equal(gateOf('kimi-k3'), 'provider-consent', 'Kimi needs a grant even while signed in');
  assert.equal(gateOf('gemini-3.8-flash'), 'provider-consent', 'a sign-in the port cannot name is not signed in');
  // With no scopes the request's own consentedProviders pass through; with neither, nothing is set.
  assert.deepEqual(routeAccessGates(R, {}), {});
  assert.deepEqual(routeAccessGates(R, { consentedProviders: ['xai'] }), { consentedProviders: ['xai'] });
});

test('owner decision c065d52: a provider a harness here has run counts as signed in (RAN_HERE); an undetected sign-in alone never does', () => {
  const { ranHereProviders } = core;
  // pinned-clock: when the runs were seen.
  const at = '2026-09-27T00:00:00Z';
  const offer = { listings: [], runs: [{ harness: 'antigravity', authMode: 'unknown', modelId: 'gemini-3.8-flash', firstAt: at, lastAt: at }, { harness: 'opencode', authMode: 'api-key', modelId: 'not-registered', firstAt: at, lastAt: at }] };
  assert.deepEqual(ranHereProviders(R, offer), ['google']);
  assert.deepEqual(ranHereProviders(R, null), []);
  const undetected = { 'gemini-3.8-flash': { harness: 'antigravity', authMode: 'unknown' } };
  assert.deepEqual(signedInProvidersOf(R, undetected), []);
  assert.deepEqual(signedInProvidersOf(R, undetected, offer), ['google']);
  const none = () => ({ granted: false, reasonCode: 'PROVIDER_CONSENT_MISSING' });
  assert.deepEqual(routeAccessGates(R, { candidateScopes: undetected }, none).consentedProviders, []);
  assert.deepEqual(routeAccessGates(R, { candidateScopes: undetected }, none, offer).consentedProviders, ['google']);
  // A task that names its models: the named models' providers and RAN_HERE's.
  assert.deepEqual(routeAccessGates(R, { eligibleModels: ['claude-opus-5-5'] }, none, offer).consentedProviders, ['anthropic', 'google']);
});

test('owner 6460ca9: Antigravity\'s own sign-in may explore a Gemini model; OD-10\'s API-key-only rule is not applied to it', () => {
  // The signed-in default: an Antigravity subscription counts for Google.
  const scopes = { 'gemini-3.8-flash': { harness: 'antigravity', authMode: 'subscription' }, 'gemini-3.7-flash': { harness: 'antigravity', authMode: 'subscription' } };
  const gates = routeAccessGates(R, { candidateScopes: scopes }, () => ({ granted: false, reasonCode: 'PROVIDER_CONSENT_MISSING' }));
  assert.deepEqual(gates.consentedProviders, ['google']);
  const access = R.harnessAccess.find((row) => row.harness === 'antigravity' && row.provider === 'google');
  assert.equal(access.unattendedAllowed, true);
  assert.ok(access.signIns.includes('subscription'));
  // Exploration on the Antigravity baseline tries the other Gemini model (same vendor, no board prior needed).
  const state = core.emptyLearningState({ workspaceId: 'w-agy', now: new Date(NOW).toISOString() });
  const choice = core.explorationChoice({
    state, sliceId: 'bounded-edit', mode: 'bounded-auto', risk: 'low', defaultModelId: routeBaseline(R, 'antigravity'), baselineModelId: routeBaseline(R, 'antigravity'),
    eligibleModelIds: ['gemini-3.8-flash', 'gemini-3.7-flash'], random: () => 0, registry: R, nowMs: NOW,
  });
  assert.equal(choice.explored, true, JSON.stringify(choice));
  assert.equal(choice.modelId.startsWith('gemini-'), true);
});

test('R17: each route baseline learns under its own key; outcomes from Codex and Claude Code never demote each other; a pin holds for every key', async (t) => {
  const { learningSliceKey, baseSliceOf, learnFromOutcome, loadLearningState, slicePolicy, pinSlice, emptyLearningState } = core;
  assert.equal(learningSliceKey('bounded-edit', 'claude-opus-5-5', R), 'bounded-edit', "the registry's own baseline keeps the bare slice");
  assert.equal(learningSliceKey('bounded-edit', 'gpt-6.1-sol', R), 'bounded-edit::gpt-6.1-sol');
  assert.equal(learningSliceKey('bounded-edit::gpt-6.1-sol', 'gemini-3.8-flash', R), 'bounded-edit::gpt-6.1-sol', 'a key is never qualified twice');
  assert.equal(baseSliceOf('bounded-edit::gpt-6.1-sol'), 'bounded-edit');
  assert.equal(baseSliceOf('bounded-edit'), 'bounded-edit');

  const home = mkdtempSync(join(tmpdir(), 'jevris-route-keys-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let seq = 0;
  const outcome = (modelId, baselineModelId) => {
    seq += 1;
    return learnFromOutcome({
      home, workspaceId: 'w-keys', baselineModelId, eligibleModelIds: [baselineModelId], registry: R, now: new Date(NOW).toISOString(),
      event: {
        eventId: `ev-${seq}`, routeId: `route-${seq}`, sliceId: 'bounded-edit', modelId, rulesModelId: modelId, policyVersion: 0, kind: 'verified-pass', labelSource: 'verification-receipt',
        receiptId: `rcpt-${seq}`, explored: false, propensity: 0.95, risk: 'low', costMicroUsd: 1_000_000, latencyMs: 60_000, at: new Date(NOW + seq * 1000).toISOString(),
      },
    });
  };
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await outcome('gpt-6.1-sol', 'gpt-6.1-sol')).recorded, true);
    assert.equal((await outcome('claude-opus-5-5', 'claude-opus-5-5')).recorded, true);
  }
  const state = await loadLearningState({ home, workspaceId: 'w-keys' });
  assert.ok(state.arms['bounded-edit::gpt-6.1-sol']?.['gpt-6.1-sol'] !== undefined, JSON.stringify(Object.keys(state.arms)));
  assert.ok(state.arms['bounded-edit']?.['claude-opus-5-5'] !== undefined);
  assert.equal(state.arms['bounded-edit']?.['gpt-6.1-sol'], undefined, 'Codex outcomes stay out of the Claude Code key');
  const demoted = state.versions.filter((v) => v.reasonCode === 'BASELINE_CHANGED');
  assert.deepEqual(demoted, [], 'alternating baselines never demote');
  // Explain on Codex reads the Codex key.
  const explained = core.explainSliceLearning(state, 'bounded-edit', [], { registry: R, harness: 'codex' });
  assert.match(explained.lines.join('\n'), /gpt-6\.1-sol/);

  // A person's pin on the slice holds under every baseline key.
  const pinned = pinSlice(emptyLearningState({ workspaceId: 'w-pin', now: new Date(NOW).toISOString() }), 'bounded-edit', 'claude-sonnet-5', new Date(NOW).toISOString(), null, R);
  assert.equal(slicePolicy(pinned, 'bounded-edit::gpt-6.1-sol').mode, 'pinned');
  assert.equal(slicePolicy(pinned, 'bounded-edit::gpt-6.1-sol').modelId, 'claude-sonnet-5');
});

test('the Codex baseline moved from GPT-6 Sol to GPT-6.1 Sol: what was learned against GPT-6 Sol stays under its own key and is never read for the new baseline', async (t) => {
  const { learningSliceKey, learnFromOutcome, loadLearningState, saveLearningState, slicePolicy, explainSliceLearning } = core;
  const OLD = 'gpt-6-sol';
  const NEW = 'gpt-6.1-sol';
  assert.equal(routeBaseline(R, 'codex'), NEW);
  const oldKey = learningSliceKey('bounded-edit', OLD, R);
  const newKey = learningSliceKey('bounded-edit', NEW, R);
  assert.deepEqual([oldKey, newKey], ['bounded-edit::gpt-6-sol', 'bounded-edit::gpt-6.1-sol']);

  const home = mkdtempSync(join(tmpdir(), 'jevris-baseline-move-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // Three verified outcomes that a workspace recorded while GPT-6 Sol was Codex's baseline.
  for (let i = 1; i <= 3; i += 1) {
    const done = await learnFromOutcome({
      home, workspaceId: 'w-move', baselineModelId: OLD, eligibleModelIds: [OLD], registry: R, now: new Date(NOW).toISOString(),
      event: {
        eventId: `ev-${i}`, routeId: `route-${i}`, sliceId: 'bounded-edit', modelId: OLD, rulesModelId: OLD, policyVersion: 0, kind: 'verified-pass', labelSource: 'verification-receipt',
        receiptId: `rcpt-${i}`, explored: false, propensity: 0.95, risk: 'low', costMicroUsd: 1_000_000, latencyMs: 60_000, at: new Date(NOW + i * 1000).toISOString(),
      },
    });
    assert.equal(done.recorded, true);
  }
  // ... and a promotion of GPT-6 Luna over GPT-6 Sol, as the old baseline would have earned.
  let state = await loadLearningState({ home, workspaceId: 'w-move' });
  const last = state.versions[state.versions.length - 1];
  const promotion = { version: last.version + 1, parentVersion: last.version, createdAt: new Date(NOW).toISOString(), reason: 'promotion', reasonCode: 'PROMOTED', sliceId: oldKey, slices: { ...last.slices, [oldKey]: { mode: 'auto', modelId: 'gpt-6-luna', baselineModelId: OLD, baselineRate: 0.9 } }, evidence: null };
  assert.equal((await saveLearningState(home, { ...state, versions: [...state.versions, promotion] })).ok, true);
  state = await loadLearningState({ home, workspaceId: 'w-move' });

  // The old key still holds everything; the new key holds nothing, so nothing is reused for GPT-6.1 Sol.
  assert.equal(slicePolicy(state, oldKey).mode, 'auto');
  assert.equal(slicePolicy(state, oldKey).modelId, 'gpt-6-luna');
  assert.ok(state.arms[oldKey]?.[OLD] !== undefined, 'the old arms are kept');
  assert.equal(state.arms[newKey], undefined, 'no arm is carried over to the new baseline');
  assert.equal(slicePolicy(state, newKey).mode, 'advise');
  assert.equal(slicePolicy(state, newKey).modelId, null);
  const explained = explainSliceLearning(state, 'bounded-edit', [], { registry: R, harness: 'codex' }).lines.join('\n');
  assert.match(explained, /Slice bounded-edit::gpt-6\.1-sol: advice only/);
  assert.match(explained, /No local outcomes yet/);
  assert.doesNotMatch(explained, /gpt-6-luna/);

  // A Codex route reads the new key: the old promotion neither switches it nor is touched by it.
  for (const modelId of [NEW, OLD, 'gpt-6-luna']) assert.equal(await core.recordModelRun(home, { harness: 'codex', authMode: 'api-key', modelId, nowMs: NOW - 1000 }), true);
  const route = (extra = {}) => routeManagedWorker(
    { taskId: 'task-move', workspaceId: 'w-move', sliceId: 'bounded-edit', mode: 'bounded-auto', risk: 'high', harness: 'codex', authMode: 'api-key', consentedProviders: ['openai'], killSwitchStopped: () => false, launch: async () => { throw new Error('never launched'); }, ...extra },
    { home, trustedKeys: new Map(), bundledCalibration: null, nowMs: () => NOW, random: () => 0.99 },
  );
  const versionsAfter = async () => (await loadLearningState({ home, workspaceId: 'w-move' })).versions.map((v) => `${v.version}:${v.reasonCode}:${v.sliceId}`);
  const before = await versionsAfter();
  const routed = await route();
  assert.deepEqual([routed.learning?.baselineModelId, routed.learning?.sliceMode], [NEW, 'advise'], JSON.stringify(routed));
  assert.deepEqual(await versionsAfter(), before, 'the route for the new baseline leaves the old key alone (no BASELINE_CHANGED demotion, no reuse)');
  // The control: a task that approves GPT-6 Sol keeps GPT-6 Sol as its baseline, so it reads the old key (and reconciles it).
  const approved = await route({ approvedModelId: OLD });
  assert.equal(approved.learning?.baselineModelId, OLD);
  assert.equal((await versionsAfter()).length, before.length + 1, 'only a route against the old baseline reconciles the old key');
  assert.match((await versionsAfter()).at(-1), /^2:[A-Z_]+:bounded-edit::gpt-6-sol$/);
});

test('D f17a3bc: the models the orchestrator left out of a no-model task carry its reason in the selection\'s eliminations', () => {
  const { withExclusions } = core;
  const selection = { outcome: 'select', modelId: 'claude-sonnet-5', baselineModelId: 'claude-opus-5-5', reasonCode: 'LOWEST_UTILITY_WITHIN_FLOOR', sliceId: 'bounded-edit', scored: [{ modelId: 'claude-sonnet-5' }], eliminated: [{ modelId: 'gpt-6-sol', gate: 'managed-allowlist' }, { modelId: 'claude-opus-5', gate: 'context' }], shadow: [], saving: null, registrySnapshotId: 's' };
  const out = withExclusions({ launched: false, selection }, { 'gpt-6-sol': 'NO_HARNESS', 'kimi-k3': 'PROVIDER_CONSENT_REQUIRED', 'grok-4.7': 'not a code', 'claude-sonnet-5': 'NO_HARNESS' });
  assert.deepEqual(out.selection.eliminated, [
    { modelId: 'gpt-6-sol', gate: 'managed-allowlist', reasonCode: 'NO_HARNESS' },
    { modelId: 'claude-opus-5', gate: 'context' },
    { modelId: 'kimi-k3', gate: 'managed-allowlist', reasonCode: 'PROVIDER_CONSENT_REQUIRED' },
  ]);
  // Nothing to mark: the result is returned as it is.
  const bare = { launched: false, selection };
  assert.equal(withExclusions(bare, undefined), bare);
  assert.equal(withExclusions({ launched: false, selection: null }, { 'gpt-6-sol': 'NO_HARNESS' }).selection, null);
});
