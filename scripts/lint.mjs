#!/usr/bin/env node
/**
 * Lint step (QA-07). Runs every `<workspace>/lint/*.lint.mjs` and `lint/*.lint.mjs` under
 * `node --test`. Lint files hold the checks that read product source text: import bans,
 * wording checks and path hygiene. Behavioural tests under test/ do not read src/*.ts.
 * Lint needs no build and never starts a harness or opens a keychain.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain, workspaces } from './build.mjs';
import { runTestFiles } from './test.mjs';

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
  // One node --test over every lint file, or batches of them when that command line would be too
  // long for Windows (scripts/argv-batches.mjs); the files and the environment are the same.
  const runTemp = mkdtempSync(join(tmpdir(), 'jl-'));
  try {
    const budget = process.env.JEVRIS_TEST_ARGV_BUDGET;
    return runTestFiles({
      parallel: files,
      spawnOptions: { cwd: repoRoot, stdio: 'inherit', shell: false, windowsHide: true, env: { ...process.env, JEVRIS_TEST: '1', JEVRIS_TEST_ARGV_BUDGET: undefined } },
      runTemp,
      processEnv: typeof budget === 'string' ? { JEVRIS_TEST_ARGV_BUDGET: budget } : {},
      base: ['--test'],
    }).code;
  } finally {
    rmSync(runTemp, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (isMain(import.meta.url)) process.exit(main());
