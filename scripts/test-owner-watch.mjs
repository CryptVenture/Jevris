// Loaded into every test process by scripts/test-preload.mjs (NODE_OPTIONS --import), so it
// also runs in every process a test starts: the jevris CLI, a hook and the detached sidecar.
//
// Process hygiene: a sidecar a test starts is detached (it outlives the command that started
// it), so a test that is cut short (its file timed out, or the run was interrupted or killed)
// would leave it running with parent PID 1. A test's `finally` never runs then. Instead:
// - The test file's process is the owner. Its preload records its pid in JT_OWNER_PID, and every
//   process it starts inherits that variable. (Not a JEVRIS_ name: tests that start the product
//   with a clean environment drop every JEVRIS_ variable, and this one must survive that.)
// - Every other process that inherited an owner checks, once a second, that the owner still
//   runs. Once it has gone, the process sends itself SIGTERM: the sidecar stops cleanly (it
//   handles SIGTERM), and any other process ends.
// This holds even when the owner was killed with SIGKILL, where no exit handler can run.
//
// The node:test runner marks each test file's process with NODE_TEST_CONTEXT, and its children
// inherit that too. So a process claims ownership only when it has that mark, no owner yet, and
// runs a test file (`*.test.mjs`). The runner never claims, and neither does a CLI or a sidecar
// whose environment lost the owner: a short-lived CLI as owner would stop its own sidecar.

export const OWNER_ENV = 'JT_OWNER_PID';
/** A test file as the node:test runner runs it. */
const TEST_FILE = /\.test\.[cm]?js$/;
export const OWNER_CHECK_MS = 1000;

/** The owner pid in `env`, or null when absent or malformed. */
export function ownerPid(env) {
  const raw = env[OWNER_ENV];
  if (typeof raw !== 'string' || !/^[1-9]\d{0,9}$/.test(raw)) return null;
  return Number(raw);
}

/** Whether `pid` names a running process (EPERM: running, owned by someone else). */
export function pidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Claims ownership for a test file's process, or watches the owner from any process it started.
 * Returns what it did: 'owner', 'watching' or 'none'. The watch timer is unref'd, so it never
 * keeps a short-lived process alive.
 */
export function installOwnerWatch({ env = process.env, pid = process.pid, argv = process.argv, check = OWNER_CHECK_MS, running = pidRunning, end = () => process.kill(process.pid, 'SIGTERM') } = {}) {
  const owner = ownerPid(env);
  if (owner === null) {
    if (typeof env.NODE_TEST_CONTEXT !== 'string' || env.NODE_TEST_CONTEXT.length === 0) return 'none';
    if (typeof argv[1] !== 'string' || !TEST_FILE.test(argv[1])) return 'none';
    env[OWNER_ENV] = String(pid);
    return 'owner';
  }
  if (owner === pid) return 'owner';
  let ended = false;
  const timer = setInterval(() => {
    if (ended || running(owner)) return;
    ended = true;
    clearInterval(timer);
    end();
  }, check);
  timer.unref();
  return 'watching';
}
