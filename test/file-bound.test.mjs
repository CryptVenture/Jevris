// A test file must not outlive a hard bound (coordinator, after D's daemon.test.mjs sat idle for
// 33 minutes on a leaked child's pipes): scripts/test-file-bound.mjs, wired by scripts/test.mjs.
// Every process here is `node` on a stand-in file in a temp folder; no harness binary runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { FILE_BOUND_URL, SERIAL_GATE_URL, fileBound, serialGate, testTimeoutArgs } = await import('../scripts/test.mjs');
const { DEFAULT_FILE_SILENT_S, FILE_SILENT_REASON, descendants, silentBoundMs } = await import('../scripts/test-file-bound.mjs');

/** The environment for a nested node --test run: none of this run's own test-process marks. */
function nestedEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const name of ['NODE_TEST_CONTEXT', 'JT_OWNER_PID', 'JEVRIS_SERIAL_GATE', 'JEVRIS_TEST_FILE_SILENT_S', 'NODE_OPTIONS']) if (!(name in extra)) delete env[name];
  return env;
}

function run(args, cwd, env, capMs = 90_000) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const cap = setTimeout(() => child.kill('SIGKILL'), capMs);
    child.on('close', (code, signal) => {
      clearTimeout(cap);
      done({ code, signal, output, ms: Date.now() - started });
    });
  });
}

function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

test('the bound reads a whole number of seconds, walks the process tree below a pid, and is imported last, after the serial gate', () => {
  assert.equal(silentBoundMs({ JEVRIS_TEST_FILE_SILENT_S: '600' }), 600_000);
  for (const bad of [undefined, '', '0', '-1', '1.5', 'x', '9999999']) assert.equal(silentBoundMs({ JEVRIS_TEST_FILE_SILENT_S: bad }), null, String(bad));
  // 10 -> 11 -> 13, 10 -> 12; 20 is another tree.
  assert.deepEqual(descendants(10, () => [[11, 10], [12, 10], [13, 11], [20, 1], [21, 20]]), [11, 12, 13]);
  assert.deepEqual(descendants(10, () => []), []);
  // Windows: 30 names a parent that died before 10 took its pid, so it is not 10's child.
  assert.deepEqual(descendants(10, () => [[10, 1, 500], [11, 10, 600], [30, 10, 100], [31, 30, 700]]), [11]);
  assert.equal(DEFAULT_FILE_SILENT_S > 300, true, 'above --test-timeout, so a slow test is never cut');
  const gated = { NODE_OPTIONS: `--import=preload --import=${SERIAL_GATE_URL}` };
  const bound = fileBound(gated, {});
  assert.equal(bound.JEVRIS_TEST_FILE_SILENT_S, String(DEFAULT_FILE_SILENT_S));
  assert.equal(bound.NODE_OPTIONS, `--import=preload --import=${SERIAL_GATE_URL} --import=${FILE_BOUND_URL}`);
  assert.equal(fileBound(bound, {}).NODE_OPTIONS, bound.NODE_OPTIONS, 'added once');
  assert.equal(fileBound({}, { JEVRIS_TEST_FILE_SILENT_S: '30' }).JEVRIS_TEST_FILE_SILENT_S, '30');
  assert.equal(fileBound({}, { JEVRIS_TEST_FILE_SILENT_S: 'off' }).JEVRIS_TEST_FILE_SILENT_S, String(DEFAULT_FILE_SILENT_S));
});

test('a file that stays up on an open child after its tests is ended at the bound, fails with FILE_SILENT_BOUND, and its child is ended; the run exits', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'file-bound-'));
  let child = 0;
  // A child still running keeps the folder on Windows: it is ended before the folder goes.
  t.after(() => {
    if (child > 0 && running(child)) process.kill(child, 'SIGKILL');
    rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  });
  writeFileSync(join(dir, 'hang.test.mjs'), [
    "import { test } from 'node:test';",
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "test('passes, then leaves a child that holds the pipes open', () => {",
    "  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
    "  writeFileSync(new URL('./child.pid', import.meta.url), String(child.pid));",
    '});',
  ].join('\n'));
  writeFileSync(join(dir, 'ok.test.mjs'), "import { test } from 'node:test';\ntest('quick', () => {});\n");
  const result = await run(['--test', '--test-reporter=spec', 'hang.test.mjs', 'ok.test.mjs'], dir, nestedEnv({ NODE_OPTIONS: `--import=${FILE_BOUND_URL}`, JEVRIS_TEST_FILE_SILENT_S: '2' }));
  child = Number(readFileSync(join(dir, 'child.pid'), 'utf8'));
  assert.equal(result.signal, null, `the run exited on its own:\n${result.output}`);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, new RegExp(`test file bound: hang\\.test\\.mjs was silent for 2 s \\(JEVRIS_TEST_FILE_SILENT_S\\); it and the 1 process\\(es\\) it started were ended \\(${FILE_SILENT_REASON}\\)`));
  assert.match(result.output, /✖ hang\.test\.mjs/);
  assert.match(result.output, /ℹ pass 2/);
  assert.match(result.output, /ℹ fail 1/);
  assert.equal(running(child), false, 'the child that held the pipes was ended');
});

test('a latency-bound file waiting its turn behind the serial gate is not cut by the bound; a file that keeps writing is not either', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'file-bound-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const slow = join(dir, 'slow.test.mjs');
  const serial = join(dir, 'serial.test.mjs');
  // Runs 5 s, writing every 200 ms: never silent for the 3 s bound.
  writeFileSync(slow, "import { test } from 'node:test';\ntest('slow but writing', async () => { for (let i = 0; i < 25; i += 1) { console.log('tick', i); await new Promise((r) => setTimeout(r, 200)); } });\n");
  writeFileSync(serial, "import { test } from 'node:test';\ntest('ran after the slow file', () => {});\n");
  const gate = serialGate([slow], [serial], dir, { NODE_OPTIONS: '' });
  const bound = fileBound(gate, { JEVRIS_TEST_FILE_SILENT_S: '3' });
  const result = await run(['--test', '--test-reporter=spec', '--test-concurrency=2', slow, serial], dir, nestedEnv({ ...gate, ...bound }));
  assert.equal(result.code, 0, result.output);
  assert.doesNotMatch(result.output, /FILE_SILENT_BOUND/);
  assert.match(result.output, /ℹ pass 2/);
  assert.equal(result.ms >= 4500, true, `the serial file waited for the slow one (${result.ms} ms)`);
});

// CI, Node 22.14.0: --test-timeout=120000 failed every file that ran past two minutes, the serial
// files among them (their wait at the gate counted), because node:test before 24 bounds the whole
// file with it. The runner passes it only where it bounds each test; the pair runs node's own
// behaviour with a 1 s timeout, so a Node release that changes it fails here.
test('the runner passes --test-timeout only on a Node that applies it to each test, not each file', async (t) => {
  assert.deepEqual(testTimeoutArgs('22.14.0'), []);
  assert.deepEqual(testTimeoutArgs('23.11.1'), []);
  assert.deepEqual(testTimeoutArgs('24.0.0'), ['--test-timeout=300000']);
  assert.deepEqual(testTimeoutArgs('26.5.0'), ['--test-timeout=300000']);
  const dir = mkdtempSync(join(tmpdir(), 'file-bound-timeout-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Longer than the 1 s timeout in all, though each test is well inside its own 10 s.
  writeFileSync(join(dir, 'long.test.mjs'), "import { test } from 'node:test';\nfor (let i = 0; i < 3; i += 1) test(`part ${i}`, { timeout: 10_000 }, async () => { await new Promise((r) => setTimeout(r, 500)); });\n");
  const result = await run(['--test', '--test-reporter=spec', '--test-timeout=1000', 'long.test.mjs'], dir, nestedEnv({}));
  const perTest = testTimeoutArgs().length > 0;
  assert.equal(result.code, perTest ? 0 : 1, `Node ${process.versions.node}: --test-timeout ${perTest ? 'bounds each test' : 'bounds the whole file'}\n${result.output}`);
});
