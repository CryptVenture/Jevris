// CDX-04: the Codex owned session, contract-tested against a stub `codex exec
// --json` (never the real binary). The §15.4 conformance list: event validation,
// duplicate delivery, cancellation, stale revision, exact output shape, permission
// preservation, user pin, offline fallback and unsupported capability. Through D's
// runLeasedTask, the Codex port gets the same lease, fencing, kill-switch hold and owned-effect
// record as the Claude port.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runCodexWorker, codexWorkerPort, codexExecArgs, codexSandbox, isCodexModel, CODEX_MISSING_MESSAGE } = await import('../dist/codex-worker.js');
const orchestrator = await import('@jevris/orchestrator');
const { holdPendingEffects } = await import('@jevris/store');
const { closeTestStore, testStore } = await import('../../../packages/orchestrator/test/store-fixture.mjs');

// A stand-in for `codex exec --json`: logs argv, stdin and cwd, then plays a script.
const STUB = `
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const script = JSON.parse(readFileSync(process.env.CODEX_STUB_SCRIPT, 'utf8'));
const seen = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'CODEX_ACCESS_TOKEN'].filter((k) => (process.env[k] ?? '') !== '');
if (process.argv[2] === 'login') {
  appendFileSync(process.env.CODEX_STUB_LOG, JSON.stringify({ argv: process.argv.slice(2), seen }) + '\\n');
  process.stdout.write((script.login ?? 'Logged in using ChatGPT') + '\\n');
  process.exit(script.login === 'Not logged in' ? 1 : 0);
}
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (stdin += c));
process.stdin.on('end', async () => {
  appendFileSync(process.env.CODEX_STUB_LOG, JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd(), pid: process.pid, seen }) + '\\n');
  if (script.write) { mkdirSync(join(process.cwd(), 'mod'), { recursive: true }); writeFileSync(join(process.cwd(), script.write), 'done\\n'); }
  for (const line of script.lines ?? []) process.stdout.write((typeof line === 'string' ? line : JSON.stringify(line)) + '\\n');
  if (script.sleepMs) await new Promise((r) => setTimeout(r, script.sleepMs));
  for (const line of script.after ?? []) process.stdout.write((typeof line === 'string' ? line : JSON.stringify(line)) + '\\n');
  if (script.stderr) process.stderr.write(script.stderr);
  if (script.finishedMarker) writeFileSync(script.finishedMarker, 'finished');
  process.exitCode = script.exitCode ?? 0;
});
`;

const THREAD = { type: 'thread.started', thread_id: 'thr_0123' };
const TURN = { type: 'turn.started' };
const DONE = { type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 40, cache_write_input_tokens: 5, output_tokens: 30, reasoning_output_tokens: 10 } };
const command = (id) => ({ type: 'item.completed', item: { id, type: 'command_execution', command: 'npm test', aggregated_output: 'ok', exit_code: 0, status: 'completed' } });
const message = (text) => ({ type: 'item.completed', item: { id: 'msg_1', type: 'agent_message', text } });

function sandboxDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-codex-worker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stub = join(dir, 'codex-stub.mjs');
  writeFileSync(stub, STUB);
  const work = join(dir, 'work tree');
  mkdirSync(work);
  return { dir, stub, work, log: join(dir, 'calls.log') };
}

function stubbed(box, script, extraEnv = {}) {
  const scriptFile = join(box.dir, `script-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(scriptFile, JSON.stringify(script));
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string' && !/API_KEY|AUTH_TOKEN|ACCESS_TOKEN|OPENAI_BASE_URL/.test(key)) env[key] = value;
  // The Codex home is the sandbox's: the port reads its config.toml for a custom provider (OP-12).
  return { command: { file: process.execPath, args: [box.stub] }, env: { ...env, CODEX_HOME: join(box.dir, 'codex-home'), CODEX_STUB_SCRIPT: scriptFile, CODEX_STUB_LOG: box.log, ...extraEnv } };
}

const calls = (box) => (existsSync(box.log) ? readFileSync(box.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);

const base = (box, extra = {}) => ({ prompt: 'Fix the parser.\nKeep Node 20.', model: 'gpt-5.2-codex', cwd: box.work, allowedTools: ['Read', 'Grep', 'Edit', 'Write'], maxTurns: 5, maxBudgetUsd: 1, timeoutMs: 20_000, ...extra });


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

test('exact output shape: the model is chosen at turn start, the prompt goes on stdin, the session runs in the worktree', async (t) => {
  const box = sandboxDir(t);
  const ids = [];
  const outcome = await runCodexWorker({ ...base(box), ...stubbed(box, { lines: [THREAD, TURN, command('c1'), message('Fixed.'), DONE] }), onSessionId: (id) => ids.push(id) });
  assert.equal(outcome.status, 'completed', outcome.reason);
  assert.deepEqual(ids, ['thr_0123'], 'the thread id is bound once, as soon as thread.started names it');
  const [call] = calls(box);
  assert.deepEqual(call.argv, [...codexExecArgs('gpt-5.2-codex', 'workspace-write')]);
  assert.deepEqual(codexExecArgs('m', 'read-only'), ['exec', '--json', '--model', 'm', '--sandbox', 'read-only', '--skip-git-repo-check', '--config', 'approval_policy="never"', '--config', 'sandbox_workspace_write.network_access=false', '--config', 'web_search="disabled"']);
  assert.equal(call.stdin, 'Fix the parser.\nKeep Node 20.');
  assert.equal(call.argv.some((arg) => arg.includes('Fix the parser')), false, 'the prompt never goes on argv');
  assert.equal(realpathSync(call.cwd), realpathSync(box.work));
  assert.equal(outcome.sessionId, 'thr_0123');
  assert.deepEqual(outcome.usage, { inputTokens: 120, outputTokens: 30, cacheReadInputTokens: 40, cacheCreationInputTokens: 5 });
  assert.equal(outcome.turns, 1);
  assert.equal(outcome.resultText, 'Fixed.');
});

test('user pin: the requested model is passed as given and never replaced; the answering model stays unknown', async (t) => {
  const box = sandboxDir(t);
  const outcome = await runCodexWorker({ ...base(box, { model: 'o4-mini-pinned' }), ...stubbed(box, { lines: [THREAD, DONE] }) });
  assert.equal(calls(box)[0].argv[calls(box)[0].argv.indexOf('--model') + 1], 'o4-mini-pinned');
  assert.equal(outcome.requestedModel, 'o4-mini-pinned');
  assert.equal(outcome.actualModel, null, 'Codex exec does not report the model: unknown, never guessed');
});

test('permission preservation: read-only unless a write tool is granted; never a bypass flag, full access or approval on anyone’s behalf', async (t) => {
  const box = sandboxDir(t);
  assert.equal(codexSandbox(['Read', 'Grep', 'Bash']), 'read-only');
  assert.equal(codexSandbox(['Read', 'Edit']), 'workspace-write');
  await runCodexWorker({ ...base(box, { allowedTools: ['Read', 'Grep'] }), ...stubbed(box, { lines: [THREAD, DONE] }) });
  const argv = calls(box)[0].argv;
  assert.equal(argv[argv.indexOf('--sandbox') + 1], 'read-only');
  for (const forbidden of ['--dangerously-bypass-approvals-and-sandbox', 'danger-full-access', '--full-auto', '--yolo']) assert.equal(argv.includes(forbidden), false, forbidden);
  assert.ok(argv.includes('approval_policy="never"'), 'nothing is approved automatically: an action that needs approval fails back to the model');
  const refused = await runCodexWorker({ ...base(box, { allowedTools: ['Read', 'WebFetch'] }), ...stubbed(box, { lines: [DONE] }) });
  assert.equal(refused.status, 'refused');
  assert.equal(refused.reason, 'invalid allowedTools');
  assert.equal(calls(box).length, 1, 'a refused grant starts nothing');
});

test('event validation: noise, non-objects and unknown events are ignored; a failed turn or stream error fails with fixed text (R80)', async (t) => {
  const box = sandboxDir(t);
  const noisy = await runCodexWorker({ ...base(box), ...stubbed(box, { lines: ['Reading prompt from stdin...', '[1,2]', '"text"', '{"no":"type"}', { type: 'future.event', x: 1 }, THREAD, DONE] }) });
  assert.equal(noisy.status, 'completed', noisy.reason);
  const failed = await runCodexWorker({ ...base(box), ...stubbed(box, { lines: [THREAD, { type: 'turn.failed', error: { message: 'model not found: gpt-x\nstack' } }], exitCode: 1 }) });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.reason, 'the turn failed');
  const errored = await runCodexWorker({ ...base(box), ...stubbed(box, { lines: [{ type: 'error', message: 'stream disconnected JEVRIS-CANARY-7f3a' }], exitCode: 1 }) });
  assert.deepEqual([errored.status, errored.reason], ['failed', 'the stream reported an error']);
  const crashed = await runCodexWorker({ ...base(box), ...stubbed(box, { lines: [THREAD], stderr: 'Error: not logged in JEVRIS-CANARY-7f3a\n', exitCode: 2 }) });
  assert.deepEqual([crashed.status, crashed.reason], ['failed', 'codex exec exited with code 2']);
  for (const outcome of [errored, crashed]) assert.doesNotMatch(JSON.stringify(outcome), /JEVRIS-CANARY/, 'no remote text in the outcome');
  const truncated = await runCodexWorker({ ...base(box), ...stubbed(box, { lines: [THREAD, TURN] }) });
  assert.deepEqual([truncated.status, truncated.reason], ['failed', 'the stream ended without a completed turn']);
  // First-use check: codex's stream names no cwd or model, so the check is its shape — thread.started first.
  assert.deepEqual(truncated.initCheck, { ok: true, reasonCode: null });
  assert.deepEqual(noisy.initCheck, { ok: false, reasonCode: 'WORKER_INIT_SHAPE' }, 'an unknown event before thread.started is a changed stream');
  assert.equal(errored.initCheck, null, 'an error alone is nothing to check');
});

test('duplicate delivery: a redelivered item is one step; the step cap stops the session when exceeded', async (t) => {
  const box = sandboxDir(t);
  const once = await runCodexWorker({ ...base(box, { maxTurns: 1 }), ...stubbed(box, { lines: [THREAD, command('c1'), command('c1'), DONE] }) });
  assert.equal(once.status, 'completed', once.reason);
  assert.equal(once.turns, 1);
  const marker = join(box.dir, 'finished-cap');
  const capped = await runCodexWorker({ ...base(box, { maxTurns: 1 }), ...stubbed(box, { lines: [THREAD, command('c1'), command('c2')], sleepMs: 3_000, after: [DONE], finishedMarker: marker }) });
  assert.deepEqual([capped.status, capped.reason], ['max-turns', 'more than 1 steps']);
  assert.equal(existsSync(marker), false, 'the session was killed, not left to finish');
});

test('cancellation: an abort kills the session tree; an abort before start starts nothing; the wall clock times out', async (t) => {
  const box = sandboxDir(t);
  const early = new AbortController();
  early.abort();
  const before = await runCodexWorker({ ...base(box, { signal: early.signal }), ...stubbed(box, { lines: [DONE] }) });
  assert.deepEqual([before.status, before.reason], ['aborted', 'aborted before start']);
  assert.equal(calls(box).length, 0);

  const marker = join(box.dir, 'finished-abort');
  const controller = new AbortController();
  let control;
  const running = runCodexWorker({ ...base(box, { signal: controller.signal, onStart: (c) => (control = c) }), ...stubbed(box, { lines: [THREAD], sleepMs: 5_000, after: [DONE], finishedMarker: marker }) });
  assert.equal(await sessionKnown(() => control), 'thr_0123', 'the thread id is known while the turn runs');
  const abortedAt = Date.now();
  controller.abort();
  const outcome = await running;
  assert.equal(outcome.status, 'aborted');
  assert.ok(Date.now() - abortedAt < 4_500, `abort was not prompt: ${Date.now() - abortedAt} ms`);
  assert.equal(existsSync(marker), false, 'the killed session never finished');

  const slow = await runCodexWorker({ ...base(box, { timeoutMs: 1_000 }), ...stubbed(box, { lines: [THREAD], sleepMs: 5_000, after: [DONE] }) });
  assert.deepEqual([slow.status, slow.reason], ['timeout', 'no result within 1000 ms']);
});

test('offline fallback and unsupported capability: no Codex CLI is unsupported with a hint; cost is never invented', async (t) => {
  const box = sandboxDir(t);
  // The bare name in the test environment is refused before any PATH lookup: nothing starts.
  const bare = await runCodexWorker(base(box));
  assert.deepEqual([bare.status, bare.reason], ['unsupported', CODEX_MISSING_MESSAGE]);
  const missing = await runCodexWorker({ ...base(box), command: { file: join(box.dir, 'no-such-codex') } });
  assert.equal(missing.status, 'unsupported');
  const done = await runCodexWorker({ ...base(box), ...stubbed(box, { lines: [THREAD, DONE] }) });
  assert.equal(done.costUsd, null, 'Codex reports tokens, not money');
  assert.equal(isCodexModel('gpt-6-sol'), true, 'a registry OpenAI model');
  assert.equal(isCodexModel('gpt-5.6-terra'), true, "through the access row's {id} template");
  assert.equal(isCodexModel('claude-opus-5-5'), false, "another provider's model");
  assert.equal(isCodexModel('gpt-5.2-codex'), false, 'an id the registry does not know is not claimed');
});

test('auth: a subscription run sees no vendor key and needs a ChatGPT login; a key run needs a key', async (t) => {
  const box = sandboxDir(t);
  const keys = { OPENAI_API_KEY: 'o', CODEX_API_KEY: 'c', ANTHROPIC_API_KEY: 'a' };
  const withKeys = (script) => {
    const s = stubbed(box, script);
    return { ...s, env: { ...s.env, ...keys } };
  };
  const sub = await runCodexWorker({ ...base(box, { auth: 'subscription' }), ...withKeys({ lines: [THREAD, DONE] }) });
  assert.equal(sub.status, 'completed', sub.reason);
  assert.equal(sub.authMode, 'subscription');
  const [login, exec] = calls(box);
  assert.deepEqual(login.argv, ['login', 'status'], 'the login is checked first, read-only');
  assert.deepEqual([login.seen, exec.seen], [[], []], 'no vendor key reaches a subscription run');

  const apiLogin = await runCodexWorker({ ...base(box, { auth: 'subscription' }), ...withKeys({ login: 'Logged in using an API key - sk-***', lines: [THREAD, DONE] }) });
  assert.deepEqual([apiLogin.status, apiLogin.reason], ['refused', 'refused: subscription mode, but Codex holds an API-key login; run codex login to sign in with ChatGPT']);
  const signedOut = await runCodexWorker({ ...base(box, { auth: 'subscription' }), ...withKeys({ login: 'Not logged in', lines: [THREAD, DONE] }) });
  assert.deepEqual([signedOut.status, signedOut.reason], ['refused', 'refused: subscription mode, but Codex is not signed in; run codex login']);
  assert.equal(calls(box).filter((c) => c.argv[0] === 'exec').length, 1, 'a refused run never starts a turn');

  const key = await runCodexWorker({ ...base(box, { auth: 'api-key' }), ...withKeys({ lines: [THREAD, DONE] }) });
  assert.equal(key.status, 'completed', key.reason);
  assert.equal(key.authMode, 'api-key');
  assert.deepEqual(calls(box).at(-1).seen, ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY']);
  const noKey = await runCodexWorker({ ...base(box, { auth: 'api-key' }), ...stubbed(box, { lines: [THREAD, DONE] }) });
  assert.deepEqual([noKey.status, noKey.reason], ['refused', 'refused: api-key mode needs CODEX_API_KEY or OPENAI_API_KEY in the environment']);
  const undecided = await runCodexWorker({ ...base(box), ...stubbed(box, { lines: [THREAD, DONE] }) });
  assert.equal(undecided.authMode, 'unknown');
});

// R65 (design 5.2, 5.3): Codex carries a limit only as text; the port keeps the pattern id.
const CANARY = 'JEVRIS-CANARY-7f3a';
const failedTurn = (message) => ({ type: 'turn.failed', error: { message } });

test('access limit (R65): the #12299 usage-limit message is a usage window by rule; no remote text is kept', async (t) => {
  const box = sandboxDir(t);
  const limited = await runCodexWorker({ ...base(box), ...stubbed(box, { lines: [THREAD, TURN, failedTurn(`You've hit your usage limit. Upgrade to Pro, purchase more credits or try again at Feb 23rd, 2026 9:01 PM. ${CANARY}`)] }) });
  assert.deepEqual([limited.status, limited.reason], ['access-limit', 'the run hit an access limit: usage-window (codex.text.x1)']);
  assert.deepEqual(limited.accessLimit, { class: 'usage-window', signal: 'codex.text.x1', weekly: false, resetBasis: 'rule', resetAtMs: limited.accessLimit.resetAtMs });
  assert.equal(limited.resetAt, undefined, 'a zoneless date is not trusted before a capture certifies its form');
  assert.equal(limited.accessSignal.port, 'codex');
  assert.equal(limited.accessSignal.channel, 'error-text');
  assert.equal(limited.accessSignal.text.pattern, 'X1');
  assert.equal(limited.accessSignal.certified, undefined);
  assert.doesNotMatch(JSON.stringify(limited), new RegExp(CANARY));
  const weekly = await runCodexWorker({ ...base(box), ...stubbed(box, { lines: [THREAD, TURN, failedTurn("You've hit your usage limit for this weekly window. Try again in 3 days.")] }) });
  assert.deepEqual([weekly.accessLimit.weekly, weekly.accessLimit.resetBasis], [true, 'reported']);
  assert.equal(typeof weekly.resetAt, 'string', 'a relative reset is reported');
  const other = await runCodexWorker({ ...base(box), ...stubbed(box, { lines: [THREAD, TURN, failedTurn('model not found')] }) });
  assert.deepEqual([other.status, other.accessSignal], ['failed', undefined]);
});

test('access limit (R65, OP-4): credit and blocked text are held as timed windows; rate and overload keep their class', async (t) => {
  const box = sandboxDir(t);
  const credit = await runCodexWorker({ ...base(box, { auth: 'api-key' }), ...stubbed(box, { lines: [THREAD, TURN, failedTurn('You exceeded your current quota, please check your plan and billing details.')] }, { OPENAI_API_KEY: 'k-test' }) });
  assert.deepEqual([credit.status, credit.accessLimit.class, credit.accessLimit.signal, credit.accessLimit.resetBasis], ['access-limit', 'usage-window', 'codex.text.x2', 'rule']);
  const blocked = await runCodexWorker({ ...base(box), ...stubbed(box, { lines: [THREAD, TURN, failedTurn('Your account has been deactivated.')] }) });
  assert.deepEqual([blocked.accessLimit.class, blocked.accessLimit.signal], ['usage-window', 'codex.text.x3']);
  const rate = await runCodexWorker({ ...base(box, { auth: 'api-key' }), ...stubbed(box, { lines: [THREAD, TURN, failedTurn('stream error: 429 Too Many Requests')] }, { OPENAI_API_KEY: 'k-test' }) });
  assert.deepEqual([rate.status, rate.accessLimit.class], ['access-limit', 'rate-limit']);
  const busy = await runCodexWorker({ ...base(box), ...stubbed(box, { lines: [THREAD, TURN, { type: 'error', message: 'Reconnecting... 1/5' }, { type: 'error', message: 'server_is_overloaded' }], exitCode: 1 }) });
  assert.deepEqual([busy.status, busy.reason], ['overloaded', 'the provider was overloaded (codex.text.x5)'], 'the last matching error event counts');
});

test('access limit (R65): success wins; stderr counts only for timed patterns of a run with no error event', async (t) => {
  const box = sandboxDir(t);
  const done = { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
  const won = await runCodexWorker({ ...base(box), ...stubbed(box, { lines: [THREAD, TURN, done], stderr: "You've hit your usage limit.\n" }) });
  assert.deepEqual([won.status, won.accessSignal], ['completed', undefined]);
  const crashed = await runCodexWorker({ ...base(box), ...stubbed(box, { lines: [THREAD], stderr: `error: 429 Too Many Requests ${CANARY}\n`, exitCode: 1 }) });
  assert.deepEqual([crashed.status, crashed.accessLimit?.class], ['access-limit', 'rate-limit']);
  assert.doesNotMatch(JSON.stringify(crashed), new RegExp(CANARY));
  const untimed = await runCodexWorker({ ...base(box), ...stubbed(box, { lines: [THREAD], stderr: 'Your account has been suspended.\n', exitCode: 1 }) });
  assert.deepEqual([untimed.status, untimed.accessSignal], ['failed', undefined], 'stderr never gives a credit or blocked signal');
  const withEvent = await runCodexWorker({ ...base(box), ...stubbed(box, { lines: [THREAD, TURN, failedTurn('model not found')], stderr: '429 Too Many Requests\n', exitCode: 1 }) });
  assert.deepEqual([withEvent.status, withEvent.accessSignal], ['failed', undefined], 'stderr is not read when an error event came');
});

test('access limit (OP-12): a custom Codex provider or OPENAI_BASE_URL reports no access signal', async (t) => {
  const box = sandboxDir(t);
  const lines = [THREAD, TURN, failedTurn("You've hit your usage limit.")];
  const viaEnv = await runCodexWorker({ ...base(box), ...stubbed(box, { lines }, { OPENAI_BASE_URL: 'http://127.0.0.1:9/v1' }) });
  assert.deepEqual([viaEnv.status, viaEnv.accessSignal], ['failed', undefined]);
  mkdirSync(join(box.dir, 'codex-home'));
  writeFileSync(join(box.dir, 'codex-home', 'config.toml'), 'model_provider = "local"\n[model_providers.local]\nbase_url = "http://127.0.0.1:9/v1"\n');
  const custom = await runCodexWorker({ ...base(box), ...stubbed(box, { lines }) });
  assert.deepEqual([custom.status, custom.accessSignal], ['failed', undefined]);
  writeFileSync(join(box.dir, 'codex-home', 'config.toml'), 'model_provider = "openai"\n');
  mkdirSync(join(box.work, '.codex'));
  writeFileSync(join(box.work, '.codex', 'config.toml'), 'openai_base_url = "http://127.0.0.1:9/v1"\n');
  const project = await runCodexWorker({ ...base(box), ...stubbed(box, { lines }) });
  assert.deepEqual([project.status, project.accessSignal], ['failed', undefined]);
  writeFileSync(join(box.work, '.codex', 'config.toml'), 'model = "gpt-5.2-codex"\n');
  const plain = await runCodexWorker({ ...base(box), ...stubbed(box, { lines }) });
  assert.equal(plain.status, 'access-limit', 'a config that redirects nothing leaves the signal');
});

// ------------------------------------------------------------------ through D's runLeasedTask

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

async function leased(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-codex-lease-'));
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
  await orchestrator.submitPlan(ws, {
    tasks: [{ id: 'T1', requirementIds: ['R1'], acceptanceCheckIds: ['fixed'], expectedOutputs: ['patch'], writeScopes: ['mod'], estimateMicroUsd: 500_000 }],
    ownerId: 'alice',
    rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 },
  });
  const authority = orchestrator.leaseAuthorityFor(ws);
  const [grant] = (await orchestrator.scheduleTasks(ws, { authority, holder: orchestrator.selfIdentity() })).leased;
  return { ws, store, authority, grant };
}

test('through runLeasedTask: a Codex run is a leased, recorded owned effect in its worktree, and the task verifies only from receipts', async (t) => {
  const box = sandboxDir(t);
  const f = await leased(t);
  const port = codexWorkerPort(stubbed(box, { write: 'mod/fixed.txt', lines: [THREAD, { type: 'item.completed', item: { id: 'p1', type: 'file_change', changes: [{ path: 'mod/fixed.txt', kind: 'add' }], status: 'completed' } }, DONE] }));
  const result = await orchestrator.runLeasedTask(f.ws, f.grant, { authority: f.authority, port, model: 'gpt-5.2-codex', allowedTools: ['Read', 'Edit', 'Write'], prompt: 'write mod/fixed.txt' });
  assert.equal(result.finalState, 'awaiting-evidence', result.reasonCode);
  const run = orchestrator.workerRuns(f.ws, 'T1')[0];
  assert.deepEqual([run.status, run.requestedModel, run.actualModel, run.costUsd, run.sessionId], ['completed', 'gpt-5.2-codex', null, null, 'thr_0123']);
  assert.equal(run.effectOperationId, orchestrator.effectOperationId(f.grant.lease.id));
  assert.equal(run.effectState, 'acknowledged');
  assert.deepEqual(run.changedPaths, ['mod/fixed.txt']);
  assert.notEqual(calls(box)[0].cwd, f.ws.workspaceRoot, 'the session ran in the task worktree, not the checkout');
  const rsv = f.ws.host.list('reservations').find((r) => r.leaseId === f.grant.lease.id);
  assert.equal(rsv.reservation.state, 'uncertain', 'no reported cost: the spend is released as uncertain, never as zero');
  const verdict = await orchestrator.completeTask(f.ws, 'T1');
  assert.equal(orchestrator.getTask(f.ws, 'T1').node.state, 'verified', JSON.stringify(verdict));
});

test('through runLeasedTask: the kill switch holds a running Codex session’s effect; the task stays blocked for a person', async (t) => {
  const box = sandboxDir(t);
  const f = await leased(t);
  const inner = codexWorkerPort(stubbed(box, { lines: [THREAD, DONE] }));
  let held;
  const port = {
    async run(input) {
      held = holdPendingEffects(f.store, { nowMs: Date.now(), actor: 'tester', channel: 'cli', reason: 'incident' }).held;
      return inner.run(input);
    },
  };
  const result = await orchestrator.runLeasedTask(f.ws, f.grant, { authority: f.authority, port, model: 'gpt-5.2-codex', allowedTools: ['Read'], prompt: 'p' });
  assert.deepEqual(held, [orchestrator.effectOperationId(f.grant.lease.id)]);
  assert.equal(result.reasonCode, 'OWNED_EFFECT_HELD');
  assert.equal(result.finalState, 'blocked');
  assert.equal(orchestrator.workerRuns(f.ws, 'T1')[0].effectState, 'held');
});

test('through runLeasedTask: stale revision — a Codex result from an expired lease never overwrites the newer lease (fencing)', async (t) => {
  const box = sandboxDir(t);
  const f = await leased(t);
  const inner = codexWorkerPort(stubbed(box, { lines: [THREAD, DONE] }));
  const port = {
    async run(input) {
      await f.authority.sweep(f.ws.workspaceId, Date.now() + 10 * 60_000, () => 'alive');
      await f.authority.reconcile(f.ws.workspaceId, 'T1', { spentMicroUsd: null, resume: true }, Date.now());
      await orchestrator.scheduleTasks(f.ws, { authority: f.authority, holder: orchestrator.selfIdentity() });
      return inner.run(input);
    },
  };
  const result = await orchestrator.runLeasedTask(f.ws, f.grant, { authority: f.authority, port, model: 'gpt-5.2-codex', allowedTools: ['Read'], prompt: 'p' });
  assert.equal(result.finalState, 'unchanged');
  assert.equal(orchestrator.getTask(f.ws, 'T1').node.state, 'leased');
  assert.match(orchestrator.workerRuns(f.ws, 'T1')[0].reason, /^stale result/);
});

test('through runLeasedTask: cancelTask aborts the Codex session and keeps the worktree', async (t) => {
  const box = sandboxDir(t);
  const f = await leased(t);
  const running = orchestrator.runLeasedTask(f.ws, f.grant, {
    authority: f.authority,
    heartbeatMs: 1_000,
    port: codexWorkerPort(stubbed(box, { write: 'mod/wip.txt', lines: [THREAD], sleepMs: 8_000, after: [DONE] })),
    model: 'gpt-5.2-codex',
    allowedTools: ['Edit'],
    prompt: 'p',
  });
  for (let i = 0; i < 50 && calls(box).length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  const cancel = await orchestrator.cancelTask(f.ws, f.authority, 'T1');
  assert.equal(cancel.signalled, 'in-process');
  const result = await running;
  assert.equal(result.finalState, 'cancelled');
  assert.equal(orchestrator.workerRuns(f.ws, 'T1')[0].status, 'aborted');
  assert.equal(cancel.worktree.deleted, false);
});

test('effort (C16): model_reasoning_effort carries the level, max passes as xhigh, recorded on the outcome; output tokens already include reasoning', async (t) => {
  const box = sandboxDir(t);
  const out = await runCodexWorker({ ...base(box, { effort: 'max' }), ...stubbed(box, { lines: [THREAD, TURN, DONE] }) });
  assert.equal(out.status, 'completed', out.reason);
  assert.equal(out.effort, 'xhigh');
  assert.deepEqual(calls(box)[0].argv.slice(-2), ['--config', 'model_reasoning_effort="xhigh"']);
  assert.equal(out.usage.outputTokens, 30, 'Codex output_tokens already count reasoning_output_tokens (OpenAI usage), so nothing is added');
  assert.deepEqual(codexExecArgs('m', 'read-only', 'low').slice(-2), ['--config', 'model_reasoning_effort="low"']);
  const none = await runCodexWorker({ ...base(box), ...stubbed(box, { lines: [THREAD, DONE] }) });
  assert.equal(none.effort, null);
  assert.equal(calls(box)[1].argv.some((a) => a.startsWith('model_reasoning_effort')), false);
  const bad = await runCodexWorker({ ...base(box, { effort: 'ultra' }), ...stubbed(box, { lines: [DONE] }) });
  assert.deepEqual([bad.status, bad.reason], ['refused', 'invalid effort']);
});
