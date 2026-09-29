#!/usr/bin/env node
/**
 * Jevris benchmark harness (OBS-04, SSOT §17.4). Measures, on this machine and OS:
 *
 *   coldStartMs         spawning the sidecar until it answers (ensureSidecar from nothing)
 *   warmStartMs         reaching a running sidecar and its first answer (probe, hello, key proof, health)
 *   ipcRoundTripMs      one authenticated `ping` over the private socket or pipe
 *   hotRulesDecisionMs         a rules-only hot-path decision (`route`, hot budget)
 *   backgroundRulesDecisionMs  a rules-only background decision (`recover`, background budget)
 *   semanticDecisionMs         a `recover` decision that asks Jev (a local test stub, so the
 *                              network is excluded)
 * Each decision series is measured at the client and inside the service.
 *
 * The in-service times come from the sidecar's own trace lines (OBS-01). Background and
 * interactive latency are never averaged together. The §17.4 targets (warm hot-path rules p95 <
 * 25 ms in the service, launcher and IPC < 100 ms, semantic p95 < 800 ms) are reported as met or not;
 * they are engineering targets, and absolute numbers need reference hardware (E-28).
 *
 * A regression check compares every p95 with a baseline record from the same kind of machine:
 *
 *   node apps/sidecar/scripts/bench.mjs [--quick] [--out <file>] [--baseline <file>] [--ratio 1.5] [--slack-ms 10]
 *
 * It exits 1 when a p95 is worse than baseline × ratio + slack, and 0 otherwise. Run it from the
 * source tree after a build. Every sidecar it starts uses a temporary home, JEVRIS_TEST=1 and the
 * keyring block, so the real keychain and the real home are never touched.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, homedir, platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const repoModule = (...parts) => import(pathToFileURL(join(repoRoot, ...parts)).href);

export const BENCH_SCHEMA = 'jevris-bench-1';
/** SSOT §17.4 engineering targets (p95, milliseconds). */
export const TARGETS = { rulesServiceP95Ms: 25, launcherIpcP95Ms: 100, semanticP95Ms: 800 };
const FULL = { cold: 5, warm: 30, ipc: 200, rules: 60, semantic: 30 };
const QUICK = { cold: 1, warm: 3, ipc: 10, rules: 5, semantic: 3 };
/** Warm-up requests before a decision series, so a series measures the warm path. */
const WARMUP = 3;

export function summarize(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  const round = (n) => Math.round(n * 100) / 100;
  return { n: sorted.length, p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted[sorted.length - 1]) };
}

/** The p95 series a record carries, by name (`rulesDecisionMs.service`, ...). */
export function p95Series(record) {
  const out = {};
  for (const [name, value] of Object.entries(record?.results ?? {})) {
    if (value !== null && typeof value === 'object' && typeof value.p95 === 'number') out[name] = value.p95;
    else if (value !== null && typeof value === 'object') {
      for (const [part, inner] of Object.entries(value)) if (inner !== null && typeof inner?.p95 === 'number') out[`${name}.${part}`] = inner.p95;
    }
  }
  return out;
}

/** Regressions of `current` against `baseline`: a p95 above baseline × ratio + slackMs. */
export function compareBench(current, baseline, { ratio = 1.5, slackMs = 10 } = {}) {
  const now = p95Series(current);
  const before = p95Series(baseline);
  const regressions = [];
  const compared = [];
  for (const [name, p95] of Object.entries(now)) {
    const base = before[name];
    if (typeof base !== 'number') continue;
    const limit = Math.round((base * ratio + slackMs) * 100) / 100;
    compared.push(name);
    if (p95 > limit) regressions.push({ name, p95, baseline: base, limit });
  }
  const sameMachineKind = baseline?.platform === current?.platform && baseline?.arch === current?.arch;
  return { ok: regressions.length === 0, regressions, compared, sameMachineKind };
}

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

async function timed(fn) {
  const started = nowMs();
  const value = await fn();
  return { value, ms: nowMs() - started };
}

/** In-service times for an op, from the sidecar's trace lines written after `fromSeq`. */
function serviceTimes(stateDir, op, fromTs) {
  const dir = join(stateDir, 'traces');
  const out = [];
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return out;
  }
  for (const name of names) {
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (line.length === 0) continue;
      try {
        const row = JSON.parse(line);
        if (row.event === 'request.outcome' && row.op === op && Date.parse(row.ts) >= fromTs && typeof row.ms === 'number') out.push(row.ms);
      } catch {
        // a torn last line
      }
    }
  }
  return out;
}

/**
 * Waits until the sidecar's trace holds `want` outcome lines for `op` since `fromTs`, then returns
 * their times. The trace is written through a stream, so under load its last lines can land after
 * the last answer. The wait counts lines, not time: `maxMs` only stops a run whose sidecar never
 * writes them, and the times found by then are returned.
 */
async function awaitServiceTimes(stateDir, op, fromTs, want, maxMs = 30_000) {
  const until = Date.now() + maxMs;
  let times = serviceTimes(stateDir, op, fromTs);
  while (times.length < want && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    times = serviceTimes(stateDir, op, fromTs);
  }
  return times;
}

/** Runs inside the test environment (a temporary home, JEVRIS_TEST=1, keyring blocked). */
async function worker(counts) {
  const sidecar = await repoModule('apps', 'sidecar', 'dist', 'index.js');
  const { jevrisPaths } = await repoModule('packages', 'platform', 'dist', 'index.js');
  const home = process.env.JEVRIS_HOME;
  const stateDir = jevrisPaths({ home }).state;
  const work = join(home, 'work');
  mkdirSync(work, { recursive: true });
  const failures = [];
  const recoverBody = (i) => ({ taskId: null, signals: { fingerprints: [`TypeError at app/parse.ts:${i}`, `TypeError at app/parse.ts:${i}`], environment: [] }, rejectedApproaches: [] });

  const cold = [];
  for (let i = 0; i < counts.cold; i += 1) {
    await sidecar.stopSidecarProcess(home);
    const { value, ms } = await timed(() => sidecar.ensureSidecar({ home, waitMs: 15_000 }));
    if (!value.ok) failures.push(`cold start: ${value.message}`);
    else cold.push(ms);
  }
  const warm = [];
  for (let i = 0; i < counts.warm; i += 1) {
    // A running sidecar: find it, then the first authenticated answer (hello, key proof, health).
    const { value, ms } = await timed(async () => {
      const ensured = await sidecar.ensureSidecar({ home, waitMs: 5000 });
      return ensured.ok ? { ensured, answer: await sidecar.sidecarRequest({ home, op: 'health', scope: 'cli', body: {} }) } : { ensured };
    });
    if (value.ensured.ok && !value.ensured.started && value.answer?.ok === true) warm.push(ms);
  }
  const ipc = [];
  for (let i = 0; i < counts.ipc; i += 1) {
    const { value, ms } = await timed(() => sidecar.sidecarRequest({ home, op: 'ping', scope: 'cli', body: {} }));
    if (value.ok) ipc.push(ms);
    else failures.push(`ping: ${value.reasonCode ?? value.reason}`);
  }
  const routeBody = () => ({ currentModel: 'claude-opus-5', modelPin: null, effortPin: null, taskId: null, sliceId: null });
  const decisions = async (label, op, body, n, offset) => {
    for (let i = 0; i < WARMUP; i += 1) await sidecar.sidecarRequest({ home, op, scope: 'cli', workspace: work, body: body(offset - 1 - i), timeoutMs: 10_000 });
    const client = [];
    const from = Date.now();
    for (let i = 0; i < n; i += 1) {
      const { value, ms } = await timed(() => sidecar.sidecarRequest({ home, op, scope: 'cli', workspace: work, body: body(offset + i), timeoutMs: 10_000 }));
      if (value.ok) client.push(ms);
      else failures.push(`${label}: ${value.reasonCode ?? value.reason}`);
    }
    return { client: summarize(client), service: summarize(await awaitServiceTimes(stateDir, op, from, client.length)) };
  };
  const hotRules = await decisions('hot rules decision', 'route', routeBody, counts.rules, 1000);
  const backgroundRules = await decisions('background rules decision', 'recover', recoverBody, counts.rules, 2000);

  // Semantic: the same sidecar restarted with the Jev test stub (loopback; test mode only).
  await sidecar.stopSidecarProcess(home);
  const { startJevStub } = await repoModule('test', 'acceptance', 'jev-stub.mjs');
  const cleanups = [];
  const stub = await startJevStub({ after: (fn) => cleanups.push(fn) }, { scenario: 'valid' });
  let semantic = { client: null, service: null };
  try {
    Object.assign(process.env, stub.env);
    const started = await sidecar.ensureSidecar({ home, waitMs: 15_000 });
    if (!started.ok) failures.push(`semantic start: ${started.message}`);
    else semantic = await decisions('semantic decision', 'recover', recoverBody, counts.semantic, 10_000);
    if (stub.requests().length === 0) failures.push('semantic decision: Jev was never asked');
  } finally {
    await sidecar.stopSidecarProcess(home);
    for (const fn of cleanups) fn();
  }
  return {
    results: {
      coldStartMs: summarize(cold),
      warmStartMs: summarize(warm),
      ipcRoundTripMs: summarize(ipc),
      hotRulesDecisionMs: hotRules,
      backgroundRulesDecisionMs: backgroundRules,
      semanticDecisionMs: semantic,
    },
    failures,
  };
}

function targetsMet(results) {
  const p95 = (value) => (value === null || value === undefined ? null : value.p95);
  const check = (value, limit) => (value === null ? null : value <= limit);
  return {
    rulesService: check(p95(results.hotRulesDecisionMs?.service), TARGETS.rulesServiceP95Ms),
    launcherIpc: check(p95(results.ipcRoundTripMs), TARGETS.launcherIpcP95Ms),
    semantic: check(p95(results.semanticDecisionMs?.client), TARGETS.semanticP95Ms),
  };
}

/** Runs the benchmark in a child process with the test environment and returns the record. */
export async function runBench({ quick = false } = {}) {
  const { testEnvironment, writeHarnessStubs } = await repoModule('scripts', 'test.mjs');
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-bench-')));
  try {
    const env = {
      ...testEnvironment(home, homedir(), writeHarnessStubs(join(home, 'bin'))),
      JEVRIS_SIDECAR_ENTRY: join(repoRoot, 'apps', 'sidecar', 'dist', 'main.js'),
      JEVRIS_SIDECAR_IDLE_MS: '120000',
    };
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--worker', quick ? 'quick' : 'full'], { env, cwd: home, encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    const last = (child.stdout ?? '').trim().split(/\r?\n/).at(-1) ?? '';
    let measured;
    try {
      measured = JSON.parse(last);
    } catch {
      measured = { results: {}, failures: [`the benchmark worker failed (exit ${child.status}): ${(child.stderr ?? '').slice(-800)}`] };
    }
    const cpu = cpus();
    return {
      schemaVersion: BENCH_SCHEMA,
      platform: platform(),
      arch: arch(),
      node: process.versions.node,
      cpus: cpu.length,
      cpuModel: (cpu[0]?.model ?? 'unknown').trim().slice(0, 80),
      quick,
      at: new Date().toISOString(),
      results: measured.results,
      targets: TARGETS,
      targetsMet: targetsMet(measured.results),
      failures: measured.failures,
    };
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
}

function flag(argv, name) {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

async function main(argv) {
  if (argv[0] === '--worker') {
    const measured = await worker(argv[1] === 'quick' ? QUICK : FULL);
    process.stdout.write(`${JSON.stringify(measured)}\n`);
    return 0;
  }
  const record = await runBench({ quick: argv.includes('--quick') });
  const out = flag(argv, '--out');
  if (out !== undefined) {
    const path = resolve(out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  }
  for (const [name, p95] of Object.entries(p95Series(record))) console.log(`${name}: p95 ${p95} ms`);
  for (const [name, met] of Object.entries(record.targetsMet)) console.log(`target ${name}: ${met === null ? 'not measured' : met ? 'met' : 'NOT met'}`);
  let code = record.failures.length === 0 ? 0 : 1;
  for (const failure of record.failures) console.log(`failure: ${failure}`);
  const baselinePath = flag(argv, '--baseline');
  if (baselinePath !== undefined) {
    const baseline = JSON.parse(readFileSync(resolve(baselinePath), 'utf8'));
    const ratio = Number(flag(argv, '--ratio') ?? 1.5);
    const slackMs = Number(flag(argv, '--slack-ms') ?? 10);
    const compared = compareBench(record, baseline, { ratio, slackMs });
    if (!compared.sameMachineKind) console.log(`note: the baseline is from ${baseline.platform}-${baseline.arch}, this run is ${record.platform}-${record.arch}`);
    for (const r of compared.regressions) console.log(`REGRESSION ${r.name}: p95 ${r.p95} ms > ${r.limit} ms (baseline ${r.baseline} ms)`);
    console.log(`compared ${compared.compared.length} series against the baseline: ${compared.ok ? 'no regression' : `${compared.regressions.length} regression(s)`}`);
    if (!compared.ok) code = 1;
  }
  return code;
}

const entry = process.argv[1];
if (typeof entry === 'string' && resolve(entry) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
