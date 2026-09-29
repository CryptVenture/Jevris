import test from 'node:test';
import assert from 'node:assert/strict';

// US12: which model each harness's hook events name, recorded per session. Claude Code and
// Codex report the model in use on their hooks, and Claude's model-switch hooks name the one
// requested. Kilo and OpenCode name the model chosen for a message when it is sent (requested)
// and the one that answered when the message completes (actual). Antigravity names its model on
// every event.

const { sessionOf } = await import('../dist/state.js');

const envelope = (harness, kind, model, payload = {}) => ({ schemaVersion: '1.0', harness, nativeEventName: kind, kind, sessionId: 's1', model, payload, dedupKey: 'k' });
const models = (harness, kind, model, payload) => {
  const s = sessionOf(envelope(harness, kind, model, payload), {});
  return [s.requestedModel, s.actualModel];
};

test('each harness event names the requested or the actual model of its session (US12)', () => {
  assert.deepEqual(models('claude', 'session.started', 'claude-sonnet-4-6'), [null, 'claude-sonnet-4-6']);
  assert.deepEqual(models('claude', 'task.requested', 'claude-sonnet-4-6'), [null, 'claude-sonnet-4-6']);
  assert.deepEqual(models('claude', 'model.change.requested', 'claude-sonnet-4-6', { toModel: 'claude-opus-4-7' }), ['claude-opus-4-7', null]);
  assert.deepEqual(models('claude', 'model.changed', 'claude-sonnet-4-6', { toModel: 'claude-opus-4-7' }), [null, 'claude-opus-4-7']);
  assert.deepEqual(models('codex', 'tool.proposed', 'gpt-5.1-codex'), [null, 'gpt-5.1-codex']);
  for (const harness of ['kilocode', 'opencode']) {
    assert.deepEqual(models(harness, 'task.requested', 'anthropic/claude-opus-4-7'), ['anthropic/claude-opus-4-7', null], `${harness} chat.message is the requested model`);
    assert.deepEqual(models(harness, 'message.completed', 'anthropic/claude-sonnet-4-6'), [null, 'anthropic/claude-sonnet-4-6'], `${harness} message.completed is the actual model`);
    assert.deepEqual(models(harness, 'tool.finished', null), [null, null], `${harness} tool events carry no model`);
  }
  assert.deepEqual(models('antigravity', 'tool.finished', 'gemini-3-pro'), [null, 'gemini-3-pro']);
  assert.equal(sessionOf({ ...envelope('claude', 'x', null), sessionId: null }, {}), undefined, 'no session id, no row');
});

test("a subagent's event is recorded under the parent session, without its model and without ending it", () => {
  // The session's own events, as a baseline for each pair below.
  const own = sessionOf(envelope('claude', 'tool.finished', 'claude-opus-5-5'), {});
  assert.deepEqual([own.sessionId, own.requestedModel, own.actualModel, own.state], ['s1', null, 'claude-opus-5-5', 'active']);
  assert.equal(sessionOf(envelope('opencode', 'session.ended', null), {}).state, 'ended', "the session's own end ends it");
  // The same events from a subagent: every adapter sets sessionId to the parent, agentId to the
  // subagent and parentSessionId to the parent.
  const sub = (harness, kind, model, payload) => sessionOf({ ...envelope(harness, kind, model, payload), agentId: 'child-1', parentSessionId: 's1' }, { harnessVersion: '1.0.0' });
  for (const harness of ['claude', 'codex', 'kilocode', 'opencode']) {
    const s = sub(harness, 'tool.finished', 'some-subagent-model');
    assert.deepEqual([s.sessionId, s.harness, s.requestedModel, s.actualModel, s.state], ['s1', harness, null, null, 'active'], `${harness} subagent tool event`);
    assert.equal(s.harnessVersion, '1.0.0');
  }
  assert.deepEqual([sub('opencode', 'message.completed', 'anthropic/claude-haiku-4-5').actualModel, sub('kilocode', 'worker.prompted', 'anthropic/claude-haiku-4-5').requestedModel], [null, null], "a child session's models are not the parent's");
  assert.equal(sub('opencode', 'session.ended', null).state, 'active', 'a subagent ending never ends the parent session');
});
