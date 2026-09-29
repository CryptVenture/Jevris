// ORC-05 (owner decision 2026-09-26): the Claude Code CLI owned session, contract-tested against
// a stub `claude -p --output-format stream-json` (never the real binary). It is the path for a
// subscription login and also runs with an API key. The §15.4 list: event validation,
// cancellation, exact output shape, permission preservation, user pin, offline fallback and
// unsupported capability; plus the auth mode, which only ever names the mode, never a value.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runClaudeWorker, claudeWorkerPort, claudePrintArgs, authFromApiKeySource, CLAUDE_MISSING_MESSAGE } = await import('../dist/claude-worker.js');

// A stand-in for `claude -p --output-format stream-json`: logs argv, stdin, cwd and which auth
// variables it can see (names only), then plays a script.
const STUB = `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const script = JSON.parse(readFileSync(process.env.CLAUDE_STUB_SCRIPT, 'utf8'));
const seen = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY'].filter((k) => (process.env[k] ?? '') !== '');
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (stdin += c));
process.stdin.on('end', async () => {
  appendFileSync(process.env.CLAUDE_STUB_LOG, JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd(), seen }) + '\\n');
  const out = (line) => (typeof line === 'string' ? line : JSON.stringify(line).replace('"@CWD"', JSON.stringify(process.cwd())));
  for (const line of script.lines ?? []) process.stdout.write(out(line) + '\\n');
  if (script.sleepMs) await new Promise((r) => setTimeout(r, script.sleepMs));
  for (const line of script.after ?? []) process.stdout.write(out(line) + '\\n');
  if (script.finishedMarker) writeFileSync(script.finishedMarker, 'finished');
  process.exitCode = script.exitCode ?? 0;
});
`;

const init = (apiKeySource = 'none', over = {}) => ({ type: 'system', subtype: 'init', session_id: 'sess-1', cwd: '@CWD', model: 'claude-sonnet-4-5', permissionMode: 'default', apiKeySource, tools: ['Read'], ...over });
const assistant = (model = 'claude-sonnet-4-5-20250929') => ({ type: 'assistant', session_id: 'sess-1', message: { model, content: [{ type: 'text', text: 'working' }] } });
const result = (over = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: 'Fixed.', session_id: 'sess-1', num_turns: 3, total_cost_usd: 0.042, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 }, ...over });

function sandboxDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-claude-worker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stub = join(dir, 'claude-stub.mjs');
  writeFileSync(stub, STUB);
  const work = join(dir, 'work tree');
  mkdirSync(work);
  return { dir, stub, work, log: join(dir, 'calls.log') };
}

function stubbed(box, script, extraEnv = {}) {
  const scriptFile = join(box.dir, `script-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(scriptFile, JSON.stringify(script));
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string' && !/API_KEY|AUTH_TOKEN|OAUTH_TOKEN|BASE_URL|CLAUDE_CODE_USE_|ANTHROPIC_FOUNDRY|ANTHROPIC_AWS/.test(key)) env[key] = value;
  // The user's Claude settings are the sandbox's (LOW 39 reads them), never the real home's.
  return { command: { file: process.execPath, args: [box.stub] }, env: { ...env, CLAUDE_CONFIG_DIR: join(box.dir, 'claude-config'), CLAUDE_STUB_SCRIPT: scriptFile, CLAUDE_STUB_LOG: box.log, ...extraEnv } };
}

const calls = (box) => (existsSync(box.log) ? readFileSync(box.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
const base = (box, extra = {}) => ({ prompt: 'Fix the parser.\nKeep Node 20.', model: 'claude-sonnet-4-5', cwd: box.work, allowedTools: ['Read', 'Grep', 'Edit'], maxTurns: 5, maxBudgetUsd: 1, timeoutMs: 20_000, ...extra });


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

test('exact output shape: the prompt goes on stdin, the model at start, the session runs in the worktree', async (t) => {
  const box = sandboxDir(t);
  const ids = [];
  const outcome = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines: [init('ANTHROPIC_API_KEY'), assistant(), result()] }, { ANTHROPIC_API_KEY: 'k-test' }), onSessionId: (id) => ids.push(id) });
  assert.equal(outcome.status, 'completed', outcome.reason);
  assert.deepEqual(ids, ['sess-1'], 'the session id is bound once, from the first event that names it');
  const [call] = calls(box);
  assert.deepEqual(call.argv, [...claudePrintArgs(base(box))]);
  assert.deepEqual(claudePrintArgs({ model: 'm', maxTurns: 2, maxBudgetUsd: 0.5, allowedTools: ['Read', 'Bash'] }), ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'm', '--max-turns', '2', '--max-budget-usd', '0.5', '--allowedTools', 'Read,Bash', '--disallowedTools', 'WebFetch,WebSearch', '--strict-mcp-config']);
  assert.equal(call.stdin, 'Fix the parser.\nKeep Node 20.');
  assert.equal(call.argv.some((arg) => arg.includes('Fix the parser')), false, 'the prompt never goes on argv');
  assert.equal(realpathSync(call.cwd), realpathSync(box.work));
  assert.equal(outcome.sessionId, 'sess-1');
  assert.deepEqual(outcome.usage, { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 7, cacheCreationInputTokens: 3 });
  assert.equal(outcome.turns, 3);
  assert.equal(outcome.resultText, 'Fixed.');
  assert.equal(outcome.authMode, 'api-key');
  assert.equal(outcome.costUsd, 0.042, 'an API key run reports the provider cost');
});

test('user pin: the requested model is passed as given; the answering model comes from the assistant messages', async (t) => {
  const box = sandboxDir(t);
  const outcome = await runClaudeWorker({ ...base(box, { model: 'claude-opus-4-1' }), ...stubbed(box, { lines: [init('none', { model: 'claude-opus-4-1-20250805' }), assistant('claude-opus-4-1-20250805'), result()] }) });
  assert.equal(calls(box)[0].argv[calls(box)[0].argv.indexOf('--model') + 1], 'claude-opus-4-1');
  assert.equal(outcome.requestedModel, 'claude-opus-4-1');
  assert.equal(outcome.actualModel, 'claude-opus-4-1-20250805');
});

test('permission preservation: only granted tools are pre-approved, web and MCP are off, never a bypass flag', async (t) => {
  const box = sandboxDir(t);
  await runClaudeWorker({ ...base(box), ...stubbed(box, { lines: [init(), result()] }) });
  const argv = calls(box)[0].argv;
  for (const flag of ['--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions']) assert.equal(argv.includes(flag), false, flag);
  assert.equal(argv[argv.indexOf('--allowedTools') + 1], 'Read,Grep,Edit');
  assert.ok(argv.includes('--strict-mcp-config'));
  const refused = await runClaudeWorker({ ...base(box, { allowedTools: ['Read', 'WebFetch'] }), ...stubbed(box, { lines: [] }) });
  assert.deepEqual([refused.status, refused.reason], ['refused', 'invalid allowedTools']);
});

test('auth: a subscription run never sees a vendor key; an API-key run never sees the subscription token', async (t) => {
  const box = sandboxDir(t);
  const all = { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'o', CODEX_API_KEY: 'c', CLAUDE_CODE_OAUTH_TOKEN: 't' };
  const sub = await runClaudeWorker({ ...base(box, { auth: 'subscription' }), ...stubbed(box, { lines: [init('oauth'), result()] }, all) });
  assert.equal(sub.status, 'completed', sub.reason);
  assert.deepEqual(calls(box)[0].seen, ['CLAUDE_CODE_OAUTH_TOKEN']);
  assert.equal(sub.authMode, 'subscription');
  assert.equal(sub.costUsd, null, 'a subscription run reports usage, not dollars (the cost is only an estimate)');

  const key = await runClaudeWorker({ ...base(box, { auth: 'api-key' }), ...stubbed(box, { lines: [init('ANTHROPIC_API_KEY'), result()] }, all) });
  assert.equal(key.status, 'completed', key.reason);
  assert.deepEqual(calls(box)[1].seen, ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY']);
  assert.equal(key.authMode, 'api-key');

  const noKey = await runClaudeWorker({ ...base(box, { auth: 'api-key' }), ...stubbed(box, { lines: [] }, { CLAUDE_CODE_OAUTH_TOKEN: 't' }) });
  assert.deepEqual([noKey.status, noKey.reason], ['refused', 'refused: api-key mode needs ANTHROPIC_API_KEY in the environment']);
  assert.equal(calls(box).length, 2, 'nothing started without the key');
});

test('auth: a session whose init contradicts the decided mode is stopped before it runs', async (t) => {
  const box = sandboxDir(t);
  const marker = join(box.dir, 'finished');
  // A settings apiKeyHelper would give a key even with every key variable removed.
  const outcome = await runClaudeWorker({ ...base(box, { auth: 'subscription' }), ...stubbed(box, { lines: [init('apiKeyHelper')], sleepMs: 5_000, after: [result()], finishedMarker: marker }) });
  assert.deepEqual([outcome.status, outcome.reason], ['refused', 'refused: the session used an API key but subscription was decided']);
  assert.equal(outcome.authMode, 'api-key', 'the outcome says what actually ran');
  assert.equal(existsSync(marker), false, 'the session was killed');
  assert.equal(authFromApiKeySource('none'), 'subscription');
  assert.equal(authFromApiKeySource('oauth'), 'subscription');
  assert.equal(authFromApiKeySource('/login managed key'), 'api-key');
  assert.equal(authFromApiKeySource(undefined), 'unknown');
});

// R63 (design 5.2): the access signal of a run with no successful result. Resets are relative to
// now, since core ignores a reset in the past or more than 8 days away.
const HOUR = 3_600_000;
const limitEvent = (rateLimitType, resetsAtS) => ({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', ...(rateLimitType === undefined ? {} : { rateLimitType }), ...(resetsAtS === undefined ? {} : { resetsAt: resetsAtS }) } });
const failedResult = (text = 'limit') => result({ subtype: 'error_during_execution', is_error: true, result: text });
const WIRE_KEYS = new Set(['port', 'channel', 'status', 'errorType', 'errorCode', 'rateLimitType', 'resetAtMs', 'text']);
const contracts = await import('@jevris/contracts');
const AccessSignalWireContract = contracts.defineContract({ name: 'AccessSignalWire', description: 'test', schema: contracts.AccessSignalWireSchema });

function assertWire(outcome) {
  const wire = outcome.accessSignal;
  assert.ok(wire !== undefined, 'an access signal is attached');
  for (const key of Object.keys(wire)) assert.ok(WIRE_KEYS.has(key), `wire key ${key}`);
  assert.equal(wire.certified, undefined, 'a port never asserts its own proof');
  assert.equal(AccessSignalWireContract.validate(wire).ok, true, JSON.stringify(wire));
}

test('access limit (R63): a rejected rate-limit event is a usage window with its reset; weekly and the Opus family are kept', async (t) => {
  const box = sandboxDir(t);
  const resetS = Math.floor((Date.now() + 2 * HOUR) / 1000);
  const five = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines: [init(), limitEvent('five_hour', resetS), failedResult()] }) });
  assert.deepEqual([five.status, five.reason], ['access-limit', 'the run hit an access limit: usage-window (claude.stream.rate-limit-event.five-hour)']);
  assert.equal(five.resetAt, new Date(resetS * 1000).toISOString());
  assert.deepEqual(five.accessSignal, { port: 'claude', channel: 'structured', errorType: 'rate_limit_event', rateLimitType: 'five_hour', resetAtMs: resetS * 1000 });
  assert.deepEqual(five.accessLimit, { class: 'usage-window', signal: 'claude.stream.rate-limit-event.five-hour', weekly: false, resetBasis: 'reported', resetAtMs: resetS * 1000 });
  assertWire(five);
  const week = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines: [init(), limitEvent('seven_day'), failedResult()] }) });
  assert.deepEqual([week.status, week.accessLimit.signal, week.accessLimit.weekly, week.accessLimit.resetBasis], ['access-limit', 'claude.stream.rate-limit-event.seven-day', true, 'rule']);
  assert.equal(week.resetAt, undefined, 'no reported reset, no resetAt');
  const opus = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines: [init(), limitEvent('seven_day_opus', resetS), failedResult()] }) });
  assert.deepEqual([opus.accessLimit.class, opus.accessLimit.weekly, opus.accessLimit.family], ['usage-window', true, 'opus']);
  const stopped = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines: [init(), limitEvent('five_hour', resetS)], exitCode: 1 }) });
  assert.equal(stopped.status, 'access-limit', 'a run that ends with no result on a rejected event is limited too');
});

test('access limit (R63): success wins; a warning is not a limit; the legacy limit text keeps its reset', async (t) => {
  const box = sandboxDir(t);
  const won = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines: [init(), limitEvent('five_hour'), { type: 'system', subtype: 'api_retry', error: 'billing_error' }, result()] }) });
  assert.equal(won.status, 'completed', 'a successful result records nothing');
  assert.equal(won.accessSignal, undefined);
  assert.equal(won.accessLimit, undefined);
  const warning = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines: [init(), { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } }, result()] }) });
  assert.equal(warning.status, 'completed', 'a warning is not a limit');
  const epoch = Math.floor((Date.now() + HOUR) / 1000);
  const text = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines: [init(), result({ is_error: true, result: `Claude AI usage limit reached|${String(epoch)}` })] }) });
  assert.deepEqual([text.status, text.accessLimit.signal, text.resetAt], ['access-limit', 'claude.text.c1', new Date(epoch * 1000).toISOString()]);
  assert.equal(text.accessSignal.channel, 'error-text');
  assertWire(text);
  const plain = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines: [init(), failedResult('the rate limit of the tool was fine; disk quota exceeded')] }) });
  assert.deepEqual([plain.status, plain.accessSignal], ['failed', undefined], 'bare "rate limit" and "quota" are no longer limits (A7)');
});

test('access limit (R63): the api_retry and assistant error enums name the class; rate_limit depends on the sign-in', async (t) => {
  const box = sandboxDir(t);
  const retry = (error) => ({ type: 'system', subtype: 'api_retry', attempt: 1, retry_delay_ms: 500, error_status: 402, error });
  const billing = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines: [init(), retry('billing_error'), failedResult()] }) });
  assert.deepEqual([billing.status, billing.reason], ['access-limit', 'the run hit an access limit: credit-exhausted (claude.stream.error.billing)']);
  assert.deepEqual(billing.accessLimit, { class: 'credit-exhausted', signal: 'claude.stream.error.billing', weekly: false, resetBasis: 'none' });
  assert.deepEqual(billing.accessSignal, { port: 'claude', channel: 'structured', errorType: 'billing_error' }, 'the retry status and delay are not carried');
  assertWire(billing);
  const blocked = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines: [init(), { ...assistant(), error: 'account_on_hold' }, failedResult()] }) });
  assert.deepEqual([blocked.status, blocked.accessLimit.class], ['access-limit', 'account-blocked']);
  const subscription = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines: [init(), { ...assistant(), error: 'rate_limit' }, failedResult()] }) });
  assert.deepEqual([subscription.authMode, subscription.accessLimit.class], ['subscription', 'usage-window']);
  const keyed = await runClaudeWorker({ ...base(box, { auth: 'api-key' }), ...stubbed(box, { lines: [init('ANTHROPIC_API_KEY'), { ...assistant(), error: 'rate_limit' }, failedResult()] }, { ANTHROPIC_API_KEY: 'k-test' }) });
  assert.deepEqual([keyed.authMode, keyed.accessLimit.class, keyed.accessLimit.signal], ['api-key', 'rate-limit', 'claude.stream.error.rate-limit']);
  const overloaded = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines: [init(), retry('overloaded'), failedResult()] }) });
  assert.deepEqual([overloaded.status, overloaded.reason, overloaded.accessLimit.resetBasis], ['overloaded', 'the provider was overloaded (claude.stream.error.overloaded)', 'none']);
  const later = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines: [init(), retry('overloaded'), retry('billing_error'), failedResult()] }) });
  assert.equal(later.accessLimit.class, 'credit-exhausted', 'the last enum counts');
  const gone = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines: [init(), { ...assistant(), error: 'model_not_found' }, failedResult("You've hit your session limit")] }) });
  assert.notEqual(gone.status, 'access-limit', 'model_not_found is model availability, never an access limit');
  assert.equal(gone.accessSignal, undefined);
  const unknown = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines: [init(), retry('unknown'), failedResult("You've hit your weekly limit")] }) });
  assert.deepEqual([unknown.accessLimit.signal, unknown.accessLimit.weekly], ['claude.text.c1', true], 'an enum with no row leaves the pinned pattern to decide');
});

test('access limit (R63, R80, OP-4): text-only credit is held as a timed window; no remote text reaches the outcome', async (t) => {
  const box = sandboxDir(t);
  const canary = 'JEVRIS-CANARY-7f3a';
  const credit = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines: [init(), failedResult(`Credit balance is too low ${canary}`)], stderr: `API Error: 400 ${canary}\n` }) });
  assert.deepEqual([credit.status, credit.accessLimit.class, credit.accessLimit.signal, credit.accessLimit.resetBasis], ['access-limit', 'usage-window', 'claude.text.c5', 'rule'], 'an uncertified text row never pauses without expiry');
  assert.doesNotMatch(JSON.stringify(credit), new RegExp(canary));
  assertWire(credit);
});

test('access limit (OP-12): a run through a redirected endpoint reports no access signal', async (t) => {
  const box = sandboxDir(t);
  const lines = [init(), { type: 'system', subtype: 'api_retry', error: 'billing_error' }, failedResult()];
  const viaEnv = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines }, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' }) });
  assert.deepEqual([viaEnv.status, viaEnv.accessSignal, viaEnv.accessLimit], ['failed', undefined, undefined]);
  const viaFoundry = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines }, { CLAUDE_CODE_USE_FOUNDRY: '1' }) });
  assert.deepEqual([viaFoundry.status, viaFoundry.accessSignal], ['failed', undefined], 'a cloud-provider switch');
  mkdirSync(join(box.work, '.claude'));
  writeFileSync(join(box.work, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: 'echo key' }));
  const helper = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines }) });
  assert.deepEqual([helper.status, helper.accessSignal], ['failed', undefined]);
  writeFileSync(join(box.work, '.claude', 'settings.json'), JSON.stringify({ permissions: {} }));
  writeFileSync(join(box.work, '.claude', 'settings.local.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } }));
  const local = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines }) });
  assert.deepEqual([local.status, local.accessSignal], ['failed', undefined]);
  writeFileSync(join(box.work, '.claude', 'settings.local.json'), JSON.stringify({ env: { OTHER: '1' } }));
  const plain = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines }) });
  assert.equal(plain.status, 'access-limit', 'workspace settings that redirect nothing leave the signal');
  // B's LOW 39: the user's settings.json env and apiKeyHelper count too, as the hook's guard sees them.
  const userDir = join(box.dir, 'claude-config');
  mkdirSync(userDir);
  writeFileSync(join(userDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } }));
  const user = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines }) });
  assert.deepEqual([user.status, user.accessSignal, user.accessLimit], ['failed', undefined, undefined], 'a user settings env redirect reports no limit');
  writeFileSync(join(userDir, 'settings.json'), JSON.stringify({ apiKeyHelper: 'echo key' }));
  assert.equal((await runClaudeWorker({ ...base(box), ...stubbed(box, { lines }) })).accessSignal, undefined, 'a user apiKeyHelper');
  writeFileSync(join(userDir, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } }));
  assert.equal((await runClaudeWorker({ ...base(box), ...stubbed(box, { lines }) })).accessSignal, undefined, 'a user cloud-provider switch');
  writeFileSync(join(userDir, 'settings.json'), JSON.stringify({ env: { OTHER: '1' }, permissions: {} }));
  assert.equal((await runClaudeWorker({ ...base(box), ...stubbed(box, { lines }) })).status, 'access-limit', 'user settings that redirect nothing leave the signal');
});

test('LOW 39: the settings files the owned Claude guard reads: workspace, user (CLAUDE_CONFIG_DIR, else HOME/.claude) and managed', async () => {
  const { claudeSettingsFiles } = await import('../dist/claude-worker.js');
  const ws = join('/w', 'repo');
  assert.deepEqual(claudeSettingsFiles(ws, { HOME: '/h', CLAUDE_CONFIG_DIR: '/c' }, 'linux'), [join(ws, '.claude', 'settings.json'), join(ws, '.claude', 'settings.local.json'), join('/c', 'settings.json'), '/etc/claude-code/managed-settings.json']);
  assert.deepEqual(claudeSettingsFiles(ws, { HOME: '/h' }, 'darwin').slice(2), [join('/h', '.claude', 'settings.json'), '/Library/Application Support/ClaudeCode/managed-settings.json']);
  assert.deepEqual(claudeSettingsFiles(ws, {}, 'linux').slice(2), ['/etc/claude-code/managed-settings.json'], 'no HOME: no user file is guessed');
  assert.equal(claudeSettingsFiles(ws, { USERPROFILE: 'C:\\Users\\p' }, 'win32').length, 5, 'Windows: the user file and both managed paths');
});

test('event validation: noise is ignored; caps and errors map to their statuses', async (t) => {
  const box = sandboxDir(t);
  const noisy = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines: ['not json', '[1,2]', { no: 'type' }, init(), result()] }) });
  assert.equal(noisy.status, 'completed');
  assert.equal(noisy.events, 2);
  const turns = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines: [init(), result({ subtype: 'error_max_turns', is_error: true, result: undefined })] }) });
  assert.equal(turns.status, 'max-turns');
  const budget = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines: [init(), result({ subtype: 'error_max_budget_usd', is_error: true, result: undefined })] }) });
  assert.equal(budget.status, 'budget-exceeded');
  const failed = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines: [init(), result({ subtype: 'error_during_execution', is_error: true, result: 'Tool failed JEVRIS-CANARY-7f3a\nsecond line' })] }) });
  // R80: a reason is fixed text plus a code; the result text never enters it.
  assert.deepEqual([failed.status, failed.reason, failed.resultText], ['failed', 'the turn ended with an error (error_during_execution)', null]);
  assert.doesNotMatch(JSON.stringify(failed), /JEVRIS-CANARY/);
  const odd = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines: [init(), result({ subtype: 'Weird Subtype JEVRIS-CANARY-7f3a', is_error: true, result: 'x' })] }) });
  assert.equal(odd.reason, 'the turn ended with an error', 'a subtype that is not a plain code is left out');
  const crashed = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines: [init()], stderr: 'API Error: 500 JEVRIS-CANARY-7f3a\n', exitCode: 1 }) });
  assert.deepEqual([crashed.status, crashed.reason], ['failed', 'claude exited with code 1'], 'stderr never enters a reason');
  const none = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines: [init()], exitCode: 1 }) });
  assert.deepEqual([none.status, none.reason], ['failed', 'claude exited with code 1']);
});

test('cancellation: an abort kills the session tree; an abort before start starts nothing; the wall clock times out', async (t) => {
  const box = sandboxDir(t);
  const early = new AbortController();
  early.abort();
  const before = await runClaudeWorker({ ...base(box, { signal: early.signal }), ...stubbed(box, { lines: [result()] }) });
  assert.deepEqual([before.status, before.reason], ['aborted', 'aborted before start']);
  assert.equal(calls(box).length, 0);

  const marker = join(box.dir, 'finished-abort');
  const controller = new AbortController();
  let control;
  const running = runClaudeWorker({ ...base(box, { signal: controller.signal, onStart: (c) => (control = c) }), ...stubbed(box, { lines: [init()], sleepMs: 5_000, after: [result()], finishedMarker: marker }) });
  assert.equal(await sessionKnown(() => control), 'sess-1', 'the session id is known while the turn runs');
  const abortedAt = Date.now();
  controller.abort();
  const outcome = await running;
  assert.equal(outcome.status, 'aborted');
  assert.ok(Date.now() - abortedAt < 4_500, `abort was not prompt: ${Date.now() - abortedAt} ms`);
  assert.equal(existsSync(marker), false, 'the killed session never finished');

  const slow = await runClaudeWorker({ ...base(box, { timeoutMs: 1_000 }), ...stubbed(box, { lines: [init()], sleepMs: 5_000, after: [result()] }) });
  assert.deepEqual([slow.status, slow.reason], ['timeout', 'no result within 1000 ms']);
});

test('offline fallback and unsupported capability: no Claude CLI is unsupported with a hint; the port has D’s shape', async (t) => {
  const box = sandboxDir(t);
  const bare = await runClaudeWorker(base(box));
  assert.deepEqual([bare.status, bare.reason], ['unsupported', CLAUDE_MISSING_MESSAGE]);
  const missing = await runClaudeWorker({ ...base(box), command: { file: join(box.dir, 'no-such-claude') } });
  assert.equal(missing.status, 'unsupported');
  const port = claudeWorkerPort(stubbed(box, { lines: [init(), result()] }));
  const outcome = await port.run(base(box, { auth: 'subscription' }));
  assert.equal(outcome.status, 'completed', outcome.reason);
  for (const key of ['status', 'reason', 'sessionId', 'requestedModel', 'actualModel', 'costUsd', 'usage', 'turns', 'durationMs', 'authMode']) assert.ok(key in outcome, key);
});

test('effort (C16): --effort is a fixed level for that session only, recorded on the outcome; Haiku gets none; a free-text level is refused', async (t) => {
  const box = sandboxDir(t);
  const high = await runClaudeWorker({ ...base(box, { effort: 'high' }), ...stubbed(box, { lines: [init(), assistant(), result()] }) });
  assert.equal(high.status, 'completed', high.reason);
  assert.equal(high.effort, 'high');
  const [call] = calls(box);
  assert.deepEqual(call.argv.slice(-2), ['--effort', 'high']);
  assert.deepEqual(claudePrintArgs({ model: 'claude-opus-5-5', maxTurns: 2, maxBudgetUsd: 1, allowedTools: ['Read'], effort: 'max' }).slice(-2), ['--effort', 'max']);
  assert.equal(claudePrintArgs({ model: 'claude-haiku-4-5', maxTurns: 2, maxBudgetUsd: 1, allowedTools: ['Read'], effort: 'high' }).includes('--effort'), false, 'Haiku has no effort levels');
  assert.equal(claudePrintArgs({ model: 'claude-opus-5-5', maxTurns: 2, maxBudgetUsd: 1, allowedTools: ['Read'] }).includes('--effort'), false, 'absent means the model default');
  const none = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines: [init(), assistant(), result()] }) });
  assert.equal(none.effort, null);
  const bad = await runClaudeWorker({ ...base(box, { effort: 'high; rm -rf' }), ...stubbed(box, { lines: [result()] }) });
  assert.deepEqual([bad.status, bad.reason], ['refused', 'invalid effort']);
  assert.equal(calls(box).length, 2, 'the refused run started nothing');
});

test('first use (owner approval 2026-09-26): the init event is checked before any tool runs; a mismatch stops the run and names why', async (t) => {
  const box = sandboxDir(t);
  const good = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines: [init(), result()] }) });
  assert.deepEqual(good.initCheck, { ok: true, reasonCode: null });
  const cases = [
    [{ cwd: box.dir }, 'WORKER_INIT_CWD'],
    [{ permissionMode: 'bypassPermissions' }, 'WORKER_INIT_BYPASS'],
    [{ tools: ['Read', 'WebFetch'] }, 'WORKER_INIT_TOOLS'],
    [{ model: 'claude-haiku-4-5' }, 'WORKER_INIT_MODEL'],
  ];
  for (const [over, code] of cases) {
    const marker = join(box.dir, `finished-${code}`);
    const out = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines: [init('none', over)], sleepMs: 5_000, after: [result()], finishedMarker: marker }) });
    assert.equal(out.status, 'refused', code);
    assert.deepEqual(out.initCheck, { ok: false, reasonCode: code });
    assert.match(out.reason, new RegExp(code));
    assert.equal(existsSync(marker), false, `${code}: stopped before it finished`);
  }
  const auth = await runClaudeWorker({ ...base(box, { auth: 'subscription' }), ...stubbed(box, { lines: [init('ANTHROPIC_API_KEY')], sleepMs: 5_000, after: [result()] }) });
  assert.deepEqual(auth.initCheck, { ok: false, reasonCode: 'WORKER_INIT_AUTH' });
  const noInit = await runClaudeWorker({ ...base(box), ...stubbed(box, { lines: [result()] }) });
  assert.equal(noInit.initCheck, null, 'no init event: nothing to check');
});
