// G8 (harness parity audit): Kilo and OpenCode failed-tool evidence, as read from OpenCode
// v1.18.32 and Kilo v7.8.1. A bash call that exits non-zero returns normally with
// metadata.exit; a tool that throws never reaches tool.execute.after, and its part in
// message.part.updated ends in state error. Both are tool.failed with the first line as
// evidence. Every other part update stays noise.
import test from 'node:test';
import assert from 'node:assert/strict';

const kilo = await import('../dist/index.js');
const opencode = await import('@jevris/adapter-opencode');

for (const [name, adapter] of [['kilocode', kilo], ['opencode', opencode]]) {
  test(`${name}: a bash call with a non-zero metadata.exit is tool.failed; exit 0 or null is not`, () => {
    const after = (exit) =>
      adapter.normalize(
        { hookKey: 'tool.execute.after', input: { tool: 'bash', sessionID: 'ses_1', callID: 'call_1', args: { command: 'npm test' } }, output: { title: 'npm test', output: '\nFAIL src/a.test.ts\nmore', metadata: { exit } } },
        { hookKey: 'tool.execute.after' },
      );
    const failed = after(1);
    assert.equal(failed.ok, true);
    assert.equal(failed.event.kind, 'tool.failed');
    assert.deepEqual(failed.intent.evidence.diagnostics, [{ id: 'error', text: 'FAIL src/a.test.ts' }]);
    assert.equal(after(0).event.kind, 'tool.finished');
    assert.equal(after(null).event.kind, 'tool.finished', 'a timeout or abort says nothing about success');
    assert.equal(after('1').event.kind, 'tool.finished');
    const other = adapter.normalize(
      { hookKey: 'tool.execute.after', input: { tool: 'read', sessionID: 'ses_1', callID: 'call_2' }, output: { title: 'x', output: '', metadata: { exit: 1 } } },
      { hookKey: 'tool.execute.after' },
    );
    assert.equal(other.event.kind, 'tool.finished', 'only the bash tool has an exit code');
  });

  test(`${name}: a tool part in state error is tool.failed with its error's first line; other parts stay noise`, () => {
    const part = (state, type = 'tool') => ({ event: { type: 'message.part.updated', properties: { sessionID: 'ses_1', part: { id: 'prt_1', sessionID: 'ses_1', messageID: 'msg_1', type, callID: 'call_3', tool: 'edit', state } } } });
    const failed = adapter.normalize(part({ status: 'error', input: {}, error: 'Error: oldString not found\nstack', time: { start: 1, end: 2 } }));
    assert.equal(failed.ok, true);
    assert.equal(failed.event.kind, 'tool.failed');
    assert.equal(failed.event.toolName, 'edit');
    assert.equal(failed.event.toolUseId, 'call_3');
    assert.deepEqual(failed.intent.evidence.diagnostics, [{ id: 'error', text: 'Error: oldString not found' }]);
    for (const quiet of [part({ status: 'completed', input: {}, output: 'ok' }), part({ status: 'running', input: {} }), part({ status: 'error', error: 'x' }, 'text'), { event: { type: 'message.part.updated', properties: {} } }]) {
      const result = adapter.normalize(quiet);
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'UNKNOWN_EVENT');
    }
  });
}
