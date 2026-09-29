// Serving hosts R52: owned workers through a pinned serving host. The dispatching port reads a host
// route (a host spelling, or the registry id plus `servingHost`), runs it only on a harness with the
// host's row, signs in to the host by that row, and needs the (host, maker) pair's consent. The host
// picker is design 4.3 (core `spellTarget`). Nothing passes a host yet: task-ops is held for the owner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUNDLED_MODEL_REGISTRY as registry, credentialFingerprint } from '@jevris/core';
import { linkSession, recordSession } from '@jevris/store';
import {
  HOST_NO_LOGIN,
  HOST_NOT_ON_HARNESS,
  HOST_ROUTE_UNKNOWN,
  PROVIDER_KEY_VARS,
  WORKER_MODEL_UNNAMED,
  hostEnv,
  hostReachable,
  hostRouteOfRun,
  hostRouteOfSpelling,
  launchFingerprint,
  linkedSessionModel,
  loadWorkerPort as loadRealWorkerPort,
  ownedWorkerSpelling,
  resolveHostAuth,
  workerProvider,
} from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

const noPort = async () => null;
const loadWorkerPort = (loaders = {}, options = {}) =>
  loadRealWorkerPort({ sdk: noPort, claude: noPort, codex: noPort, opencode: noPort, kilo: noPort, antigravity: noPort, ...loaders }, { harnessModelId: (model) => model, registry, ...options });

const input = { prompt: 'p', model: 'kimi-k3', cwd: tmpdir(), allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, timeoutMs: 1000, signal: new AbortController().signal };
const granted = (p) => ({ granted: true, provider: p, textVersion: 'v', grantedAtMs: 1 });
const missing = (p) => ({ granted: false, provider: p, reasonCode: 'PROVIDER_CONSENT_MISSING' });
const reader = (table) => (p) => table[p] ?? missing(p);

function stubs() {
  const seen = [];
  const stub = (name) => async () => ({
    run: async (run) => {
      seen.push({ harness: name, model: run.model, servingHost: run.servingHost, auth: run.auth, env: run.env });
      return { status: 'completed', reason: '', sessionId: null, requestedModel: run.model, actualModel: null, costUsd: null, usage: null, turns: 0, durationMs: 0 };
    },
  });
  return { seen, opencode: stub('opencode'), kilo: stub('kilo') };
}

test('R52: a host spelling names the maker behind the host; a registry id plus servingHost is the same route', () => {
  assert.deepEqual(
    ['openrouter/moonshotai/kimi-k3', 'kilo/x-ai/grok-4.7', 'openrouter/anthropic/claude-sonnet-5', 'moonshotai/kimi-k3', 'kimi-k3'].map((m) => workerProvider(m, registry)),
    ['moonshot', 'xai', 'anthropic', 'moonshot', 'moonshot'],
  );
  assert.deepEqual(hostRouteOfSpelling(registry, 'openrouter/moonshotai/kimi-k3'), { provider: 'moonshot', modelId: 'kimi-k3', servingHost: 'openrouter' });
  assert.deepEqual(hostRouteOfSpelling(registry, 'kilo/moonshotai/kimi-k3'), { provider: 'moonshot', modelId: 'kimi-k3', servingHost: 'kilo' });
  assert.equal(hostRouteOfSpelling(registry, 'moonshotai/kimi-k3'), null, 'the maker spelling is no host route');
  assert.equal(hostRouteOfSpelling(registry, 'somegateway/moonshotai/kimi-k3'), null, 'an unpinned gateway is no route');
  assert.deepEqual(hostRouteOfRun(registry, 'kimi-k3', 'openrouter'), { provider: 'moonshot', modelId: 'kimi-k3', servingHost: 'openrouter' });
  assert.deepEqual(hostRouteOfRun(registry, 'moonshot/kimi-k3', 'kilo'), { provider: 'moonshot', modelId: 'kimi-k3', servingHost: 'kilo' });
  assert.equal(hostRouteOfRun(registry, 'kimi-k3', 'somegateway'), HOST_ROUTE_UNKNOWN);
  assert.equal(hostRouteOfRun(registry, 'no-such-model', 'openrouter'), HOST_ROUTE_UNKNOWN);
  assert.equal(hostRouteOfRun(registry, 'kimi-k3', undefined), null, 'no host: the maker route');
  // Only a harness with the host's row and a spelling there reaches it.
  const viaKilo = { provider: 'moonshot', modelId: 'kimi-k3', servingHost: 'kilo' };
  assert.deepEqual(['opencode', 'kilo', 'claude'].map((h) => hostReachable(registry, h, viaKilo)), [false, true, false]);
  const viaOpenRouter = { ...viaKilo, servingHost: 'openrouter' };
  assert.deepEqual(['opencode', 'kilo', 'codex'].map((h) => hostReachable(registry, h, viaOpenRouter)), [true, true, false]);
});

test('R52: a host route signs in to the host by its harnessHosts row: OpenRouter by its key variable, the Kilo Gateway by the Kilo sign-in', () => {
  const key = { OPENROUTER_API_KEY: 'k-not-real' };
  assert.deepEqual(resolveHostAuth(registry, 'opencode', 'openrouter', undefined, key, []), { ok: true, mode: 'api-key', source: 'environment' });
  assert.deepEqual(resolveHostAuth(registry, 'opencode', 'openrouter', 'api-key', key, null), { ok: true, mode: 'api-key', source: 'declared' });
  // A key stored in the harness does not count: F's port hides stored logins from an api-key run.
  const stored = resolveHostAuth(registry, 'opencode', 'openrouter', undefined, {}, [{ provider: 'openrouter', type: 'api' }]);
  assert.equal(stored.ok, false);
  assert.equal(stored.reasonCode, HOST_NO_LOGIN);
  assert.match(stored.reason, /^HOST_NO_LOGIN: opencode holds no openrouter API key; set OPENROUTER_API_KEY$/);
  assert.equal(resolveHostAuth(registry, 'opencode', 'openrouter', 'api-key', {}, null).reasonCode, HOST_NO_LOGIN, 'a declared key that is not set');
  const declaredSub = resolveHostAuth(registry, 'kilo', 'openrouter', 'subscription', key, null);
  assert.equal(declaredSub.reasonCode, HOST_NOT_ON_HARNESS, 'OpenRouter takes no subscription');
  // The Kilo Gateway: Kilo's own login line; an unreadable list is an assumed login, never signed in.
  assert.deepEqual(resolveHostAuth(registry, 'kilo', 'kilo', undefined, {}, [{ provider: 'Kilo Gateway', type: 'oauth' }]), { ok: true, mode: 'subscription', source: 'stored-login' });
  assert.deepEqual(resolveHostAuth(registry, 'kilo', 'kilo', undefined, {}, null), { ok: true, mode: 'subscription', source: 'undetected' });
  const noKilo = resolveHostAuth(registry, 'kilo', 'kilo', undefined, key, [{ provider: 'moonshotai', type: 'oauth' }]);
  assert.equal(noKilo.reasonCode, HOST_NO_LOGIN);
  assert.match(noKilo.reason, /sign in to kilo in kilo$/);
  assert.equal(resolveHostAuth(registry, 'opencode', 'kilo', undefined, {}, null).reasonCode, HOST_NOT_ON_HARNESS, 'OpenCode has no Kilo Gateway row');
  // B's LOW 36: the run's environment holds only the host's own key, in api-key mode; never the
  // maker's or any other provider's; a subscription run has no provider or host key at all.
  const env = { PATH: '/bin', MOONSHOT_API_KEY: 'm-not-real', OPENROUTER_API_KEY: 'k-not-real', ANTHROPIC_API_KEY: 'a-not-real', OPENAI_API_KEY: 'o-not-real', XAI_API_KEY: 'x-not-real' };
  const all = Object.values(PROVIDER_KEY_VARS).flat();
  assert.deepEqual(hostEnv({ provider: 'moonshot', modelId: 'kimi-k3', servingHost: 'openrouter' }, 'api-key', all, env), { PATH: '/bin', OPENROUTER_API_KEY: 'k-not-real' });
  assert.deepEqual(hostEnv({ provider: 'moonshot', modelId: 'kimi-k3', servingHost: 'kilo' }, 'subscription', all, env), { PATH: '/bin' });
});

test('R52 acceptance: a gateway pin without the maker\'s consent is refused, and nothing starts', async () => {
  const s = stubs();
  const env = { OPENROUTER_API_KEY: 'k-not-real', MOONSHOT_API_KEY: 'm-not-real' };
  // OpenRouter is granted and signed in (its key is set); Moonshot, the maker, is not granted.
  const port = await loadWorkerPort({ opencode: s.opencode, kilo: s.kilo }, { env, credentials: async () => [], providerConsent: reader({ openrouter: granted('openrouter') }) });
  for (const run of [{ ...input, model: 'openrouter/moonshotai/kimi-k3' }, { ...input, model: 'kimi-k3', servingHost: 'openrouter' }]) {
    const refused = await port.run(run);
    assert.equal(refused.status, 'refused');
    assert.match(refused.reason, /^PROVIDER_CONSENT_REQUIRED: moonshot has no current consent to receive this work through openrouter; grant it with jevris consent provider moonshot --grant$/);
    assert.deepEqual([refused.authMode, refused.authSource], ['api-key', 'environment']);
  }
  assert.deepEqual(s.seen, []);
  // A maker grant does not stand in for the host: OpenRouter revoked blocks the pair.
  const revoked = await (await loadWorkerPort({ opencode: s.opencode }, { env, credentials: async () => [], providerConsent: reader({ moonshot: granted('moonshot'), openrouter: { granted: false, provider: 'openrouter', reasonCode: 'PROVIDER_CONSENT_REVOKED' } }) })).run({ ...input, servingHost: 'openrouter' });
  assert.match(revoked.reason, /^HOST_CONSENT_REVOKED: openrouter has no current consent/);
  // No consent reader: nothing can be shown for the pair, so it is refused.
  const unread = await (await loadWorkerPort({ opencode: s.opencode }, { env, credentials: async () => [] })).run({ ...input, servingHost: 'openrouter' });
  assert.match(unread.reason, /^HOST_CONSENT_REQUIRED: openrouter and moonshot have no consent Jevris can read/);
  assert.deepEqual(s.seen, []);
});

test('R52: with the pair\'s consent the run goes to OpenCode or Kilo as the registry id plus the host, with the host\'s sign-in and never the maker\'s key', async () => {
  const s = stubs();
  const env = { OPENROUTER_API_KEY: 'k-not-real', MOONSHOT_API_KEY: 'm-not-real', ANTHROPIC_API_KEY: 'a-not-real', OPENAI_API_KEY: 'o-not-real' };
  const consent = reader({ moonshot: granted('moonshot') });
  const port = await loadWorkerPort({ opencode: s.opencode, kilo: s.kilo }, { env, credentials: async () => [{ provider: 'Kilo Gateway', type: 'oauth' }], providerConsent: consent });
  assert.equal(port.harnessFor('openrouter/moonshotai/kimi-k3'), 'opencode');
  assert.equal(port.harnessFor('kimi-k3', 'kilo'), 'kilo', 'only Kilo reaches the Kilo Gateway');
  assert.equal(port.harnessFor('kimi-k3', 'somegateway'), null);
  assert.deepEqual(await port.authFor('kimi-k3', 'kilo'), { mode: 'subscription', source: 'stored-login' });
  // OpenRouter signed in by its key: its signed-in default allows it; the maker has a grant.
  const viaOpenRouter = await port.run({ ...input, model: 'openrouter/moonshotai/kimi-k3' });
  assert.deepEqual([viaOpenRouter.status, viaOpenRouter.harness, viaOpenRouter.authMode, viaOpenRouter.authSource], ['completed', 'opencode', 'api-key', 'environment']);
  // The Kilo Gateway through the Kilo sign-in: a subscription run with no provider key at all.
  const viaKilo = await port.run({ ...input, servingHost: 'kilo' });
  assert.deepEqual([viaKilo.status, viaKilo.harness, viaKilo.authMode, viaKilo.authSource], ['completed', 'kilo', 'subscription', 'stored-login']);
  const [first, second] = s.seen;
  assert.deepEqual([first.harness, first.model, first.servingHost, first.auth], ['opencode', 'kimi-k3', 'openrouter', 'api-key']);
  assert.equal(first.env.MOONSHOT_API_KEY, undefined, 'the maker never receives the request');
  assert.deepEqual([first.env.ANTHROPIC_API_KEY, first.env.OPENAI_API_KEY], [undefined, undefined], 'nor any other provider (B\'s LOW 36)');
  assert.equal(first.env.OPENROUTER_API_KEY, 'k-not-real');
  assert.deepEqual([second.harness, second.model, second.servingHost, second.auth], ['kilo', 'kimi-k3', 'kilo', 'subscription']);
  assert.equal(second.env.OPENROUTER_API_KEY, undefined);
  assert.equal(second.env.MOONSHOT_API_KEY, undefined);
  assert.equal(second.env.ANTHROPIC_API_KEY, undefined);
  // A maker route is unchanged: no servingHost reaches the port.
  await port.run({ ...input });
  assert.equal(s.seen[2].servingHost, undefined);
  assert.equal(s.seen[2].model, 'kimi-k3');
});

test('R52: the Kilo Gateway needs its own consent when its sign-in is not seen, and a revoked OpenRouter blocks it downstream', async () => {
  const s = stubs();
  const undetected = await loadWorkerPort({ kilo: s.kilo }, { env: {}, credentials: async () => null, providerConsent: reader({ moonshot: granted('moonshot') }) });
  const assumed = await undetected.run({ ...input, servingHost: 'kilo' });
  assert.match(assumed.reason, /^HOST_CONSENT_REQUIRED: kilo has no current consent/);
  const forwarded = await (await loadWorkerPort({ kilo: s.kilo }, { env: {}, credentials: async () => [{ provider: 'kilo', type: 'oauth' }], providerConsent: reader({ moonshot: granted('moonshot'), kilo: granted('kilo'), openrouter: { granted: false, provider: 'openrouter', reasonCode: 'PROVIDER_CONSENT_REVOKED' } }) })).run({ ...input, servingHost: 'kilo' });
  assert.match(forwarded.reason, /^HOST_CONSENT_REVOKED: openrouter, which kilo forwards to, has withdrawn consent/);
  const noLogin = await (await loadWorkerPort({ kilo: s.kilo }, { env: {}, credentials: async () => [], providerConsent: reader({ moonshot: granted('moonshot') }) })).run({ ...input, servingHost: 'kilo' });
  assert.equal(noLogin.status, 'refused');
  assert.match(noLogin.reason, /^HOST_NO_LOGIN: /);
  assert.deepEqual(s.seen, []);
});

test('R52: a host route only lists harnesses that reach the host; a preferred harness that cannot is refused, not rerouted', async () => {
  const s = stubs();
  const dir = tempDir('jv-r52-');
  writeFileSync(join(dir, 'workers.json'), JSON.stringify({ schemaVersion: 'jevris-workers-1', harness: { moonshot: 'opencode' } }));
  const port = await loadWorkerPort({ opencode: s.opencode, kilo: s.kilo }, { env: {}, configDir: dir, credentials: async () => [{ provider: 'kilo', type: 'oauth' }], providerConsent: reader({ moonshot: granted('moonshot') }) });
  assert.equal(port.harnessFor('kimi-k3', 'kilo'), null);
  const refused = await port.run({ ...input, servingHost: 'kilo' });
  assert.equal(refused.status, 'refused');
  assert.equal(refused.reason, `${WORKER_MODEL_UNNAMED}: no harness here reaches moonshot's kimi-k3 through kilo`);
  const unknown = await port.run({ ...input, servingHost: 'somegateway' });
  assert.equal(unknown.reason, 'HOST_ROUTE_UNKNOWN: kimi-k3 through somegateway is not a pinned host\'s route for a registered model');
  // B's nit: a host that is not an id's shape is never echoed.
  const free = await port.run({ ...input, servingHost: 'Some Free Text' });
  assert.equal(free.reason, 'HOST_ROUTE_UNKNOWN: kimi-k3 through an unknown host is not a pinned host\'s route for a registered model');
  // Not installed: the host's harness is named, as for makers.
  const none = await (await loadWorkerPort({ opencode: s.opencode }, { env: {}, credentials: async () => null, providerConsent: reader({ moonshot: granted('moonshot'), kilo: granted('kilo') }) })).run({ ...input, servingHost: 'kilo' });
  assert.equal(none.status, 'unsupported');
  assert.deepEqual(s.seen, []);
});

test('R52 acceptance, design 4.3: the linked session\'s host is used; with two seen hosts and no link the route is advice only', () => {
  const at = '2026-09-28T00:00:00.000Z';
  const run = (raw, servingHost) => ({ harness: 'kilocode', authMode: 'subscription', modelId: 'kimi-k3', firstAt: at, lastAt: at, raw, servingHost, source: 'reported' });
  const twoHosts = { listings: [], runs: [run('openrouter/moonshotai/kimi-k3', 'openrouter'), run('kilo/moonshotai/kimi-k3', 'kilo')] };
  const allowAll = () => true;
  const target = { provider: 'moonshot', modelId: 'kimi-k3' };
  const advice = ownedWorkerSpelling({ registry, harness: 'kilo', target, sessionModel: null, offer: twoHosts, hostAllowed: allowAll });
  assert.deepEqual(advice, { ok: false, reasonCode: 'NOT_ON_SESSION_HOST', seenHosts: ['kilo', 'openrouter'] });
  // A linked session on OpenRouter keeps OpenRouter (rule 1).
  const linked = ownedWorkerSpelling({ registry, harness: 'kilo', target, sessionModel: 'openrouter/anthropic/claude-sonnet-5', offer: twoHosts, hostAllowed: allowAll });
  assert.deepEqual([linked.ok, linked.id, linked.servingHost, linked.via, linked.rule, linked.hostRoute], [true, 'openrouter/moonshotai/kimi-k3', 'openrouter', 'host', 1, true]);
  // One seen host, allowed and priced: that host (rule 2); not allowed: advice only.
  const oneHost = { listings: [], runs: [run('kilo/moonshotai/kimi-k3', 'kilo')] };
  const one = ownedWorkerSpelling({ registry, harness: 'kilo', target, sessionModel: null, offer: oneHost, hostAllowed: allowAll });
  assert.deepEqual([one.ok, one.id, one.servingHost, one.rule], [true, 'kilo/moonshotai/kimi-k3', 'kilo', 2]);
  assert.equal(ownedWorkerSpelling({ registry, harness: 'kilo', target, sessionModel: null, offer: oneHost }).ok, false, 'no host passes consent by default');
  // A harness that names no host keeps the maker's spelling.
  const claude = ownedWorkerSpelling({ registry, harness: 'claude', target: { provider: 'anthropic', modelId: 'claude-sonnet-5' }, sessionModel: null, offer: twoHosts });
  assert.deepEqual([claude.ok, claude.id, claude.via], [true, 'claude-sonnet-5', 'maker']);
});

test('R52: the linked session model is the newest live session linked to the task on the same harness', () => {
  const dir = tempDir('jv-r52-link-');
  const store = testStore(dir);
  try {
    const atMs = Date.now();
    assert.equal(linkedSessionModel(store, 'T1', 'kilo'), null);
    assert.equal(recordSession(store, { sessionId: 'kilo-1', harness: 'kilocode', state: 'active', actualModel: 'openrouter/moonshotai/kimi-k3', atMs }).ok, true);
    assert.equal(linkSession(store, { sessionId: 'kilo-1', harness: 'kilocode', taskId: 'T1', via: 'route', actor: 'tester', channel: 'terminal', atMs }).ok, true);
    assert.equal(recordSession(store, { sessionId: 'oc-1', harness: 'opencode', state: 'active', actualModel: 'moonshotai/kimi-k3', atMs }).ok, true);
    assert.equal(linkSession(store, { sessionId: 'oc-1', harness: 'opencode', taskId: 'T1', via: 'route', actor: 'tester', channel: 'terminal', atMs: atMs + 1 }).ok, true);
    assert.equal(linkedSessionModel(store, 'T1', 'kilo'), 'openrouter/moonshotai/kimi-k3');
    assert.equal(linkedSessionModel(store, 'T1', 'opencode'), 'moonshotai/kimi-k3');
    assert.equal(linkedSessionModel(store, 'T2', 'kilo'), null, 'another task');
    assert.equal(linkedSessionModel(store, 'T1', 'codex'), null, 'a session on another harness names no host here');
    assert.equal(linkedSessionModel(undefined, 'T1', 'kilo'), null);
  } finally {
    closeTestStore(store);
  }
});

test('the pre-spawn release: every refusal the dispatching port makes before a harness port runs says spawned: false; a harness port\'s own outcome never carries it, even when it claims it', async () => {
  const s = stubs();
  const env = { OPENROUTER_API_KEY: 'k-not-real', MOONSHOT_API_KEY: 'm-not-real' };
  const port = await loadWorkerPort({ opencode: s.opencode, kilo: s.kilo }, { env, credentials: async () => [], providerConsent: reader({ openrouter: granted('openrouter') }) });
  const refusals = [
    await port.run({ ...input, model: 'kimi-k3', servingHost: 'openrouter' }), // the maker's consent
    await port.run({ ...input, servingHost: 'somegateway' }), // HOST_ROUTE_UNKNOWN
    await port.run({ ...input, model: 'not-a-model-anyone-names' }), // WORKER_PROVIDER_UNKNOWN
    await (await loadWorkerPort({ kilo: s.kilo }, { env: {}, credentials: async () => [], providerConsent: reader({ moonshot: granted('moonshot') }) })).run({ ...input, servingHost: 'kilo' }), // HOST_NO_LOGIN
    await (await loadWorkerPort({ opencode: s.opencode }, { env: {}, credentials: async () => null, providerConsent: reader({ moonshot: granted('moonshot'), kilo: granted('kilo') }) })).run({ ...input, servingHost: 'kilo' }), // no harness
  ];
  assert.deepEqual(refusals.map((r) => [r.status === 'refused' || r.status === 'unsupported', r.spawned]), refusals.map(() => [true, false]), JSON.stringify(refusals.map((r) => r.reason)));
  assert.deepEqual(s.seen, [], 'no harness port ran');
  // Paired: a harness port that ran (and even one claiming spawned: false) never passes the claim on.
  const lying = async () => ({ run: async (run) => ({ status: 'refused', reason: 'refused: after start', sessionId: null, requestedModel: run.model, actualModel: null, costUsd: null, usage: null, turns: 0, durationMs: 0, spawned: false }) });
  const ran = await (await loadWorkerPort({ opencode: lying }, { env, credentials: async () => [], providerConsent: reader({ moonshot: granted('moonshot') }) })).run({ ...input, model: 'openrouter/moonshotai/kimi-k3' });
  assert.equal(ran.status, 'refused');
  assert.equal(ran.spawned, undefined);
});

test("B's invariant under C2's host-key fingerprint (97e737e9): an api-key host run's child has every stored login hidden (AUTH_CONTENT '{}'), and the key Jevris fingerprints is the one in the child's environment", async () => {
  const { opencodeWorkerEnv, OPENCODE_FLAVOR } = await import(new URL('../../../apps/cli/dist/opencode-worker.js', import.meta.url));
  const { KILO_FLAVOR } = await import(new URL('../../../apps/cli/dist/kilo-worker.js', import.meta.url));
  const s = stubs();
  const env = { PATH: '/bin', OPENROUTER_API_KEY: 'k-not-real-host', MOONSHOT_API_KEY: 'm-not-real-maker' };
  const port = await loadWorkerPort({ opencode: s.opencode }, { env, credentials: async () => [], providerConsent: reader({ moonshot: granted('moonshot') }) });
  const ran = await port.run({ ...input, servingHost: 'openrouter' });
  assert.deepEqual([ran.status, ran.authMode], ['completed', 'api-key']);
  const [seen] = s.seen;
  for (const flavor of [OPENCODE_FLAVOR, KILO_FLAVOR]) {
    // What F's port hands the child, from exactly what the dispatching port passed it.
    const child = opencodeWorkerEnv(flavor, { auth: seen.auth, allowedTools: [], maxTurns: 1, cwd: tmpdir() }, seen.env);
    assert.equal(child[`${flavor.prefix}_AUTH_CONTENT`], '{}', `${flavor.prefix}: a stored login could answer instead of the key`);
    assert.equal(child['OPENROUTER_API_KEY'], env['OPENROUTER_API_KEY']);
    assert.equal(child['MOONSHOT_API_KEY'], undefined, 'the maker key never reaches a host run');
    // The fingerprint the launch check and the resume tick compute is the child's own key's.
    const fingerprint = launchFingerprint(seen.harness, 'api-key', env, 'openrouter');
    assert.equal(fingerprint, credentialFingerprint(child['OPENROUTER_API_KEY']));
    assert.notEqual(fingerprint, credentialFingerprint(env['MOONSHOT_API_KEY']));
    // Paired: a subscription run keeps no AUTH_CONTENT override (its stored login answers) and no key to fingerprint.
    const login = opencodeWorkerEnv(flavor, { auth: 'subscription', allowedTools: [], maxTurns: 1, cwd: tmpdir() }, seen.env);
    assert.equal(login[`${flavor.prefix}_AUTH_CONTENT`], undefined);
    assert.equal(launchFingerprint(seen.harness, 'subscription', env, 'openrouter'), null);
  }
});
