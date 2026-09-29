import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from './temp-dirs.mjs';

// OBS-02: the SSOT §17.5 decision counters over a window, from the immutable decision rows.

const s = await import(new URL('../dist/index.js', import.meta.url).href);

function row(id, extra = {}) {
  return {
    workspaceId: 'wOne',
    decisionId: id,
    taskId: null,
    kind: 'recover',
    specVersion: '1',
    model: 'rules',
    encoderVersion: 'none',
    calibrationVersion: 'none',
    policyVersion: 'p1',
    state: 'applied',
    outcome: 'advisory',
    reasonCodes: ['RULES'],
    latencyMs: 3,
    providerCalls: 0,
    usage: null,
    reservedMicroUsd: 0,
    costMicroUsd: null,
    billingBasis: 'none',
    processRole: 'sidecar',
    source: 'direct',
    record: { decisionId: id },
    createdAtMs: 1_000,
    ...extra,
  };
}

test('decision counters: count, outcomes, abstentions, rules bypass, fallbacks, retries, latency, tokens and cost (OBS-02)', () => {
  const dir = makeTempDir('b-counters-');
  const store = s.openStore({ path: join(dir, 'jevris.db'), role: 'sidecar', workspaceId: 'host', hostScope: 'hostA', fsKind: () => ({ kind: 'local', label: 't' }) });
  assert.equal(store.ok, true, JSON.stringify(store));
  try {
    const rows = [
      row('d1'),
      row('d2', { latencyMs: 7 }),
      row('d3', { model: 'jev-1', providerCalls: 1, outcome: 'applied', state: 'applied', reasonCodes: ['CONFIDENT'], latencyMs: 400, usage: { inputTokens: 100, outputTokens: 20 }, reservedMicroUsd: 500, costMicroUsd: 300 }),
      row('d4', { model: 'jev-1', providerCalls: 3, outcome: 'abstained', state: 'abstained', reasonCodes: ['OVERLOADED'], latencyMs: 4000, reservedMicroUsd: 500 }),
      row('d5', { model: 'jev-1', providerCalls: 1, outcome: 'stale', state: 'stale', reasonCodes: ['DEADLINE'], latencyMs: 5000, reservedMicroUsd: 500 }),
      row('d6', { workspaceId: 'wTwo' }),
      row('old', { createdAtMs: 10 }),
    ];
    for (const input of rows) assert.equal(s.recordDecisionRow(store, input).ok, true, input.decisionId);

    const c = s.decisionCounters(store, { sinceMs: 500 });
    assert.equal(c.decisions, 6, 'the row before the window is not counted');
    assert.deepEqual(c.outcomes, { advisory: 3, applied: 1, abstained: 1, stale: 1 });
    assert.equal(c.abstentions, 1);
    assert.equal(c.rulesOnly, 3, 'no provider call: the rules bypass');
    assert.equal(c.semantic, 3);
    assert.equal(c.fallbacks, 2, 'Jev was called but local rules answered');
    assert.equal(c.stale, 1);
    assert.equal(c.retries, 2, 'calls after the first');
    assert.deepEqual(c.latencyMs.rules, { count: 3, p50: 3, p95: 7, max: 7 });
    assert.deepEqual(c.latencyMs.semantic, { count: 3, p50: 4000, p95: 5000, max: 5000 });
    assert.deepEqual(c.tokens, { input: 100, output: 20, usageUnknown: 5 });
    assert.deepEqual(c.costMicroUsd, { reserved: 1500, actual: 300, actualUnknown: 5 });
    assert.deepEqual(c.models, { rules: 3, 'jev-1': 3 });
    assert.equal(c.reasonCodes.RULES, 3);
    assert.equal(c.reasonCodes.OVERLOADED, 1);
    assert.equal(c.truncated, false);

    // One workspace only.
    assert.equal(s.decisionCounters(store, { sinceMs: 500, workspaceId: 'wTwo' }).decisions, 1);
    // An empty window has no latency.
    const empty = s.decisionCounters(store, { sinceMs: 1_000_000 });
    assert.equal(empty.decisions, 0);
    assert.deepEqual(empty.latencyMs, { rules: null, semantic: null });
  } finally {
    s.closeStore(store);
    removeTempDir(dir);
  }
});
