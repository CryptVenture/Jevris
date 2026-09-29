import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


function injectedPort() {
  const calls = [];
  return {
    calls,
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
}

// Every directory a test makes is removed when the file ends, pass or fail
// (JEVRIS_KEEP_TEST_DIRS=1 keeps them for a look).
const made = [];
after(() => {
  if (process.env.JEVRIS_KEEP_TEST_DIRS === '1') return;
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'jevris-home-'));
  made.push(home);
  return home;
}

function keptWorktree() {
  const path = mkdtempSync(join(tmpdir(), 'jevris-keep-'));
  made.push(path);
  writeFileSync(join(path, 'edit.txt'), 'recoverable');
  return path;
}

test('cancel aborts and closes a string prompt without treating interrupt as the cancel', async () => {
  const { cancelOwnedSession } = await import('../dist/index.js');
  const home = tempHome();
  const path = keptWorktree();
  const port = injectedPort();
  const result = await cancelOwnedSession({
    home,
    sessionId: 'owned-1',
    ownedSessionIds: ['owned-1'],
    promptKind: 'string',
    worktree: { path, status: 'dirty' },
    port,
  });
  assert.deepEqual(port.calls, ['abort', 'close']);
  assert.equal(result.signalled, true);
  assert.equal(result.deleted, false);
  assert.equal(result.schedulingStopped, true);
  assert.equal(result.effect, 'needs-reconciliation');
  assert.equal(result.path, path);
  assert.equal(result.report, path);
  assert.equal(existsSync(path), true);
  assert.equal(existsSync(join(path, 'edit.txt')), true);
});

test('cancel interrupts a streaming prompt only after abort and close', async () => {
  const { cancelOwnedSession } = await import('../dist/index.js');
  const port = injectedPort();
  const path = keptWorktree();
  const result = await cancelOwnedSession({
    home: tempHome(),
    sessionId: 'owned-stream',
    ownedSessionIds: ['owned-stream'],
    promptKind: 'stream',
    worktree: { path, status: 'clean' },
    port,
  });
  assert.deepEqual(port.calls, ['abort', 'close', 'interrupt']);
  assert.equal(result.signalled, true);
  assert.equal(result.deleted, false);
  assert.equal(existsSync(path), true);
});

test('an unowned session id is not signalled', async () => {
  const { cancelOwnedSession } = await import('../dist/index.js');
  const port = injectedPort();
  const path = keptWorktree();
  const result = await cancelOwnedSession({
    home: tempHome(),
    sessionId: 'foreign-1',
    ownedSessionIds: ['owned-1'],
    promptKind: 'stream',
    worktree: { path, status: 'dirty' },
    port,
  });
  assert.equal(port.calls.length, 0);
  assert.equal(result.signalled, false);
  assert.equal(result.deleted, false);
  assert.equal(result.schedulingStopped, true);
  assert.equal(existsSync(path), true);
});

test('dirty unknown and unreadable worktrees are retained and scheduling stops', async () => {
  const { cancelOwnedSession, readSchedulingStopped, schedulingStoppedPath } = await import('../dist/index.js');
  for (const status of ['dirty', 'unknown', 'unreadable', 'clean']) {
    const home = tempHome();
    const path = keptWorktree();
    const port = injectedPort();
    const result = await cancelOwnedSession({
      home,
      sessionId: 'owned-keep',
      ownedSessionIds: ['owned-keep'],
      promptKind: 'string',
      worktree: { path, status },
      port,
    });
    assert.equal(result.deleted, false);
    assert.equal(result.path, path);
    assert.equal(result.report, path);
    assert.equal(result.schedulingStopped, true);
    assert.equal(existsSync(path), true);
    assert.equal(existsSync(join(path, 'edit.txt')), true);
    assert.equal(await readSchedulingStopped(home), true);
    const file = schedulingStoppedPath(home);
    const raw = readFileSync(file, 'utf8');
    assert.deepEqual(JSON.parse(raw), { stopped: true });
    assert.equal(raw.includes('source'), false);
    assert.equal(raw.includes('secret'), false);
    assert.equal(JSON.stringify(result).includes('ANTHROPIC'), false);
  }
});

test('compiled cancel does not delete a path or spawn git', () => {
  const text = readFileSync(new URL('../dist/cancel.js', import.meta.url), 'utf8');
  assert.equal(text.includes('scheduling-stopped.json'), true);
  assert.equal(text.includes('needs-reconciliation'), true);
  assert.equal(text.includes('rm('), false);
  assert.equal(text.includes('rmSync'), false);
  assert.equal(text.includes('spawn'), false);
  assert.equal(text.includes('rewindFiles'), false);
  assert.equal(text.includes('ExitWorktree'), false);
  assert.equal(text.includes('better-sqlite3'), false);
});
