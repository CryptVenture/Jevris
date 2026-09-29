#!/usr/bin/env node
/**
 * Stability runs (QA-05): the hook and sidecar suites must pass 20 consecutive runs on every
 * CI matrix cell. Each run goes through scripts/test.mjs (temp HOME, stub harnesses, keyring
 * blocked), so it is the same environment as `npm test`.
 *
 *   node scripts/repeat-tests.mjs                                  # 20 runs of apps/hook and apps/sidecar
 *   node scripts/repeat-tests.mjs --runs 5 test/qa --report stability.json
 *
 * Run `npm run build` first. Exit 0 only when every run passed; the report names each failed run.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './build.mjs';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
export const DEFAULT_TARGETS = ['apps/hook/test', 'apps/sidecar/test'];

export function parseArgs(argv) {
  const options = { runs: 20, report: undefined, targets: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--runs') options.runs = Number(argv[++i]);
    else if (arg === '--report') options.report = argv[++i];
    else if (arg.startsWith('--')) throw new Error(`unknown argument: ${arg}`);
    else options.targets.push(arg);
  }
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 500) throw new Error('--runs must be 1..500');
  if (options.targets.length === 0) options.targets = [...DEFAULT_TARGETS];
  return options;
}

/** Test files under the targets: a directory contributes its *.test.mjs files. */
export function expandTargets(targets, root = repoRoot) {
  const files = [];
  for (const target of targets) {
    const full = join(root, target);
    if (!existsSync(full)) throw new Error(`no such test target: ${target}`);
    if (statSync(full).isDirectory()) {
      for (const name of readdirSync(full).sort()) if (name.endsWith('.test.mjs')) files.push(relative(root, join(full, name)));
    } else files.push(relative(root, full));
  }
  return files;
}

function main(argv) {
  const options = parseArgs(argv);
  const files = expandTargets(options.targets);
  const runs = [];
  for (let run = 1; run <= options.runs; run += 1) {
    const started = Date.now();
    const result = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'test.mjs'), '--no-build', ...files], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      maxBuffer: 256 * 1024 * 1024,
    });
    const ok = result.status === 0;
    const failed = ok ? [] : [...(result.stdout ?? '').matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1]).filter((name) => name !== 'failing tests:');
    runs.push({ run, ok, ms: Date.now() - started, failed: [...new Set(failed)].slice(0, 20) });
    console.log(`${ok ? 'ok  ' : 'FAIL'} run ${run}/${options.runs} (${Date.now() - started} ms)${ok ? '' : `: ${[...new Set(failed)].slice(0, 3).join('; ')}`}`);
  }
  const passed = runs.filter((r) => r.ok).length;
  const report = { schemaVersion: 1, kind: 'stability', platform: process.platform, node: process.version, files, runs: options.runs, passed, at: new Date().toISOString(), details: runs };
  if (options.report !== undefined) {
    mkdirSync(dirname(options.report), { recursive: true });
    writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(`stability: ${passed}/${options.runs} consecutive runs passed on ${process.platform} ${process.version}`);
  return passed === options.runs ? 0 : 1;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
