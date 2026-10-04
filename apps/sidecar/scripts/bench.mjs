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
 *   node apps/sidecar/scripts/bench.mjs [--quick] [--out <file>] [--baseline <file>]
 *                                       [--ratio 1.5] [--slack-ms 10] [--rechecks 2]
 *
 * The regression gate. It compares this run with a baseline record from the same kind of machine
 * (in CI, the last successful main run's) and exits 1 only for a regression that repeats.
 *
 * Why it is not "p95 above baseline x 1.5 + 10 ms" alone. That rule failed a different series on
 * almost every CI run of 4a82f0e..0685dba with no code change on the request path: on this
 * machine the same series measured the same at 0b1237d and at 0685dba over six alternating
 * rounds, and the records of eight CI runs show why. Between two hosted runners (or two runs on
 * one) the MEDIAN of a series moves by 2 to 4 times (macOS `recover` 7 to 28 ms, Windows semantic
 * 71 to 234 ms, macOS cold start 238 to 655 ms), and a series' p95 moves further, because it is
 * one stalled request: a cold start has 5 samples, so its p95 was its slowest single start. The
 * baseline is one earlier run's numbers, so it can also be a lucky low one, and a main that never
 * goes green keeps it frozen. Replaying the old rule over those eight runs tripped a series in
 * 12 of 21 runs, none of them real. So:
 *
 *   1. Medians decide, p95 guards the tail. A series trips when its median is above
 *      baseline median x ratio + slack (a real slowdown moves the whole distribution), or its p95
 *      is above baseline p95 x 2 * ratio + 2 * slack (a gross tail change). One stalled request
 *      cannot trip the median rule, and a tail rule twice as wide as the median one
 *      ignores a lone stall but still sees a slow path taken by every tenth request.
 *   2. More samples: 8 cold starts, 100 rules decisions and 60 semantic ones (a p95 over 5 or 30
 *      values is just the largest).
 *   3. A trip must repeat. Every series that tripped is measured again alone, from a fresh
 *      sidecar and a fresh home, up to `--rechecks` times (default 2); the run fails only for a
 *      series that trips in the first pass and in every re-measure. A series the re-measure could
 *      not measure stays a suspect. The record written by --out is always the first pass.
 *   4. Machine speed. Each pass first times three fixed workloads (a node process start, a CPU
 *      loop and file fsyncs, `calibration` in the record). When this machine's probes are slower
 *      than the baseline's, the limits widen by the slowest probe's ratio (at most 3 times); they
 *      never narrow. A code regression does not slow the probes, so it is measured against the
 *      unwidened limits, while a slow runner is not blamed on the code. A baseline with no
 *      calibration (an older record) widens nothing.
 *
 * The quick run (`--quick`, what `npm test` runs) treats a deadline or a timeout of a decision series as a measured outcome
 * and counts it in `deadlineHits` (a Windows runner took 2 to 7 s for the engine's durable writes alone, past a background op's
 * 5 s); the full run and the gate treat it as a failure, as they always did. A sidecar that never starts, a Jev that was
 * never asked and a series with no sample are failures in both.
 *
 * The limits and the baseline come from the command line and the record, the §17.4 targets are
 * untouched, and hosted runners stay a regression check, not a measurement of the targets.
 *
 * Run it from the source tree after a build. Every sidecar it starts uses a temporary home,
 * JEVRIS_TEST=1 and the keyring block, so the real keychain and the real home are never touched.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { arch, cpus, homedir, platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const repoModule = (...parts) => import(pathToFileURL(join(repoRoot, ...parts)).href);

export const BENCH_SCHEMA = 'jevris-bench-1';
/** SSOT §17.4 engineering targets (p95, milliseconds). */
export const TARGETS = { rulesServiceP95Ms: 25, launcherIpcP95Ms: 100, semanticP95Ms: 800 };
const FULL = { cold: 8, warm: 30, ipc: 200, rules: 100, semantic: 60 };
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

/** Every top-level series a record can carry, in the order the worker measures them. */
export const SERIES = ['coldStartMs', 'warmStartMs', 'ipcRoundTripMs', 'hotRulesDecisionMs', 'backgroundRulesDecisionMs', 'semanticDecisionMs'];

/** The summary (`{ n, p50, p95, max }`) of every series a record carries, by name (`rulesDecisionMs.service`, ...). */
export function statSeries(record) {
  const isSummary = (value) => value !== null && typeof value === 'object' && typeof value.p95 === 'number';
  const out = {};
  for (const [name, value] of Object.entries(record?.results ?? {})) {
    if (isSummary(value)) out[name] = value;
    else if (value !== null && typeof value === 'object') {
      for (const [part, inner] of Object.entries(value)) if (isSummary(inner)) out[`${name}.${part}`] = inner;
    }
  }
  return out;
}

/** The p95 of every series a record carries, by name. */
export function p95Series(record) {
  const out = {};
  for (const [name, stat] of Object.entries(statSeries(record))) out[name] = stat.p95;
  return out;
}

/** The most the limits widen for a slower machine. */
export const MAX_SPEED_FACTOR = 3;

/**
 * How much slower this machine is than the baseline's, from their `calibration` probes: the
 * largest current/baseline ratio, never below 1 and never above MAX_SPEED_FACTOR. 1 when either
 * record has no calibration.
 */
export function speedFactor(current, baseline) {
  const now = current?.calibration;
  const before = baseline?.calibration;
  if (now === null || typeof now !== 'object' || before === null || typeof before !== 'object') return 1;
  let factor = 1;
  for (const [name, value] of Object.entries(now)) {
    const then = before[name];
    if (typeof value === 'number' && typeof then === 'number' && then > 0 && value > 0) factor = Math.max(factor, value / then);
  }
  return Math.min(MAX_SPEED_FACTOR, Math.round(factor * 100) / 100);
}

/**
 * Regressions of `current` against `baseline`. A series trips when its median is above
 * baseline median x ratio + slackMs ('median'), or its p95 is above baseline p95 x 2 * ratio +
 * 2 * slackMs ('tail'); both limits widen by the machine `speedFactor`. A series trips on the
 * median rule first when both apply. This is one pass: the gate (`runGate`) counts only a trip
 * that repeats.
 */
export function compareBench(current, baseline, { ratio = 1.5, slackMs = 10 } = {}) {
  const now = statSeries(current);
  const before = statSeries(baseline);
  const speed = speedFactor(current, baseline);
  const round = (n) => Math.round(n * 100) / 100;
  const regressions = [];
  const compared = [];
  for (const [name, stat] of Object.entries(now)) {
    const base = before[name];
    if (base === undefined) continue;
    compared.push(name);
    const medianLimit = round((base.p50 * ratio + slackMs) * speed);
    const tailLimit = round((base.p95 * 2 * ratio + 2 * slackMs) * speed);
    if (stat.p50 > medianLimit) regressions.push({ name, kind: 'median', value: stat.p50, baseline: base.p50, limit: medianLimit });
    else if (stat.p95 > tailLimit) regressions.push({ name, kind: 'tail', value: stat.p95, baseline: base.p95, limit: tailLimit });
  }
  const sameMachineKind = baseline?.platform === current?.platform && baseline?.arch === current?.arch;
  return { ok: regressions.length === 0, regressions, compared, sameMachineKind, speedFactor: speed };
}

/**
 * The gate: `first` (a bench record) against `baseline`, then every series that tripped is
 * measured again alone (`remeasure(seriesNames)` returns a record holding only those series), up
 * to `rechecks` times. A regression counts only when its series trips in the first pass and in
 * every re-measure; a series a re-measure did not measure stays a suspect. `confirmed` are the
 * regressions of the first pass that survived; `cleared` are the series that tripped once and
 * did not repeat.
 */
export async function runGate({ first, baseline, ratio = 1.5, slackMs = 10, rechecks = 2, remeasure }) {
  const options = { ratio, slackMs };
  const firstPass = compareBench(first, baseline, options);
  const passes = [firstPass];
  let suspects = firstPass.regressions.map((r) => r.name);
  const cleared = [];
  for (let round = 0; round < rechecks && suspects.length > 0; round += 1) {
    const topLevel = [...new Set(suspects.map((name) => name.split('.')[0]))];
    const again = await remeasure(topLevel, round + 1);
    const pass = compareBench(again, baseline, options);
    passes.push(pass);
    const measured = new Set(pass.compared);
    const tripped = new Set(pass.regressions.map((r) => r.name));
    const kept = [];
    for (const name of suspects) {
      if (tripped.has(name) || !measured.has(name)) kept.push(name);
      else cleared.push(name);
    }
    suspects = kept;
  }
  const confirmed = firstPass.regressions.filter((r) => suspects.includes(r.name));
  return { ok: confirmed.length === 0, confirmed, cleared, passes, sameMachineKind: firstPass.sameMachineKind, compared: firstPass.compared };
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

/**
 * What one request of a decision series came to. `ok` is an answer. With `lenient` (the quick run `npm test` makes), a
 * deadline or a timeout is `deadline`: the host was too slow for the op's budget, which is an outcome the run measured
 * (a loaded Windows runner took 2 to 7 s for the engine's durable journal and budget writes alone, past the 5 s a
 * background op has), not a fault of the harness. Anything else, and every deadline in the full run, is a `failure`: the
 * full run and the gate stay as strict as they were, and a series with no sample at all is still missing.
 */
export function outcomeOf(value, lenient) {
  if (value !== null && typeof value === 'object' && value.ok === true) return 'ok';
  const code = value?.reasonCode;
  const timedOut = code === 'DEADLINE' || code === 'TIMEOUT' || code === 'CONNECT_TIMEOUT' || code === 'HANDSHAKE_TIMEOUT' || value?.reason === 'timeout';
  return lenient && timedOut ? 'deadline' : 'failure';
}

/**
 * One decision series: `warmup` unmeasured requests, then `n` measured ones, one at a time, with the in-service time of
 * each from the sidecar's own trace. `ports` is `{ sidecar, home, work, stateDir }`. A deadline that `outcomeOf` calls an
 * outcome counts in `deadlineHits` and its time is a sample (it is what the caller waited); a failure goes to `failures`.
 */
export async function measureDecisions({ ports, label, op, body, n, offset, warmup = WARMUP, lenient = false, failures }) {
  const { sidecar, home, work, stateDir } = ports;
  for (let i = 0; i < warmup; i += 1) await sidecar.sidecarRequest({ home, op, scope: 'cli', workspace: work, body: body(offset - 1 - i), timeoutMs: 10_000 });
  const client = [];
  let deadlineHits = 0;
  const from = Date.now();
  for (let i = 0; i < n; i += 1) {
    const { value, ms } = await timed(() => sidecar.sidecarRequest({ home, op, scope: 'cli', workspace: work, body: body(offset + i), timeoutMs: 10_000 }));
    const outcome = outcomeOf(value, lenient);
    if (outcome === 'failure') {
      failures.push(`${label}: ${value.reasonCode ?? value.reason}`);
      continue;
    }
    if (outcome === 'deadline') deadlineHits += 1;
    client.push(ms);
  }
  return { client: summarize(client), service: summarize(await awaitServiceTimes(stateDir, op, from, client.length)), deadlineHits };
}

/**
 * Runs inside the test environment (a temporary home, JEVRIS_TEST=1, keyring blocked). `only`
 * names the top-level series to measure (a re-measure), or is null for all of them; a series left
 * out is null in the result. The sidecar still starts once, unmeasured, when cold starts are left out.
 * `counts` is FULL or QUICK; the quick run is lenient about a deadline (see `outcomeOf`), the full one is not.
 */
async function worker(counts, only = null) {
  const wants = (name) => only === null || only.includes(name);
  const lenient = counts === QUICK;
  const sidecar = await repoModule('apps', 'sidecar', 'dist', 'index.js');
  const { jevrisPaths } = await repoModule('packages', 'platform', 'dist', 'index.js');
  const home = process.env.JEVRIS_HOME;
  const stateDir = jevrisPaths({ home }).state;
  const work = join(home, 'work');
  mkdirSync(work, { recursive: true });
  const failures = [];
  const ports = { sidecar, home, work, stateDir };
  const recoverBody = (i) => ({ taskId: null, signals: { fingerprints: [`TypeError at app/parse.ts:${i}`, `TypeError at app/parse.ts:${i}`], environment: [] }, rejectedApproaches: [] });

  const cold = [];
  // A re-measure without cold starts still needs one running sidecar; that start is not timed.
  const coldRuns = wants('coldStartMs') ? counts.cold : 1;
  for (let i = 0; i < coldRuns; i += 1) {
    await sidecar.stopSidecarProcess(home);
    const { value, ms } = await timed(() => sidecar.ensureSidecar({ home, waitMs: 15_000 }));
    if (!value.ok) failures.push(`cold start: ${value.message}`);
    else cold.push(ms);
  }
  // No sidecar ever answered: every later series would wait out its timeouts and the run
  // would end at the parent's 10-minute limit with nothing said. Stop here with the reason.
  if (coldRuns > 0 && cold.length === 0) {
    await sidecar.stopSidecarProcess(home);
    return { results: Object.fromEntries(SERIES.map((name) => [name, null])), failures };
  }
  const warm = [];
  for (let i = 0; i < (wants('warmStartMs') ? counts.warm : 0); i += 1) {
    // A running sidecar: find it, then the first authenticated answer (hello, key proof, health).
    const { value, ms } = await timed(async () => {
      const ensured = await sidecar.ensureSidecar({ home, waitMs: 5000 });
      return ensured.ok ? { ensured, answer: await sidecar.sidecarRequest({ home, op: 'health', scope: 'cli', body: {} }) } : { ensured };
    });
    if (value.ensured.ok && !value.ensured.started && value.answer?.ok === true) warm.push(ms);
  }
  const ipc = [];
  for (let i = 0; i < (wants('ipcRoundTripMs') ? counts.ipc : 0); i += 1) {
    const { value, ms } = await timed(() => sidecar.sidecarRequest({ home, op: 'ping', scope: 'cli', body: {} }));
    if (value.ok) ipc.push(ms);
    else failures.push(`ping: ${value.reasonCode ?? value.reason}`);
  }
  const routeBody = () => ({ currentModel: 'claude-opus-5', modelPin: null, effortPin: null, taskId: null, sliceId: null });
  const decisions = (label, op, body, n, offset) => measureDecisions({ ports, label, op, body, n, offset, lenient, failures });
  const skipped = { client: null, service: null };
  const hotRules = wants('hotRulesDecisionMs') ? await decisions('hot rules decision', 'route', routeBody, counts.rules, 1000) : skipped;
  const backgroundRules = wants('backgroundRulesDecisionMs') ? await decisions('background rules decision', 'recover', recoverBody, counts.rules, 2000) : skipped;

  // Semantic: the same sidecar restarted with the Jev test stub (loopback; test mode only).
  await sidecar.stopSidecarProcess(home);
  let semantic = skipped;
  if (wants('semanticDecisionMs')) {
    const { startJevStub } = await repoModule('test', 'acceptance', 'jev-stub.mjs');
    const cleanups = [];
    const stub = await startJevStub({ after: (fn) => cleanups.push(fn) }, { scenario: 'valid' });
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
  }
  return {
    results: {
      coldStartMs: wants('coldStartMs') ? summarize(cold) : null,
      warmStartMs: wants('warmStartMs') ? summarize(warm) : null,
      ipcRoundTripMs: wants('ipcRoundTripMs') ? summarize(ipc) : null,
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

function median(values) {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
}

/**
 * Times three fixed workloads that stand for what the series spend their time on, so a slower
 * machine can be told from slower code: starting a node process (cold start, and the git child
 * a decision may start), a CPU loop, and small files written and fsynced. Each is the median of
 * several rounds, in milliseconds. Nothing here touches the product.
 */
export function calibrate(dir) {
  const spawnMs = [];
  for (let i = 0; i < 7; i += 1) {
    const started = nowMs();
    spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true });
    spawnMs.push(nowMs() - started);
  }
  const cpuMs = [];
  for (let round = 0; round < 7; round += 1) {
    const started = nowMs();
    const numbers = [];
    let acc = 0;
    for (let i = 0; i < 60_000; i += 1) {
      acc = (acc * 31 + i) % 1_000_003;
      numbers.push(acc);
    }
    numbers.sort((x, y) => x - y);
    JSON.parse(JSON.stringify(numbers.slice(0, 20_000)));
    cpuMs.push(nowMs() - started);
  }
  const fsyncMs = [];
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 12; i += 1) {
    const started = nowMs();
    const fd = openSync(join(dir, `probe-${i}`), 'w');
    writeSync(fd, 'x'.repeat(4096));
    fsyncSync(fd);
    closeSync(fd);
    fsyncMs.push(nowMs() - started);
  }
  const round = (n) => Math.round(n * 100) / 100;
  return { nodeSpawnMs: round(median(spawnMs)), cpuLoopMs: round(median(cpuMs)), fsyncMs: round(median(fsyncMs)) };
}

/**
 * Runs the benchmark in a child process with the test environment and returns the record. `only`
 * names the top-level series to measure (a re-measure); the others are null in the record.
 */
export async function runBench({ quick = false, only = null } = {}) {
  const { testEnvironment, writeHarnessStubs } = await repoModule('scripts', 'test.mjs');
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-bench-')));
  try {
    const env = {
      ...testEnvironment(home, homedir(), writeHarnessStubs(join(home, 'bin'))),
      JEVRIS_SIDECAR_ENTRY: join(repoRoot, 'apps', 'sidecar', 'dist', 'main.js'),
      JEVRIS_SIDECAR_IDLE_MS: '120000',
    };
    const calibration = calibrate(join(home, 'calibration'));
    const args = [fileURLToPath(import.meta.url), '--worker', quick ? 'quick' : 'full'];
    if (only !== null) args.push('--only', only.join(','));
    const child = spawnSync(process.execPath, args, { env, cwd: home, encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
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
      calibration,
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
    const only = flag(argv, '--only');
    const measured = await worker(argv[1] === 'quick' ? QUICK : FULL, only === undefined ? null : only.split(','));
    process.stdout.write(`${JSON.stringify(measured)}\n`);
    return 0;
  }
  const quick = argv.includes('--quick');
  const record = await runBench({ quick });
  const out = flag(argv, '--out');
  const write = () => {
    if (out === undefined) return;
    const path = resolve(out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  };
  write();
  for (const [name, stat] of Object.entries(statSeries(record))) console.log(`${name}: p50 ${stat.p50} ms, p95 ${stat.p95} ms (n ${stat.n})`);
  for (const [name, series] of Object.entries(record.results)) if (series !== null && typeof series === 'object' && series.deadlineHits > 0) console.log(`note: ${name} hit its deadline ${series.deadlineHits} time(s); the quick run counts that as an outcome`);
  for (const [name, met] of Object.entries(record.targetsMet)) console.log(`target ${name}: ${met === null ? 'not measured' : met ? 'met' : 'NOT met'}`);
  let code = record.failures.length === 0 ? 0 : 1;
  for (const failure of record.failures) console.log(`failure: ${failure}`);
  const baselinePath = flag(argv, '--baseline');
  if (baselinePath !== undefined) {
    const baseline = JSON.parse(readFileSync(resolve(baselinePath), 'utf8'));
    const ratio = Number(flag(argv, '--ratio') ?? 1.5);
    const slackMs = Number(flag(argv, '--slack-ms') ?? 10);
    const rechecks = Number(flag(argv, '--rechecks') ?? 2);
    const describe = (r) => `${r.name} ${r.kind === 'median' ? 'median' : 'p95'} ${r.value} ms > ${r.limit} ms (baseline ${r.baseline} ms)`;
    const gate = await runGate({
      first: record,
      baseline,
      ratio,
      slackMs,
      rechecks,
      remeasure: async (names, round) => {
        console.log(`re-measuring ${names.join(', ')} (${round} of ${rechecks}), because they tripped`);
        const again = await runBench({ quick, only: names });
        for (const failure of again.failures) console.log(`re-measure failure: ${failure}`);
        return again;
      },
    });
    if (!gate.sameMachineKind) console.log(`note: the baseline is from ${baseline.platform}-${baseline.arch}, this run is ${record.platform}-${record.arch}`);
    const speed = gate.passes[0]?.speedFactor ?? 1;
    if (speed >= 1.1) console.log(`note: this machine measured ${speed} times slower than the baseline's on the calibration probes, so the limits are widened by that much`);
    gate.passes.forEach((pass, index) => {
      for (const r of pass.regressions) console.log(`${index === 0 ? 'tripped' : `tripped again (re-measure ${index})`}: ${describe(r)}`);
    });
    for (const name of gate.cleared) console.log(`cleared: ${name} tripped once and did not repeat`);
    for (const r of gate.confirmed) console.log(`REGRESSION ${describe(r)}`);
    console.log(`compared ${gate.compared.length} series against the baseline: ${gate.ok ? 'no regression' : `${gate.confirmed.length} regression(s)`}`);
    record.gate = { passes: gate.passes.length, confirmed: gate.confirmed.map((r) => r.name), cleared: gate.cleared };
    write();
    if (!gate.ok) code = 1;
  }
  return code;
}

const entry = process.argv[1];
if (typeof entry === 'string' && resolve(entry) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
