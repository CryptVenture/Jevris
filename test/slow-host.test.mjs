// The slow-host kit (scripts/slow-host.mjs, scripts/slow-host-preload.cjs, scripts/test-slow.mjs): the options, the quick set found
// by a scan, the burners and the freezer with stub processes, the git wrapper, the environment, the preload in real children, and a
// whole run with a stub runner. Nothing here runs the suite or starts a CPU burner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { SERIAL_TEST_FILES, budgetScaleFor } from '../scripts/test.mjs';
import {
  DEFAULTS, PRELOAD_FILE, RETRYABLE_ERROR_RULES, burnerSource, descendantsOf, describeFaults, failedTests, faultTotals, findOnPath, freezable, gitWrapperScript, groupFailures, parseSlowArgs,
  quickSignals, quickTestFiles, refuseWindows, runSlow, seededRandom, slowConfig, slowEnvironment, startBurners, startFreezer, summaryCounts, writeKit,
} from '../scripts/slow-host.mjs';

/** The kit's processes (a preload in NODE_OPTIONS, an sh wrapper, signals) are for POSIX hosts: it refuses to run on Windows. */
const posix = process.platform === 'win32' ? 'the kit is for POSIX hosts' : false;
const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const dirs = [];
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'slowkit-'));
  dirs.push(dir);
  t?.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The options of a kit that adds nothing but what a test turns on: no start delay, no git delay, no stalls. */
function quietOptions(...extra) {
  const options = parseSlowArgs(['--burners', '0', '--freeze-rate', '0', '--fs-delay', '0', '--fs-stall', '0', '--fs-error-rate', '0', '--start-delay', '0', '--git-delay', '0', '--sqlite-delay', '0', '--sqlite-stall', '0', ...extra]);
  options.startStallRate = 0;
  options.gitLongRate = 0;
  return options;
}

test('the options: defaults are three burners per core and the Windows runner\'s settings, and every flag is checked', () => {
  const o = parseSlowArgs([], 4);
  assert.deepEqual([o.burners, o.runs, o.quick, o.build, o.scale, o.files], [12, 1, false, true, null, []], '3 per core on 4 cores');
  assert.deepEqual([o.fsDelayMs, o.startDelayMs, o.gitDelayMs, o.freezeRate, o.fsErrorRate, o.fsErrorFirst], [6, 300, 100, 0.04, 0.02, false]);
  const q = parseSlowArgs(['--quick', '--runs', '3', '--burners', '5', '--scale', '4', '--seed', '9', '--no-build', '--keep', '--no-env-inject', '--freeze-ms', '100-900', '--fs-match', 'jtmp$', '--fs-error-first']);
  assert.deepEqual([q.quick, q.runs, q.burners, q.scale, q.seed, q.build, q.keep, q.injectEnv, q.freezeMinMs, q.freezeMaxMs, q.fsMatch, q.fsErrorFirst], [true, 3, 5, '4', 9, false, true, false, 100, 900, 'jtmp$', true]);
  const harsh = parseSlowArgs(['--harsh']);
  assert.deepEqual([harsh.freezeRate, harsh.fsStallRate, harsh.gitDelayMs, harsh.startStallRate, harsh.fsBurstExtra], [0.1, 0.002, 300, 0.05, 2], '--harsh is the first, harsher settings');
  assert.equal(parseSlowArgs(['--harsh', '--freeze-rate', '0.2']).freezeRate, 0.2, 'a flag beside it wins');
  assert.equal(parseSlowArgs(['--freeze-rate', '0.2', '--harsh']).freezeRate, 0.2, 'whatever the order');
  assert.deepEqual(parseSlowArgs(['a.test.mjs', 'b.test.mjs']).files, ['a.test.mjs', 'b.test.mjs']);
  assert.deepEqual(parseSlowArgs(['--', '--odd-name.test.mjs']).files, ['--odd-name.test.mjs']);
  assert.deepEqual(parseSlowArgs(['--fs-error-rule', '{"ops":["rename"],"match":"x$","on":"from"}']).fsErrorRules, [{ ops: ['rename'], match: 'x$', on: 'from' }]);
  for (const bad of [['--runs', '0'], ['--runs', 'x'], ['--burners', '-1'], ['--scale', '99'], ['--fs-stall', '2'], ['--fs-error-rate', 'x'], ['--freeze-ms', '900-100'], ['--freeze-ms', 'x'], ['--fs-match', '('], ['--fs-error-rule', '{}'], ['--bogus'], ['--runs'], ['--quick', 'a.test.mjs']]) {
    assert.throws(() => parseSlowArgs(bad), Error, bad.join(' '));
  }
});

test('the quick set is found by a scan of the test files: every latency-bound file and every file that starts a sidecar, a daemon, a hook or the CLI', () => {
  for (const [text, signal] of [
    ["const s = await startDaemon({ home });", 'daemon'],
    ["await withDaemon(t, async () => {});", 'daemon'],
    ["const out = ensureSidecar({ home });", 'sidecar'],
    ["run(['sidecar', 'start', '--home', home]);", 'sidecar'],
    // Built in two pieces, so lint/slow-ci.lint.mjs (bare-env) does not read this fixture as a child's environment.
    [`const env = { ${'JEVRIS_SIDECAR'}_ENTRY: ENTRY };`, 'sidecar'],
    ["import { story } from './lib.mjs';", 'story'],
    ["const r = runCli(['status']);", 'cli'],
    ["const bin = join(root, 'bin', 'jevris.mjs');", 'cli'],
    ["const hook = join(root, 'dist', 'hook.mjs');", 'hook'],
    ["warmHooks(box, 'claude', make);", 'hook'],
  ]) assert.deepEqual(quickSignals(text), [signal], text);
  assert.deepEqual(quickSignals("assert.equal(add(1, 2), 3);\nconst { x } = await import('../dist/x.js');"), [], 'a unit test is not in it');
  // With stub files: a serial file is in whatever it holds, a scanned one by its text, a plain one never.
  const files = [join(root, SERIAL_TEST_FILES[0]), join(root, 'a', 'test', 'daemon-user.test.mjs'), join(root, 'a', 'test', 'plain.test.mjs')];
  const texts = new Map([[files[0], 'nothing'], [files[1], 'await startDaemon({});'], [files[2], 'assert.ok(true);']]);
  assert.deepEqual(quickTestFiles(root, files, (file) => texts.get(file)), [SERIAL_TEST_FILES[0], 'a/test/daemon-user.test.mjs'].sort());
  // The real tree: every latency-bound file, the acceptance stories and a good part of the suite, and not all of it.
  const real = quickTestFiles(root);
  for (const file of SERIAL_TEST_FILES) assert.ok(real.includes(file), `${file} is in the quick set`);
  assert.ok(real.includes('test/acceptance/us29.test.mjs'));
  assert.ok(real.includes('apps/sidecar/test/pending-advice-held.test.mjs'));
  assert.ok(real.includes('apps/cli/test/runtime-commands.test.mjs'));
  assert.ok(real.length > 50 && real.length < 400, `${real.length} files`);
  assert.deepEqual(real, [...real].sort());
});

test('burners: only the pids the kit started are signalled, once, also after a failed start; a burner ends when its parent has gone', () => {
  const started = [];
  const killed = [];
  const spawnFn = (program, args, options) => {
    started.push({ program, args, options });
    return { pid: 9000 + started.length, unref() {} };
  };
  const burn = startBurners(3, { spawnFn, kill: (pid) => killed.push(pid), parentPid: 4242, hook: false });
  assert.deepEqual(burn.pids, [9001, 9002, 9003]);
  assert.equal(started.length, 3);
  assert.ok(started.every((s) => s.args[0] === '-e' && s.options.stdio === 'ignore'), 'a bare node loop with no output');
  assert.ok(started.every((s) => !('JEVRIS_TEST' in s.options.env) && !('NODE_OPTIONS' in s.options.env)), 'the burner gets nothing of the run\'s environment');
  burn.stop();
  burn.stop();
  assert.deepEqual(killed, [9001, 9002, 9003], 'each pid once');
  // A start that fails midway stops what it started, and throws.
  const half = [];
  let count = 0;
  assert.throws(() => startBurners(4, { spawnFn: () => { count += 1; if (count === 3) throw new Error('no more'); return { pid: 100 + count }; }, kill: (pid) => half.push(pid), hook: false }), /no more/);
  assert.deepEqual(half, [101, 102]);
  // A pid that is already gone is not an error.
  const gone = startBurners(1, { spawnFn: () => ({ pid: 7 }), kill: () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); }, hook: false });
  assert.doesNotThrow(() => gone.stop());
  // The loop's code compiles, names its parent, and is the only thing a burner runs.
  const source = burnerSource(4242);
  assert.doesNotThrow(() => new vm.Script(source));
  assert.match(source, /const p=4242,/);
  assert.match(source, /process\.kill\(p,0\)/);
});

test('a burner really ends by itself when its parent has gone (no orphan is left running)', { skip: posix }, (t) => {
  // The parent pid names a process that does not exist; the burner checks it on its first turn and exits at once.
  const dir = temp(t);
  const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const deadPid = Number(probe.stdout);
  writeFileSync(join(dir, 'b.cjs'), burnerSource(deadPid));
  const started = Date.now();
  const run = spawnSync(process.execPath, [join(dir, 'b.cjs')], { timeout: 60_000, encoding: 'utf8' });
  assert.equal(run.status, 0, 'it exited on its own');
  assert.ok(Date.now() - started < 60_000);
});

test('the freezer: it stops one process below the runner for a moment, resumes it through a shell that outlives the kit, and never signals anything else', () => {
  const listing = [
    '    1     0 /sbin/launchd',
    '  100     1 node scripts/test-slow.mjs',
    '  200   100 node scripts/test.mjs --no-build',
    '  300   200 node --test --test-reporter=spec a.test.mjs',
    '  400   300 /usr/bin/node /x/test/a.test.mjs',
    '  500   400 /usr/bin/node /x/dist/sidecar.mjs --home /h',
    '  600   500 sleep 1',
    '  700     1 node /elsewhere/other-agent.mjs',
    '  800   100 ps -A -o pid=,ppid=,args=',
    'not a line',
  ].join('\n');
  const below = descendantsOf(listing, 200).map((row) => row.pid);
  assert.deepEqual(below, [300, 400, 500, 600], 'only what is below the root, the root itself and other trees excluded');
  assert.deepEqual(descendantsOf(listing, 200).filter(freezable).map((row) => row.pid), [400, 500], 'not the node --test runner, not a sleep');
  const signalled = [];
  const shells = [];
  let tick = null;
  const sequence = [0.01, 0.2, 0.9];
  const freezer = startFreezer({
    rootPid: 200, rate: 0.5, minMs: 300, maxMs: 1500, tickMs: 10, list: () => listing,
    signal: (pid, name) => signalled.push([pid, name]),
    spawnFn: (file, args, options) => {
      shells.push({ file, args, options });
      return { unref() {} };
    },
    random: () => sequence.shift() ?? 0.99,
    timers: { setInterval: (fn) => { tick = fn; return { unref() {} }; }, clearInterval() {} },
  });
  tick();
  assert.equal(freezer.stats.freezes, 1);
  assert.deepEqual(signalled, [[400, 'SIGSTOP']], 'the first candidate, stopped');
  assert.equal(shells.length, 1);
  assert.equal(shells[0].file, '/bin/sh');
  assert.match(shells[0].args[1], /^sleep \d+\.\d{3}; kill -CONT 400 /, 'the resume is a shell command for that pid');
  assert.deepEqual([shells[0].options.detached, shells[0].options.stdio], [true, 'ignore'], 'it outlives this process');
  assert.ok(freezer.stats.frozenMs >= 300 && freezer.stats.frozenMs <= 1500);
  tick(); // random() is now 0.99 >= rate: nothing happens
  assert.equal(freezer.stats.freezes, 1);
  freezer.stop();
  assert.deepEqual(signalled.at(-1), [400, 'SIGCONT'], 'stop resumes what is still frozen');
  assert.ok(signalled.every(([pid]) => [400, 500].includes(pid)), 'never the root, a runner, another tree');
  // A rate of 0 starts no timer; a tick with nothing to freeze signals nothing.
  let timers = 0;
  startFreezer({ rootPid: 200, rate: 0, minMs: 1, maxMs: 2, list: () => '', signal() {}, timers: { setInterval: () => { timers += 1; return {}; }, clearInterval() {} } });
  assert.equal(timers, 0);
  const none = [];
  let again = null;
  startFreezer({ rootPid: 200, rate: 1, minMs: 1, maxMs: 2, list: () => '  200     1 node x', signal: (pid) => none.push(pid), random: () => 0, timers: { setInterval: (fn) => { again = fn; return { unref() {} }; }, clearInterval() {} } });
  again();
  assert.deepEqual(none, []);
  // A seeded source repeats and stays in [0, 1).
  const a = seededRandom(7);
  const b = seededRandom(7);
  const draws = Array.from({ length: 5 }, () => a());
  assert.deepEqual(draws, Array.from({ length: 5 }, () => b()));
  assert.ok(draws.every((x) => x >= 0 && x < 1));
});

test('the git wrapper waits, counts the call, and runs the real git with the same arguments', { skip: posix }, (t) => {
  const dir = temp(t);
  const real = join(dir, 'realgit');
  writeFileSync(real, '#!/bin/sh\necho "real git: $@"\n');
  chmodSync(real, 0o755);
  const calls = join(dir, 'calls');
  writeFileSync(calls, '');
  const script = gitWrapperScript({ realGit: real, shortMs: 120, longMs: 2000, longRate: 0, callsFile: calls });
  assert.match(script, /^#!\/bin\/sh/);
  assert.match(script, /sleep 0\.120/);
  assert.match(script, /sleep 2\.000/);
  writeFileSync(join(dir, 'git'), script);
  chmodSync(join(dir, 'git'), 0o755);
  const began = Date.now();
  const run = spawnSync(join(dir, 'git'), ['status', '-s', 'a b'], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.equal(run.stdout, 'real git: status -s a b\n');
  assert.ok(Date.now() - began >= 100, 'it waited');
  assert.equal(readFileSync(calls, 'utf8'), '.', 'one call counted');
  assert.equal(findOnPath('realgit', ['/nope', dir].join(delimiter)), real);
  assert.equal(findOnPath('realgit', dir, dir), null, 'the kit\'s own folder is skipped');
  assert.equal(findOnPath('realgit', '/nope'), null);
});

test('the kit folder holds the enable file, a git wrapper only when git is found and the delay is on, and a log; the environment carries them', (t) => {
  const dir = temp(t);
  const fakeBin = join(dir, 'fake-bin');
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'git'), '#!/bin/sh\n');
  chmodSync(join(fakeBin, 'git'), 0o755);
  const options = parseSlowArgs(['--burners', '0']);
  const kit = writeKit(join(dir, 'kit'), options, { pathValue: fakeBin, runIndex: 2 });
  assert.equal(kit.gitWrapped, true);
  assert.ok(existsSync(join(kit.bin, 'git')));
  assert.equal(kit.config.seed, options.seed + 2, 'each run draws its own faults');
  const enable = readFileSync(kit.enable, 'utf8');
  assert.match(enable, /process\.env\.JEVRIS_SLOW_CONFIG = process\.env\.JEVRIS_SLOW_CONFIG \|\|/);
  assert.ok(enable.includes(JSON.stringify(PRELOAD_FILE)), 'it requires the preload by its absolute path');
  assert.equal(JSON.parse(JSON.parse(enable.match(/\|\| (".*");/)[1])).active, true);
  assert.equal(writeKit(join(dir, 'kit2'), parseSlowArgs(['--git-delay', '0']), { pathValue: fakeBin }).gitWrapped, false, 'no delay, no wrapper');
  assert.equal(writeKit(join(dir, 'kit3'), options, { pathValue: '/nope' }).gitWrapped, false, 'no git, no wrapper');
  // The environment: the preload and the kit's git first, the runner's own budget scale, the events file, and the caller's own settings kept.
  const base = { PATH: '/usr/bin', NODE_OPTIONS: '--max-old-space-size=512', CI: undefined };
  const env = slowEnvironment(base, kit, options, { eventsFile: '/e.jsonl' });
  assert.equal(env.PATH, `${kit.bin}${delimiter}/usr/bin`);
  assert.equal(env.NODE_OPTIONS, `--max-old-space-size=512 --require=${kit.enable}`);
  assert.equal(env.JEVRIS_TEST_BUDGET_SCALE, '6', 'what the runner gives the Windows cell under CI');
  assert.equal(env.JEVRIS_TEST_BUDGET_SCALE, budgetScaleFor({ CI: '1' }, 'win32'));
  assert.equal(env.JEVRIS_TEST_EVENTS, '/e.jsonl');
  assert.equal(JSON.parse(env.JEVRIS_SLOW_CONFIG).active, true);
  assert.equal(slowEnvironment({ ...base, JEVRIS_TEST_BUDGET_SCALE: '3' }, kit, options, { eventsFile: '/e' }).JEVRIS_TEST_BUDGET_SCALE, '3', 'a caller\'s own value wins');
  assert.equal(slowEnvironment(base, kit, { ...options, scale: '9' }, { eventsFile: '/e' }).JEVRIS_TEST_BUDGET_SCALE, '9', '--scale wins');
  assert.equal(slowEnvironment(env, kit, options, { eventsFile: '/e' }).NODE_OPTIONS, env.NODE_OPTIONS, 'the preload is not added twice');
  assert.equal(slowEnvironment({ PATH: '/usr/bin' }, writeKit(join(dir, 'kit4'), parseSlowArgs(['--git-delay', '0']), { pathValue: fakeBin }), options, { eventsFile: '/e' }).PATH, '/usr/bin', 'no wrapper, PATH as it was');
  // The default error rules are the operations the product retries, and only those.
  assert.deepEqual(RETRYABLE_ERROR_RULES.map((r) => r.ops.join('+')), ['write+appendFile', 'rename', 'unlink']);
  assert.deepEqual(slowConfig(parseSlowArgs(['--fs-error-rate', '0']), {}).fs.errors.rules, [], 'no rate, no rule');
  assert.equal(slowConfig(parseSlowArgs(['--fs-error-first']), {}).fs.errors.firstPerPath, true);
  assert.equal(DEFAULTS.burnersPerCore, 3);
});

/** Runs `script` in a node child whose preload is the kit's, in a run folder of its own; returns what it printed and the kit's log. */
function inKit(t, options, script, { env = {}, file = 'probe.cjs', sub = '', home: homeAt = null } = {}) {
  const dir = temp(t);
  const kit = writeKit(join(dir, 'kit'), options, { pathValue: '' });
  const work = join(dir, 'work');
  const home = homeAt === null ? join(dir, 'home') : join(dir, homeAt);
  mkdirSync(join(work, sub), { recursive: true });
  mkdirSync(home, { recursive: true });
  const entry = join(work, sub, file);
  writeFileSync(entry, script);
  const run = spawnSync(process.execPath, [entry, work], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    env: { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, TMPDIR: work, TMP: work, TEMP: work, NODE_OPTIONS: `--require=${kit.enable}`, ...env },
  });
  assert.equal(run.status, 0, `${run.stderr}${run.stdout}`);
  return { out: run.stdout.trim().length > 0 ? JSON.parse(run.stdout.trim().split('\n').at(-1)) : null, log: readFileSync(kit.log, 'utf8'), kit, work, home };
}

const TIME_WRITE = [
  "const fs = require('node:fs'); const path = require('node:path');",
  "const time = (fn) => { const t0 = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t0) / 1e6; };",
  "const inside = time(() => fs.writeFileSync(path.join(process.argv[2], 'a.txt'), 'x'));",
  "const other = process.env.OUTSIDE ? time(() => fs.writeFileSync(path.join(process.env.OUTSIDE, 'b.txt'), 'x')) : -1;",
  "console.log(JSON.stringify({ inside, other, name: fs.writeFileSync.name }));",
].join('\n');

test('the preload waits on writes under the run\'s temp folder, never outside it, and a root that holds the home is never in scope', { skip: posix }, (t) => {
  const options = quietOptions('--fs-delay', '90');
  const outside = temp(t);
  const { out, log } = inKit(t, options, TIME_WRITE, { env: { OUTSIDE: outside } });
  assert.ok(out.inside >= 80, `a write under the temp folder waited (${out.inside} ms)`);
  assert.ok(faultTotals(log).fsOps >= 1, 'the slowed operation is counted in the kit\'s log');
  // A write outside the folder is not slowed. That is read from the kit's own count of the operations it slowed, not from a stopwatch: a plain write
  // can take any time on a loaded host, and a bound on it would fail this test on the loaded host it exists for.
  const alone = inKit(t, options, TIME_WRITE);
  assert.equal(faultTotals(log).fsOps, faultTotals(alone.log).fsOps, 'the same run with a write outside the folder slowed no more operations than the run without it');
  // A run's HOME is a temporary home INSIDE its temporary folder: that is where the faults belong, so the HOME variable never turns the scope off.
  const inside = inKit(t, options, TIME_WRITE.replace("path.join(process.argv[2], 'a.txt')", "path.join(process.env.HOME, 'a.txt')"), { home: 'work/h' });
  assert.ok(inside.out.inside >= 80, `a write under a temporary home inside the temp folder waited (${inside.out.inside} ms)`);
  // The REAL home (named in the configuration, here a folder of this test) is never in scope, nor a folder that holds it or sits inside it.
  const dir = temp(t);
  const realHome = join(dir, 'real-home');
  mkdirSync(join(realHome, 'tmp'), { recursive: true });
  // Read from the kit's count of the operations it slowed (no stopwatch, which a loaded host would fail), with a control: the same command in a
  // folder that is in scope is slowed and counted, so a count of none means the folder was out of scope and not that the log is silent for `node -e`.
  const slowedBy = (tmpRoot, name) => {
    const kit = writeKit(join(dir, name), options, { pathValue: '', realHome });
    const run = spawnSync(process.execPath, ['-e', TIME_WRITE.replace('process.argv[2]', 'process.env.TMPDIR')], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', TMPDIR: tmpRoot, NODE_OPTIONS: `--require=${kit.enable}` } });
    assert.equal(run.status, 0, run.stderr);
    return faultTotals(existsSync(kit.log) ? readFileSync(kit.log, 'utf8') : '').fsOps;
  };
  const elsewhere = temp(t);
  assert.ok(slowedBy(elsewhere, 'kit-control') >= 1, 'control: a write in a temp folder that is in scope is slowed and counted');
  for (const [tmpRoot, label] of [[dir, 'a temp folder that holds the real home'], [realHome, 'a temp folder that is the real home'], [join(realHome, 'tmp'), 'a temp folder inside the real home']]) {
    assert.equal(slowedBy(tmpRoot, `kit-${label.length}`), 0, `${label}: nothing is slowed`);
  }
});

test('the preload does nothing without a configuration that says so, and nothing to a process that sets no preload of its own', { skip: posix }, () => {
  // The names of the fs calls as a child sees them: under the suite runner its own preload wraps them too, so the baseline is a child with no kit at all.
  const probe = "const fs = require('node:fs'); console.log(fs.writeFileSync.name, fs.appendFileSync.name, fs.renameSync.name)";
  const names = (extra) => spawnSync(process.execPath, ['-e', probe], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...extra } }).stdout.trim();
  const baseline = names({});
  assert.ok(baseline.length > 0);
  assert.equal(names({ NODE_OPTIONS: `--require="${PRELOAD_FILE}"` }), baseline, 'no JEVRIS_SLOW_CONFIG: the preload is inert');
  assert.equal(names({ JEVRIS_SLOW_CONFIG: JSON.stringify({ active: false, fs: { delayMs: 500 } }), NODE_OPTIONS: `--require="${PRELOAD_FILE}"` }), baseline, 'a configuration that is not active');
  const bad = spawnSync(process.execPath, ['-e', "console.log('ok')"], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', JEVRIS_SLOW_CONFIG: '{not json', NODE_OPTIONS: `--require="${PRELOAD_FILE}"` } });
  assert.equal(bad.stdout.trim(), 'ok', 'a broken configuration does not break the process');
});

const APPEND = [
  "const fs = require('node:fs'); const path = require('node:path');",
  "const dir = process.argv[2]; const seen = [];",
  "for (const name of ['sidecar.log', 'b.txt', 'sidecar.log']) { try { fs.appendFileSync(path.join(dir, name), 'x\\n'); seen.push(name + ':ok'); } catch (error) { seen.push(name + ':' + error.code); } }",
  "try { fs.writeFileSync(path.join(dir, 'c.jtmp'), 'x'); fs.renameSync(path.join(dir, 'c.jtmp'), path.join(dir, 'c.json')); seen.push('rename:ok'); } catch (error) { seen.push('rename:' + error.code); }",
  "console.log(JSON.stringify(seen));",
].join('\n');

test('a transient error is injected only on what the product retries, once per path, and only when the product is on the stack', { skip: posix }, (t) => {
  const options = quietOptions('--fs-error-first');
  // From a file under a dist folder (the product's own bundle), the first append to a log fails and the second works.
  const product = inKit(t, options, APPEND, { sub: 'dist', file: 'app.cjs' });
  assert.match(product.out[0], /^sidecar\.log:(EBUSY|EPERM)$/, 'the first append to a log fails with a transient code');
  assert.deepEqual(product.out.slice(1), ['b.txt:ok', 'sidecar.log:ok', product.out[3]], 'a file that is not the sidecar log is never failed, and the retry works');
  // The rename of a .jtmp is one of the retried operations: it fails once too (a plain rename of anything else would not).
  assert.match(product.out[3], /^rename:(EBUSY|EPERM)$/);
  assert.equal(Object.values(faultTotals(product.log).errors).reduce((sum, n) => sum + n, 0), 2, 'both injected errors are counted in the kit\'s log');
  // The same writes from a test's own code (no dist on the stack) are never failed: a fixture write is not retried.
  const fixture = inKit(t, options, APPEND, { sub: 'fixtures', file: 'app.cjs' });
  assert.deepEqual(fixture.out, ['sidecar.log:ok', 'b.txt:ok', 'sidecar.log:ok', 'rename:ok']);
  // With no rate and no first-failure option there is no rule at all.
  const none = inKit(t, quietOptions(), APPEND, { sub: 'dist', file: 'app.cjs' });
  assert.deepEqual(none.out, ['sidecar.log:ok', 'b.txt:ok', 'sidecar.log:ok', 'rename:ok']);
});

test('a COMMIT of better-sqlite3 waits while its transaction holds the lock, and a plain statement does not', { skip: posix }, (t) => {
  const script = [
    `const Database = require(${JSON.stringify(join(root, 'node_modules', 'better-sqlite3'))});`,
    "const db = new Database(':memory:'); db.exec('create table t(a)');",
    "const insert = db.prepare('insert into t values (?)');",
    "const time = (fn) => { const t0 = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t0) / 1e6; };",
    "const commit = time(() => db.transaction(() => insert.run(1))());",
    "const plain = time(() => insert.run(2));",
    "console.log(JSON.stringify({ commit, plain }));",
  ].join('\n');
  const { out, log } = inKit(t, quietOptions('--sqlite-delay', '80'), script);
  assert.ok(out.commit >= 70, `the commit waited (${out.commit} ms)`);
  // The plain insert is not slowed: the kit counted one commit and only that one (read from its count, not a stopwatch on the insert, which a loaded host would fail).
  assert.equal(faultTotals(log).sqliteCommits, 1);
});

test('every node process starts late, and a child a test gives an environment of its own gets the kit too', { skip: posix }, (t) => {
  const options = quietOptions('--start-delay', '250');
  const dir = temp(t);
  const kit = writeKit(join(dir, 'kit'), options, { pathValue: '' });
  writeFileSync(join(dir, 'noop.cjs'), '');
  const env = { PATH: process.env.PATH ?? '', NODE_OPTIONS: `--require=${kit.enable}` };
  const time = (args) => {
    const began = Date.now();
    const run = spawnSync(process.execPath, args, { cwd: root, env });
    assert.equal(run.status, 0, String(run.stderr));
    return Date.now() - began;
  };
  assert.ok(time([join(dir, 'noop.cjs')]) >= 230, 'a script file starts late');
  assert.equal(faultTotals(readFileSync(kit.log, 'utf8')).starts, 1);
  // A helper a test starts with `node -e` is not a product process: it is not slowed (one that exits at once must be gone before the test writes to it).
  const fast = time(['-e', '0']);
  assert.equal(faultTotals(readFileSync(kit.log, 'utf8')).starts, 1, `node -e is not counted (${fast} ms)`);
  // A grandchild started with `{ PATH }` only has no NODE_OPTIONS of its own; the kit puts its preload in.
  const script = [
    "const { spawnSync } = require('node:child_process');",
    "const grand = (env) => spawnSync(process.execPath, ['-e', 'console.log(process.env.NODE_OPTIONS || \"\")'], { env, encoding: 'utf8' }).stdout.trim();",
    "console.log(JSON.stringify({ bare: grand({ PATH: process.env.PATH }), inherited: grand(undefined), own: grand({ PATH: process.env.PATH, NODE_OPTIONS: '--no-warnings' }) }));",
  ].join('\n');
  const injected = inKit(t, quietOptions(), script);
  assert.ok(injected.out.bare.includes(`--require=${injected.kit.enable}`), `a bare environment gets the preload: ${injected.out.bare}`);
  assert.ok(injected.out.inherited.includes(injected.kit.enable), 'an inherited environment already has it');
  assert.ok(injected.out.own.startsWith('--no-warnings ') && injected.out.own.includes(injected.kit.enable), 'a NODE_OPTIONS of the child\'s own is kept and added to');
  const off = inKit(t, quietOptions('--no-env-inject'), script);
  assert.ok(!off.out.bare.includes(off.kit.enable), `--no-env-inject leaves a bare environment without the kit: ${off.out.bare}`);
});


// The suite runner's own preload also wraps spawn in the children and cannot start a permission-model child with a hand-built environment, so this
// runs under `node --test test/slow-host.test.mjs` (and the kit's runs of packs.test.mjs, where PAK-06 starts such a child, hold it in the quick set).
test('a child under Node\'s permission model still runs: the kit is taken out of its NODE_OPTIONS', { skip: posix || (process.env.JEVRIS_TEST === '1' && 'the suite runner\'s preload wraps spawn in the children too') }, (t) => {
  // It cannot read the kit's file, so it runs with the kit taken out of its NODE_OPTIONS (explicit or inherited).
  const flag = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission';
  const guarded = [
    "const { spawnSync } = require('node:child_process');",
    `const run = (env) => spawnSync(process.execPath, [${JSON.stringify(flag)}, '-e', 'console.log(7)'], { env, encoding: 'utf8' });`,
    "const seen = [run(undefined), run({ PATH: process.env.PATH }), run({ ...process.env })].map((r) => r.stdout.trim() + ':' + r.status + String(r.stderr).split('\\n')[0].slice(0, 160));",
    "console.log(JSON.stringify(seen));",
  ].join('\n');
  assert.deepEqual(inKit(t, quietOptions(), guarded).out, ['7:0', '7:0', '7:0'], 'inherited, hand-built and copied environments');
});

test('failed tests, summaries and the faults of a run are read from the files the runner and the preload write', () => {
  const events = [
    JSON.stringify({ file: join(root, 'apps/a/test/a.test.mjs'), name: 'passes', passed: true, skipped: false }),
    JSON.stringify({ file: join(root, 'apps/a/test/a.test.mjs'), name: 'fails', passed: false, skipped: false }),
    JSON.stringify({ file: join(root, 'apps/a/test/b.test.mjs'), name: 'skipped', passed: false, skipped: true }),
    '{"file": "cut off',
    '',
  ].join('\n');
  assert.deepEqual(failedTests(events), [{ file: join(root, 'apps/a/test/a.test.mjs'), name: 'fails' }]);
  const rows = groupFailures([failedTests(events), [], failedTests(events)], root);
  assert.deepEqual(rows, [{ file: 'apps/a/test/a.test.mjs', name: 'fails', runs: 2 }]);
  assert.deepEqual(summaryCounts('ℹ tests 10\nℹ pass 9\nℹ fail 1\nℹ skipped 0\n'), { tests: 10, pass: 9, fail: 1, skipped: 0 });
  assert.equal(summaryCounts('nothing'), null);
  const total = faultTotals([
    JSON.stringify({ fsOps: 4, fsMs: 8, stalls: 1, stallMs: 2000, errors: { EBUSY: 1 }, startMs: 300, startStalls: 0, childEnv: 1, sqliteCommits: 5, sqliteMs: 5, sqliteStalls: 0 }),
    JSON.stringify({ fsOps: 1, fsMs: 2, errors: { EBUSY: 1, EPERM: 2 }, startMs: 2000, startStalls: 1 }),
    'torn',
  ].join('\n'), '...');
  assert.deepEqual([total.processes, total.fsOps, total.stalls, total.errors, total.starts, total.startStalls, total.gitCalls, total.sqliteCommits], [2, 5, 1, { EBUSY: 2, EPERM: 2 }, 2, 1, 3, 5]);
  assert.match(describeFaults(total), /5 slowed file operation.*4 transient write error.*2 slowed process start.*3 delayed git call/);
});

test('a whole run with a stub runner: the kit is made and removed, the burners stop, every failing test is named with its runs, and the exit code says it', async (t) => {
  const dir = temp(t);
  const said = [];
  const stopped = [];
  const envs = [];
  const results = [{ status: 0, events: [{ file: join(root, 'x.test.mjs'), name: 'ok', passed: true }] }, { status: 1, events: [{ file: join(root, 'apps/s/test/slow.test.mjs'), name: 'a bound', passed: false }] }, { status: 1, events: [{ file: join(root, 'apps/s/test/slow.test.mjs'), name: 'a bound', passed: false }, { file: join(root, 'y.test.mjs'), name: 'other', passed: false }] }];
  let index = 0;
  const code = await runSlow(parseSlowArgs(['--runs', '3', '--burners', '2', '--freeze-rate', '0', '--no-build']), {
    say: (line) => said.push(line),
    errorSay: (line) => said.push(line),
    tmp: dir,
    baseEnv: { PATH: '/usr/bin' },
    files: () => [join(root, 'apps/sidecar/test/daemon.test.mjs'), join(root, 'test/slow-host.test.mjs')],
    burn: (count) => ({ pids: [], stop: () => stopped.push(count) }),
    freeze: () => ({ stats: { freezes: 1, frozenMs: 500 }, stop() {} }),
    runner: async ({ files, env, onStart }) => {
      onStart(4242);
      envs.push({ files, env });
      const result = results[index];
      index += 1;
      writeFileSync(env.JEVRIS_TEST_EVENTS, `${result.events.map((e) => JSON.stringify({ ...e, skipped: false })).join('\n')}\n`);
      return result.status;
    },
  });
  assert.equal(code, 1);
  assert.equal(index, 3);
  assert.deepEqual(stopped, [2], 'the burners are stopped once');
  assert.deepEqual(envs[0].files, [], 'the first run of a full selection is the full suite');
  assert.ok(envs[1].files.includes('apps/sidecar/test/daemon.test.mjs'), 'the repeats are the quick set');
  assert.ok(envs.every(({ env }) => env.JEVRIS_TEST_BUDGET_SCALE === '6' && env.NODE_OPTIONS.includes('--require=') && env.PATH.endsWith('/usr/bin')));
  const text = said.join('\n');
  assert.match(text, /3 failing test|2 failing test/);
  assert.match(text, /apps\/s\/test\/slow\.test\.mjs :: a bound {2}\(failed in 2 of 3 run\(s\)\)/);
  assert.match(text, /y\.test\.mjs :: other {2}\(failed in 1 of 3 run\(s\)\)/);
  assert.match(text, /test:slow: FAIL: 1 of 3 run\(s\) passed/);
  assert.match(text, /1 process freeze\(s\)/);
  assert.ok(!existsSync(join(dir, 'jslow-')) && !readdirSyncSafe(dir).some((name) => name.startsWith('jslow-')), 'the kit folder is gone');
  // A clean run passes, and --keep keeps the folder.
  const clean = [];
  const ok = await runSlow(parseSlowArgs(['--quick', '--burners', '0', '--freeze-rate', '0', '--no-build', '--keep']), {
    say: (line) => clean.push(line), errorSay: (line) => clean.push(line), tmp: dir, baseEnv: { PATH: '/usr/bin' }, files: () => [], burn: () => ({ stop() {} }),
    runner: async ({ env }) => {
      writeFileSync(env.JEVRIS_TEST_EVENTS, `${JSON.stringify({ file: null, name: 'fine', passed: true, skipped: false })}\n`);
      return 0;
    },
  });
  assert.equal(ok, 0);
  assert.match(clean.join('\n'), /test:slow: PASS: 1 of 1 run\(s\) passed/);
  assert.ok(readdirSyncSafe(dir).some((name) => name.startsWith('jslow-')), 'kept');
  // A signal during a run stops the rest and returns the signal's code, after the burners were stopped.
  let signalled = 0;
  const burnStops = [];
  const stopCode = await runSlow(parseSlowArgs(['--runs', '2', '--burners', '1', '--freeze-rate', '0', '--no-build', 'x.test.mjs']), {
    say() {}, errorSay() {}, tmp: dir, baseEnv: { PATH: '/usr/bin' }, files: () => [], burn: () => ({ stop: () => burnStops.push(1) }),
    runner: async ({ onSignal }) => {
      signalled += 1;
      onSignal('SIGINT');
      return 130;
    },
  });
  assert.equal(stopCode, 130);
  assert.equal(signalled, 1, 'the second run never started');
  assert.deepEqual(burnStops, [1]);
});

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

test('the kit refuses to run on Windows, where it would make nothing slower than the runner already is', () => {
  assert.match(refuseWindows('win32'), /Windows runner/);
  assert.equal(refuseWindows('darwin'), null);
  assert.equal(refuseWindows('linux'), null);
});
