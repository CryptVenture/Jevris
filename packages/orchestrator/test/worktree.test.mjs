import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorktree,
  enforceAllowedPaths,
  getWorktree,
  gitVersionOk,
  openWorkspace,
  parseGitVersion,
  recoverCrashedWorktrees,
  removeWorktree,
  worktreeStatus,
  worktreesRoot,
} from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function fixture() {
  const dir = tempDir('jv-wt-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo with space');
  mkdirSync(home);
  mkdirSync(join(repo, 'mod'), { recursive: true });
  writeFileSync(join(repo, 'mod', 'a.txt'), 'a\n');
  writeFileSync(join(repo, 'other.txt'), 'o\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  return { ws, repo, done: () => {
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    } };
}

test('git version floor is 2.38 (ORC-04)', async () => {
  assert.deepEqual(parseGitVersion('git version 2.39.3 (Apple Git-146)'), [2, 39, 3]);
  const fake = (v) => ({ run: () => ({ ok: true, stdout: `git version ${v}\n` }) });
  assert.equal((await gitVersionOk(fake('2.37.9'), '.')).ok, false);
  assert.equal((await gitVersionOk(fake('2.38.0'), '.')).ok, true);
  assert.equal((await gitVersionOk(fake('3.0.0'), '.')).ok, true);
});

test('a worktree is created from a base commit under the data dir with port and cache resource keys (ORC-04)', async () => {
  const f = fixture();
  try {
    const base = git(f.repo, 'rev-parse', 'HEAD');
    const r = await createWorktree(f.ws, { taskId: 'T1', baseCommit: base, allowedPaths: ['mod'] });
    assert.equal(r.ok, true, JSON.stringify(r));
    const wt = r.worktree;
    assert.ok(wt.path.startsWith(worktreesRoot(f.ws)));
    assert.equal(wt.baseCommit, base);
    assert.ok(existsSync(join(wt.path, 'mod', 'a.txt')));
    assert.ok(wt.resourceKeys.some((k) => k.startsWith('port:')));
    assert.ok(wt.resourceKeys.some((k) => k.startsWith('depcache:')));
    const second = await createWorktree(f.ws, { taskId: 'T2', allowedPaths: ['mod'] });
    assert.notEqual(second.worktree.port, wt.port);
    assert.equal((await createWorktree(f.ws, { taskId: 'T3', baseCommit: 'f'.repeat(40), allowedPaths: [] })).reasonCode, 'BAD_BASE');
    assert.equal((await createWorktree(f.ws, { taskId: '../x', allowedPaths: [] })).reasonCode, 'INVALID_TASK');
  } finally {
    f.done();
  }
});

test('allowed paths are enforced from the real diff, including commits and untracked files (ORC-04)', async () => {
  const f = fixture();
  try {
    const { worktree } = await createWorktree(f.ws, { taskId: 'T1', allowedPaths: ['mod'] });
    writeFileSync(join(worktree.path, 'mod', 'a.txt'), 'changed\n');
    assert.deepEqual((await enforceAllowedPaths(worktree)).violations, []);
    writeFileSync(join(worktree.path, 'other.txt'), 'sneaky\n');
    writeFileSync(join(worktree.path, 'new-file.txt'), 'x\n');
    const report = (await enforceAllowedPaths(worktree));
    assert.equal(report.ok, false);
    assert.deepEqual(report.violations, ['new-file.txt', 'other.txt']);
    git(worktree.path, 'add', '.');
    git(worktree.path, 'commit', '-q', '-m', 'w');
    assert.deepEqual((await enforceAllowedPaths(worktree)).violations, ['new-file.txt', 'other.txt']);
  } finally {
    f.done();
  }
});

test('a dirty or unknown tree is never removed; a clean owned tree needs confirmation (ORC-04, ORC-06)', async () => {
  const f = fixture();
  try {
    const { worktree } = await createWorktree(f.ws, { taskId: 'T1', allowedPaths: ['mod'] });
    assert.equal((await removeWorktree(f.ws, worktree.id, false)).reasonCode, 'NEEDS_CONFIRMATION');
    writeFileSync(join(worktree.path, 'mod', 'a.txt'), 'wip\n');
    assert.equal((await worktreeStatus(worktree)), 'dirty');
    assert.equal((await removeWorktree(f.ws, worktree.id, true)).reasonCode, 'DIRTY');
    assert.ok(existsSync(join(worktree.path, 'mod', 'a.txt')));
    const broken = { ...worktree, path: join(worktree.path, 'missing') };
    assert.equal((await worktreeStatus(broken)), 'unknown');
    const clean = (await createWorktree(f.ws, { taskId: 'T2', allowedPaths: [] })).worktree;
    assert.deepEqual(await removeWorktree(f.ws, clean.id, true), { removed: true });
    assert.equal(existsSync(clean.path), false);
    assert.equal(getWorktree(f.ws, clean.id).state, 'removed');
  } finally {
    f.done();
  }
});

test('the crash registry persists: a tree whose owner died is recorded as crashed, not deleted (ORC-04)', async () => {
  const f = fixture();
  try {
    const { worktree } = await createWorktree(f.ws, { taskId: 'T1', allowedPaths: [] });
    // A fresh workspace handle (as after a restart) still sees the registry.
    assert.deepEqual(await recoverCrashedWorktrees(f.ws, () => 'alive'), []);
    assert.deepEqual(await recoverCrashedWorktrees(f.ws, () => 'dead'), [worktree.id]);
    assert.equal(getWorktree(f.ws, worktree.id).state, 'crashed');
    assert.ok(existsSync(worktree.path));
  } finally {
    f.done();
  }
});
