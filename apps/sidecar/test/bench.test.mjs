import test from 'node:test';
import assert from 'node:assert/strict';

// OBS-04: the benchmark harness measures cold and warm start, the IPC round trip, hot-path and
// background rules decisions and a semantic decision per OS. The regression gate compares medians
// (with a p95 guard, widened for a slower machine) and fails only a regression that repeats when
// the tripped series are measured again.

const { BENCH_SCHEMA, MAX_SPEED_FACTOR, SERIES, TARGETS, calibrate, compareBench, measureDecisions, outcomeOf, p95Series, runBench, runGate, speedFactor, statSeries, summarize } = await import('../scripts/bench.mjs');

const stat = (p50, p95 = p50) => ({ n: 100, p50, p95, max: p95 });
const record = (series, extra = {}) => ({ platform: 'linux', arch: 'x64', results: series, ...extra });
const ONE = (name, p50, p95 = p50) => record({ [name]: stat(p50, p95) });

test('summaries and the series a record carries (OBS-04)', () => {
  assert.deepEqual(summarize([5, 1, 3, 2, 4]), { n: 5, p50: 3, p95: 5, max: 5 });
  assert.equal(summarize([]), null);
  const rec = record({ coldStartMs: stat(200), hotRulesDecisionMs: { client: stat(4), service: null } });
  assert.deepEqual(p95Series(rec), { coldStartMs: 200, 'hotRulesDecisionMs.client': 4 });
  assert.deepEqual(Object.keys(statSeries(rec)), ['coldStartMs', 'hotRulesDecisionMs.client']);
  assert.deepEqual(SERIES.length, 6);
});

test('a series trips on its median above baseline x ratio + slack, or its p95 far above the baseline p95 (OBS-04)', () => {
  const base = ONE('coldStartMs', 200, 240);
  const opts = { ratio: 1.5, slackMs: 10 };
  // Median limit 200 x 1.5 + 10 = 310; tail limit 240 x 3 + 20 = 740.
  assert.equal(compareBench(ONE('coldStartMs', 310, 500), base, opts).ok, true, 'at the limit, and a slow tail below 740');
  const median = compareBench(ONE('coldStartMs', 311, 320), base, opts);
  assert.equal(median.ok, false);
  assert.deepEqual(median.regressions, [{ name: 'coldStartMs', kind: 'median', value: 311, baseline: 200, limit: 310 }]);
  const tail = compareBench(ONE('coldStartMs', 250, 741), base, opts);
  assert.deepEqual(tail.regressions, [{ name: 'coldStartMs', kind: 'tail', value: 741, baseline: 240, limit: 740 }]);
  assert.equal(tail.sameMachineKind, true);
  assert.equal(compareBench(ONE('coldStartMs', 311), { ...base, platform: 'darwin' }, opts).sameMachineKind, false);
  // A series only one record has is not compared.
  assert.deepEqual(compareBench(ONE('warmStartMs', 999), base, opts).compared, []);
});

test('the old failures are noise, not regressions: one stalled sample or a 2x noisy median under a lucky baseline (OBS-04)', () => {
  // CI run cfebc1e (ubuntu): the background series p95 was 29.6 ms against a 9.5 ms baseline, its median was normal.
  const base = ONE('backgroundRulesDecisionMs.client', 8, 9.5);
  assert.equal(compareBench(ONE('backgroundRulesDecisionMs.client', 8.2, 29.6), base).ok, true, 'a stalled request is a p95 spike, not a median move');
  // Cold start with 5 samples: its p95 was its slowest start (ubuntu 734 ms against 438 ms, median 228 ms against 407 ms).
  assert.equal(compareBench(ONE('coldStartMs', 228, 734), ONE('coldStartMs', 407, 438)).ok, true);
});

test('the limits widen for a slower machine and never narrow (OBS-04)', () => {
  const calibrated = (series, calibration) => ({ ...series, calibration });
  const base = calibrated(ONE('coldStartMs', 200), { nodeSpawnMs: 30, cpuLoopMs: 10, fsyncMs: 4 });
  assert.equal(speedFactor(base, base), 1);
  assert.equal(speedFactor(ONE('coldStartMs', 1), base), 1, 'a record with no calibration widens nothing');
  assert.equal(speedFactor(calibrated({}, { nodeSpawnMs: 30, cpuLoopMs: 10, fsyncMs: 4 }), ONE('coldStartMs', 1)), 1);
  assert.equal(speedFactor(calibrated({}, { nodeSpawnMs: 15, cpuLoopMs: 5, fsyncMs: 2 }), base), 1, 'a faster machine does not narrow');
  assert.equal(speedFactor(calibrated({}, { nodeSpawnMs: 30, cpuLoopMs: 25, fsyncMs: 4 }), base), 2.5, 'the slowest probe decides');
  assert.equal(speedFactor(calibrated({}, { nodeSpawnMs: 900, cpuLoopMs: 10, fsyncMs: 4 }), base), MAX_SPEED_FACTOR);
  // A median of 450 trips the 310 limit; on a machine 2x slower it does not (620), and a real slowdown to 700 still does.
  const slow = { nodeSpawnMs: 60, cpuLoopMs: 20, fsyncMs: 8 };
  assert.equal(compareBench(ONE('coldStartMs', 450), base).ok, false);
  assert.equal(compareBench(calibrated(ONE('coldStartMs', 450), slow), base).ok, true);
  assert.equal(compareBench(calibrated(ONE('coldStartMs', 700), slow), base).ok, false);
  // The same 450 ms on a machine as fast as the baseline's is a regression.
  assert.equal(compareBench(calibrated(ONE('coldStartMs', 450), { nodeSpawnMs: 30, cpuLoopMs: 10, fsyncMs: 4 }), base).ok, false);
});

test('the gate fails only a series that trips in the first pass and in every re-measure (OBS-04)', async () => {
  const base = record({ coldStartMs: stat(200), warmStartMs: stat(1), hotRulesDecisionMs: { client: stat(2), service: stat(1) } });
  const first = record({ coldStartMs: stat(400), warmStartMs: stat(20), hotRulesDecisionMs: { client: stat(30), service: stat(1) } });
  // coldStartMs and warmStartMs and hotRulesDecisionMs.client trip at first.
  assert.deepEqual(compareBench(first, base).regressions.map((r) => r.name), ['coldStartMs', 'warmStartMs', 'hotRulesDecisionMs.client']);
  const calls = [];
  const remeasure = async (names, round) => {
    calls.push([round, names]);
    // A noise series is back to normal; the hot decision is still slow; cold start could not be measured this time.
    return record({ warmStartMs: stat(1), hotRulesDecisionMs: { client: stat(30), service: stat(1) }, coldStartMs: null });
  };
  const gate = await runGate({ first, baseline: base, rechecks: 2, remeasure });
  assert.deepEqual(calls, [
    [1, ['coldStartMs', 'warmStartMs', 'hotRulesDecisionMs']],
    [2, ['coldStartMs', 'hotRulesDecisionMs']],
  ], 'each round measures only the series still under suspicion');
  assert.deepEqual(gate.cleared, ['warmStartMs']);
  assert.deepEqual(gate.confirmed.map((r) => r.name), ['coldStartMs', 'hotRulesDecisionMs.client'], 'a series not measured in a re-measure stays a suspect');
  assert.equal(gate.ok, false);
  assert.equal(gate.passes.length, 3);
});

test('a gate with no trip does not measure again, and a trip that does not repeat passes (OBS-04)', async () => {
  const base = ONE('coldStartMs', 200);
  let calls = 0;
  const remeasure = async () => {
    calls += 1;
    return ONE('coldStartMs', 205);
  };
  const clean = await runGate({ first: ONE('coldStartMs', 210), baseline: base, remeasure });
  assert.equal(clean.ok, true);
  assert.equal(calls, 0);
  const noise = await runGate({ first: ONE('coldStartMs', 900), baseline: base, remeasure });
  assert.equal(noise.ok, true, 'a stall that does not come back');
  assert.deepEqual(noise.cleared, ['coldStartMs']);
  assert.equal(calls, 1, 'one re-measure cleared it, so no second one');
  // With rechecks 0 a single trip is a regression.
  const strict = await runGate({ first: ONE('coldStartMs', 900), baseline: base, rechecks: 0, remeasure });
  assert.equal(strict.ok, false);
});

test('a real slowdown repeats and fails the gate (OBS-04)', async () => {
  // recover 20 ms slower: a median of 8 ms becomes 28 ms against a limit of 8 x 1.5 + 10 = 22 ms, in every pass.
  const base = ONE('backgroundRulesDecisionMs.client', 8, 9.5);
  const slow = () => ONE('backgroundRulesDecisionMs.client', 28, 33);
  const gate = await runGate({ first: slow(), baseline: base, remeasure: async () => slow() });
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.confirmed.map((r) => [r.name, r.kind, r.limit]), [['backgroundRulesDecisionMs.client', 'median', 22]]);
});

test('the calibration probes report positive times (OBS-04)', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'b-calib-'));
  try {
    const probes = calibrate(join(dir, 'p'));
    assert.deepEqual(Object.keys(probes), ['nodeSpawnMs', 'cpuLoopMs', 'fsyncMs']);
    for (const value of Object.values(probes)) assert.equal(value > 0, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a quick benchmark run measures every series against the built product (OBS-04)', async () => {
  const measured = await runBench({ quick: true });
  assert.equal(measured.schemaVersion, BENCH_SCHEMA);
  assert.deepEqual(measured.failures, []);
  assert.equal(measured.platform, process.platform);
  assert.deepEqual(measured.targets, TARGETS);
  assert.deepEqual(Object.keys(measured.calibration), ['nodeSpawnMs', 'cpuLoopMs', 'fsyncMs']);
  for (const name of ['coldStartMs', 'warmStartMs', 'ipcRoundTripMs']) assert.equal(typeof measured.results[name]?.p95, 'number', name);
  for (const name of ['hotRulesDecisionMs', 'backgroundRulesDecisionMs', 'semanticDecisionMs']) {
    assert.equal(typeof measured.results[name]?.client?.p95, 'number', `${name}.client`);
    assert.equal(typeof measured.results[name]?.service?.p95, 'number', `${name}.service (from the sidecar's traces)`);
    assert.equal(Number.isInteger(measured.results[name]?.deadlineHits) && measured.results[name].deadlineHits >= 0, true, `${name}.deadlineHits is a count`);
  }
  for (const met of Object.values(measured.targetsMet)) assert.equal(typeof met, 'boolean');
});

test('a re-measure runs only the series it is asked for (OBS-04)', async () => {
  const measured = await runBench({ quick: true, only: ['ipcRoundTripMs', 'hotRulesDecisionMs'] });
  assert.deepEqual(measured.failures, []);
  assert.equal(typeof measured.results.ipcRoundTripMs?.p95, 'number');
  assert.equal(typeof measured.results.hotRulesDecisionMs?.client?.p95, 'number');
  for (const name of ['coldStartMs', 'warmStartMs']) assert.equal(measured.results[name], null, name);
  for (const name of ['backgroundRulesDecisionMs', 'semanticDecisionMs']) assert.deepEqual(measured.results[name], { client: null, service: null }, name);
});

// The quick run is a smoke test of the harness against a built product, and a slow host is not a defect of the harness.
// A Windows runner took 2 to 7 s for the engine's durable journal and budget writes before a request was sent, so a
// semantic decision ended `DEADLINE` at its 5 s budget and the quick run failed with ['semantic decision: DEADLINE'].
// With an injected 1.5 s per fsync of the decision files that failure was reproduced on a development machine; the
// quick run now counts the deadline as an outcome and the full run and the gate stay strict.

function fakeSidecar(stateDir, answers) {
  let at = 0;
  return {
    async sidecarRequest({ op }) {
      const answer = answers[Math.min(at, answers.length - 1)];
      at += 1;
      // The sidecar's own trace of the request, as the product writes it.
      const { mkdirSync, appendFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      mkdirSync(join(stateDir, 'traces'), { recursive: true });
      appendFileSync(join(stateDir, 'traces', 'trace.jsonl'), `${JSON.stringify({ event: 'request.outcome', op, ok: answer.ok === true, ms: 5000, ts: new Date().toISOString() })}\n`); // test-hygiene: not product source
      return answer;
    },
  };
}

async function withStateDir(fn) {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'b-decisions-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('outcomeOf: an answer is ok; a deadline or a timeout is an outcome only in the quick run; every other refusal is a failure (OBS-04)', () => {
  assert.equal(outcomeOf({ ok: true, result: {} }, true), 'ok');
  assert.equal(outcomeOf({ ok: true }, false), 'ok');
  for (const reply of [{ ok: false, reasonCode: 'DEADLINE' }, { ok: false, reason: 'timeout', reasonCode: 'TIMEOUT' }, { ok: false, reason: 'timeout', reasonCode: 'HANDSHAKE_TIMEOUT' }, { ok: false, reason: 'timeout' }]) {
    assert.equal(outcomeOf(reply, true), 'deadline', JSON.stringify(reply));
    assert.equal(outcomeOf(reply, false), 'failure', `${JSON.stringify(reply)}: the full run is strict`);
  }
  for (const reply of [{ ok: false, reasonCode: 'INVALID_REQUEST' }, { ok: false, reason: 'unavailable', reasonCode: 'NOT_RUNNING' }, { ok: false, reason: 'rejected', reasonCode: 'KILL_SWITCH' }, { ok: false }, null, undefined]) {
    assert.equal(outcomeOf(reply, true), 'failure', JSON.stringify(reply));
  }
});

test('a quick series that hit its deadline records the hits and its times, and reports no failure (OBS-04)', async () => {
  await withStateDir(async (stateDir) => {
    const failures = [];
    const sidecar = fakeSidecar(stateDir, [{ ok: true }, { ok: false, reasonCode: 'DEADLINE' }, { ok: false, reasonCode: 'DEADLINE' }, { ok: true }]);
    const ports = { sidecar, home: stateDir, work: stateDir, stateDir };
    const series = await measureDecisions({ ports, label: 'semantic decision', op: 'recover', body: (i) => ({ i }), n: 3, offset: 10, warmup: 1, lenient: true, failures });
    assert.deepEqual(failures, []);
    assert.equal(series.deadlineHits, 2);
    assert.equal(series.client.n, 3, 'a deadline answer is a sample: it is what the caller waited');
    assert.equal(typeof series.client.p95, 'number');
    assert.equal(typeof series.service.p95, 'number', 'and the sidecar traced it');
  });
});

test('the full run is as strict as before: the same deadlines are failures, and a series with no sample is missing (OBS-04)', async () => {
  await withStateDir(async (stateDir) => {
    const failures = [];
    const sidecar = fakeSidecar(stateDir, [{ ok: false, reasonCode: 'DEADLINE' }]);
    const ports = { sidecar, home: stateDir, work: stateDir, stateDir };
    const series = await measureDecisions({ ports, label: 'semantic decision', op: 'recover', body: (i) => ({ i }), n: 2, offset: 10, warmup: 0, lenient: false, failures });
    assert.deepEqual(failures, ['semantic decision: DEADLINE', 'semantic decision: DEADLINE']);
    assert.equal(series.deadlineHits, 0);
    assert.equal(series.client, null, 'nothing was measured: the series is missing, and the run says so');
  });
});

test('a quick series whose requests all fail for another reason is a failure and has no sample, so the quick run still fails (OBS-04)', async () => {
  await withStateDir(async (stateDir) => {
    const failures = [];
    const sidecar = fakeSidecar(stateDir, [{ ok: false, reasonCode: 'NOT_RUNNING', reason: 'unavailable' }]);
    const ports = { sidecar, home: stateDir, work: stateDir, stateDir };
    const series = await measureDecisions({ ports, label: 'hot rules decision', op: 'route', body: (i) => ({ i }), n: 2, offset: 1000, warmup: 0, lenient: true, failures });
    assert.deepEqual(failures, ['hot rules decision: NOT_RUNNING', 'hot rules decision: NOT_RUNNING']);
    assert.equal(series.client, null);
  });
});
