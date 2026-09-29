#!/usr/bin/env node
/**
 * Commits only the declared paths, safely, while other domains commit in the same checkout.
 *
 *   node scripts/safe-commit.mjs -F <message-file> [--check] -- <path> [<path> ...]
 *   node scripts/safe-commit.mjs -m "<message>" [--check] -- <path> [<path> ...]
 *
 * - The tree is built in a private index from a pinned base commit (HEAD when the script starts),
 *   never from the shared index, which may hold another domain's staged work.
 * - Each declared path is taken as it is in the working tree (added, modified or deleted). The
 *   commit is refused when the tree would differ from the base in any other path.
 * - `--check` compiles the exact tree (`tsc -b` in a scratch copy, sharing node_modules), so the
 *   commit builds against its parent alone.
 * - The branch moves with a compare-and-swap (`git update-ref <branch> <new> <base>`). If anyone
 *   committed after the base was pinned, nothing is written and the script exits 3: run it again.
 *   A plain `git commit` after a slow check would parent the stale tree on the newer commit and
 *   silently revert it.
 * - Afterwards the shared index is brought in step for the declared paths only.
 *
 * Works on macOS, Linux and Windows (no shell, no symlink privileges needed: junctions on Windows).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

function fail(message, code = 1) {
  process.stderr.write(`safe-commit: ${message}\n`);
  process.exit(code);
}

function git(args, { env, input, cwd, allowFail = false } = {}) {
  const out = spawnSync('git', args, { cwd: cwd ?? repo, env: env ?? process.env, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (out.status !== 0 && !allowFail) fail(`git ${args.join(' ')} failed: ${(out.stderr ?? '').trim()}`);
  return { code: out.status ?? 1, stdout: (out.stdout ?? '').trim(), stderr: (out.stderr ?? '').trim() };
}

function parseArgs(argv) {
  const out = { message: null, messageFile: null, check: false, paths: [] };
  let i = 0;
  for (; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      i += 1;
      break;
    }
    if (arg === '-F') out.messageFile = argv[(i += 1)] ?? fail('-F needs a file');
    else if (arg === '-m') out.message = argv[(i += 1)] ?? fail('-m needs a message');
    else if (arg === '--check') out.check = true;
    else fail(`unknown option ${arg}; paths go after --`);
  }
  out.paths = argv.slice(i).map((p) => p.replace(/\\/g, '/').replace(/^\.\//, ''));
  if (out.paths.length === 0) fail('no paths declared (put them after --)');
  if ((out.message === null) === (out.messageFile === null)) fail('give exactly one of -m and -F');
  return out;
}

/** Compiles the tree in a scratch copy that shares the checkout's node_modules. */
function checkTree(tree) {
  const dir = mkdtempSync(join(tmpdir(), 'safe-commit-'));
  try {
    const archive = spawnSync('git', ['archive', '--format=tar', tree], { cwd: repo, maxBuffer: 1024 * 1024 * 1024 });
    if (archive.status !== 0) fail('git archive failed');
    const untar = spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout, maxBuffer: 1024 * 1024 * 1024 });
    if (untar.status !== 0) fail('tar -x failed');
    const link = (target, path) => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
    const nm = join(dir, 'node_modules');
    mkdirSync(join(nm, '@jevris'), { recursive: true });
    for (const name of readdirSync(join(repo, 'node_modules'))) {
      if (name === '@jevris') continue;
      link(join(repo, 'node_modules', name), join(nm, name));
    }
    // Workspace packages point at the scratch copy's own sources.
    for (const name of readdirSync(join(repo, 'node_modules', '@jevris'))) {
      const rel = relative(realpathSync(repo), realpathSync(join(repo, 'node_modules', '@jevris', name)));
      const target = join(dir, rel);
      if (existsSync(target)) link(target, join(nm, '@jevris', name));
    }
    const tsc = join(repo, 'node_modules', 'typescript', 'bin', 'tsc');
    const built = spawnSync(process.execPath, [tsc, '-b'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (built.status !== 0) fail(`the tree does not compile; nothing committed\n${(built.stdout ?? '').slice(-4000)}`);
    process.stdout.write('safe-commit: the tree compiles\n');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

const repo = git(['rev-parse', '--show-toplevel'], { cwd: process.cwd() }).stdout;
const args = parseArgs(process.argv.slice(2));
const branchRef = git(['symbolic-ref', 'HEAD']).stdout;
const base = git(['rev-parse', 'HEAD']).stdout;
const scratch = mkdtempSync(join(tmpdir(), 'safe-commit-index-'));
const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') };
try {
  git(['read-tree', base], { env });
  for (const path of args.paths) {
    if (existsSync(resolve(repo, path))) git(['update-index', '--add', '--', path], { env });
    else git(['update-index', '--force-remove', '--', path], { env });
  }
  const tree = git(['write-tree'], { env }).stdout;
  const changed = git(['diff-tree', '-r', '--name-only', base, tree]).stdout.split('\n').filter(Boolean);
  if (changed.length === 0) fail('nothing to commit in the declared paths');
  const declared = new Set(args.paths);
  const stray = changed.filter((path) => !declared.has(path));
  if (stray.length > 0) fail(`the tree would change undeclared paths: ${stray.join(', ')}`);
  if (args.check) checkTree(tree);
  let messageFile = args.messageFile;
  if (messageFile === null) {
    messageFile = join(scratch, 'message');
    writeFileSync(messageFile, `${args.message}\n`);
  }
  const commit = git(['commit-tree', tree, '-p', base, '-F', resolve(messageFile)]).stdout;
  const moved = git(['update-ref', branchRef, commit, base], { allowFail: true });
  if (moved.code !== 0) fail(`${branchRef} moved since ${base.slice(0, 7)}; nothing committed. Run again.`, 3);
  // The shared index follows the declared paths only; anything else staged there stays as it was.
  for (const path of args.paths) {
    if (existsSync(resolve(repo, path))) git(['update-index', '--add', '--', path], { allowFail: true });
    else git(['update-index', '--force-remove', '--', path], { allowFail: true });
  }
  process.stdout.write(`${git(['log', '--oneline', '-1', commit]).stdout}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
