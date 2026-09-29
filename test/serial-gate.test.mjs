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
const { alive, finished, lockHeld, markerOf, tryLock, unfinished } = await import('../scripts/test-serial-gate.mjs');

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

/** Runs `file` alone under a gate whose plan lists `parallel` and `serial`, with extra variables. */
async function gatedAlone(dir, parallel, serial, file, extra = {}) {
  const gate = serialGate(parallel, serial, dir, { NODE_OPTIONS: process.env.NODE_OPTIONS ?? '' });
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const started = Date.now();
  let output = '';
  await new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=dot', file], { env: { ...env, ...gate, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', fail);
    child.on('close', done);
  });
  return { gate: gate.JEVRIS_SERIAL_GATE, ms: Date.now() - started, output };
}

const testFile = (dir, name, body = '') => {
  const path = join(dir, `${name}.test.mjs`);
  writeFileSync(path, `import test from 'node:test';\nimport { appendFileSync } from 'node:fs';\ntest(${JSON.stringify(name)}, () => { ${body} });\n`);
  return path;
};

// CI (Node 24 and latest): the five serial files waited out the 20-minute cap. node:test had
// sorted the files and started them early; waiting for parallel files not yet started, they held
// every slot, so those files never started. A serial file now waits only for running parallel
// files, and a capped wait names them, with its state, here and after the run.
test('a capped wait names the running parallel files it went ahead of, and the runner prints them after the run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-cap-'));
  try {
    const busy = testFile(dir, 'busy');
    const serial = testFile(dir, 'serial');
    const plan = serialGate([busy], [serial], dir, {});
    // The parallel file marked itself started, and its process (this one) is running.
    writeFileSync(join(plan.JEVRIS_SERIAL_GATE, `${markerOf(busy)}.start`), String(process.pid));
    const run = await gatedAlone(dir, [busy], [serial], serial, { JEVRIS_SERIAL_GATE_WAIT_S: '2' });
    assert.ok(run.ms >= 1500, `the running parallel file was waited for until the cap (${run.ms} ms)`);
    const lines = cappedWaits(run.gate);
    assert.equal(lines.length, 1, run.output);
    assert.match(lines[0], new RegExp(`^serial gate: .*serial\\.test\\.mjs waited [23] s, its cap, and went ahead of 1 unfinished parallel file\\(s\\): .*busy\\.test\\.mjs \\(pid ${process.pid}, still running\\)$`));
    const record = JSON.parse(readFileSync(join(run.gate, `waited-${markerOf(serial)}.json`), 'utf8'));
    assert.deepEqual(record.unfinished, [{ file: busy, pid: process.pid, running: true }]);
    assert.equal(record.locked, true);
    // Pair: a finished parallel file is not waited for and not named.
    writeFileSync(join(run.gate, `${markerOf(busy)}.done`), '');
    assert.deepEqual(unfinished(run.gate, [busy]), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a serial file does not wait for a parallel file that has not started; a parallel file that starts waits while a serial file holds the lock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-lock-'));
  try {
    const log = join(dir, 'log.txt');
    const later = testFile(dir, 'later', `appendFileSync(${JSON.stringify(log)}, 'ran ' + Date.now() + '\\n');`);
    const serial = testFile(dir, 'serial');
    const quick = await gatedAlone(dir, [later], [serial], serial, { JEVRIS_SERIAL_GATE_WAIT_S: '120' });
    assert.ok(quick.ms < 30_000, `no wait for a file node:test has not started (${quick.ms} ms)`);
    assert.deepEqual(cappedWaits(quick.gate), []);
    assert.equal(lockHeld(quick.gate), false, 'the serial file let the lock go at exit');

    // A live serial file (this process) holds the lock: the parallel file waits for it.
    mkdirSync(join(quick.gate, 'serial.lock'));
    writeFileSync(join(quick.gate, 'serial.lock', 'pid'), String(process.pid));
    const released = Date.now() + 1500;
    setTimeout(() => rmSync(join(quick.gate, 'serial.lock'), { recursive: true, force: true }), 1500);
    const waited = await gatedAlone(dir, [later], [serial], later, { JEVRIS_SERIAL_GATE_WAIT_S: '120' });
    assert.match(waited.output, /\S/);
    const ran = Number(/ran (\d+)/.exec(readFileSync(log, 'utf8'))?.[1]);
    assert.ok(ran >= released - 50, `the parallel file ran after the lock was let go (${ran - released} ms)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
