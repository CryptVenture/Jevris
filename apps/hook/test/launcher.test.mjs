// Hook launcher (HKR-01): normalize with F's adapters, forward to the sidecar `event` op, render
// exactly one response, always exit 0, never block past the deadline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardStdin } from '../../../scripts/child-stdin.mjs';
import { exactBudgets } from '../../../test/budget-scale.mjs';

const { runLauncher, parseLauncherArgs, chooseOutcome, deadlineMs, outcomeOf } = await import('../dist/launcher.js');
const { ADAPTERS } = await importAdapters();
const claude = await import('@jevris/adapter-claude-code');
const codex = await import('@jevris/adapter-codex');

async function importAdapters() {
  const [antigravity, claudeCode, codexAdapter, kilocode, opencode] = await Promise.all([
    import('@jevris/adapter-antigravity'),
    import('@jevris/adapter-claude-code'),
    import('@jevris/adapter-codex'),
    import('@jevris/adapter-kilocode'),
    import('@jevris/adapter-opencode'),
  ]);
  return { ADAPTERS: { claude: claudeCode, kilo: kilocode, codex: codexAdapter, opencode, agy: antigravity } };
}

const BIN = join(import.meta.dirname, '..', 'dist', 'bin.js');

function fixture(adapter, id) {
  const found = adapter.FIXTURES.find((f) => f.id === id);
  assert.ok(found, id);
  return found;
}

function fakeSidecar({ ensure = { ok: true, endpoint: 'fake', started: false }, answer = { ok: true, result: { recorded: true, duplicate: false, results: {} } }, delayMs = 0 } = {}) {
  const calls = [];
  return {
    calls,
    sidecar: {
      async ensure(input) {
        calls.push({ kind: 'ensure', ...input });
        return ensure;
      },
      async request(input) {
        calls.push({ kind: 'request', ...input });
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        return typeof answer === 'function' ? answer(input) : answer;
      },
    },
  };
}

function deps(sidecar, env = {}) {
  return { adapters: ADAPTERS, sidecar, env: { JEVRIS_HOME: '/tmp/jevris-home', ...env }, cwd: () => '/work', nowMs: () => Date.now() };
}

const args = (harness, event = null) => ({ harness, event });

test('arguments: --harness is required and must be a launcher name', () => {
  assert.deepEqual(parseLauncherArgs(['--harness', 'claude']), { harness: 'claude', event: null });
  assert.deepEqual(parseLauncherArgs(['--harness', 'kilo', '--event', 'tool.execute.before']), { harness: 'kilo', event: 'tool.execute.before' });
  for (const bad of [[], ['--harness'], ['--harness', 'gemini'], ['--harness', 'claude', '--harness', 'codex'], ['--harness', 'claude', 'extra'], ['--harness', 'claude', '--event', '../x']]) {
    assert.equal(parseLauncherArgs(bad), null, bad.join(' '));
  }
  assert.equal(deadlineMs({}), 1500);
  assert.equal(deadlineMs({ JEVRIS_HOOK_DEADLINE_MS: '10' }), 100);
  assert.equal(deadlineMs({ JEVRIS_HOOK_DEADLINE_MS: '999999' }), 4000);
  assert.equal(deadlineMs({ JEVRIS_HOOK_DEADLINE_MS: 'soon' }), 1500);
});

test('a test run scales the hook deadline with JEVRIS_TEST_BUDGET_SCALE, its ceiling too, and only under JEVRIS_TEST=1', () => {
  const scaled = { JEVRIS_TEST: '1', JEVRIS_TEST_BUDGET_SCALE: '6' };
  assert.equal(deadlineMs({ ...scaled, JEVRIS_HOOK_DEADLINE_MS: '4000' }), 24_000);
  assert.equal(deadlineMs({ ...scaled, JEVRIS_HOOK_DEADLINE_MS: '999999' }), 24_000, 'the 4000 ms ceiling scales as well');
  assert.equal(deadlineMs({ ...scaled, JEVRIS_HOOK_DEADLINE_MS: '10' }), 600);
  assert.equal(deadlineMs(scaled), 9000, 'the 1500 ms default scales');
  assert.equal(deadlineMs({ ...scaled, JEVRIS_TEST_BUDGET_SCALE: '1' }), 1500);
  assert.equal(deadlineMs({ ...scaled, JEVRIS_TEST_BUDGET_SCALE: '99' }), 1500, 'a value out of range is a scale of 1');
  // The variable alone does nothing: a hook outside a test run keeps its product deadline.
  assert.equal(deadlineMs({ JEVRIS_TEST_BUDGET_SCALE: '6', JEVRIS_HOOK_DEADLINE_MS: '4000' }), 4000);
  assert.equal(deadlineMs({ JEVRIS_TEST_BUDGET_SCALE: '6' }), 1500);
});

test('every mapped Claude event is forwarded to the event op with scope hook and a hot budget', async () => {
  for (const name of Object.keys(claude.CLAUDE_EVENTS)) {
    const native = { session_id: 's1', cwd: '/work/repo', hook_event_name: name, tool_name: 'Bash', tool_input: {}, tool_use_id: 'tu1', agent_id: 'a1', agent_type: 'worker' };
    const { calls, sidecar } = fakeSidecar();
    const result = await runLauncher(args('claude'), JSON.stringify(native), deps(sidecar), Date.now());
    assert.equal(result.exitCode, 0);
    assert.equal(calls.some((c) => c.kind === 'ensure'), false, 'one connection per hook: a sidecar that answers is never probed (P11)');
    const request = calls.find((c) => c.kind === 'request');
    assert.ok(request, `${name} forwarded`);
    assert.equal(request.op, 'event');
    assert.equal(request.scope, 'hook');
    assert.equal(request.budget, 'hot');
    assert.equal(request.workspace, '/work/repo');
    assert.equal(request.home, '/tmp/jevris-home');
    assert.equal(request.body.envelope.nativeEventName, name);
    assert.equal(request.body.deliveryKey, request.body.envelope.dedupKey);
    assert.equal(request.timeoutMs > 0 && request.timeoutMs <= 1500, true);
  }
});

test('each adapter fixture that normalizes is forwarded; each refusal renders no decision', async () => {
  for (const [name, adapter] of Object.entries(ADAPTERS)) {
    for (const fx of adapter.FIXTURES) {
      const { calls, sidecar } = fakeSidecar();
      const result = await runLauncher(args(name, fx.hookKey ?? null), JSON.stringify(fx.native), deps(sidecar), Date.now());
      assert.equal(result.exitCode, 0);
      const forwarded = calls.some((c) => c.kind === 'request');
      assert.equal(forwarded, fx.kind !== null, `${fx.id}: forwarded only when it normalizes`);
      assert.equal(typeof result.stdout, 'string');
    }
  }
});

test('the prompt text reaches the sidecar only as body.task, never in the envelope it records', async () => {
  const { calls, sidecar } = fakeSidecar();
  const native = { session_id: 's1', cwd: '/work', hook_event_name: 'UserPromptSubmit', prompt: 'CANARY_prompt_text_7f1' };
  await runLauncher(args('claude'), JSON.stringify(native), deps(sidecar), Date.now());
  const request = calls.find((c) => c.kind === 'request');
  assert.equal(JSON.stringify(request.body.envelope).includes('CANARY_prompt_text_7f1'), false);
  assert.deepEqual(request.body.task, { objective: 'CANARY_prompt_text_7f1' });
  const { task: _task, ...rest } = request;
  assert.equal(JSON.stringify({ ...rest, body: { ...request.body, task: undefined } }).includes('CANARY_prompt_text_7f1'), false, 'nowhere else');
});

test('no sidecar, a refusal, a timeout or a malformed input all render no decision', async () => {
  const native = JSON.stringify(fixture(claude, 'claude.session-start').native);
  // No sidecar: the request finds none, and only then is it started, without waiting (P11, IPC-13).
  const starting = fakeSidecar({ ensure: { ok: false, reason: 'starting', message: 'starting' }, answer: { ok: false, reason: 'unavailable', reasonCode: 'NOT_RUNNING', message: 'not running' } });
  const r1 = await runLauncher(args('claude'), native, deps(starting.sidecar), Date.now());
  assert.equal(r1.stdout, '');
  assert.equal(r1.reason, 'SIDECAR_STARTING');
  assert.deepEqual(starting.calls.map((c) => c.kind), ['request', 'ensure']);
  assert.equal(starting.calls[1].waitMs, 0, 'a hook never waits for the sidecar to start');
  // A sidecar that is up but refuses, times out or is busy is not started again.
  for (const answer of [{ ok: false, reason: 'timeout', reasonCode: 'TIMEOUT', message: 't' }, { ok: false, reason: 'rejected', reasonCode: 'BUSY', message: 'b' }]) {
    const up = fakeSidecar({ answer });
    assert.equal((await runLauncher(args('claude'), native, deps(up.sidecar), Date.now())).reason, answer.reasonCode);
    assert.deepEqual(up.calls.map((c) => c.kind), ['request']);
  }
  // Started by another hook meanwhile: this delivery keeps its own reason.
  const raced = fakeSidecar({ answer: { ok: false, reason: 'unavailable', reasonCode: 'ECONNREFUSED', message: 'x' } });
  assert.equal((await runLauncher(args('claude'), native, deps(raced.sidecar), Date.now())).reason, 'ECONNREFUSED');
  assert.deepEqual(raced.calls.map((c) => c.kind), ['request', 'ensure']);

  const refused = fakeSidecar({ answer: { ok: false, reason: 'refused', reasonCode: 'SCOPE_DENIED', message: 'no' } });
  assert.equal((await runLauncher(args('claude'), native, deps(refused.sidecar), Date.now())).reason, 'SCOPE_DENIED');

  // A sidecar that never answers: the launcher still answers, at its deadline.
  const never = fakeSidecar({ answer: () => new Promise(() => undefined) });
  const r3 = await runLauncher(args('claude'), native, deps(never.sidecar, { JEVRIS_HOOK_DEADLINE_MS: '150' }), Date.now());
  assert.equal(r3.reason, 'HOOK_DEADLINE');
  assert.equal(r3.stdout, '');

  // A clock already past the deadline never calls the sidecar.
  const late = fakeSidecar();
  const r5 = await runLauncher(args('claude'), native, { ...deps(late.sidecar), nowMs: () => 10_000 }, 0);
  assert.equal(r5.reason, 'DEADLINE');
  assert.equal(late.calls.length, 0);

  for (const input of [null, '{not json', '[]', JSON.stringify({ hook_event_name: 'NoSuchEvent' })]) {
    const { calls, sidecar } = fakeSidecar();
    const r = await runLauncher(args('claude'), input, deps(sidecar), Date.now());
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, '');
    assert.equal(calls.length, 0);
  }

  const stop = fixture(codex, 'codex.subagent-stop');
  const offline = fakeSidecar({ ensure: { ok: false, reason: 'unavailable', message: 'x' }, answer: { ok: false, reason: 'unavailable', reasonCode: 'NOT_RUNNING', message: 'x' } });
  const r4 = await runLauncher(args('codex'), JSON.stringify(stop.native), deps(offline.sidecar), Date.now());
  assert.equal(r4.stdout, codex.protocolResponse(codex.normalize(stop.native).event, { kind: 'observe' }), 'the adapter renders its required body');
});

test('context and route render only when a subscriber attests certification', async () => {
  const native = fixture(claude, 'claude.session-start').native;
  const uncertified = { recorded: true, duplicate: false, results: { restore: { hookOutcome: { kind: 'context', text: 'Resume: finish the parser.' } } } };
  const certified = { recorded: true, duplicate: false, results: { restore: { hookOutcome: { kind: 'context', text: 'Resume: finish the parser.' }, certified: true } } };
  const a = await runLauncher(args('claude'), JSON.stringify(native), deps(fakeSidecar({ answer: { ok: true, result: uncertified } }).sidecar), Date.now());
  assert.equal(a.stdout, '');
  assert.equal(a.reason, 'NOT_CERTIFIED');
  const b = await runLauncher(args('claude'), JSON.stringify(native), deps(fakeSidecar({ answer: { ok: true, result: certified } }).sidecar), Date.now());
  const event = claude.normalize(native).event;
  assert.equal(b.stdout, claude.protocolResponse(event, { kind: 'context', text: 'Resume: finish the parser.' }));
  assert.match(b.stdout, /Resume: finish the parser/);
  const forced = await runLauncher(args('claude'), JSON.stringify(native), deps(fakeSidecar({ answer: { ok: true, result: certified } }).sidecar, { JEVRIS_HOOK_OBSERVE_ONLY: '1' }), Date.now());
  assert.equal(forced.stdout, '');
});

test('outcome choice: strongest certified proposal, deterministic, bounded', () => {
  assert.equal(chooseOutcome(null).outcome.kind, 'observe');
  assert.equal(chooseOutcome({ duplicate: true, results: { a: { hookOutcome: { kind: 'explain', text: 'x' } } } }).reason, 'DUPLICATE_DELIVERY');
  const chosen = chooseOutcome({
    results: {
      b: { hookOutcome: { kind: 'explain', text: 'why' } },
      a: { hookOutcome: { kind: 'context', text: 'ctx' }, certified: true },
      c: { hookOutcome: { kind: 'route', updatedInput: { model: 'm' } } },
      d: { queued: true },
      e: { hookOutcome: { kind: 'allow' } },
    },
  });
  assert.deepEqual(chosen.outcome, { kind: 'context', text: 'ctx' });
  assert.equal(outcomeOf({ hookOutcome: { kind: 'context', text: 'x'.repeat(9000) } }).outcome.text.length, 8000);
  assert.equal(outcomeOf({ hookOutcome: { kind: 'context', text: '   ' } }), null);
  assert.equal(outcomeOf({ hookOutcome: { kind: 'route', updatedInput: [] } }), null);
});

test('JEV-0031: a result the stopped sidecar answered observes with reason KILL_SWITCH, not NO_PROPOSAL', async () => {
  const stopped = { recorded: true, duplicate: false, killSwitch: 'stopped', results: {} };
  assert.deepEqual(chooseOutcome(stopped), { outcome: { kind: 'observe' }, reason: 'KILL_SWITCH', continuation: null });
  // A stopped answer never actuates, even if a result somehow carries a certified proposal.
  const withProposal = { ...stopped, results: { a: { hookOutcome: { kind: 'context', text: 'ctx' }, certified: true } } };
  assert.equal(chooseOutcome(withProposal).outcome.kind, 'observe');
  const native = fixture(claude, 'claude.session-start').native;
  const run = await runLauncher(args('claude'), JSON.stringify(native), deps(fakeSidecar({ answer: { ok: true, result: stopped } }).sidecar), Date.now());
  assert.equal(run.stdout, '');
  assert.equal(run.reason, 'KILL_SWITCH');
});

test("D's answer replay: a duplicate the sidecar marks replayed renders as the first delivery did (reason DUPLICATE_REPLAYED); an unmarked duplicate still observes", async () => {
  const context = { restore: { hookOutcome: { kind: 'context', text: 'Resume: finish the parser.' }, certified: true } };
  const first = { recorded: true, duplicate: false, deliveryKey: 'k1', results: context };
  const replayed = { ...first, recorded: false, duplicate: true, replayed: true };
  assert.deepEqual(chooseOutcome(replayed).outcome, chooseOutcome(first).outcome);
  assert.equal(chooseOutcome(replayed).reason, 'DUPLICATE_REPLAYED');
  // Paired: the same results as a plain duplicate observe, as before.
  assert.deepEqual(chooseOutcome({ ...replayed, replayed: false }), { outcome: { kind: 'observe' }, reason: 'DUPLICATE_DELIVERY', continuation: null });
  const native = fixture(claude, 'claude.session-start').native;
  const run = (result) => runLauncher(args('claude'), JSON.stringify(native), deps(fakeSidecar({ answer: { ok: true, result } }).sidecar), Date.now());
  const [a, b] = [await run(first), await run(replayed)];
  assert.match(a.stdout, /Resume: finish the parser/);
  assert.equal(b.stdout, a.stdout, 'the retry renders the first answer unchanged');
  assert.equal(b.reason, 'DUPLICATE_REPLAYED');
  // A Stop reminder's continuation replays as the same block, not a second, different one.
  const stop = { ...fixture(claude, 'claude.stop').native, stop_hook_active: false };
  const remind = 'Missing verification evidence: unit. Uncovered requirements: none. Run the declared checks (jevris verify) before finishing.';
  const completion = { hookOutcome: { kind: 'explain', text: remind }, certified: false, reasonCode: 'STOP_REMINDER', stopContinuation: { text: remind, certified: true, missingEvidence: ['unit'] } };
  const stopFirst = { recorded: true, duplicate: false, deliveryKey: 'k2', results: { completion } };
  const stopRun = (result) => runLauncher(args('claude'), JSON.stringify(stop), deps(fakeSidecar({ answer: { ok: true, result } }).sidecar), Date.now());
  const [c, d] = [await stopRun(stopFirst), await stopRun({ ...stopFirst, recorded: false, duplicate: true, replayed: true })];
  assert.equal(c.reason, 'STOP_CONTINUATION');
  assert.equal(d.stdout, c.stdout);
  assert.equal(d.reason, 'DUPLICATE_REPLAYED', 'every replayed answer reads DUPLICATE_REPLAYED');
});

test('a subscriber that missed its slice reads SUBSCRIBER_QUEUED, not NO_PROPOSAL; any proposal still wins (a53b702)', async () => {
  // Pairs: the same answer with and without `queued`.
  const late = { recorded: true, duplicate: false, results: { orchestrator: { queued: true }, security: null }, queued: ['orchestrator'] };
  const { queued: _omit, ...onTime } = late;
  assert.deepEqual(chooseOutcome(late), { outcome: { kind: 'observe' }, reason: 'SUBSCRIBER_QUEUED', continuation: null });
  assert.equal(chooseOutcome(onTime).reason, 'NO_PROPOSAL');
  // A proposal that did arrive is still chosen, and an uncertified one still reads NOT_CERTIFIED.
  const proposed = chooseOutcome({ ...late, results: { ...late.results, security: { hookOutcome: { kind: 'explain', text: 'why' } } } });
  assert.deepEqual([proposed.outcome.kind, proposed.reason], ['explain', 'PROPOSED_BY_SECURITY']);
  assert.equal(chooseOutcome({ ...late, results: { ...late.results, restore: { hookOutcome: { kind: 'context', text: 'ctx' } } } }).reason, 'NOT_CERTIFIED');
  // A malformed `queued` is ignored.
  for (const queued of [[], 'orchestrator', [5], ['../x'], [''], null, { a: 1 }]) {
    assert.equal(chooseOutcome({ ...onTime, queued }).reason, 'NO_PROPOSAL', JSON.stringify(queued));
  }
  // Through the launcher: one response, the adapter's observe body, whatever the reason.
  const native = fixture(claude, 'claude.stop').native;
  const event = claude.normalize(native).event;
  const logs = [];
  const r = await runLauncher(args('claude'), JSON.stringify(native), { ...deps(fakeSidecar({ answer: { ok: true, result: late } }).sidecar), log: (line) => logs.push(line) }, Date.now());
  assert.deepEqual([r.exitCode, r.reason, r.stdout], [0, 'SUBSCRIBER_QUEUED', claude.protocolResponse(event, { kind: 'observe' })]);
  assert.deepEqual(logs, ['jevris-hook claude SUBSCRIBER_QUEUED']);
  const r2 = await runLauncher(args('claude'), JSON.stringify(native), deps(fakeSidecar({ answer: { ok: true, result: onTime } }).sidecar), Date.now());
  assert.deepEqual([r2.reason, r2.stdout], ['NO_PROPOSAL', r.stdout]);
});

test('JEVRIS_SIDECAR_AUTOSTART=0: the launcher never starts the sidecar; a running one still answers, else it observes (SIDECAR_AUTOSTART_OFF)', async () => {
  const native = JSON.stringify(fixture(claude, 'claude.session-start').native);
  const event = claude.normalize(fixture(claude, 'claude.session-start').native).event;
  const observeBody = claude.protocolResponse(event, { kind: 'observe' });
  // The pair: without the variable the launcher asks the client to start the sidecar.
  const on = fakeSidecar();
  await runLauncher(args('claude'), native, deps(on.sidecar), Date.now());
  assert.deepEqual(on.calls.map((c) => c.kind), ['request'], 'a running sidecar: one request, no probe (P11)');
  // With it: no ensure at all; a running sidecar still answers.
  const running = fakeSidecar({ answer: { ok: true, result: { recorded: true, duplicate: false, results: { restore: { hookOutcome: { kind: 'context', text: 'Resume: finish the parser.' }, certified: true } } } } });
  const answered = await runLauncher(args('claude'), native, deps(running.sidecar, { JEVRIS_SIDECAR_AUTOSTART: '0' }), Date.now());
  assert.deepEqual(running.calls.map((c) => c.kind), ['request']);
  assert.match(answered.stdout, /Resume: finish the parser/);
  // No sidecar running: one observe response, the documented reason, nothing started.
  const none = fakeSidecar({ answer: { ok: false, reason: 'unavailable', reasonCode: 'NOT_RUNNING', message: 'not running' } });
  const logs = [];
  const quiet = await runLauncher(args('claude'), native, { ...deps(none.sidecar, { JEVRIS_SIDECAR_AUTOSTART: '0' }), log: (line) => logs.push(line) }, Date.now());
  assert.deepEqual(none.calls.map((c) => c.kind), ['request']);
  assert.deepEqual([quiet.exitCode, quiet.reason, quiet.stdout], [0, 'SIDECAR_AUTOSTART_OFF', observeBody]);
  assert.deepEqual(logs, ['jevris-hook claude SIDECAR_AUTOSTART_OFF']);
  // Any other value leaves autostart on.
  const other = fakeSidecar();
  await runLauncher(args('claude'), native, deps(other.sidecar, { JEVRIS_SIDECAR_AUTOSTART: '1' }), Date.now());
  assert.deepEqual(other.calls.map((c) => c.kind), ['request']);
});

// The launcher's own deadline and watchdog are the subject of these runs: the product's exact budgets, whatever scale the runner sets (test/budget-scale.mjs).
function runBin(argv, { input, env = {}, keepOpen = false } = {}) {
  return new Promise((resolve) => {
    const home = mkdtempSync(join(tmpdir(), 'jevris-hook-'));
    const child = guardStdin(
      spawn(process.execPath, [BIN, ...argv], {
        env: { ...exactBudgets(process.env), JEVRIS_HOME: home, JEVRIS_HOOK_OBSERVE_ONLY: '1', ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
    let stdout = '';
    let stderr = '';
    const began = Date.now();
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => {
      rmSync(home, { recursive: true, force: true });
      resolve({ code, stdout, stderr, ms: Date.now() - began });
    });
    if (input !== undefined) child.stdin.write(input);
    if (!keepOpen) child.stdin.end();
  });
}

test('the process always exits 0 and writes at most one response', async () => {
  const native = JSON.stringify(fixture(claude, 'claude.session-start').native);
  const ok = await runBin(['--harness', 'claude'], { input: native });
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout, '');
  assert.equal(ok.stderr, '');
  const usage = await runBin(['--harness', 'gemini'], { input: native, env: { JEVRIS_HOOK_DEBUG: '1' } });
  assert.equal(usage.code, 0);
  assert.match(usage.stderr, /USAGE/);
  // Over the 8 MiB read bound the input is refused unparsed; a larger-than-128 KiB input is read
  // and cut to fit (intent-fields test), so this one fails only as JSON.
  const over = await runBin(['--harness', 'claude'], { input: 'x'.repeat(8 * 1024 * 1024 + 1), env: { JEVRIS_HOOK_DEBUG: '1' } });
  assert.equal(over.code, 0);
  assert.match(over.stderr, /INPUT_REFUSED/);
  const notJson = await runBin(['--harness', 'claude'], { input: 'x'.repeat(131_073), env: { JEVRIS_HOOK_DEBUG: '1' } });
  assert.match(notJson.stderr, /INVALID_JSON/);
  const stop = fixture(codex, 'codex.subagent-stop');
  const codexStop = await runBin(['--harness', 'codex'], { input: JSON.stringify(stop.native) });
  assert.equal(codexStop.stdout, '{}\n');
});

test('a harness that never closes stdin still gets an answer before the deadline', async () => {
  const hung = await runBin(['--harness', 'claude'], { input: '{"hook_event_name":', keepOpen: true, env: { JEVRIS_HOOK_DEADLINE_MS: '200', JEVRIS_HOOK_DEBUG: '1' } });
  assert.equal(hung.code, 0);
  assert.match(hung.stderr, /WATCHDOG/);
  assert.equal(hung.ms < 2000, true);
});

test('a harness-supplied version is forwarded; otherwise the field is omitted', async () => {
  const base = { session_id: 's1', cwd: '/work/repo', hook_event_name: 'SessionStart' };
  const bodyOf = async (native, extra = {}) => {
    const run = fakeSidecar();
    await runLauncher(args('claude'), JSON.stringify(native), { ...deps(run.sidecar), ...extra }, Date.now());
    return run.calls.find((c) => c.kind === 'request').body;
  };
  assert.equal((await bodyOf({ ...base, harness_version: '2.1.280' })).harnessVersion, '2.1.280');
  assert.equal((await bodyOf({ ...base, harnessVersion: '1.0.3-beta.1' })).harnessVersion, '1.0.3-beta.1');

  // A port override receives the harness and the native payload.
  const seen = [];
  const viaPort = await bodyOf(base, { harnessVersion: (harness, native) => (seen.push([harness, native.session_id]), '9.9.9') });
  assert.deepEqual(seen, [['claude', 's1']]);
  assert.equal(viaPort.harnessVersion, '9.9.9');

  // Nothing supplied, a malformed or non-string value, or a failing port: the field is absent.
  const absent = [
    [base, {}],
    [{ ...base, harness_version: '2.1.280; rm -rf /' }, {}],
    [{ ...base, harness_version: 7 }, {}],
    [base, { harnessVersion: () => null }],
    [base, { harnessVersion: () => { throw new Error('unreadable'); } }],
  ];
  for (const [native, extra] of absent) assert.equal(Object.hasOwn(await bodyOf(native, extra), 'harnessVersion'), false);
});

// US23 at the launcher: the stop decision reaches the harness unchanged, and nothing the
// sidecar answers for a stop turns into a continuation. A second stop with stop_hook_active
// gives no further block.
const STOP_FIXTURES = { claude: ['claude.stop', 'claude.subagent-stop'], codex: ['codex.stop', 'codex.subagent-stop'], kilo: ['kilocode.session-idle'], opencode: ['opencode.session-idle'], agy: ['antigravity.stop'] };

function continuation(stdout) {
  if (stdout === '') return null;
  let body;
  try {
    body = JSON.parse(stdout);
  } catch {
    return 'not JSON';
  }
  const walk = (value) => {
    if (value === null || typeof value !== 'object') return null;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'decision' && item !== 'stop') return `decision ${String(item)}`;
      if (key === 'continue' && item === false) return 'continue false';
      if (key === 'additionalContext' || key === 'updatedInput' || key === 'permissionDecision' || key === 'reason') return key;
      const inner = walk(item);
      if (inner !== null) return inner;
    }
    return null;
  };
  return walk(body);
}

// US23 forbids a continuation after a reminder has fired: the second stop on an unchanged
// condition (stop_hook_active) never continues, even with a certified continuation proposed.
// The one allowed first continuation (VER-05, SSOT §10.5) is tested in stop-continuation.test.mjs.
test('US23: the second stop never continues, and a stop without a certified continuation reaches the harness unchanged', async () => {
  const remind = 'Missing verification evidence: unit. Run the declared checks (jevris verify) before finishing.';
  const unverified = 'Unverified: the work ends without current passing receipts for unit. It is labelled unverified.';
  const hostile = [
    { hookOutcome: { kind: 'context', text: remind }, certified: true },
    { hookOutcome: { kind: 'route', updatedInput: { model: 'm' } }, certified: true },
    { hookOutcome: { kind: 'block', reason: remind }, certified: true },
    { hookOutcome: { kind: 'continue', text: remind }, certified: true },
    { hookOutcome: { kind: 'deny', reason: remind }, certified: true },
  ];
  for (const [name, ids] of Object.entries(STOP_FIXTURES)) {
    const adapter = ADAPTERS[name];
    for (const id of ids) {
      const fx = fixture(adapter, id);
      const event = adapter.normalize(fx.native).event;
      assert.ok(event, `${id} normalizes`);
      // First stop: the reminder; second stop (stop_hook_active): the unverified report.
      const first = { ...fx.native, ...(Object.hasOwn(fx.native, 'stop_hook_active') ? { stop_hook_active: false } : {}) };
      // Antigravity has no stop_hook_active: a later execution attempt follows a continue (G6).
      const second = { ...fx.native, ...(Object.hasOwn(fx.native, 'stop_hook_active') ? { stop_hook_active: true } : {}), ...(name === 'agy' ? { executionNum: 2 } : {}) };
      for (const [native, text] of [[first, remind], [second, unverified]]) {
        const { sidecar } = fakeSidecar({ answer: { ok: true, result: { recorded: true, duplicate: false, results: { completion: { hookOutcome: { kind: 'explain', text } } } } } });
        const result = await runLauncher(args(name, fx.hookKey ?? null), JSON.stringify(native), deps(sidecar), Date.now());
        assert.equal(result.exitCode, 0);
        const rendered = adapter.protocolResponse(adapter.normalize(native).event, { kind: 'explain', text });
        assert.equal(result.stdout, rendered, `${id}: the stop decision reaches the harness unchanged`);
        assert.equal(continuation(result.stdout), null, `${id}: ${result.stdout}`);
      }
      for (const outcome of [...hostile, { hookOutcome: { kind: 'explain', text: remind }, certified: true, stopContinuation: { certified: true, missingEvidence: ['unit'] } }]) {
        const { sidecar } = fakeSidecar({ answer: { ok: true, result: { recorded: true, duplicate: false, results: { completion: outcome } } } });
        const result = await runLauncher(args(name, fx.hookKey ?? null), JSON.stringify(second), deps(sidecar), Date.now());
        assert.equal(result.exitCode, 0);
        assert.equal(continuation(result.stdout), null, `${id} ${outcome.hookOutcome.kind}: ${result.stdout}`);
      }
    }
  }
});

test('G16: a Kilo or OpenCode delivery gives back the shim misses it carried, validated, and the adapter never sees them', async () => {
  const { shimMissesOf } = await import('../dist/launcher.js');
  const kilo = await import('@jevris/adapter-kilocode');
  const idle = fixture(kilo, 'kilocode.session-idle').native;
  const carried = [
    { reasonCode: 'SHIM_DROPPED', count: 3, maxMs: 0 },
    { reasonCode: 'SHIM_KILLED', count: 1, maxMs: 30000 },
  ];
  for (const harness of ['kilo', 'opencode']) {
    const fake = fakeSidecar();
    const result = await runLauncher(args(harness), JSON.stringify({ ...idle, shimMisses: carried }), deps(fake.sidecar), Date.now());
    assert.deepEqual(result.shimMisses, carried, harness);
    const request = fake.calls.find((call) => call.kind === 'request');
    assert.ok(request, 'the event still reaches the sidecar');
    assert.equal(JSON.stringify(request.body.envelope).includes('SHIM_'), false, 'the misses are not part of the event');
  }
  const fake = fakeSidecar();
  const plain = await runLauncher(args('kilo'), JSON.stringify(idle), deps(fake.sidecar), Date.now());
  assert.equal(Object.hasOwn(plain, 'shimMisses'), false);
  const claudeRun = await runLauncher(args('claude'), JSON.stringify({ ...fixture(claude, 'claude.session-start').native, shimMisses: carried }), deps(fakeSidecar().sidecar), Date.now());
  assert.equal(Object.hasOwn(claudeRun, 'shimMisses'), false, 'only the plugin shims carry misses');

  assert.deepEqual(shimMissesOf('x'), []);
  assert.deepEqual(shimMissesOf(Array.from({ length: 5 }, () => carried[0])), [], 'more entries than reason codes');
  assert.deepEqual(
    shimMissesOf([
      carried[0],
      carried[0],
      { reasonCode: 'SHIM_TIMEOUT', count: 0, maxMs: 0 },
      { reasonCode: 'SHIM_SPAWN_FAILED', count: 1, maxMs: 3_600_001 },
    ]),
    [carried[0]],
    'a repeat, a zero count and an over-long wait are ignored',
  );
  assert.deepEqual(shimMissesOf([{ reasonCode: 'TIMEOUT', count: 1, maxMs: 0 }, carried[1]]), [carried[1]], 'an unknown code is ignored',
  );
});

test('G21: a Claude hook sends the session sign-in the environment shows, by Claude Code precedence; never a value', async () => {
  const { sessionAuthMode } = await import('../dist/launcher.js');
  assert.equal(sessionAuthMode('claude', {}), null, 'a /login may be a subscription or a Console login');
  assert.equal(sessionAuthMode('claude', { ANTHROPIC_API_KEY: 'x' }), 'api-key');
  assert.equal(sessionAuthMode('claude', { ANTHROPIC_AUTH_TOKEN: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'y' }), 'api-key', 'a key outranks the OAuth token');
  assert.equal(sessionAuthMode('claude', { CLAUDE_CODE_OAUTH_TOKEN: 'y' }), 'subscription');
  assert.equal(sessionAuthMode('claude', { CLAUDE_CODE_OAUTH_TOKEN: '' }), null, 'an empty variable is not set');
  assert.equal(sessionAuthMode('claude', { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: 'x' }), null, 'a cloud provider is not an account mode');
  assert.equal(sessionAuthMode('claude', { CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_OAUTH_TOKEN: 'y' }), 'subscription', 'a provider switched off does not count');
  assert.equal(sessionAuthMode('codex', { OPENAI_API_KEY: 'x' }), null, 'only Claude Code');

  const agent = fixture(claude, 'claude.pre-agent');
  const secret = 'sk-ant-never-sent-0123456789';
  const fake = fakeSidecar();
  await runLauncher(args('claude'), JSON.stringify(agent.native), deps(fake.sidecar, { ANTHROPIC_API_KEY: secret }), Date.now());
  const request = fake.calls.find((call) => call.kind === 'request');
  assert.equal(request.body.authMode, 'api-key');
  assert.equal(JSON.stringify(request).includes(secret), false, 'only the mode is sent');
  const plain = fakeSidecar();
  await runLauncher(args('claude'), JSON.stringify(agent.native), deps(plain.sidecar), Date.now());
  assert.equal(Object.hasOwn(plain.calls.find((call) => call.kind === 'request').body, 'authMode'), false, 'unknown is left out');
});

test('G2: every event request says whether the harness can show an explain there, from the adapter renderer', async () => {
  const cases = [
    ['claude', claude, 'claude.stop', true],
    ['claude', claude, 'claude.prompt', true],
    ['codex', codex, 'codex.stop', true],
    ['kilo', await import('@jevris/adapter-kilocode'), 'kilocode.session-idle', false],
    ['kilo', await import('@jevris/adapter-kilocode'), 'kilocode.compacting', false],
    ['opencode', await import('@jevris/adapter-opencode'), 'opencode.session-idle', false],
    // G4: a person's message shows its text on the turn's system prompt.
    ['kilo', await import('@jevris/adapter-kilocode'), 'kilocode.chat-message', true],
    ['opencode', await import('@jevris/adapter-opencode'), 'opencode.chat-message', true],
    ['agy', await import('@jevris/adapter-antigravity'), 'antigravity.stop', false],
    ['agy', await import('@jevris/adapter-antigravity'), 'antigravity.pre-invocation', true],
  ];
  for (const [harness, adapter, id, shows] of cases) {
    const fx = fixture(adapter, id);
    const fake = fakeSidecar();
    await runLauncher(args(harness, fx.hookKey ?? null), JSON.stringify(fx.native), deps(fake.sidecar), Date.now());
    const request = fake.calls.find((call) => call.kind === 'request');
    assert.ok(request, id);
    assert.equal(request.body.showsExplain, shows, id);
  }
});
