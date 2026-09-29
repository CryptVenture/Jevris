// R11 (routing design, with C): D tells the router which installed harness and sign-in reach
// each model the owned-worker route may pick, and null for a model no harness reaches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jevrisPaths } from '@jevris/platform';
import { PROVIDER_CONSENT_TEXT } from '@jevris/contracts';
import { grantProviderConsent } from '@jevris/store';
import { BUNDLED_MODEL_REGISTRY, accessScopeOf, classifyAccessSignal, recordAccessLimit } from '@jevris/core';
import {
  DEFAULT_CONFIG,
  approveManifests,
  drainBackgroundWorkers,
  getTask,
  manifestHash,
  openWorkspace,
  parseManifest,
  providerConsentOf,
  scriptedWorkerPort,
  setTaskOpDeps,
  sidecarOps,
} from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

async function fixture(models) {
  const dir = tempDir('jv-rs-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  const state = jevrisPaths({ home }).state;
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'test-home.json'), JSON.stringify({ schemaVersion: 'jevris-test-home-1' }), { mode: 0o600 });
  chmodSync(join(state, 'test-home.json'), 0o600);
  mkdirSync(join(repo, 'mod'), { recursive: true });
  writeFileSync(join(repo, 'mod', 'a.txt'), 'a\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  const m = parseManifest({ id: 'fixed', argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code' }).manifest;
  await approveManifests(ws, [m], { fixed: manifestHash(m) }, 'test');
  const cfg = jevrisPaths({ home }).config;
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, managedWorkers: 'bounded-auto' }, orchestration: { ...DEFAULT_CONFIG.orchestration, enabled: true } }));
  const scriptPath = join(dir, 'worker-script.json');
  writeFileSync(scriptPath, JSON.stringify({ schemaVersion: 'jevris-test-worker-1', runs: [{ writes: [], status: 'completed', costUsd: 0.01 }] }));
  const scripted = scriptedWorkerPort({ JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: scriptPath }, home);
  const calls = [];
  const ctx = (op, body, engine) => ({
    op, client: 'cli', scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'], workspace: { id: ws.workspaceId, root: ws.workspaceRoot }, body, home,
    signal: new AbortController().signal, deadline: { budgetMs: 20000, remainingMs: () => 20000, expired: () => false }, store, killSwitchStopped: false, engine, trace: () => {},
  });
  const engine = { async routeManagedWorker(input) {
    calls.push(input);
    return { launched: false, reasonCode: 'CALIBRATION_NO_RELEASE' };
  } };
  const submit = () => sidecarOps.find((o) => o.op === 'plan.submit').handle(ctx('plan.submit', {
    plan: { tasks: [{ id: 'T1', requirementIds: ['R1'], acceptanceCheckIds: ['fixed'], expectedOutputs: ['patch'], writeScopes: ['mod'], models, sliceId: 'bounded-edit' }] },
    ownerId: 'alice',
    channel: 'terminal', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 },
  }, engine));
  return { ws, scripted, calls, submit, done: () => {
    setTaskOpDeps({});
    closeTestStore(store);
  } };
}

test('R11: the managed route names each eligible model\'s harness and sign-in, and null for a model no installed harness reaches', async () => {
  const f = await fixture(['claude-sonnet-4-5', 'gpt-5-codex', 'grok-4.7']);
  try {
    // Claude and Codex are installed (Claude on a key, Codex on its login); no OpenCode or Kilo, so no harness reaches Grok.
    const harnessOf = (model) => (model.startsWith('claude-') ? 'claude' : model.startsWith('gpt-') ? 'codex' : null);
    setTaskOpDeps({ workerPort: async () => ({
      ...f.scripted,
      harnessFor: harnessOf,
      authFor: async (model) => (harnessOf(model) === 'claude' ? { mode: 'api-key', source: 'environment' } : harnessOf(model) === 'codex' ? { mode: 'subscription', source: 'environment' } : null),
    }) });
    await f.submit();
    await drainBackgroundWorkers();
    assert.deepEqual(f.calls[0].candidateScopes, {
      'claude-sonnet-4-5': { harness: 'claude', authMode: 'api-key' },
      'gpt-5-codex': { harness: 'codex', authMode: 'subscription' },
      'grok-4.7': null,
    });
  } finally {
    f.done();
  }
});

test('R11: a port that cannot say which harness runs a model sends no candidate scopes (the router keeps its earlier behaviour)', async () => {
  const f = await fixture(['claude-sonnet-4-5']);
  try {
    setTaskOpDeps({ workerPort: async () => f.scripted });
    await f.submit();
    await drainBackgroundWorkers();
    assert.equal(f.calls.length, 1);
    assert.equal(Object.hasOwn(f.calls[0], 'candidateScopes'), false);
  } finally {
    f.done();
  }
});

test('R29: the worker port reads each provider\'s stored consent for today\'s consent text; no store, no reader', async () => {
  const f = await fixture(['claude-opus-5-5']);
  try {
    assert.equal(providerConsentOf({ store: undefined }), undefined);
    const read = providerConsentOf(f.ws);
    assert.deepEqual([read('deepseek').granted, read('deepseek').reasonCode], [false, 'PROVIDER_CONSENT_MISSING']);
    assert.equal(read('no-such-provider').reasonCode, 'PROVIDER_CONSENT_MISSING');
    const who = { actor: 'cli', channel: 'terminal' };
    assert.equal(grantProviderConsent(f.ws.store, { provider: 'deepseek', textVersion: PROVIDER_CONSENT_TEXT.deepseek.version, atMs: 1_000, ...who }).ok, true);
    assert.equal(read('deepseek').granted, true);
    // A grant for another version of the text is stale.
    assert.equal(grantProviderConsent(f.ws.store, { provider: 'moonshot', textVersion: 'moonshot-2020-01-01', atMs: 1_000, ...who }).ok, true);
    assert.deepEqual([read('moonshot').granted, read('moonshot').reasonCode], [false, 'PROVIDER_CONSENT_STALE']);
  } finally {
    f.done();
  }
});

/** A port for f17a3bc: Claude, Codex and Antigravity on their sign-ins, OpenCode on keys, and nothing reaching Grok. */
function signedInPort(scripted) {
  const harnessOf = (model) => (/^claude-/.test(model) ? 'claude' : /^gpt-/.test(model) ? 'codex' : /^gemini-/.test(model) ? 'antigravity' : /^(glm|kimi|deepseek)-/.test(model) ? 'opencode' : null);
  const modeOf = { claude: 'subscription', codex: 'subscription', antigravity: 'subscription', opencode: 'api-key' };
  return { ...scripted, harnessFor: harnessOf, authFor: async (model) => (harnessOf(model) === null ? null : { mode: modeOf[harnessOf(model)], source: 'environment' }) };
}

test('f17a3bc: a task naming no models routes among every reachable, consented model; unnamed vendors only on API keys, except Antigravity\'s sign-in for Gemini; the baseline is the harness default', async () => {
  const f = await fixture([]);
  try {
    setTaskOpDeps({ workerPort: async () => signedInPort(f.scripted) });
    await f.submit();
    await drainBackgroundWorkers();
    assert.equal(f.calls.length, 1, 'no longer QUEUED_NO_MODEL');
    const call = f.calls[0];
    const eligible = call.eligibleModels;
    // The baseline's vendor (Anthropic, on Claude Code's sign-in) and its models are in.
    assert.ok(eligible.includes('claude-opus-5-5'));
    assert.equal(call.approvedModelId, null, 'no approved model: the router takes the harness default');
    // Antigravity's own sign-in among Gemini models is in (6460ca9); GLM on an OpenCode key is in.
    assert.ok(eligible.includes('gemini-3.8-flash'));
    assert.ok(eligible.includes('glm-5.3'));
    // Out, each with its reason: OpenAI on a Codex subscription (OD-10), Kimi and DeepSeek without consent (OD-4), Grok with no harness.
    for (const id of ['gpt-6-sol', 'kimi-k3', 'deepseek-v4-pro', 'grok-4.7']) assert.ok(!eligible.includes(id), id);
    assert.equal(call.candidateExclusions['gpt-6-sol'], 'EXPLORATION_NEEDS_API_KEY');
    assert.equal(call.candidateExclusions['kimi-k3'], 'PROVIDER_CONSENT_REQUIRED');
    assert.equal(call.candidateExclusions['grok-4.7'], 'NO_HARNESS');
    assert.equal(Object.hasOwn(call.candidateScopes, 'grok-4.7'), false, 'scopes cover the default set only');
    assert.equal(call.candidateScopes['glm-5.3'].authMode, 'api-key');
    // The router did not launch: the baseline ran as the default set's.
    assert.notEqual(getTask(f.ws, 'T1').node.state, 'ready');
  } finally {
    f.done();
  }
});

test('f17a3bc: a task that names models keeps its list; a granted provider joins a no-model task\'s set; a port that cannot say which harness runs a model leaves the task QUEUED_NO_MODEL', async () => {
  const named = await fixture(['claude-opus-5-5', 'gpt-6-sol']);
  try {
    setTaskOpDeps({ workerPort: async () => signedInPort(named.scripted) });
    await named.submit();
    await drainBackgroundWorkers();
    assert.deepEqual(named.calls[0].eligibleModels, ['claude-opus-5-5', 'gpt-6-sol'], 'a vendor the user named runs on its sign-in');
    assert.equal(named.calls[0].approvedModelId, 'claude-opus-5-5');
    assert.equal(Object.hasOwn(named.calls[0], 'candidateExclusions'), false);
  } finally {
    named.done();
  }
  const granted = await fixture([]);
  try {
    grantProviderConsent(granted.ws.store, { provider: 'deepseek', textVersion: PROVIDER_CONSENT_TEXT.deepseek.version, atMs: 1_000, actor: 'cli', channel: 'terminal' });
    setTaskOpDeps({ workerPort: async () => signedInPort(granted.scripted) });
    await granted.submit();
    await drainBackgroundWorkers();
    assert.ok(granted.calls[0].eligibleModels.includes('deepseek-v4-pro'), 'consented, on an API key');
    assert.ok(!granted.calls[0].eligibleModels.includes('kimi-k3'));
  } finally {
    granted.done();
  }
  const blind = await fixture([]);
  try {
    setTaskOpDeps({ workerPort: async () => blind.scripted });
    const out = await blind.submit();
    await drainBackgroundWorkers();
    assert.equal(blind.calls.length, 0);
    assert.deepEqual(out.body.leaseIds, [], JSON.stringify(out.body));
    assert.ok(['validated', 'ready'].includes(getTask(blind.ws, 'T1').node.state), 'queued, not leased');
  } finally {
    blind.done();
  }
});

test('B\'s security review finding 8: an undetected sign-in is not signed in, so its provider gets no signed-in consent default; a grant or a seen sign-in does', async () => {
  // Claude Code on an assumed subscription (no key, nothing declared): `undetected`.
  const undetectedPort = (scripted, claudeSource = 'undetected') => {
    const p = signedInPort(scripted);
    return { ...p, authFor: async (model) => (/^claude-/.test(model) ? { mode: 'subscription', source: claudeSource } : p.authFor(model)) };
  };
  const plain = await fixture([]);
  try {
    setTaskOpDeps({ workerPort: async () => undetectedPort(plain.scripted) });
    await plain.submit();
    await drainBackgroundWorkers();
    const call = plain.calls[0];
    assert.ok(call !== undefined, 'other providers still route');
    for (const id of ['claude-opus-5-5', 'claude-sonnet-5']) {
      assert.ok(!call.eligibleModels.includes(id), `${id} is out`);
      assert.equal(call.candidateExclusions[id], 'PROVIDER_CONSENT_REQUIRED', id);
    }
    assert.ok(call.eligibleModels.includes('glm-5.3'), 'a provider reached on a key keeps its default');
  } finally {
    plain.done();
  }
  // The scope itself says the sign-in is unknown, so core's signedInProvidersOf does not count it.
  const scoped = await fixture(['claude-sonnet-5', 'glm-5.3']);
  try {
    setTaskOpDeps({ workerPort: async () => undetectedPort(scoped.scripted) });
    await scoped.submit();
    await drainBackgroundWorkers();
    assert.deepEqual(scoped.calls[0].candidateScopes, { 'claude-sonnet-5': { harness: 'claude', authMode: 'unknown' }, 'glm-5.3': { harness: 'opencode', authMode: 'api-key' } });
  } finally {
    scoped.done();
  }
  // Owner decision c065d52 (RAN_HERE): once a harness here has run an Anthropic model, the
  // undetected sign-in counts, and a no-model task's set keeps the Anthropic models.
  const seen = await fixture([]);
  try {
    const { recordModelRun } = await import('@jevris/core');
    assert.equal(await recordModelRun(seen.ws.home, { harness: 'claude', authMode: 'unknown', modelId: 'claude-opus-5-5', nowMs: Date.now() }), true);
    setTaskOpDeps({ workerPort: async () => undetectedPort(seen.scripted) });
    await seen.submit();
    await drainBackgroundWorkers();
    assert.ok(seen.calls[0].eligibleModels.includes('claude-opus-5-5'));
    assert.equal(Object.hasOwn(seen.calls[0].candidateExclusions ?? {}, 'claude-sonnet-5'), false);
  } finally {
    seen.done();
  }
  // A seen sign-in (a subscription declared in workers.json) restores the default.
  const declared = await fixture([]);
  try {
    setTaskOpDeps({ workerPort: async () => undetectedPort(declared.scripted, 'declared') });
    await declared.submit();
    await drainBackgroundWorkers();
    assert.ok(declared.calls[0].eligibleModels.includes('claude-opus-5-5'));
  } finally {
    declared.done();
  }
});

test('R74 (E10): a model an access limit pauses here leaves a no-model task\'s default set with ACCESS_LIMITED, so it is never the baseline', async () => {
  const f = await fixture([]);
  try {
    const nowMs = Date.now();
    const scope = accessScopeOf(BUNDLED_MODEL_REGISTRY, 'claude', 'claude-opus-5-5', 'subscription');
    const classification = classifyAccessSignal({ port: 'claude-api', channel: 'structured', status: 429, certified: false }, 'subscription', nowMs);
    assert.equal((await recordAccessLimit({ home: f.ws.home, scope, classification, source: 'owned-run', nowMs })).ok, true);
    setTaskOpDeps({ workerPort: async () => signedInPort(f.scripted) });
    await f.submit();
    await drainBackgroundWorkers();
    const call = f.calls[0];
    assert.equal(call.candidateExclusions['claude-opus-5-5'], 'ACCESS_LIMITED');
    assert.ok(!call.eligibleModels.includes('claude-opus-5-5'));
    // Only the paused model's scope is out for the pause; the set is not empty and routes on.
    assert.deepEqual(Object.entries(call.candidateExclusions).filter(([, why]) => why === 'ACCESS_LIMITED').map(([id]) => id), ['claude-opus-5-5']);
    assert.ok(call.eligibleModels.length > 0);
  } finally {
    f.done();
  }
});
