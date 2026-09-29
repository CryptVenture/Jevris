// C's LOW B (coordinator): an owned run through a pinned serving host is paused, and records, on the
// host's scope, as a session through that host does; never on the maker's scope.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchAccessCheck, launchFingerprint, runAccessScope } from '../dist/index.js';
import { BUNDLED_MODEL_REGISTRY as registry, accessScopeOf, accessScopeOnHost, classifyAccessSignal, credentialFingerprint, recordAccessLimit } from '@jevris/core';

// pinned-clock: every record here is stamped at this fixed time.
const NOW = Date.parse('2026-09-28T12:00:00Z');

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-host-scope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const credit = (port) => classifyAccessSignal({ port, channel: 'structured', certified: false, errorType: 'APIError', status: 402 }, 'api-key', NOW);

test('core: a run through a pinned host has the host scope with the maker\'s model; an unpinned host or unknown model has none', () => {
  assert.deepEqual(accessScopeOnHost(registry, 'opencode', 'moonshot', 'kimi-k3', 'openrouter', 'api-key'), { harness: 'opencode', authMode: 'api-key', servingHost: 'openrouter', modelId: 'kimi-k3', family: accessScopeOf(registry, 'opencode', 'openrouter/moonshotai/kimi-k3', 'api-key').family });
  assert.equal(accessScopeOnHost(registry, 'opencode', 'moonshot', 'kimi-k3', 'example.com', 'api-key'), null, 'an unpinned host records nothing (OP-12)');
  assert.equal(accessScopeOnHost(registry, 'opencode', 'moonshot', 'no-such-model', 'openrouter', 'api-key'), null);
  assert.equal(accessScopeOnHost(registry, 'nope', 'moonshot', 'kimi-k3', 'openrouter', 'api-key'), null);
  assert.equal(accessScopeOnHost(registry, 'opencode', 'moonshot', 'kimi-k3', 'openrouter', 'whatever').authMode, 'unknown');
});

test('runAccessScope: the pinned host when the run names one, the maker otherwise; the session\'s scope for the same route is the same', () => {
  const viaHost = runAccessScope(registry, 'opencode', 'kimi-k3', 'api-key', null, 'openrouter');
  assert.equal(viaHost.servingHost, 'openrouter');
  assert.equal(viaHost.modelId, 'kimi-k3');
  const session = accessScopeOf(registry, 'opencode', 'openrouter/moonshotai/kimi-k3', 'api-key');
  assert.deepEqual(viaHost, session, 'an owned run and a session through the host share one scope');
  assert.equal(runAccessScope(registry, 'kilo', 'kimi-k3', 'api-key', null, 'openrouter').harness, 'kilocode');
  assert.equal(runAccessScope(registry, 'opencode', 'kimi-k3', 'api-key').servingHost, 'moonshot', 'a direct run stays on the maker');
  assert.equal(runAccessScope(registry, 'opencode', 'kimi-k3', 'api-key', null, 'example.com'), null, 'HOST_ROUTE_UNKNOWN records nothing');
  assert.equal(runAccessScope(registry, 'opencode', 'no-such-model', 'api-key', null, 'openrouter'), null);
  // The reported model does not move a host run back to the maker.
  assert.equal(runAccessScope(registry, 'opencode', 'kimi-k3', 'api-key', 'moonshotai/kimi-k3', 'openrouter').servingHost, 'openrouter');
});

test('the launch check: a host pause a session recorded stops an owned run through that host, and neither scope pauses the other', async (t) => {
  const dir = home(t);
  // A session through OpenRouter hit a 402: recorded on opencode api-key openrouter.
  const session = accessScopeOf(registry, 'opencode', 'openrouter/moonshotai/kimi-k3', 'api-key');
  assert.equal((await recordAccessLimit({ home: dir, scope: session, classification: credit('opencode'), source: 'session', nowMs: NOW })).ok, true);
  const check = (servingHost) => launchAccessCheck({ home: dir, registry, harness: 'opencode', model: 'kimi-k3', authMode: 'api-key', env: {}, nowMs: NOW + 1, ...(servingHost === undefined ? {} : { servingHost }) });
  const viaHost = await check('openrouter');
  assert.equal(viaHost.pause?.class, 'credit-exhausted');
  assert.equal(viaHost.scope.servingHost, 'openrouter');
  assert.equal((await check()).pause, null, 'the maker\'s own API is not the host: a direct run is not paused');
  // A pause on the maker does not pause the host route.
  const other = home(t);
  const maker = runAccessScope(registry, 'opencode', 'kimi-k3', 'api-key');
  assert.equal((await recordAccessLimit({ home: other, scope: maker, classification: credit('opencode'), source: 'owned-run', nowMs: NOW })).ok, true);
  assert.equal((await launchAccessCheck({ home: other, registry, harness: 'opencode', model: 'kimi-k3', authMode: 'api-key', env: {}, nowMs: NOW + 1, servingHost: 'openrouter' })).pause, null);
});

test('the coordinator\'s 1.2 decision after LOW B: an API-key run through a pinned host fingerprints the host\'s own key, the one hostEnv passes; never the maker\'s', () => {
  const env = { OPENROUTER_API_KEY: 'dummy-host-one', MOONSHOT_API_KEY: 'dummy-maker-one', ANTHROPIC_API_KEY: 'dummy-maker-two' };
  const host = credentialFingerprint('dummy-host-one');
  assert.match(host, /^[0-9a-f]{16}$/);
  assert.equal(launchFingerprint('opencode', 'api-key', env, 'openrouter'), host);
  assert.equal(launchFingerprint('kilo', 'api-key', env, 'openrouter'), host);
  assert.equal(launchFingerprint('opencode', 'subscription', env, 'openrouter'), null, 'a subscription host run has no fingerprint');
  assert.equal(launchFingerprint('opencode', 'unknown', env, 'openrouter'), null);
  assert.equal(launchFingerprint('opencode', 'api-key', { MOONSHOT_API_KEY: 'dummy-maker-one' }, 'openrouter'), null, 'the maker key never stands in for the host key');
  assert.equal(launchFingerprint('opencode', 'api-key', { OPENROUTER_API_KEY: '' }, 'openrouter'), null);
  assert.equal(launchFingerprint('kilo', 'api-key', env, 'kilo'), null, 'the Kilo Gateway is a login, not a key');
  assert.equal(launchFingerprint('opencode', 'api-key', env, 'moonshot'), credentialFingerprint('dummy-maker-one'), 'a direct OpenCode run has the maker key (G-9)');
  assert.equal(launchFingerprint('opencode', 'api-key', env), null, 'no scope host, no key');
  assert.equal(launchFingerprint('claude', 'api-key', env, 'anthropic'), credentialFingerprint('dummy-maker-two'), 'a maker host keeps the harness rule');
  assert.equal(launchFingerprint('claude', 'api-key', env), credentialFingerprint('dummy-maker-two'));
});

test('G-9 (D\'s trace 3): a direct API-key OpenCode or Kilo run fingerprints the maker key Jevris passes, on the scope\'s maker host; two different keys across a maker\'s variables give none', () => {
  // D's ask: a direct run's scope names the maker's provider id, the key both the launch check and the resume tick look up.
  for (const harness of ['opencode', 'kilo']) {
    assert.equal(runAccessScope(registry, harness, 'kimi-k3', 'api-key').servingHost, 'moonshot', harness);
    assert.equal(runAccessScope(registry, harness, 'glm-5.3', 'api-key').servingHost, 'zai', harness);
  }
  const one = credentialFingerprint('dummy-maker-one');
  for (const harness of ['opencode', 'kilo']) {
    assert.equal(launchFingerprint(harness, 'api-key', { MOONSHOT_API_KEY: 'dummy-maker-one', OPENROUTER_API_KEY: 'dummy-host-one' }, 'moonshot'), one, `${harness}: the maker key, never the host key`);
    assert.equal(launchFingerprint(harness, 'api-key', { ZHIPU_API_KEY: 'dummy-maker-one' }, 'zai'), one);
    assert.equal(launchFingerprint(harness, 'subscription', { MOONSHOT_API_KEY: 'dummy-maker-one' }, 'moonshot'), null, 'a subscription run has no fingerprint');
    assert.equal(launchFingerprint(harness, 'unknown', { MOONSHOT_API_KEY: 'dummy-maker-one' }, 'moonshot'), null);
    assert.equal(launchFingerprint(harness, 'api-key', { ANTHROPIC_API_KEY: 'dummy-maker-one' }, 'moonshot'), null, 'another maker\'s key never stands in');
    assert.equal(launchFingerprint(harness, 'api-key', { GEMINI_API_KEY: 'dummy-maker-one', GOOGLE_API_KEY: 'dummy-maker-one' }, 'google'), one, 'the same key in both variables');
    assert.equal(launchFingerprint(harness, 'api-key', { GEMINI_API_KEY: 'dummy-maker-one', GOOGLE_API_KEY: 'dummy-maker-two' }, 'google'), null, 'which one the harness reads is not known');
    assert.equal(launchFingerprint(harness, 'api-key', { OPENAI_API_KEY: 'dummy-maker-one', CODEX_API_KEY: 'dummy-maker-two' }, 'openai'), null);
    assert.equal(launchFingerprint(harness, 'api-key', { OPENAI_API_KEY: 'dummy-maker-one' }, 'openai'), one);
    assert.equal(launchFingerprint(harness, 'api-key', { MOONSHOT_API_KEY: 'dummy-maker-one' }, 'example'), null, 'a host Jevris does not know');
  }
  assert.equal(launchFingerprint('antigravity', 'api-key', { GEMINI_API_KEY: 'dummy-maker-one' }, 'google'), null, 'Antigravity: no key Jevris passes');
  assert.equal(launchFingerprint('codex', 'api-key', { OPENAI_API_KEY: 'dummy-maker-one', CODEX_API_KEY: 'dummy-maker-two' }, 'openai'), credentialFingerprint('dummy-maker-two'), 'Codex keeps its own rule');
});
