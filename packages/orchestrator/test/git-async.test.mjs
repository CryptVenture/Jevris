// git never holds the sidecar's event loop (A's triage, 2026-09-27). With a git that stays busy
// until the test releases it, a PreCompact hook's capsule write waits on git while another
// sidecar request is answered, and the release itself can only happen because the loop is free.
// A git blocking the loop (spawnSync) could never be released, so the test would see the hook
// already settled before the concurrent request ran. A git past its timeout is killed.
// Offline: the stand-in git is node running a script; the real git only sets up the repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleHookEvent, nodeGit, openWorkspace, setSubscriberGit, sidecarOps, snapshotRevision } from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

/** A stand-in git: marks that it started, waits for the release file, then answers a clean status. */
const STUB = `
const { existsSync, writeFileSync } = require('node:fs');
const [started, release] = [process.env.STUB_STARTED, process.env.STUB_RELEASE];
writeFileSync(started, 'x');
const until = Date.now() + 20000;
const tick = () => {
  if (existsSync(release) || Date.now() > until) {
    if (process.argv.includes('status')) process.stdout.write('# branch.oid abc123\\0# branch.head main\\0');
    process.exit(0);
  }
  setTimeout(tick, 20);
};
tick();
`;

function fixture() {
  const dir = tempDir('jv-git-async-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  const g = spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8' });
  assert.equal(g.status, 0, g.stderr);
  const stub = join(dir, 'slow-git.cjs');
  writeFileSync(stub, STUB);
  const started = join(dir, 'started');
  const release = join(dir, 'release');
  const git = (timeoutMs = 30_000) => nodeGit(timeoutMs, { STUB_STARTED: started, STUB_RELEASE: release }, { command: process.execPath, prefixArgs: [stub] });
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  const ctx = (op, body) => ({
    op, client: 'cli', scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'], workspace: { id: ws.workspaceId, root: ws.workspaceRoot }, body, home,
    signal: new AbortController().signal, deadline: { budgetMs: 30000, remainingMs: () => 30000, expired: () => false }, store, killSwitchStopped: false, engine: undefined, trace: () => {},
  });
  return {
    dir, repo, ws, ctx, git, started, release,
    done: () => {
      setSubscriberGit(undefined);
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function until(check) {
  for (let i = 0; i < 1000 && !check(); i += 1) await new Promise((r) => setTimeout(r, 20));
  return check();
}

test('a PreCompact capsule write waits on a busy git while another sidecar request is answered', async () => {
  const f = fixture();
  try {
    setSubscriberGit(f.git());
    let settled = false;
    const envelope = { schemaVersion: '1.0', harness: 'claude', nativeEventName: 'PreCompact', kind: 'context.compacting', sessionId: 's1', turnId: null, toolUseId: null, toolName: null, agentId: null, model: null, permissionMode: null, cwd: f.repo, trigger: 'auto', blocking: false, responseRequired: false, payload: {}, dedupKey: 'd' };
    const hook = handleHookEvent(f.ctx('event', { envelope, deliveryKey: 'pre-1' })).finally(() => {
      settled = true;
    });
    assert.ok(await until(() => existsSync(f.started)), 'git started');
    // Another request is served while git is still running.
    const other = await sidecarOps.find((o) => o.op === 'task.get').handle(f.ctx('task.get', { taskId: 'T1' }));
    assert.equal(other.ok, true, JSON.stringify(other));
    assert.equal(settled, false, 'the hook still waits on git');
    writeFileSync(f.release, 'go');
    const answer = await hook;
    assert.equal(answer.reasonCode, 'CAPSULE_WRITTEN', JSON.stringify(answer));
  } finally {
    f.done();
  }
});

test('snapshotRevision through the asynchronous git gives the status git answered', async () => {
  const f = fixture();
  try {
    writeFileSync(f.release, 'go');
    const snap = await snapshotRevision(f.repo, f.git());
    assert.deepEqual([snap.kind, snap.head, snap.branch, snap.dirty.length], ['git', 'abc123', 'main', 0]);
  } finally {
    f.done();
  }
});

test('a git past its timeout is killed and answers not ok; the call never rejects', async () => {
  const f = fixture();
  try {
    const result = await f.git(300).run(['status'], f.repo);
    assert.equal(result.ok, false);
    // A git that cannot start answers not ok too.
    const missing = await nodeGit(5_000, {}, { command: join(f.dir, 'no-such-git') }).run(['status'], f.repo);
    assert.equal(missing.ok, false);
  } finally {
    writeFileSync(f.release, 'go');
    f.done();
  }
});
