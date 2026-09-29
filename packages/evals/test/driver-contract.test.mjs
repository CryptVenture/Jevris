import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const e = await import('../dist/index.js');

const GOOD = {
  completed: true, receipts: [{ id: 'unit', passed: true }], retries: 0, inputTokens: 10, outputTokens: 5, costMicroUsd: 12, costSource: 'provider-reported',
  estimatedCostMicroUsd: 10, wallMs: 100, humanMinutes: 0, defectEscaped: false, abandoned: false, safetyFailures: [], measuredComponents: ['retries', 'verification'],
};

test('EVL-05: validateRunOutcome names every broken field of a driver outcome', () => {
  assert.deepEqual(e.validateRunOutcome(GOOD), []);
  assert.deepEqual(e.validateRunOutcome(null), ['not an object']);
  assert.deepEqual(e.validateRunOutcome({ ...GOOD, receipts: [{ id: 'x' }], costSource: 'guess', measuredComponents: ['retries', 'retries'] }), ['receipts', 'costSource', 'measuredComponents']);
  assert.deepEqual(e.validateRunOutcome({ ...GOOD, costSource: 'estimate', costMicroUsd: 3 }), ['costMicroUsd: an estimate must equal estimatedCostMicroUsd']);
  assert.deepEqual(e.validateRunOutcome({ ...GOOD, wallMs: -1 }), ['wallMs']);
});

test('EVL-05: driverConformance passes a well-behaved driver and fails one that ignores cancellation or shares sandboxes', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'jevris-driver-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const sandboxes = e.directorySandboxes(base, null);
  const task = { taskId: 't1', repository: 'r', sliceId: 's', difficulty: 'easy' };
  const good = { async run({ signal }) { return signal.aborted ? { ...GOOD, completed: false, receipts: [] } : GOOD; } };
  const ok = await e.driverConformance({ driver: good, sandboxes, task });
  assert.equal(ok.passed, true, JSON.stringify(ok.checks));
  const deaf = { run: () => new Promise(() => {}) };
  const hung = await e.driverConformance({ driver: { run: (input) => (input.signal.aborted ? deaf.run() : Promise.resolve(GOOD)) }, sandboxes, task, cancelWithinMs: 50 });
  assert.equal(hung.passed, false);
  assert.match(hung.checks.find((c) => c.name === 'cancel').detail, /did not settle/);
  const shared = { async create() { return { path: base, dispose: async () => {} }; } };
  const reused = await e.driverConformance({ driver: good, sandboxes: shared, task });
  assert.equal(reused.checks.find((c) => c.name === 'jev-routed: own sandbox').passed, false);
});
