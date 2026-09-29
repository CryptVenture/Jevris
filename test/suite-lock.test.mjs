import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireHostSuiteLock, acquireSuiteLock, HELD_ENV, HOST_DIR_ENV, HOST_HELD_ENV, hostLockPath, liveTickets, LOCK_DIR, queuePath, readOwner, TICKET_STALE_MS, WAIT_ENV, writeTicket } from '../scripts/suite-lock.mjs';
import { needsHostLock, parseArgs as parseCellArgs } from '../scripts/ci-cell.mjs';
import { isFullSuite } from '../scripts/test-future.mjs';
import { isFullSuite as isFullRun, testEnvironment } from '../scripts/test.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

function tempRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'suite-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const quiet = { say: () => {} };

/** A pid that existed and has exited. */
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(child.stdout);
}

test('the suite lock is taken with its owner recorded and released by its holder (BLD-10)', (t) => {
  const dir = tempRoot(t);
  const env = {};
  const lock = acquireSuiteLock(dir, { env, waitMs: 0, command: 'npm test', ...quiet });
  const owner = readOwner(join(dir, LOCK_DIR));
  assert.equal(owner.token, lock.token);
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.host, hostname());
  assert.equal(owner.command, 'npm test');
  assert.equal(env[HELD_ENV], lock.token, 'children inherit the held token');
  assert.equal(lock.release(), true);
  assert.equal(existsSync(join(dir, LOCK_DIR)), false);
  assert.equal(env[HELD_ENV], undefined);
  assert.equal(lock.release(), false, 'a second release does nothing');
});

test('a held lock is not taken by another caller, which names the holder (BLD-10)', (t) => {
  const dir = tempRoot(t);
  const first = acquireSuiteLock(dir, { env: {}, waitMs: 0, command: 'npm run build', ...quiet });
  t.after(() => first.release());
  assert.throws(() => acquireSuiteLock(dir, { env: {}, waitMs: 0, ...quiet }), (error) => error.code === 'SUITE_LOCK_TIMEOUT' && /npm run build \(pid \d+ on /.test(error.message));
  assert.equal(readOwner(join(dir, LOCK_DIR)).token, first.token, 'the holder keeps its lock');
});

test('a caller that holds the lock re-enters it, and its nested release leaves the lock in place (BLD-10)', (t) => {
  const dir = tempRoot(t);
  const env = {};
  const outer = acquireSuiteLock(dir, { env, waitMs: 0, ...quiet });
  t.after(() => outer.release());
  const inner = acquireSuiteLock(dir, { env: { ...env }, waitMs: 0, ...quiet });
  assert.equal(inner.reentrant, true);
  assert.equal(inner.release(), false);
  assert.equal(readOwner(join(dir, LOCK_DIR)).token, outer.token);
  // A token for some other lock is not a pass.
  assert.throws(() => acquireSuiteLock(dir, { env: { [HELD_ENV]: 'not-the-holder' }, waitMs: 0, ...quiet }), { code: 'SUITE_LOCK_TIMEOUT' });
});

test('release never removes a lock someone else now holds (BLD-10)', (t) => {
  const dir = tempRoot(t);
  const lock = acquireSuiteLock(dir, { env: {}, waitMs: 0, ...quiet });
  const other = { token: 'someone-else', pid: process.pid, host: hostname(), command: 'another agent', startedAt: new Date().toISOString() };
  writeFileSync(join(dir, LOCK_DIR, 'owner.json'), JSON.stringify(other));
  assert.equal(lock.release(), false);
  assert.equal(readOwner(join(dir, LOCK_DIR)).token, 'someone-else');
});

test('a lock whose holder process is gone is taken over; an unknown holder is never removed (BLD-10)', (t) => {
  const dir = tempRoot(t);
  const lockPath = join(dir, LOCK_DIR);
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ token: 'dead', pid: deadPid(), host: hostname(), command: 'crashed build', startedAt: '2026-09-26T00:00:00.000Z' }));
  const said = [];
  const lock = acquireSuiteLock(dir, { env: {}, waitMs: 0, say: (line) => said.push(line) });
  assert.equal(readOwner(lockPath).token, lock.token);
  assert.match(said.join('\n'), /took over from crashed build/);
  lock.release();

  // Another host's holder, or a lock without owner.json, cannot be proven gone.
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ token: 'remote', pid: deadPid(), host: `not-${hostname()}`, command: 'x', startedAt: 'y' }));
  assert.throws(() => acquireSuiteLock(dir, { env: {}, waitMs: 0, ...quiet }), { code: 'SUITE_LOCK_TIMEOUT' });
  assert.equal(readOwner(lockPath).token, 'remote');
  rmSync(join(lockPath, 'owner.json'));
  assert.throws(() => acquireSuiteLock(dir, { env: {}, waitMs: 0, ...quiet }), /unknown holder/);
  assert.equal(existsSync(lockPath), true);
});

test('the CLI runs one command under the lock of its checkout, passes its exit code on and releases (BLD-10)', (t) => {
  // A copy of the script in a temp checkout, so the test never touches this checkout's lock.
  const dir = tempRoot(t);
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(join(root, 'scripts', 'suite-lock.mjs'), join(dir, 'scripts', 'suite-lock.mjs'));
  const cli = join(dir, 'scripts', 'suite-lock.mjs');
  const env = { ...process.env, [WAIT_ENV]: '0' };
  delete env[HELD_ENV];
  const marker = join(dir, 'seen.txt');
  const script = `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(marker)}, String(fs.existsSync(${JSON.stringify(join(dir, LOCK_DIR))}) && process.env.${HELD_ENV}.length > 0)); process.exit(7)`;
  const run = spawnSync(process.execPath, [cli, '--', process.execPath, '-e', script], { encoding: 'utf8', env });
  assert.equal(run.status, 7, run.stderr);
  assert.equal(readFileSync(marker, 'utf8'), 'true', 'the command ran holding the lock');
  assert.equal(existsSync(join(dir, LOCK_DIR)), false, 'the lock was released');

  // Held by someone else: exit 75 naming the holder, and their lock stays.
  const held = acquireSuiteLock(dir, { env: {}, waitMs: 0, command: 'another agent suite', ...quiet });
  t.after(() => held.release());
  const refused = spawnSync(process.execPath, [cli, '--', process.execPath, '-e', 'process.exit(0)'], { encoding: 'utf8', env });
  assert.equal(refused.status, 75);
  assert.match(refused.stderr, /held by another agent suite/);
  assert.equal(readOwner(join(dir, LOCK_DIR)).token, held.token);
  const status = spawnSync(process.execPath, [cli, '--status'], { encoding: 'utf8', env });
  assert.match(status.stdout, /suite lock: held by another agent suite/);
  assert.equal(spawnSync(process.execPath, [cli], { encoding: 'utf8', env }).status, 2);
});

test('build, bundle and test take the suite lock at their entry point; safe-commit --check builds in a private copy (BLD-10)', () => {
  for (const name of ['build', 'bundle', 'test'].map((stem) => `${stem}.mjs`)) {
    const text = readFileSync(join(root, 'scripts', name), 'utf8');
    assert.match(text, /if \(isMain\(import\.meta\.url\)\) \{\n[\s\S]{0,300}runLocked\(repoRoot, /, name);
  }
  assert.match(readFileSync(join(root, 'scripts', 'safe-commit.mjs'), 'utf8'), /mkdtempSync\(join\(tmpdir\(\), 'safe-commit-'\)\)/);
});

test('the host suite lock lives in a per-user folder of the real temp directory, never a home, and holds only a token, the pid and the start time', (t) => {
  const dir = tempRoot(t);
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : null;
  const path = hostLockPath({ JEVRIS_REAL_TMPDIR: dir });
  assert.equal(path.startsWith(join(dir, 'jevris-host-suite-')), true, path);
  if (uid !== null) assert.equal(path, join(dir, `jevris-host-suite-${uid}.lock`));
  // A run's own TMPDIR does not move it: every clone on the machine meets at one lock.
  assert.equal(hostLockPath({ JEVRIS_REAL_TMPDIR: dir, TMPDIR: join(dir, 'run') }), path);
  assert.equal(hostLockPath({ [HOST_DIR_ENV]: join(dir, 'x') }), join(dir, 'x', 'jevris-host-suite.lock'));
  const env = { [HOST_DIR_ENV]: dir };
  const lock = acquireHostSuiteLock({ env, waitMs: 0, ...quiet });
  const owner = readOwner(join(dir, 'jevris-host-suite.lock'));
  assert.deepEqual(Object.keys(owner).sort(), ['pid', 'startedAt', 'token']);
  assert.equal(owner.pid, process.pid);
  assert.equal(env[HOST_HELD_ENV], owner.token, 'children inherit the hold');
  assert.equal(lock.release(), true);
  assert.equal(existsSync(join(dir, 'jevris-host-suite.lock')), false);
});

test('a second full suite waits for the host suite lock with one visible line naming the pid and start time; a nested run re-enters it', (t) => {
  const dir = tempRoot(t);
  const first = { [HOST_DIR_ENV]: dir };
  const lock = acquireHostSuiteLock({ env: first, waitMs: 0, ...quiet });
  const lines = [];
  assert.throws(() => acquireHostSuiteLock({ env: { [HOST_DIR_ENV]: dir }, waitMs: 60, pollMs: 20, say: (line) => lines.push(line) }), (error) => error.code === 'SUITE_LOCK_TIMEOUT' && /host suite lock .* is held by pid \d+ since /.test(error.message));
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`^waiting for suite lock held by pid ${process.pid} since \\d{4}-\\d{2}-\\d{2}T`));
  // verify:fresh or test:future holds it; the npm test it starts inherits the hold.
  const nested = acquireHostSuiteLock({ env: { ...first }, waitMs: 0, ...quiet });
  assert.equal(nested.reentrant, true);
  assert.equal(nested.release(), false, 'a nested release leaves the lock in place');
  assert.equal(existsSync(join(dir, 'jevris-host-suite.lock')), true);
  lock.release();
});

test('a host suite lock whose pid is dead is stale and taken over; a lock with no readable owner is never removed', (t) => {
  const dir = tempRoot(t);
  const lockPath = join(dir, 'jevris-host-suite.lock');
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, 'owner.json'), `${JSON.stringify({ token: 'dead', pid: deadPid(), startedAt: '2026-09-27T10:00:00.000Z' })}\n`);
  const lines = [];
  const lock = acquireHostSuiteLock({ env: { [HOST_DIR_ENV]: dir }, waitMs: 0, say: (line) => lines.push(line) });
  assert.match(lines[0], /^host suite lock: took over from pid \d+ since 2026-09-27T10:00:00.000Z, which is no longer running$/);
  assert.equal(readOwner(lockPath).pid, process.pid);
  lock.release();
  mkdirSync(lockPath);
  assert.throws(() => acquireHostSuiteLock({ env: { [HOST_DIR_ENV]: dir }, waitMs: 0, ...quiet }), /unknown holder/);
  assert.equal(existsSync(lockPath), true);
});

test('the host suite lock is first come, first served: waiters take it in the order they arrived', async (t) => {
  const dir = tempRoot(t);
  const log = join(dir, 'order.log');
  const lockUrl = new URL('../scripts/suite-lock.mjs', import.meta.url).href;
  // Each waiter takes the lock, notes its name, holds it briefly and releases it.
  const script = `
    import { appendFileSync } from 'node:fs';
    const { acquireHostSuiteLock } = await import(${JSON.stringify(lockUrl)});
    const lock = acquireHostSuiteLock({ env: { ${HOST_DIR_ENV}: ${JSON.stringify(dir)} }, waitMs: 60000, pollMs: 25, say: () => {} });
    appendFileSync(${JSON.stringify(log)}, process.argv[1] + '\\n');
    await new Promise((done) => setTimeout(done, 60));
    lock.release();
  `;
  const holder = acquireHostSuiteLock({ env: { [HOST_DIR_ENV]: dir }, waitMs: 0, ...quiet });
  const names = ['w1', 'w2', 'w3', 'w4', 'w5'];
  const children = [];
  for (const name of names) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, name], { stdio: 'ignore' });
    children.push(new Promise((done) => child.on('close', done)));
    // The next waiter arrives only once this one's ticket is in the queue.
    const want = children.length;
    for (let i = 0; i < 400 && liveTickets(join(dir, 'jevris-host-suite.lock'), { sweep: false }).length < want; i += 1) await new Promise((done) => setTimeout(done, 10));
  }
  assert.equal(liveTickets(join(dir, 'jevris-host-suite.lock'), { sweep: false }).length, names.length, 'every waiter queued');
  holder.release();
  assert.deepEqual(await Promise.all(children), names.map(() => 0));
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), names, 'taken in arrival order');
  assert.deepEqual(readdirSync(queuePath(join(dir, 'jevris-host-suite.lock'))), [], 'every waiter removed its own ticket');
});

test('a waiter says how many are ahead; tickets of dead or silent waiters are swept, a live one never, and a timeout still exits 75 with its own ticket gone', (t) => {
  const dir = tempRoot(t);
  const lockPath = join(dir, 'jevris-host-suite.lock');
  const env = () => ({ [HOST_DIR_ENV]: dir });
  // A live waiter (this process) ahead in the queue: the next one waits behind it and says so.
  const live = writeTicket(lockPath, { arrivedMs: 1, pid: process.pid, startedAt: '2026-09-28T01:00:00.000Z', token: 'live' });
  const lines = [];
  assert.throws(() => acquireHostSuiteLock({ env: env(), waitMs: 80, pollMs: 20, say: (line) => lines.push(line) }), (error) => error.code === 'SUITE_LOCK_TIMEOUT' && /1 waiter\(s\) ahead/.test(error.message));
  assert.deepEqual(lines, ['host suite lock: waiting: 1 ahead']);
  assert.equal(existsSync(live), true, "another waiter's live ticket is never removed");
  assert.deepEqual(readdirSync(queuePath(lockPath)).sort(), [basename(live)].sort(), 'the timed-out waiter removed its own ticket');
  rmSync(live);
  // A dead waiter's ticket, and one not refreshed for TICKET_STALE_MS, are swept; then the lock is taken.
  const dead = writeTicket(lockPath, { arrivedMs: 2, pid: deadPid(), startedAt: '2026-09-28T01:00:00.000Z', token: 'dead' });
  const silent = writeTicket(lockPath, { arrivedMs: 3, pid: process.pid, startedAt: '2026-09-28T01:00:00.000Z', token: 'silent' });
  const old = new Date(Date.now() - TICKET_STALE_MS - 5_000);
  utimesSync(silent, old, old);
  const swept = [];
  const lock = acquireHostSuiteLock({ env: env(), waitMs: 0, say: (line) => swept.push(line) });
  assert.equal(existsSync(dead), false);
  assert.equal(existsSync(silent), false);
  assert.equal(swept.filter((line) => /removed the queue ticket of pid \d+/.test(line)).length, 2);
  assert.equal(readOwner(lockPath).pid, process.pid);
  lock.release();
  // The status line reads the queue without removing anything.
  const stale = writeTicket(lockPath, { arrivedMs: 4, pid: deadPid(), startedAt: '2026-09-28T01:00:00.000Z', token: 'status' });
  assert.deepEqual(liveTickets(lockPath, { sweep: false }), []);
  assert.equal(existsSync(stale), true);
});

test('the runner gives every test process a 60 s sidecar autostart wait (B 6d26fae)', () => {
  assert.equal(testEnvironment('/h', '/real').JEVRIS_SIDECAR_WAIT_MS, '60000');
});

test('full suites and Docker cells take the host suite lock; single test files, lint and a build-only cell do not', () => {
  assert.equal(isFullSuite([]), true);
  assert.equal(isFullSuite(['--no-build']), true);
  assert.equal(isFullSuite(['--no-build', 'test/a.test.mjs']), false);
  for (const argv of [[], ['--no-build']]) assert.equal(isFullRun(argv), true, argv.join(' '));
  assert.equal(isFullRun(['--no-build', 'test/a.test.mjs']), false);
  assert.equal(needsHostLock(parseCellArgs(['--docker', '--node', '24', '--steps', 'ci,build'])), true);
  assert.equal(needsHostLock(parseCellArgs([])), true);
  assert.equal(needsHostLock(parseCellArgs(['--steps', 'ci,build,lint'])), false);
  for (const [name, pattern] of [
    ['ci-cell.mjs', /runHostLocked\(\(\) => main\(argv\)\)/],
    ['test-future.mjs', /if \(full\) \{[\s\S]{0,300}runHostLocked\(\(\) => main\(argv\)\)/],
    ['verify-fresh.mjs', /runHostLocked\(async \(\) => /],
    // npm test: the full suite takes the host lock around the per-checkout one; named files do not.
    ['test.mjs', /isFullSuite\(argv\) \? runHostLocked\(run\) : run\(\)/],
  ]) assert.match(readFileSync(join(root, 'scripts', name), 'utf8'), pattern, name);
  // Lint never waits for a suite.
  assert.doesNotMatch(readFileSync(join(root, 'scripts', 'lint.mjs'), 'utf8'), /runHostLocked|acquireHostSuiteLock/);
});
