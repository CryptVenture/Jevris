// ORC-05 (owner directive 2026-09-26): the Antigravity CLI owned session, contract-tested against
// a stub `agy --input-format stream-json --output-format stream-json` (never the real binary,
// never the app). The §15.4 list, plus the watch-and-kill least privilege this harness allows:
// a grant without write tools is enforced after the fact, and the outcome says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ag = await import('../dist/antigravity-worker.js');

const STUB = `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const script = JSON.parse(readFileSync(process.env.AG_STUB_SCRIPT, 'utf8'));
const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];
const seen = KEYS.filter((k) => (process.env[k] ?? '') !== '');
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (stdin += c));
process.stdin.on('end', async () => {
  appendFileSync(process.env.AG_STUB_LOG, JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd(), seen }) + '\\n');
  const cwd = process.cwd();
  for (const line of script.lines ?? []) process.stdout.write((typeof line === 'string' ? line : JSON.stringify(line).replace('"@CWD"', JSON.stringify(cwd))) + '\\n');
  if (script.sleepMs) await new Promise((r) => setTimeout(r, script.sleepMs));
  for (const line of script.after ?? []) process.stdout.write((typeof line === 'string' ? line : JSON.stringify(line).replace('"@CWD"', JSON.stringify(cwd))) + '\\n');
  if (script.stderr) process.stderr.write(script.stderr);
  if (script.finishedMarker) writeFileSync(script.finishedMarker, 'finished');
  process.exitCode = script.exitCode ?? 0;
});
`;

const CID = 'conv-42';
const init = (over = {}) => ({ event: 'init', conversation_id: CID, init: { cwd: '@CWD', tools: ['view_file', 'write_to_file', 'run_command'], permission_mode: 'request-review', model: 'gemini-3.5-pro', ...over } });
const step = (index, type, over = {}) => ({ event: 'step_update', step_update: { conversation_id: CID, step_index: index, state: 'ACTIVE', step_type: type, ...over } });
const toolStep = (index, name) => step(index, 'tool', { tool_name: name });
const result = (over = {}) => ({ event: 'result', result: { conversation_id: CID, status: 'SUCCESS', response: 'Fixed.', duration_seconds: 3, num_turns: 2, usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 12, cache_read_tokens: 7, total_tokens: 139 }, ...over } });

function sandboxDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-agy-worker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stub = join(dir, 'agy-stub.mjs');
  writeFileSync(stub, STUB);
  const work = join(dir, 'work tree');
  mkdirSync(work);
  return { dir, stub, work, log: join(dir, 'calls.log') };
}

function stubbed(box, script, extraEnv = {}) {
  const scriptFile = join(box.dir, `script-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(scriptFile, JSON.stringify(script));
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string' && !/API_KEY|AUTH_TOKEN|OAUTH_TOKEN/.test(key)) env[key] = value;
  return { command: { file: process.execPath, args: [box.stub] }, env: { ...env, AG_STUB_SCRIPT: scriptFile, AG_STUB_LOG: box.log, ...extraEnv } };
}

const calls = (box) => (existsSync(box.log) ? readFileSync(box.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
const base = (box, extra = {}) => ({ prompt: 'Fix the parser.\nKeep Node 20.', model: 'gemini-3.5-pro', cwd: box.work, allowedTools: ['Read', 'Grep', 'Edit'], maxTurns: 5, maxBudgetUsd: 1, timeoutMs: 20_000, ...extra });


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

test('exact output shape: one user event on stdin, stream-json both ways, the sandbox on, the worktree as cwd', async (t) => {
  const box = sandboxDir(t);
  const ids = [];
  const out = await ag.runAntigravityWorker({ ...base(box), ...stubbed(box, { lines: [init(), step(0, 'user_input'), toolStep(1, 'view_file'), step(2, 'agent_response', { text_delta: 'Fixed.' }), result()] }), onSessionId: (id) => ids.push(id) });
  assert.equal(out.status, 'completed', out.reason);
  assert.deepEqual(ids, [CID], 'the conversation id is bound once');
  const [call] = calls(box);
  assert.deepEqual(call.argv, ['--input-format', 'stream-json', '--output-format', 'stream-json', '--model', 'gemini-3.5-pro', '--sandbox', '--print-timeout', '20s']);
  assert.deepEqual(call.stdin.split('\n').filter(Boolean).map((l) => JSON.parse(l)), [{ event: 'user', message: { content: 'Fix the parser.\nKeep Node 20.' } }]);
  assert.equal(call.cwd, realpathSync(box.work));
  assert.deepEqual([out.sessionId, out.actualModel, out.turns, out.resultText, out.costUsd], [CID, 'gemini-3.5-pro', 2, 'Fixed.', null]);
  assert.deepEqual(out.usage, { inputTokens: 100, outputTokens: 32, cacheReadInputTokens: 7, cacheCreationInputTokens: 0 }, 'thinking tokens count as output');
  for (const flag of ['--dangerously-skip-permissions', '-p', '--print', '--prompt']) assert.equal(call.argv.includes(flag), false, flag);
});

test('permission preservation: a bypass mode or a foreign cwd at init is killed and refused', async (t) => {
  const box = sandboxDir(t);
  const marker = join(box.dir, 'finished');
  const bypass = await ag.runAntigravityWorker({ ...base(box), ...stubbed(box, { lines: [init({ permission_mode: 'always-proceed' })], sleepMs: 5_000, after: [result()], finishedMarker: marker }) });
  assert.equal(bypass.status, 'refused');
  assert.match(bypass.reason, /permission_mode always-proceed, not request-review/);
  assert.equal(existsSync(marker), false, 'stopped before it finished');
  const elsewhere = await ag.runAntigravityWorker({ ...base(box), ...stubbed(box, { lines: [init({ cwd: box.dir })], sleepMs: 5_000, after: [result()] }) });
  assert.equal(elsewhere.status, 'refused');
  assert.match(elsewhere.reason, /did not start in the task worktree/);
  assert.deepEqual([bypass.initCheck, elsewhere.initCheck], [{ ok: false, reasonCode: 'WORKER_INIT_BYPASS' }, { ok: false, reasonCode: 'WORKER_INIT_CWD' }]);
  const otherModel = await ag.runAntigravityWorker({ ...base(box), ...stubbed(box, { lines: [init({ model: 'gemini-2.0-flash' })], sleepMs: 5_000, after: [result()] }) });
  assert.equal(otherModel.status, 'refused');
  assert.match(otherModel.reason, /started on gemini-2\.0-flash, not gemini-3\.5-pro/);
  assert.deepEqual(otherModel.initCheck, { ok: false, reasonCode: 'WORKER_INIT_MODEL' });
  const good = await ag.runAntigravityWorker({ ...base(box), ...stubbed(box, { lines: [init(), result()] }) });
  assert.deepEqual(good.initCheck, { ok: true, reasonCode: null });
});

test('least privilege after the fact: a step outside the grant kills the run; a read-only grant says it is enforced only after the fact', async (t) => {
  const box = sandboxDir(t);
  const ro = ['Read', 'Grep'];
  const write = await ag.runAntigravityWorker({ ...base(box, { allowedTools: ro }), ...stubbed(box, { lines: [init(), toolStep(1, 'write_to_file')], sleepMs: 5_000, after: [result()] }) });
  assert.equal(write.status, 'refused');
  assert.match(write.reason, /write tool write_to_file was not granted/);
  assert.equal(write.readOnlyEnforcement, 'after-the-fact');
  const shell = await ag.runAntigravityWorker({ ...base(box), ...stubbed(box, { lines: [init(), toolStep(1, 'run_command')], sleepMs: 5_000, after: [result()] }) });
  assert.equal(shell.status, 'refused');
  assert.match(shell.reason, /shell tool run_command was not granted \(no Bash\)/);
  assert.equal(shell.readOnlyEnforcement, 'not-applicable', 'a write grant has nothing read-only to enforce');
  const web = await ag.runAntigravityWorker({ ...base(box, { allowedTools: ['Read', 'Bash', 'Edit'] }), ...stubbed(box, { lines: [init(), toolStep(1, 'read_url_content')], sleepMs: 5_000, after: [result()] }) });
  assert.equal(web.status, 'refused');
  const allowed = await ag.runAntigravityWorker({ ...base(box, { allowedTools: ['Read', 'Bash', 'Edit'] }), ...stubbed(box, { lines: [init(), toolStep(1, 'run_command'), toolStep(2, 'replace_file_content'), result()] }) });
  assert.equal(allowed.status, 'completed', allowed.reason);
  assert.deepEqual(['view_file', 'grep_search', 'mcp_jevris_status'].map(ag.antigravityToolKind), ['other', 'other', 'other']);
});

test('auth: a subscription run sees no vendor or Google key; api-key is refused (no documented key sign-in)', async (t) => {
  const box = sandboxDir(t);
  const keys = { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', XAI_API_KEY: 'x', GEMINI_API_KEY: 'g', GOOGLE_API_KEY: 'k' };
  const sub = await ag.runAntigravityWorker({ ...base(box, { auth: 'subscription' }), ...stubbed(box, { lines: [init(), result()] }, keys) });
  assert.equal(sub.status, 'completed', sub.reason);
  assert.deepEqual(calls(box)[0].seen, []);
  const key = await ag.runAntigravityWorker({ ...base(box, { auth: 'api-key' }), ...stubbed(box, { lines: [result()] }, keys) });
  assert.equal(key.status, 'refused');
  assert.match(key.reason, /documents no API-key sign-in/);
  assert.equal(calls(box).length, 1, 'nothing started');
});

test('access limit (R67): a G pattern in the error, else in stderr of a failed run, is a usage window by rule until certified', async (t) => {
  const box = sandboxDir(t);
  const limited = await ag.runAntigravityWorker({ ...base(box), ...stubbed(box, { lines: [init(), result({ status: 'ERROR', error: 'RESOURCE_EXHAUSTED: quota exceeded for this account; resets in 3h 10m JEVRIS-CANARY-7f3a', response: '' })] }) });
  assert.deepEqual([limited.status, limited.reason], ['access-limit', 'the run hit an access limit: usage-window (antigravity.text.g1)']);
  assert.deepEqual([limited.accessLimit.class, limited.accessLimit.weekly, limited.accessLimit.resetBasis], ['usage-window', false, 'rule'], 'an uncertified row never trusts the stated reset');
  assert.equal(limited.resetAt, undefined);
  assert.deepEqual([limited.accessSignal.port, limited.accessSignal.channel, limited.accessSignal.text.pattern], ['antigravity', 'error-text', 'G1']);
  assert.equal(limited.accessSignal.text.resetForm, 'relative', 'the stated reset travels as a number for the runner to judge');
  assert.equal(limited.accessSignal.certified, undefined, 'a port never asserts its own proof');
  assert.doesNotMatch(JSON.stringify(limited), /JEVRIS-CANARY|RESOURCE_EXHAUSTED/, 'R80: the error text is never kept');
  const weekly = await ag.runAntigravityWorker({ ...base(box), ...stubbed(box, { lines: [init(), result({ status: 'ERROR', error: 'You have reached your weekly limit for this model.', response: '' })] }) });
  assert.deepEqual([weekly.accessLimit.signal, weekly.accessLimit.weekly], ['antigravity.text.g2', true]);
  const crashed = await ag.runAntigravityWorker({ ...base(box), ...stubbed(box, { lines: [init()], stderr: 'error: usage limit reached\n', exitCode: 1 }) });
  assert.deepEqual([crashed.status, crashed.accessLimit?.signal], ['access-limit', 'antigravity.text.g1'], 'stderr of a failed run with no result counts');
  const won = await ag.runAntigravityWorker({ ...base(box), ...stubbed(box, { lines: [init(), result()], stderr: 'quota exceeded\n' }) });
  assert.deepEqual([won.status, won.accessSignal], ['completed', undefined], 'success wins');
  const disk = await ag.runAntigravityWorker({ ...base(box), ...stubbed(box, { lines: [init(), result({ status: 'ERROR', error: 'disk quota exceeded', response: '' })], exitCode: 1 }) });
  assert.deepEqual([disk.status, disk.accessSignal], ['failed', undefined], 'a disk quota is not an access limit');
  const signIn = await ag.runAntigravityWorker({ ...base(box, { auth: 'subscription' }), ...stubbed(box, { lines: [init(), result({ status: 'ERROR', error: 'quota exceeded', response: '' })] }) });
  assert.equal(signIn.accessLimit.class, 'usage-window', 'the sign-in mode does not change a text row');
});

// C2's G4-G7 (c2867879, 260b7923): Gemini's own error texts, quoted exactly from ai.google.dev
// (re-read 2026-09-28). Uncertified, credit and a blocked key are held as a timed usage window
// (OP-4); a rate limit and an overload keep their class. The text is never kept.
test('access limit (R67): each of Gemini\'s sourced error sentences reaches its pinned G pattern and class', async (t) => {
  const box = sandboxDir(t);
  const run = (error) => ag.runAntigravityWorker({ ...base(box), ...stubbed(box, { lines: [init(), result({ status: 'ERROR', error: `${error} JEVRIS-CANARY-7f3a`, response: '' })] }) });
  for (const [sentence, pattern, status, cls] of [
    ['402 Payment Required: Your Prepay credit balance is depleted.', 'G4', 'access-limit', 'usage-window'],
    ['Your API key was reported as leaked. Please use another API key.', 'G5', 'access-limit', 'usage-window'],
    ['429 quota_exceeded: You have exceeded your daily quota.', 'G1', 'access-limit', 'usage-window'],
    ['429 rate_limit_exceeded: You have exceeded the per-minute or per-second request or token limit.', 'G6', 'access-limit', 'rate-limit'],
    ['503: The service is temporarily overloaded or down.', 'G7', 'overloaded', null],
    // E's G8 (10c39931) on C2's core row (dcb43d50): Gemini's 401 sentence, held as a timed window uncertified.
    ['401 UNAUTHENTICATED: The API key is missing, invalid, or expired.', 'G8', 'access-limit', 'usage-window'],
    ['The API key is missing, invalid or expired.', 'G8', 'access-limit', 'usage-window'],
  ]) {
    const out = await run(sentence);
    assert.equal(out.accessSignal?.text?.pattern, pattern, sentence);
    assert.equal(out.status, status, sentence);
    if (cls !== null) assert.deepEqual([out.accessLimit?.class, out.accessLimit?.resetBasis], [cls, 'rule'], sentence);
    assert.doesNotMatch(JSON.stringify(out), /JEVRIS-CANARY|Prepay|leaked|per-minute|overloaded or down|daily quota|missing, invalid/, `${pattern}: the text is never kept`);
  }
  // G8 needs the whole sentence: a bare 401 or a partial phrase reports nothing.
  for (const text of ['401 UNAUTHENTICATED', 'Request had invalid authentication credentials.', 'The API key is missing.']) {
    const out = await run(text);
    assert.deepEqual([out.status, out.accessSignal, out.accessLimit], ['failed', undefined, undefined], text);
  }
});

test('results, caps and effort', async (t) => {
  const box = sandboxDir(t);
  const errored = await ag.runAntigravityWorker({ ...base(box), ...stubbed(box, { lines: [init(), result({ status: 'ERROR', error: 'unknown model JEVRIS-CANARY-7f3a' })], exitCode: 1 }) });
  assert.deepEqual([errored.status, errored.reason], ['failed', 'the run ended ERROR']);
  assert.doesNotMatch(JSON.stringify(errored), /JEVRIS-CANARY/);
  const odd = await ag.runAntigravityWorker({ ...base(box), ...stubbed(box, { lines: [init(), result({ status: 'weird JEVRIS', error: '' })], exitCode: 1 }) });
  assert.equal(odd.reason, 'the run ended without a known status');
  const waiting = await ag.runAntigravityWorker({ ...base(box), ...stubbed(box, { lines: [init(), result({ status: 'WAITING', response: '' })] }) });
  assert.deepEqual([waiting.status, waiting.reason], ['failed', 'the run ended WAITING']);
  const none = await ag.runAntigravityWorker({ ...base(box), ...stubbed(box, { lines: ['noise', init()] }) });
  assert.deepEqual([none.status, none.reason], ['failed', 'the stream ended without a result']);
  const capped = await ag.runAntigravityWorker({ ...base(box, { maxTurns: 1, allowedTools: ['Read'] }), ...stubbed(box, { lines: [init(), toolStep(1, 'view_file'), toolStep(1, 'view_file'), toolStep(2, 'grep_search')], sleepMs: 5_000, after: [result()] }) });
  assert.deepEqual([capped.status, capped.reason], ['max-turns', 'more than 1 steps'], 'a redelivered step is one step');
  const effort = await ag.runAntigravityWorker({ ...base(box, { effort: 'xhigh' }), ...stubbed(box, { lines: [init(), result()] }) });
  assert.equal(effort.effort, 'high', 'xhigh passes as the nearest level agy has');
  assert.deepEqual(calls(box).at(-1).argv.slice(-2), ['--effort', 'high']);
});

test('cancellation and unsupported capability', async (t) => {
  const box = sandboxDir(t);
  const early = new AbortController();
  early.abort();
  const before = await ag.runAntigravityWorker({ ...base(box, { signal: early.signal }), ...stubbed(box, { lines: [result()] }) });
  assert.deepEqual([before.status, before.reason], ['aborted', 'aborted before start']);
  const controller = new AbortController();
  let control;
  const running = ag.runAntigravityWorker({ ...base(box, { signal: controller.signal, onStart: (c) => (control = c) }), ...stubbed(box, { lines: [init()], sleepMs: 5_000, after: [result()] }) });
  assert.equal(await sessionKnown(() => control), CID);
  controller.abort();
  assert.equal((await running).status, 'aborted');
  const slow = await ag.runAntigravityWorker({ ...base(box, { timeoutMs: 1_000 }), ...stubbed(box, { lines: [init()], sleepMs: 5_000, after: [result()] }) });
  assert.deepEqual([slow.status, slow.reason], ['timeout', 'no result within 1000 ms']);
  const bare = await ag.runAntigravityWorker(base(box));
  assert.deepEqual([bare.status, bare.reason], ['unsupported', ag.ANTIGRAVITY_MISSING_MESSAGE]);
  const port = ag.antigravityWorkerPort(stubbed(box, { lines: [init(), result()] }));
  assert.equal((await port.run(base(box))).status, 'completed');
});
