// The latency-bound files run last and alone, in the same node --test run (scripts/test.mjs
// SERIAL_TEST_FILES, scripts/test-serial-gate.mjs; A's flake pass, coordinator 2026-09-28).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { SERIAL_GATE_URL, SERIAL_TEST_FILES, cappedWaits, serialGate, splitSerial } = await import('../scripts/test.mjs');
const { alive, finished, markerOf, tryLock, unfinished } = await import('../scripts/test-serial-gate.mjs');

test('the listed latency-bound files exist, and a run lists them after every other file', () => {
  for (const file of SERIAL_TEST_FILES) assert.equal(existsSync(join(root, file)), true, `${file} exists`);
  const other = join(root, 'test', 'serial-gate.test.mjs');
  const bound = join(root, SERIAL_TEST_FILES[0]);
  assert.deepEqual(splitSerial([bound, other], root), { parallel: [other], serial: [bound] });
});

test('the gate is on only when a run holds serial files and other files, and adds its import once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  try {
    assert.equal(serialGate(['a.test.mjs'], [], dir, {}), null);
    assert.equal(serialGate([], ['b.test.mjs'], dir, {}), null);
    const gate = serialGate(['a.test.mjs'], ['b.test.mjs'], dir, { NODE_OPTIONS: '--import=x' });
    assert.equal(gate.NODE_OPTIONS, `--import=x --import=${SERIAL_GATE_URL}`);
    assert.equal(serialGate(['a.test.mjs'], ['b.test.mjs'], dir, gate).NODE_OPTIONS, gate.NODE_OPTIONS);
    const plan = JSON.parse(readFileSync(join(gate.JEVRIS_SERIAL_GATE, 'plan.json'), 'utf8'));
    assert.equal(plan.parallel.length, 1);
    assert.equal(plan.serial.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a parallel file whose process has gone counts as finished, and a lock whose owner has gone is taken over', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  try {
    assert.equal(alive(process.pid), true);
    const marker = markerOf('x.test.mjs');
    assert.equal(finished(dir, marker), false, 'not started yet');
    writeFileSync(join(dir, `${marker}.start`), String(process.pid));
    assert.equal(finished(dir, marker), false, 'still running');
    writeFileSync(join(dir, `${marker}.done`), '');
    assert.equal(finished(dir, marker), true);
    const gone = markerOf('y.test.mjs');
    writeFileSync(join(dir, `${gone}.start`), '999999999');
    assert.equal(finished(dir, gone), true, 'its process has gone');
    mkdirSync(join(dir, 'serial.lock'));
    writeFileSync(join(dir, 'serial.lock', 'pid'), String(process.pid));
    assert.equal(tryLock(dir), false, 'held by a live process');
    writeFileSync(join(dir, 'serial.lock', 'pid'), '999999999');
    assert.equal(tryLock(dir), false, 'a stale lock is cleared first');
    assert.equal(tryLock(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('in one node --test run, each serial file starts after every parallel file ended, and runs alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-run-'));
  try {
    const log = join(dir, 'log.jsonl');
    const file = (name, ms) => {
      const path = join(dir, `${name}.test.mjs`);
      writeFileSync(
        path,
        [
          "import test from 'node:test';",
          "import { appendFileSync } from 'node:fs';",
          `test(${JSON.stringify(name)}, async () => {`,
          `  const start = Date.now();`,
          `  await new Promise((done) => setTimeout(done, ${ms}));`,
          `  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ name: ${JSON.stringify(name)}, start, end: Date.now() }) + '\\n');`,
          '});',
        ].join('\n'),
      );
      return path;
    };
    const parallel = [file('p1', 600), file('p2', 300), file('p3', 100)];
    const serial = [file('s1', 200), file('s2', 200)];
    const gate = serialGate(parallel, serial, dir, { NODE_OPTIONS: process.env.NODE_OPTIONS ?? '' });
    // A run of its own: without NODE_TEST_CONTEXT, which would make it report to this file's runner.
    const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
    const code = await new Promise((done, fail) => {
      const child = spawn(process.execPath, ['--test', '--test-concurrency=4', '--test-reporter=dot', ...parallel, ...serial], { env: { ...env, ...gate }, stdio: 'ignore' });
      child.on('error', fail);
      child.on('close', done);
    });
    assert.equal(code, 0);
    const rows = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const at = (name) => rows.find((row) => row.name === name);
    const lastParallelEnd = Math.max(...['p1', 'p2', 'p3'].map((name) => at(name).end));
    for (const name of ['s1', 's2']) assert.ok(at(name).start >= lastParallelEnd, `${name} started after every parallel file ended`);
    const [first, second] = [at('s1'), at('s2')].sort((a, b) => a.start - b.start);
    assert.ok(second.start >= first.end, 'the serial files did not overlap');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// CI (Linux and macOS, Node 24 and later): the serial files waited out the 1200 s cap and the run
// did not say for what. A capped wait now names each parallel file it waited for, with its state.
test('a capped wait names the parallel files it waited for, and the runner prints them after the run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-cap-'));
  try {
    const never = join(dir, 'never.test.mjs');
    const serial = join(dir, 'serial.test.mjs');
    writeFileSync(never, "import test from 'node:test';\ntest('never run here', () => {});\n");
    writeFileSync(serial, "import test from 'node:test';\ntest('ran after its capped wait', () => {});\n");
    const gate = serialGate([never], [serial], dir, { NODE_OPTIONS: process.env.NODE_OPTIONS ?? '' });
    const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
    const stderr = await new Promise((done, fail) => {
      // Only the serial file runs: the parallel one never starts, so the wait is capped at 1 s.
      const child = spawn(process.execPath, ['--test', '--test-reporter=dot', serial], { env: { ...env, ...gate, JEVRIS_SERIAL_GATE_WAIT_S: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let text = '';
      child.stdout.on('data', (chunk) => { text += chunk; });
      child.stderr.on('data', (chunk) => { text += chunk; });
      child.on('error', fail);
      child.on('close', () => done(text));
    });
    const lines = cappedWaits(gate.JEVRIS_SERIAL_GATE);
    assert.equal(lines.length, 1, stderr);
    assert.match(lines[0], /^serial gate: .*serial\.test\.mjs waited [12] s, its cap, and went ahead of 1 file\(s\): .*never\.test\.mjs \(never started\)$/);
    const record = JSON.parse(readFileSync(join(gate.JEVRIS_SERIAL_GATE, `waited-${markerOf(serial)}.json`), 'utf8'));
    assert.deepEqual(record.unfinished, [{ file: never, pid: null, running: false }]);
    assert.equal(record.capped, true);
    // Pair: a parallel file with a live process is named as still running; a finished one is not named.
    writeFileSync(join(gate.JEVRIS_SERIAL_GATE, `${markerOf(never)}.start`), String(process.pid));
    assert.deepEqual(unfinished(gate.JEVRIS_SERIAL_GATE, [never]), [{ file: never, pid: process.pid, running: true }]);
    writeFileSync(join(gate.JEVRIS_SERIAL_GATE, `${markerOf(never)}.done`), '');
    assert.deepEqual(unfinished(gate.JEVRIS_SERIAL_GATE, [never]), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Runs `serial` alone under a gate whose plan also lists `parallel`, with extra gate variables. */
async function gatedAlone(dir, parallel, serial, extra) {
  const gate = serialGate(parallel, [serial], dir, { NODE_OPTIONS: process.env.NODE_OPTIONS ?? '' });
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const started = Date.now();
  await new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=dot', serial], { env: { ...env, ...gate, ...extra }, stdio: 'ignore' });
    child.on('error', fail);
    child.on('close', done);
  });
  return { gate, ms: Date.now() - started };
}

// node:test has started every parallel file by the time a serial file runs, so one that never
// marked itself started never loaded the gate: the serial file goes ahead after the start grace,
// not after the 20-minute cap, and says so. Pair: a started, running file is still waited for.
test('a parallel file that never marked itself started is not waited for past the start grace; a running one is', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-grace-'));
  try {
    const never = join(dir, 'never.test.mjs');
    const serial = join(dir, 'serial.test.mjs');
    writeFileSync(never, "import test from 'node:test';\ntest('never run here', () => {});\n");
    writeFileSync(serial, "import test from 'node:test';\ntest('ran after the grace', () => {});\n");
    const quick = await gatedAlone(dir, [never], serial, { JEVRIS_SERIAL_GATE_WAIT_S: '120', JEVRIS_SERIAL_GATE_START_GRACE_S: '1' });
    assert.ok(quick.ms < 60_000, `went ahead after the grace (${quick.ms} ms), not the cap`);
    const record = JSON.parse(readFileSync(join(quick.gate.JEVRIS_SERIAL_GATE, `waited-${markerOf(serial)}.json`), 'utf8'));
    assert.equal(record.capped, false);
    assert.deepEqual(record.unfinished, [{ file: never, pid: null, running: false }]);

    const other = mkdtempSync(join(tmpdir(), 'gate-grace-running-'));
    try {
      const gate = serialGate([never], [serial], other, {});
      // The parallel file marked itself started, and its process (this one) is running.
      writeFileSync(join(gate.JEVRIS_SERIAL_GATE, `${markerOf(never)}.start`), String(process.pid));
      const held = await gatedAlone(other, [never], serial, { JEVRIS_SERIAL_GATE_WAIT_S: '3', JEVRIS_SERIAL_GATE_START_GRACE_S: '1' });
      assert.ok(held.ms >= 2500, `a running parallel file is waited for until the cap (${held.ms} ms)`);
      const capped = JSON.parse(readFileSync(join(held.gate.JEVRIS_SERIAL_GATE, `waited-${markerOf(serial)}.json`), 'utf8'));
      assert.equal(capped.capped, true);
      assert.deepEqual(capped.unfinished, [{ file: never, pid: process.pid, running: true }]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
