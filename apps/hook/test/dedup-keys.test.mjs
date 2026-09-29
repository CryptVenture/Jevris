// Dedup keys across all five adapters: a repeatable event later in the same session is a new
// delivery; a redelivery of the same event is still a duplicate.
// - Claude Code and Codex: no event id on PreCompact, SessionStart, Stop or a repeated prompt,
//   so the launcher passes the transcript position (its size) and the key includes it.
// - Kilo and OpenCode: bus events such as session.idle and session.compacted, and the compacting
//   hook, carry no id, so the shim stamps each delivered event object (instance, sequence).
// - Antigravity: its step, invocation and execution counters already tell deliveries apart.
import test from 'node:test';
import assert from 'node:assert/strict';

const { transcriptPosition } = await import('../dist/launcher.js');
const claude = await import('@jevris/adapter-claude-code');
const codex = await import('@jevris/adapter-codex');
const kilocode = await import('@jevris/adapter-kilocode');
const opencode = await import('@jevris/adapter-opencode');
const antigravity = await import('@jevris/adapter-antigravity');

function key(adapter, native, context = {}) {
  const result = adapter.normalize(native, context);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.event.dedupKey;
}

const CLAUDE_REPEATABLE = [
  { hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: '' },
  { hook_event_name: 'PostCompact', trigger: 'auto' },
  { hook_event_name: 'SessionStart', source: 'compact' },
  { hook_event_name: 'Stop', stop_hook_active: false },
  { hook_event_name: 'UserPromptSubmit', prompt: 'continue' },
];

test('Claude Code: a repeatable event at a later transcript position gets a new key; the same position dedups', () => {
  for (const event of CLAUDE_REPEATABLE) {
    const native = { ...event, session_id: 's1', transcript_path: '/t/s1.jsonl', cwd: '/w' };
    const first = key(claude, native, { transcriptBytes: 1_000 });
    assert.notEqual(key(claude, native, { transcriptBytes: 5_000 }), first, `${event.hook_event_name}: a second one in the session collides`);
    assert.equal(key(claude, native, { transcriptBytes: 1_000 }), first, `${event.hook_event_name}: a redelivery does not dedup`);
    assert.equal(key(claude, native), key(claude, native), 'without a position the key is still stable');
  }
});

test('Codex: two compactions in one turn get their own keys; a redelivery dedups', () => {
  for (const name of ['PreCompact', 'PostCompact', 'Stop']) {
    const native = { hook_event_name: name, session_id: 's1', turn_id: 'turn-1', transcript_path: '/t/s1.jsonl', cwd: '/w', trigger: 'auto' };
    const first = key(codex, native, { transcriptBytes: 2_048 });
    assert.notEqual(key(codex, native, { transcriptBytes: 9_000 }), first, `${name}: a second one in the turn collides`);
    assert.equal(key(codex, native, { transcriptBytes: 2_048 }), first);
  }
  const start = { hook_event_name: 'SessionStart', session_id: 's1', source: 'compact', transcript_path: '/t/s1.jsonl', cwd: '/w' };
  assert.notEqual(key(codex, start, { transcriptBytes: 10 }), key(codex, start, { transcriptBytes: 20 }));
});

test('the launcher gives the transcript size as the position, and nothing when it cannot', () => {
  const sizes = { '/t/s1.jsonl': 4_096 };
  const deps = { fileSize: (path) => sizes[path] ?? null };
  assert.equal(transcriptPosition(deps, { transcript_path: '/t/s1.jsonl' }), 4_096);
  assert.equal(transcriptPosition(deps, { transcript_path: '/t/missing.jsonl' }), null);
  assert.equal(transcriptPosition(deps, { transcript_path: 42 }), null);
  assert.equal(transcriptPosition(deps, {}), null);
  assert.equal(transcriptPosition({}, { transcript_path: '/t/s1.jsonl' }), null, 'no fileSize dependency, no position');
  assert.equal(transcriptPosition({ fileSize: () => { throw new Error('EACCES'); } }, { transcript_path: '/t/s1.jsonl' }), null);
  assert.equal(transcriptPosition({ fileSize: () => -1 }, { transcript_path: '/t/s1.jsonl' }), null);
});

for (const [name, adapter] of [['Kilo', kilocode], ['OpenCode', opencode]]) {
  test(`${name}: each delivered event object gets its own stamp; the same object redelivered keeps it`, async () => {
    const sent = [];
    const hooks = adapter.createHooks(async (text) => {
      sent.push(JSON.parse(text));
      return '';
    });
    const compacted = () => ({ event: { type: 'session.compacted', properties: { sessionID: 'ses_1' } } });
    const idle = () => ({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } });
    const first = compacted();
    await hooks.event(first);
    await hooks.event(compacted());
    await hooks.event(first);
    await hooks.event(idle());
    await hooks.event(idle());
    const compacting = { sessionID: 'ses_1' };
    await hooks['experimental.session.compacting'](compacting, { context: [] });
    await hooks['experimental.session.compacting']({ sessionID: 'ses_1' }, { context: [] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const keys = sent.map((native) => key(adapter, native, native.hookKey === 'event' ? { hookKey: 'event' } : { hookKey: native.hookKey }));
    assert.equal(keys.length, 7);
    assert.notEqual(keys[1], keys[0], 'a second session.compacted in the session collides');
    assert.equal(keys[2], keys[0], 'the same event object redelivered does not dedup');
    assert.notEqual(keys[4], keys[3], 'a second session.idle collides');
    assert.notEqual(keys[6], keys[5], 'a second compacting hook collides');
    // A replay of the exact forwarded input (a launcher retry) is the same key.
    assert.equal(key(adapter, sent[0], { hookKey: 'event' }), keys[0]);
    // Two shim loads (a harness restart resuming ses_1) never share a stamp.
    const other = [];
    const again = adapter.createHooks(async (text) => {
      other.push(JSON.parse(text));
      return '';
    });
    await again.event(compacted());
    assert.notEqual(key(adapter, other[0], { hookKey: 'event' }), keys[0]);
  });
}

test('Antigravity: its counters already separate deliveries, and a redelivery dedups', () => {
  const common = { conversationId: 'c1', workspacePaths: ['/w'], modelName: 'm' };
  const stop = (executionNum) => ({ ...common, executionNum, terminationReason: 'model_stop', error: '', fullyIdle: true });
  assert.notEqual(key(antigravity, stop(1), { hookKey: 'Stop' }), key(antigravity, stop(2), { hookKey: 'Stop' }));
  assert.equal(key(antigravity, stop(1), { hookKey: 'Stop' }), key(antigravity, stop(1), { hookKey: 'Stop' }));
  const pre = (invocationNum) => ({ ...common, invocationNum });
  assert.notEqual(key(antigravity, pre(1), { hookKey: 'PreInvocation' }), key(antigravity, pre(2), { hookKey: 'PreInvocation' }));
});
