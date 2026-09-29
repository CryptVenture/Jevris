// Access-limit stub cases (access limits R69, K16-K20): the stub answers with a scripted error in
// the API's own shape, and stand-in harnesses turn it into the transcript, hook payload or plugin
// event the real binary would. No real harness starts, no model is called, and the temp profile is
// the only home. Every scripted body and header carries a canary that must never be kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runStubCases, stubCaseLines, accessVerdict, accessErrorReply, stopFailureVerdict, sessionErrorVerdict, readAccessProbeRecords, ACCESS_CANARY, ACCESS_CASE_CLASS, ACCESS_CASE_TIMEOUT_MS } = await import('../dist/stub-cases.js');
const { startStubProvider } = await import('../dist/stub-provider.js');
const { accessChecks } = await import('../dist/certification.js');

async function withProfile(fn) {
  const profile = await mkdtemp(join(tmpdir(), 'jevris-stub-access-'));
  try {
    await mkdir(join(profile, '.codex'), { recursive: true });
    const env = { PATH: process.env.PATH, HOME: profile, CODEX_HOME: join(profile, '.codex'), JEVRIS_HOOK_OBSERVE_ONLY: '1', ANTHROPIC_API_KEY: 'sk-real-looking', OPENAI_API_KEY: 'sk-real-looking' };
    return await fn(profile, env);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

/** A stand-in CLI: `behave(file, args, env, cwd)` plays the harness and returns its exit and output. */
function cli(behave) {
  const calls = [];
  return {
    calls,
    cli: {
      available: () => true,
      run: async (file, args, _timeout, env, options) => {
        calls.push({ file, args: [...args] });
        const out = await behave(file, args, env, options?.cwd ?? null);
        return { spawned: true, code: out.code, stdout: out.stdout, stderr: out.stderr ?? '' };
      },
    },
  };
}

const lines = (events) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
const CLAUDE_ENUM = { rate_limit_error: 'rate_limit', billing_error: 'billing_error', authentication_error: 'authentication_failed' };

async function call(url, headers, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: response.status, headers: Object.fromEntries(response.headers), text: await response.text() };
}

/**
 * Claude Code with the stub profile: the request, then the stream-json of a failed turn, and a
 * StopFailure hook when --settings names one, in the hooks reference's shape (`error`,
 * `error_details`, `last_assistant_message`; no `error_type`, as 2.1.283 sent in the owner's run).
 * Like 2.1.283, it retries a 429 or a 401 itself: without CLAUDE_CODE_MAX_RETRIES=1, or with
 * CLAUDE_CODE_RETRY_WATCHDOG set, it is still retrying at the case's bound (exit 124).
 */
async function playClaude(args, env, cwd, options = {}) {
  const reply = await call(`${env.ANTHROPIC_BASE_URL}/v1/messages`, { 'x-api-key': env.ANTHROPIC_API_KEY }, { model: 'claude-haiku-4-5', max_tokens: 8, messages: [{ role: 'user', content: 'ok' }] });
  const body = JSON.parse(reply.text);
  const code = CLAUDE_ENUM[body.error.type];
  const retried = reply.status === 429 || reply.status === 401;
  if (retried && (env.CLAUDE_CODE_MAX_RETRIES !== '1' || env.CLAUDE_CODE_RETRY_WATCHDOG !== undefined)) return { code: 124, stdout: '' };
  const settings = args.includes('--settings') ? JSON.parse(args[args.indexOf('--settings') + 1]) : null;
  const runHook = (event, payload) => {
    const hook = settings?.hooks?.[event]?.[0]?.hooks?.[0]?.command;
    if (hook === undefined || options.hooks === false) return;
    const [node, probe] = hook.split(' ').map((part) => JSON.parse(part));
    execFileSync(node, [probe], { input: JSON.stringify({ hook_event_name: event, session_id: 'ses_1', transcript_path: join(cwd, 't.jsonl'), cwd, permission_mode: 'default', ...payload }) });
  };
  runHook('UserPromptSubmit', { prompt: 'Reply with the single word ok.' });
  if (options.stopFailure !== false) runHook('StopFailure', { error: options.errorType ?? code, error_details: `${reply.status} ${body.error.message}`, last_assistant_message: `API Error: ${reply.text}` });
  return {
    code: 1,
    stdout: lines([
      { type: 'system', subtype: 'init', model: 'claude-haiku-4-5' },
      ...(retried ? [{ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 1, retry_delay_ms: 1000, error_status: reply.status, error: code }] : []),
      { type: 'assistant', error: code, message: { content: [{ type: 'text', text: `API Error: ${reply.status} ${reply.text}` }] } },
      { type: 'result', subtype: 'success', is_error: true, result: `API Error: ${reply.status} ${reply.text}` },
    ]),
  };
}

/**
 * Codex exec with the stub provider: its error event and turn.failed carry Codex's own text, as
 * 0.157.1 prints it (openai/codex rust-v0.157.1, codex-api/src/api_bridge.rs and
 * protocol/src/error.rs): a 429 whose body says insufficient_quota is CodexErr::QuotaExceeded, with
 * the body dropped; any other 429 is "exceeded retry limit"; other statuses keep the body's message.
 */
async function playCodex(args, env) {
  const toml = await readFile(join(env.CODEX_HOME, 'config.toml'), 'utf8');
  const base = /base_url = "([^"]+)"/.exec(toml)[1];
  const key = env[/env_key = "([^"]+)"/.exec(toml)?.[1] ?? ''] ?? 'jevris-stub-key';
  const reply = await call(`${base}/responses`, { authorization: `Bearer ${key}` }, { model: 'gpt-5.5', stream: true, input: 'ok' });
  const error = JSON.parse(reply.text).error;
  const message =
    reply.status === 429 && (error.type === 'insufficient_quota' || error.code === 'insufficient_quota')
      ? 'Quota exceeded. Check your plan and billing details.'
      : reply.status === 429
        ? 'exceeded retry limit, last status: 429 Too Many Requests'
        : `unexpected status ${reply.status}: ${error.message}`;
  return { code: 1, stdout: lines([{ type: 'thread.started', thread_id: 't1' }, { type: 'turn.started' }, { type: 'error', message }, { type: 'turn.failed', error: { message } }]), stderr: `ERROR: ${message}\n` };
}

/** Kilo or OpenCode run --format json: an error event, and the probe plugin's bus events when one is configured. */
async function playPlugin(harness, env, options = {}) {
  const key = harness === 'kilocode' ? 'KILO_CONFIG_CONTENT' : 'OPENCODE_CONFIG_CONTENT';
  const config = JSON.parse(env[key]);
  const { baseURL, apiKey } = config.provider.anthropic.options;
  const reply = await call(`${baseURL}/messages`, { 'x-api-key': apiKey }, { model: 'claude-haiku-4-5', max_tokens: 8, messages: [{ role: 'user', content: 'ok' }] });
  const error = { name: 'APIError', data: { message: JSON.parse(reply.text).error.message, statusCode: reply.status, isRetryable: reply.status === 429, responseHeaders: reply.headers, responseBody: reply.text } };
  if (Array.isArray(config.plugin) && options.load !== false) {
    const plugin = await import(config.plugin[0]);
    const hooks = await plugin.JevrisStubProbe({});
    if (options.bus !== false) await hooks.event({ event: { type: 'message.updated', properties: { info: { id: 'msg_1', sessionID: 'ses_1', role: 'assistant', providerID: 'anthropic', modelID: 'claude-haiku-4-5', error } } } });
    if (options.bus !== false) await hooks.event({ event: { type: 'session.error', properties: { sessionID: 'ses_1', error } } });
  }
  return { code: 1, stdout: lines([{ type: 'step_start' }, { type: 'error', sessionID: 'ses_1', error }]) };
}

function play(harness, options) {
  return cli(async (_file, args, env, cwd) => (harness === 'claude' ? playClaude(args, env, cwd, options) : harness === 'codex' ? playCodex(args, env) : playPlugin(harness, env, options)));
}

const byId = (list) => Object.fromEntries(list.map((item) => [item.id, item]));

test('the scripted error replies carry each API\'s own codes, the canary, and the reset headers on a rate limit', async () => {
  const now = Date.parse('2026-09-28T10:00:00Z');
  const rate = accessErrorReply('anthropic', 'rate', now);
  assert.deepEqual([rate.kind, rate.status, rate.body.error.type, rate.headers['retry-after'], rate.headers['anthropic-ratelimit-requests-reset']], ['error', 429, 'rate_limit_error', '1', '2026-09-28T10:30:00.000Z']);
  assert.deepEqual([accessErrorReply('anthropic', 'credit', now).status, accessErrorReply('anthropic', 'credit', now).body.error.type], [402, 'billing_error']);
  assert.deepEqual([accessErrorReply('anthropic', 'auth', now).status, accessErrorReply('anthropic', 'auth', now).body.error.type], [401, 'authentication_error']);
  assert.deepEqual([accessErrorReply('openai', 'rate', now).body.error.code, accessErrorReply('openai', 'rate', now).headers['x-ratelimit-reset-requests']], ['rate_limit_exceeded', '30m0s']);
  assert.deepEqual([accessErrorReply('openai', 'credit', now).status, accessErrorReply('openai', 'credit', now).body.error.code], [429, 'insufficient_quota']);
  assert.equal(accessErrorReply('openai', 'auth', now).body.error.code, 'invalid_api_key');
  for (const api of ['anthropic', 'openai']) {
    for (const kind of ['rate', 'credit', 'auth']) {
      const reply = accessErrorReply(api, kind, now);
      assert.match(JSON.stringify(reply.body), new RegExp(ACCESS_CANARY));
      assert.equal(reply.headers['x-jevris-canary'], ACCESS_CANARY);
    }
  }
  const stub = await startStubProvider({ script: () => accessErrorReply('anthropic', 'rate', Date.now()) });
  try {
    const reply = await call(`${stub.baseUrl}/v1/messages`, { 'x-api-key': stub.dummyKey }, { model: 'claude-haiku-4-5', max_tokens: 8, messages: [] });
    assert.equal(reply.status, 429);
    assert.equal(reply.headers['retry-after'], '1');
    assert.equal(JSON.parse(reply.text).error.type, 'rate_limit_error');
  } finally {
    await stub.close();
  }
});

for (const harness of ['claude', 'codex', 'opencode', 'kilocode']) {
  test(`${harness}.access-limit.* (K16-K18): the port's parser reads the scripted error, core gives the case's class, and no canary is kept`, async () => {
    await withProfile(async (profile, env) => {
      const fake = play(harness);
      const results = byId(await runStubCases({ harness, cli: fake.cli, env, profile, hookEntry: null, timeoutMs: 5000 }));
      for (const kind of ['rate', 'credit', 'auth']) {
        const found = results[`${harness}.access-limit.${kind}`];
        assert.ok(found, `${harness}.access-limit.${kind} ran`);
        assert.equal(found.passed, true, `${kind}: ${found.reasonCode} ${found.detail}`);
        assert.match(found.detail, new RegExp(ACCESS_CASE_CLASS[kind]));
        assert.doesNotMatch(JSON.stringify(found), new RegExp(ACCESS_CANARY));
      }
      assert.doesNotMatch(stubCaseLines(Object.values(results)).join('\n'), new RegExp(ACCESS_CANARY), "certify's printed case lines carry no canary");
      if (harness === 'opencode' || harness === 'kilocode') assert.match(results[`${harness}.access-limit.rate`].detail, /reset parsed/);
      if (harness === 'codex') {
        const run = fake.calls.find((item) => item.args.some((arg) => arg.includes('request_max_retries=0')));
        assert.ok(run, "Codex's documented provider retry count is set to 0 for the case");
      }
      if (harness === 'claude') {
        // A user's CLAUDE_CODE_RETRY_WATCHDOG would retry 429s indefinitely; the case removes it and caps retries at 1.
        const watched = play('claude');
        const again = byId(await runStubCases({ harness, cli: watched.cli, env: { ...env, CLAUDE_CODE_RETRY_WATCHDOG: '1', CLAUDE_CODE_MAX_RETRIES: '10' }, profile: await mkdtemp(join(profile, 'w-')), hookEntry: null, timeoutMs: 5000 }));
        for (const kind of ['rate', 'credit', 'auth']) assert.equal(again[`claude.access-limit.${kind}`].passed, true, `${kind}: ${again[`claude.access-limit.${kind}`].reasonCode}`);
      }
    });
  });
}

test('accessVerdict: a run that kept retrying, gave no signal, or reached another class fails with its reason', () => {
  const now = Date.now();
  assert.equal(accessVerdict('claude.access-limit.rate', 'claude', 'rate', { spawned: false, code: 1, stdout: '' }, now).reasonCode, 'HARNESS_NOT_STARTED');
  const timedOut = accessVerdict('claude.access-limit.rate', 'claude', 'rate', { spawned: true, code: 124, stdout: lines([{ type: 'assistant', error: 'rate_limit' }]) }, now);
  assert.deepEqual([timedOut.passed, timedOut.reasonCode], [false, 'HARNESS_KEPT_RETRYING'], 'a timeout is never a pass, whatever the transcript held');
  assert.match(timedOut.detail, new RegExp(`${ACCESS_CASE_TIMEOUT_MS / 1000} s bound`), 'the detail names the bound');
  assert.equal(ACCESS_CASE_TIMEOUT_MS, 60_000);
  const ok = lines([{ type: 'result', subtype: 'success', is_error: false, result: 'ok' }]);
  assert.equal(accessVerdict('claude.access-limit.rate', 'claude', 'rate', { spawned: true, code: 0, stdout: ok }, now).reasonCode, 'NO_ACCESS_SIGNAL');
  const billing = lines([{ type: 'assistant', error: 'billing_error' }, { type: 'result', is_error: true, result: 'x' }]);
  const wrong = accessVerdict('claude.access-limit.rate', 'claude', 'rate', { spawned: true, code: 1, stdout: billing }, now);
  assert.deepEqual([wrong.passed, wrong.reasonCode], [false, 'WRONG_CLASS']);
  const noReset = lines([{ type: 'error', error: { name: 'APIError', data: { statusCode: 429, message: ACCESS_CANARY } } }]);
  assert.equal(accessVerdict('opencode.access-limit.rate', 'opencode', 'rate', { spawned: true, code: 1, stdout: noReset }, now).reasonCode, 'RESET_NOT_PARSED', 'OpenCode must carry the header reset');
  assert.equal(accessVerdict('opencode.access-limit.rate', 'opencode', 'rate', { spawned: true, code: 1, stdout: noReset }, now).detail.includes(ACCESS_CANARY), false);
});

test('claude.session.stop-failure (K19): the probe sees billing_error; the installed adapter keeps no text; a binary without the event is EVENT_ABSENT', async () => {
  await withProfile(async (profile, env) => {
    const fired = byId(await runStubCases({ harness: 'claude', cli: play('claude').cli, env, profile, hookEntry: null, timeoutMs: 5000 }))['claude.session.stop-failure'];
    assert.equal(fired.passed, true, `${fired.reasonCode} ${fired.detail}`);
    assert.match(fired.detail, /error_details/, 'the payload fields the binary sent are replayed');
    assert.match(fired.detail, /last_assistant_message/);
    assert.doesNotMatch(JSON.stringify(fired), new RegExp(ACCESS_CANARY));
    const absent = byId(await runStubCases({ harness: 'claude', cli: play('claude', { stopFailure: false }).cli, env, profile: await mkdtemp(join(profile, 'p2-')), hookEntry: null, timeoutMs: 5000 }))['claude.session.stop-failure'];
    assert.deepEqual([absent.passed, absent.reasonCode], [false, 'EVENT_ABSENT']);
    const other = byId(await runStubCases({ harness: 'claude', cli: play('claude', { errorType: 'unknown' }).cli, env, profile: await mkdtemp(join(profile, 'p3-')), hookEntry: null, timeoutMs: 5000 }))['claude.session.stop-failure'];
    assert.deepEqual([other.passed, other.reasonCode], [false, 'WRONG_ERROR_TYPE']);
    const echoed = byId(await runStubCases({ harness: 'claude', cli: play('claude', { errorType: ACCESS_CANARY }).cli, env, profile: await mkdtemp(join(profile, 'p5-')), hookEntry: null, timeoutMs: 5000 }))['claude.session.stop-failure'];
    assert.deepEqual([echoed.passed, echoed.reasonCode], [false, 'CANARY_KEPT'], 'a code-shaped canary a verdict would print is caught centrally');
    assert.doesNotMatch(JSON.stringify(echoed), new RegExp(ACCESS_CANARY));
    const noProbe = byId(await runStubCases({ harness: 'claude', cli: play('claude', { hooks: false }).cli, env, profile: await mkdtemp(join(profile, 'p4-')), hookEntry: null, timeoutMs: 5000 }))['claude.session.stop-failure'];
    assert.deepEqual([noProbe.passed, noProbe.reasonCode], [false, 'PROBE_NOT_RUN'], 'a probe that never ran is a failed case, never EVENT_ABSENT');
  });
  const work = await mkdtemp(join(tmpdir(), 'jevris-k19-'));
  try {
    const ok = lines([{ type: 'result', is_error: false, result: 'ok' }]);
    const control = [{ event: 'UserPromptSubmit', code: null, statusCode: null, keys: [] }];
    assert.equal(stopFailureVerdict('claude.session.stop-failure', control, { code: 0, stdout: ok }, work, Date.now()).reasonCode, 'TURN_NOT_FAILED', 'a turn that never reached the 402 is a failed case, never EVENT_ABSENT');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

for (const harness of ['kilocode', 'opencode']) {
  test(`${harness}.session.error (K20): APIError 402 reaches the plugin bus; the installed adapter reads a failed turn and keeps no text`, async () => {
    await withProfile(async (profile, env) => {
      const seen = byId(await runStubCases({ harness, cli: play(harness).cli, env, profile, hookEntry: null, timeoutMs: 5000 }))[`${harness}.session.error`];
      assert.equal(seen.passed, true, `${seen.reasonCode} ${seen.detail}`);
      assert.match(seen.detail, /responseBody/, "the error data's own fields are replayed");
      assert.doesNotMatch(JSON.stringify(seen), new RegExp(ACCESS_CANARY));
      const absent = byId(await runStubCases({ harness, cli: play(harness, { bus: false }).cli, env, profile: await mkdtemp(join(profile, 'p2-')), hookEntry: null, timeoutMs: 5000 }))[`${harness}.session.error`];
      assert.deepEqual([absent.passed, absent.reasonCode], [false, 'EVENT_ABSENT']);
      const unloaded = byId(await runStubCases({ harness, cli: play(harness, { load: false }).cli, env, profile: await mkdtemp(join(profile, 'p3-')), hookEntry: null, timeoutMs: 5000 }))[`${harness}.session.error`];
      assert.deepEqual([unloaded.passed, unloaded.reasonCode], [false, 'PROBE_NOT_LOADED'], 'a probe that never loaded is a failed case, never EVENT_ABSENT');
    });
    const loaded = { event: 'probe.loaded', code: null, statusCode: null, keys: [] };
    const wrong = sessionErrorVerdict(`${harness}.session.error`, harness, [loaded, { event: 'session.error', code: 'ProviderAuthError', statusCode: null, keys: [] }], { code: 1, stdout: '' }, Date.now());
    assert.deepEqual([wrong.passed, wrong.reasonCode], [false, 'WRONG_ERROR']);
    assert.equal(sessionErrorVerdict(`${harness}.session.error`, harness, [loaded], { code: 0, stdout: '' }, Date.now()).reasonCode, 'TURN_NOT_FAILED', 'no 402, no EVENT_ABSENT');
  });
}

test('readAccessProbeRecords keeps only codes and key names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jevris-probe-'));
  try {
    const file = join(dir, 'p.jsonl');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, `${JSON.stringify({ event: 'StopFailure', code: 'billing_error', keys: ['error_message', 'has space', 7], extra: ACCESS_CANARY })}\n{torn\n${JSON.stringify({ event: 'not a code!', code: 'x y', statusCode: 1.5 })}\n`);
    assert.deepEqual(await readAccessProbeRecords(file), [
      { event: 'StopFailure', code: 'billing_error', statusCode: null, keys: ['error_message'] },
      { event: null, code: null, statusCode: null, keys: [] },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('access.detect needs all three K16-K18 cases; access.session needs the hooks and its case, and a missing event is its own reason', () => {
  const live = (ok) => [{ featureId: 'plugin.install', passed: true, reasonCode: null, detail: '' }, { featureId: 'hooks.observe', passed: ok, reasonCode: ok ? null : 'X', detail: '' }];
  const pass = (id) => ({ id, passed: true, reasonCode: null, detail: '' });
  const fail = (id, reasonCode) => ({ id, passed: false, reasonCode, detail: '' });
  const detect = ['rate', 'credit', 'auth'].map((kind) => pass(`claude.access-limit.${kind}`));
  const run = (harness, hooks, cases) => Object.fromEntries(accessChecks(harness, live(hooks), cases).map((item) => [item.featureId, [item.passed, item.reasonCode]]));
  assert.deepEqual(run('claude', true, [...detect, pass('claude.session.stop-failure')]), { 'access.detect': [true, null], 'access.session': [true, null] });
  assert.deepEqual(run('claude', true, detect.slice(1))['access.detect'], [false, 'ACCESS_DETECT_CASE_NOT_RUN']);
  assert.deepEqual(run('claude', true, [fail('claude.access-limit.rate', 'WRONG_CLASS'), ...detect.slice(1)])['access.detect'], [false, 'ACCESS_DETECT_CASE_FAILED']);
  assert.deepEqual(run('claude', false, [...detect, pass('claude.session.stop-failure')])['access.session'], [false, 'ACCESS_SESSION_NEEDS_HOOKS']);
  assert.deepEqual(run('claude', true, detect)['access.session'], [false, 'ACCESS_SESSION_CASE_NOT_RUN']);
  assert.deepEqual(run('claude', true, [...detect, fail('claude.session.stop-failure', 'EVENT_ABSENT')])['access.session'], [false, 'ACCESS_SESSION_EVENT_ABSENT']);
  assert.deepEqual(run('claude', true, [...detect, fail('claude.session.stop-failure', 'CANARY_KEPT')])['access.session'], [false, 'ACCESS_SESSION_CASE_FAILED']);
  assert.deepEqual(Object.keys(run('codex', true, [])), ['access.detect', 'access.usage-read'], 'Codex sessions are not detectable; its usage read is K21');
  assert.deepEqual(run('codex', true, [])['access.usage-read'], [false, 'ACCESS_USAGE_CASE_NOT_RUN']);
  assert.deepEqual(run('antigravity', true, []), {}, 'Antigravity has neither');
  assert.deepEqual(Object.keys(run('opencode', true, [])), ['access.detect', 'access.session']);
});
