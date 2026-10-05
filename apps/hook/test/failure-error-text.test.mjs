// A failed tool call's error text is free text: several lines, Windows line ends, colour codes, any length (JEV-0061).
//
// Antigravity's PostToolUse carries the failure in its `error`. The adapter used to read it with the
// one-short-line, no-control-character reader meant for ids and paths, so a real tool error (several
// lines, colour codes, more than 4096 characters) was not a failure at all and two identical failures
// gave no repeated-failure advice. The error is now normalized rather than refused: the call failed
// when the error has text, and the failure record stays content-free (closed codes and one-way digests of
// the normalized text, the same as every other harness). Ids, paths and names are still refused when
// they hold a control character. Through the five adapters, the launcher's input cap and a real sidecar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from '../../../test/acceptance/lib.mjs';
import { managedHostSkip } from '../../../test/managed-host.mjs';

const { runLauncher } = await import('../dist/launcher.js');
const claude = await import('@jevris/adapter-claude-code');
const codex = await import('@jevris/adapter-codex');
const kilocode = await import('@jevris/adapter-kilocode');
const opencode = await import('@jevris/adapter-opencode');
const antigravity = await import('@jevris/adapter-antigravity');
const adapters = { claude, kilo: kilocode, codex, opencode, agy: antigravity };

const LF = 'exit status 1\nFAIL src/a.test.js\n  AssertionError: expected 1 to equal 2';
const TEXTS = {
  'several lines': LF,
  'Windows line ends': LF.replaceAll('\n', '\r\n'),
  'blank lines around the text': `\n\n  ${LF.replaceAll('\n', '\n\n')}\n\n`,
  'colour codes': `\u001b[31mFAIL\u001b[0m exit status 1\nsrc/a.test.js\n  \u001b[1mAssertionError\u001b[22m: expected 1 to equal 2`,
  'a tab and a NUL': `${LF}\n\tat run (/w/a.js:3:9)\u0000`,
  'one long line': `exit status 1: ${'x'.repeat(6000)}`,
  'a long error of many lines': `exit status 1\n${'  at step (/w/a.js:3:9)\n'.repeat(4000)}`,
};

let step = 0;
const base = { conversationId: 'conv-1', workspacePaths: ['/w'], modelName: 'gemini-3.6-flash-medium' };
const post = (error, extra = {}) => ({ ...base, toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } }, stepIdx: (step += 1), error, ...extra });
const inWorkspace = (box, native) => ({ ...native, workspacePaths: [box.work] });
const normalizeAgy = (native) => antigravity.normalize(native, { hookKey: 'PostToolUse' });

test('Antigravity: an error of several lines, with Windows line ends, colour codes or any length, is a failure', () => {
  for (const [label, error] of Object.entries(TEXTS)) {
    const result = normalizeAgy(post(error));
    assert.equal(result.ok, true, `${label}: ${JSON.stringify(result)}`);
    assert.equal(result.event.kind, 'tool.failed', `${label}: a call with an error is a failed call`);
    assert.equal(result.event.payload.failed, true, label);
    assert.equal(result.event.toolName, 'run_command', label);
    assert.equal(result.intent.failure.family, 'shell:nonzero', `${label}: the failure record is built from the text`);
    assert.match(result.intent.failure.signature, /^[0-9a-f]{16}$/, label);
    assert.match(result.intent.failure.commandDigest, /^[0-9a-f]{16}$/, label);
  }
});

test('Antigravity: the same error with other line ends, blank lines or colour is the same failure as the same error on one line, and as another harness reports it', () => {
  const key = (error) => normalizeAgy(post(error)).intent.failure.signature;
  const oneLine = key('exit status 1 FAIL src/a.test.js AssertionError: expected 1 to equal 2');
  for (const label of ['several lines', 'Windows line ends', 'blank lines around the text']) assert.equal(key(TEXTS[label]), oneLine, `${label}: spacing is folded, as for every harness`);
  // Another harness reporting the same text gives the same signature, so failures compare across harnesses.
  const fromClaude = claude.normalize({ session_id: 's1', cwd: '/w', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'npm test' }, error: LF });
  assert.equal(fromClaude.ok, true);
  assert.equal(key(LF), fromClaude.intent.failure.signature);
  // Two deliveries of one failure compare as a repeat: the same signature and the same call digest, whichever step they came from.
  const a = normalizeAgy(post(TEXTS['several lines']));
  const b = normalizeAgy(post(TEXTS['several lines']));
  assert.notEqual(a.event.dedupKey, b.event.dedupKey, 'two steps are two events');
  assert.deepEqual(a.intent.failure, b.intent.failure);
});

test('Antigravity: no error text, a blank one or one that is not text is not a failure', () => {
  for (const error of [undefined, null, '', '   ', '\n\n', ' \r\n\t ', 42, true, { message: 'boom' }, ['boom']]) {
    const native = post(error);
    if (error === undefined) delete native.error;
    const result = normalizeAgy(native);
    assert.equal(result.ok, true, JSON.stringify(error));
    assert.equal(result.event.kind, 'tool.finished', `${JSON.stringify(error)} is a finished call`);
    assert.equal(result.event.payload.failed, false, JSON.stringify(error));
    assert.equal(result.intent?.failure, undefined, `${JSON.stringify(error)}: no failure features`);
  }
});

test('Antigravity: the error is free text, but ids, paths and names are still refused when they hold a control character', () => {
  const failed = normalizeAgy(post(TEXTS['several lines'], { conversationId: 'conv\n1', workspacePaths: ['/w\n/x'], modelName: 'gemini\u0000', toolCall: { name: 'run\ncommand', args: { CommandLine: 'npm test' } } }));
  assert.equal(failed.ok, true);
  assert.equal(failed.event.kind, 'tool.failed', 'the failure does not depend on those fields');
  assert.deepEqual([failed.event.sessionId, failed.event.cwd, failed.event.model, failed.event.toolName], [null, null, null, null]);
  assert.equal(failed.intent.failure.toolClass, 'other', 'a name that was refused is no tool class');
});

test('Antigravity: the error text is in no part of the event, and only the first line is kept as evidence', () => {
  const secret = 'AKIAIOSFODNN7EXAMPLE-fake-secret-for-the-test';
  const result = normalizeAgy(post(`exit status 1\npassword=${secret}\n  AssertionError: expected 1 to equal 2`));
  assert.equal(result.event.kind, 'tool.failed');
  const wire = JSON.stringify({ event: result.event, failure: result.intent.failure });
  for (const leak of ['AKIA', 'password', 'AssertionError', 'exit status']) assert.equal(wire.includes(leak), false, `${leak} must not travel in the envelope or the features`);
  assert.deepEqual(result.intent.evidence.diagnostics, [{ id: 'error', text: 'exit status 1' }], 'only the first line');
});

test('a multi-line failure is a failure on every harness, and a harness gives the same signature for it', () => {
  const claudeFailure = claude.normalize({ session_id: 's1', cwd: '/w', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'npm test' }, error: TEXTS['colour codes'] });
  const codexFailure = codex.normalize({ session_id: 's1', cwd: '/w', hook_event_name: 'PostToolUse', tool_name: 'mcp__x__y', tool_use_id: 'c1', tool_input: { q: 1 }, tool_response: { isError: true, content: [{ type: 'text', text: TEXTS['colour codes'] }] } });
  const pluginBash = (adapter) => adapter.normalize({ hookKey: 'tool.execute.after', input: { tool: 'bash', sessionID: 'ses_1', callID: 'call_1', args: { command: 'npm test' } }, output: { title: 'npm test', output: TEXTS['colour codes'], metadata: { exit: 1 } } });
  const pluginPart = (adapter) => adapter.normalize({ event: { type: 'message.part.updated', properties: { part: { id: 'prt_1', sessionID: 'ses_1', messageID: 'msg_1', type: 'tool', callID: 'call_9', tool: 'bash', state: { status: 'error', input: { command: 'npm test' }, error: TEXTS['colour codes'], time: { start: 1, end: 2 } } } } } });
  const agyFailure = normalizeAgy(post(TEXTS['colour codes']));
  const results = { claude: claudeFailure, codex: codexFailure, kilo: pluginBash(kilocode), 'kilo part': pluginPart(kilocode), opencode: pluginBash(opencode), 'opencode part': pluginPart(opencode), agy: agyFailure };
  for (const [label, result] of Object.entries(results)) {
    assert.equal(result.ok, true, label);
    assert.equal(result.event.kind, 'tool.failed', `${label}: a multi-line error with colour codes is a failure`);
  }
  assert.equal(new Set(['claude', 'kilo', 'kilo part', 'opencode', 'opencode part', 'agy'].map((label) => results[label].intent.failure.signature)).size, 1, 'one text, one signature, on every harness');
});

// ------------------------------------------------------------------------------------------------ the launcher and its caps

async function deliver(native, event = 'PostToolUse') {
  const calls = [];
  const sidecar = {
    async ensure() {
      return { ok: true, endpoint: 'fake', started: false };
    },
    async request(input) {
      calls.push(input);
      return { ok: true, result: { recorded: true, duplicate: false, results: {} } };
    },
  };
  const began = Date.now();
  const result = await runLauncher({ harness: 'agy', event }, JSON.stringify(native), { adapters, sidecar, env: { JEVRIS_HOME: '/tmp/jevris-home' }, cwd: () => '/w', nowMs: () => Date.now() }, began);
  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 1, `the event reached the sidecar: ${result.reason}`);
  return { body: calls[0].body, ms: Date.now() - began, reason: result.reason };
}

test('a wall of blank lines, and an error far over the input cap, still give the failure record, bounded and quickly', async () => {
  const hangGuardMs = 20_000;
  const walls = {
    'a hundred thousand newlines': `exit status 1\n${'\n'.repeat(100_000)}FAIL src/a.test.js`,
    'a hundred thousand blank lines of spaces': `exit status 1\n${' \n'.repeat(60_000)}FAIL src/a.test.js`,
    'a hundred thousand tabs and carriage returns': `exit status 1\r\n${'\t\r\n'.repeat(40_000)}FAIL src/a.test.js`,
  };
  for (const [label, error] of Object.entries(walls)) {
    const { body, ms } = await deliver(post(error));
    assert.equal(body.envelope.kind, 'tool.failed', label);
    assert.equal(body.failure.family, 'shell:nonzero', label);
    assert.ok(ms < hangGuardMs, `${label}: the hook took ${ms} ms`);
  }
  // A wall that fits the adapter's input cap untouched (the launcher cuts nothing), so the failure rules read it as it is (they look at the first 20,000 characters).
  for (const error of [`exit status 1${'\n'.repeat(60_000)}FAIL src/a.test.js`, `exit status 1\n${' \n'.repeat(30_000)}FAIL src/a.test.js`, `exit status 1\r\n${'\t\r\n'.repeat(20_000)}FAIL src/a.test.js`]) {
    const began = Date.now();
    const result = normalizeAgy(post(error));
    const ms = Date.now() - began;
    assert.equal(result.ok, true);
    assert.equal(result.event.kind, 'tool.failed');
    assert.equal(result.intent.failure.family, 'shell:nonzero', 'the status before the wall is still read');
    assert.ok(ms < hangGuardMs, `a wall of blank lines took ${ms} ms`);
  }
  // About 1.2 MB of output: the launcher cuts the long string to fit the adapters' bound, so the event is not lost,
  // the request to the sidecar stays within its cap and the same error is the same failure each time.
  const huge = `exit status 1\n${'  at step (/w/src/a.js:3:9) code 0x1f4a\n'.repeat(30_000)}`;
  assert.ok(Buffer.byteLength(huge) > 1_000_000);
  const first = await deliver(post(huge));
  const second = await deliver(post(huge));
  for (const { body, ms } of [first, second]) {
    assert.equal(body.envelope.kind, 'tool.failed', 'a 1 MB error is a failure');
    assert.equal(body.failure.family, 'shell:nonzero');
    assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 131_072, 'the request stays within the sidecar body cap');
    assert.ok(ms < hangGuardMs, `the hook took ${ms} ms`);
  }
  assert.equal(first.body.failure.signature, second.body.failure.signature);
  assert.equal(first.body.failure.commandDigest, second.body.failure.commandDigest);
  // The adapter's own input cap is as it was: a native input past it is refused unless the launcher cut it first.
  assert.equal(antigravity.normalize(post(huge), { hookKey: 'PostToolUse' }).reasonCode, 'OVER_CAP');
});

// ------------------------------------------------------------------------------------------------ the issue's scenario, through a real sidecar

const SLOW = { extraEnv: { JEVRIS_HOOK_DEADLINE_MS: '4000' } };
const RULES = /this failure has come back 2 times; the next most useful evidence is /;

function linesOf(hook) {
  assert.equal(hook.code, 0, `the hook exited ${hook.code}: ${hook.stderr}`);
  assert.doesNotMatch(hook.reason ?? '', /DEADLINE|TIMEOUT/, `the hook ran out of time (${hook.reason}): the machine is too loaded for the 4 s hook deadline`);
  if (hook.stdout.trim() === '') return [];
  const json = JSON.parse(hook.stdout);
  return (json.injectSteps ?? []).map((item) => item.ephemeralMessage).filter((text) => typeof text === 'string').flatMap((text) => text.split('\n').filter(Boolean));
}

test('through a real sidecar: two identical failed tool calls with a multi-line error give the repeated-failure line at the next invocation, once; so does a 1 MB error', { timeout: 120_000, skip: managedHostSkip() }, async (t) => {
  const box = await sandbox(t);
  assert.equal(box.startSidecar().code, 0, 'the sidecar did not start');
  const failTwice = (conversationId, command, error) => {
    for (let i = 0; i < 2; i += 1) {
      const out = box.hook('agy', inWorkspace(box, post(error, { conversationId, toolCall: { name: 'run_command', args: { CommandLine: command } } })), { ...SLOW, event: 'PostToolUse' });
      assert.equal(out.stdout.trim(), '{}', 'PostToolUse shows nothing');
      assert.deepEqual(linesOf(out), []);
    }
  };
  const invocation = (conversationId) => box.hook('agy', inWorkspace(box, { ...base, conversationId, invocationNum: (step += 1), initialNumSteps: 10 }), { ...SLOW, event: 'PreInvocation' });

  const multiline = `conv-multi-${process.pid}`;
  failTwice(multiline, `npm run multiline-${process.pid}`, TEXTS['colour codes']);
  const shown = linesOf(invocation(multiline));
  assert.equal(shown.filter((line) => RULES.test(line)).length, 1, `the line is the ephemeral message before the next invocation: ${JSON.stringify(shown)}`);
  assert.deepEqual(linesOf(invocation(multiline)), [], 'once');

  const huge = `conv-huge-${process.pid}`;
  failTwice(huge, `npm run huge-${process.pid}`, `exit status 1\n${'  at step (/w/src/a.js:3:9)\n'.repeat(40_000)}`);
  assert.equal(linesOf(invocation(huge)).filter((line) => RULES.test(line)).length, 1, 'a 1 MB error is the same failure twice');
});
