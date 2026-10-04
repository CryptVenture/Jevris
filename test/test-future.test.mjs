import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFutureArgs } from '../scripts/test-future.mjs';

const preload = new URL('../scripts/test-preload.mjs', import.meta.url).href;
const DAY = 86_400_000;

test('test:future: --days is a whole number of days (default 90); everything else goes to the runner (QA-05)', () => {
  assert.deepEqual(parseFutureArgs([]), { days: 90, rest: [] });
  assert.deepEqual(parseFutureArgs(['--days', '365', '--no-build', 'test/a.test.mjs']), { days: 365, rest: ['--no-build', 'test/a.test.mjs'] });
  for (const bad of [['--days'], ['--days', '0'], ['--days', '-3'], ['--days', '1.5'], ['--days', 'x']]) assert.throws(() => parseFutureArgs(bad), /whole number of days/, bad.join(' '));
});

/**
 * Runs a probe under the test preload with the given shift, the way the runner starts a test
 * process, and returns what it saw: its own clock and file times, and a child's clock.
 */
function probe(t, days) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-future-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = [
    "import { spawnSync } from 'node:child_process';",
    "import { statSync, utimesSync, writeFileSync } from 'node:fs';",
    "import { stat } from 'node:fs/promises';",
    "import { join } from 'node:path';",
    'const dir = process.env.PROBE_DIR;',
    "const file = join(dir, 'f.txt');",
    "writeFileSync(file, 'x');",
    'const fresh = statSync(file).mtimeMs;',
    'const set = new Date(Date.now() - 3_600_000);',
    'utimesSync(file, set, set);',
    'const readBack = (await stat(file)).mtimeMs;',
    // A child with an explicit env and no NODE_OPTIONS: the preload must carry the shift to it.
    "const child = spawnSync(process.execPath, ['-e', 'console.log(Date.now())'], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' });",
    // The real wall clock, which the shift leaves alone (so this test also holds under test:future).
    'const real = performance.timeOrigin + performance.now();',
    // A test may fake a wall-clock jump by assigning Date.now, and put the previous function back.
    'const before = Date.now;',
    'Date.now = () => before() + 60_000;',
    'const jumped = Date.now() - before();',
    'const constructed = new Date().getTime() - before();',
    'Date.now = before;',
    'const restored = Date.now() - before();',
    'console.log(JSON.stringify({ real, now: Date.now(), made: new Date().getTime(), fresh, set: set.getTime(), readBack, child: Number(child.stdout), isDate: new Date() instanceof Date, text: typeof Date(), jumped, constructed, restored }));',
  ].join('\n');
  const env = {
    ...process.env,
    NODE_OPTIONS: `--import=${preload}`,
    JEVRIS_GUARD_REAL_HOME: join(dir, 'real-home'),
    JEVRIS_HOME_WRITE_LEDGER: join(dir, 'ledger.txt'),
    PROBE_DIR: dir,
  };
  // 0, not absent: under test:future the preload would carry this run's own shift into the probe.
  env.JEVRIS_TEST_CLOCK_SHIFT_DAYS = String(days);
  const ran = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(ran.status, 0, ran.stderr);
  return JSON.parse(ran.stdout.trim().split('\n').at(-1));
}

test('test:future: Date, file times and a child with an explicit env all move the same number of days ahead; utimes reads back as written (QA-05)', (t) => {
  const seen = probe(t, 90);
  const ahead = (ms) => ms - seen.real;
  for (const [what, ms] of [['Date.now', seen.now], ['new Date()', seen.made], ['a new file', seen.fresh], ['the child', seen.child]]) {
    assert.ok(Math.abs(ahead(ms) - 90 * DAY) < 60_000, `${what} is 90 days ahead (${ahead(ms)} ms)`);
  }
  assert.equal(Math.round(seen.readBack / 1000), Math.round(seen.set / 1000), 'a time set with utimes reads back as set');
  assert.deepEqual([seen.isDate, seen.text], [true, 'string']);
});

test('test:future: a test that assigns its own Date.now is honoured, and putting the previous one back restores the shifted clock (QA-05)', (t) => {
  for (const days of [90, 0]) {
    const seen = probe(t, days);
    assert.ok(Math.abs(seen.jumped - 60_000) < 5_000, `${days} days: Date.now follows the assignment (${seen.jumped} ms)`);
    assert.ok(Math.abs(seen.constructed) < 5_000, `${days} days: new Date() does not read Date.now, as on a real Date (${seen.constructed} ms)`);
    assert.ok(Math.abs(seen.restored) < 5_000, `${days} days: restored (${seen.restored} ms)`);
  }
});

test('test:future: with a shift of 0 days nothing moves (QA-05)', (t) => {
  const seen = probe(t, 0);
  for (const ms of [seen.now, seen.fresh, seen.child]) assert.ok(Math.abs(ms - seen.real) < 60_000, `${ms - seen.real} ms`);
});
