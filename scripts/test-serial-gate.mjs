// Imported into every test process by scripts/test.mjs (NODE_OPTIONS --import) when a run holds
// latency-bound files (SERIAL_TEST_FILES). It does nothing in any other process.
//
// The runner writes the plan to JEVRIS_SERIAL_GATE/plan.json. node:test does not start files in
// the order given (it sorts them: on CI apps/sidecar/test/daemon.test.mjs started before 299
// parallel files), so the gate cannot count on the serial files starting last. It keeps a serial
// file alone with a lock both kinds of file respect, in the process node:test starts for a file:
// - a parallel file waits while a live serial file holds the serial lock, then marks itself
//   started (with its pid), checks the lock again, and marks itself done at exit;
// - a serial file waits until no started parallel file is still running, takes the lock, and
//   checks again that none started meanwhile; if one did, it lets the lock go and waits again.
// A file that node:test has not started yet is not waited for: it waits for the lock when it
// starts. Every file keeps making progress: a serial file waits only for running parallel files,
// a parallel file only for the serial file that holds the lock.
// One node --test run holds both, so coverage, the test events and the summary stay one run's.
// Each wait is capped (JEVRIS_SERIAL_GATE_WAIT_S, default 3600 s: on windows-latest the parallel
// files alone run for more than 20 minutes, and a serial file that went ahead at a 1200 s cap ran
// beside them), and a serial file names the parallel files a capped wait went ahead of.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const gate = process.env.JEVRIS_SERIAL_GATE;
const main = process.argv[1];

/** The marker name of a test file. */
export function markerOf(file) {
  return createHash('sha256').update(resolve(file)).digest('hex').slice(0, 16);
}

/** Whether a process is running (EPERM counts: it exists). */
export function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** How long a marker file that holds no pid yet counts as "its writer is between create and write". */
const PID_GRACE_MS = 10_000;

/**
 * The pid a marker file holds, or null while it holds none. writeFileSync creates the file empty
 * and then writes it, and on a loaded Windows runner a reader can land between the two: an empty
 * read is "not written yet" (Number('') is 0, which alive() calls a dead process, and that once let
 * a serial file run beside a parallel one). Throws when the file does not exist.
 */
function pidIn(path) {
  const text = readFileSync(path, 'utf8').trim();
  const pid = Number(text);
  return text.length > 0 && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** Whether a marker file with no pid in it is still young enough for its writer to be mid-write. */
function mid(path, now = Date.now()) {
  try {
    return now - statSync(path).mtimeMs < PID_GRACE_MS;
  } catch {
    return false;
  }
}

/** True when the parallel file behind `marker` has finished: its done marker, or its process gone. */
export function finished(dir, marker) {
  if (existsSync(join(dir, `${marker}.done`))) return true;
  const start = join(dir, `${marker}.start`);
  try {
    const pid = pidIn(start);
    return pid === null ? !mid(start) : !alive(pid);
  } catch {
    return false;
  }
}

/** Takes the serial lock (a folder holding the owner's pid); a lock whose owner has gone is taken over. */
export function tryLock(dir) {
  const lock = join(dir, 'serial.lock');
  try {
    mkdirSync(lock);
  } catch {
    let owner = null;
    try {
      owner = pidIn(join(lock, 'pid'));
    } catch {
      return false; // being written by its new owner
    }
    if (owner === null ? mid(join(lock, 'pid')) : alive(owner)) return false;
    rmSync(lock, { recursive: true, force: true });
    return false;
  }
  writeFileSync(join(lock, 'pid'), String(process.pid));
  return true;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * The parallel files that have marked themselves started and are not done: each with its pid and
 * whether that process is running. A serial file whose wait is capped writes them to
 * waited-<marker>.json in the gate folder and to stderr; scripts/test.mjs prints them after the run.
 */
export function unfinished(dir, parallel) {
  const out = [];
  for (const file of parallel) {
    const marker = markerOf(file);
    if (!started(dir, marker) || finished(dir, marker)) continue;
    let pid = null;
    try {
      pid = pidIn(join(dir, `${marker}.start`));
    } catch {
      pid = null;
    }
    out.push({ file, pid, running: pid !== null && alive(pid) });
  }
  return out;
}

/** One line per capped wait, for the run's output. */
export function describeWait(record) {
  const held = record.unfinished.map((item) => `${item.file} (pid ${item.pid}${item.running ? ', still running' : ''})`);
  const lock = record.locked === false ? ' without the serial lock (another serial file held it)' : '';
  return `serial gate: ${record.file} waited ${record.waitedS} s, its cap, and went ahead${lock} of ${held.length} unfinished parallel file(s)${held.length === 0 ? '' : `: ${held.join(', ')}`}`;
}

/** True when the parallel file behind `marker` has marked itself started. */
export function started(dir, marker) {
  return existsSync(join(dir, `${marker}.start`));
}

/** True when a live process other than this one holds the serial lock. */
export function lockHeld(dir) {
  const file = join(dir, 'serial.lock', 'pid');
  let owner = null;
  try {
    owner = pidIn(file);
  } catch {
    // no lock, or its owner is still writing its pid
    return existsSync(join(dir, 'serial.lock'));
  }
  if (owner === null) return mid(file); // created, not written yet
  return owner !== process.pid && alive(owner);
}

/** The cap on each wait, in milliseconds. */
function capMs() {
  const waitS = Number(process.env.JEVRIS_SERIAL_GATE_WAIT_S ?? '3600');
  return (Number.isFinite(waitS) && waitS > 0 ? waitS : 3600) * 1000;
}

if (typeof gate === 'string' && gate.length > 0 && (process.env.NODE_TEST_CONTEXT ?? '').length > 0 && typeof main === 'string' && main.length > 0) {
  let plan = null;
  try {
    plan = JSON.parse(readFileSync(join(gate, 'plan.json'), 'utf8'));
  } catch {
    plan = null;
  }
  const self = resolve(main);
  // Each file's own time, from its process start to its exit, for the runner's slowest-files line.
  const began = Date.now();
  process.on('exit', () => {
    try {
      writeFileSync(join(gate, `took-${markerOf(self)}.json`), JSON.stringify({ file: self, ms: Date.now() - began }));
    } catch {
      // the run's folder is gone
    }
  });
  if (plan !== null && Array.isArray(plan.parallel) && Array.isArray(plan.serial)) {
    if (plan.parallel.includes(self)) {
      const marker = markerOf(self);
      const until = Date.now() + capMs();
      // Started only while no serial file runs: mark, then check the lock again, since a serial
      // file takes the lock and then checks the marks (one of the two always sees the other).
      for (;;) {
        while (Date.now() < until && lockHeld(gate)) await sleep(250);
        writeFileSync(join(gate, `${marker}.start`), String(process.pid));
        if (Date.now() >= until || !lockHeld(gate)) break;
        rmSync(join(gate, `${marker}.start`), { force: true });
      }
      process.on('exit', () => {
        try {
          writeFileSync(join(gate, `${marker}.done`), '');
        } catch {
          // the run's folder is gone
        }
      });
    } else if (plan.serial.includes(self)) {
      const began = Date.now();
      const until = began + capMs();
      const running = () => plan.parallel.some((file) => { const marker = markerOf(file); return started(gate, marker) && !finished(gate, marker); });
      let locked = false;
      for (;;) {
        while (Date.now() < until && running()) await sleep(250);
        // The lock has its own cap: after a capped wait the serial files still run one at a time.
        const lockUntil = Date.now() + capMs();
        while (Date.now() < lockUntil && !(locked = tryLock(gate))) await sleep(250);
        if (!locked || Date.now() >= until || !running()) break;
        // A parallel file started between the check and the lock: let it finish first.
        rmSync(join(gate, 'serial.lock'), { recursive: true, force: true });
        locked = false;
      }
      if (locked) {
        process.on('exit', () => {
          rmSync(join(gate, 'serial.lock'), { recursive: true, force: true });
        });
      }
      const held = unfinished(gate, plan.parallel);
      if (Date.now() >= until || !locked) {
        const record = { file: self, waitedS: Math.round((Date.now() - began) / 1000), capped: true, locked, unfinished: held };
        try {
          writeFileSync(join(gate, `waited-${markerOf(self)}.json`), JSON.stringify(record));
        } catch {
          // the run's folder is gone
        }
        process.stderr.write(`${describeWait(record)}\n`);
      }
    }
  }
}
