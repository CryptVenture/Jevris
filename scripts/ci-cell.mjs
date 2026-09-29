#!/usr/bin/env node
/**
 * Reproduces one CI matrix cell locally (BLD-10).
 *
 *   node scripts/ci-cell.mjs                      # host OS, this node, a clean copy of HEAD
 *   node scripts/ci-cell.mjs --docker --node 22.14.0   # linux cell in node:22.14.0
 *   node scripts/ci-cell.mjs --docker --node 24 --steps build,test
 *   node scripts/ci-cell.mjs --docker --working-tree   # uncommitted changes too
 *   node scripts/ci-cell.mjs --docker --node 24 --steps ci,build,smoke   # the full pack smoke on Linux
 *
 * The cell runs on a clean `git archive HEAD` copy, never on this checkout, so it sees
 * exactly what CI checks out. Docker cells run as the image's unprivileged `node` user,
 * like the GitHub runner user, because root would bypass the permission checks the tests
 * make. The live-harness smoke is never run and no secret is passed in.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './build.mjs';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** The CI job steps, in order. .github/workflows/ci.yml runs the same npm scripts. */
export const CELL_STEPS = [
  { id: 'ci', npm: ['ci'] },
  { id: 'build', npm: ['run', 'build'] },
  { id: 'clean', npm: ['run', 'check:clean'] },
  { id: 'lint', npm: ['run', 'lint'] },
  { id: 'test', npm: ['test'] },
  { id: 'pack', npm: ['run', 'check:pack'] },
  { id: 'signatures', npm: ['audit', 'signatures'] },
];

/**
 * Steps a cell runs only when named with --steps: the CI pack-smoke job's full installed
 * end-to-end run, so a Linux container can rehearse it (RLS-04).
 */
export const EXTRA_STEPS = [{ id: 'smoke', npm: ['run', 'smoke:pack', '--', '--full', '--npx', '--no-build'] }];

export function parseArgs(argv) {
  const options = { docker: false, workingTree: false, node: undefined, steps: CELL_STEPS.map((step) => step.id), keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--docker') options.docker = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--working-tree') options.workingTree = true;
    else if (arg === '--node') options.node = argv[++i];
    else if (arg === '--steps') options.steps = String(argv[++i] ?? '').split(',').filter((id) => id.length > 0);
    else throw new Error(`unknown argument: ${arg}`);
  }
  const known = new Set([...CELL_STEPS, ...EXTRA_STEPS].map((step) => step.id));
  for (const id of options.steps) if (!known.has(id)) throw new Error(`unknown step: ${id}`);
  if (options.node !== undefined && !/^(\d+(\.\d+){0,2}|latest|current|lts)$/.test(options.node)) {
    throw new Error(`invalid node version: ${options.node}`);
  }
  return options;
}

export function dockerImage(node) {
  if (node === undefined || node === 'latest') return 'node:current';
  return `node:${node}`;
}

/** The shell script a docker cell runs. Only fixed npm commands; no interpolated input. */
/**
 * The cell's copy is not a git checkout (git archive), so it is committed as it arrives: the
 * clean step then compares the build's output with exactly the files the cell started from.
 */
const BASELINE_GIT = [
  ['init', '-q'],
  ['add', '-A'],
  ['-c', 'user.name=ci-cell', '-c', 'user.email=ci-cell@localhost.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'baseline'],
];
const BASELINE = BASELINE_GIT.map((args) => `git ${args.join(' ')}`).join(' && ');

export function dockerScript(stepIds) {
  const commands = stepIds.map((id) => {
    const step = [...CELL_STEPS, ...EXTRA_STEPS].find((entry) => entry.id === id);
    return `echo "::cell step ${id}" && npm ${step.npm.join(' ')}`;
  });
  return ['set -e', 'mkdir -p "$HOME/work"', 'tar -xf /cell/head.tar -C "$HOME/work"', 'cd "$HOME/work"', BASELINE, 'node --version', ...commands].join('\n');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false, windowsHide: true, ...options });
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}

function npmCli() {
  const nodeDir = dirname(process.execPath);
  for (const candidate of [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('npm-cli.js not found next to this node');
}

/**
 * --working-tree: the tracked and untracked (not ignored) files as they are now, for
 * checking a change before it is committed. The default stays a clean HEAD.
 */
function archiveWorkingTree(dest) {
  const tar = join(dest, 'head.tar');
  const listed = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: repoRoot, encoding: 'utf8' });
  if (listed.status !== 0) throw new Error('git ls-files failed');
  const files = listed.stdout.split('\0').filter((name) => name.length > 0 && existsSync(join(repoRoot, name)));
  const list = join(dest, 'files.txt');
  writeFileSync(list, `${files.join('\n')}\n`);
  const code = run('tar', ['-cf', tar, '-C', repoRoot, '-T', list]);
  if (code !== 0) throw new Error('tar failed');
  return tar;
}

function archiveHead(dest) {
  const tar = join(dest, 'head.tar');
  const code = run('git', ['archive', '--format=tar', '-o', tar, 'HEAD'], { cwd: repoRoot });
  if (code !== 0) throw new Error('git archive failed');
  return tar;
}

function main(argv) {
  const options = parseArgs(argv);
  // A suite-owned scratch root, named outside the jevris* and jv-* test-leak patterns, so a
  // concurrent test run never mistakes a cell for one of its own leftovers.
  const scratch = mkdtempSync(join(tmpdir(), 'jc-cell-'));
  try {
    const tar = options.workingTree ? archiveWorkingTree(scratch) : archiveHead(scratch);
    if (options.docker) {
      const image = dockerImage(options.node);
      console.log(`cell: linux ${image} steps=${options.steps.join(',')}`);
      // --init gives the container a reaping PID 1, as a runner VM has; without it a killed
      // grandchild stays a zombie and the process-tree tests read it as alive.
      return run('docker', [
        'run', '--rm', '--init', '--user', 'node', '-e', 'HOME=/home/node', '-e', 'CI=true',
        '-v', `${scratch}:/cell:ro`, image, 'bash', '-c', dockerScript(options.steps),
      ]);
    }
    if (options.node !== undefined && !process.version.startsWith(`v${options.node}`)) {
      console.error(`this is node ${process.version}; run this script with the node you want, or use --docker`);
      return 2;
    }
    const work = join(scratch, 'work');
    run(process.execPath, ['-e', 'require("fs").mkdirSync(process.argv[1])', work]);
    if (run('tar', ['-xf', tar, '-C', work]) !== 0) throw new Error('tar failed');
    for (const args of BASELINE_GIT) if (run('git', args, { cwd: work }) !== 0) throw new Error('the baseline commit failed');
    console.log(`cell: ${process.platform} node ${process.version} steps=${options.steps.join(',')}`);
    const npm = npmCli();
    for (const id of options.steps) {
      const step = [...CELL_STEPS, ...EXTRA_STEPS].find((entry) => entry.id === id);
      console.log(`::cell step ${id}`);
      const code = run(process.execPath, [npm, ...step.npm], { cwd: work, env: { ...process.env, CI: 'true' } });
      if (code !== 0) return code;
    }
    return 0;
  } finally {
    if (!options.keep) rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
    else console.log(`kept ${scratch}`);
  }
}

/**
 * A Docker cell, or a host cell that runs the suite or the pack smoke, is a full suite: it
 * takes the machine-wide host suite lock (scripts/suite-lock.mjs), so cells and suites from any
 * clone on this machine run one at a time.
 */
export function needsHostLock(options) {
  return options.docker || options.steps.includes('test') || options.steps.includes('smoke');
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  let heavy = false;
  try {
    heavy = needsHostLock(parseArgs(argv));
  } catch {
    // main reports the usage error
  }
  if (heavy) {
    const { runHostLocked } = await import('./suite-lock.mjs');
    process.exit(await runHostLocked(() => main(argv)));
  }
  process.exit(main(argv));
}
