// Sonnet-first visibility (owner decision 2026-09-30) through the built CLI: `jevris route learning
// status` shows, per slice, the first-try and control tasks this workspace finished, the cost per
// verified task of each (an estimate when priced from usage), and says quality is unknown.
// Temporary HOME, no network, no worker run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from '../../../test/acceptance/lib.mjs';

const orchestrator = await import('@jevris/orchestrator');

const SLICE = 'issue-fix';
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
const note = (arm) => ({ firstTry: { arm, propensity: arm === 'control' ? 0.1 : 0.9, firstTryModelId: SONNET, baselineModelId: OPUS, stepUpModelIds: [OPUS], breakEven: 0.5, breakEvenBasis: 'estimated', overheadMicroUsd: 1000 } });

test('route learning status shows the first-try ledger per slice with its estimate label and "quality unknown"', async (t) => {
  const box = await sandbox(t);
  box.write('work/src/a.js', 'export const a = 1;\n');
  box.gitInit();
  const none = box.jevris(['route', 'learning', 'status']);
  assert.equal(none.code, 0, none.stdout + none.stderr);
  assert.match(none.stdout, /Sonnet-first routing \(routing\.firstTry auto\)/);
  assert.match(none.stdout, /Quality: unknown/);
  assert.match(none.stdout, /No first-try tasks have run in this workspace yet\./);

  const ws = orchestrator.openWorkspace({ home: box.home, workspaceRoot: box.work });
  const run = (leaseId, model, costUsd) => ({ leaseId, requestedModel: model, actualModel: model, costUsd, authMode: 'api-key', durationMs: 1000 });
  for (const [id, arm, model, cost] of [['A1', 'first-try', SONNET, 0.02], ['A2', 'control', OPUS, 0.05]]) {
    await orchestrator.keepFirstTryRoute(ws, { taskId: id, sliceId: SLICE, run: { leaseId: `l-${id}`, requestedModel: model }, note: note(arm), nowMs: 1 });
    await orchestrator.recordFirstTryOutcome(ws, id, 'verified-pass', { run: run(`l-${id}`, model, cost), nowMs: 2 });
  }
  const text = box.jevris(['route', 'learning', 'status']);
  assert.equal(text.code, 0, text.stdout + text.stderr);
  assert.match(text.stdout, /^- issue-fix: claude-sonnet-5-5 before claude-opus-5-5, now first-try \(DAY_1_PRIOR\); 0 open\.$/m);
  assert.match(text.stdout, /first try: 1 finished, 1 verified, 0 handed off; cost per verified task \$0\.0200$/m);
  assert.match(text.stdout, /control \(baseline first\): 1 finished, 1 verified; cost per verified task \$0\.0500$/m);

  const json = box.jevris(['route', 'learning', 'status'], { json: true });
  assert.equal(json.code, 0, json.stdout + json.stderr);
  assert.equal(json.json.firstTry.setting, 'auto');
  const [slice] = json.json.firstTry.slices;
  assert.deepEqual([slice.sliceId, slice.mode, slice.firstTry.verified, slice.firstTry.costPerVerifiedMicroUsd, slice.control.costPerVerifiedMicroUsd], [SLICE, 'first-try', 1, 20_000, 50_000]);
});
