import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Concurrency audit P4, K1, K2 (owner ededdba: no shedding): hot and background admission, and
// the bounded background executor, FIFO per key, that spills to a spool and never drops work.

const { createAdmission, createBackgroundExecutor } = await import('../dist/admission.js');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'b-sched-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('hot and background have separate pools; a full pool refuses at once; overrun work frees its slot but stays bounded (P4, K1)', async () => {
  const admission = createAdmission({ hot: 2, background: 2 });
  const h1 = admission.admit('hot');
  const h2 = admission.admit('hot');
  assert.equal(admission.admit('hot'), undefined, 'the hot pool is full');
  const b1 = admission.admit('background');
  assert.ok(b1, 'a background op never needs a hot slot');
  assert.deepEqual(admission.counts(), { hot: 2, background: 1, overrun: 0, answer: 0 });
  // A hot request past its deadline gives back its hot slot and holds an overrun slot.
  const late = deferred();
  h1.overrun(late.promise);
  assert.deepEqual(admission.counts(), { hot: 1, background: 1, overrun: 1, answer: 0 });
  assert.equal(admission.admit('background'), undefined, 'overrun work counts against the background pool');
  h1.release();
  assert.equal(admission.counts().hot, 1, 'release after overrun is a no-op');
  const h3 = admission.admit('hot');
  assert.ok(h3, 'the freed hot slot is taken');
  // Overrun reaching the hot pool's size refuses new hot work: a prompt BUSY, not a late DEADLINE.
  const late2 = deferred();
  h2.overrun(late2.promise);
  h3.release();
  assert.equal(admission.admit('hot'), undefined, 'two overrun jobs saturate a two-slot hot pool');
  late.resolve();
  late2.resolve();
  await tick();
  await tick();
  assert.deepEqual(admission.counts(), { hot: 0, background: 1, overrun: 0, answer: 0 });
  b1.release();
  assert.deepEqual(admission.counts(), { hot: 0, background: 0, overrun: 0, answer: 0 });
});

test('the answer lane: a full or saturated hot pool still admits an answer request from its kept slots, and only those (ededdba, K3)', async () => {
  const admission = createAdmission({ hot: 1, background: 1, answer: 2 });
  const plain = admission.admit('hot');
  assert.ok(plain);
  assert.equal(admission.admit('hot'), undefined, 'an ordinary hot request is BUSY on a full pool');
  const a1 = admission.admit('hot', { answer: true });
  const a2 = admission.admit('hot', { answer: true });
  assert.ok(a1 && a2, 'answers take the kept slots');
  assert.equal(admission.admit('hot', { answer: true }), undefined, 'the kept slots are bounded');
  assert.equal(admission.admit('background', { answer: true }) !== undefined, true, 'the flag never changes the background pool');
  assert.deepEqual(admission.counts(), { hot: 1, background: 1, overrun: 0, answer: 2 });
  a1.release();
  a1.release();
  assert.equal(admission.counts().answer, 1, 'a release frees its own pool once');
  // Overrun work saturating the loop refuses ordinary hot work, but not an answer.
  const late = deferred();
  plain.overrun(late.promise);
  assert.equal(admission.admit('hot'), undefined);
  const a3 = admission.admit('hot', { answer: true });
  assert.ok(a3, 'an answer is admitted while overrun work saturates the hot pool');
  late.resolve();
  await tick();
  await tick();
  // With room in the hot pool an answer takes an ordinary slot and leaves the kept ones free.
  const a4 = admission.admit('hot', { answer: true });
  assert.deepEqual(admission.counts(), { hot: 1, background: 1, overrun: 0, answer: 2 });
  for (const slot of [a2, a3, a4]) slot.release();
  assert.deepEqual(admission.counts(), { hot: 0, background: 1, overrun: 0, answer: 0 });
});

test('jobs of one key run in order, one at a time; keys interleave within the concurrency bound; nothing is dropped (K2)', async () => {
  let hot = false;
  const executor = createBackgroundExecutor({ concurrency: 2, hotBusy: () => hot });
  const log = [];
  let running = 0;
  let peak = 0;
  const job = (key, n) => ({
    key,
    label: key,
    bytes: 10,
    run: async () => {
      running += 1;
      peak = Math.max(peak, running);
      log.push(`${key}${n}`);
      await sleep(1);
      running -= 1;
    },
  });
  for (let n = 0; n < 50; n += 1) for (const key of ['a', 'b', 'c']) executor.enqueue(job(key, n));
  await executor.drain(5_000);
  assert.equal(log.length, 150, 'every job ran');
  for (const key of ['a', 'b', 'c']) assert.deepEqual(log.filter((x) => x.startsWith(key)), Array.from({ length: 50 }, (_, n) => `${key}${n}`));
  assert.ok(peak <= 2, `at most 2 at once, saw ${peak}`);
  assert.deepEqual(executor.depth(), { running: 0, held: 0, queued: 0, spooled: 0 });
  void hot;
});

test('background work waits while a hot request is in flight, unless nothing background runs, so it always progresses (P4)', async () => {
  let hot = true;
  const executor = createBackgroundExecutor({ concurrency: 4, hotBusy: () => hot });
  const started = [];
  const gates = [deferred(), deferred(), deferred()];
  for (const [n, gate] of gates.entries()) executor.enqueue({ key: `k${n}`, label: 'x', bytes: 1, run: () => (started.push(n), gate.promise) });
  await tick();
  await tick();
  assert.deepEqual(started, [0], 'with a hot request in flight, only one background job runs');
  hot = false;
  executor.kick();
  await tick();
  await tick();
  assert.deepEqual(started, [0, 1, 2], 'once hot work is gone, the rest start');
  for (const gate of gates) gate.resolve();
  await executor.drain(1_000);
});

test('held work blocks its key: a later job of that key starts only after it, and settled() waits for it within a signal (K1, K2)', async () => {
  const executor = createBackgroundExecutor({ concurrency: 4, hotBusy: () => false });
  const held = deferred();
  const order = [];
  executor.hold('s1', 'orc', held.promise.then(() => order.push('held')));
  assert.equal(executor.pending('s1'), true);
  executor.enqueue({ key: 's1', label: 'orc', bytes: 1, run: async () => order.push('next') });
  executor.enqueue({ key: 's2', label: 'orc', bytes: 1, run: async () => order.push('other') });
  await tick();
  await tick();
  assert.deepEqual(order, ['other'], 'another key is not held up');
  const expired = new AbortController();
  const waiting = executor.settled('s1', expired.signal);
  expired.abort();
  assert.equal(await waiting, false, 'settled gives up with its signal');
  const settled = executor.settled('s1');
  held.resolve();
  assert.equal(await settled, true);
  assert.deepEqual(order, ['other', 'held', 'next']);
  assert.equal(executor.pending('s1'), false);
  assert.deepEqual(executor.depth().held, 0);
});

test('past its memory bound the queue spills to a private spool, in order, and a spool left at close runs at the next start (no shedding)', async (t) => {
  const dir = tempDir(t);
  const spoolDir = join(dir, 'spool');
  const ran = [];
  const gate = deferred();
  const make = (n) => ({ key: 'k', label: 'sub', bytes: 100, run: async () => ran.push(n), spool: () => JSON.stringify({ n }) });
  const revive = (text) => {
    const { n } = JSON.parse(text);
    return make(n);
  };
  const executor = createBackgroundExecutor({ concurrency: 1, memoryBytes: 250, hotBusy: () => false, spoolDir, revive });
  executor.enqueue({ key: 'k', label: 'sub', bytes: 0, run: () => gate.promise });
  await tick();
  const where = [];
  for (let n = 0; n < 6; n += 1) where.push(executor.enqueue(make(n)));
  assert.deepEqual(where, ['queued', 'queued', 'spooled', 'spooled', 'spooled', 'spooled']);
  assert.deepEqual(executor.depth(), { running: 1, held: 0, queued: 2, spooled: 4 });
  const files = readdirSync(spoolDir);
  assert.equal(files.length, 4);
  if (process.platform !== 'win32') {
    for (const name of files) assert.equal(statSync(join(spoolDir, name)).mode & 0o777, 0o600);
    assert.equal(statSync(spoolDir).mode & 0o777, 0o700);
  }
  gate.resolve();
  await executor.drain(2_000);
  assert.deepEqual(ran, [0, 1, 2, 3, 4, 5], 'spooled work comes back in order');
  assert.deepEqual(readdirSync(spoolDir), [], 'a spooled job is removed once it ran');

  // Close with work waiting: it goes to the spool, and the next executor runs it.
  const blocked = deferred();
  const first = createBackgroundExecutor({ concurrency: 1, hotBusy: () => false, spoolDir, revive });
  first.enqueue({ key: 'k', label: 'sub', bytes: 0, run: () => blocked.promise });
  first.enqueue(make(10));
  first.enqueue(make(11));
  await tick();
  first.close();
  blocked.resolve();
  await first.drain(500);
  assert.equal(readdirSync(spoolDir).length, 2);
  ran.length = 0;
  const next = createBackgroundExecutor({ concurrency: 1, hotBusy: () => false, spoolDir, revive });
  assert.equal(next.recoverSpool(), 2);
  await next.drain(2_000);
  assert.deepEqual(ran, [10, 11]);
  assert.deepEqual(readdirSync(spoolDir), []);
});

test('a spooled job that cannot be revived is removed and counted, never left behind', async (t) => {
  const dir = tempDir(t);
  const spoolDir = join(dir, 'spool');
  const events = [];
  const executor = createBackgroundExecutor({ concurrency: 1, memoryBytes: 1, hotBusy: () => false, spoolDir, revive: () => undefined, onEvent: (e) => events.push(e.event) });
  const gate = deferred();
  executor.enqueue({ key: 'k', label: 'sub', bytes: 0, run: () => gate.promise });
  assert.equal(executor.enqueue({ key: 'k', label: 'sub', bytes: 10, run: async () => undefined, spool: () => '{}' }), 'spooled');
  gate.resolve();
  await executor.drain(1_000);
  assert.deepEqual(events, ['job-spooled', 'spool-unreadable']);
  assert.deepEqual(readdirSync(spoolDir), []);
});
