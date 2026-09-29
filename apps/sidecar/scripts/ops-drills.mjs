#!/usr/bin/env node
/**
 * OBS-05 operations drills. Each drill runs the installed product (its `jevris` command and its
 * hook launcher) in a private home, breaks something the way operations would meet it, and
 * checks that Jevris keeps answering, says what is wrong, and recovers:
 *
 *   crash               SIGKILL the sidecar; the next command starts a healthy one.
 *   read-only-store     the store file is read-only: the store is reported unavailable, commands
 *                       still answer, and it is healthy again once writable.
 *   corrupt-store       the store is overwritten: it is refused with a restore hint and
 *                       `jevris store restore <backup>` brings it back.
 *   disk-full           the store cannot grow (test-mode page limit, the same SQLITE_FULL a full
 *                       disk raises): the fault is reported, commands answer, and a restart after
 *                       space is freed is healthy.
 *   interrupted-update  an update killed the sidecar and a spawner, leaving the runtime files,
 *                       the writer lock, a spawn lock and a migration lock of dead processes:
 *                       the next command comes up healthy.
 *   stale-result        Jev answers only after the decision's deadline: the command answers from
 *                       local rules in time and the late answer is never applied.
 *   rollback            `jevris kill-switch drill` activates the switch, checks it fails closed,
 *                       restores the previous state and records the drill.
 *   offline             Jev is unreachable: decisions fall back to rules and status reports the
 *                       degraded decision health.
 *
 * Library use (A's pack-smoke --full hosts it against the installed tarball):
 *   const { DRILL_IDS, runDrill, operationsPayload } = await import('.../ops-drills.mjs');
 *   const result = await runDrill(id, { packageDir, home, env, bin });   // { passed, recordHash, detail }
 *   operationsPayload(results, { os, ranAgainst: 'installed-tarball' })
 * `env` must be a test environment (JEVRIS_TEST=1, as scripts/test.mjs testEnvironment builds):
 * disk-full's page limit and the local Jev stub work only in test mode.
 *
 * Command line (source tree, for development): node apps/sidecar/scripts/ops-drills.mjs [--out <file>]
 * Nothing here touches the real HOME or the keychain.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const repoModule = (...parts) => import(pathToFileURL(join(repoRoot, ...parts)).href);

export const DRILL_IDS = ['crash', 'read-only-store', 'corrupt-store', 'disk-full', 'interrupted-update', 'stale-result', 'rollback', 'offline'];

/** The per-drill environment: every home variable points at the drill's own home. */
export function drillEnv(env, home) {
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    JEVRIS_HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
  };
}

function waitMs(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** A pid that certainly belongs to no running process: a child that already exited. */
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(child.stdout);
}

class Drill {
  constructor(id, { packageDir, home, env, bin }) {
    this.id = id;
    this.packageDir = packageDir;
    this.bin = bin;
    this.home = realpathSync(mkdtempSync(join(home, `drill-${id}-`)));
    this.env = drillEnv(env, this.home);
    this.work = join(this.home, 'work');
    mkdirSync(this.work, { recursive: true });
    this.steps = [];
  }

  async init() {
    const platform = await repoModule('packages', 'platform', 'dist', 'index.js');
    this.platform = platform;
    this.paths = platform.jevrisPaths({ home: this.home });
    this.db = join(this.paths.data, 'jevris.db');
  }

  /** The last lines of the sidecar's log, for a failed step's detail. */
  sidecarLog() {
    try {
      return readFileSync(join(this.paths.state, 'logs', 'sidecar.log'), 'utf8').split('\n').slice(-40).join('\n');
    } catch {
      return '';
    }
  }

  /** Runs the installed `jevris` with --home, returning { code, stdout, stderr, json }. */
  jevris(args, extraEnv = {}) {
    const env = { ...this.env, ...extraEnv };
    const argv = [...args, '--home', this.home];
    const direct = /\.(mjs|cjs|js)$/.test(this.bin);
    const run = direct
      ? spawnSync(process.execPath, [this.bin, ...argv], { env, cwd: this.work, encoding: 'utf8', timeout: 120_000, windowsHide: true })
      : this.platform.runSync(this.bin, argv, { env, spawnEnv: env, cwd: this.work, timeoutMs: 120_000 });
    const stdout = run.stdout ?? '';
    let json = null;
    try {
      json = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? '');
    } catch {
      json = null;
    }
    return { code: run.status, stdout, stderr: run.stderr ?? '', json };
  }

  /** One hook event through the installed hook launcher. */
  hook(native, extraEnv = {}) {
    const launcher = join(this.packageDir, 'dist', 'hook.mjs');
    const run = spawnSync(process.execPath, [launcher, '--harness', 'claude'], {
      env: { ...this.env, ...extraEnv },
      cwd: this.work,
      input: JSON.stringify(native),
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    });
    return { code: run.status };
  }

  sidecar(extraEnv) {
    return this.jevris(['sidecar', 'status', '--json'], extraEnv).json ?? {};
  }

  step(name, ok, detail = '') {
    this.steps.push({ step: name, ok: ok === true, ...(detail === '' ? {} : { detail: String(detail).slice(0, 300) }) });
    return ok === true;
  }

  cleanup() {
    this.jevris(['sidecar', 'stop']);
    rmSync(this.home, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function crash(d) {
  d.step('start', d.jevris(['sidecar', 'start']).code === 0);
  const before = d.sidecar();
  if (!d.step('running', before.state === 'running' && Number.isSafeInteger(before.pid), JSON.stringify(before))) return;
  process.kill(before.pid, 'SIGKILL');
  for (let i = 0; i < 100 && alive(before.pid); i += 1) await waitMs(100);
  d.step('killed', !alive(before.pid));
  // The next command answers and starts a new sidecar. On a loaded host the cold start can
  // outlast the command's wait, so the answer may say the sidecar is still starting.
  const status = d.jevris(['status', '--json']);
  const state = status.json?.sidecar?.state;
  d.step('a command answers after the crash', status.code === 0 && (state === 'running' || state === 'starting'), status.stdout.slice(0, 200));
  let after = d.sidecar();
  for (let waited = 0; waited < 60_000 && after.state !== 'running'; waited += 500) {
    await waitMs(500);
    after = d.sidecar();
  }
  d.step('a new healthy sidecar', after.state === 'running' && after.pid !== before.pid && after.store?.state === 'ok', JSON.stringify(after.store));
}

function storeFiles(d) {
  return [d.db, `${d.db}-wal`, `${d.db}-shm`].filter((file) => existsSync(file));
}

async function readOnlyStore(d) {
  d.jevris(['sidecar', 'start']);
  d.jevris(['sidecar', 'stop']);
  if (!d.step('store created', existsSync(d.db))) return;
  for (const file of storeFiles(d)) chmodSync(file, 0o444);
  try {
    d.jevris(['sidecar', 'start']);
    const store = d.sidecar().store ?? {};
    d.step('the read-only store is reported, not used', store.state === 'unavailable' && typeof store.diagnostic === 'string', JSON.stringify(store));
    d.step('commands still answer', d.jevris(['status', '--json']).code === 0);
  } finally {
    d.jevris(['sidecar', 'stop']);
    for (const file of storeFiles(d)) chmodSync(file, 0o600);
  }
  d.jevris(['sidecar', 'start']);
  d.step('healthy once writable', d.sidecar().store?.state === 'ok');
}

async function corruptStore(d) {
  d.jevris(['sidecar', 'start']);
  const backup = join(d.home, 'before.db');
  d.step('backup', d.jevris(['store', 'backup', backup]).code === 0 && existsSync(backup));
  d.jevris(['sidecar', 'stop']);
  const fd = openSync(d.db, 'r+');
  writeSync(fd, Buffer.alloc(8192, 0x5a), 0, 8192, 0);
  closeSync(fd);
  for (const file of [`${d.db}-wal`, `${d.db}-shm`]) rmSync(file, { force: true });
  d.jevris(['sidecar', 'start']);
  const refused = d.sidecar().store ?? {};
  d.step('the damaged store is refused with a restore hint', refused.state === 'unavailable' && /restore/.test(refused.diagnostic ?? ''), JSON.stringify(refused));
  d.step('commands still answer', d.jevris(['status', '--json']).code === 0);
  const restored = d.jevris(['store', 'restore', backup]);
  d.step('store restore', restored.code === 0, restored.stderr || restored.stdout);
  d.jevris(['sidecar', 'start']);
  d.step('healthy after restore', d.sidecar().store?.state === 'ok');
}

async function diskFull(d) {
  if (!d.step('test mode', d.env.JEVRIS_TEST === '1', 'disk-full injects its page limit only with JEVRIS_TEST=1')) return;
  const full = { JEVRIS_TEST_STORE_FREE_PAGES: '0' };
  d.jevris(['sidecar', 'start'], full);
  let store = {};
  for (let i = 0; i < 400; i += 1) {
    d.hook({ hook_event_name: 'PostToolUse', session_id: 'disk-full', cwd: d.work, tool_use_id: `toolu_${i}`, tool_name: 'Read', tool_input: { file_path: join(d.work, `f${i}.ts`) }, tool_response: { file: { content: 'x' } } }, full);
    if (i % 20 !== 19) continue;
    store = d.sidecar().store ?? {};
    if (store.fault !== null && store.fault !== undefined) break;
  }
  d.step('the full store is reported', store.fault === 'store-full' && store.state === 'unavailable', JSON.stringify(store));
  d.step('commands still answer', d.jevris(['status', '--json']).code === 0);
  d.jevris(['sidecar', 'stop']);
  d.jevris(['sidecar', 'start']);
  d.step('healthy after space is freed and a restart', d.sidecar().store?.state === 'ok');
}

async function interruptedUpdate(d) {
  d.jevris(['sidecar', 'start']);
  const before = d.sidecar();
  if (!d.step('running', Number.isSafeInteger(before.pid))) return;
  // The update kills the running sidecar: its endpoint, pidfile and writer lock stay behind.
  process.kill(before.pid, 'SIGKILL');
  for (let i = 0; i < 100 && alive(before.pid); i += 1) await waitMs(100);
  const gone = deadPid();
  // A spawner the update killed held the spawn lock.
  writeFileSync(join(d.paths.runtime, 'spawn.lock'), JSON.stringify({ pid: gone, atMs: Date.now() }), { mode: 0o600 });
  // A migration the update started holds the migration lock.
  try {
    const require = createRequire(join(d.packageDir, 'package.json'));
    const Database = require('better-sqlite3');
    const db = new Database(d.db);
    db.prepare('INSERT INTO migration_lock (id, holder, holder_pid, acquired_at_ms) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET holder = excluded.holder, holder_pid = excluded.holder_pid, acquired_at_ms = excluded.acquired_at_ms').run('interrupted-update', gone, Date.now());
    db.close();
    d.step('migration lock left behind', true);
  } catch (error) {
    d.step('migration lock left behind', false, error instanceof Error ? error.message : String(error));
  }
  const status = d.jevris(['status', '--json']);
  d.step('the next command answers from a fresh sidecar', status.code === 0 && status.json?.sidecar?.state === 'running', status.stdout.slice(0, 200));
  const after = d.sidecar();
  d.step('healthy store after the takeover', after.state === 'running' && after.pid !== before.pid && after.store?.state === 'ok', JSON.stringify(after.store));
}

/** A local Jev stub (test mode only): { env, requests(), stop() }. */
async function jevStub(scenario, lateMs) {
  const cleanups = [];
  const { startJevStub } = await repoModule('test', 'acceptance', 'jev-stub.mjs');
  const stub = await startJevStub({ after: (fn) => cleanups.push(fn) }, { scenario, lateMs });
  return { ...stub, stop: () => cleanups.forEach((fn) => fn()) };
}

async function staleResult(d) {
  const stub = await jevStub('late', 20_000);
  try {
    d.jevris(['sidecar', 'start'], stub.env);
    const started = Date.now();
    const recover = d.jevris(['recover', '--failure', 'TypeError at app/parse.ts:14', '--failure', 'TypeError at app/parse.ts:14', '--json'], stub.env);
    const elapsed = Date.now() - started;
    d.step('answers from local rules before the late answer', recover.code === 0 && typeof recover.json?.result?.action === 'string' && elapsed < 20_000, `${elapsed} ms`);
    d.step('Jev was asked', stub.requests().length >= 1);
    // The decision is mirrored into the store when the engine settles it. On a loaded machine the
    // command can answer from local rules (its request deadline passed) a moment before that, so
    // status is polled for a bounded time. When the answer names its decision (the recover
    // payload's decisionId), that decision is the one checked; otherwise the deadline decision.
    const decisionId = typeof recover.json?.result?.decisionId === 'string' ? recover.json.result.decisionId : null;
    const wanted = (row) => (decisionId !== null ? row.decisionId === decisionId : row.reasonCode === 'DEADLINE');
    let status;
    let decisions = [];
    const until = Date.now() + 15_000;
    do {
      status = d.jevris(['status', '--json'], stub.env);
      decisions = status.json?.result?.recentDecisions ?? [];
      if (decisions.some(wanted)) break;
      await waitMs(250);
    } while (Date.now() < until);
    const late = decisions.find(wanted);
    d.step(
      'the late answer is not applied',
      late !== undefined && late.outcome !== 'applied' && decisions.every((row) => row.outcome !== 'applied'),
      JSON.stringify(decisions) + (late === undefined ? ` status ${status.code} ${status.stdout.slice(0, 600)} log ${d.sidecarLog()}` : ''),
    );
  } finally {
    d.jevris(['sidecar', 'stop']);
    stub.stop();
  }
}

async function rollback(d) {
  d.jevris(['sidecar', 'start']);
  const drill = d.jevris(['kill-switch', 'drill', '--json']);
  d.step('kill-switch drill passed and recorded', drill.code === 0 && drill.json?.passed === true && drill.json?.recorded === true, drill.stdout.slice(0, 300));
  const status = d.jevris(['kill-switch', 'status', '--json']);
  d.step('the previous state is restored', status.code === 0 && /clear/.test(status.stdout), status.stdout.slice(0, 200));
  d.step('the sidecar is healthy', d.sidecar().state === 'running');
}

async function offline(d) {
  const net = await import('node:net');
  const server = net.createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  const env = { JEVRIS_TEST_PROVIDER_URL: `http://127.0.0.1:${port}`, JEVRIS_TEST_PROVIDER_KEY: 'offline-drill' };
  d.jevris(['sidecar', 'start'], env);
  const recover = d.jevris(['recover', '--failure', 'TypeError at app/parse.ts:14', '--failure', 'TypeError at app/parse.ts:14', '--json'], env);
  d.step('decisions fall back to local rules', recover.code === 0 && typeof recover.json?.result?.action === 'string', recover.stderr.slice(0, 200));
  const status = d.jevris(['status', '--json'], env);
  d.step('status reports degraded decision health', status.code === 0 && status.json?.result?.decisionHealth === 'degraded', JSON.stringify(status.json?.result?.decisionHealth ?? status.stdout.slice(0, 200)));
}

const DRILLS = {
  crash,
  'read-only-store': readOnlyStore,
  'corrupt-store': corruptStore,
  'disk-full': diskFull,
  'interrupted-update': interruptedUpdate,
  'stale-result': staleResult,
  rollback,
  offline,
};

/** Runs one drill. Never throws: a failure is `passed: false` with the step that failed. */
export async function runDrill(id, { packageDir, home, env, bin }) {
  const contracts = await repoModule('packages', 'contracts', 'dist', 'index.js');
  if (!(id in DRILLS)) return { passed: false, recordHash: null, detail: `unknown drill ${id}` };
  const drill = new Drill(id, { packageDir, home, env, bin });
  try {
    await drill.init();
    await DRILLS[id](drill);
  } catch (error) {
    drill.step('drill ran', false, error instanceof Error ? error.message : String(error));
  } finally {
    try {
      drill.cleanup();
    } catch {
      // best effort
    }
  }
  const passed = drill.steps.length > 0 && drill.steps.every((step) => step.ok);
  const record = { drill: id, os: process.platform, passed, steps: drill.steps };
  const failed = drill.steps.find((step) => !step.ok);
  return { passed, recordHash: contracts.contentHash(record), detail: failed === undefined ? `${drill.steps.length} steps passed` : `${failed.step}: ${failed.detail ?? 'failed'}`, steps: drill.steps };
}

/** The `operations-drills` payload from runDrill results keyed by id. */
export function operationsPayload(results, { os = process.platform, ranAgainst = 'installed-tarball' } = {}) {
  return { os, ranAgainst, drills: DRILL_IDS.map((id) => ({ id, passed: results[id]?.passed === true, recordHash: results[id]?.recordHash ?? null })) };
}

async function main(argv) {
  const outAt = argv.indexOf('--out');
  const only = argv.filter((arg, index) => !arg.startsWith('--') && argv[index - 1] !== '--out');
  const { testEnvironment, writeHarnessStubs } = await repoModule('scripts', 'test.mjs');
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'jops-')));
  const env = testEnvironment(home, homedir(), writeHarnessStubs(mkdtempSync(join(tmpdir(), 'jops-bin-'))));
  const results = {};
  try {
    for (const id of only.length > 0 ? only : DRILL_IDS) {
      results[id] = await runDrill(id, { packageDir: repoRoot, home, env, bin: join(repoRoot, 'bin', 'jevris.mjs') });
      console.log(`${id}: ${results[id].passed ? 'pass' : 'FAIL'} (${results[id].detail})`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
  if (outAt >= 0) {
    const out = resolve(argv[outAt + 1]);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(operationsPayload(results, { ranAgainst: 'source-tree' }), null, 2)}\n`);
  }
  return Object.values(results).every((result) => result.passed) ? 0 : 1;
}

const entry = process.argv[1];
if (typeof entry === 'string' && resolve(entry) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));

