#!/usr/bin/env node
/**
 * Cross-platform build. Runs the same way under cmd.exe, PowerShell, bash and zsh:
 * no shell is involved, every child is process.execPath with an argument array.
 *
 * 1. tsc -b over the workspace references.
 * 2. Remove stale dist/*.test.js copies left by the old shell build, so an orphan can never run.
 * 3. Emit the generated plugin sources (scripts/emit-hook.mjs). Harness plugin trees are
 *    rendered at install into the target home, never into the repository or dist/ (DRY).
 * 4. Bundle the runtime entry points into dist/ (scripts/bundle.mjs, PKG-06).
 *
 * It runs holding the suite lock (scripts/suite-lock.mjs), so it waits for a running suite.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..');

export function tscPath(root = repoRoot) {
  const require = createRequire(join(root, 'package.json'));
  return join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
}

export function workspaces(root = repoRoot) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return Array.isArray(pkg.workspaces) ? pkg.workspaces.filter((entry) => typeof entry === 'string') : [];
}

export function removeOrphanTests(root = repoRoot) {
  const removed = [];
  for (const workspace of workspaces(root)) {
    const dist = join(root, workspace, 'dist');
    if (!existsSync(dist)) continue;
    for (const name of readdirSync(dist)) {
      if (!name.endsWith('.test.js') && !name.endsWith('.test.d.ts')) continue;
      const full = join(dist, name);
      rmSync(full, { force: true });
      removed.push(full);
    }
  }
  return removed;
}

export function runNode(args, options = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}

function main() {
  const steps = [
    [tscPath(), '-b'],
    null,
    [join(repoRoot, 'scripts', 'emit-hook.mjs')],
    [join(repoRoot, 'scripts', 'bundle.mjs')],
  ];
  for (const step of steps) {
    if (step === null) {
      removeOrphanTests();
      continue;
    }
    const code = runNode(step);
    if (code !== 0) process.exit(code);
  }
}

export function isMain(moduleUrl) {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry.length === 0) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entry);
  } catch {
    return false;
  }
}

// Holding the suite lock, so a running suite never sees dist/ rewritten under it.
if (isMain(import.meta.url)) {
  const { runLocked } = await import('./suite-lock.mjs');
  process.exit(await runLocked(repoRoot, () => {
    main();
    return 0;
  }));
}
