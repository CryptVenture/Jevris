// G-9 (D's trace 3) and the host key (97e737e9): the key whose fingerprint an owned OpenCode or Kilo
// launch records is the one the child actually gets. The child's stored logins are hidden
// (`<PREFIX>_AUTH_CONTENT` is '{}'), so the environment variable is its only credential.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const oc = await import('../dist/opencode-worker.js');
const kc = await import('../dist/kilo-worker.js');
const { hostEnv, launchFingerprint, providerEnv, PROVIDER_KEY_VARS } = await import('@jevris/orchestrator');
const { credentialFingerprint } = await import('@jevris/core');

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-key-child-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const childOf = (flavor, auth, base, cwd) => oc.opencodeWorkerEnv(flavor, { auth, allowedTools: ['Read'], maxTurns: 1, cwd }, base);

for (const flavor of [oc.OPENCODE_FLAVOR, kc.KILO_FLAVOR]) {
  test(`${flavor.harness}: a direct API-key run's fingerprint is of the maker key its child gets, with every stored login hidden; a subscription child has no key and no fingerprint`, (t) => {
    const cwd = sandbox(t);
    const env = { MOONSHOT_API_KEY: 'dummy-maker-one', OPENROUTER_API_KEY: 'dummy-host-one' };
    const child = childOf(flavor, 'api-key', providerEnv('moonshot', 'api-key', env), cwd);
    assert.equal(child[`${flavor.prefix}_AUTH_CONTENT`], '{}', 'no stored login reaches a key run');
    assert.equal(child.MOONSHOT_API_KEY, env.MOONSHOT_API_KEY, 'the fingerprinted variable reaches the child unchanged');
    assert.equal(launchFingerprint(flavor.harness, 'api-key', env, 'moonshot'), credentialFingerprint(child.MOONSHOT_API_KEY));
    const sub = childOf(flavor, 'subscription', providerEnv('moonshot', 'subscription', env), cwd);
    assert.equal(sub.MOONSHOT_API_KEY, undefined);
    assert.equal(launchFingerprint(flavor.harness, 'subscription', env, 'moonshot'), null);
    // Two different keys across a maker's variables: which one the harness reads is not known, so none.
    const two = { GEMINI_API_KEY: 'dummy-maker-one', GOOGLE_API_KEY: 'dummy-maker-two' };
    assert.equal(PROVIDER_KEY_VARS.google.every((name) => childOf(flavor, 'api-key', providerEnv('google', 'api-key', two), cwd)[name] === two[name]), true);
    assert.equal(launchFingerprint(flavor.harness, 'api-key', two, 'google'), null);
  });

  test(`${flavor.harness}: a run through OpenRouter fingerprints the host key its child gets, and the child sees no maker key`, (t) => {
    const cwd = sandbox(t);
    const env = { MOONSHOT_API_KEY: 'dummy-maker-one', OPENROUTER_API_KEY: 'dummy-host-one' };
    const route = { provider: 'moonshot', modelId: 'kimi-k3', servingHost: 'openrouter' };
    const child = childOf(flavor, 'api-key', hostEnv(route, 'api-key', Object.values(PROVIDER_KEY_VARS).flat(), env), cwd);
    assert.equal(child[`${flavor.prefix}_AUTH_CONTENT`], '{}');
    assert.equal(child.MOONSHOT_API_KEY, undefined, 'the maker key never reaches a host run');
    assert.equal(launchFingerprint(flavor.harness, 'api-key', env, 'openrouter'), credentialFingerprint(child.OPENROUTER_API_KEY));
  });
}
