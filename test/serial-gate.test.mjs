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
const { SERIAL_GATE_URL, SERIAL_TEST_FILES, serialGate, splitSerial } = await import('../scripts/test.mjs');
const { alive, finished, markerOf, tryLock } = await import('../scripts/test-serial-gate.mjs');

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
