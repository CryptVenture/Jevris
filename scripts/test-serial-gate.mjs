// Imported into every test process by scripts/test.mjs (NODE_OPTIONS --import) when a run holds
// latency-bound files (SERIAL_TEST_FILES). It does nothing in any other process.
//
// The runner lists those files last and writes the plan to JEVRIS_SERIAL_GATE/plan.json. In the
// process node:test starts for a listed file:
// - a parallel file marks itself started (with its pid) and, at exit, done;
// - a serial file waits until every parallel file is done (or its process has gone), then takes
//   the serial lock, so it runs alone: with no parallel file and no other serial file beside it.
// One node --test run holds both, so coverage, the test events and the summary stay one run's.
// A wait is capped (JEVRIS_SERIAL_GATE_WAIT_S, default 1200 s): a file that never starts cannot
// hold the run forever, and the file then runs as it would have without the gate.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** True when the parallel file behind `marker` has finished: its done marker, or its process gone. */
export function finished(dir, marker) {
  if (existsSync(join(dir, `${marker}.done`))) return true;
  try {
    return !alive(Number(readFileSync(join(dir, `${marker}.start`), 'utf8')));
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
    let owner = 0;
    try {
      owner = Number(readFileSync(join(lock, 'pid'), 'utf8'));
    } catch {
      return false; // being written by its new owner
    }
    if (alive(owner)) return false;
    rmSync(lock, { recursive: true, force: true });
    return false;
  }
  writeFileSync(join(lock, 'pid'), String(process.pid));
  return true;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

if (typeof gate === 'string' && gate.length > 0 && (process.env.NODE_TEST_CONTEXT ?? '').length > 0 && typeof main === 'string' && main.length > 0) {
  let plan = null;
  try {
    plan = JSON.parse(readFileSync(join(gate, 'plan.json'), 'utf8'));
  } catch {
    plan = null;
  }
  const self = resolve(main);
  if (plan !== null && Array.isArray(plan.parallel) && Array.isArray(plan.serial)) {
    if (plan.parallel.includes(self)) {
      const marker = markerOf(self);
      writeFileSync(join(gate, `${marker}.start`), String(process.pid));
      process.on('exit', () => {
        try {
          writeFileSync(join(gate, `${marker}.done`), '');
        } catch {
          // the run's folder is gone
        }
      });
    } else if (plan.serial.includes(self)) {
      const waitS = Number(process.env.JEVRIS_SERIAL_GATE_WAIT_S ?? '1200');
      const until = Date.now() + (Number.isFinite(waitS) && waitS > 0 ? waitS : 1200) * 1000;
      const markers = plan.parallel.map(markerOf);
      while (Date.now() < until && !markers.every((marker) => finished(gate, marker))) await sleep(250);
      let locked = false;
      while (Date.now() < until && !(locked = tryLock(gate))) await sleep(250);
      if (locked) {
        process.on('exit', () => {
          rmSync(join(gate, 'serial.lock'), { recursive: true, force: true });
        });
      }
    }
  }
}
