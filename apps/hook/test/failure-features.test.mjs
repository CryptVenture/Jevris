// Live repeated-failure advice: every harness that has a failure event gives the sidecar a
// content-free `failure` feature object, and the launcher sends it next to the envelope as
// `body.failure`. Golden fixtures from stub payloads (no real harness runs):
// - Claude Code: PostToolUseFailure (error text, tool input, `is_interrupt`, `duration_ms`).
// - Kilo and OpenCode: a bash `tool.execute.after` with a non-zero exit, and an errored tool part.
// - Codex: a PostToolUse MCP result with `isError`. Its Bash and apply_patch results carry no exit
//   status, so they stay finished calls and give no failure.
// - Antigravity: a PostToolUse with an `error`.
// The features hold closed codes, two one-way digests and booleans. Never text, a path or output.
import test from 'node:test';
import assert from 'node:assert/strict';

const { runLauncher } = await import('../dist/launcher.js');
const claude = await import('@jevris/adapter-claude-code');
const codex = await import('@jevris/adapter-codex');
const kilocode = await import('@jevris/adapter-kilocode');
const opencode = await import('@jevris/adapter-opencode');
const antigravity = await import('@jevris/adapter-antigravity');

function normalized(adapter, native, context = {}) {
  const result = adapter.normalize(native, context);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

const ERR = 'Exit code 1\n  1) checkout totals\n     AssertionError: expected 41 to equal 42\n      at Context.<anonymous> (/Users/alice/work/shop/test/cart.test.js:10:5)\n      at process.processImmediate (node:internal/timers:483:21)';
const NO_LEAK = ['alice', 'cart.test', 'AssertionError', 'checkout', 'npm test', 'docker compose', 'github', 'ECONNREFUSED', '127.0.0.1', 'rate limit', 'x.test'];

function assertContentFree(failure, label) {
  const wire = JSON.stringify(failure);
  for (const leak of NO_LEAK) assert.equal(wire.includes(leak), false, `${label}: ${leak} must not travel`);
  assert.deepEqual(Object.keys(failure).sort(), ['commandDigest', 'elapsed', 'environmental', 'exitClass', 'family', 'present', 'signature', 'toolClass']);
}

test('Claude Code: PostToolUseFailure gives the failure features; a finished call gives none', () => {
  const failed = normalized(claude, { session_id: 's1', cwd: '/w/repo', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'npm test -- --grep checkout' }, error: ERR, duration_ms: 4200 });
  assert.equal(failed.event.kind, 'tool.failed');
  assert.deepEqual(failed.intent.failure, { toolClass: 'shell', exitClass: 'nonzero', family: 'shell:nonzero', signature: 'e4ccc2caf5dd4a33', commandDigest: 'ae442c59d9419a9c', environmental: false, elapsed: 'lt10s', present: ['failing-test-output', 'stack-trace'] });
  assertContentFree(failed.intent.failure, 'claude');
  const env = normalized(claude, { session_id: 's1', cwd: '/w/repo', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 't2', tool_input: { command: 'docker compose up' }, error: 'Exit code 127\nbash: docker: command not found' });
  assert.deepEqual(env.intent.failure, { toolClass: 'shell', exitClass: 'nonzero', family: 'shell:nonzero', signature: 'a26a9fba0d2e22c5', commandDigest: '92fe43385e01a841', environmental: true, elapsed: 'unknown', present: [] });
  const interrupted = normalized(claude, { session_id: 's1', cwd: '/w/repo', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 't3', tool_input: { command: 'sleep 100' }, error: 'Command was interrupted', is_interrupt: true, duration_ms: 120_000 });
  assert.deepEqual([interrupted.intent.failure.family, interrupted.intent.failure.exitClass, interrupted.intent.failure.elapsed], ['shell:timeout', 'timeout', 'gte60s']);
  const mcp = normalized(claude, { session_id: 's1', cwd: '/w/repo', hook_event_name: 'PostToolUseFailure', tool_name: 'mcp__github__create_issue', tool_use_id: 't4', tool_input: { title: 'x' }, error: 'HTTP 500 from server' });
  assert.deepEqual([mcp.intent.failure.toolClass, mcp.intent.failure.family], ['mcp', 'mcp:error']);
  assertContentFree(mcp.intent.failure, 'claude mcp');
  const silent = normalized(claude, { session_id: 's1', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash' });
  assert.deepEqual(silent.intent.failure, { toolClass: 'shell', exitClass: 'error', family: 'shell:error', signature: null, commandDigest: null, environmental: false, elapsed: 'unknown', present: [] });
  const finished = normalized(claude, { session_id: 's1', cwd: '/w/repo', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ok' } });
  assert.equal(finished.event.kind, 'tool.finished');
  assert.equal(finished.intent?.failure, undefined, 'a finished call has no failure features');
});

for (const [name, adapter] of [
  ['Kilo', kilocode],
  ['OpenCode', opencode],
]) {
  test(`${name}: a bash call that exits non-zero, and an errored tool part, give the failure features; a zero exit gives none`, () => {
    const bash = normalized(adapter, { hookKey: 'tool.execute.after', input: { tool: 'bash', sessionID: 'ses_1', callID: 'call_3', args: { command: 'npm test' } }, output: { title: 'npm test', output: ERR, metadata: { exit: 1 } } });
    assert.equal(bash.event.kind, 'tool.failed');
    assert.deepEqual(bash.intent.failure, { toolClass: 'shell', exitClass: 'nonzero', family: 'shell:nonzero', signature: 'e4ccc2caf5dd4a33', commandDigest: 'cb56e5fe68497b1d', environmental: false, elapsed: 'unknown', present: ['failing-test-output', 'stack-trace'] });
    assertContentFree(bash.intent.failure, `${name} bash`);
    // The same error text from another harness has the same signature: failures compare across harnesses.
    assert.equal(bash.intent.failure.signature, normalized(claude, { session_id: 's1', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'x' }, error: ERR }).intent.failure.signature);
    const part = normalized(adapter, { event: { type: 'message.part.updated', properties: { part: { id: 'prt_1', sessionID: 'ses_1', messageID: 'msg_1', type: 'tool', callID: 'call_9', tool: 'webfetch', state: { status: 'error', input: { url: 'https://x.test/a' }, error: 'ECONNREFUSED 127.0.0.1:443', time: { start: 1000, end: 2500 } } } } } });
    assert.equal(part.event.kind, 'tool.failed');
    assert.deepEqual(part.intent.failure, { toolClass: 'web', exitClass: 'error', family: 'web:error', signature: '9db084903fbab82c', commandDigest: '1c3561b79d27d500', environmental: true, elapsed: 'lt10s', present: [] });
    assertContentFree(part.intent.failure, `${name} part`);
    const ok = normalized(adapter, { hookKey: 'tool.execute.after', input: { tool: 'bash', sessionID: 'ses_1', callID: 'call_3', args: { command: 'npm test' } }, output: { title: 'npm test', output: 'ok', metadata: { exit: 0 } } });
    assert.equal(ok.event.kind, 'tool.finished');
    assert.equal(ok.intent?.failure, undefined);
  });
}

test('Codex: an MCP result with isError gives the failure features; Bash and apply_patch results stay finished calls', () => {
  const mcp = normalized(codex, { session_id: 's1', cwd: '/w/repo', hook_event_name: 'PostToolUse', tool_name: 'mcp__github__create_issue', tool_use_id: 'c1', tool_input: { title: 'x' }, tool_response: { isError: true, content: [{ type: 'text', text: 'Error: rate limit exceeded (429)' }] } });
  assert.equal(mcp.event.kind, 'tool.failed');
  assert.deepEqual(mcp.intent.failure, { toolClass: 'mcp', exitClass: 'error', family: 'mcp:error', signature: '5116daa11d8aa65e', commandDigest: 'bd12a7601739eebf', environmental: false, elapsed: 'unknown', present: [] });
  assertContentFree(mcp.intent.failure, 'codex');
  const bash = normalized(codex, { session_id: 's1', cwd: '/w/repo', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'c2', tool_input: { command: 'npm test' }, tool_response: 'exit 1' });
  assert.equal(bash.event.kind, 'tool.finished', 'Codex reports no exit status for a shell call, so it is not a failure event');
  assert.equal(bash.intent?.failure, undefined);
});

test('Antigravity: a PostToolUse with an error gives the failure features; one without gives none', () => {
  const base = antigravity.FIXTURES.find((f) => f.id === 'antigravity.post-tool-failed').native;
  const failed = normalized(antigravity, base, { hookKey: 'PostToolUse' });
  assert.equal(failed.event.kind, 'tool.failed');
  assert.deepEqual(failed.intent.failure, { toolClass: 'shell', exitClass: 'nonzero', family: 'shell:nonzero', signature: '27a186afc5ea70d7', commandDigest: '8e3c9173d67581c4', environmental: false, elapsed: 'unknown', present: [] });
  const env = normalized(antigravity, { ...base, toolCall: { name: 'run_command', args: { CommandLine: 'docker ps', Cwd: '/workspace/project' } }, error: 'permission denied while trying to connect to the Docker daemon socket' }, { hookKey: 'PostToolUse' });
  assert.deepEqual([env.intent.failure.environmental, env.intent.failure.exitClass], [true, 'error']);
  assertContentFree(env.intent.failure, 'antigravity');
  const ok = normalized(antigravity, antigravity.FIXTURES.find((f) => f.id === 'antigravity.post-tool').native, { hookKey: 'PostToolUse' });
  assert.equal(ok.event.kind, 'tool.finished');
  assert.equal(ok.intent?.failure, undefined);
});

test('the launcher sends the failure features next to the envelope as body.failure, and only for a failed call', async () => {
  const adapters = { claude, kilo: kilocode, codex, opencode, agy: antigravity };
  const send = async (harness, native, event = null) => {
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
    await runLauncher({ harness, event }, JSON.stringify(native), { adapters, sidecar, env: { JEVRIS_HOME: '/tmp/jevris-home' }, cwd: () => '/w/repo', nowMs: () => Date.now() }, Date.now());
    assert.equal(calls.length, 1);
    return calls[0].body;
  };
  const failed = await send('claude', { session_id: 's1', cwd: '/w/repo', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'npm test -- --grep checkout' }, error: ERR, duration_ms: 4200 });
  assert.equal(failed.envelope.kind, 'tool.failed');
  assert.equal(failed.failure.family, 'shell:nonzero');
  assert.equal(JSON.stringify(failed.envelope).includes('e4ccc2caf5dd4a33'), false, 'the digests are never in the recorded envelope');
  const agy = await send('agy', antigravity.FIXTURES.find((f) => f.id === 'antigravity.post-tool-failed').native, 'PostToolUse');
  assert.equal(agy.failure.family, 'shell:nonzero');
  const finished = await send('claude', { session_id: 's1', cwd: '/w/repo', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ok' } });
  assert.equal('failure' in finished, false);
  const stop = await send('claude', { session_id: 's1', hook_event_name: 'Stop', stop_hook_active: false });
  assert.deepEqual(Object.keys(stop).sort(), ['deliveryKey', 'envelope', 'showsExplain']);
});
