// CLA-04 and CLA-05 at the protocol layer, plus the §15.4 "user pin" item: a routed Agent or
// Task input changes nothing but `model`, an explicit pin is never overridden, and no output
// ever carries a permission decision.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as claudeAdapter from '../dist/index.js';

const adapters = [{ mod: claudeAdapter }];

test('user pin: routing respects an explicit model and changes nothing but the model', () => {
  const claude = adapters[0].mod;
  const byId = (id) => claude.normalize(claude.FIXTURES.find((fixture) => fixture.id === id).native).event;
  const nativeOf = (id) => claude.FIXTURES.find((fixture) => fixture.id === id).native;
  const free = byId('claude.pre-agent');
  const pinned = byId('claude.pre-agent-pinned');
  const native = nativeOf('claude.pre-agent');
  const routed = claude.routedInput(native, 'haiku');
  assert.deepEqual(routed, { ...native.tool_input, model: 'haiku' });
  // The wire route names a registry id; the adapter renders its alias on the native input.
  const route = { kind: 'route', model: 'claude-haiku-4-5' };
  assert.deepEqual(JSON.parse(claude.protocolResponse(free, route, native)), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: routed },
  });
  assert.equal(claude.protocolResponse(free, route), '', 'no native input, no route');
  assert.equal(claude.protocolResponse(pinned, route, nativeOf('claude.pre-agent-pinned')), '', 'an explicit model is never overridden');
  assert.equal(claude.routedInput(nativeOf('claude.pre-agent-pinned'), 'haiku'), null);
  const dropped = { ...native, tool_input: { prompt: 'find x', subagent_type: 'Explore' } };
  assert.equal(claude.protocolResponse(free, route, dropped), '', 'an input whose keys differ from the event refuses');
  const added = { ...native, tool_input: { ...native.tool_input, extra: 1 } };
  assert.equal(claude.protocolResponse(free, route, added), '', 'an added key refuses');
  const bashNative = { hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_use_id: 'x', tool_input: { command: 'ls' } };
  assert.equal(claude.protocolResponse(claude.normalize(bashNative).event, route, bashNative), '', 'only Agent and Task route');
});

test('rewrite plus instruct: a route with a context note renders updatedInput and additionalContext together on PreToolUse, and only then', () => {
  const claude = adapters[0].mod;
  const native = claude.FIXTURES.find((fixture) => fixture.id === 'claude.pre-agent').native;
  const event = claude.normalize(native).event;
  const note = 'Jevris set model haiku on this one Agent call (read-only type, low risk by rules). The session model is unchanged.';
  const out = claude.protocolResponse(event, { kind: 'route', model: 'claude-haiku-5-5', context: note }, native);
  // The exact JSON: one hookSpecificOutput holding the rewrite and the note, no permission decision. Claude Code accepting
  // both fields in one PreToolUse answer is not proven by any repository fixture (no real binary is run here): it is
  // flagged as unverified in the docs and the certification report.
  assert.equal(out, JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...native.tool_input, model: 'haiku' }, additionalContext: note } }));
  assert.equal(out.includes('permissionDecision'), false);
  // Without a note the output is what it was before; a blank note adds nothing.
  const plain = claude.protocolResponse(event, { kind: 'route', model: 'claude-haiku-5-5' }, native);
  assert.deepEqual(JSON.parse(plain), { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...native.tool_input, model: 'haiku' } } });
  assert.equal(claude.protocolResponse(event, { kind: 'route', model: 'claude-haiku-5-5', context: '   ' }, native), plain);
  // A route that cannot be applied says nothing, note or not: the note would claim a rewrite that did not happen.
  const pinnedNative = claude.FIXTURES.find((fixture) => fixture.id === 'claude.pre-agent-pinned').native;
  assert.equal(claude.protocolResponse(claude.normalize(pinnedNative).event, { kind: 'route', model: 'claude-haiku-5-5', context: note }, pinnedNative), '');
  assert.equal(claude.protocolResponse(event, { kind: 'route', model: 'claude-haiku-5-5', context: note }), '');
  // The advice form (not applied) is an ordinary context on PreToolUse.
  const advice = 'Jevris advises model: haiku for this Explore subagent (read-only type, low risk by rules).';
  assert.deepEqual(JSON.parse(claude.protocolResponse(event, { kind: 'context', text: advice })), { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: advice } });
});

test('a route UP (tiered routing, 2026-10-08): the exact PreToolUse JSON sets model opus on one Agent call, with the note for the model, and nothing else', () => {
  const claude = adapters[0].mod;
  const native = claude.FIXTURES.find((fixture) => fixture.id === 'claude.pre-agent').native;
  const event = claude.normalize(native).event;
  const note = "Jevris set model opus on this one Agent call (the session's work was judged very hard by the tier rules (TIER_PROTECTED_PATH); a rules-based default, not a learned route and not a signed prior). The session model is unchanged.";
  const out = claude.protocolResponse(event, { kind: 'route', model: 'claude-opus-5-5', context: note }, native);
  assert.equal(out, JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...native.tool_input, model: 'opus' }, additionalContext: note } }));
  assert.equal(out.includes('permissionDecision'), false, 'no permission decision: native permissions stay authoritative');
  assert.deepEqual(Object.keys(JSON.parse(out).hookSpecificOutput.updatedInput).sort(), [...Object.keys(native.tool_input), 'model'].sort(), 'only the model key is added to the native input');
  // Not routable the pinned way: an explicit model on the call is never overridden, whatever the tier says.
  const pinnedNative = claude.FIXTURES.find((fixture) => fixture.id === 'claude.pre-agent-pinned').native;
  assert.equal(claude.protocolResponse(claude.normalize(pinnedNative).event, { kind: 'route', model: 'claude-opus-5-5', context: note }, pinnedNative), '');
});

test('route: a registry id maps to the haiku, sonnet, opus or fable alias by family (R25); any other model is never routed', () => {
  const claude = claudeAdapter;
  const cases = [
    ['claude-haiku-4-5', 'haiku'],
    ['claude-sonnet-4-5-20250929', 'sonnet'],
    ['claude-opus-5-5', 'opus'],
    ['claude-3-5-haiku-20241022', 'haiku'],
    ['sonnet', 'sonnet'],
    ['claude-fable-5-1', 'fable'],
    ['fable', 'fable'],
    ['gpt-5.5', null],
    ['haiku-claude', null],
    ['claude-opusx-1', null],
  ];
  for (const [id, alias] of cases) assert.equal(claude.subagentAlias(id), alias, id);
  const native = claude.FIXTURES.find((fixture) => fixture.id === 'claude.pre-agent').native;
  const free = claude.normalize(native).event;
  assert.equal(claude.routeInput(native, 'gpt-5.5'), null);
  assert.equal(claude.protocolResponse(free, { kind: 'route', model: 'gpt-5.5' }, native), '', 'no alias, no route');
  assert.equal(JSON.parse(claude.protocolResponse(free, { kind: 'route', model: 'claude-fable-5-1' }, native)).hookSpecificOutput.updatedInput.model, 'fable');
  assert.equal(JSON.parse(claude.protocolResponse(free, { kind: 'route', model: 'claude-opus-5-5' }, native)).hookSpecificOutput.updatedInput.model, 'opus');
  assert.deepEqual([...claude.SUBAGENT_MODEL_ALIASES], ['haiku', 'sonnet', 'opus', 'fable']);
});

test('PreModelSwitch is explained, never answered with ask or a block, and PostModelSwitch is observed', () => {
  const claude = claudeAdapter;
  const byId = (id) => claude.normalize(claude.FIXTURES.find((fixture) => fixture.id === id).native).event;
  const pre = byId('claude.pre-switch');
  const post = byId('claude.post-switch');
  assert.equal(pre.kind, 'model.change.requested');
  assert.equal(post.kind, 'model.changed');
  assert.deepEqual(JSON.parse(claude.protocolResponse(pre, { kind: 'explain', text: 'outside the calibrated range' })), {
    systemMessage: 'outside the calibrated range',
  });
  for (const outcome of [{ kind: 'observe' }, { kind: 'context', text: 'x' }, { kind: 'route', model: 'claude-haiku-4-5' }]) {
    assert.equal(claude.protocolResponse(pre, outcome, claude.FIXTURES.find((fixture) => fixture.id === 'claude.pre-switch').native), '');
    assert.equal(claude.protocolResponse(post, outcome), '');
  }
});

test('Codex-shaped input is refused, never replayed as Claude protocol', () => {
  const result = claudeAdapter.normalize({ hook_event_name: 'Stop', session_id: 's', turn_id: 't' });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'FOREIGN_PROTOCOL');
  assert.equal(claudeAdapter.normalize({ hook_event_name: 'Interrupt', session_id: 's' }).reasonCode, 'FOREIGN_PROTOCOL');
});
