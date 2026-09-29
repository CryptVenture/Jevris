import test from 'node:test';
import assert from 'node:assert/strict';

// OBS-04: the benchmark harness measures cold and warm start, the IPC round trip, hot-path and
// background rules decisions and a semantic decision per OS, and a regression check fails a p95
// beyond baseline × ratio + slack.

const { BENCH_SCHEMA, TARGETS, compareBench, p95Series, runBench, summarize } = await import('../scripts/bench.mjs');

test('summaries and the regression check (OBS-04)', () => {
  assert.deepEqual(summarize([5, 1, 3, 2, 4]), { n: 5, p50: 3, p95: 5, max: 5 });
  assert.equal(summarize([]), null);
  const record = (hot, cold) => ({ platform: 'linux', arch: 'x64', results: { coldStartMs: { n: 1, p50: cold, p95: cold, max: cold }, hotRulesDecisionMs: { client: { n: 1, p50: hot, p95: hot, max: hot }, service: null } } });
  assert.deepEqual(p95Series(record(4, 200)), { coldStartMs: 200, 'hotRulesDecisionMs.client': 4 });
  const base = record(4, 200);
  assert.equal(compareBench(record(15, 300), base, { ratio: 1.5, slackMs: 10 }).ok, true, 'within 1.5 × + 10 ms');
  const worse = compareBench(record(17, 320), base, { ratio: 1.5, slackMs: 10 });
  assert.equal(worse.ok, false);
  assert.deepEqual(worse.regressions.map((r) => [r.name, r.limit]), [['coldStartMs', 310], ['hotRulesDecisionMs.client', 16]]);
  assert.equal(worse.sameMachineKind, true);
  assert.equal(compareBench(record(17, 320), { ...base, platform: 'darwin' }).sameMachineKind, false);
});

test('a quick benchmark run measures every series against the built product (OBS-04)', async () => {
  const record = await runBench({ quick: true });
  assert.equal(record.schemaVersion, BENCH_SCHEMA);
  assert.deepEqual(record.failures, []);
  assert.equal(record.platform, process.platform);
  assert.deepEqual(record.targets, TARGETS);
  for (const name of ['coldStartMs', 'warmStartMs', 'ipcRoundTripMs']) assert.equal(typeof record.results[name]?.p95, 'number', name);
  for (const name of ['hotRulesDecisionMs', 'backgroundRulesDecisionMs', 'semanticDecisionMs']) {
    assert.equal(typeof record.results[name]?.client?.p95, 'number', `${name}.client`);
    assert.equal(typeof record.results[name]?.service?.p95, 'number', `${name}.service (from the sidecar's traces)`);
  }
  for (const met of Object.values(record.targetsMet)) assert.equal(typeof met, 'boolean');
});
