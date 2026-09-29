// The stub profiles (R33, OD-9): each harness in certify's throwaway profile is pointed at the
// loopback stub provider with a dummy key, and every provider route and credential the parent
// environment carried is removed. Pure functions: no harness binary, no file write, no real home.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

const sp = await import('../dist/stub-profile.js');
const { certifyEnv } = await import('../dist/certification.js');
const { scanToml, hasTomlTable } = await import('../dist/toml-edit.js');

const STUB = { baseUrl: 'http://127.0.0.1:43123', dummyKey: 'jevris-stub-key' };
const PROFILE = join('profile-root', 'certify-profile');
// Placeholders only: none of these is a credential.
const PARENT = {
  PATH: '/usr/bin',
  HOME: '/home/someone',
  LANG: 'C',
  ANTHROPIC_API_KEY: 'placeholder-anthropic',
  ANTHROPIC_AUTH_TOKEN: 'placeholder-token',
  ANTHROPIC_BASE_URL: 'https://gateway.invalid',
  ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock.invalid',
  ANTHROPIC_MODEL: 'placeholder-model',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_USE_VERTEX: '1',
  CLAUDE_CODE_USE_FOUNDRY: '1',
  CLAUDE_CODE_OAUTH_TOKEN: 'placeholder-oauth',
  OPENAI_API_KEY: 'placeholder-openai',
  OPENAI_BASE_URL: 'https://openai.invalid',
  CODEX_API_KEY: 'placeholder-codex',
  XAI_API_KEY: 'placeholder-xai',
  GEMINI_API_KEY: 'placeholder-gemini',
  OPENCODE_CONFIG_CONTENT: '{"placeholder":true}',
  NO_PROXY: 'corp.invalid',
};
const PLACEHOLDERS = Object.values(PARENT).filter((value) => value.startsWith('placeholder') || value.includes('.invalid') || value.startsWith('{'));

function noParentSecret(env) {
  for (const [key, value] of Object.entries(env)) {
    if (key === 'NO_PROXY' || key === 'no_proxy') continue;
    assert.equal(PLACEHOLDERS.includes(value), false, `${key} kept a value from the parent environment`);
  }
}

test('stub profile: Claude Code gets the stub base URL and dummy key, keeps its profile, and loses every other route and credential', () => {
  const { env: base } = certifyEnv('claude', PROFILE, PARENT, 'linux', null);
  const { env, files } = sp.stubProfileClaude(STUB, base);
  assert.deepEqual(files, []);
  assert.equal(env.ANTHROPIC_BASE_URL, STUB.baseUrl);
  assert.equal(env.ANTHROPIC_API_KEY, STUB.dummyKey);
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.equal(env.DISABLE_TELEMETRY, '1');
  assert.equal(env.CLAUDE_CONFIG_DIR, join(PROFILE, '.claude'));
  assert.equal(env.HOME, PROFILE);
  assert.equal(env.PATH, '/usr/bin');
  for (const gone of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY']) {
    assert.equal(env[gone], undefined, `${gone} reached the stub run`);
  }
  assert.equal(env.NO_PROXY, 'corp.invalid,127.0.0.1,localhost');
  assert.equal(env.no_proxy, env.NO_PROXY);
  noParentSecret(env);
});

test('stub profile: on macOS Claude Code keeps the account HOME that certifyEnv chose (keychain), and only the config folder is in the profile', () => {
  const { env: base } = certifyEnv('claude', PROFILE, PARENT, 'darwin', '/Users/someone');
  const { env } = sp.stubProfileClaude(STUB, base);
  assert.equal(env.HOME, '/Users/someone');
  assert.equal(env.CLAUDE_CONFIG_DIR, join(PROFILE, '.claude'));
});

test('stub profile: only a loopback 127.0.0.1 origin with a port and a short literal key are accepted', () => {
  const { env: base } = certifyEnv('claude', PROFILE, PARENT, 'linux', null);
  for (const baseUrl of ['https://api.anthropic.com', 'http://localhost:43123', 'http://127.0.0.1', 'http://127.0.0.1:43123/v1', 'http://127.0.0.2:43123', 'http://user@127.0.0.1:1']) {
    assert.throws(() => sp.stubProfileClaude({ ...STUB, baseUrl }, base), /STUB_NOT_LOOPBACK/, baseUrl);
  }
  assert.throws(() => sp.stubProfileClaude({ ...STUB, dummyKey: 'a b' }, base), /STUB_KEY_INVALID/);
  assert.throws(() => sp.stubOpencodeConfig(STUB, 'bad model"'), /STUB_MODEL_INVALID/);
});

test('stub profile: Codex gets a [model_providers.stub] Responses provider in the profile CODEX_HOME, and keeps the rest of its config', () => {
  const { env: base } = certifyEnv('codex', PROFILE, PARENT, 'linux', null);
  const fresh = sp.stubProfileCodex(STUB, base, 'gpt-5.5');
  assert.equal(fresh.env[sp.STUB_KEY_VARIABLE], STUB.dummyKey);
  assert.equal(fresh.env.CODEX_HOME, join(PROFILE, '.codex'));
  assert.equal(fresh.env.OPENAI_API_KEY, undefined);
  assert.equal(fresh.env.OPENAI_BASE_URL, undefined);
  assert.equal(fresh.env.CODEX_API_KEY, undefined);
  noParentSecret(fresh.env);
  assert.equal(fresh.files.length, 1);
  assert.equal(fresh.files[0].path, join(PROFILE, '.codex', 'config.toml'));
  assert.equal(
    fresh.files[0].content,
    [
      'model = "gpt-5.5"',
      'model_provider = "stub"',
      '',
      '[model_providers.stub]',
      'name = "Jevris stub provider"',
      'base_url = "http://127.0.0.1:43123/v1"',
      'wire_api = "responses"',
      'env_key = "JEVRIS_STUB_KEY"',
      '',
    ].join('\n'),
  );

  const existing = [
    '# installed by jevris',
    'model = "o-old"',
    'model_provider = "openai"',
    'approval_policy = "on-request"',
    '',
    '[model_providers.stub]',
    'name = "earlier"',
    'base_url = "http://127.0.0.1:1/v1"',
    '',
    '[profiles.fast]',
    'model = "kept-in-profile"',
    '',
    '[[hooks.PreToolUse]]',
    'command = "node hook.mjs"',
    '',
  ].join('\n');
  const merged = sp.stubCodexConfig(existing, STUB, 'gpt-5.5');
  assert.notEqual(scanToml(merged), null);
  assert.equal((merged.match(/^model = /gm) ?? []).length, 2, 'one top-level model and the profile model');
  assert.match(merged, /^model = "gpt-5\.5"\nmodel_provider = "stub"\n/);
  assert.doesNotMatch(merged, /o-old|"openai"|earlier|127\.0\.0\.1:1\//);
  assert.match(merged, /approval_policy = "on-request"/);
  assert.match(merged, /\[profiles\.fast\]\nmodel = "kept-in-profile"/);
  assert.match(merged, /\[\[hooks\.PreToolUse\]\]\ncommand = "node hook\.mjs"/);
  assert.equal(hasTomlTable(merged, ['model_providers', 'stub']), true);
  assert.equal((merged.match(/\[model_providers\.stub\]/g) ?? []).length, 1);
  assert.equal(sp.stubCodexConfig(merged, STUB, 'gpt-5.5'), merged, 'applying it again changes nothing');

  assert.throws(() => sp.stubProfileCodex(STUB, base, 'gpt-5.5', 'model = "unterminated\n'), /STUB_CONFIG_UNREADABLE/);
  const { CODEX_HOME: _dropped, ...noHome } = base;
  assert.throws(() => sp.stubProfileCodex(STUB, noHome, 'gpt-5.5'), /STUB_NO_PROFILE/);
});

test('stub profile: OpenCode and Kilo get inline config overriding the built-in anthropic provider, with no npm provider and no file', () => {
  for (const [harness, variable, other] of [
    ['opencode', 'OPENCODE_CONFIG_CONTENT', 'KILO_CONFIG_CONTENT'],
    ['kilocode', 'KILO_CONFIG_CONTENT', 'OPENCODE_CONFIG_CONTENT'],
  ]) {
    const { env: base } = certifyEnv(harness, PROFILE, PARENT, 'linux', null);
    const { env, files } = sp.stubProfileOpencode(harness, STUB, base, 'claude-sonnet-5');
    assert.deepEqual(files, []);
    assert.equal(env[other], undefined);
    const config = JSON.parse(env[variable]);
    assert.deepEqual(config, {
      provider: { anthropic: { options: { baseURL: 'http://127.0.0.1:43123/v1', apiKey: 'jevris-stub-key' } } },
      model: 'anthropic/claude-sonnet-5',
      autoupdate: false,
      share: 'disabled',
    });
    assert.doesNotMatch(env[variable], /npm/);
    assert.equal(env.XDG_CONFIG_HOME, join(PROFILE, '.config'));
    noParentSecret(env);
  }
});

test('stub profile: one entry per harness, and none for Antigravity (no custom endpoint, owner-run)', () => {
  assert.deepEqual([...sp.STUB_HARNESSES], ['claude', 'codex', 'opencode', 'kilocode']);
  for (const harness of ['claude', 'codex', 'opencode', 'kilocode']) {
    const { env: base } = certifyEnv(harness, PROFILE, PARENT, 'linux', null);
    const profile = sp.stubProfile(harness, STUB, base, { model: 'claude-sonnet-5' });
    assert.notEqual(profile, null, harness);
    assert.equal(sp.isStubHarness(harness), true);
    noParentSecret(profile.env);
  }
  const { env: base } = certifyEnv('antigravity', PROFILE, PARENT, 'linux', null);
  assert.equal(sp.stubProfile('antigravity', STUB, base, { model: 'gemini-3-pro' }), null);
  assert.equal(sp.isStubHarness('antigravity'), false);
  assert.throws(() => sp.stubProfile('claude', STUB, base, { model: '' }), /STUB_MODEL_INVALID/);
});
