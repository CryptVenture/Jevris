// git's processes are started off the sidecar's event loop (K3 lifecycle load and W10 handoff, windows-latest, CI run 37329307976).
// Starting a process blocks the thread that starts it; the pool of worker threads in git-work.ts takes the start, answers each caller
// its own result, and gives way to the caller's own inline run whenever it is off, not ready, failed or ended.
//
// Where a process was started is read from the thread-id log of test/git-start-probe.mjs (0 is the main thread), not from a clock, so
// the test holds on a host of any speed and fails when git is started on the main thread.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  GIT_RUNNER_SOURCE,
  GIT_WORKERS,
  enableGitWorkers,
  gitWorkerCount,
  gitWorkerReady,
  nodeGit,
  runGitOffLoop,
  warmGitWorkers,
} from '../dist/index.js';
import { gitStartPreload } from '../../../test/git-start-probe.mjs';
import { tempDir } from './temp-dirs.mjs';

const dir = tempDir('jv-gitwork-');
const log = join(dir, 'starts.log');
const preload = join(dir, 'probe.cjs');
writeFileSync(preload, gitStartPreload(log.replace(/\\/g, '/'), 0, { always: true }));
// The probe in this process too: a start of git on the main thread is logged as 0, and each worker thread gets the probe.
createRequire(import.meta.url)(preload);

/** Thread ids of the git processes started so far, oldest first. */
const starts = () => {
  try {
    return readFileSync(log, 'utf8').split('\n').filter((line) => line !== '');
  } catch {
    return [];
  }
};

/** Waits (state, not a duration guess) until `condition` holds. */
async function until(condition, what, boundMs = 60_000) {
  const giveUpAt = Date.now() + boundMs;
  while (!condition()) {
    assert.ok(Date.now() < giveUpAt, `${what} did not happen within ${String(boundMs)} ms`);
    await sleep(10);
  }
}

// A stand-in for git: node running a script that echoes what it was given, so the request is seen to arrive whole.
const ECHO = join(dir, 'echo.cjs');
writeFileSync(ECHO, "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), marker: process.env.JEVRIS_GITWORK_MARKER ?? null }));\nprocess.stderr.write('note');\nprocess.exitCode = Number(process.env.JEVRIS_GITWORK_EXIT ?? 0);\n");
const SLEEP = join(dir, 'sleep.cjs');
writeFileSync(SLEEP, 'setTimeout(() => {}, 120000);\n');
const standIn = (script, timeoutMs, extraEnv = {}) => nodeGit(timeoutMs, extraEnv, { command: process.execPath, prefixArgs: [script] });

test('the runner the workers run is self-contained: it runs from its own text, with only the spawn it is given', async () => {
  const run = new Function(`return (${GIT_RUNNER_SOURCE});`)();
  const { EventEmitter } = await import('node:events');
  const fake = (code, chunks) => (program, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => undefined;
    setImmediate(() => {
      for (const chunk of chunks) child.stdout.emit('data', new TextEncoder().encode(chunk));
      child.stderr.emit('data', new TextEncoder().encode('warn'));
      child.emit('close', code);
    });
    child.seen = { program, args, options };
    fake.last = child.seen;
    return child;
  };
  const request = { command: null, prefixArgs: ['x'], args: ['status', '--porcelain'], cwd: '/work', env: { A: '1' }, timeoutMs: 5000 };
  assert.deepEqual(await run(fake(0, ['a', 'bc']), request, 'the-git'), { ok: true, stdout: 'abc', stderr: 'warn' });
  assert.deepEqual(fake.last.args, ['x', '-c', 'core.quotepath=off', 'status', '--porcelain']);
  assert.equal(fake.last.program, 'the-git');
  assert.equal(fake.last.options.cwd, '/work');
  assert.deepEqual(fake.last.options.env, { A: '1' });
  assert.equal((await run(fake(1, ['x']), request, 'the-git')).ok, false, 'a non-zero exit is not ok');
  assert.deepEqual(await run(() => { throw new Error('no such program'); }, request, 'the-git'), { ok: false, stdout: '', stderr: '' }, 'a spawn that throws is not ok');
});

test('git is started by a worker thread once the pool is ready, by the calling thread before and without it, and the answers are the same', async (t) => {
  t.after(() => enableGitWorkers(false));
  const git = nodeGit(30_000);
  // Without the pool: the calling thread (0), as before.
  enableGitWorkers(false);
  const inline = await git.run(['--version'], dir);
  assert.equal(inline.ok, true, JSON.stringify(inline));
  assert.match(inline.stdout, /^git version /);
  assert.deepEqual(starts(), ['0'], 'with the pool off git is started by the main thread');
  assert.equal(await runGitOffLoop({ command: null, prefixArgs: [], args: ['--version'], cwd: dir, env: {}, timeoutMs: 1000 }, 'git'), null, 'with the pool off nothing is sent to a worker');
  // The pool is on and started in this call: its workers have not said they are ready, so this call is the caller's own.
  enableGitWorkers(true);
  warmGitWorkers();
  assert.equal(gitWorkerCount(), GIT_WORKERS);
  assert.equal(gitWorkerReady(), false, 'a worker is not ready before it has run');
  assert.deepEqual((await git.run(['--version'], dir)).stdout, inline.stdout);
  assert.deepEqual(starts(), ['0', '0'], 'a call before a worker is ready is run by the calling thread');
  // Ready: every start is a worker's, never the main thread's.
  await until(gitWorkerReady, 'a git worker to be ready');
  const before = starts().length;
  const answers = await Promise.all([git.run(['--version'], dir), git.run(['--version'], dir), git.run(['no-such-subcommand'], dir), git.run(['--version'], dir)]);
  assert.deepEqual(answers.map((a) => a.ok), [true, true, false, true]);
  assert.deepEqual([answers[0].stdout, answers[1].stdout, answers[3].stdout], [inline.stdout, inline.stdout, inline.stdout]);
  assert.match(answers[2].stderr, /no-such-subcommand/, 'git\'s own message is carried back');
  const after = starts().slice(before);
  assert.equal(after.length, 4, 'each call started one git process');
  assert.deepEqual(after.filter((id) => id === '0'), [], 'a git process was started on the main thread while the workers were ready');
});

test('a request reaches the worker whole (program, arguments, directory, environment) and a failure comes back with its output; a missing program and a timeout are not ok', async (t) => {
  t.after(() => enableGitWorkers(false));
  enableGitWorkers(true);
  warmGitWorkers();
  await until(gitWorkerReady, 'a git worker to be ready');
  const before = starts().length;
  const echoed = await standIn(ECHO, 30_000, { JEVRIS_GITWORK_MARKER: 'seen', JEVRIS_GITWORK_EXIT: '3' }).run(['status', '--porcelain=v2'], dir);
  assert.equal(echoed.ok, false, 'exit code 3 is not ok');
  assert.deepEqual(JSON.parse(echoed.stdout), { argv: ['-c', 'core.quotepath=off', 'status', '--porcelain=v2'], cwd: JSON.parse(echoed.stdout).cwd, marker: 'seen' });
  assert.equal(echoed.stderr, 'note');
  assert.equal((await standIn(ECHO, 30_000).run(['x'], dir)).ok, true);
  assert.deepEqual(await nodeGit(30_000, {}, { command: join(dir, 'no-such-program') }).run(['x'], dir), { ok: false, stdout: '', stderr: '' });
  const slow = await standIn(SLEEP, 300).run([], dir);
  assert.equal(slow.ok, false, 'a run past its timeout is killed and not ok');
  assert.equal(starts().length, before, 'none of these was git, so none was probed');
});

test('callers are answered each its own result when many runs are in flight at once', async (t) => {
  t.after(() => enableGitWorkers(false));
  enableGitWorkers(true);
  warmGitWorkers();
  await until(gitWorkerReady, 'a git worker to be ready');
  const answers = await Promise.all(Array.from({ length: 24 }, (_, i) => standIn(ECHO, 30_000).run([`call-${String(i)}`], dir)));
  assert.deepEqual(answers.map((a) => JSON.parse(a.stdout).argv.at(-1)), Array.from({ length: 24 }, (_, i) => `call-${String(i)}`));
});

test('workers that end, or are ended with a call in flight, leave git run by the caller, and the pool comes back', async (t) => {
  t.after(() => enableGitWorkers(false));
  enableGitWorkers(true);
  warmGitWorkers();
  await until(gitWorkerReady, 'a git worker to be ready');
  // A call in flight when its worker is ended (the pool turned off): the caller runs it again itself and gets the answer.
  const running = standIn(ECHO, 30_000).run(['in-flight'], dir);
  enableGitWorkers(false);
  assert.equal(gitWorkerCount(), 0, 'turning the pool off ends its workers');
  const answer = await running;
  assert.equal(JSON.parse(answer.stdout).argv.at(-1), 'in-flight', 'the call was answered');
  // Off: inline, and on again: a pool that starts again.
  assert.equal((await standIn(ECHO, 30_000).run(['off'], dir)).ok, true);
  enableGitWorkers(true);
  assert.equal((await standIn(ECHO, 30_000).run(['first-after-on'], dir)).ok, true, 'the first call after the pool is on is the caller\'s own, and starts the pool');
  assert.equal(gitWorkerCount(), GIT_WORKERS);
  await until(gitWorkerReady, 'the git workers to be ready again');
});
