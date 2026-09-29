#!/usr/bin/env node
/**
 * Lint step (QA-07). Runs every `<workspace>/lint/*.lint.mjs` and `lint/*.lint.mjs` under
 * `node --test`. Lint files hold the checks that read product source text: import bans,
 * wording checks and path hygiene. Behavioural tests under test/ do not read src/*.ts.
 * Lint needs no build and never starts a harness or opens a keychain.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain, workspaces } from './build.mjs';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

export function collectLintFiles(root = repoRoot) {
  const files = [];
  for (const dir of [...workspaces(root).map((workspace) => join(root, workspace, 'lint')), join(root, 'lint')]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith('.lint.mjs')) files.push(join(dir, name));
    }
  }
  return files;
}

function main() {
  const files = collectLintFiles();
  if (files.length === 0) {
    console.error('no lint files found');
    return 1;
  }
  const result = spawnSync(process.execPath, ['--test', ...files], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
    env: { ...process.env, JEVRIS_TEST: '1' },
  });
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}

if (isMain(import.meta.url)) process.exit(main());
