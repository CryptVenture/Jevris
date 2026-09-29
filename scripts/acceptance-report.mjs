#!/usr/bin/env node
/**
 * Story and workflow acceptance reports (RLS-02, RLS-03). Runs test/acceptance under the test
 * runner (temporary HOME, stub harness binaries, keychain blocked), collects the record each
 * story, workflow and pending entry writes, and emits two jevris.evidence/1 records that
 * `jevris gates` reads:
 *
 *   <out>/story-report.json      every US01..US40: passed, Then-clause count, failures
 *   <out>/workflow-report.json   every W01..W12: passed, hashes of the product outputs it checked
 *   <out>/runtime-gate-report.json  the named tests of the run-time gates (release-gates.ts
 *                                   RUNTIME_GATE_TESTS: §18.5 learning, §22.2 economics in use),
 *                                   each passed or not in this run; a missing or skipped one fails
 *
 * A story or workflow with no record (no test file) is reported as failed, never skipped.
 *
 *   node scripts/acceptance-report.mjs --out release-evidence [--commit <sha>] [--no-build] [--strict]
 *
 * Exit 0 when the reports were written (and, with --strict, every entry passed); 1 otherwise.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMain } from './build.mjs';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
export const WORKFLOW_IDS = Array.from({ length: 12 }, (_, i) => `W${String(i + 1).padStart(2, '0')}`);

export function storyIds(root = repoRoot) {
  return JSON.parse(readFileSync(join(root, 'fixtures', 'ssot', 'user-stories.json'), 'utf8')).map((item) => item.id);
}

/** Reads every record the acceptance run wrote: id -> record. */
export function readRecords(dir) {
  const records = new Map();
  if (!existsSync(dir)) return records;
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const record = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    if (typeof record.id === 'string') records.set(record.id, record);
  }
  return records;
}

/** The story-report payload: one row per story, missing ones failed. */
export function storyPayload(records, ids) {
  return {
    stories: ids.map((id) => {
      const record = records.get(id);
      if (record === undefined) return { id, passed: false, thenClauses: 0, failures: ['no acceptance test'] };
      return { id, passed: record.passed === true, thenClauses: Number(record.thenClauses) || 0, failures: (record.failures ?? []).map((item) => String(item).slice(0, 500)).slice(0, 64) };
    }),
  };
}

/** The workflow-report payload: one row per workflow, with the output hashes it recorded. */
export function workflowPayload(records, ids = WORKFLOW_IDS) {
  return {
    workflows: ids.map((id) => {
      const record = records.get(id);
      if (record === undefined) return { id, passed: false, evidence: [] };
      return { id, passed: record.passed === true, evidence: (record.evidence ?? []).filter((item) => /^sha256:[0-9a-f]{64}$/.test(item)).slice(0, 64) };
    }),
  };
}

/**
 * The runtime-gate-report payload: every required test with whether this run passed it. `rows`
 * are the reporter's lines (scripts/test-events-reporter.mjs); a test with no passing row fails.
 */
export function runtimeGatePayload(rows, required, root = repoRoot) {
  const rel = (file) => {
    if (typeof file !== 'string') return null;
    const path = file.startsWith('file:') ? fileURLToPath(file) : file;
    return relative(root, path).split(sep).join('/');
  };
  const seen = rows.map((row) => ({ file: rel(row.file), name: row.name, passed: row.passed === true }));
  return {
    tests: required.map((test) => ({
      gate: test.gate,
      file: test.file,
      name: test.name,
      passed: seen.some((row) => row.file === test.file && row.name === test.name && row.passed),
    })),
  };
}

/** Runs the files of the required run-time gate tests under the test runner and reads each result. */
function runtimeGateRun(root, env, required) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-runtime-gates-'));
  try {
    const events = join(dir, 'events.jsonl');
    const files = [...new Set(required.map((test) => test.file))].map((file) => join(root, ...file.split('/')));
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'test.mjs'), '--no-build', ...files], { cwd: root, env: { ...env, JEVRIS_TEST_EVENTS: events }, stdio: 'inherit', shell: false, windowsHide: true });
    const text = existsSync(events) ? readFileSync(events, 'utf8') : '';
    const rows = text.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
    return { rows, status: result.status ?? 1 };
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

function acceptanceFiles(root) {
  const dir = join(root, 'test', 'acceptance');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => join(dir, name));
}

function gitCommit(root) {
  const out = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', shell: false });
  const sha = (out.stdout ?? '').trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

export async function acceptanceReport({ root = repoRoot, out, commit, build = true, env = process.env } = {}) {
  const recordsDir = mkdtempSync(join(tmpdir(), 'jevris-acceptance-'));
  try {
    const files = acceptanceFiles(root);
    let status = 0;
    if (files.length > 0) {
      const args = [join(root, 'scripts', 'test.mjs'), ...(build ? [] : ['--no-build']), ...files];
      const result = spawnSync(process.execPath, args, { cwd: root, env: { ...env, JEVRIS_ACCEPTANCE_OUT: recordsDir }, stdio: 'inherit', shell: false, windowsHide: true });
      status = result.status ?? 1;
    }
    const records = readRecords(recordsDir);
    const contracts = await import(pathToFileURL(join(root, 'packages', 'contracts', 'dist', 'index.js')).href);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const producedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const common = { producedAt, version: pkg.version, commit: commit ?? gitCommit(root), tool: 'acceptance-report', os: process.platform, arch: process.arch, node: process.version };
    const stories = contracts.releaseEvidence({ ...common, kind: 'story-report', id: `story-report-${process.platform}`, payload: storyPayload(records, storyIds(root)) });
    const workflows = contracts.releaseEvidence({ ...common, kind: 'workflow-report', id: `workflow-report-${process.platform}`, payload: workflowPayload(records) });
    const { RUNTIME_GATE_TESTS } = await import(pathToFileURL(join(root, 'apps', 'cli', 'dist', 'gate-records.js')).href);
    const runtime = runtimeGateRun(root, env, RUNTIME_GATE_TESTS);
    const runtimeGates = contracts.releaseEvidence({ ...common, kind: 'runtime-gate-report', id: `runtime-gate-report-${process.platform}`, payload: runtimeGatePayload(runtime.rows, RUNTIME_GATE_TESTS, root) });
    for (const record of [stories, workflows, runtimeGates]) {
      const checked = contracts.ReleaseEvidenceContract.validate(record);
      if (!checked.ok) throw new Error(`acceptance-report: ${record.kind} is not valid evidence: ${JSON.stringify(checked.issues ?? checked).slice(0, 400)}`);
    }
    if (out !== undefined) {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'story-report.json'), `${JSON.stringify(stories, null, 2)}\n`);
      writeFileSync(join(out, 'workflow-report.json'), `${JSON.stringify(workflows, null, 2)}\n`);
      writeFileSync(join(out, 'runtime-gate-report.json'), `${JSON.stringify(runtimeGates, null, 2)}\n`);
    }
    return { stories, workflows, runtimeGates, testStatus: status, runtimeStatus: runtime.status };
  } finally {
    rmSync(recordsDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function main(argv) {
  const value = (flag) => {
    const at = argv.indexOf(flag);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const out = value('--out') ?? join(repoRoot, 'release-evidence');
  const { stories, workflows, runtimeGates } = await acceptanceReport({ out, commit: value('--commit'), build: !argv.includes('--no-build') });
  const failedRuntime = runtimeGates.payload.tests.filter((row) => !row.passed);
  const failedStories = stories.payload.stories.filter((row) => !row.passed);
  const failedFlows = workflows.payload.workflows.filter((row) => !row.passed);
  console.log(`acceptance: ${stories.payload.stories.length - failedStories.length}/${stories.payload.stories.length} stories, ${workflows.payload.workflows.length - failedFlows.length}/${workflows.payload.workflows.length} workflows pass`);
  for (const row of failedStories) console.log(`  ${row.id}: ${row.failures[0] ?? 'failed'}`);
  for (const row of failedFlows) console.log(`  ${row.id}: failed`);
  console.log(`runtime gates: ${runtimeGates.payload.tests.length - failedRuntime.length}/${runtimeGates.payload.tests.length} named tests pass`);
  for (const row of failedRuntime) console.log(`  ${row.gate}: ${row.file}: ${row.name}`);
  console.log(`acceptance: wrote ${join(out, 'story-report.json')}, ${join(out, 'workflow-report.json')} and ${join(out, 'runtime-gate-report.json')}`);
  return argv.includes('--strict') && (failedStories.length > 0 || failedFlows.length > 0 || failedRuntime.length > 0) ? 1 : 0;
}

if (isMain(import.meta.url)) process.exit(await main(process.argv.slice(2)));
