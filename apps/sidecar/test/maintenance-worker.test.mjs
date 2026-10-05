// P10 (sidecar concurrency audit; owner ededdba): the retention sweep runs in a worker thread on a
// second store connection that only this process may open while it holds the writer lock, in
// chunked transactions, while the writer connection keeps writing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const api = await import('@jevris/store');
const { sweepInWorker, sweepInline, SWEEP_CHUNK_ROWS, SWEEP_PAUSE_MS } = await import('../dist/maintenance.js');
const { performance } = await import('node:perf_hooks');
const MAIN = new URL('../dist/main.js', import.meta.url);
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const DAY = 86_400_000;

function withStore(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'b-maint-')));
  const path = join(dir, 'jevris.db');
  const store = api.openStore({ path, role: 'sidecar', workspaceId: 'host', hostScope: 'hostA', fsKind: () => ({ kind: 'local', label: 't' }) });
  assert.equal(store.ok, true, JSON.stringify(store));
  const done = async () => {
    api.closeStore(store);
    rmSync(dir, { recursive: true, force: true });
  };
  return fn(store, path, dir).finally(done);
}

async function seedOld(store, rows, now) {
  const ledger = api.hookLedger(store, { nowMs: () => now - 40 * DAY });
  await ledger.transact((tx) => {
    for (let i = 0; i < rows; i += 1) tx.put('loop-signals', `old-${String(i).padStart(5, '0')}`, { i, pad: 'x'.repeat(200) });
  });
  await api.hookLedger(store, { nowMs: () => now }).transact((tx) => tx.put('loop-signals', 'fresh', { fresh: true }));
  assert.equal(api.flushHookRecords(store), true);
}

test('the maintenance connection opens only in the writer process, on the latest schema and its own host scope', async () => {
  await withStore(async (store, path) => {
    // In this realm the writer connection is already live for the path, so a second one here is refused.
    assert.equal(api.openMaintenanceStore({ path, hostScope: 'hostA' }).reason, 'writer-busy');
    // In the worker (its own realm, this process) a wrong host scope is refused.
    const wrong = await sweepInWorker(MAIN, { path, hostScope: 'other', policy: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 }, nowMs: Date.now(), rawDir: join(path, '..', 'evidence') }).done;
    assert.deepEqual(wrong, { ok: false, reason: 'host-scope-mismatch', where: 'worker' });
  });
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'b-maint-nolock-')));
  try {
    assert.equal(api.openMaintenanceStore({ path: join(dir, 'jevris.db'), hostScope: 'hostA' }).reason, 'writer-busy', 'no writer lock held, no maintenance connection');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a new store uses incremental auto-vacuum', async () => {
  await withStore(async (_store, path) => {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      assert.equal(db.pragma('auto_vacuum', { simple: true }), 2);
    } finally {
      db.close();
    }
  });
});

test('the worker sweeps on its own connection in chunks while the writer keeps writing', async () => {
  await withStore(async (store, path, dir) => {
    const now = Date.now();
    await seedOld(store, SWEEP_CHUNK_ROWS * 3 + 7, now);
    const running = sweepInWorker(MAIN, { path, hostScope: 'hostA', policy: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 }, nowMs: now, rawDir: join(dir, 'evidence') });
    // The writer connection is never locked out for long while the worker runs.
    let writes = 0;
    const writer = api.hookLedger(store);
    const started = Date.now();
    while (Date.now() - started < 50) {
      await writer.transact((tx) => tx.put('stop-reports', `w${writes}`, { writes }));
      assert.equal(api.flushHookRecords(store), true);
      writes += 1;
      await new Promise((resolve) => setImmediate(resolve));
    }
    const outcome = await running.done;
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(outcome.where, 'worker');
    assert.equal(outcome.removed.hook_records, SWEEP_CHUNK_ROWS * 3 + 7);
    assert.deepEqual(api.hookLedger(store).list('loop-signals'), [{ fresh: true }]);
    assert.equal(api.hookLedger(store).list('stop-reports').length, writes, 'every write during the sweep is kept');
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const audit = db.prepare("SELECT channel, detail FROM audit_log WHERE kind = 'retention.sweep'").all();
      assert.equal(audit.length, 1, 'one audit row per sweep');
      assert.equal(JSON.parse(audit[0].detail).removed, SWEEP_CHUNK_ROWS * 3 + 7);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM maintenance_flag').get().n, 0, 'the immutability flag is never left committed');
    } finally {
      db.close();
    }
  });
});

test('the inline fallback runs the same chunked sweep; a worker that cannot start says so', async () => {
  await withStore(async (store, path, dir) => {
    const now = Date.now();
    await seedOld(store, 12, now);
    const job = { path, hostScope: 'hostA', policy: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 }, nowMs: now, rawDir: join(dir, 'evidence') };
    const missing = await sweepInWorker(new URL('file:///nonexistent/jevris-sidecar-main.js'), job).done;
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /^MAINTENANCE_WORKER_(UNAVAILABLE|FAILED)$/);
    const inline = sweepInline(api, store, job);
    assert.equal(inline.ok, true, JSON.stringify(inline));
    assert.equal(inline.where, 'inline');
    assert.equal(inline.removed.hook_records, 12);
  });
});

test('sweep chunks are bounded in time: a slow chunk halves the next, and the pause runs between writes', async () => {
  const run = async (stepMs) => {
    let pauses = 0;
    let at = 0;
    let result;
    await withStore(async (store, _path, dir) => {
      const now = Date.now();
      await seedOld(store, 300, now);
      result = api.sweepRetention(store, {
        policy: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 },
        nowMs: now,
        rawDir: join(dir, 'evidence'),
        chunkRows: 500,
        chunkMs: 8,
        clock: () => (at += stepMs),
        pause: () => {
          pauses += 1;
        },
        vacuum: 'incremental',
      });
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.removed.hook_records, 300);
    return pauses;
  };
  const slow = await run(20);
  const fast = await run(0);
  assert.ok(slow > fast + 5, `slow chunks shrink, so more writes and pauses (${slow} against ${fast})`);
});

// windows-latest (af665fd): the worker sweep of 1507 rows timed out at 120 s. Every write there took
// over 8 ms for its commit and sync alone, so every chunk "was slow", the size halved write after
// write down to one row, and the sweep needed about 1500 writes. A step's fixed cost does not
// shrink with its rows, so the size now stops at a floor. Deterministic: a clock that makes
// every write slow, whatever its rows.
test('when every write is slow, the chunk size stops at a floor instead of shrinking to one row', async () => {
  let at = 0;
  let pauses = 0;
  let result;
  await withStore(async (store, _path, dir) => {
    const now = Date.now();
    await seedOld(store, 1500, now);
    result = api.sweepRetention(store, {
      policy: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 },
      nowMs: now,
      rawDir: join(dir, 'evidence'),
      chunkRows: 500,
      chunkMs: 8,
      clock: () => (at += 60),
      pause: () => {
        pauses += 1;
      },
      vacuum: 'incremental',
    });
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.removed.hook_records, 1500);
  const smallest = Math.min(...result.chunks.slice(0, -1).map((c) => c.rows));
  assert.ok(smallest >= 16, `no chunk shrank below the floor (smallest ${String(smallest)})`);
  assert.ok(result.chunks.length <= 120, `the sweep took ${String(result.chunks.length)} writes, not about 1500 (${String(pauses)} pauses)`);
});

test('a hot write that meets a maintenance chunk waits about one chunk, not busy_timeout', async (t) => {
  // One sweep of 6000 rows in the worker while this connection commits hot writes beside it.
  const scenario = () =>
    withStore(async (store, path, dir) => {
      const now = Date.now();
      await seedOld(store, 6000, now);
      // This machine's own speed, measured with no sweep running: the same hot commit, same disk.
      const quiet = [];
      for (let i = 0; i < 30; i += 1) {
        await api.hookLedger(store).transact((tx) => tx.put('loop-signals', `quiet${i}`, { i }));
        const began = performance.now();
        assert.equal(api.flushHookRecords(store), true);
        quiet.push(performance.now() - began);
      }
      const running = sweepInWorker(MAIN, { path, hostScope: 'hostA', policy: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 }, nowMs: now, rawDir: join(dir, 'evidence') });
      let finished = false;
      void running.done.then(() => {
        finished = true;
      });
      const writer = api.hookLedger(store);
      const waits = [];
      let during = 0;
      for (let i = 0; i < 400 && !finished; i += 1) {
        await writer.transact((tx) => tx.put('stop-reports', `hot${i}`, { i }));
        // The synchronous commit is what blocks the event loop; time exactly that.
        const started = performance.now();
        assert.equal(api.flushHookRecords(store), true, 'a hot write is never refused while the worker sweeps');
        waits.push(performance.now() - started);
        if (!finished) during += 1;
        await new Promise((resolve) => setTimeout(resolve, SWEEP_PAUSE_MS / 4));
      }
      const outcome = await running.done;
      assert.equal(outcome.ok, true, JSON.stringify(outcome));
      assert.equal(outcome.where, 'worker');
      assert.equal(outcome.removed.hook_records, 6000);
      assert.ok(during >= 3, `hot writes ran while the worker swept (${during})`);
      assert.equal(api.hookLedger(store).list('stop-reports').length, waits.length, 'every hot write is kept');
      return { outcome, waits, quiet };
    });
  // What bounds a hot write's wait is the chunk, so the test shows three things.
  // 1. The sweep is chunked: the 6000 rows went in at least 12 deletes of at most 500 rows each
  //    (SWEEP_CHUNK_ROWS; the first chunks are smaller while the size ramps up from 100).
  // 2. A chunk holds the lock briefly: the 90th percentile of the chunks' lock times is under
  //    50 ms, and so is that of the hot commits. On windows-latest the bound is 100 ms (one chunk
  //    took 59 ms there; file writes are slower, and one runner carries the whole suite).
  // 3. Nothing comes near busy_timeout (2 s): the longest maintenance write and the worst hot
  //    commit are each under 400 ms (1200 ms on Windows, where a runner stall held a hot commit for
  //    about 520 ms in CI run 37324140640; a commit that waited for a held lock takes about 2000 ms).
  // Why a percentile, not the longest write: the longest is one sample, and a stalled runner
  // decides it. A 500-row chunk is under 1 ms of work on a quiet host (0.9 ms at most, measured
  // at 52f2beb), yet a macos-latest runner held one for 85 ms at 52f2beb while its worst hot
  // commit took 7.6 ms, and ubuntu-latest one for 79 ms at 5c5b566. The store's own share of
  // those, a connection that synced every commit, is fixed (52f2beb). The percentile still fails
  // when chunking is broken: with a huge chunk size the sweep is a few large deletes and step 1
  // fails; with no chunking at all it is one delete, which is its own 90th percentile.
  // Why the timing checks get one more try: run 36651204396 (windows-latest) failed `worst < 400`
  // with one hot commit at 2547.7 ms while the same run's chunks were healthy (a 500-row chunk
  // is well under 100 ms) and its 90th percentiles were normal. One commit stalled for longer
  // than busy_timeout while the chunk timings show no lock held that long, so the stall came
  // from the runner (a paused process, antivirus, disk flush), not from chunking. A stall is
  // not repeatable; a chunking bug is, because it shows in every run. So the structural checks
  // (chunk count, chunk size, rows) run on every attempt and fail at once, and the timing
  // checks fail only when a second, fresh sweep also breaks them.
  const writeBound = process.platform === 'win32' ? 100 : 50;
  const p90 = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * 0.9) - 1)] ?? 0;
  };
  let timing = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const { outcome, waits, quiet } = await scenario();
    // The 400 ms bounds are for a quiet disk. A runner whose plain commit already takes tens of
    // ms (windows-latest at af665fd: a hot commit p90 of 72 ms, a 341 ms chunk, a worst commit of
    // 496 ms) gets the bound this run's own quiet commits earn: 400 ms plus ten of their 90th
    // percentiles. Still far under busy_timeout (2000 ms) wherever a commit costs under ~160 ms.
    // windows-latest again (CI run 37324140640): both sweeps' worst hot commit was about 520 ms against a 401 ms bound,
    // on a runner whose quiet commit p90 was 0.1 ms (the same kind of stall as the 496 ms at af665fd, and it lasted for both
    // attempts), while the structural checks and the 90th percentiles held. What this bound shows is that nothing comes near
    // busy_timeout (2000 ms): a commit that really waited for a held lock takes about 2000 ms or is refused. So on Windows
    // the base is 1200 ms, still far under busy_timeout; elsewhere it stays 400 ms.
    const nearBusyBase = process.platform === 'win32' ? 1200 : 400;
    const nearBusy = nearBusyBase + 10 * p90(quiet);
    const bound = writeBound + 2 * p90(quiet);
    const chunkMs = outcome.chunks.map((c) => c.ms);
    const worst = Math.max(...waits);
    t.diagnostic(
      `attempt ${String(attempt)}: ${String(outcome.chunks.length)} chunks (largest ${String(Math.max(...outcome.chunks.map((c) => c.rows)))} rows), p90 ${p90(chunkMs).toFixed(1)} ms, longest maintenance write ${outcome.longestWriteMs.toFixed(1)} ms; ` +
        `${String(waits.length)} hot commits, p90 ${p90(waits).toFixed(1)} ms, worst ${worst.toFixed(1)} ms; quiet p90 ${p90(quiet).toFixed(1)} ms`,
    );
    assert.ok(outcome.chunks.length >= 12, `the sweep ran in ${String(outcome.chunks.length)} chunks`);
    assert.ok(outcome.chunks.every((c) => c.rows <= 500), `no chunk over 500 rows: ${JSON.stringify(outcome.chunks.map((c) => c.rows))}`);
    assert.equal(outcome.chunks.reduce((a, c) => a + c.rows, 0), 6000, 'the chunks hold every removed row');
    timing = [];
    if (!(p90(chunkMs) < bound)) timing.push(`90th percentile of chunk writes ${p90(chunkMs).toFixed(1)} ms (bound ${bound.toFixed(0)})`);
    if (!(p90(waits) < bound)) timing.push(`90th percentile of hot commits ${p90(waits).toFixed(1)} ms (bound ${bound.toFixed(0)})`);
    if (!(outcome.longestWriteMs < nearBusy)) timing.push(`longest maintenance write ${outcome.longestWriteMs.toFixed(1)} ms (bound ${nearBusy.toFixed(0)})`);
    if (!(worst < nearBusy)) timing.push(`worst hot commit ${worst.toFixed(1)} ms during the sweep (bound ${nearBusy.toFixed(0)})`);
    if (timing.length === 0) break;
    t.diagnostic(`attempt ${String(attempt)} broke a timing bound (${timing.join('; ')})${attempt < 2 ? ', measuring again' : ''}`);
  }
  assert.deepEqual(timing, [], 'both sweeps broke a timing bound');
});
