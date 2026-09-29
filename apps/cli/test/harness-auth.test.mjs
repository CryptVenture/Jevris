// Per-harness auth mode (owner decision 2026-09-26): a subscription login and an API key are
// both first-class. Only the mode is read or shown, never a value; detection asks the harness
// (a stub here, never the real binary).
import test from 'node:test';
import assert from 'node:assert/strict';

const { parseClaudeAuthStatus, parseCodexLoginStatus, parseProviderAuthList, detectAuth, workerEnv, authProblem, authLine, VENDOR_KEYS } = await import('../dist/harness-auth.js');

test('claude auth status: the auth method alone decides the mode; every other field is ignored', () => {
  const status = (over) => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'someone@example.invalid', orgId: 'org', subscriptionType: 'max', ...over });
  assert.equal(parseClaudeAuthStatus(status({})), 'subscription');
  assert.equal(parseClaudeAuthStatus(status({ authMethod: 'oauth_token', subscriptionType: null })), 'subscription');
  assert.equal(parseClaudeAuthStatus(status({ authMethod: 'api_key' })), 'api-key');
  assert.equal(parseClaudeAuthStatus(status({ apiProvider: 'bedrock', authMethod: 'something' })), 'api-key');
  assert.equal(parseClaudeAuthStatus(status({ loggedIn: false, authMethod: 'none' })), 'signed-out');
  assert.equal(parseClaudeAuthStatus(status({ authMethod: 'future-kind' })), 'unknown');
  assert.equal(parseClaudeAuthStatus('not json'), 'unknown');
  assert.equal(parseClaudeAuthStatus('[]'), 'unknown');
});

test('codex login status: ChatGPT is a subscription, a stored key is api-key', () => {
  assert.equal(parseCodexLoginStatus('Logged in using ChatGPT\n'), 'subscription');
  assert.equal(parseCodexLoginStatus('Logged in using an API key - sk-proj-***ABCD\n'), 'api-key');
  assert.equal(parseCodexLoginStatus('Not logged in\n'), 'signed-out');
  assert.equal(parseCodexLoginStatus(''), 'unknown');
});

const allow = () => null;

test('detection asks the harness read-only, and says unknown when it cannot', async () => {
  const ran = [];
  const cli = (stdout, available = true, spawned = true) => ({
    available: () => available,
    run: async (file, args) => {
      ran.push([file, ...args]);
      return { spawned, code: 0, stdout };
    },
  });
  assert.equal(await detectAuth('claude', cli(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })), {}, allow), 'subscription');
  assert.equal(await detectAuth('codex', cli('Logged in using ChatGPT'), {}, allow), 'subscription');
  assert.deepEqual(ran, [['claude', 'auth', 'status', '--json'], ['codex', 'login', 'status']]);
  assert.equal(await detectAuth('claude', cli('', false), {}, allow), 'unknown', 'not on PATH');
  assert.equal(await detectAuth('codex', cli('', true, false), {}, allow), 'unknown', 'did not start');
  assert.equal(await detectAuth('opencode', cli('anything'), {}, allow), 'unknown', 'output it cannot read is unknown');
  const onStderr = { available: () => true, run: async () => ({ spawned: true, code: 0, stdout: '', stderr: 'Logged in using ChatGPT\n' }) };
  assert.equal(await detectAuth('codex', onStderr, {}, allow), 'subscription', 'codex login status prints on stderr');
  // By default a test run never asks a harness, stub or not.
  assert.equal(await detectAuth('claude', cli('{}')), 'not-probed');
  assert.equal(ran.length, 4, 'claude, codex and opencode were asked, plus the one that did not start');
});

// `opencode auth list` / `kilo auth list` as OpenCode 1.18.32 and Kilo 7.7.9 print it (captured
// under a temp HOME with dummy credentials): clack glyphs, a dim ANSI code before each type.
const listing = (entries, env = []) =>
  [
    '\u001b[0m',
    '\u250c  Credentials \u001b[90m~/.local/share/opencode/auth.json',
    '\u2502',
    ...entries.flatMap(([name, type]) => [`\u25cf  ${name} \u001b[90m${type}`, '\u2502']),
    `\u2514  ${entries.length} credentials`,
    '',
    ...(env.length === 0 ? [] : ['\u250c  Environment', '\u2502', ...env.map(([name, variable]) => `\u25cf  ${name} \u001b[90m${variable}`), `\u2514  ${env.length} environment variable`]),
  ].join('\n');

test('opencode and kilo auth list: a stored OAuth login is a subscription, only stored keys an API key, none no login; never a value', async () => {
  assert.equal(parseProviderAuthList(listing([['xAI', 'oauth'], ['OpenAI', 'api']])), 'subscription');
  assert.equal(parseProviderAuthList(listing([['xAI', 'api'], ['Vercel', 'wellknown']])), 'api-key');
  assert.equal(parseProviderAuthList(listing([])), 'signed-out');
  assert.equal(parseProviderAuthList(listing([['Anthropic', 'oauth']])), 'signed-out', 'an Anthropic login may not be used through OpenCode or Kilo (ANTHROPIC_LOGIN_THIRD_PARTY)');
  assert.equal(parseProviderAuthList(listing([['Anthropic', 'oauth'], ['xAI', 'api']])), 'api-key');
  assert.equal(parseProviderAuthList(listing([], [['Anthropic', 'ANTHROPIC_API_KEY']])), 'signed-out', 'environment variables are not stored logins');
  assert.equal(parseProviderAuthList('\u250c  Credentials\n\u25cf  xAI oauth\n'), 'unknown', 'no count line: cut short');
  assert.equal(parseProviderAuthList(''), 'unknown');

  const ran = [];
  const cli = { available: () => true, run: async (file, args, _ms, env) => (ran.push({ file, args, env }), { spawned: true, code: 0, stdout: listing([['xAI', 'oauth']]) }) };
  assert.equal(await detectAuth('opencode', cli, { PATH: '/bin' }, allow), 'subscription');
  assert.equal(await detectAuth('kilo', cli, { PATH: '/bin' }, allow), 'subscription');
  assert.deepEqual(ran.map((call) => [call.file, ...call.args]), [['opencode', 'auth', 'list'], ['kilo', 'auth', 'list']]);
  assert.deepEqual([ran[0].env.OPENCODE_DISABLE_MODELS_FETCH, ran[0].env.OPENCODE_DISABLE_AUTOUPDATE, ran[0].env.PATH], ['1', '1', '/bin'], 'no models.dev fetch, no update check');
  assert.deepEqual([ran[1].env.KILO_DISABLE_MODELS_FETCH, ran[1].env.KILO_NO_DAEMON], ['1', '1'], 'Kilo: no fetch, and never a daemon');
  assert.equal(authLine({ harness: 'opencode', setting: 'auto', mode: 'subscription', keysInEnvironment: [], detected: 'subscription', problem: null }), 'harness opencode auth: subscription (auto: no vendor key in the environment; the harness reports a subscription login)');
});

test('workerEnv: a subscription run never sees a vendor key; a key run never sees the subscription token', () => {
  const env = { PATH: '/bin', ANTHROPIC_API_KEY: 'a', ANTHROPIC_AUTH_TOKEN: 'b', OPENAI_API_KEY: 'o', CODEX_API_KEY: 'c', CLAUDE_CODE_OAUTH_TOKEN: 't', CODEX_ACCESS_TOKEN: 'x', EMPTY: undefined };
  const sub = workerEnv('claude', 'subscription', env);
  for (const key of VENDOR_KEYS) assert.equal(key in sub, false, key);
  assert.equal(sub.CLAUDE_CODE_OAUTH_TOKEN, 't');
  assert.equal('EMPTY' in sub, false);
  const key = workerEnv('claude', 'api-key', env);
  assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in key, false);
  assert.equal('CODEX_ACCESS_TOKEN' in key, false);
  assert.equal(key.ANTHROPIC_API_KEY, 'a');
  assert.deepEqual(workerEnv('codex', 'api-key', { OPENAI_API_KEY: 'o' }), { OPENAI_API_KEY: 'o', CODEX_API_KEY: 'o' }, 'codex exec reads CODEX_API_KEY');
  assert.deepEqual(workerEnv('codex', undefined, env), { PATH: '/bin', ANTHROPIC_API_KEY: 'a', ANTHROPIC_AUTH_TOKEN: 'b', OPENAI_API_KEY: 'o', CODEX_API_KEY: 'c', CLAUDE_CODE_OAUTH_TOKEN: 't', CODEX_ACCESS_TOKEN: 'x' }, 'no decided mode: unchanged');
});

test('the doctor line names the mode, where it came from and what would stop a run, never a value', () => {
  const view = (over) => ({ harness: 'claude', setting: 'auto', mode: 'subscription', keysInEnvironment: [], detected: 'subscription', problem: null, ...over });
  assert.equal(authLine(view({})), 'harness claude auth: subscription (auto: no vendor key in the environment; the harness reports a subscription login)');
  assert.equal(authLine(view({ mode: 'api-key', keysInEnvironment: ['ANTHROPIC_API_KEY'], detected: 'api-key' })), 'harness claude auth: api-key (auto: ANTHROPIC_API_KEY in the environment; the harness reports an API key)');
  assert.equal(authLine(view({ harness: 'kilo', setting: 'subscription', detected: 'unknown' })), 'harness kilo auth: subscription (stated in workers.json; not detected)');
  assert.equal(authProblem('claude', 'api-key', ['ANTHROPIC_API_KEY'], [], 'subscription', {}), 'api-key mode needs ANTHROPIC_API_KEY in the environment');
  assert.equal(authProblem('codex', 'subscription', ['OPENAI_API_KEY', 'CODEX_API_KEY'], [], 'signed-out', {}), 'not signed in; run codex login');
  assert.equal(authProblem('claude', 'subscription', ['ANTHROPIC_API_KEY'], [], 'signed-out', { CLAUDE_CODE_OAUTH_TOKEN: 't' }), null, 'a setup-token in the environment is a login');
  assert.equal(authProblem('kilo', 'api-key', [], [], 'unknown', {}), null, 'Kilo keeps its keys in its own config');
});

test('Grok in Kilo and OpenCode: a subscription run never sees XAI_API_KEY, and doctor names the key (the name only) when it is set', async () => {
  const { MODEL_KEYS } = await import('../dist/harness-auth.js');
  assert.ok(VENDOR_KEYS.includes('XAI_API_KEY'));
  const env = { PATH: '/bin', XAI_API_KEY: 'secret-xai-value' };
  for (const harness of ['kilo', 'opencode']) {
    assert.equal('XAI_API_KEY' in workerEnv(harness, 'subscription', env), false, `${harness} subscription run`);
    assert.equal(workerEnv(harness, 'api-key', env).XAI_API_KEY, 'secret-xai-value', `${harness} api-key run keeps the key`);
    assert.deepEqual(MODEL_KEYS[harness], ['XAI_API_KEY']);
  }
  assert.deepEqual(MODEL_KEYS.claude, []);
  assert.deepEqual(MODEL_KEYS.codex, []);
  const view = (over) => ({ harness: 'opencode', setting: 'api-key', mode: 'api-key', keysInEnvironment: [], modelKeysInEnvironment: ['XAI_API_KEY'], detected: 'unknown', problem: null, ...over });
  const stated = authLine(view({}));
  assert.equal(stated, 'harness opencode auth: api-key (stated in workers.json; not detected; XAI_API_KEY in the environment for Grok models)');
  assert.equal(stated.includes('secret-xai-value'), false);
  assert.doesNotMatch(stated, /required|SuperGrok/, 'a SuperGrok login works too: no key is required');
  const unknown = authLine(view({ harness: 'kilo', setting: 'auto', mode: 'subscription' }));
  assert.match(unknown, /^harness kilo auth: unknown \(not detected, and not stated; XAI_API_KEY in the environment for Grok models\); state it in /);
  assert.equal(authLine(view({ modelKeysInEnvironment: [] })), 'harness opencode auth: api-key (stated in workers.json; not detected)');
});

test('D\'s entry @jevris/cli/harness-auth: detectHarnessAuth takes the global or worker name and never asks a harness in a test run', async () => {
  const entry = await import('@jevris/cli/harness-auth');
  assert.equal(typeof entry.detectHarnessAuth, 'function');
  for (const harness of ['opencode', 'kilocode', 'kilo', 'claude', 'codex']) assert.equal(await entry.detectHarnessAuth(harness, { JEVRIS_TEST: '1' }), 'not-probed', harness);
});

test('providerCredentials: the stored credentials by provider and type for D, from the one parser; null when it cannot tell', async () => {
  const { parseProviderCredentials } = await import('../dist/harness-auth.js');
  assert.deepEqual(parseProviderCredentials(listing([['xAI', 'oauth'], ['OpenAI', 'api'], ['Vercel', 'wellknown']], [['Anthropic', 'ANTHROPIC_API_KEY']])), [
    { provider: 'xAI', type: 'oauth' },
    { provider: 'OpenAI', type: 'api' },
    { provider: 'Vercel', type: 'wellknown' },
  ]);
  assert.deepEqual(parseProviderCredentials(listing([])), []);
  assert.equal(parseProviderCredentials('┌  Credentials\n●  xAI oauth\n'), null, 'cut short');
  assert.equal(parseProviderCredentials('something else'), null);
  const entry = await import('@jevris/cli/harness-auth');
  for (const harness of ['opencode', 'kilo', 'kilocode']) assert.equal(await entry.providerCredentials(harness, { JEVRIS_TEST: '1' }), null, 'never asked in a test run');
});
