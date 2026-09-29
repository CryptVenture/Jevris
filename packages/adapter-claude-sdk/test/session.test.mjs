import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';


const FORBIDDEN_MODES = ['bypassPermissions', 'acceptEdits', 'auto', 'dontAsk', 'plan'];

function injectedPort() {
  const calls = [];
  const port = {
    calls,
    started: undefined,
    start(input) {
      calls.push('start');
      port.started = input;
      return { sessionId: 'owned-session' };
    },
    close() {
      calls.push('close');
    },
    abort() {
      calls.push('abort');
    },
    interrupt() {
      calls.push('interrupt');
    },
  };
  return port;
}

test('agent sdk query is a function and is not called', async () => {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  assert.equal(typeof sdk.query, 'function');
  assert.equal(sdk.query.length >= 0, true);
});

test('createOwnedSession refuses every permission mode other than default', async () => {
  const { createOwnedSession } = await import('../dist/index.js');
  for (const permissionMode of FORBIDDEN_MODES) {
    const port = injectedPort();
    const result = await createOwnedSession({
      permissionMode,
      prompt: 'not-sent',
      promptKind: 'string',
      port,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'refused');
    assert.equal(port.calls.includes('start'), false);
    assert.equal(port.calls.includes('close'), false);
    assert.equal(port.calls.includes('abort'), false);
    assert.equal(port.calls.includes('interrupt'), false);
  }
});

test('createOwnedSession refuses skip, checkpointing, and rewind before any port call', async () => {
  const { createOwnedSession } = await import('../dist/index.js');
  const refusals = [
    { allowDangerouslySkipPermissions: true },
    { enableFileCheckpointing: true },
    { rewind: true },
    { debug: true },
    { pathToClaudeCodeExecutable: '/tmp/not-claude' },
    { allowedTools: ['Bash'] },
  ];
  for (const extra of refusals) {
    const port = injectedPort();
    const result = await createOwnedSession({
      permissionMode: 'default',
      prompt: 'not-sent',
      promptKind: 'string',
      port,
      ...extra,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'refused');
    assert.equal(port.calls.length, 0);
  }
});

test('accepted options stay default and disallow worktree enter and exit', async () => {
  const { createOwnedSession } = await import('../dist/index.js');
  const port = injectedPort();
  const result = await createOwnedSession({
    permissionMode: 'default',
    prompt: 'not-sent',
    promptKind: 'string',
    port,
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, undefined);
  assert.equal(result.sessionId, 'owned-session');
  assert.equal(result.permissionMode, 'default');
  assert.deepEqual(result.disallowedTools, ['EnterWorktree', 'ExitWorktree']);
  assert.equal(typeof result.close, 'function');
  assert.equal(typeof result.abort, 'function');
  assert.equal(Object.hasOwn(result, 'interrupt'), false);
  assert.equal(port.calls.includes('start'), true);
  assert.equal(port.calls.includes('interrupt'), false);
  const options = port.started.options;
  assert.equal(options.permissionMode, 'default');
  assert.deepEqual(options.disallowedTools, ['EnterWorktree', 'ExitWorktree']);
  assert.equal(options.abortController instanceof AbortController, true);
  assert.deepEqual(Object.keys(options).sort(), ['abortController', 'disallowedTools', 'permissionMode']);
  assert.equal(Object.hasOwn(options, 'debug'), false);
  assert.equal(Object.hasOwn(options, 'pathToClaudeCodeExecutable'), false);
  assert.equal(Object.hasOwn(options, 'allowDangerouslySkipPermissions'), false);
  assert.equal(Object.hasOwn(options, 'enableFileCheckpointing'), false);
  assert.equal(Object.hasOwn(options, 'allowedTools'), false);
  assert.equal(port.started.prompt, 'not-sent');
  result.abort();
  result.close();
  assert.deepEqual(port.calls, ['start', 'abort', 'close']);
});

test('a streaming prompt may expose interrupt but does not call it during create', async () => {
  const { createOwnedSession } = await import('../dist/index.js');
  const port = injectedPort();
  async function* prompt() {
    yield { type: 'user', message: { role: 'user', content: 'not-sent' } };
  }
  const result = await createOwnedSession({
    permissionMode: 'default',
    prompt: prompt(),
    promptKind: 'stream',
    port,
  });
  assert.equal(result.ok, true);
  assert.equal(typeof result.interrupt, 'function');
  assert.equal(port.calls.includes('interrupt'), false);
  assert.equal(port.calls.includes('start'), true);
});

test('compiled session does not set a bypass, a debug flag, or a claude path', () => {
  const text = readFileSync(new URL('../dist/session.js', import.meta.url), 'utf8');
  assert.equal(text.includes('permissionMode'), true);
  assert.equal(text.includes("'default'") || text.includes('"default"'), true);
  assert.equal(text.includes('EnterWorktree'), true);
  assert.equal(text.includes('ExitWorktree'), true);
  assert.equal(text.includes('query'), true);
  assert.equal(text.includes('debug: true'), false);
  assert.equal(text.includes('debug:true'), false);
  assert.equal(text.includes('pathToClaudeCodeExecutable'), false);
  assert.equal(text.includes('allowDangerouslySkipPermissions'), false);
  assert.equal(text.includes('bypassPermissions'), false);
  assert.equal(text.includes('acceptEdits'), false);
  assert.equal(text.includes('createSession'), false);
  assert.equal(text.includes('rewindFiles'), false);
  assert.equal(text.includes('enableFileCheckpointing'), false);
});
