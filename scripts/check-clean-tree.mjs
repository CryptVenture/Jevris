#!/usr/bin/env node
/**
 * The build leaves the checkout unchanged (BLD-10). Run after `npm run build`. It fails when a
 * tracked file changed or a new file appeared that .gitignore does not cover. Either means a
 * generated file was committed stale, or the build writes somewhere it should not. It prints
 * each path with the command that regenerates it, so the fix is to run that command and commit
 * the result.
 *
 *   npm run build && npm run check:clean
 *
 * Exit 0 clean; 1 the build changed the checkout; 2 not a git checkout.
 * The CI test cells and scripts/ci-cell.mjs run it right after the build.
 */
import { spawnSync } from 'node:child_process';
import { isMain } from './build.mjs';

/** The command that regenerates a generated path, or null for a path nothing generates. */
export function regenerationCommand(path) {
  if (/^plugins\/(shared\/(mcp|shim)\.js|claude\/hooks\/hooks\.json)$/.test(path)) return 'npm run build (scripts/emit-hook.mjs regenerates the plugin files)';
  if (path === 'docs/cli.md' || path === 'docs/platform-support.md') return 'npm run docs';
  if (path.startsWith('assets/schemas/') || path.startsWith('assets/evaluation/')) return 'npm run assets:sync';
  return null;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, windowsHide: true });
  return { code: result.status ?? 1, stdout: result.stdout ?? '' };
}

/** What differs from HEAD: tracked files changed or removed, and new files not ignored. */
export function changedPaths(cwd) {
  const inside = git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return null;
  const split = (text) => text.split('\0').filter((name) => name.length > 0);
  const modified = split(git(cwd, ['diff', 'HEAD', '--name-only', '-z']).stdout);
  const untracked = split(git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']).stdout);
  return { modified, untracked };
}

/** The failure text for a dirty checkout, or null when it is clean. */
export function report(changed) {
  if (changed.modified.length === 0 && changed.untracked.length === 0) return null;
  const lines = ['The build changed the checkout. Regenerate these files and commit them, or stop the build from writing them:'];
  for (const path of changed.modified) lines.push(`  changed: ${path}${regenerationCommand(path) === null ? '' : `  (regenerate: ${regenerationCommand(path)})`}`);
  for (const path of changed.untracked) lines.push(`  new, not ignored: ${path}`);
  lines.push('Then check with: npm run build && npm run check:clean');
  return lines.join('\n');
}

function main() {
  const changed = changedPaths(process.cwd());
  if (changed === null) {
    console.error('check:clean: not a git checkout, so there is nothing to compare the build with');
    return 2;
  }
  const text = report(changed);
  if (text === null) {
    console.log('check:clean: the build left the checkout unchanged');
    return 0;
  }
  console.error(text);
  const diff = git(process.cwd(), ['diff', 'HEAD', '--stat']);
  if (diff.stdout.trim() !== '') console.error(diff.stdout.trimEnd());
  return 1;
}

if (isMain(import.meta.url)) process.exit(main());
