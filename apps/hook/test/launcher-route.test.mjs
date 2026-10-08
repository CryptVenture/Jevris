// Claude Code subagent routing through the launcher (owner decision 9ce2ba5, E 7a6f7a5): the
// sidecar proposes only a registry model id; the launcher renders it with the adapter from the
// harness's own hook input, so no tool-input value crosses the sidecar boundary.
import test from 'node:test';
import assert from 'node:assert/strict';

const { runLauncher, outcomeOf } = await import('../dist/launcher.js');
const claude = await import('@jevris/adapter-claude-code');
const codex = await import('@jevris/adapter-codex');
const ADAPTERS = { claude, codex };

const nativeOf = (adapter, id) => adapter.FIXTURES.find((fixture) => fixture.id === id).native;

function sidecarProposing(proposal) {
  const requests = [];
  return {
    requests,
    sidecar: {
      async ensure() {
        return { ok: true, endpoint: 'fake', started: false };
      },
      async request(input) {
        requests.push(input);
        return { ok: true, result: { recorded: true, duplicate: false, results: { decision: proposal } } };
      },
    },
  };
}

const deps = (sidecar) => ({ adapters: ADAPTERS, sidecar, env: { JEVRIS_HOME: '/tmp/jevris-home' }, cwd: () => '/work', nowMs: () => Date.now() });
const run = (harness, native, proposal) => {
  const fake = sidecarProposing(proposal);
  return runLauncher({ harness, event: null }, JSON.stringify(native), deps(fake.sidecar), Date.now()).then((result) => ({ ...result, requests: fake.requests }));
};

test('a certified wire route renders the alias on the harness own input, and the sidecar never saw a tool-input value', async () => {
  const native = nativeOf(claude, 'claude.pre-agent');
  const result = await run('claude', native, { hookOutcome: { kind: 'route', model: 'claude-haiku-4-5' }, certified: true });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...native.tool_input, model: 'haiku' } } });
  assert.match(result.reason, /^PROPOSED_BY_DECISION/);
  const sent = JSON.stringify(result.requests[0].body);
  assert.ok(!sent.includes('find x') && !sent.includes('"search"'), 'the prompt and description never reach the sidecar');
  assert.equal(result.requests[0].body.envelope.payload.subagentType, 'Explore', 'the subagent type does');
});

test('rewrite plus instruct: a route with a note renders the rewrite and the note in one PreToolUse answer; a context outcome on the same call is the advice form', async () => {
  const native = nativeOf(claude, 'claude.pre-agent');
  const note = 'Jevris set model haiku on this one Agent call (read-only type, low risk by rules). The session model is unchanged.';
  const routed = await run('claude', native, { hookOutcome: { kind: 'route', model: 'claude-haiku-5-5', context: note }, certified: true });
  assert.equal(routed.stdout, JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...native.tool_input, model: 'haiku' }, additionalContext: note } }));
  const sent = JSON.stringify(routed.requests[0].body);
  assert.ok(!sent.includes('find x') && !sent.includes('"search"'), 'the prompt and description still never reach the sidecar');
  // The sidecar's downgrade when the route cannot be applied: the same advice, addressed to the model.
  const advice = 'Jevris advises model: haiku for this Explore subagent (read-only type, low risk by rules). This call already started; set model on the next Agent call to apply it. The session model is unchanged.';
  const advised = await run('claude', native, { hookOutcome: { kind: 'context', text: advice }, certified: true });
  assert.deepEqual(JSON.parse(advised.stdout), { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: advice } });
  // Not certified: a context never renders.
  assert.equal((await run('claude', native, { hookOutcome: { kind: 'context', text: advice }, certified: false })).stdout, '');
  // The note is validated on the wire like the rest of the route.
  assert.deepEqual(outcomeOf({ hookOutcome: { kind: 'route', model: 'claude-haiku-5-5', context: note }, certified: true }), { outcome: { kind: 'route', model: 'claude-haiku-5-5', context: note }, certified: true });
  assert.deepEqual(outcomeOf({ hookOutcome: { kind: 'route', model: 'claude-haiku-5-5', context: null }, certified: true }), { outcome: { kind: 'route', model: 'claude-haiku-5-5' }, certified: true });
  assert.equal(outcomeOf({ hookOutcome: { kind: 'route', model: 'claude-haiku-5-5', context: 7 }, certified: true }), null);
  assert.equal(outcomeOf({ hookOutcome: { kind: 'route', model: 'claude-haiku-5-5', context: '' }, certified: true }), null);
  // Codex ignores the note.
  const codexNative = nativeOf(codex, codex.FIXTURES.find((fixture) => fixture.native?.hook_event_name === 'PreToolUse')?.id ?? codex.FIXTURES[0].id);
  const withNote = await run('codex', codexNative, { hookOutcome: { kind: 'route', model: 'claude-haiku-5-5', context: note }, certified: true });
  assert.ok(!withNote.stdout.includes(note), 'no Codex output carries the Claude Code note');
});

test('a route with no alias, an uncertified route, or a pinned subagent is no decision', async () => {
  const native = nativeOf(claude, 'claude.pre-agent');
  const other = await run('claude', native, { hookOutcome: { kind: 'route', model: 'gpt-5.5' }, certified: true });
  assert.deepEqual([other.stdout, other.reason], ['', 'ROUTE_NOT_RENDERED']);
  const spelled = await run('claude', native, { hookOutcome: { kind: 'route', model: 'anthropic/claude-haiku-4-5', variant: 'high' }, certified: true });
  assert.deepEqual([spelled.stdout, spelled.reason], ['', 'ROUTE_NOT_RENDERED'], 'Claude Code takes no provider/model spelling');
  const uncertified = await run('claude', native, { hookOutcome: { kind: 'route', model: 'claude-haiku-4-5' }, certified: false });
  assert.deepEqual([uncertified.stdout, uncertified.reason], ['', 'NOT_CERTIFIED']);
  const pinned = await run('claude', nativeOf(claude, 'claude.pre-agent-pinned'), { hookOutcome: { kind: 'route', model: 'claude-haiku-4-5' }, certified: true });
  assert.deepEqual([pinned.stdout, pinned.reason], ['', 'ROUTE_NOT_RENDERED']);
});

test('an input cut to fit is never routed: the route would rewrite a cut prompt', async () => {
  const native = nativeOf(claude, 'claude.pre-agent');
  const long = { ...native, tool_input: { ...native.tool_input, prompt: 'p'.repeat(140_000) } };
  const result = await run('claude', long, { hookOutcome: { kind: 'route', model: 'claude-haiku-4-5' }, certified: true });
  assert.equal(result.exitCode, 0);
  assert.deepEqual([result.stdout, result.reason], ['', 'ROUTE_INPUT_CUT']);
});

test('the wire route is only a model id: a legacy updatedInput or a malformed model is refused before rendering', async () => {
  assert.equal(outcomeOf({ hookOutcome: { kind: 'route', updatedInput: { model: 'haiku' } }, certified: true }), null);
  assert.equal(outcomeOf({ hookOutcome: { kind: 'route', model: 'https://example.test/x' }, certified: true }), null);
  assert.deepEqual(outcomeOf({ hookOutcome: { kind: 'route', model: 'claude-haiku-4-5' }, certified: true }), { outcome: { kind: 'route', model: 'claude-haiku-4-5' }, certified: true });
  // R20 (C): a provider/model route and its variant reach the adapter; a null variant is dropped, a malformed one refuses the route.
  assert.deepEqual(outcomeOf({ hookOutcome: { kind: 'route', model: 'openai/gpt-6-sol', variant: 'high' }, certified: true }), { outcome: { kind: 'route', model: 'openai/gpt-6-sol', variant: 'high' }, certified: true });
  assert.deepEqual(outcomeOf({ hookOutcome: { kind: 'route', model: 'claude-haiku-4-5', variant: null }, certified: true }), { outcome: { kind: 'route', model: 'claude-haiku-4-5' }, certified: true });
  assert.equal(outcomeOf({ hookOutcome: { kind: 'route', model: 'openai/gpt-6-sol', variant: 'High Effort' }, certified: true }), null);
  const codexNative = nativeOf(codex, codex.FIXTURES.find((fixture) => fixture.native?.hook_event_name === 'PreToolUse')?.id ?? codex.FIXTURES[0].id);
  const result = await run('codex', codexNative, { hookOutcome: { kind: 'route', model: 'claude-haiku-4-5' }, certified: true });
  assert.equal(result.exitCode, 0);
  assert.ok(!result.stdout.includes('updatedInput'), 'Codex never renders a route');
});
