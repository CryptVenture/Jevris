#!/usr/bin/env node
/**
 * Coverage with per-package floors (QA-06).
 *
 *   npm run coverage            # build, run the suite with coverage, check the floors
 *   node scripts/coverage.mjs --no-build
 *
 * Runs scripts/test.mjs (same temp HOME, keyring block and harness stubs) with node's test
 * coverage, writes coverage/lcov.info and coverage/summary.json, and fails when a package's
 * line or branch coverage falls below its floor in coverage-floors.json. CI uploads the
 * coverage/ directory as an artifact.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './build.mjs';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** apps/<name> or packages/<name> for a covered file, or null for anything else. */
export function packageOf(file, root = repoRoot) {
  const rel = relative(root, file).split(sep).join('/');
  const match = /^(apps|packages)\/([^/]+)\/dist\//.exec(rel);
  return match === null ? null : `${match[1]}/${match[2]}`;
}

/** Sums LF/LH and BRF/BRH per package from an lcov report. */
export function summarize(lcov, root = repoRoot) {
  const totals = new Map();
  let current = null;
  for (const raw of lcov.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      const pkg = packageOf(line.slice(3), root);
      current = pkg === null ? null : totals.get(pkg) ?? { linesFound: 0, linesHit: 0, branchesFound: 0, branchesHit: 0 };
      if (pkg !== null) totals.set(pkg, current);
      continue;
    }
    if (current === null) continue;
    if (line === 'end_of_record') {
      current = null;
      continue;
    }
    const [key, value] = line.split(':');
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    if (key === 'LF') current.linesFound += n;
    else if (key === 'LH') current.linesHit += n;
    else if (key === 'BRF') current.branchesFound += n;
    else if (key === 'BRH') current.branchesHit += n;
  }
  const out = {};
  for (const pkg of [...totals.keys()].sort()) {
    const t = totals.get(pkg);
    out[pkg] = {
      lines: t.linesFound === 0 ? 100 : Math.floor((t.linesHit / t.linesFound) * 10000) / 100,
      branches: t.branchesFound === 0 ? 100 : Math.floor((t.branchesHit / t.branchesFound) * 10000) / 100,
    };
  }
  return out;
}

/** Floor findings: a package under its line or branch floor, or a floor with no coverage. */
export function checkFloors(summary, floors) {
  const failures = [];
  for (const [pkg, floor] of Object.entries(floors)) {
    const got = summary[pkg];
    if (got === undefined) {
      failures.push(`${pkg}: no coverage recorded`);
      continue;
    }
    if (got.lines < floor.lines) failures.push(`${pkg}: lines ${got.lines}% < floor ${floor.lines}%`);
    if (got.branches < floor.branches) failures.push(`${pkg}: branches ${got.branches}% < floor ${floor.branches}%`);
  }
  return failures;
}

function main(argv) {
  const outDir = join(repoRoot, 'coverage');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const lcovPath = join(outDir, 'lcov.info');
  const args = [join(repoRoot, 'scripts', 'test.mjs'), ...argv];
  const ran = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
    env: { ...process.env, JEVRIS_TEST_COVERAGE_LCOV: lcovPath },
  });
  if (ran.error !== undefined) throw ran.error;
  if (ran.status !== 0) {
    console.error('coverage: the test run failed');
    return ran.status ?? 1;
  }
  const summary = summarize(readFileSync(lcovPath, 'utf8'));
  writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  const floors = JSON.parse(readFileSync(join(repoRoot, 'coverage-floors.json'), 'utf8')).floors;
  console.log('coverage (lines / branches):');
  for (const [pkg, got] of Object.entries(summary)) {
    const floor = floors[pkg];
    const note = floor === undefined ? ' (no floor)' : ` (floor ${floor.lines} / ${floor.branches})`;
    console.log(`  ${pkg}: ${got.lines}% / ${got.branches}%${note}`);
  }
  const failures = checkFloors(summary, floors);
  for (const failure of failures) console.error(`coverage floor: ${failure}`);
  return failures.length === 0 ? 0 : 1;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
