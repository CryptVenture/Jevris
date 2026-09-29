// Imported into every test process by scripts/test.mjs (NODE_OPTIONS --import) when a run holds
// latency-bound files (SERIAL_TEST_FILES). It does nothing in any other process.
//
// The runner lists those files last and writes the plan to JEVRIS_SERIAL_GATE/plan.json. In the
// process node:test starts for a listed file:
// - a parallel file marks itself started (with its pid) and, at exit, done;
// - a serial file waits until every parallel file is done (or its process has gone), then takes
//   the serial lock, so it runs alone: with no parallel file and no other serial file beside it.
// One node --test run holds both, so coverage, the test events and the summary stay one run's.
// A parallel file that has not marked itself started a minute (JEVRIS_SERIAL_GATE_START_GRACE_S)
// after a serial file began waiting never loaded the gate: node:test had started it by then.
// A wait is capped (JEVRIS_SERIAL_GATE_WAIT_S, default 1200 s), so a file that never finishes
// cannot hold the run forever. Either way the serial file names what it went ahead of.
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

/**
 * The parallel files a serial file is still waiting for when its wait ends: each with the
 * pid it recorded (null: it never started) and whether that process is running. The serial file
 * writes them to waited-<marker>.json in the gate folder and to stderr, and scripts/test.mjs
 * prints them after the run, so a capped wait names what held it.
 */
export function unfinished(dir, parallel) {
  const out = [];
  for (const file of parallel) {
    const marker = markerOf(file);
    if (finished(dir, marker)) continue;
    let pid = null;
    try {
      pid = Number(readFileSync(join(dir, `${marker}.start`), 'utf8'));
    } catch {
      pid = null;
    }
    out.push({ file, pid, running: pid !== null && alive(pid) });
  }
  return out;
}

/** One line per wait that ended with a parallel file unfinished, for the run's output. */
export function describeWait(record) {
  const held = record.unfinished.map((item) => `${item.file} (${item.pid === null ? 'never started' : `pid ${item.pid}${item.running ? ' still running' : ''}`})`);
  return `serial gate: ${record.file} waited ${record.waitedS} s${record.capped === true ? ', its cap,' : ''} and went ahead of ${held.length} file(s): ${held.join(', ')}`;
}

/** True when the parallel file behind `marker` has marked itself started. */
export function started(dir, marker) {
  return existsSync(join(dir, `${marker}.start`));
}

/** How long a serial file waits for a parallel file to mark itself started (seconds). */
export const START_GRACE_S = 60;

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
      const capMs = (Number.isFinite(waitS) && waitS > 0 ? waitS : 1200) * 1000;
      const graceS = Number(process.env.JEVRIS_SERIAL_GATE_START_GRACE_S ?? String(START_GRACE_S));
      const graceMs = (Number.isFinite(graceS) && graceS > 0 ? graceS : START_GRACE_S) * 1000;
      const began = Date.now();
      const until = began + capMs;
      const markers = plan.parallel.map(markerOf);
      // node:test starts files in the order given, and the runner lists every parallel file
      // first: when a serial file runs, every parallel file's process has been started. One that
      // has not marked itself started within the grace never loaded this gate and is not waited on.
      const settled = (marker) => finished(gate, marker) || (Date.now() - began > graceMs && !started(gate, marker));
      while (Date.now() < until && !markers.every(settled)) await sleep(250);
      const held = unfinished(gate, plan.parallel);
      if (held.length > 0) {
        const record = { file: self, waitedS: Math.round((Date.now() - began) / 1000), capped: Date.now() >= until, unfinished: held };
        try {
          writeFileSync(join(gate, `waited-${markerOf(self)}.json`), JSON.stringify(record));
        } catch {
          // the run's folder is gone
        }
        process.stderr.write(`${describeWait(record)}\n`);
      }
      // The lock has its own cap: a capped wait above still runs the serial files one at a time.
      const lockUntil = Date.now() + capMs;
      let locked = false;
      while (Date.now() < lockUntil && !(locked = tryLock(gate))) await sleep(250);
      if (locked) {
        process.on('exit', () => {
          rmSync(join(gate, 'serial.lock'), { recursive: true, force: true });
        });
      }
    }
  }
}
