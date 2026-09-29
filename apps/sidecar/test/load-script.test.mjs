import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The sidecar load run (owner decision DOMAINS ededdba): only its pure parts run here. The run
 * itself takes minutes, holds the host suite lock and is never part of npm test.
 */
const root = fileURLToPath(new URL('../../..', import.meta.url));
const load = await import('../scripts/load.mjs');
const gates = await import('../../cli/dist/release-gates.js');

const sample = (code, ms = 10) => ({ code, ms });

test('bench:load runs apps/sidecar/scripts/load.mjs, and npm test never collects it', async () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['bench:load'], 'node apps/sidecar/scripts/load.mjs');
  const { collectTestFiles } = await import('../../../scripts/test.mjs');
  assert.equal(collectTestFiles().some((file) => file.endsWith(join('scripts', 'load.mjs'))), false);
  // The whole run holds the host suite lock.
  assert.match(readFileSync(join(root, 'apps', 'sidecar', 'scripts', 'load.mjs'), 'utf8'), /runHostLocked\(\(\) => main\(argv\)\)/);
});

test('arguments: scenarios, duration, files and commit are checked; anything else is a usage error', () => {
  assert.deepEqual(load.parseLoadArgs([]).only, load.SCENARIOS);
  const parsed = load.parseLoadArgs(['--quick', '--only', 'history,subagents20', '--duration-s', '30', '--commit', 'abcdef1']);
  assert.deepEqual([parsed.quick, parsed.only, parsed.durationS, parsed.commit], [true, ['subagents20', 'history'], 30, 'abcdef1']);
  for (const bad of [['--only', 'nope'], ['--only'], ['--duration-s', '0'], ['--duration-s', 'x'], ['--commit', 'HEAD'], ['--out'], ['--what']]) {
    assert.throws(() => load.parseLoadArgs(bad), Error, bad.join(' '));
  }
});

test('the measures match the gate targets one to one, and every measure comes from its scenario', () => {
  const results = {
    subagents20: { hooks: load.summarize([sample('OK', 100), sample('OK_QUEUED', 200), sample('DEADLINE', 1500), sample('BUSY', 3)]), loop: { worstWindowP99Ms: 40, worstStallMs: 150 } },
    verify8: { hooks: load.summarize([sample('OK', 300)]), cliStatus: load.summarize([sample('OK', 900)]), pings: load.summarize([sample('OK', 20)]), loop: { worstWindowP99Ms: 60, worstStallMs: 90 } },
    subagents50: { hooks: load.summarize([...Array(98).fill(sample('OK')), sample('DEADLINE', 1500), sample('ECONNREFUSED', 1)]), busyMaxMs: 0 },
    history: { first: load.summarize([sample('OK', 20)]), last: load.summarize([sample('OK', 30)]) },
    lifecycle: { lifecycle: load.summarize([sample('OK')]), restoresAndStops: load.summarize([sample('OK'), sample('OK_QUEUED'), sample('DEADLINE')]) },
    lifecycle50: { lifecycle: load.summarize([sample('OK'), sample('BUSY', 2), sample('BUSY', 3), sample('OK_DUP'), sample('DEADLINE', 1500)]) },
  };
  const measures = load.measuresFrom(results);
  assert.deepEqual(measures.map((m) => m.id), gates.SIDECAR_LOAD_TARGETS.map((t) => t.id));
  const value = (id) => measures.find((m) => m.id === id).value;
  assert.equal(value('load.subagents20.unanswered'), 2, 'DEADLINE and BUSY are not answers; OK_QUEUED is');
  assert.equal(value('load.loop.window-p99-ms'), 60, 'the worse window of both runs');
  assert.equal(value('load.loop.worst-stall-ms'), 150);
  assert.equal(value('load.subagents50.deadline-rate'), 0.01);
  assert.equal(value('load.subagents50.unanswered'), 1, 'a refused connection is neither answered, BUSY nor DEADLINE');
  assert.equal(value('load.history.p50-ratio'), 1.5);
  assert.equal(value('load.lifecycle.queued'), 2);
  assert.equal(value('load.lifecycle50.busy'), 2, 'only BUSY counts; a DEADLINE is not a BUSY answer');
  // A scenario that did not run leaves its measures null, and the gate calls them not measured.
  const partial = load.measuresFrom({ history: results.history });
  assert.equal(partial.filter((m) => m.value !== null).length, 1);
  assert.equal(gates.judgeSidecarLoad(partial).filter((v) => v.ok).length, 1);
});

test('lifecycle50 is a locked target: no lifecycle hook answered BUSY during 50 subagents (owner decision DOMAINS 684ff82; D\'s K3)', () => {
  assert.equal(load.SCENARIOS.includes('lifecycle50'), true);
  assert.deepEqual(load.REPORT_ONLY_SCENARIOS, []);
  assert.deepEqual(load.PROPOSED_LOAD_TARGETS, []);
  const target = gates.SIDECAR_LOAD_TARGETS.find((t) => t.id === 'load.lifecycle50.busy');
  assert.deepEqual([target.limit, target.unit], [0, 'count']);
  assert.equal(gates.SIDECAR_LOAD_TARGETS.length, 13);
  const busy = load.measuresFrom({ lifecycle50: { lifecycle: load.summarize([sample('OK'), sample('BUSY', 2)]) } });
  assert.equal(busy.find((m) => m.id === 'load.lifecycle50.busy').value, 1);
  assert.equal(gates.judgeSidecarLoad(busy).find((v) => v.target.id === 'load.lifecycle50.busy').ok, false);
  const clean = load.measuresFrom({ lifecycle50: { lifecycle: load.summarize([sample('OK'), sample('OK_DUP')]) } });
  assert.equal(gates.judgeSidecarLoad(clean).find((v) => v.target.id === 'load.lifecycle50.busy').ok, true);
  assert.equal(load.measuresFrom({}).find((m) => m.id === 'load.lifecycle50.busy').value, null, 'not run: not measured');
});

test('verify8 counts the verify as running only when the sidecar says so, never from the CLI answer', () => {
  const notRun = { outcome: 'not-run', reasonCode: 'NO_RECEIPT' };
  assert.deepEqual(load.verifyStates([notRun, notRun]), ['not-run/NO_RECEIPT']);
  assert.equal(load.verifyUnderway(load.verifyStates([notRun, notRun])), false, 'a CLI that timed out into reduced mode ran nothing');
  assert.equal(load.verifyUnderway(load.verifyStates([notRun, { outcome: 'not-run', reasonCode: 'RUNNING' }])), true);
  assert.equal(load.verifyUnderway(load.verifyStates([{ outcome: 'not-run', reasonCode: 'QUEUED' }])), true);
  assert.equal(load.verifyUnderway(load.verifyStates([{ outcome: 'passed', reasonCode: null }])), true);
  assert.equal(load.verifyUnderway([]), false);
});

test('the event-loop summary takes the worst window and the longest stall', () => {
  const rows = [
    { t: 1, p99: 12, stalls: [], rss: 50 * 1048576 },
    { t: 2, p99: 80, stalls: [[2, 45], [2, 250]], rss: 60 * 1048576 },
    { t: 3, p99: 20, stalls: [[3, 60]], rss: 55 * 1048576 },
  ];
  assert.deepEqual(load.loopSummary(rows), { seconds: 3, worstWindowP99Ms: 80, medianWindowP99Ms: 20, worstStallMs: 250, stallsOver40Ms: 3, stallsOver200Ms: 1, rssMaxMb: 60 });
  assert.equal(load.loopSummary([]), null);
});

test('the machine record names no host, and this run knows whether it is on the reference machine', () => {
  const machine = load.machineOf();
  assert.deepEqual(Object.keys(machine).sort(), ['arch', 'cores', 'cpuModel', 'memoryGb', 'os']);
  assert.equal(Number.isInteger(machine.cores) && machine.cores >= 1, true);
  assert.match(gates.describeLoadMachine(gates.SIDECAR_LOAD_REFERENCE), /^darwin arm64, Apple M4 Max, 16 cores, 64 GB$/);
});

test('the instrumented entry writes its lag rows without synchronous file I/O on the loop it measures (D\'s profile: a 4.0 s appendFileSync gap)', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-load-wrap-')));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const lag = join(dir, 'lag.jsonl');
  writeFileSync(lag, '');
  // A preload counts every synchronous fs call; the stand-in entry idles for 2.3 s (two lag rows)
  // and prints the calls made meanwhile.
  const preload = join(dir, 'count-sync.mjs');
  writeFileSync(
    preload,
    [
      "import fs from 'node:fs';",
      "import { syncBuiltinESMExports } from 'node:module';",
      'globalThis.__syncCalls = [];',
      "for (const name of Object.keys(fs).filter((key) => key.endsWith('Sync') && typeof fs[key] === 'function')) {",
      '  const real = fs[name];',
      '  fs[name] = function (...args) { globalThis.__syncCalls.push(name); return real.apply(this, args); };',
      '}',
      'syncBuiltinESMExports();',
      '',
    ].join('\n'),
  );
  const entry = join(dir, 'entry.mjs');
  // Loading modules reads files synchronously; counting starts once the entry is loaded, which is
  // when the wrapper's timers are running and the sidecar would be serving.
  writeFileSync(entry, "globalThis.__syncCalls.length = 0;\nsetTimeout(() => { process.stdout.write(JSON.stringify(globalThis.__syncCalls)); process.exit(0); }, 2300);\n");
  const wrapper = join(dir, 'main.js');
  writeFileSync(wrapper, load.WRAPPER);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  const run = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, wrapper], {
    env: { ...process.env, JEVRIS_LOAD_LAG_FILE: lag, JEVRIS_LOAD_REAL_ENTRY: pathToFileURL(entry).href },
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), [], 'the wrapper made a synchronous fs call while running');
  const rows = readFileSync(lag, 'utf8').split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
  assert.ok(rows.length >= 1, 'the wrapper wrote no lag row');
  for (const row of rows) for (const key of ['t', 'p50', 'p99', 'max', 'stalls', 'rss']) assert.ok(key in row, key);
});
