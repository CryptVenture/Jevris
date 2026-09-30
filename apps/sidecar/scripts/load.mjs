#!/usr/bin/env node
/**
 * Sidecar concurrency load run (owner decision DOMAINS ededdba; audit
 * .planning/research/sidecar-concurrency-audit.md). It measures the locked targets and exits 1
 * when one is not met:
 *
 *   subagents20  20 concurrent subagents for 60 s: hook p99 <= 250 ms, every hook answered
 *   verify8      the same during an 8-check verify over a tree with 80 MB untracked: hook p99
 *                <= 400 ms, `jevris status` p99 <= 1 s, ping p99 <= 100 ms
 *   loop         both runs above: event-loop delay p99 <= 50 ms in every 1 s window, no stall over 200 ms
 *   subagents50  50 concurrent subagents: every hook answered or BUSY within 50 ms, DEADLINE <= 1%
 *   history      one session, 2600 sequential events: p50 of events 2401-2600 within 1.5x events 1-200
 *   lifecycle    compact restores and Stop reminders during 20 subagents: never queued
 *   lifecycle50  PreCompact, compact restores and Stop during 50 subagents: never answered BUSY
 *                (D's K3; B's answer lane 63a0a31; owner decision DOMAINS 684ff82)
 *
 * A subagent is SubagentStart, 3 x (PreToolUse, PostToolUse), SubagentStop, sequential per
 * subagent and concurrent across subagents. Each hook is sent exactly as the launcher sends it (op
 * `event`, scope hook, hot budget, 1500 ms), with the Claude Code adapter, and timed at the client.
 * The targets and the reference machine live in apps/cli/src/release-gates.ts, which the
 * `perf.sidecar-concurrency` release gate also reads; the absolute numbers are judged on the
 * reference machine only.
 *
 *   npm run bench:load -- [--quick] [--only <scenario,...>] [--duration-s N] [--out <file>]
 *                         [--evidence <file>] [--commit <sha>]
 *
 * Run it from the source tree after `npm run build`. Every scenario runs in its own child process
 * and its own sandbox: a temporary home (the test environment of scripts/test.mjs, JEVRIS_TEST=1,
 * the keyring blocked), stub harness binaries on PATH, and an instrumented sidecar entry that
 * records event-loop delay. The real home, the real keychain and real harness binaries are never
 * touched, and no model is called. It holds the host suite lock, so no full suite runs beside it.
 * It is never part of `npm test`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { arch, cpus, homedir, loadavg, platform, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const repoModule = (...parts) => import(pathToFileURL(join(repoRoot, ...parts)).href);

export const LOAD_SCHEMA = 'jevris-load-1';
export const SCENARIOS = ['subagents20', 'verify8', 'subagents50', 'history', 'lifecycle', 'lifecycle50'];
/** Scenarios that feed only report-only measures: a failure to run them is printed, never the exit code. */
export const REPORT_ONLY_SCENARIOS = [];

/**
 * Proposed targets: measured and printed, never judged by the perf gate, never in the evidence.
 * Each joins SIDECAR_LOAD_TARGETS (apps/cli/src/release-gates.ts) only with the owner's approval.
 * None today: load.lifecycle50.busy was the last, and joined the locked set (DOMAINS 684ff82).
 */
export const PROPOSED_LOAD_TARGETS = [];
const USAGE = 'usage: npm run bench:load -- [--quick] [--only <scenario,...>] [--duration-s N] [--out <file>] [--evidence <file>] [--commit <sha>]';
/** The hook deadline the launcher uses. */
const HOOK_TIMEOUT_MS = 1500;
const SCENARIO_TIMEOUT_MS = 20 * 60_000;

// ------------------------------------------------------------------ pure parts (tested)

/** The report-only measures, one per proposed target; a scenario that did not run gives null. */
export function reportOnlyMeasures(_results) {
  return [];
}

/** Each proposed target against its measure; printed as `report`, never a pass or fail of the run. */
export function judgeProposed(measures) {
  return PROPOSED_LOAD_TARGETS.map((target) => {
    const value = measures.find((item) => item.id === target.id)?.value ?? null;
    return { target, value, ok: value !== null && Number.isFinite(value) && value <= target.limit };
  });
}

/** Percentiles as bench.mjs takes them (nearest rank), with outcome codes counted. */
export function summarize(samples) {
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const at = (p) => (ms.length === 0 ? null : Math.round(ms[Math.min(ms.length - 1, Math.max(0, Math.ceil(p * ms.length) - 1))] * 10) / 10);
  const codes = {};
  for (const s of samples) codes[s.code] = (codes[s.code] ?? 0) + 1;
  return { n: ms.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1), codes };
}

/** An answered hook: served, served with work queued, or a duplicate delivery. */
export const answered = (code) => code === 'OK' || code === 'OK_QUEUED' || code === 'OK_DUP';

/** Event-loop rows (one per second from the instrumented entry) inside [fromMs, toMs]. */
export function loopSummary(rows) {
  if (rows.length === 0) return null;
  const gaps = rows.flatMap((row) => row.stalls.map((stall) => stall[1])).sort((a, b) => a - b);
  return {
    seconds: rows.length,
    worstWindowP99Ms: Math.round(Math.max(...rows.map((row) => row.p99)) * 10) / 10,
    medianWindowP99Ms: Math.round([...rows.map((row) => row.p99)].sort((a, b) => a - b)[Math.floor(rows.length / 2)] * 10) / 10,
    worstStallMs: gaps.length === 0 ? 0 : gaps[gaps.length - 1],
    stallsOver40Ms: gaps.length,
    stallsOver200Ms: gaps.filter((gap) => gap > 200).length,
    rssMaxMb: Math.round(Math.max(...rows.map((row) => row.rss)) / 1048576),
  };
}

const worst = (...values) => {
  const known = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  return known.length === 0 ? null : Math.max(...known);
};

/** The measures the targets judge, from the scenario results; a scenario that did not run gives nulls. */
export function measuresFrom(results) {
  const count = (summary, keep) => (summary === undefined || summary === null ? null : Object.entries(summary.codes).filter(([code]) => keep(code)).reduce((sum, [, n]) => sum + n, 0));
  const s20 = results.subagents20;
  const v8 = results.verify8;
  const s50 = results.subagents50;
  const hist = results.history;
  const life = results.lifecycle;
  const life50 = results.lifecycle50;
  const deadline = s50?.hooks ? (s50.hooks.codes.DEADLINE ?? 0) / Math.max(1, s50.hooks.n) : null;
  return [
    { id: 'load.subagents20.hook-p99-ms', value: s20?.hooks?.p99 ?? null },
    { id: 'load.subagents20.unanswered', value: count(s20?.hooks, (code) => !answered(code)) },
    { id: 'load.verify8.hook-p99-ms', value: v8?.hooks?.p99 ?? null },
    { id: 'load.verify8.cli-status-p99-ms', value: v8?.cliStatus?.p99 ?? null },
    { id: 'load.verify8.ping-p99-ms', value: v8?.pings?.p99 ?? null },
    { id: 'load.loop.window-p99-ms', value: s20?.loop && v8?.loop ? worst(s20.loop.worstWindowP99Ms, v8.loop.worstWindowP99Ms) : null },
    { id: 'load.loop.worst-stall-ms', value: s20?.loop && v8?.loop ? worst(s20.loop.worstStallMs, v8.loop.worstStallMs) : null },
    { id: 'load.subagents50.deadline-rate', value: deadline === null ? null : Math.round(deadline * 10000) / 10000 },
    { id: 'load.subagents50.busy-max-ms', value: s50?.hooks ? (s50.busyMaxMs ?? 0) : null },
    { id: 'load.subagents50.unanswered', value: count(s50?.hooks, (code) => !answered(code) && code !== 'BUSY' && code !== 'DEADLINE') },
    { id: 'load.history.p50-ratio', value: hist?.first?.p50 && hist?.last?.p50 !== null && hist?.last?.p50 !== undefined ? Math.round((hist.last.p50 / hist.first.p50) * 100) / 100 : null },
    { id: 'load.lifecycle.queued', value: life?.lifecycle ? count(life.restoresAndStops, (code) => code !== 'OK' && code !== 'OK_DUP') : null },
    { id: 'load.lifecycle50.busy', value: life50?.lifecycle ? count(life50.lifecycle, (code) => code === 'BUSY') : null },
  ];
}

/** The sidecar's view of each check (verify.status rows): RUNNING, QUEUED, or outcome/reasonCode. */
export function verifyStates(rows) {
  return [...new Set(rows.map((row) => (row.reasonCode === 'RUNNING' || row.reasonCode === 'QUEUED' ? row.reasonCode : `${String(row.outcome)}/${String(row.reasonCode)}`)))];
}

/** The sidecar took the verify run: a check is running, queued or has a fresh outcome. */
export function verifyUnderway(states) {
  return states.some((state) => state === 'RUNNING' || state === 'QUEUED' || state.startsWith('passed/') || state.startsWith('failed/'));
}

export function machineOf() {
  const cpu = cpus();
  return { os: platform(), arch: arch(), cpuModel: (cpu[0]?.model ?? 'unknown').trim().slice(0, 200) || 'unknown', cores: Math.max(1, cpu.length), memoryGb: Math.max(1, Math.round(totalmem() / 2 ** 30)) };
}

export function parseLoadArgs(argv) {
  const options = { quick: false, only: [...SCENARIOS], durationS: null, out: null, evidence: null, commit: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} takes a value`);
      i += 1;
      return next;
    };
    if (arg === '--quick') options.quick = true;
    else if (arg === '--only') {
      const names = value().split(',').filter((name) => name.length > 0);
      const unknown = names.filter((name) => !SCENARIOS.includes(name));
      if (names.length === 0 || unknown.length > 0) throw new Error(`--only takes scenarios from ${SCENARIOS.join(', ')}`);
      options.only = SCENARIOS.filter((name) => names.includes(name));
    } else if (arg === '--duration-s') {
      const text = value();
      if (!/^[1-9]\d{0,3}$/.test(text)) throw new Error('--duration-s takes whole seconds from 1 to 9999');
      options.durationS = Number(text);
    } else if (arg === '--out') options.out = resolve(value());
    else if (arg === '--evidence') options.evidence = resolve(value());
    else if (arg === '--commit') {
      const text = value();
      if (!/^[0-9a-f]{7,40}$/.test(text)) throw new Error('--commit takes a git commit id');
      options.commit = text;
    } else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

// ------------------------------------------------------------------ one scenario (child process)

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * The instrumented entry: named main.js, so the bundled sidecar's invokedDirectly() check starts
 * the daemon. It writes its rows with one asynchronous append at a time, never a synchronous one:
 * a synchronous write on the loop it measures stalled that loop under the verify's disk I/O
 * (D's CPU profile, 2026-09-27: a 4.0 s gap in appendFileSync).
 */
export const WRAPPER = `import { monitorEventLoopDelay } from 'node:perf_hooks';
import { appendFile } from 'node:fs/promises';
const out = process.env.JEVRIS_LOAD_LAG_FILE;
const h = monitorEventLoopDelay({ resolution: 5 });
const pending = [];
let writing = false;
function flush() {
  if (pending.length === 0) { writing = false; return; }
  writing = true;
  appendFile(out, pending.splice(0).join('')).catch(() => {}).finally(flush);
}
h.enable();
let last = performance.now();
const stalls = [];
setInterval(() => {
  const now = performance.now();
  const gap = now - last - 5;
  if (gap > 40) stalls.push([Date.now(), Math.round(gap)]);
  last = now;
}, 5).unref();
setInterval(() => {
  const line = { t: Date.now(), p50: h.percentile(50) / 1e6, p99: h.percentile(99) / 1e6, max: h.max / 1e6, stalls: stalls.splice(0), rss: process.memoryUsage().rss };
  h.reset();
  pending.push(JSON.stringify(line) + '\\n');
  if (!writing) flush();
}, 1000).unref();
await import(process.env.JEVRIS_LOAD_REAL_ENTRY);
`;

async function sandbox(name) {
  const { testEnvironment, writeHarnessStubs } = await repoModule('scripts', 'test.mjs');
  const root = realpathSync(mkdtempSync(join(tmpdir(), `jl-${name}-`)));
  const home = join(root, 'h');
  const work = join(root, 'w');
  mkdirSync(join(home, '.config'), { recursive: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(join(root, 'wrap'), { recursive: true });
  writeFileSync(join(root, 'wrap', 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(root, 'wrap', 'main.js'), WRAPPER);
  const lagFile = join(root, 'lag.jsonl');
  writeFileSync(lagFile, '');
  const env = {
    ...testEnvironment(home, homedir(), writeHarnessStubs(join(root, 'bin'))),
    JEVRIS_SIDECAR_ENTRY: join(root, 'wrap', 'main.js'),
    JEVRIS_LOAD_REAL_ENTRY: pathToFileURL(join(repoRoot, 'dist', 'sidecar.mjs')).href,
    JEVRIS_LOAD_LAG_FILE: lagFile,
    JEVRIS_SIDECAR_IDLE_MS: '3600000',
  };
  if (resolve(env.HOME) === resolve(homedir()) || resolve(env.JEVRIS_HOME) === resolve(homedir())) throw new Error('refusing: the sandbox home is the real home');
  // This process is the client: sidecarRequest reads JEVRIS_HOME and the rest from process.env.
  for (const key of Object.keys(process.env)) if (/^(JEVRIS_|CLAUDE_|CODEX_)/.test(key)) delete process.env[key];
  Object.assign(process.env, env);
  const git = (...args) => spawnSync('git', ['-c', 'user.email=load@example.invalid', '-c', 'user.name=load', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd: work, env: { ...env, GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' });
  const sidecar = await repoModule('apps', 'sidecar', 'dist', 'index.js');
  const adapter = await repoModule('packages', 'adapter-claude-code', 'dist', 'index.js');
  return { root, home, work, env, lagFile, git, sidecar, adapter };
}

/** `jevris <argv>` as a child, asynchronously, so this process keeps sending hooks meanwhile. */
function jevris(box, argv, timeoutMs = 600_000) {
  return new Promise((done) => {
    const started = performance.now();
    const child = spawn(process.execPath, [join(repoRoot, 'bin', 'jevris.mjs'), ...argv], { cwd: box.work, env: box.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 1_000_000) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 100_000) stderr += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr, ms: performance.now() - started });
    });
  });
}

let serial = 0;
function nativeEvent(kind, { session, agent = null, cwd }) {
  serial += 1;
  const base = { session_id: session, transcript_path: join(cwd, '.no-transcript.jsonl'), cwd, permission_mode: 'default', ...(agent === null ? {} : { agent_id: agent, agent_type: 'general-purpose' }) };
  const tool = { tool_name: 'Bash', tool_use_id: `toolu_${serial}`, tool_input: { command: `grep -rn load src/${serial}` } };
  if (kind === 'pre') return { ...base, hook_event_name: 'PreToolUse', ...tool };
  if (kind === 'post') return { ...base, hook_event_name: 'PostToolUse', ...tool, tool_response: { stdout: 'x'.repeat(4000) } };
  if (kind === 'sstart') return { ...base, hook_event_name: 'SubagentStart' };
  if (kind === 'sstop') return { ...base, hook_event_name: 'SubagentStop', stop_hook_active: false };
  if (kind === 'stop') return { ...base, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: `done ${serial}` };
  if (kind === 'precompact') return { ...base, hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: '' };
  if (kind === 'restore') return { ...base, hook_event_name: 'SessionStart', source: 'compact', model: 'claude-opus-5-5' };
  throw new Error(kind);
}

/** One hook, as the launcher sends it. */
async function hook(box, native) {
  const normalized = box.adapter.normalize(native, {});
  if (!normalized.ok) return { ms: 0, code: `NORMALIZE_${normalized.reasonCode}`, kind: native.hook_event_name };
  const started = performance.now();
  const answer = await box.sidecar.sidecarRequest({
    op: 'event',
    workspace: box.work,
    body: { envelope: normalized.event, deliveryKey: normalized.event.dedupKey, harnessVersion: '2.1.278', ...(normalized.intent ?? {}) },
    scope: 'hook',
    timeoutMs: HOOK_TIMEOUT_MS,
    eventAtMs: Date.now(),
    budget: 'hot',
  });
  const ms = performance.now() - started;
  const code = answer.ok ? (Array.isArray(answer.result?.queued) && answer.result.queued.length > 0 ? 'OK_QUEUED' : answer.result?.duplicate ? 'OK_DUP' : 'OK') : (answer.reasonCode ?? `SIDECAR_${String(answer.reason).toUpperCase()}`);
  return { ms, code, kind: native.hook_event_name };
}

/** `n` concurrent subagents in one parent session. */
async function subagents(box, n, session) {
  const out = [];
  const one = async (i) => {
    const o = { session, agent: `a${i}_${serial}`, cwd: box.work };
    out.push(await hook(box, nativeEvent('sstart', o)));
    for (let c = 0; c < 3; c += 1) {
      out.push(await hook(box, nativeEvent('pre', o)));
      out.push(await hook(box, nativeEvent('post', o)));
    }
    out.push(await hook(box, nativeEvent('sstop', o)));
  };
  await Promise.all(Array.from({ length: n }, (_, i) => one(i)));
  return out;
}

/** Bursts of `n` subagents, 300 ms apart, until `durationMs` has passed (the audit's §4.1 shape). */
async function sustained(box, n, durationMs) {
  const samples = [];
  const end = Date.now() + durationMs;
  let round = 0;
  while (Date.now() < end) {
    round += 1;
    samples.push(...(await subagents(box, n, `load-${round}`)));
    await sleep(300);
  }
  return samples;
}

function loopBetween(box, fromMs, toMs) {
  const rows = readFileSync(box.lagFile, 'utf8').split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line)).filter((row) => row.t >= fromMs && row.t <= toMs + 1000);
  return loopSummary(rows);
}

async function start(box) {
  const started = await jevris(box, ['sidecar', 'start', '--home', box.home, '--wait-ms', '60000']);
  if (started.code !== 0) throw new Error(`sidecar start failed (exit ${started.code})`);
  for (let i = 0; i < 300 && readFileSync(box.lagFile, 'utf8').length === 0; i += 1) await sleep(100);
  if (readFileSync(box.lagFile, 'utf8').length === 0) throw new Error('the instrumented sidecar did not report');
  for (let i = 0; i < 5; i += 1) await hook(box, nativeEvent('pre', { session: 'warm', cwd: box.work }));
  box.settledMs = await settle(box);
}

/**
 * Waits until the fresh sidecar's start-up work is done: two 1 s windows in a row with no loop
 * delay over 100 ms, or 30 s. The targets are about steady load, not a cold start; how long it
 * took is reported with the results.
 */
async function settle(box) {
  const from = Date.now();
  while (Date.now() - from < 30_000) {
    await sleep(1000);
    const rows = readFileSync(box.lagFile, 'utf8').split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
    const recent = rows.slice(-2);
    if (recent.length === 2 && recent.every((row) => row.t > from && row.max < 100)) break;
  }
  return Date.now() - from;
}

async function stop(box) {
  await jevris(box, ['sidecar', 'stop', '--home', box.home], 60_000);
}

function checksFile(box, checks) {
  writeFileSync(join(box.work, 'jevris.checks.json'), `${JSON.stringify({ schemaVersion: 'jevris-checks-1', checks: checks.map((check) => ({ mandatory: true, requirementIds: ['R-1'], description: check.id, ...check })) }, null, 2)}\n`);
}

/** The two facts `jevris certify` leaves, so hook context (restores, Stop reminders) is delivered. */
async function certifyHooks(box, version = '2.1.278') {
  const { generateKeyPairSync } = await import('node:crypto');
  const { jevrisPaths } = await repoModule('packages', 'platform', 'dist', 'index.js');
  const { signRecord } = await repoModule('packages', 'contracts', 'dist', 'index.js');
  const { localKeyId } = await repoModule('apps', 'cli', 'dist', 'certification-store.js');
  const pair = generateKeyPairSync('ed25519');
  const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const dir = join(jevrisPaths({ home: box.home, env: box.env }).data, 'certifications');
  mkdirSync(join(dir, 'keys'), { recursive: true });
  writeFileSync(join(dir, 'keys', 'local.pub.pem'), publicPem);
  const [major, minor] = version.split('.').map(Number);
  const day = 86_400_000;
  const record = {
    id: 'cert-claude-load',
    schemaVersion: '1.0',
    harness: 'claude',
    actuatorId: 'claude.hooks',
    harnessVersionRange: { minimum: `${major}.${minor}.0`, maximumExclusive: `${major}.${minor + 1}.0` },
    operatingSystems: [process.platform],
    models: [],
    tools: [],
    limitations: [],
    fixtureSuiteHash: `sha256:${'a'.repeat(64)}`,
    features: ['hooks.observe', 'hooks.context'].map((featureId) => ({ featureId, status: 'certified', reasonCode: null })),
    certifiedAt: new Date(Date.now() - day).toISOString(),
    expiresAt: new Date(Date.now() + 30 * day).toISOString(),
  };
  writeFileSync(join(dir, 'claude.json'), `${JSON.stringify(signRecord(record, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), localKeyId(publicPem)), null, 2)}\n`);
  const orchestrator = pathToFileURL(join(repoRoot, 'packages', 'orchestrator', 'dist', 'index.js')).href;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(orchestrator)}); await m.recordHarnessVersion(${JSON.stringify(box.home)}, 'claude', ${JSON.stringify(version)});`], { env: box.env, cwd: box.work, encoding: 'utf8' });
  if (run.status !== 0) throw new Error('recording the harness version failed');
}

/**
 * Approves the workspace's checks as `jevris verify approve` records them after a person answers
 * y at a terminal: the CLI refuses --yes and a scripted run (SR-1), and this run has no terminal.
 */
function approveChecks(box) {
  const orchestrator = pathToFileURL(join(repoRoot, 'packages', 'orchestrator', 'dist', 'index.js')).href;
  const script = `const m = await import(${JSON.stringify(orchestrator)}); const p = m.readProposedManifests(${JSON.stringify(box.work)}, process.platform); if (!p.ok) process.exit(1); await m.approveManifests(m.openWorkspace({ home: ${JSON.stringify(box.home)}, workspaceRoot: ${JSON.stringify(box.work)}, platform: process.platform }), p.manifests, p.hashes, 'cli', Date.now());`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: box.env, cwd: box.work, encoding: 'utf8' });
  return { code: run.status ?? 1 };
}

/**
 * Compact restores and Stop reminders from four sessions while `width` subagents run. The four
 * sessions start in the same tick as the burst, so their PreCompacts race the SubagentStarts for
 * the hot slots (D's K3 shape).
 */
async function lifecycleUnder(box, rounds, width, tag) {
  checksFile(box, [{ id: 'unit', argv: [process.execPath, '-e', '0'], resultFormat: 'exit-code' }]);
  box.git('init', '-q');
  box.git('add', '-A');
  box.git('commit', '-q', '-m', 'base');
  if (approveChecks(box).code !== 0) throw new Error('approving the checks failed');
  await certifyHooks(box);
  await start(box);
  const lifecycle = [];
  const burst = [];
  for (let round = 0; round < rounds; round += 1) {
    const load = subagents(box, width, `${tag}-burst-${round}`);
    await Promise.all(
      Array.from({ length: 4 }, async (_, i) => {
        const o = { session: `${tag}-${round}-${i}`, cwd: box.work };
        lifecycle.push(await hook(box, nativeEvent('precompact', o)));
        lifecycle.push(await hook(box, nativeEvent('restore', o)));
        lifecycle.push(await hook(box, nativeEvent('stop', o)));
      }),
    );
    burst.push(...(await load));
    await sleep(300);
  }
  return {
    lifecycle: summarize(lifecycle),
    restoresAndStops: summarize(lifecycle.filter((sample) => sample.kind === 'SessionStart' || sample.kind === 'Stop')),
    subagents: summarize(burst),
  };
}

const SCENARIO_RUNS = {
  async subagents20(box, { durationMs }) {
    box.git('init', '-q');
    box.git('commit', '-q', '--allow-empty', '-m', 'base');
    await start(box);
    const from = Date.now();
    const samples = await sustained(box, 20, durationMs);
    return { hooks: summarize(samples), loop: loopBetween(box, from, Date.now()) };
  },

  async verify8(box, { durationMs }) {
    // Eight checks, each printing 10 MB of TAP lines spread over the run, on a tree with about
    // 80 MB untracked (200 files of 100 KB and a 60 MB artefact), as in the audit's §4.2. The
    // verify run starts first, on a quiet sidecar, and must be running before the hooks start:
    // a verify that the sidecar never ran would measure hooks alone.
    const seconds = Math.max(1, Math.round(durationMs / 1000)) + 15;
    const printer = `const line='ok 1 - '+'x'.repeat(120)+'\\n';const chunk=line.repeat(Math.ceil(1048576/line.length));let i=0;const t=setInterval(()=>{process.stdout.write(chunk);if(++i>=10){clearInterval(t);process.stdout.write('1..1\\n');}},${Math.max(1, Math.round((seconds * 1000) / 10))});`;
    const checks = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, argv: [process.execPath, '-e', printer], resultFormat: 'auto', timeoutMs: 600_000 }));
    checksFile(box, checks);
    mkdirSync(join(box.work, 'out'), { recursive: true });
    box.git('init', '-q');
    box.git('add', '-A');
    box.git('commit', '-q', '-m', 'base');
    writeFileSync(join(box.work, 'big-artifact.tgz'), Buffer.alloc(60 * 1024 * 1024, 98));
    for (let i = 0; i < 200; i += 1) writeFileSync(join(box.work, 'out', `u${i}.txt`), Buffer.alloc(100 * 1024, 99));
    const approved = approveChecks(box);
    if (approved.code !== 0) throw new Error(`verify approve failed (exit ${approved.code})`);
    await start(box);
    const from = Date.now();
    const verified = await jevris(box, ['verify', ...checks.flatMap((check) => ['--check', check.id]), '--json'], 120_000);
    let answer = null;
    try {
      answer = JSON.parse(verified.stdout);
    } catch {
      // not JSON: reported below
    }
    // Reason codes and outcomes only.
    const verify = {
      exit: verified.code,
      ms: Math.round(verified.ms),
      mode: typeof answer?.mode === 'string' ? answer.mode : null,
      sidecar: typeof answer?.sidecar?.reasonCode === 'string' ? answer.sidecar.reasonCode : typeof answer?.sidecar?.state === 'string' ? answer.sidecar.state : null,
      ran: answer?.result?.ran === true,
      // Per check, outcome stays not-run until a check ends; RUNNING or QUEUED is its reasonCode.
      checkStates: Array.isArray(answer?.result?.checks) ? verifyStates(answer.result.checks) : [],
    };
    // The CLI may give up waiting (a TIMEOUT answer in reduced mode) while the sidecar still runs
    // the checks. What counts is the sidecar's own view: a check running, queued or finished.
    const checkIds = checks.map((check) => check.id);
    const started = Date.now();
    let seen = null;
    let last = 'no answer';
    while (seen === null && Date.now() - started < 60_000) {
      const status = await box.sidecar.sidecarRequest({ op: 'verify.status', scope: 'mcp', workspace: box.work, body: { taskId: null, checkIds }, timeoutMs: 10_000 });
      const rows = status.ok ? (status.result?.checks ?? status.result?.result?.checks ?? []) : [];
      const states = verifyStates(rows);
      last = status.ok ? `${rows.length} check(s): ${states.join(', ') || 'none'}` : `verify.status refused: ${String(status.reasonCode ?? status.reason)}`;
      if (verifyUnderway(states)) seen = states;
      else await sleep(500);
    }
    verify.sidecarStates = seen;
    verify.seenAfterMs = Date.now() - from;
    if (seen === null) throw new Error(`the sidecar never ran the verify checks (CLI exit ${verified.code}, mode ${verify.mode}, sidecar ${verify.sidecar}; verify.status for 60 s: ${last})`);
    let running = true;
    const pings = [];
    const cli = [];
    const pingLoop = (async () => {
      while (running) {
        const t0 = performance.now();
        const ping = await box.sidecar.sidecarRequest({ op: 'ping', scope: 'cli', body: {}, timeoutMs: 5000 });
        pings.push({ ms: performance.now() - t0, code: ping.ok ? 'OK' : (ping.reasonCode ?? 'ERROR') });
        await sleep(100);
      }
    })();
    const cliLoop = (async () => {
      while (running) {
        const run = await jevris(box, ['status', '--json'], 60_000);
        const text = `${run.stdout}\n${run.stderr}`;
        cli.push({ ms: run.ms, code: run.code === 0 ? (/TIMEOUT/.test(text) ? 'OK_WITH_TIMEOUT' : 'OK') : /TIMEOUT/.test(text) ? 'TIMEOUT' : `EXIT_${run.code}` });
        await sleep(2000);
      }
    })();
    const hooksFrom = Date.now();
    const samples = await sustained(box, 20, durationMs);
    running = false;
    await Promise.all([pingLoop, cliLoop]);
    return { hooks: summarize(samples), pings: summarize(pings), cliStatus: summarize(cli), loop: loopBetween(box, hooksFrom, Date.now()), verify, verifyLeadMs: hooksFrom - from };
  },

  async subagents50(box, { rounds }) {
    box.git('init', '-q');
    box.git('commit', '-q', '--allow-empty', '-m', 'base');
    await start(box);
    const samples = [];
    for (let round = 0; round < rounds; round += 1) {
      samples.push(...(await subagents(box, 50, `load50-${round}`)));
      await sleep(300);
    }
    const busy = samples.filter((sample) => sample.code === 'BUSY').map((sample) => sample.ms);
    return { hooks: summarize(samples), busyMaxMs: busy.length === 0 ? 0 : Math.round(Math.max(...busy) * 10) / 10 };
  },

  async history(box, { events }) {
    box.git('init', '-q');
    box.git('commit', '-q', '--allow-empty', '-m', 'base');
    await start(box);
    const all = [];
    for (let i = 0; i < events; i += 1) all.push(await hook(box, nativeEvent('pre', { session: 'history', cwd: box.work })));
    return { events, first: summarize(all.slice(0, 200)), last: summarize(all.slice(-200)) };
  },

  async lifecycle(box, { rounds }) {
    return lifecycleUnder(box, rounds, 20, 'life');
  },

  // The same lifecycle hooks during 50 subagents, where a full hot pool once answered them BUSY
  // (D's K3; fixed by B's answer lane).
  async lifecycle50(box, { rounds }) {
    return lifecycleUnder(box, rounds, 50, 'life50');
  },
};

async function runScenario(name, options) {
  const box = await sandbox(name);
  try {
    const result = await SCENARIO_RUNS[name](box, options);
    // Whether the sidecar that took the load still answers (a crash shows as refused connections).
    await sleep(2000);
    const ping = await box.sidecar.sidecarRequest({ op: 'ping', scope: 'cli', body: {}, timeoutMs: 10_000 });
    return { ...result, settledMs: box.settledMs ?? null, aliveAfter: ping.ok === true };
  } finally {
    await stop(box).catch(() => undefined);
    rmSync(box.root, { recursive: true, force: true, maxRetries: 3 });
  }
}

// ------------------------------------------------------------------ the run (parent process)

function scenarioOptions(name, options) {
  const durationMs = (options.durationS ?? (options.quick ? 10 : 60)) * 1000;
  return { durationMs, rounds: options.quick ? 1 : 3, events: options.quick ? 600 : 2600 };
}

function childRun(name, options) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--scenario', name, JSON.stringify(scenarioOptions(name, options))], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), SCENARIO_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      const last = stdout.trim().split(/\r?\n/).at(-1) ?? '';
      try {
        const parsed = JSON.parse(last);
        done(parsed.error === undefined ? { ok: true, result: parsed } : { ok: false, error: String(parsed.error) });
      } catch {
        done({ ok: false, error: `the scenario process ended with exit ${code} and no result` });
      }
    });
  });
}

function gitCommit() {
  const run = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : null;
}

async function main(argv) {
  let options;
  try {
    options = parseLoadArgs(argv);
  } catch (error) {
    console.error(`bench:load: ${error.message}`);
    console.error(USAGE);
    return 2;
  }
  if (!existsSync(join(repoRoot, 'dist', 'sidecar.mjs')) || !existsSync(join(repoRoot, 'apps', 'cli', 'dist', 'release-gates.js'))) {
    console.error('bench:load: build first (npm run build)');
    return 2;
  }
  const gates = await repoModule('apps', 'cli', 'dist', 'release-gates.js');
  const machine = machineOf();
  const reference = gates.describeLoadMachine(gates.SIDECAR_LOAD_REFERENCE);
  const onReference = ['os', 'arch', 'cpuModel', 'cores', 'memoryGb'].every((key) => machine[key] === gates.SIDECAR_LOAD_REFERENCE[key]);
  const load = Math.round(loadavg()[0] * 100) / 100;
  console.error(`bench:load: ${options.only.join(', ')}${options.quick ? ' (quick: a smoke run, not a measurement)' : ''} on ${gates.describeLoadMachine(machine)}; one-minute load ${load}`);
  if (!onReference) console.error(`bench:load: this is not the reference machine (${reference}); the absolute targets are judged there only`);
  const results = {};
  const errors = {};
  for (const name of options.only) {
    const started = Date.now();
    console.error(`bench:load: ${name} ...`);
    const run = await childRun(name, options);
    if (run.ok) results[name] = run.result;
    else errors[name] = run.error;
    console.error(`bench:load: ${name} ${run.ok ? 'done' : `failed: ${run.error}`} (${Math.round((Date.now() - started) / 1000)} s)`);
  }
  const measures = measuresFrom(results);
  const verdicts = gates.judgeSidecarLoad(measures);
  const judged = verdicts.filter((item) => item.value !== null);
  for (const item of verdicts) {
    const state = item.value === null ? 'NOT MEASURED' : item.ok ? 'pass' : 'FAIL';
    console.log(`${state.padEnd(12)} ${item.target.id.padEnd(34)} ${item.value === null ? '-' : String(item.value)} (limit ${item.target.limit} ${item.target.unit}): ${item.target.criterion}`);
  }
  const failed = judged.filter((item) => !item.ok);
  const reportOnly = reportOnlyMeasures(results);
  const proposed = judgeProposed(reportOnly);
  for (const item of proposed) {
    const state = item.value === null ? 'NOT MEASURED' : item.ok ? 'report: met' : 'report: not met';
    console.log(`${state.padEnd(16)} ${item.target.id.padEnd(30)} ${item.value === null ? '-' : String(item.value)} (proposed limit ${item.target.limit} ${item.target.unit}; report-only): ${item.target.criterion}`);
  }
  const scenarioErrors = Object.keys(errors).filter((name) => !REPORT_ONLY_SCENARIOS.includes(name)).length;
  console.log(`bench:load: ${judged.length - failed.length}/${judged.length} measured targets met; ${verdicts.length - judged.length} not measured${scenarioErrors > 0 ? `; ${scenarioErrors} scenario(s) failed to run` : ''}`);
  const record = { schemaVersion: LOAD_SCHEMA, producedAt: new Date().toISOString(), commit: options.commit ?? gitCommit(), machine, reference: gates.SIDECAR_LOAD_REFERENCE, onReference, quick: options.quick, loadAverage: load, node: process.version, measures, verdicts: verdicts.map((item) => ({ id: item.target.id, value: item.value, limit: item.target.limit, ok: item.ok })), reportOnly: proposed.map((item) => ({ id: item.target.id, value: item.value, limit: item.target.limit, ok: item.ok })), results, errors };
  if (options.out !== null) {
    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, `${JSON.stringify(record, null, 2)}\n`);
    console.error(`bench:load: wrote ${options.out}`);
  }
  if (options.evidence !== null) {
    const contracts = await repoModule('packages', 'contracts', 'dist', 'index.js');
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    const evidence = contracts.releaseEvidence({
      kind: 'sidecar-load',
      id: `sidecar-load-${machine.os}`,
      producedAt: record.producedAt.replace(/\.\d{3}Z$/, 'Z'),
      version: pkg.version,
      commit: record.commit,
      tool: 'bench-load',
      os: machine.os,
      arch: machine.arch,
      node: process.version,
      payload: { machine, quick: options.quick, loadAverage: load, measures },
    });
    const checked = contracts.ReleaseEvidenceContract.validate(evidence);
    if (!checked.ok) {
      console.error('bench:load: the evidence record is not valid');
      return 1;
    }
    mkdirSync(dirname(options.evidence), { recursive: true });
    writeFileSync(options.evidence, `${JSON.stringify(evidence, null, 2)}\n`);
    console.error(`bench:load: wrote evidence ${options.evidence}`);
  }
  return failed.length > 0 || scenarioErrors > 0 ? 1 : 0;
}

async function scenarioMain(name, optionsText) {
  if (!SCENARIOS.includes(name)) {
    console.log(JSON.stringify({ error: `unknown scenario ${name}` }));
    return 2;
  }
  try {
    const result = await runScenario(name, JSON.parse(optionsText));
    console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    return 1;
  }
}

const entry = process.argv[1];
if (typeof entry === 'string' && resolve(entry) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--scenario') process.exit(await scenarioMain(argv[1] ?? '', argv[2] ?? '{}'));
  // The whole run holds the host suite lock: a full suite beside it would distort every number.
  const { runHostLocked } = await repoModule('scripts', 'suite-lock.mjs');
  process.exit(await runHostLocked(() => main(argv)));
}
