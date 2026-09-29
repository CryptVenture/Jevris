// ORC-05 (owner directive 2026-09-26: every harness has owned workers): the OpenCode and Kilo
// owned sessions, contract-tested against a stub `opencode run --format json` / `kilo run
// --format json` (never the real binary). The §15.4 list: event validation, cancellation, exact
// output shape, permission preservation, user pin, offline fallback and unsupported capability;
// plus the auth mode (names only, never a value), effort and the caps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const oc = await import('../dist/opencode-worker.js');
const kc = await import('../dist/kilo-worker.js');
const orchestrator = await import('@jevris/orchestrator');
const { closeTestStore, testStore } = await import('../../../packages/orchestrator/test/store-fixture.mjs');

// A stand-in for `<harness> run --format json`: logs argv, stdin, cwd, which key variables it can
// see (names only) and the Jevris variables it was given, then plays a script.
const STUB = `
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const script = JSON.parse(readFileSync(process.env.OC_STUB_SCRIPT, 'utf8'));
const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
const seen = KEYS.filter((k) => (process.env[k] ?? '') !== '');
const jevris = {};
for (const k of Object.keys(process.env)) if (/^(OPENCODE|KILO)_/.test(k) || k === 'PWD') jevris[k] = process.env[k];
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (stdin += c));
process.stdin.on('end', async () => {
  appendFileSync(process.env.OC_STUB_LOG, JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd(), seen, jevris }) + '\\n');
  if (script.write) { mkdirSync(join(process.cwd(), 'mod'), { recursive: true }); writeFileSync(join(process.cwd(), script.write), 'done\\n'); }
  for (const line of script.lines ?? []) process.stdout.write((typeof line === 'string' ? line : JSON.stringify(line)) + '\\n');
  if (script.sleepMs) await new Promise((r) => setTimeout(r, script.sleepMs));
  for (const line of script.after ?? []) process.stdout.write((typeof line === 'string' ? line : JSON.stringify(line)) + '\\n');
  if (script.stderr) process.stderr.write(script.stderr);
  if (script.finishedMarker) writeFileSync(script.finishedMarker, 'finished');
  process.exitCode = script.exitCode ?? 0;
});
`;

const SID = 'ses_0123';
const start = () => ({ type: 'step_start', timestamp: 1, sessionID: SID, part: { type: 'step-start' } });
const finish = (cost = 0.01, tokens = { input: 100, output: 20, reasoning: 5, cache: { read: 7, write: 3 } }) => ({ type: 'step_finish', timestamp: 2, sessionID: SID, part: { type: 'step-finish', reason: 'stop', cost, tokens } });
const text = (t) => ({ type: 'text', timestamp: 3, sessionID: SID, part: { type: 'text', text: t } });
const tool = (name) => ({ type: 'tool_use', timestamp: 2, sessionID: SID, part: { type: 'tool', tool: name, state: { status: 'completed' } } });
const error = (err) => ({ type: 'error', timestamp: 4, sessionID: SID, error: err });

function sandboxDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-oc-worker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stub = join(dir, 'oc-stub.mjs');
  writeFileSync(stub, STUB);
  const work = join(dir, 'work tree');
  mkdirSync(work);
  return { dir, stub, work, log: join(dir, 'calls.log') };
}

function stubbed(box, script, extraEnv = {}) {
  const scriptFile = join(box.dir, `script-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(scriptFile, JSON.stringify(script));
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string' && !/API_KEY|AUTH_TOKEN|OAUTH_TOKEN|^OPENCODE_|^KILO_/.test(key)) env[key] = value;
  return { command: { file: process.execPath, args: [box.stub] }, env: { ...env, OC_STUB_SCRIPT: scriptFile, OC_STUB_LOG: box.log, ...extraEnv } };
}

const calls = (box) => (existsSync(box.log) ? readFileSync(box.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
const base = (box, extra = {}) => ({ prompt: 'Fix the parser.\nKeep Node 20.', model: 'grok-4.7', cwd: box.work, allowedTools: ['Read', 'Grep', 'Edit'], maxTurns: 5, maxBudgetUsd: 1, timeoutMs: 20_000, ...extra });

const FLAVORS = [
  { name: 'opencode', port: 'opencode', run: oc.runOpencodeWorker, prefix: 'OPENCODE', missing: oc.OPENCODE_FLAVOR.missingMessage },
  { name: 'kilo', port: 'kilocode', run: kc.runKiloWorker, prefix: 'KILO', missing: kc.KILO_FLAVOR.missingMessage },
];

for (const f of FLAVORS) {
  test(`${f.name}: exact output shape — the prompt on stdin, provider/model and the Jevris agent in argv, the worktree as --dir and PWD`, async (t) => {
    const box = sandboxDir(t);
    const ids = [];
    const out = await f.run({ ...base(box), ...stubbed(box, { lines: [start(), tool('read'), finish(), start(), text('Fixed.'), finish()] }), onSessionId: (id) => ids.push(id) });
    assert.equal(out.status, 'completed', out.reason);
    assert.deepEqual(ids, [SID], 'the session id is bound once, from the first step_start, while the run is live');
    const [call] = calls(box);
    assert.deepEqual(call.argv, ['run', '--format', 'json', '--model', 'xai/grok-4.7', '--agent', 'jevris-worker', '--dir', box.work]);
    assert.equal(call.stdin, 'Fix the parser.\nKeep Node 20.');
    assert.equal(call.argv.includes('Fix the parser.\nKeep Node 20.'), false, 'never the prompt in argv');
    assert.equal(call.jevris.PWD, box.work);
    assert.deepEqual([out.sessionId, out.harnessModel, out.requestedModel, out.actualModel, out.turns, out.resultText], [SID, 'xai/grok-4.7', 'grok-4.7', null, 2, 'Fixed.']);
    assert.deepEqual(out.usage, { inputTokens: 200, outputTokens: 50, cacheReadInputTokens: 14, cacheCreationInputTokens: 6 }, 'reasoning tokens count as output');
    assert.equal(call.jevris[`${f.prefix}_DISABLE_AUTOUPDATE`], '1');
    if (f.name === 'kilo') assert.equal(call.jevris.KILO_NO_DAEMON, '1', 'never attach to a daemon running in another environment');
    else assert.equal(call.jevris.KILO_NO_DAEMON, undefined);
  });

  test(`${f.name}: permission preservation — everything denied, then only the granted tools; web, subagents and outside paths never; never --auto`, async (t) => {
    const box = sandboxDir(t);
    await f.run({ ...base(box, { allowedTools: ['Read', 'Grep', 'Glob', 'LS'] }), ...stubbed(box, { lines: [start(), finish()] }) });
    await f.run({ ...base(box, { allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'TodoWrite'] }), ...stubbed(box, { lines: [start(), finish()] }) });
    const [ro, rw] = calls(box);
    const config = JSON.parse(ro.jevris[`${f.prefix}_CONFIG_CONTENT`]);
    assert.equal(config.share, 'disabled');
    const agent = config.agent['jevris-worker'];
    assert.deepEqual([agent.mode, agent.steps], ['primary', 5]);
    assert.deepEqual(Object.entries(agent.permission), [['*', 'deny'], ['glob', 'allow'], ['grep', 'allow'], ['list', 'allow'], ['read', 'allow']], '* first: the last matching rule wins');
    assert.deepEqual(JSON.parse(ro.jevris[`${f.prefix}_PERMISSION`]), agent.permission, 'the same rules for every agent');
    const rwRules = JSON.parse(rw.jevris[`${f.prefix}_CONFIG_CONTENT`]).agent['jevris-worker'].permission;
    assert.deepEqual(Object.keys(rwRules), ['*', 'bash', 'edit', 'read', 'todowrite']);
    for (const never of ['webfetch', 'websearch', 'task', 'external_directory']) assert.equal(rwRules[never], undefined, `${never} stays denied by *`);
    for (const call of [ro, rw]) for (const flag of ['--auto', '--yolo', '--dangerously-skip-permissions', '--share', '--attach']) assert.equal(call.argv.includes(flag), false, flag);
  });

  test(`${f.name}: a run whose Jevris agent did not load is refused, never counted as the task's result`, async (t) => {
    const box = sandboxDir(t);
    const out = await f.run({ ...base(box), ...stubbed(box, { lines: [start(), text('done'), finish()], stderr: '! agent "jevris-worker" not found. Falling back to default agent\n' }) });
    assert.equal(out.status, 'refused');
    assert.match(out.reason, /Jevris agent did not load/);
    assert.deepEqual(out.initCheck, { ok: false, reasonCode: 'WORKER_AGENT_NOT_LOADED' });
  });

  test(`${f.name}: first-use check — a session opening with step_start passes; any other first event fails the shape check`, async (t) => {
    const box = sandboxDir(t);
    const ok = await f.run({ ...base(box), ...stubbed(box, { lines: [start(), text('done'), finish()] }) });
    assert.deepEqual(ok.initCheck, { ok: true, reasonCode: null });
    const odd = await f.run({ ...base(box), ...stubbed(box, { lines: [text('done'), finish()] }) });
    assert.deepEqual(odd.initCheck, { ok: false, reasonCode: 'WORKER_INIT_SHAPE' });
  });

  test(`${f.name}: a step part delivered twice (same part id) counts once`, async (t) => {
    const box = sandboxDir(t);
    const withId = (event, id) => ({ ...event, part: { ...event.part, id } });
    const out = await f.run({ ...base(box), ...stubbed(box, { lines: [withId(start(), 'p1'), withId(finish(), 'p2'), withId(finish(), 'p2'), withId(start(), 'p3'), withId(finish(), 'p4')] }) });
    assert.equal(out.status, 'completed', out.reason);
    assert.equal(out.turns, 2);
    assert.deepEqual(out.usage, { inputTokens: 200, outputTokens: 50, cacheReadInputTokens: 14, cacheCreationInputTokens: 6 });
  });

  test(`${f.name}: auth — a subscription run sees no provider key; a key run needs the model's key and never sees a stored login`, async (t) => {
    const box = sandboxDir(t);
    const keys = { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', XAI_API_KEY: 'x', GEMINI_API_KEY: 'g', OPENROUTER_API_KEY: 'r' };
    const sub = await f.run({ ...base(box, { auth: 'subscription' }), ...stubbed(box, { lines: [start(), finish()] }, keys) });
    assert.equal(sub.status, 'completed', sub.reason);
    assert.equal(sub.authMode, 'subscription');
    assert.equal(sub.costUsd, null, 'on a subscription the price is only an estimate');
    const [s] = calls(box);
    assert.deepEqual(s.seen, [], 'no provider key reaches a subscription run');
    assert.equal(s.jevris[`${f.prefix}_AUTH_CONTENT`], undefined, 'the stored login is the subscription');

    const key = await f.run({ ...base(box, { auth: 'api-key' }), ...stubbed(box, { lines: [start(), finish(0.25)] }, { XAI_API_KEY: 'x' }) });
    assert.equal(key.status, 'completed', key.reason);
    assert.equal(key.costUsd, 0.25, 'with a key the step cost is the spend');
    const k = calls(box)[1];
    assert.deepEqual(k.seen, ['XAI_API_KEY']);
    assert.equal(k.jevris[`${f.prefix}_AUTH_CONTENT`], '{}', 'an empty credential store hides every stored login');
    assert.equal(JSON.stringify(k).includes('"x"'), false, 'the key value never reaches argv or the log');

    const none = await f.run({ ...base(box, { auth: 'api-key' }), ...stubbed(box, { lines: [finish()] }) });
    assert.deepEqual([none.status, none.reason], ['refused', 'refused: api-key mode needs XAI_API_KEY in the environment']);
    const odd = await f.run({ ...base(box, { auth: 'api-key', model: 'someprovider/model-1' }), ...stubbed(box, { lines: [finish()] }) });
    assert.equal(odd.status, 'refused');
    assert.match(odd.reason, /no key variable/);
    assert.equal(calls(box).length, 2, 'refused runs started nothing');

    for (const auth of ['subscription', undefined]) {
      const claude = await f.run({ ...base(box, { auth, model: 'claude-opus-5-5' }), ...stubbed(box, { lines: [finish()] }, keys) });
      assert.equal(claude.status, 'refused', `${auth}: a Claude login runs only in Claude Code`);
      assert.match(claude.reason, /ANTHROPIC_LOGIN_THIRD_PARTY/);
    }
    const claudeKey = await f.run({ ...base(box, { auth: 'api-key', model: 'claude-opus-5-5' }), ...stubbed(box, { lines: [start(), finish()] }, { ANTHROPIC_API_KEY: 'a' }) });
    assert.equal(claudeKey.status, 'completed', claudeKey.reason);
    assert.deepEqual(calls(box)[2].seen, ['ANTHROPIC_API_KEY']);

    // R29: GLM runs on OpenCode and Kilo under the registry's `zai/` id with ZHIPU_API_KEY.
    const glm = await f.run({ ...base(box, { auth: 'api-key', model: 'glm-5.3' }), ...stubbed(box, { lines: [start(), finish()] }, { ZHIPU_API_KEY: 'z' }) });
    assert.equal(glm.status, 'completed', glm.reason);
    assert.equal(glm.harnessModel, 'zai/glm-5.3');
    assert.deepEqual(calls(box)[3].argv.slice(calls(box)[3].argv.indexOf('--model'), calls(box)[3].argv.indexOf('--model') + 2), ['--model', 'zai/glm-5.3']);

    const signedOut = await f.run({ ...base(box, { auth: 'subscription' }), ...stubbed(box, { lines: [start(), error({ name: 'ProviderAuthError', data: { providerID: 'xai', message: 'no credentials' } })], exitCode: 1 }) });
    // R66: a ProviderAuthError is a blocked account (an access limit), not a refusal; the sign-in hint stays.
    assert.deepEqual([signedOut.status, signedOut.accessLimit?.class], ['access-limit', 'account-blocked']);
    assert.equal(signedOut.reason, `the run hit an access limit: account-blocked (${f.port}.error.provider-auth): not signed in to xai; run ${f.name} auth login`);
  });

  test(`${f.name}: access limit (R66) — the error's name, status, body code and headers name the class; the message and body are never kept`, async (t) => {
    const box = sandboxDir(t);
    const apiError = (statusCode, extra = {}) => error({ name: 'APIError', data: { message: 'JEVRIS-CANARY-7f3a Too Many Requests', statusCode, isRetryable: false, ...extra } });
    const limited = await f.run({ ...base(box), ...stubbed(box, { lines: [start(), apiError(429, { responseHeaders: { 'retry-after': '120', 'x-canary': 'JEVRIS-CANARY-7f3a' } })], exitCode: 1 }) });
    assert.deepEqual([limited.status, limited.reason], ['access-limit', `the run hit an access limit: rate-limit (${f.port}.api-error.429)`]);
    assert.ok(Date.parse(limited.resetAt) > Date.now() + 100_000, limited.resetAt);
    assert.deepEqual(Object.keys(limited.accessSignal).sort(), ['channel', 'errorType', 'port', 'resetAtMs', 'status']);
    assert.deepEqual([limited.accessSignal.port, limited.accessSignal.errorType, limited.accessSignal.status, limited.accessLimit.resetBasis], [f.port, 'APIError', 429, 'reported']);
    const zai = await f.run({ ...base(box), ...stubbed(box, { lines: [start(), apiError(429, { responseBody: '{"error":{"code":"1113","message":"Insufficient balance JEVRIS-CANARY-7f3a"}}' })], exitCode: 1 }) });
    assert.deepEqual([zai.accessLimit.class, zai.accessLimit.signal, zai.accessSignal.errorCode, zai.accessLimit.resetBasis], ['credit-exhausted', `${f.port}.api-error.body-code.credit`, '1113', 'none'], 'Z.ai 1113 on a 429 is credit');
    const slow = await f.run({ ...base(box), ...stubbed(box, { lines: [start(), apiError(429, { responseBody: '{"error":{"type":"requests","code":"slow_down"}}' })], exitCode: 1 }) });
    assert.deepEqual([slow.accessLimit.class, slow.accessLimit.signal], ['rate-limit', `${f.port}.api-error.body-code.rate`], "OpenAI's slow_down is a rate limit");
    const spend = await f.run({ ...base(box, { auth: 'api-key', model: 'claude-opus-5-5' }), ...stubbed(box, { lines: [start(), apiError(429, { responseBody: '{"type":"error","error":{"type":"rate_limit_error","details":{"error_code":"enforced_spend_limit_reached"}}}' })], exitCode: 1 }, { ANTHROPIC_API_KEY: 'a' }) });
    assert.equal(spend.accessLimit.class, 'credit-exhausted', "Anthropic's spend cap is read from details.error_code");
    const billing = await f.run({ ...base(box), ...stubbed(box, { lines: [start(), apiError(402)], exitCode: 1 }) });
    assert.deepEqual([billing.status, billing.accessLimit.class], ['access-limit', 'credit-exhausted']);
    const busy = await f.run({ ...base(box), ...stubbed(box, { lines: [start(), apiError(529)], exitCode: 1 }) });
    assert.deepEqual([busy.status, busy.reason], ['overloaded', `the provider was overloaded (${f.port}.api-error.5xx)`]);
    const quota = await f.run({ ...base(box), ...stubbed(box, { lines: [error({ name: 'UnknownError', data: { message: 'You exceeded your current quota' } })], exitCode: 1 }) });
    assert.deepEqual([quota.status, quota.accessLimit.class, quota.accessLimit.signal, quota.accessSignal.channel], ['access-limit', 'usage-window', `${f.port}.text.x2`, 'error-text'], 'a text-only credit signal is held as a timed window (OP-4)');
    const huge = await f.run({ ...base(box), ...stubbed(box, { lines: [start(), apiError(429, { responseBody: `{"error":{"code":"1113","pad":"${'x'.repeat(9000)}"}}` })], exitCode: 1 }) });
    assert.deepEqual([huge.accessLimit.signal, huge.accessSignal.errorCode], [`${f.port}.api-error.429`, undefined], 'a body over 8 KiB is not parsed');
    for (const outcome of [limited, zai, slow, spend, billing, busy, quota, huge]) {
      assert.doesNotMatch(JSON.stringify(outcome), /JEVRIS-CANARY|Insufficient|Too Many/, 'no message, body or header value is kept');
      assert.equal(outcome.accessSignal.certified, undefined, 'a port never asserts its own proof');
    }
    const won = await f.run({ ...base(box), ...stubbed(box, { lines: [start(), finish(), text('done')] }) });
    assert.deepEqual([won.status, won.accessSignal], ['completed', undefined], 'success wins');
  });

  test(`${f.name}: access limit (guard 6) — a project config that redefines the provider reports no access signal`, async (t) => {
    const box = sandboxDir(t);
    const lines = [start(), error({ name: 'APIError', data: { message: 'x', statusCode: 402 } })];
    writeFileSync(join(box.work, 'opencode.json'), JSON.stringify({ provider: { xai: { options: { baseURL: 'http://127.0.0.1:9/v1' } } } }));
    const redefined = await f.run({ ...base(box), ...stubbed(box, { lines, exitCode: 1 }) });
    assert.deepEqual([redefined.status, redefined.accessSignal], ['failed', undefined]);
    writeFileSync(join(box.work, 'opencode.json'), JSON.stringify({ provider: { openrouter: {} } }));
    const other = await f.run({ ...base(box), ...stubbed(box, { lines, exitCode: 1 }) });
    assert.equal(other.status, 'access-limit', 'another provider redefined leaves the signal');
    writeFileSync(join(box.work, 'opencode.json'), '{"provider": {env:X}}');
    const doubt = await f.run({ ...base(box), ...stubbed(box, { lines, exitCode: 1 }) });
    assert.deepEqual([doubt.status, doubt.accessSignal], ['failed', undefined], 'a config that substitutes or does not parse counts as redefined');
  });

  test(`${f.name}: a failure that is no access limit fails with fixed text (R80)`, async (t) => {
    const box = sandboxDir(t);
    const other = await f.run({ ...base(box), ...stubbed(box, { lines: [start(), error({ name: 'UnknownError', data: { message: 'model not found JEVRIS-CANARY-7f3a' } })], exitCode: 1 }) });
    assert.deepEqual([other.status, other.reason], ['failed', 'the session reported UnknownError']);
    const api = await f.run({ ...base(box), ...stubbed(box, { lines: [start(), error({ name: 'APIError', data: { message: 'JEVRIS-CANARY-7f3a', statusCode: 418, responseBody: '{"error":"JEVRIS-CANARY-7f3a"}' } })], exitCode: 1 }) });
    assert.deepEqual([api.status, api.reason, api.accessSignal], ['failed', 'the session reported APIError (status 418)', undefined]);
    const odd = await f.run({ ...base(box), ...stubbed(box, { lines: [start(), error({ name: 'JEVRIS CANARY', data: { statusCode: 'x' } })], exitCode: 1 }) });
    assert.equal(odd.reason, 'the session reported an error', 'a name that is not a plain error name is left out');
    for (const outcome of [other, api, odd]) assert.doesNotMatch(JSON.stringify(outcome), /JEVRIS-CANARY|JEVRIS CANARY/);
  });

  test(`${f.name}: caps — past maxTurns steps or maxBudgetUsd the run is stopped with that status`, async (t) => {
    const box = sandboxDir(t);
    const steps = await f.run({ ...base(box, { maxTurns: 2 }), ...stubbed(box, { lines: [start(), finish(), start(), finish(), start()], sleepMs: 5_000, after: [finish()] }) });
    assert.deepEqual([steps.status, steps.reason], ['max-turns', 'more than 2 steps']);
    assert.ok(steps.durationMs < 4_500, 'stopped at once');
    const money = await f.run({ ...base(box, { maxBudgetUsd: 0.05 }), ...stubbed(box, { lines: [start(), finish(0.04), start(), finish(0.04)], sleepMs: 5_000, after: [start(), finish()] }) });
    assert.deepEqual([money.status, money.reason], ['budget-exceeded', 'over 0.05 USD']);
  });

  test(`${f.name}: event validation — noise is ignored; no finished step, or a non-zero exit, fails with fixed text (R80)`, async (t) => {
    const box = sandboxDir(t);
    const noisy = await f.run({ ...base(box), ...stubbed(box, { lines: ['not json', '[1,2]', '{"no":"type"}', { type: 'unknown_event', sessionID: SID }, start(), text('ok'), finish()] }) });
    assert.equal(noisy.status, 'completed', noisy.reason);
    assert.equal(noisy.events, 4);
    const empty = await f.run({ ...base(box), ...stubbed(box, { lines: [start()] }) });
    assert.deepEqual([empty.status, empty.reason], ['failed', 'the stream ended without a finished step']);
    const rejected = await f.run({ ...base(box), ...stubbed(box, { lines: [start(), finish()], stderr: 'permission requested: bash (npm test); auto-rejecting\n', exitCode: 1 }) });
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.reason, `${f.name} run exited with code 1: a permission request was auto-rejected`, 'the harness line is recognised, not kept');
    const crashed = await f.run({ ...base(box), ...stubbed(box, { lines: [start(), finish()], stderr: 'Error: upstream said JEVRIS-CANARY-7f3a\n', exitCode: 1 }) });
    assert.equal(crashed.reason, `${f.name} run exited with code 1`, 'stderr never enters a reason');
  });

  test(`${f.name}: cancellation — an abort kills the tree; an abort before start starts nothing; the wall clock times out`, async (t) => {
    const box = sandboxDir(t);
    const early = new AbortController();
    early.abort();
    const before = await f.run({ ...base(box, { signal: early.signal }), ...stubbed(box, { lines: [finish()] }) });
    assert.deepEqual([before.status, before.reason], ['aborted', 'aborted before start']);
    assert.equal(calls(box).length, 0);
    const marker = join(box.dir, 'finished');
    const controller = new AbortController();
    let control;
    const running = f.run({ ...base(box, { signal: controller.signal, onStart: (c) => (control = c) }), ...stubbed(box, { lines: [start()], sleepMs: 5_000, after: [finish()], finishedMarker: marker }) });
    assert.equal(await sessionKnown(() => control), SID);
    controller.abort();
    const out = await running;
    assert.equal(out.status, 'aborted');
    assert.equal(existsSync(marker), false, 'the killed session never finished');
    const slow = await f.run({ ...base(box, { timeoutMs: 1_000 }), ...stubbed(box, { lines: [start()], sleepMs: 5_000, after: [finish()] }) });
    assert.deepEqual([slow.status, slow.reason], ['timeout', 'no result within 1000 ms']);
  });

  test(`${f.name}: user pin, effort and unsupported capability`, async (t) => {
    const box = sandboxDir(t);
    const pinned = await f.run({ ...base(box, { model: 'openrouter/qwen/qwen3-coder', effort: 'high' }), ...stubbed(box, { lines: [start(), finish()] }) });
    assert.equal(pinned.harnessModel, 'openrouter/qwen/qwen3-coder', 'a provider/model id passes as given');
    assert.equal(pinned.effort, 'high');
    assert.deepEqual(calls(box)[0].argv.slice(-2), ['--variant', 'high']);
    // The registry spells each model for the harness (R6): no family regex.
    assert.equal(oc.opencodeModel('gpt-6-sol'), 'openai/gpt-6-sol');
    assert.equal(oc.opencodeModel('claude-opus-5-5'), 'anthropic/claude-opus-5-5');
    assert.equal(oc.opencodeModel('grok-4.7'), 'xai/grok-4.7');
    assert.equal(oc.opencodeModel('kimi-k3'), 'moonshotai/kimi-k3', "the harness's own provider id");
    assert.equal(oc.opencodeModel('kimi-k3', 'kilocode'), 'moonshotai/kimi-k3', 'Kilo resolves ids against the models.dev catalog it ships');
    assert.equal(oc.opencodeModel('gpt-5.2'), null, 'an id the registry does not know needs a pin');
    assert.equal(oc.opencodeModel('openai/gpt-5.2'), 'openai/gpt-5.2', 'a provider/model pin passes as given');
    // R29: GLM, Kimi and DeepSeek launch on OpenCode with their providers' key variables (models.dev).
    assert.equal(oc.opencodeModel('glm-5.3'), 'zai/glm-5.3');
    assert.equal(oc.opencodeModel('deepseek-v4-pro'), 'deepseek/deepseek-v4-pro');
    assert.deepEqual(['glm-5.3', 'kimi-k3', 'deepseek-v4-pro', 'zai-coding-plan/glm-5.3'].map((m) => oc.opencodeProviderKeys(m)), [['ZHIPU_API_KEY'], ['MOONSHOT_API_KEY'], ['DEEPSEEK_API_KEY'], ['ZHIPU_API_KEY']]);
    assert.deepEqual(oc.opencodeProviderKeys('glm-5.3', 'kilocode'), ['ZHIPU_API_KEY'], 'Kilo reads the same provider key');
    const unknown = await f.run({ ...base(box, { model: 'mystery-model' }), ...stubbed(box, { lines: [finish()] }) });
    assert.equal(unknown.status, 'refused');
    assert.match(unknown.reason, /no provider for model mystery-model/);
    // The bare name in a test run is refused before any PATH lookup: nothing starts.
    const bare = await f.run(base(box));
    assert.deepEqual([bare.status, bare.reason], ['unsupported', f.missing]);
    const missing = await f.run({ ...base(box), command: { file: join(box.dir, `no-such-${f.name}`) } });
    assert.equal(missing.status, 'unsupported');
  });

  // Serving hosts R52 (agreed with D): servingHost starts the host's own spelling of the registry
  // model, or refuses; never the maker spelling. Nothing sets it until the parked task-ops wiring.
  test(`${f.name}: a serving host runs the host spelling of the model; no spelling is refused; absent is the maker route`, async (t) => {
    const box = sandboxDir(t);
    const via = await f.run({ ...base(box, { model: 'kimi-k3', effort: 'high', servingHost: 'openrouter' }), ...stubbed(box, { lines: [start(), finish()] }) });
    assert.equal(via.harnessModel, 'openrouter/moonshotai/kimi-k3');
    const argv = calls(box).at(-1).argv;
    assert.equal(argv[argv.indexOf('--model') + 1], 'openrouter/moonshotai/kimi-k3', 'the host spelling in argv');
    const maker = await f.run({ ...base(box, { model: 'kimi-k3', effort: 'high' }), ...stubbed(box, { lines: [start(), finish()] }) });
    assert.equal(maker.harnessModel, 'moonshotai/kimi-k3', 'no servingHost: the maker route, as before R52');
    const before = calls(box).length;
    const none = await f.run({ ...base(box, { model: 'kimi-k3', servingHost: 'nowhere' }), ...stubbed(box, { lines: [start(), finish()] }) });
    assert.equal(none.status, 'refused');
    assert.match(none.reason, new RegExp(`^refused: ${oc.WORKER_HOST_UNSPELLED}: `));
    assert.equal(calls(box).length, before, 'nothing starts');
    // B's LOW 36: a host run sees only the host's own key, never the maker's or another provider's.
    const everyKey = { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', XAI_API_KEY: 'x', GEMINI_API_KEY: 'g', OPENROUTER_API_KEY: 'r' };
    const keyed = await f.run({ ...base(box, { model: 'kimi-k3', servingHost: 'openrouter', auth: 'api-key' }), ...stubbed(box, { lines: [start(), finish()] }, everyKey) });
    assert.equal(keyed.status, 'completed', keyed.reason);
    assert.deepEqual(calls(box).at(-1).seen, ['OPENROUTER_API_KEY']);
    const signedIn = await f.run({ ...base(box, { model: 'kimi-k3', servingHost: 'openrouter', auth: 'subscription' }), ...stubbed(box, { lines: [start(), finish()] }, everyKey) });
    assert.equal(signedIn.status, 'completed', signedIn.reason);
    assert.deepEqual(calls(box).at(-1).seen, [], 'a subscription host run carries no key');
    const bad = await f.run({ ...base(box, { model: 'kimi-k3', servingHost: 'Open Router' }), ...stubbed(box, { lines: [start(), finish()] }) });
    assert.deepEqual([bad.status, bad.reason], ['refused', 'invalid servingHost']);
  });
}

// ------------------------------------------------------------------ through D's runLeasedTask

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}


/**
 * The session id once the stub turn has reported it: polled, bounded, never a fixed delay. On a
 * loaded host starting the stub can take longer than any fixed delay, and the abort would then
 * land before the session started.
 */
async function sessionKnown(control, ms = 15_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const id = control()?.sessionId() ?? null;
    if (id !== null) return id;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return control()?.sessionId() ?? null;
}

test('through runLeasedTask: an OpenCode run and a Kilo run are leased, recorded owned effects in their worktrees', async (t) => {
  for (const [name, port] of [['opencode', oc.opencodeWorkerPort], ['kilo', kc.kiloWorkerPort]]) {
    const box = sandboxDir(t);
    const dir = mkdtempSync(join(tmpdir(), `jevris-${name}-lease-`));
    const home = join(dir, 'home');
    const repo = join(dir, 'repo');
    mkdirSync(home);
    mkdirSync(join(repo, 'mod'), { recursive: true });
    writeFileSync(join(repo, 'mod', 'a.txt'), 'a\n');
    git(repo, 'init', '-q');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    const store = testStore(dir);
    t.after(() => {
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    });
    const ws = orchestrator.openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
    const m = orchestrator.parseManifest({ id: 'fixed', argv: [process.execPath, '-e', "process.exit(require('fs').existsSync('mod/fixed.txt') ? 0 : 1)"], resultFormat: 'exit-code', requirementIds: ['R1'] }).manifest;
    await orchestrator.approveManifests(ws, [m], { fixed: orchestrator.manifestHash(m) }, 'test');
    await orchestrator.submitPlan(ws, { tasks: [{ id: 'T1', requirementIds: ['R1'], acceptanceCheckIds: ['fixed'], expectedOutputs: ['patch'], writeScopes: ['mod'], estimateMicroUsd: 500_000 }], ownerId: 'alice', rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 } });
    const authority = orchestrator.leaseAuthorityFor(ws);
    const [grant] = (await orchestrator.scheduleTasks(ws, { authority, holder: orchestrator.selfIdentity() })).leased;
    const result = await orchestrator.runLeasedTask(ws, grant, { authority, port: port(stubbed(box, { write: 'mod/fixed.txt', lines: [start(), tool('write'), finish()] })), model: 'grok-4.7', allowedTools: ['Read', 'Edit', 'Write'], prompt: 'write mod/fixed.txt' });
    assert.equal(result.finalState, 'awaiting-evidence', `${name}: ${result.reasonCode}`);
    const run = orchestrator.workerRuns(ws, 'T1')[0];
    assert.deepEqual([run.status, run.requestedModel, run.sessionId], ['completed', 'grok-4.7', SID], name);
    assert.deepEqual(run.changedPaths, ['mod/fixed.txt'], name);
    assert.notEqual(calls(box)[0].cwd, ws.workspaceRoot, `${name}: the session ran in the task worktree, not the checkout`);
  }
});

test('onSessionId: reported once with the first id, before the run ends; a throwing callback never fails the run', async (t) => {
  const { sessionIdReporter } = await import('../dist/owned-session.js');
  const seen = [];
  const report = sessionIdReporter((id) => seen.push(id));
  report(null);
  report('first');
  report('second');
  assert.deepEqual(seen, ['first']);
  sessionIdReporter(undefined)('x');
  const box = sandboxDir(t);
  const out = await oc.runOpencodeWorker({ ...base(box), ...stubbed(box, { lines: [start(), text('Fixed.'), finish()] }), onSessionId: () => { throw new Error('binding failed'); } });
  assert.equal(out.status, 'completed', out.reason);
  assert.equal(out.sessionId, SID);
});
