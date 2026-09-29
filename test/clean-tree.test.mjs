import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = join(root, 'scripts', 'check-clean-tree.mjs');
const { changedPaths, regenerationCommand, report } = await import('../scripts/check-clean-tree.mjs');
const { dockerScript } = await import('../scripts/ci-cell.mjs');

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-clean-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'plugins', 'shared'), { recursive: true });
  writeFileSync(join(dir, 'plugins', 'shared', 'mcp.js'), 'v1\n');
  writeFileSync(join(dir, '.gitignore'), 'dist/\n');
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

const check = (cwd) => spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });

test('check:clean passes a checkout the build left unchanged, ignored outputs included (BLD-10)', (t) => {
  const dir = repo(t);
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist', 'out.js'), 'built\n');
  assert.deepEqual(changedPaths(dir), { modified: [], untracked: [] });
  const out = check(dir);
  assert.equal(out.status, 0, out.stderr);
});

test('check:clean fails a rewritten generated file and a new unignored output, naming the regeneration command (BLD-10)', (t) => {
  const dir = repo(t);
  writeFileSync(join(dir, 'plugins', 'shared', 'mcp.js'), 'v2\n');
  writeFileSync(join(dir, 'stray.log'), 'x\n');
  assert.deepEqual(changedPaths(dir), { modified: ['plugins/shared/mcp.js'], untracked: ['stray.log'] });
  const out = check(dir);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /changed: plugins\/shared\/mcp\.js {2}\(regenerate: npm run build/);
  assert.match(out.stderr, /new, not ignored: stray\.log/);
  assert.match(out.stderr, /npm run build && npm run check:clean/);
});

test('check:clean refuses outside a git checkout, and ci-cell commits its copy first so the check can run (BLD-10)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-clean-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(changedPaths(dir), null);
  assert.equal(check(dir).status, 2);
  const docker = dockerScript(['ci', 'build', 'clean']);
  assert.ok(docker.indexOf('git init -q') < docker.indexOf('npm run check:clean'));
  assert.match(docker, /git -c user\.name=ci-cell .* commit -q -m baseline/);
});

test('regeneration commands name the generator for each generated file', () => {
  assert.match(regenerationCommand('plugins/claude/hooks/hooks.json'), /^npm run build/);
  assert.equal(regenerationCommand('docs/cli.md'), 'npm run docs');
  assert.equal(regenerationCommand('assets/evaluation/cost-registry.json'), 'npm run assets:sync');
  assert.equal(regenerationCommand('apps/cli/src/cli.ts'), null);
  assert.equal(report({ modified: [], untracked: [] }), null);
});
