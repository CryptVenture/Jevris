// Imported into every test process by scripts/test.mjs (NODE_OPTIONS --import, after the serial
// gate). It acts only in the process node:test starts for a test file, and only while
// JEVRIS_TEST_FILE_SILENT_S names a bound.
//
// A test file must not outlive a hard bound. node:test's --test-timeout ends a test, but not a
// file whose tests are done while its process stays up: a leaked child that holds the file's
// pipes open kept one file idle for 33 minutes, and the host suite lock with it. So the file's
// process notes each write it makes to stdout or stderr (node:test streams every test event to
// the runner through stdout). Once it has been silent for the bound, it:
// - writes one line to stderr naming the file, the bound and FILE_SILENT_BOUND;
// - sends SIGTERM to every process it started (their descendants too), then SIGKILL to any still
//   running after a short grace;
// - exits 1, so the runner reports the file as failed and the whole run fails.
// The owner watch (scripts/test-owner-watch.mjs) ends any process that had already left the tree.
// The timer is unref'd, so it never keeps a finished file alive. The clock starts when this module
// loads, after the serial gate's wait, so a latency-bound file's wait for its turn never counts.
import { spawnSync } from 'node:child_process';
import { relative } from 'node:path';

export const FILE_SILENT_ENV = 'JEVRIS_TEST_FILE_SILENT_S';
export const FILE_SILENT_REASON = 'FILE_SILENT_BOUND';
/** The runner's default: well above --test-timeout (120 s), so a slow test is never cut. */
export const DEFAULT_FILE_SILENT_S = 600;
const TEST_FILE = /\.test\.[cm]?js$/;
const GRACE_MS = 2000;
let installed = false;

/** The bound in milliseconds from `env`, or null when absent or malformed. */
export function silentBoundMs(env) {
  const raw = env[FILE_SILENT_ENV];
  if (typeof raw !== 'string' || !/^[1-9]\d{0,5}$/.test(raw)) return null;
  return Number(raw) * 1000;
}

/**
 * The pids of every process below `root`, deepest last, from one process listing of
 * [pid, ppid] or [pid, ppid, created] entries. Windows reuses pids and keeps a dead parent's pid
 * on its children, so where creation times are known a child must not predate its parent.
 */
export function descendants(root, listing = psListing) {
  const children = new Map();
  const created = new Map();
  for (const [pid, ppid, at] of listing()) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
    if (typeof at === 'number') created.set(pid, at);
  }
  const out = [];
  const queue = [root];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const pid of children.get(parent) ?? []) {
      if (pid === root || out.includes(pid)) continue;
      if (created.has(pid) && created.has(parent) && created.get(pid) < created.get(parent)) continue;
      out.push(pid);
      queue.push(pid);
    }
  }
  return out;
}

function psListing() {
  // Windows has no ps: the process table comes from CIM, "pid ppid created" per line, the
  // creation time as a Windows file time.
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToFileTimeUtc())" }'], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 30_000 })
    : spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', shell: false, windowsHide: true });
  if (result.status !== 0) return [];
  const pairs = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)(?:\s+(\d+))?\s*$/.exec(line);
    // The listing process itself is gone by now: never count it.
    if (match !== null && Number(match[1]) !== result.pid) pairs.push(match[3] === undefined ? [Number(match[1]), Number(match[2])] : [Number(match[1]), Number(match[2]), Number(match[3])]);
  }
  return pairs;
}

function signal(pid, name) {
  try {
    process.kill(pid, name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Installs the bound in a test file's process. Returns false when this process is not a test
 * file's (or no bound is set). `now`, `check` and `end` are injectable for tests.
 */
export function installFileBound({ env = process.env, argv = process.argv, pid = process.pid, now = Date.now, check = 1000, end = (code) => process.exit(code), list = psListing } = {}) {
  const bound = silentBoundMs(env);
  if (bound === null) return false;
  if (typeof env.NODE_TEST_CONTEXT !== 'string' || env.NODE_TEST_CONTEXT.length === 0) return false;
  if (typeof argv[1] !== 'string' || !TEST_FILE.test(argv[1])) return false;
  // The file's own process only: one it started that runs a test file of its own is not it.
  const owner = env.JT_OWNER_PID;
  if (typeof owner === 'string' && owner.length > 0 && owner !== String(pid)) return false;
  // Once per process, however often the module is imported.
  if (installed) return false;
  installed = true;
  let last = now();
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write;
    stream.write = function noted(...args) {
      last = now();
      return write.apply(this, args);
    };
  }
  let fired = false;
  const timer = setInterval(() => {
    if (fired || now() - last < bound) return;
    fired = true;
    clearInterval(timer);
    const file = relative(process.cwd(), argv[1]) || argv[1];
    const started = descendants(pid, list);
    process.stderr.write(`test file bound: ${file} was silent for ${Math.round(bound / 1000)} s (${FILE_SILENT_ENV}); it and the ${started.length} process(es) it started were ended (${FILE_SILENT_REASON})\n`);
    for (const child of started) signal(child, 'SIGTERM');
    // A ref'd timer: the process stays up for the grace, then ends.
    setTimeout(() => {
      for (const child of started) signal(child, 'SIGKILL');
      end(1);
    }, started.length === 0 ? 0 : GRACE_MS);
  }, check);
  timer.unref();
  return true;
}

installFileBound();
