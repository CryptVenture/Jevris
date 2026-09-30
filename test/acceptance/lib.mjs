/**
 * Story and workflow acceptance (RLS-02, RLS-03, SSOT §13, §14, §22.2).
 *
 * One file per story (`usNN.test.mjs`) or workflow (`wNN.test.mjs`) drives the real product:
 * the built `jevris` CLI, the hook launcher, the MCP server and a real sidecar, each in a
 * sandbox of its own (temporary home and workspace, stub harness binaries, the OS keychain
 * blocked). A story asserts every Then clause of fixtures/ssot/user-stories.json by its exact
 * text:
 *
 *   story('US01', async ({ then, sandbox }) => {
 *     const box = await sandbox();
 *     ...
 *     await then('Only Jevris-owned entries change', () => { assert... });
 *     await then('a concurrent user edit is preserved and data deletion is a separate choice', () => { ... });
 *   });
 *
 * A story or workflow blocked on work that has not landed is declared with `pending(id, why)`.
 * It creates no test (npm test has no skipped acceptance test) and the report counts it as
 * failed, so the release gate still sees the gap.
 *
 * With JEVRIS_ACCEPTANCE_OUT set, every story, workflow and pending entry writes one JSON
 * record there; scripts/acceptance-report.mjs turns them into the story-report and
 * workflow-report release evidence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { removeTree, windowsProcesses } from '../../scripts/remove-tree.mjs';
import { withStubPath, writeHarnessStubs } from '../../scripts/test.mjs';
import { managedHostSkip } from '../managed-host.mjs';

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** The canonical user stories (SSOT §14). */
export const STORIES = JSON.parse(readFileSync(join(repoRoot, 'fixtures', 'ssot', 'user-stories.json'), 'utf8'));
export const STORY_IDS = STORIES.map((item) => item.id);
export const WORKFLOW_IDS = Array.from({ length: 12 }, (_, i) => `W${String(i + 1).padStart(2, '0')}`);

/** The Then clauses of one story: its `then` text split at semicolons, final period dropped. */
export function thenClauses(id) {
  const found = STORIES.find((item) => item.id === id);
  if (found === undefined) throw new Error(`unknown story ${id}`);
  return found.then
    .split(/;\s*/)
    .map((clause) => clause.trim().replace(/\.$/, ''))
    .filter((clause) => clause.length > 0);
}

/**
 * The product under test. By default the repository build; JEVRIS_ACCEPTANCE_ROOT names an
 * installed package directory (or a runtime copy) to run the same suite against.
 */
export function product(root = process.env.JEVRIS_ACCEPTANCE_ROOT ?? repoRoot) {
  return {
    root,
    bin: join(root, 'bin', 'jevris.mjs'),
    mcp: join(root, 'plugins', 'shared', 'mcp.js'),
    hook: join(root, 'dist', 'hook.mjs'),
  };
}

/** The actor the CLI sends for a person (`jevris authorize`, `budget update`, `plan --submit`): the OS user, cleaned as the CLI cleans it. */
export function actorOf(env) {
  const cleaned = (env.USER ?? env.USERNAME ?? 'cli').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 63);
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `u${cleaned}`.slice(0, 64);
}

/** Imports a repository package's built entry (contracts, adapters) to validate product output. */
export function load(pkg) {
  return import(pathToFileURL(join(repoRoot, 'packages', pkg, 'dist', 'index.js')).href);
}

export function sha256(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function run(file, args, { env, cwd, input, timeoutMs = 60_000 }) {
  const result = spawnSync(process.execPath, [file, ...args], { env, cwd, input, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '', signal: result.signal ?? null };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * A fresh sandbox: temporary home and git-marked workspace, the runner's environment minus any
 * Jevris or harness setting, and helpers that drive the product inside it. Cleaned up when the
 * test ends (the sidecar is stopped first).
 */
export async function sandbox(t, options = {}) {
  const target = product(options.root);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-accept-')));
  const home = join(dir, 'home');
  const work = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(work, '.git'), { recursive: true });
  // The runner's JEVRIS_SIDECAR_WAIT_MS is kept: it acts only in a test run, and lets a loaded
  // host's slower sidecar cold start (Windows) outlast the CLI's product wait.
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue;
    if (/^(JEVRIS_|CLAUDE_|CODEX_|XDG_)/.test(key) && !/^JEVRIS_(TEST|NO_LIVE_HARNESS|HARNESS_STUB_DIR|STUB_LOG|SIDECAR_WAIT_MS)$/.test(key)) continue;
    env[key] = value;
  }
  // Defence in depth: scripts/test.mjs already puts its harness stubs first on PATH; a story run
  // any other way (node --test <file>) gets its own, so no real claude, codex, kilo, opencode or
  // agy can start. The product also refuses a login probe outside the real home.
  if (typeof env.JEVRIS_HARNESS_STUB_DIR !== 'string' || env.JEVRIS_HARNESS_STUB_DIR.length === 0) {
    const stubs = writeHarnessStubs(join(dir, 'bin'));
    Object.assign(env, withStubPath(env, stubs), { JEVRIS_NO_LIVE_HARNESS: '1', JEVRIS_HARNESS_STUB_DIR: stubs, JEVRIS_STUB_LOG: join(stubs, 'calls.log') });
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    JEVRIS_HOME: home,
    JEVRIS_BIN: target.bin,
    CLAUDE_PROJECT_DIR: work,
    ...(options.env ?? {}),
  });
  // What the story started that runs on (MCP clients, long-running product processes): closed at
  // teardown before the sandbox is removed. Windows refuses to remove a folder that is a live
  // process's working folder, and node:test runs after-hooks in the order they were added, so a
  // hook of their own would run after the removal.
  const closers = [];
  const box = {
    dir,
    home,
    work,
    env,
    product: target,
    /** Runs `jevris <argv>`; `json: true` adds --json and parses stdout. */
    jevris(argv, { input, json = false, cwd = work, extraEnv = {} } = {}) {
      const out = run(target.bin, json ? [...argv, '--json'] : argv, { env: { ...env, ...extraEnv }, cwd, input });
      return { ...out, json: json ? parseJson(out.stdout) : null };
    },
    /** Runs the hook launcher for one harness with a native event on stdin. */
    hook(harness, native, { event, extraEnv = {}, timeoutMs = 20_000 } = {}) {
      const args = ['--harness', harness, ...(event !== undefined ? ['--event', event] : [])];
      const out = run(target.hook, args, { env: { ...env, JEVRIS_HOOK_DEBUG: '1', ...extraEnv }, cwd: work, input: typeof native === 'string' ? native : JSON.stringify(native), timeoutMs });
      const reason = /jevris-hook \S+ (\S+)/.exec(out.stderr)?.[1] ?? null;
      return { ...out, reason };
    },
    /** A connected MCP client over stdio (the SDK validates structuredContent). */
    async mcp(extraEnv = {}) {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      const transport = new StdioClientTransport({ command: process.execPath, args: [target.mcp], env: { ...env, ...extraEnv }, cwd: work, stderr: 'ignore' });
      const client = new Client({ name: 'jevris-acceptance', version: '1.0.0' });
      await client.connect(transport);
      closers.push(() => client.close().catch(() => {}));
      return client;
    },
    /**
     * Registers `close` to run at teardown before the sidecar stops and the sandbox is removed
     * (an MCP client a story connects itself, say). A story's own t.after would run after the
     * removal, and on Windows the live process would keep the folder.
     */
    closeAtTeardown(close) {
      closers.push(close);
    },
    startSidecar() {
      // The CLI waits 5 s by default, then answers "starting" while the sidecar keeps starting.
      // A loaded CI cell can take longer to boot it, so the sandbox waits up to 60 s: a start
      // that never finishes still fails, a slow one does not (load triage, r22).
      return box.jevris(['sidecar', 'start', '--home', home, '--wait-ms', '60000']);
    },
    stopSidecar() {
      return box.jevris(['sidecar', 'stop', '--home', home]);
    },
    /** Writes a file under the sandbox (relative to the sandbox directory). */
    write(rel, text) {
      const full = join(dir, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, typeof text === 'string' ? text : `${JSON.stringify(text, null, 2)}\n`);
      return full;
    },
    read(rel) {
      return readFileSync(join(dir, rel), 'utf8');
    },
    /** Runs git in the workspace with a fixed identity and no signing; never the user's config. */
    git(...args) {
      const out = spawnSync('git', ['-c', 'user.email=acceptance@example.invalid', '-c', 'user.name=acceptance', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
        cwd: work,
        env: { ...env, GIT_CONFIG_NOSYSTEM: '1' },
        encoding: 'utf8',
        windowsHide: true,
      });
      return { code: out.status ?? 1, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
    },
    /** Makes the workspace a real git repository with one commit of its current files (owned worktrees need one). */
    gitInit() {
      rmSync(join(work, '.git'), { recursive: true, force: true });
      // core.autocrlf off in the repository itself, so the product's own git (which reads the
      // host's config) keeps line endings as written too: Git for Windows turns it on in its
      // system config, and a checkout would then turn '\n' into '\r\n'.
      for (const args of [['init', '-q'], ['config', 'core.autocrlf', 'false'], ['add', '-A'], ['commit', '-q', '--allow-empty', '-m', 'base']]) {
        const out = box.git(...args);
        assert.equal(out.code, 0, `git ${args[0]}: ${out.stderr}`);
      }
    },
    /**
     * Scripted owned workers (D's test worker port): writes the test-home marker the port requires
     * and the script (`runs` in the jevris-test-worker-1 format), and names it in the sandbox
     * environment. Call it before anything starts the sidecar, which reads its environment once.
     */
    async workerScript(runs) {
      const { jevrisPaths } = await load('platform');
      const state = jevrisPaths({ home }).state;
      mkdirSync(state, { recursive: true, mode: 0o700 });
      const marker = join(state, 'test-home.json');
      writeFileSync(marker, `${JSON.stringify({ schemaVersion: 'jevris-test-home-1' })}\n`, { mode: 0o600 });
      chmodSync(marker, 0o600);
      const file = join(dir, 'worker-script.json');
      writeFileSync(file, `${JSON.stringify({ schemaVersion: 'jevris-test-worker-1', runs }, null, 2)}\n`);
      env.JEVRIS_TEST = '1';
      env.JEVRIS_TEST_WORKER_SCRIPT = file;
      return file;
    },
    /**
     * The person-only verification changes (SR-1). `verify approve`, `verify issuer add` and
     * `verify waive` need a person at an interactive terminal and refuse --yes, so a story run
     * (no terminal) cannot make them through the CLI. These write the same host-ledger records
     * through D's orchestrator, as the CLI does after a person answers y. Each answers
     * `{ code: 0 }` when it recorded the change and `{ code: 1, reason }` when it did not.
     */
    async approveChecks() {
      const orchestrator = await load('orchestrator');
      const proposed = orchestrator.readProposedManifests(work, process.platform);
      if (!proposed.ok) return { code: 1, reason: proposed.reason };
      const ws = orchestrator.openWorkspace({ home, workspaceRoot: work, platform: process.platform });
      const record = await orchestrator.approveManifests(ws, proposed.manifests, proposed.hashes, 'cli', Date.now());
      return { code: 0, approved: Object.keys(record.hashes).sort() };
    },
    /** One request to the sandbox sidecar with the CLI's key and scope, as the CLI sends it. */
    sidecar(op, body) {
      const client = pathToFileURL(join(repoRoot, 'apps', 'sidecar', 'dist', 'index.js')).href;
      const script = `const { sidecarRequest } = await import(${JSON.stringify(client)}); const r = await sidecarRequest({ home: process.env.JEVRIS_HOME, op: ${JSON.stringify(op)}, scope: 'cli', workspace: ${JSON.stringify(work)}, body: ${JSON.stringify(body)}, timeoutMs: 30000 }); process.stdout.write(JSON.stringify(r));`;
      const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, cwd: work, encoding: 'utf8', timeout: 60_000, windowsHide: true });
      assert.equal(out.status, 0, out.stderr);
      return JSON.parse(out.stdout);
    },
    /**
     * A new root budget needs a person (SR-1): `plan --submit` creates one only with an
     * authorization minted at a terminal (`jevris authorize budget.increase --scope <id>`, which
     * a story run cannot answer). This sends the request that command sends, for the sandbox user,
     * and returns the single-use authorization id to pass as `--authorization`. It starts the
     * sidecar if it is not running.
     */
    authorizeBudget(budgetId) {
      assert.equal(box.startSidecar().code, 0, 'the sidecar did not start');
      const minted = box.sidecar('authorization.mint', { actionClass: 'budget.increase', scope: budgetId, ttlMs: 300_000, actor: actorOf(env), channel: 'terminal' });
      assert.equal(minted.ok, true, JSON.stringify(minted));
      return minted.result.authorizationId;
    },
    async trustIssuer(issuerId, keyFile, { keyId = 'default', repository = null } = {}) {
      const orchestrator = await load('orchestrator');
      const ws = orchestrator.openWorkspace({ home, workspaceRoot: work, platform: process.platform });
      await orchestrator.addTrustedIssuer(ws, { issuerId, keys: { [keyId]: readFileSync(keyFile, 'utf8') }, repository }, Date.now());
      return { code: 0 };
    },
    async waive(checkId, reason, authority) {
      const orchestrator = await load('orchestrator');
      const ws = orchestrator.openWorkspace({ home, workspaceRoot: work, platform: process.platform });
      const waiver = await orchestrator.waiveCheck(ws, checkId, authority, reason, Date.now());
      return { code: 0, waiver };
    },
    /** Starts a long-running product process (for cancellation and crash scenarios). */
    spawn(file, args, opts = {}) {
      const child = spawn(process.execPath, [file, ...args], { env: { ...env, ...(opts.env ?? {}) }, cwd: opts.cwd ?? work, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      closers.push(async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill();
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
      });
      return child;
    },
  };
  t.after(async () => {
    for (const close of closers.splice(0)) await close();
    // Any jevris command can start the sidecar on demand, so it is always stopped here, whether
    // or not the story started it; stopping one that is not running is harmless.
    box.stopSidecar();
    // A sidecar that did not answer stop (a hung provider stub, say) is ended through its pid
    // file, and a sandbox sidecar that survives teardown fails the test.
    const { jevrisPaths } = await load('platform');
    const pidFile = join(jevrisPaths({ home, env }).runtime, 'sidecar.pid');
    let pid;
    try {
      pid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
    } catch {
      pid = undefined;
    }
    // Only a live process whose command line names this sandbox's home is touched, so a stale pid
    // file whose number the OS gave to another process never signals that process.
    if (pid !== undefined && Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid && sandboxSidecar(pid, home)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already gone
      }
      for (let i = 0; i < 600 && alive(pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
      const survived = alive(pid);
      if (survived) process.kill(pid, 'SIGKILL');
      await sweepAndRemove(dir, t, options.keep === true);
      assert.equal(survived, false, `the sandbox sidecar ${pid} survived sidecar stop and SIGTERM`);
      return;
    }
    await sweepAndRemove(dir, t, options.keep === true);
  });
  return box;
}


/**
 * Ends every sidecar whose command line names this sandbox folder: one the pid file does not
 * know (a second sidecar started on demand, or one restarted after a crash scenario) would
 * otherwise outlive the test with its folder deleted. Each one found is named on stderr with
 * the test, so the story that leaks it can be fixed. POSIX `ps` only.
 */
/** Every process's pid and command line: `ps` on POSIX, CIM on Windows. */
function commandLines() {
  if (process.platform === 'win32') return windowsProcesses().map((row) => ({ pid: row.pid, args: row.commandLine }));
  const ps = spawnSync('ps', ['-Ao', 'pid=,args='], { encoding: 'utf8', shell: false });
  if (ps.status !== 0) return [];
  return ps.stdout
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((match) => match !== null)
    .map((match) => ({ pid: Number(match[1]), args: match[2] }));
}

/**
 * Ends any sidecar still running for this sandbox that the pid file did not name (one a client
 * with another locality started, say), then removes the sandbox. On Windows, where listing the
 * processes costs a PowerShell start, the sweep runs only when the removal fails: a sidecar
 * running there holds its store, so a removal that succeeds leaves none behind.
 */
async function sweepAndRemove(dir, t, keep) {
  if (process.platform !== 'win32') {
    await sweepSandboxSidecars(dir, t);
    if (!keep) removeTree(dir);
    return;
  }
  if (keep) return;
  try {
    removeTree(dir);
  } catch {
    await sweepSandboxSidecars(dir, t);
    removeTree(dir);
  }
}

async function sweepSandboxSidecars(dir, t) {
  const names = process.platform === 'win32' ? [dir.toLowerCase()] : [dir, dir.replace(/^\/private(?=\/)/, '')];
  const pids = commandLines()
    .filter(({ args }) => {
      const text = process.platform === 'win32' ? args.toLowerCase() : args;
      return text.includes('sidecar') && names.some((name) => text.includes(name));
    })
    .map(({ pid }) => pid)
    .filter((pid) => pid > 1 && pid !== process.pid);
  for (const pid of pids) {
    process.stderr.write(`acceptance: ${t.name}: ended a leftover sandbox sidecar ${pid} that the pid file did not name\n`);
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  for (const pid of pids) {
    for (let i = 0; i < 600 && alive(pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    if (alive(pid)) process.kill(pid, 'SIGKILL');
  }
}

/** True when `pid` is a live sidecar started for this sandbox home. */
function sandboxSidecar(pid, home) {
  if (!alive(pid)) return false;
  const row = commandLines().find((entry) => entry.pid === pid);
  if (row === undefined) return false;
  const args = process.platform === 'win32' ? row.args.toLowerCase() : row.args;
  return args.includes('sidecar') && args.includes(process.platform === 'win32' ? home.toLowerCase() : home);
}

/** True while a process with this pid exists. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function writeRecord(record) {
  const out = process.env.JEVRIS_ACCEPTANCE_OUT;
  if (typeof out !== 'string' || out.length === 0) return;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * A thrown scenario error on one line, keeping both ends: the start says what failed and the end
 * usually says why (a CLI answer's JSON ends with the summary and the reason codes). Cutting to
 * the first 300 characters lost that on a Windows-only flake, so the last 1500 stay too.
 */
export function oneLine(message, head = 300, tail = 1500) {
  const text = String(message).replace(/\s+/g, ' ').trim();
  if (text.length <= head + tail) return text;
  return `${text.slice(0, head)} [... ${String(text.length - head - tail)} characters omitted ...] ${text.slice(text.length - tail)}`;
}

async function runScenario(kind, id, title, fn, t) {
  const clauses = [];
  const evidence = [];
  const then = async (label, check) => {
    try {
      await check();
      clauses.push({ label, ok: true });
    } catch (error) {
      clauses.push({ label, ok: false, error: oneLine(error?.message ?? error) });
    }
  };
  const record = (value) => {
    evidence.push(sha256(value));
    return value;
  };
  let thrown = null;
  try {
    await fn({ t, then, evidence: record, sandbox: (options) => sandbox(t, options) });
  } catch (error) {
    thrown = oneLine(error?.message ?? error);
  }
  const failures = [
    ...clauses.filter((clause) => !clause.ok).map((clause) => `${clause.label}: ${clause.error}`),
    ...(thrown === null ? [] : [`scenario failed: ${thrown}`]),
  ];
  if (kind === 'story') {
    const missing = thenClauses(id).filter((clause) => !clauses.some((item) => item.label === clause));
    for (const clause of missing) failures.push(`${clause}: not asserted`);
  }
  if (clauses.length === 0) failures.push('no Then clause was asserted');
  const passed = failures.length === 0;
  writeRecord({ kind, id, title, passed, pending: false, thenClauses: clauses.length, clauses, failures: failures.slice(0, 64), evidence: evidence.slice(0, 64) });
  assert.deepEqual(failures, [], `${id} ${title}`);
}

/** One user story: `fn({ then, sandbox, evidence, t })` asserts every Then clause of `id`. */
export function story(id, fn) {
  const found = STORIES.find((item) => item.id === id);
  if (found === undefined) throw new Error(`unknown story ${id}`);
  const title = found.want;
  // On a machine with a real managed policy (GOV-05) the product rightly ignores the test's
  // managed dir, so a story cannot run there; it is skipped, writes no record, and the
  // acceptance report counts it missing rather than passed.
  test(`${id}: ${title}`, { timeout: 300_000, skip: managedHostSkip() }, (t) => runScenario('story', id, title, fn, t));
}

/** One end-to-end workflow (SSOT §13); `evidence(value)` records a hash of a product output. */
export function workflow(id, title, fn) {
  if (!WORKFLOW_IDS.includes(id)) throw new Error(`unknown workflow ${id}`);
  test(`${id}: ${title}`, { timeout: 600_000, skip: managedHostSkip() }, (t) => runScenario('workflow', id, title, fn, t));
}

/**
 * A story or workflow that cannot pass yet because `blockedOn` has not landed. No test is
 * created; the report records it as failed with the reason.
 */
export function pending(id, blockedOn) {
  const isStory = STORY_IDS.includes(id);
  if (!isStory && !WORKFLOW_IDS.includes(id)) throw new Error(`unknown story or workflow ${id}`);
  if (typeof blockedOn !== 'string' || blockedOn.length < 3) throw new Error(`pending ${id} needs the owner and requirement it waits for`);
  writeRecord({
    kind: isStory ? 'story' : 'workflow',
    id,
    title: isStory ? STORIES.find((item) => item.id === id).want : id,
    passed: false,
    pending: true,
    thenClauses: isStory ? thenClauses(id).length : 0,
    clauses: [],
    failures: [`pending: blocked on ${blockedOn}`],
    evidence: [],
  });
}
