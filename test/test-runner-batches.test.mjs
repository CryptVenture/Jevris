import test from 'node:test';
import assert from 'node:assert/strict';
import { globSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

// The test runner (scripts/test.mjs) and the lint runner (scripts/lint.mjs) put every file they run
// on one `node --test` command line. Windows refuses a command line over 32,767 characters
// (spawnSync fails with ENAMETOOLONG and no test runs), and a checkout at D:\a\Jevris\Jevris\ with
// about 560 test files was over it: the three Windows cells of run 37153768310 ran nothing. The
// runners now keep each command line under a budget (scripts/argv-batches.mjs): a list that fits
// is one process, exactly as before, and a list that does not runs in batches one after another.
// A coverage run is never split (branch coverage does not merge across processes: a merged lcov
// report read about ten points low on branches), so the full suite names its files as glob
// patterns that node expands itself.
//
// Nothing here runs a test: the spawn is injected, and the file lists are the repository's real
// ones moved to a simulated Windows or Linux checkout root.

const root = fileURLToPath(new URL('..', import.meta.url));
const { ARGV_BUDGET_POSIX, ARGV_BUDGET_WINDOWS, MIN_ARGV_BUDGET, argvBudget, batchFiles, commandLength, planRuns } = await import('../scripts/argv-batches.mjs');
const runner = await import('../scripts/test.mjs');
const { collectLintFiles } = await import('../scripts/lint.mjs');
const { parseCounts } = await import('../scripts/verify-fresh.mjs');

const WINDOWS_LIMIT = 32_767;
const WINDOWS_NODE = 'C:\\hostedtoolcache\\windows\\node\\22.14.0\\x64\\node.exe';
const POSIX_NODE = '/opt/hostedtoolcache/node/22.14.0/x64/bin/node';
const WINDOWS_CI_ROOT = 'D:\\a\\Jevris\\Jevris';
const POSIX_CI_ROOT = '/home/runner/work/Jevris/Jevris';
const LONG_WINDOWS_ROOT = `C:\\${'a-long-folder-name\\'.repeat(11)}Jevris`;

const here = (file) => relative(root, file).split(/[\\/]/);

/** The repository's real test files, split as the runner splits them, moved under another root. */
function realFiles(api, to) {
  const { parallel, serial } = runner.splitSerial(runner.collectTestFiles(root), root);
  const move = (file) => api.join(to, ...here(file));
  return { parallel: parallel.map(move), serial: serial.map(move) };
}

/** An injected spawn that records each command line and answers with the status the caller picks. */
function recorder(status = () => 0, onCall = () => {}) {
  const calls = [];
  const spawn = (program, args) => {
    calls.push({ program, args });
    onCall(calls.length, args);
    return { status: status(calls.length) };
  };
  return { calls, spawn };
}

const isFile = (arg) => !arg.startsWith('--');

/** Runs the runner's own planning and spawning over `files` with an injected spawn. */
function run(files, { program, budget, status, onCall, processEnv = {}, base } = {}) {
  const runTemp = mkdtempSync(join(tmpdir(), 'trb-'));
  const lines = [];
  try {
    const { calls, spawn } = recorder(status, onCall);
    const result = runner.runTestFiles({ ...files, spawnOptions: {}, runTemp, spawn, program, processEnv, budget, ...(base === undefined ? {} : { base }), log: (line) => lines.push(line) });
    return { ...result, calls, lines, runTemp };
  } finally {
    rmSync(runTemp, { recursive: true, force: true });
  }
}

/** The facts every split run keeps: nothing over the budget, no file lost, serial files last and alone. */
function assertSound({ calls, parallel, serial, budget, program }) {
  for (const { args } of calls) {
    assert.ok(commandLength(program, args) <= budget, `a command line of ${commandLength(program, args)} characters is over the budget of ${budget}`);
    if (budget <= ARGV_BUDGET_WINDOWS) assert.ok(`"${program}" ${args.join(' ')}`.length <= WINDOWS_LIMIT, 'and under what Windows refuses');
    assert.equal(args[0], '--test');
  }
  assert.deepEqual(calls.flatMap(({ args }) => args.filter(isFile)), [...parallel, ...serial], 'every file runs once, in order');
  // One process holds the serial files with the serial gate (scripts/test-serial-gate.mjs); a split run runs each alone.
  if (calls.length === 1) return;
  const last = calls.slice(calls.length - serial.length);
  assert.deepEqual(last.map(({ args }) => args.filter(isFile)), serial.map((file) => [file]), 'each serial file runs alone, after all the others');
  for (const { args } of calls.slice(0, calls.length - serial.length)) assert.equal(args.filter(isFile).some((file) => serial.includes(file)), false, 'no serial file runs beside another file');
}

test('the one-process command line for the real file set is over what Windows allows, which is why the runner batches (CI run 37153768310)', () => {
  const { parallel, serial } = realFiles(win32, LONG_WINDOWS_ROOT);
  assert.ok(commandLength(WINDOWS_NODE, ['--test', ...parallel, ...serial]) > WINDOWS_LIMIT);
  const ci = realFiles(win32, WINDOWS_CI_ROOT);
  // The measured figure for the CI root is about 34,300 characters (more than 32,767 at the time of the failure).
  assert.ok(commandLength(WINDOWS_NODE, ['--test', ...ci.parallel, ...ci.serial]) > ARGV_BUDGET_WINDOWS, 'the list does not fit the Windows budget in one process');
});

test('on the Windows CI checkout root the real file set runs in command lines under the budget, in order, with the serial files last and alone', () => {
  const files = realFiles(win32, WINDOWS_CI_ROOT);
  const { calls, code, runs } = run(files, { program: WINDOWS_NODE, budget: argvBudget({}, 'win32') });
  assert.equal(code, 0);
  assert.equal(runs, calls.length);
  assert.ok(calls.length >= files.serial.length + 2, 'more than one batch of the other files');
  assertSound({ calls, ...files, budget: ARGV_BUDGET_WINDOWS, program: WINDOWS_NODE });
});

test('a pathological checkout root with 200-character folders still runs every file, in batches under the budget', () => {
  const files = realFiles(win32, LONG_WINDOWS_ROOT);
  assert.ok(LONG_WINDOWS_ROOT.length > 200);
  const { calls } = run(files, { program: WINDOWS_NODE, budget: argvBudget({}, 'win32') });
  assert.ok(calls.length > files.serial.length + 4);
  assertSound({ calls, ...files, budget: ARGV_BUDGET_WINDOWS, program: WINDOWS_NODE });
});

test('no number of files can overflow it: ten times the real list, with the real paths, still batches under the budget', () => {
  const real = realFiles(win32, WINDOWS_CI_ROOT);
  const many = { parallel: Array.from({ length: 10 }, (_, i) => real.parallel.map((file) => file.replace('.test.mjs', `-${i}.test.mjs`))).flat(), serial: real.serial };
  const { calls } = run(many, { program: WINDOWS_NODE, budget: argvBudget({}, 'win32') });
  assertSound({ calls, ...many, budget: ARGV_BUDGET_WINDOWS, program: WINDOWS_NODE });
});

test('a list that fits the budget is one process with the files in the given order, exactly as before (Linux, macOS and a short Windows list)', () => {
  const posix200 = realFiles(posix, POSIX_CI_ROOT);
  const some = { parallel: posix200.parallel.slice(0, 200), serial: posix200.serial };
  const { calls, runs } = run(some, { program: POSIX_NODE, budget: argvBudget({}, 'linux') });
  assert.equal(runs, 1);
  assert.deepEqual(calls[0].args, ['--test', ...runner.testTimeoutArgs(), ...some.parallel, ...some.serial]);
  const win = realFiles(win32, WINDOWS_CI_ROOT);
  const few = { parallel: win.parallel.slice(0, 100), serial: win.serial };
  const second = run(few, { program: WINDOWS_NODE, budget: argvBudget({}, 'win32') });
  assert.equal(second.runs, 1);
  assert.deepEqual(second.calls[0].args, ['--test', ...runner.testTimeoutArgs(), ...few.parallel, ...few.serial]);
  assert.deepEqual(second.lines, [], 'a one-process run prints nothing of its own');
});

test('on Linux and macOS the real file set stays within the posix budget, so it stays one process until it outgrows 100,000 characters', () => {
  assert.equal(argvBudget({}, 'linux'), ARGV_BUDGET_POSIX);
  assert.equal(argvBudget({}, 'darwin'), ARGV_BUDGET_POSIX);
  assert.equal(argvBudget({}, 'win32'), ARGV_BUDGET_WINDOWS);
  const files = realFiles(posix, POSIX_CI_ROOT);
  const { calls } = run(files, { program: POSIX_NODE, budget: argvBudget({}, 'linux') });
  assertSound({ calls, ...files, budget: ARGV_BUDGET_POSIX, program: POSIX_NODE });
});

test('JEVRIS_TEST_ARGV_BUDGET forces a split on any host, and a bad value changes nothing', () => {
  assert.equal(argvBudget({ JEVRIS_TEST_ARGV_BUDGET: '4000' }, 'linux'), 4000);
  assert.equal(argvBudget({ JEVRIS_TEST_ARGV_BUDGET: '5' }, 'linux'), MIN_ARGV_BUDGET);
  for (const bad of ['', '0', '-5', 'abc', '1e6', '12.5', ' 4000']) assert.equal(argvBudget({ JEVRIS_TEST_ARGV_BUDGET: bad }, 'linux'), ARGV_BUDGET_POSIX, bad);
  const files = realFiles(posix, POSIX_CI_ROOT);
  const budget = argvBudget({ JEVRIS_TEST_ARGV_BUDGET: '4000' }, 'linux');
  const { calls } = run(files, { program: POSIX_NODE, budget });
  assert.ok(calls.length > files.serial.length + 5);
  assertSound({ calls, ...files, budget, program: POSIX_NODE });
});

test('a failing batch does not stop the others, and the exit code is the first failure', () => {
  const files = realFiles(win32, WINDOWS_CI_ROOT);
  const statuses = new Map([[2, 3], [4, 1]]);
  const { calls, code } = run(files, { program: WINDOWS_NODE, budget: ARGV_BUDGET_WINDOWS, status: (n) => statuses.get(n) ?? 0 });
  assert.equal(code, 3);
  assert.deepEqual(calls.flatMap(({ args }) => args.filter(isFile)), [...files.parallel, ...files.serial]);
  const killed = run(files, { program: WINDOWS_NODE, budget: ARGV_BUDGET_WINDOWS, status: (n) => (n === 1 ? null : 0) });
  assert.equal(killed.code, 1, 'a batch killed by a signal fails the run');
  assert.throws(() => {
    const dir = mkdtempSync(join(tmpdir(), 'trb-'));
    try {
      runner.runTestFiles({ ...files, spawnOptions: {}, runTemp: dir, spawn: () => ({ error: new Error('spawn failed') }), program: WINDOWS_NODE, processEnv: {}, budget: ARGV_BUDGET_WINDOWS, log: () => {} });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, /spawn failed/);
});

/** Writes what a batch's reporters would have written to the destinations on its command line. */
function reporters(perBatch) {
  return (n, args) => {
    const to = (suffix) => args.find((arg) => arg.startsWith('--test-reporter-destination=') && arg.endsWith(suffix))?.slice('--test-reporter-destination='.length);
    const batch = perBatch(n);
    for (const [suffix, text] of [['.events', batch.events], ['.summary', batch.summary]]) {
      const path = to(suffix);
      if (path !== undefined && text !== undefined) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
      }
    }
  };
}

test('a split run reports as one: the counts are added into one summary and the events joined in order', () => {
  const files = realFiles(win32, WINDOWS_CI_ROOT);
  const out = mkdtempSync(join(tmpdir(), 'trb-out-'));
  try {
    const events = join(out, 'events.jsonl');
    const expected = { tests: 0, pass: 0, skipped: 0, fail: 0 };
    const result = run(files, {
      program: WINDOWS_NODE,
      budget: ARGV_BUDGET_WINDOWS,
      processEnv: { JEVRIS_TEST_EVENTS: events },
      onCall: reporters((n) => {
        expected.tests += 10 + n;
        expected.pass += 9 + n;
        expected.skipped += 1;
        return {
          events: `{"file":"f${n}","name":"t","passed":true,"skipped":false}\n`,
          summary: `${JSON.stringify({ tests: 10 + n, suites: 0, pass: 9 + n, fail: 0, cancelled: 0, skipped: 1, todo: 0, duration_ms: 1000.5 })}\n`,
        };
      }),
    });
    const { calls } = result;
    // Each batch got its own destinations (stdout, the events and the summary), none the real file.
    for (const { args } of calls) {
      const destinations = args.filter((arg) => arg.startsWith('--test-reporter-destination='));
      assert.equal(destinations.length, 3, 'stdout, the events and the summary');
      assert.ok(!destinations.includes(`--test-reporter-destination=${events}`));
      assert.equal(args.filter((arg) => arg.startsWith('--test-reporter=')).length, 3);
    }
    // The events are the batches' lines, in batch order.
    assert.deepEqual(readFileSync(events, 'utf8').split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line).file), calls.map((_, i) => `f${i + 1}`));
    // One summary, in the form verify:fresh reads, the sum of the batches.
    const counts = parseCounts(result.lines.join('\n'));
    assert.deepEqual([counts.tests, counts.pass, counts.skipped, counts.fail], [expected.tests, expected.pass, expected.skipped, expected.fail]);
    assert.equal(result.lines.at(-1), 'ℹ duration_ms ' + String(1000.5 * calls.length));
    assert.match(result.lines[0], /^test: \d+ test files need a command line of \d+ characters, over the budget of 20000 \(Windows refuses 32,767\), so they run in \d+ batch\(es\) one after another, then 5 latency-bound file\(s\) each alone$/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('a coverage run is never split: the full suite names its files as glob patterns that expand to exactly the same files, and a long list of named files stops', () => {
  const win = realFiles(win32, WINDOWS_CI_ROOT);
  const lcov = join(tmpdir(), 'trb-never-written.lcov');
  const processEnv = { JEVRIS_TEST_COVERAGE_LCOV: lcov };
  const patterns = runner.testPatterns(root);
  const full = run({ ...win, patterns }, { program: WINDOWS_NODE, budget: ARGV_BUDGET_WINDOWS, processEnv });
  assert.equal(full.calls.length, 1, 'one process');
  assert.deepEqual(full.calls[0].args, ['--test', ...runner.testTimeoutArgs(), ...runner.coverageArgs(processEnv), ...patterns]);
  assert.ok(full.calls[0].args.includes(`--test-reporter-destination=${lcov}`), 'the real lcov file, not a part');
  assert.ok(commandLength(WINDOWS_NODE, full.calls[0].args) < 3000, 'a couple of dozen short patterns');
  assert.match(full.lines[0], /so this coverage run names them as \d+ glob patterns that node expands itself: the same files, one process$/);
  // A long list of named files cannot be a pattern list: it stops, and runs nothing.
  const named = run(win, { program: WINDOWS_NODE, budget: ARGV_BUDGET_WINDOWS, processEnv });
  assert.equal(named.code, 2);
  assert.equal(named.calls.length, 0);
  assert.match(named.lines[0], /a coverage run cannot be split into batches/);
  // node expands the patterns with the glob engine fs.globSync shares: the files are exactly collectTestFiles'.
  const expanded = patterns.flatMap((pattern) => globSync(pattern, { cwd: root })).map((file) => resolve(root, file)).sort();
  assert.deepEqual(expanded, runner.collectTestFiles(root).map((file) => resolve(file)).sort());
  assert.ok(patterns.length > 15 && patterns.every((pattern) => !pattern.includes('\\') && !isAbsolutePath(pattern)));
  // The patterns do not depend on the checkout root, so no root, however deep, makes the line longer.
  assert.deepEqual(runner.testPatterns(root), patterns);
});

const isAbsolutePath = (path) => posix.isAbsolute(path) || win32.isAbsolute(path);

test('a one-process run keeps its reporters pointing at the real files, so a short run is exactly what it was', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trb-one-'));
  try {
    const lcov = join(dir, 'lcov.info');
    const events = join(dir, 'events.jsonl');
    const some = { parallel: [join(dir, 'a.test.mjs')], serial: [] };
    const { calls } = run(some, { program: POSIX_NODE, budget: ARGV_BUDGET_POSIX, processEnv: { JEVRIS_TEST_COVERAGE_LCOV: lcov, JEVRIS_TEST_EVENTS: events } });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['--test', ...runner.testTimeoutArgs(), ...runner.coverageArgs({ JEVRIS_TEST_COVERAGE_LCOV: lcov }), ...runner.eventArgs({ JEVRIS_TEST_COVERAGE_LCOV: lcov, JEVRIS_TEST_EVENTS: events }), ...some.parallel]);
    assert.ok(calls[0].args.includes(`--test-reporter-destination=${lcov}`));
    assert.ok(calls[0].args.includes(`--test-reporter-destination=${events}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the lint runner and the acceptance report stay far under the limit on the Windows CI root, and the lint runner batches the same way', () => {
  const toWindows = (file) => win32.join(WINDOWS_CI_ROOT, ...here(file));
  const lint = collectLintFiles(root).map(toWindows);
  assert.ok(lint.length > 20);
  assert.ok(commandLength(WINDOWS_NODE, ['--test', ...lint]) < ARGV_BUDGET_WINDOWS, 'the lint list is one process today');
  // And it still batches when it must (a long root and a small budget), with the lint runner's own flags (no timeout).
  const long = collectLintFiles(root).map((file) => win32.join(LONG_WINDOWS_ROOT, ...here(file)));
  const { calls } = run({ parallel: long, serial: [] }, { program: WINDOWS_NODE, budget: 8000, base: ['--test'] });
  assert.ok(calls.length >= 2);
  assert.deepEqual(calls.flatMap(({ args }) => args.filter(isFile)), long);
  for (const { args } of calls) assert.ok(commandLength(WINDOWS_NODE, args) <= 8000);
  assert.deepEqual(calls[0].args.slice(0, 1), ['--test']);
  // acceptance-report starts `node scripts/test.mjs --no-build <every acceptance file>`: that outer line must fit too.
  const acceptance = readdirSync(join(root, 'test', 'acceptance')).filter((name) => name.endsWith('.test.mjs')).map((name) => win32.join(WINDOWS_CI_ROOT, 'test', 'acceptance', name));
  assert.ok(acceptance.length > 40);
  assert.ok(commandLength(WINDOWS_NODE, [win32.join(WINDOWS_CI_ROOT, 'scripts', 'test.mjs'), '--no-build', ...acceptance]) < ARGV_BUDGET_WINDOWS / 2, 'the acceptance report passes its files to the runner, so its own line needs room to grow');
});

test('batchFiles never drops, repeats or reorders a file, never leaves a batch empty and never exceeds the budget when it can avoid it', () => {
  assert.deepEqual(batchFiles([], { program: 'node', fixed: ['--test'], budget: 2000 }), []);
  // A file that cannot fit beside the fixed arguments still runs, alone.
  const big = 'x'.repeat(3000);
  assert.deepEqual(batchFiles(['a', big, 'b'], { program: 'node', fixed: ['--test'], budget: 2000 }), [['a'], [big], ['b']]);
  // An exact fit stays together, one more character splits.
  const budgetFor = (words) => commandLength('node', ['--test']) + words.reduce((sum, word) => sum + word.length + 3, 0);
  const names = ['aaaa', 'bbbb', 'cccc'];
  assert.deepEqual(batchFiles(names, { program: 'node', fixed: ['--test'], budget: budgetFor(names) }), [names]);
  assert.deepEqual(batchFiles(names, { program: 'node', fixed: ['--test'], budget: budgetFor(names) - 1 }), [['aaaa', 'bbbb'], ['cccc']]);
  // Seeded pseudo-random lengths.
  let seed = 12345;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed;
  };
  for (let round = 0; round < 50; round += 1) {
    const files = Array.from({ length: 1 + (next() % 300) }, (_, i) => `f${i}-${'p'.repeat(next() % 400)}`);
    const budget = 1500 + (next() % 20000);
    const batches = batchFiles(files, { program: 'node', fixed: ['--test', '--x=1'], budget });
    assert.deepEqual(batches.flat(), files);
    for (const batch of batches) {
      assert.ok(batch.length > 0);
      if (batch.length > 1) assert.ok(commandLength('node', ['--test', '--x=1', ...batch]) <= budget);
    }
  }
  // planRuns: the one-run form when it fits, otherwise batches then each serial file alone.
  const fits = planRuns({ parallel: ['a', 'b'], serial: ['s'], program: 'node', flags: ['--test'], budget: 1000 });
  assert.deepEqual(fits, [['a', 'b', 's']]);
  const split = planRuns({ parallel: ['a'.repeat(400), 'b'.repeat(400), 'c'.repeat(400)], serial: ['s1', 's2'], program: 'node', flags: ['--test'], budget: 1000 });
  assert.deepEqual(split, [['a'.repeat(400), 'b'.repeat(400)], ['c'.repeat(400)], ['s1'], ['s2']]);
});
