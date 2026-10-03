// A graceful stop never cuts off a verification run (review of wave 1, M1). The sidecar decides, in
// the step that accepts the `shutdown` frame (the frame `jevris sidecar stop` sends): while a run is
// under way it refuses with VERIFICATION_RUNNING and keeps serving, unless the frame says `force`. A
// run that begins after the stop was accepted is waited for, up to a bound; a signal ends the wait.
// In-process daemons with an injected run count, and a child process (fixtures/busy-daemon.mjs) for
// the client's stop. Temporary homes; no real service manager, harness or model.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { startDaemon: startDaemonOnce, sidecarRequest, stopSidecarProcess, probeSidecar, runtimeFiles } = await import('../dist/index.js');
const protocol = await import('../dist/protocol.js');

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'busy-daemon.mjs');
const posix = process.platform !== 'win32';

const daemons = new Set();
const children = new Set();

function tempHome() {
  // realpath: macOS tmpdir is a symlink; a short base keeps the socket path under 103 bytes.
  return realpathSync(mkdtempSync(join(tmpdir(), 'jvg-')));
}

async function startDaemon(options) {
  const started = await startDaemonOnce({ packageOps: false, idleMs: 0, store: false, log: () => undefined, ...options });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  daemons.add(started.daemon);
  return started.daemon;
}

function exitOf(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve([child.exitCode, child.signalCode]);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve([code, signal]);
    });
  });
}

async function endChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if ((await exitOf(child, 5000)) === null) {
    child.kill('SIGKILL');
    await exitOf(child, 5000);
  }
}

after(async () => {
  for (const child of [...children]) await endChild(child);
  for (const daemon of [...daemons]) await daemon.stop('test-cleanup').catch(() => undefined);
});

/** Settles to 'still running' when the daemon has not stopped after `ms` (a marker, not a timing assertion). */
const stillRunning = (daemon, ms = 700) => Promise.race([daemon.stopped, new Promise((resolve) => setTimeout(() => resolve('still running'), ms))]);

const shutdown = (home, body = {}) => sidecarRequest({ home, op: 'shutdown', scope: 'cli', body, timeoutMs: 5000 });

// ------------------------------------------------------------------ the daemon decides

test('a shutdown with no verification run under way is accepted and the sidecar stops', async () => {
  const home = tempHome();
  try {
    const daemon = await startDaemon({ home, backgroundWork: () => 0 });
    const answer = await shutdown(home);
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal(answer.result.stopping, true);
    assert.equal(await daemon.stopped, 'shutdown');
    assert.equal(existsSync(runtimeFiles({ home }).endpoint), false, 'its endpoint is gone');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a shutdown during a verification run is refused with VERIFICATION_RUNNING, the sidecar keeps serving, and a later shutdown is accepted', async () => {
  const home = tempHome();
  let runs = 2;
  try {
    const daemon = await startDaemon({ home, backgroundWork: () => runs });
    const refused = await shutdown(home);
    assert.equal(refused.ok, false, 'a stop is refused while runs are under way');
    assert.equal(refused.reason, 'rejected');
    assert.equal(refused.reasonCode, 'VERIFICATION_RUNNING');
    assert.equal(refused.message, 'The sidecar is finishing 2 verification runs and was left running.');
    assert.equal(await stillRunning(daemon), 'still running', 'the sidecar did not stop');
    const ping = await sidecarRequest({ home, op: 'ping', scope: 'cli' });
    assert.equal(ping.ok, true, 'it still serves');
    runs = 1;
    assert.equal((await shutdown(home)).message, 'The sidecar is finishing a verification run and was left running.');
    runs = 0;
    const accepted = await shutdown(home);
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.equal(await daemon.stopped, 'shutdown');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a forced shutdown stops the sidecar although a run is under way; only the boolean true forces', async () => {
  const home = tempHome();
  try {
    const daemon = await startDaemon({ home, backgroundWork: () => 1 });
    for (const notForce of ['true', 1, 'yes', null]) {
      const refused = await shutdown(home, { force: notForce });
      assert.equal(refused.reasonCode, 'VERIFICATION_RUNNING', `force: ${JSON.stringify(notForce)} does not force`);
    }
    const forced = await shutdown(home, { force: true });
    assert.equal(forced.ok, true, JSON.stringify(forced));
    assert.equal(await daemon.stopped, 'shutdown-forced');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a run counter that throws does not make the sidecar impossible to stop', async () => {
  const home = tempHome();
  try {
    const daemon = await startDaemon({
      home,
      backgroundWork: () => {
        throw new Error('counter');
      },
    });
    assert.equal((await shutdown(home)).ok, true);
    assert.equal(await daemon.stopped, 'shutdown');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a shutdown from a hook or MCP client is still refused by scope, whatever the runs', async () => {
  const home = tempHome();
  try {
    await startDaemon({ home, backgroundWork: () => 0 });
    for (const scope of ['hook', 'mcp']) {
      const res = await sidecarRequest({ home, op: 'shutdown', scope, body: { force: true } });
      assert.equal(res.ok, false, scope);
      assert.equal(res.reasonCode, 'SCOPE_DENIED', scope);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ the race after the decision

test('a run that begins after the stop was accepted is waited for: the sidecar exits only when it ends', async () => {
  const home = tempHome();
  let runs = 0;
  try {
    const daemon = await startDaemon({ home, backgroundWork: () => runs });
    const accepted = await shutdown(home);
    assert.equal(accepted.ok, true, 'no run when it was asked');
    runs = 1; // a request that was in flight starts a run while the sidecar closes
    assert.equal(await stillRunning(daemon), 'still running', 'the run is not cut off');
    runs = 0;
    assert.equal(await daemon.stopped, 'shutdown');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the wait for a late run has a bound: past it the sidecar exits', async () => {
  const home = tempHome();
  let runs = 0;
  const logs = [];
  try {
    const daemon = await startDaemon({ home, backgroundWork: () => runs, shutdownRunWaitMs: 300, log: (entry) => logs.push(entry) });
    assert.equal((await shutdown(home)).ok, true);
    runs = 1;
    assert.equal(await daemon.stopped, 'shutdown', 'it exits at the bound although the run is still counted');
    const ended = logs.find((entry) => entry.event === 'stop-wait-ended');
    assert.equal(ended?.ended, 'bound');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a signal ends the wait for a late run at once: a signal means stop now', async () => {
  const home = tempHome();
  let runs = 0;
  const logs = [];
  try {
    const daemon = await startDaemon({ home, backgroundWork: () => runs, log: (entry) => logs.push(entry) });
    assert.equal((await shutdown(home)).ok, true);
    runs = 1;
    assert.equal(await stillRunning(daemon, 500), 'still running', 'waiting for the run');
    void daemon.stop('SIGTERM');
    assert.equal(await daemon.stopped, 'shutdown');
    assert.equal(logs.find((entry) => entry.event === 'stop-wait-ended')?.ended, 'signal');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a signal-first stop, an idle exit and a forced stop do not wait for runs', async () => {
  const home = tempHome();
  try {
    const daemon = await startDaemon({ home, backgroundWork: () => 3 });
    await daemon.stop('SIGTERM');
    assert.equal(await daemon.stopped, 'SIGTERM');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ the client, against a separate process

/** A sidecar child whose run count is the flag file; resolves once its endpoint is readable. */
async function busySidecar() {
  const home = tempHome();
  const flag = join(home, 'run.flag');
  const child = spawn(process.execPath, [FIXTURE, home, flag], { stdio: 'ignore' });
  children.add(child);
  child.once('exit', () => children.delete(child));
  const files = runtimeFiles({ home });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && protocol.readEndpoint(files) === undefined) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.notEqual(protocol.readEndpoint(files), undefined, 'the sidecar child came up');
  return { home, flag, child, running: () => writeFileSync(flag, ''), idle: () => rmSync(flag, { force: true }) };
}

test('stopSidecarProcess does not stop a sidecar that is finishing a run, signals nothing, and says why; without a run it stops it', { skip: !posix && 'POSIX process control' }, async () => {
  const s = await busySidecar();
  try {
    s.running();
    const busy = await stopSidecarProcess(s.home, 3000);
    assert.equal(busy.stopped, false);
    assert.equal(busy.method, 'failed');
    assert.equal(busy.busy?.reasonCode, 'VERIFICATION_RUNNING');
    assert.match(busy.busy?.message ?? '', /is finishing a verification run and was left running\.$/);
    assert.equal(s.child.exitCode, null, 'the sidecar child is alive');
    assert.equal(s.child.signalCode, null, 'and was not signalled');
    assert.equal((await sidecarRequest({ home: s.home, op: 'ping', scope: 'cli' })).ok, true, 'and still answers');
    s.idle();
    const stopped = await stopSidecarProcess(s.home, 8000);
    assert.deepEqual([stopped.stopped, stopped.method], [true, 'shutdown-frame']);
    assert.deepEqual(await exitOf(s.child, 10_000), [0, null]);
  } finally {
    await endChild(s.child);
    rmSync(s.home, { recursive: true, force: true });
  }
});

test('stopSidecarProcess with force stops a sidecar that is finishing a run', { skip: !posix && 'POSIX process control' }, async () => {
  const s = await busySidecar();
  try {
    s.running();
    const stopped = await stopSidecarProcess(s.home, 8000, { force: true });
    assert.deepEqual([stopped.stopped, stopped.method, stopped.busy], [true, 'shutdown-frame', undefined]);
    assert.deepEqual(await exitOf(s.child, 10_000), [0, null]);
  } finally {
    await endChild(s.child);
    rmSync(s.home, { recursive: true, force: true });
  }
});

test('a run that begins after the stop was accepted is not signalled by the client, and the sidecar exits once it ends', { skip: !posix && 'POSIX process control' }, async () => {
  const s = await busySidecar();
  try {
    // The sidecar's decision sees no run; then one begins while it closes.
    writeFileSync(`${s.flag}.late`, '');
    const result = await stopSidecarProcess(s.home, 700);
    assert.equal(result.stopped, false, 'it had not exited when the wait ended: it is finishing the run');
    assert.equal(result.method, 'failed');
    assert.equal(result.busy, undefined, 'the frame was accepted');
    assert.equal(s.child.exitCode, null);
    assert.equal(s.child.signalCode, null, 'a client whose frame was accepted never signals: the sidecar is closing');
    assert.equal(existsSync(s.flag), true, 'the run began');
    s.idle();
    assert.deepEqual(await exitOf(s.child, 10_000), [0, null], 'it exits by itself once the run has ended');
    assert.equal((await probeSidecar(s.home)).running, false);
  } finally {
    await endChild(s.child);
    rmSync(s.home, { recursive: true, force: true });
  }
});

test('a signal sent to a sidecar that is waiting for a late run ends the wait: stop now', { skip: !posix && 'POSIX process control' }, async () => {
  const s = await busySidecar();
  try {
    writeFileSync(`${s.flag}.late`, '');
    const answer = await shutdown(s.home);
    assert.equal(answer.ok, true, JSON.stringify(answer));
    // Waiting: still alive well after the 20 ms the stop needs to begin.
    assert.equal(await exitOf(s.child, 700), null, 'waiting for the run');
    s.child.kill('SIGTERM');
    assert.deepEqual(await exitOf(s.child, 10_000), [0, null], 'the signal ended the wait and the sidecar exited cleanly');
  } finally {
    await endChild(s.child);
    rmSync(s.home, { recursive: true, force: true });
  }
});
