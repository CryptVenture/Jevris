// Cheaper-first routing where people look (owner decision 2026-09-30, visibility): the status,
// explain and cost-report views over the local first-try ledger. Each is table-driven over the
// states a person can be in: setting off, baseline, auto with no data, auto with slices in each
// verdict, and a harness with no first-try step. The views must agree with the router's own verdict
// and invent no figure: where the data does not exist the field is null. Temporary homes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { FirstTrySliceViewSchema, FirstTryStatusSchema, defineContract, surfacePayloadContract } from '@jevris/contracts';
import { EMPTY_FIRST_TRY_HISTORY, firstTryVerdict, learningSettings } from '@jevris/core';
import {
  attachHandOffLease,
  closeUnhandled,
  emptyFirstTryCostView,
  firstTryCostView,
  firstTryHistory,
  firstTrySliceView,
  firstTryStatusView,
  firstTryWorkspaceOf,
  keepFirstTryRoute,
  noteHandOff,
  openWorkspace,
  recordFirstTryOutcome,
  withFirstTryExplain,
} from '../dist/index.js';
import { tempDir } from './temp-dirs.mjs';

// Claude Code's baseline is Sonnet 5.5 and its first try Haiku 5.5 (owner decision 2026-10-08).
const BASE = 'claude-sonnet-5-5';
const FIRST = 'claude-haiku-5-5';
const statusContract = defineContract({ name: 'jevris-first-try-status-view', description: 'test', schema: FirstTryStatusSchema });
const sliceContract = defineContract({ name: 'jevris-first-try-slice-view', description: 'test', schema: FirstTrySliceViewSchema });

function workspace() {
  const dir = tempDir('jv-ft-view-');
  const home = join(dir, 'home');
  const root = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  return { home, root, ws: openWorkspace({ home, workspaceRoot: root }) };
}

const note = (arm, extra = {}) => ({
  firstTry: { arm, propensity: arm === 'control' ? 0.1 : 0.9, firstTryModelId: FIRST, baselineModelId: BASE, stepUpModelIds: [BASE], breakEven: 0.5, breakEvenBasis: 'estimated', overheadMicroUsd: 1000, ...extra },
});
const run = (leaseId, model, costUsd, extra = {}) => ({ leaseId, requestedModel: model, actualModel: model, costUsd, authMode: 'api-key', durationMs: 1000, ...extra });

/**
 * One task in the ledger. `outcome`: open (started), pass, fail (finished failed, no hand-off made),
 * handoff-pass (first attempt failed, handed off once, the hand-off passed). `costs` are USD per attempt.
 */
async function task(ws, id, { slice = 'issue-fix', arm = 'first-try', outcome = 'pass', costs = [0.02, 0.05], extra } = {}) {
  const model = arm === 'control' ? BASE : FIRST;
  await keepFirstTryRoute(ws, { taskId: id, sliceId: slice, run: { leaseId: `l-${id}`, requestedModel: model }, note: note(arm, extra), nowMs: 1 });
  if (outcome === 'open') return;
  if (outcome === 'pass') {
    await recordFirstTryOutcome(ws, id, 'verified-pass', { run: run(`l-${id}`, model, costs[0]), nowMs: 2 });
    return;
  }
  await recordFirstTryOutcome(ws, id, 'verified-fail', { run: run(`l-${id}`, model, costs[0]), nowMs: 2 });
  if (outcome === 'fail') {
    await closeUnhandled(ws, id, 3);
    return;
  }
  await noteHandOff(ws, id, BASE, 3);
  await attachHandOffLease(ws, id, `h-${id}`);
  await recordFirstTryOutcome(ws, id, 'verified-pass', { run: run(`h-${id}`, BASE, costs[1]), nowMs: 4 });
}

async function many(ws, prefix, n, options) {
  for (let i = 0; i < n; i += 1) await task(ws, `${prefix}${String(i)}`, options);
}

const harnessOf = (view, name) => view.harnesses.find((h) => h.harness === name);

// ------------------------------------------------------------------------------------------ status

test('status view, setting baseline: every harness is off with FIRST_TRY_OFF, whatever the ledger holds', async () => {
  const { home, ws } = workspace();
  await many(ws, 'P', 5, { outcome: 'pass' });
  const view = await firstTryStatusView({ home, ws, setting: 'baseline' });
  assert.equal(statusContract.validate(view).ok, true, JSON.stringify(statusContract.validate(view)));
  assert.equal(view.setting, 'baseline');
  assert.ok(view.harnesses.length >= 3);
  for (const h of view.harnesses) assert.deepEqual([h.state, h.reasonCode], ['off', 'FIRST_TRY_OFF'], h.harness);
  // The counts are still the ledger's, so a person can see what the setting is holding back.
  assert.deepEqual(harnessOf(view, 'claude').slices, { firstTry: 1, baselineFirst: 0, learning: 0 });
});

test('status view, auto with no data: the ladder per harness with zero slices, and Antigravity off with why', async () => {
  const { home } = workspace();
  const view = await firstTryStatusView({ home, ws: null, setting: 'auto' });
  assert.equal(statusContract.validate(view).ok, true, JSON.stringify(statusContract.validate(view)));
  assert.equal(view.unavailable, null);
  const claude = harnessOf(view, 'claude');
  assert.deepEqual([claude.state, claude.reasonCode, claude.baselineModelId, claude.firstTryModelId, claude.strongerIsPreview], ['on', null, BASE, FIRST, false]);
  const codex = harnessOf(view, 'codex');
  assert.deepEqual([codex.state, codex.firstTryModelId], ['on', 'gpt-6-luna']);
  const agy = harnessOf(view, 'antigravity');
  assert.deepEqual([agy.state, agy.reasonCode, agy.firstTryModelId, agy.strongerIsPreview], ['off', 'NO_CHEAPER_RUNG', null, true]);
  for (const h of view.harnesses) assert.deepEqual(h.slices, { firstTry: 0, baselineFirst: 0, learning: 0 }, h.harness);
  assert.deepEqual(view.other, { firstTry: 0, baselineFirst: 0, learning: 0 });
});

test('status view, auto with learned slices: each slice is counted once under its verdict, by the harness whose baseline it has', async () => {
  const { home, ws } = workspace();
  await many(ws, 'L', 2, { slice: 'learning-slice', outcome: 'pass' });
  await many(ws, 'F', 5, { slice: 'paying-slice', outcome: 'pass' });
  await many(ws, 'B', 5, { slice: 'failing-slice', outcome: 'fail' });
  await many(ws, 'G', 5, { slice: 'paying-two', outcome: 'pass' });
  const view = await firstTryStatusView({ home, ws, setting: 'auto' });
  assert.equal(statusContract.validate(view).ok, true, JSON.stringify(statusContract.validate(view)));
  assert.deepEqual(harnessOf(view, 'claude').slices, { firstTry: 2, baselineFirst: 1, learning: 1 });
  assert.deepEqual(harnessOf(view, 'codex').slices, { firstTry: 0, baselineFirst: 0, learning: 0 });
  assert.deepEqual(view.other, { firstTry: 0, baselineFirst: 0, learning: 0 });
});

test('status view: a slice whose baseline is no harness default (here Opus 5.5) is counted under other', async () => {
  const { home, ws } = workspace();
  await keepFirstTryRoute(ws, { taskId: 'Z1', sliceId: 'odd', run: { leaseId: 'l-Z1', requestedModel: 'claude-haiku-4-5-20251001' }, note: { firstTry: { arm: 'first-try', propensity: 0.9, firstTryModelId: 'claude-haiku-4-5-20251001', baselineModelId: 'claude-opus-5-5', stepUpModelIds: ['claude-opus-5-5'], breakEven: 0.3, breakEvenBasis: 'estimated', overheadMicroUsd: 0 } }, nowMs: 1 });
  const view = await firstTryStatusView({ home, ws, setting: 'auto' });
  assert.deepEqual(view.other, { firstTry: 0, baselineFirst: 0, learning: 1 });
  assert.deepEqual(harnessOf(view, 'claude').slices, { firstTry: 0, baselineFirst: 0, learning: 0 });
});

test('status view: a refused model registry reads as unavailable with its reason code, and no ladder is invented', async () => {
  const { home } = workspace();
  const { jevrisPaths } = await import('@jevris/platform');
  const { writeFileSync } = await import('node:fs');
  mkdirSync(jevrisPaths({ home }).config, { recursive: true });
  writeFileSync(join(jevrisPaths({ home }).config, 'model-registry.json'), '{ not json');
  const view = await firstTryStatusView({ home, ws: null, setting: 'auto' });
  assert.equal(statusContract.validate(view).ok, true, JSON.stringify(statusContract.validate(view)));
  assert.deepEqual([view.unavailable, view.harnesses.length], ['MODEL_REGISTRY_NOT_JSON', 0]);
});

test('firstTryWorkspaceOf: the global workspace and a workspace with no root have no ledger', () => {
  const { home, ws } = workspace();
  const ctx = (workspace) => ({ home, workspace, store: undefined });
  assert.equal(firstTryWorkspaceOf(ctx({ id: 'global', root: null })), null);
  assert.equal(firstTryWorkspaceOf(ctx({ id: ws.workspaceId, root: null })), null);
  assert.equal(firstTryWorkspaceOf(ctx({ id: ws.workspaceId, root: ws.workspaceRoot })).workspaceId, ws.workspaceId);
});

// ------------------------------------------------------------------------------------------ explain

test('slice view with no first-try task: no groups, and the setting is carried', async () => {
  const { ws } = workspace();
  for (const setting of ['auto', 'baseline']) {
    const view = await firstTrySliceView({ ws, sliceId: 'bounded-edit', setting });
    assert.equal(sliceContract.validate(view).ok, true);
    assert.deepEqual([view.sliceId, view.setting, view.groups.length], ['bounded-edit', setting, 0]);
  }
});

const verdictTable = [
  ['learning: two finished first tries', async (ws) => many(ws, 'T', 2, { outcome: 'pass' }), 'learning', 'DAY_1_PRIOR', null, 0.5 ** 3],
  ['first-try: five finished first tries that passed', async (ws) => many(ws, 'T', 5, { outcome: 'pass' }), 'first-try', 'FIRST_TRY_WORTH_IT', null, 0.5 ** 6],
  // The slice just moved: the live verdict holds it for five more finished tasks (the anti-flap floor), and the last change says why it moved.
  ['baseline-first: five finished first tries that failed', async (ws) => many(ws, 'T', 5, { outcome: 'fail' }), 'baseline-first', 'ANTI_FLAP', { mode: 'baseline', reasonCode: 'FIRST_TRY_BELOW_BREAK_EVEN', atFinished: 5 }, 1 - 0.5 ** 6],
  [
    'baseline-first: held at baseline once the floor has passed, not yet proven',
    async (ws) => many(ws, 'T', 10, { outcome: 'fail' }),
    'baseline-first',
    'BASELINE_FIRST_NOT_PROVEN',
    { mode: 'baseline', reasonCode: 'FIRST_TRY_BELOW_BREAK_EVEN', atFinished: 5 },
    1 - 0.5 ** 11,
  ],
];
for (const [name, seed, verdict, reasonCode, lastChange, pBelow] of verdictTable) {
  test(`slice view, ${name}: the verdict, reason code and the probability the router's own function gives`, async () => {
    const { ws } = workspace();
    await seed(ws);
    const view = await firstTrySliceView({ ws, sliceId: 'issue-fix', setting: 'auto' });
    assert.equal(sliceContract.validate(view).ok, true, JSON.stringify(sliceContract.validate(view)));
    const [g] = view.groups;
    assert.equal(view.groups.length, 1);
    assert.deepEqual([g.verdict, g.reasonCode, g.baselineModelId, g.firstTryModelId], [verdict, reasonCode, BASE, FIRST]);
    assert.deepEqual(g.lastChange, lastChange);
    // P(success rate < p*) under Beta(1 + pass, 1 + fail) at p* = 0.5: a closed form for these counts.
    assert.ok(Math.abs(g.pBelowBreakEven - pBelow) < 1e-9, `${String(g.pBelowBreakEven)} against ${String(pBelow)}`);
    // The same numbers the router's function reaches on the same history and settings.
    const expected = firstTryVerdict({ history: firstTryHistory(ws, { sliceId: 'issue-fix', baselineModelId: BASE, firstTryModelId: FIRST }), candidate: { breakEven: 0.5, overheadMicroUsd: 1000 }, settings: learningSettings({}) });
    assert.deepEqual([g.reasonCode, g.pBelowBreakEven, g.breakEven.value, g.breakEven.basis], [expected.reasonCode, expected.pBelowBreakEven, expected.breakEven, expected.breakEvenBasis]);
    assert.deepEqual(g.thresholds, { demoteAbove: 0.4, reinstateBelow: 0.1, minFinishedToReinstate: 12, antiFlapFloor: 5, margin: 0.075 });
  });
}

test('slice view, a slice that failed and then paid for itself comes back to first-try, and says so', async () => {
  const { ws } = workspace();
  await many(ws, 'F', 5, { outcome: 'fail' });
  await many(ws, 'P', 20, { outcome: 'pass' });
  const [g] = (await firstTrySliceView({ ws, sliceId: 'issue-fix', setting: 'auto' })).groups;
  assert.equal(g.verdict, 'first-try');
  assert.deepEqual([g.lastChange.mode, g.lastChange.reasonCode], ['first-try', 'FIRST_TRY_WORTH_IT']);
  // Coming back needs at least 12 finished first-try tasks in all (the local minimum), and five more than at the demotion (the floor).
  assert.ok(g.lastChange.atFinished >= 12 && g.lastChange.atFinished >= 5 + 5, String(g.lastChange.atFinished));
});

test('slice view: counts, the control share, the break-even inputs and cost per verified task come from the ledger', async () => {
  const { ws } = workspace();
  await task(ws, 'A1', { outcome: 'pass', costs: [0.02] });
  await task(ws, 'A2', { outcome: 'handoff-pass', costs: [0.02, 0.06] });
  await task(ws, 'A3', { outcome: 'fail', costs: [0.02] });
  await task(ws, 'A4', { outcome: 'open' });
  await task(ws, 'C1', { arm: 'control', outcome: 'pass', costs: [0.05] });
  const view = await firstTrySliceView({ ws, sliceId: 'issue-fix', setting: 'auto' });
  assert.equal(sliceContract.validate(view).ok, true, JSON.stringify(sliceContract.validate(view)));
  const [g] = view.groups;
  assert.deepEqual(g.started, { firstTry: 4, control: 1, open: 1 });
  assert.deepEqual(g.firstTry, { finished: 3, verified: 2, firstAttemptPass: 1, firstAttemptFail: 2, handedOff: 1 });
  assert.deepEqual(g.control, { finished: 1, verified: 1 });
  // One control task in five started; the slice is on first-try, so the next task is control with the cap share (the control has fewer than five finished tasks).
  assert.deepEqual(g.controlShare, { observed: 0.2, nextTaskArm: 'control', nextTaskShare: 0.1 });
  // Under five first attempts with a label the price estimate stands; the means are shown with their sample counts.
  assert.deepEqual(g.breakEven, { value: 0.5, basis: 'estimated', overheadMicroUsd: 1000, firstAttempt: { meanMicroUsd: 20_000, samples: 3 }, stepUpAttempt: { meanMicroUsd: 60_000, samples: 1 } });
  // 20k + (20k + 60k) + 20k over two verified tasks; the control's 50k over its one.
  assert.deepEqual(g.costPerVerified, { firstTryMicroUsd: 60_000, controlMicroUsd: 50_000, estimate: false });
  assert.equal(g.pWorseThanBaseline, null, 'the control has fewer than five finished tasks');
});

test('slice view: only the named slice, and one group per baseline and first-try model', async () => {
  const { ws } = workspace();
  await task(ws, 'A1', { slice: 'issue-fix' });
  await task(ws, 'B1', { slice: 'bounded-edit' });
  const view = await firstTrySliceView({ ws, sliceId: 'bounded-edit', setting: 'auto' });
  assert.equal(view.groups.length, 1);
  assert.equal(view.groups[0].started.firstTry, 1);
});

// ------------------------------------------------------------------------------------- cost report

const costTable = [
  [
    'tasks started, handed up and completed, with a control to compare against',
    async (ws) => {
      await task(ws, 'A1', { outcome: 'pass', costs: [0.02] });
      await task(ws, 'A2', { outcome: 'handoff-pass', costs: [0.02, 0.05] });
      await task(ws, 'A3', { outcome: 'fail', costs: [0.02] });
      await task(ws, 'A4', { outcome: 'open' });
      await task(ws, 'C1', { arm: 'control', outcome: 'pass', costs: [0.06] });
      await task(ws, 'C2', { arm: 'control', outcome: 'fail', costs: [0.06] });
    },
    // 20k + 70k + 20k = 110k spent; the control's 120k over its one verified task, times two verified first-try tasks.
    { started: 4, open: 1, handedUp: 1, completedOnFirstTry: 1, finished: 3, verified: 2, controlStarted: 2, controlVerified: 1, slices: 1, compared: 1, spentMicroUsd: 110_000, baselineEstimateMicroUsd: 240_000, savedMicroUsd: 130_000, estimate: false },
  ],
  [
    'spent more than the baseline estimate is a negative figure',
    async (ws) => {
      await task(ws, 'A1', { outcome: 'pass', costs: [0.1] });
      await task(ws, 'C1', { arm: 'control', outcome: 'pass', costs: [0.04] });
    },
    { started: 1, open: 0, handedUp: 0, completedOnFirstTry: 1, finished: 1, verified: 1, controlStarted: 1, controlVerified: 1, slices: 1, compared: 1, spentMicroUsd: 100_000, baselineEstimateMicroUsd: 40_000, savedMicroUsd: -60_000, estimate: false },
  ],
  [
    'no control task: the baseline estimate and the saving are unknown, never zero',
    async (ws) => {
      await task(ws, 'A1', { outcome: 'pass', costs: [0.02] });
    },
    { started: 1, open: 0, handedUp: 0, completedOnFirstTry: 1, finished: 1, verified: 1, controlStarted: 0, controlVerified: 0, slices: 1, compared: 0, spentMicroUsd: null, baselineEstimateMicroUsd: null, savedMicroUsd: null, estimate: false },
  ],
  [
    'a control with no verified task has no cost per verified task: unknown',
    async (ws) => {
      await task(ws, 'A1', { outcome: 'pass', costs: [0.02] });
      await task(ws, 'C1', { arm: 'control', outcome: 'fail', costs: [0.06] });
    },
    { started: 1, open: 0, handedUp: 0, completedOnFirstTry: 1, finished: 1, verified: 1, controlStarted: 1, controlVerified: 0, slices: 1, compared: 0, spentMicroUsd: null, baselineEstimateMicroUsd: null, savedMicroUsd: null, estimate: false },
  ],
  [
    'an attempt with no recorded cost makes the spend unknown for that slice',
    async (ws) => {
      await task(ws, 'A1', { outcome: 'pass', costs: [null] });
      await task(ws, 'C1', { arm: 'control', outcome: 'pass', costs: [0.06] });
    },
    { started: 1, open: 0, handedUp: 0, completedOnFirstTry: 1, finished: 1, verified: 1, controlStarted: 1, controlVerified: 1, slices: 1, compared: 0, spentMicroUsd: null, baselineEstimateMicroUsd: null, savedMicroUsd: null, estimate: false },
  ],
  [
    'only started tasks, none finished: counts and no figure',
    async (ws) => {
      await task(ws, 'A1', { outcome: 'open' });
    },
    { started: 1, open: 1, handedUp: 0, completedOnFirstTry: 0, finished: 0, verified: 0, controlStarted: 0, controlVerified: 0, slices: 0, compared: 0, spentMicroUsd: null, baselineEstimateMicroUsd: null, savedMicroUsd: null, estimate: false },
  ],
];
for (const [name, seed, expected] of costTable) {
  test(`cost view: ${name}`, async () => {
    const { ws } = workspace();
    await seed(ws);
    const view = await firstTryCostView({ ws, setting: 'auto' });
    const { groups, setting, ...numbers } = view;
    assert.equal(setting, 'auto');
    assert.deepEqual(numbers, expected);
    assert.ok(Object.values(numbers).every((v) => v === null || typeof v === 'boolean' || Number.isInteger(v)), 'money is integer micro-USD');
    assert.ok(groups.length <= 1);
  });
}

test('cost view: a subscription run is priced from usage at list price and labelled an estimate', async () => {
  const { ws } = workspace();
  const usage = { inputTokens: 10_000, outputTokens: 1_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  for (const [id, arm, model] of [['A1', 'first-try', FIRST], ['C1', 'control', BASE]]) {
    await keepFirstTryRoute(ws, { taskId: id, sliceId: 'issue-fix', run: { leaseId: `l-${id}`, requestedModel: model }, note: note(arm), nowMs: 1 });
    await recordFirstTryOutcome(ws, id, 'verified-pass', { run: run(`l-${id}`, model, null, { authMode: 'subscription', usage }), nowMs: 2 });
  }
  const view = await firstTryCostView({ ws, setting: 'auto' });
  assert.equal(view.estimate, true);
  assert.equal(view.compared, 1);
  assert.ok(Number.isInteger(view.spentMicroUsd) && view.spentMicroUsd > 0, String(view.spentMicroUsd));
  // The control runs the dearer model on the same usage, so the estimate is higher and the difference is a saving.
  assert.ok(view.baselineEstimateMicroUsd > view.spentMicroUsd);
  assert.equal(view.savedMicroUsd, view.baselineEstimateMicroUsd - view.spentMicroUsd);
});

test('cost view: money covers only the slices that can be compared, and says how many that is', async () => {
  const { ws } = workspace();
  await task(ws, 'A1', { slice: 'with-control', outcome: 'pass', costs: [0.02] });
  await task(ws, 'C1', { slice: 'with-control', arm: 'control', outcome: 'pass', costs: [0.05] });
  await task(ws, 'B1', { slice: 'no-control', outcome: 'pass', costs: [0.03] });
  const view = await firstTryCostView({ ws, setting: 'auto' });
  assert.deepEqual([view.slices, view.compared, view.spentMicroUsd, view.baselineEstimateMicroUsd, view.savedMicroUsd], [2, 1, 20_000, 50_000, 30_000]);
  assert.deepEqual(view.groups.map((g) => [g.sliceId, g.savedMicroUsd]), [['no-control', null], ['with-control', 30_000]]);
});

test('the empty cost view has every count zero and no figure', () => {
  const v = emptyFirstTryCostView('baseline');
  assert.deepEqual([v.setting, v.started, v.savedMicroUsd, v.groups.length], ['baseline', 0, null, 0]);
});

// ------------------------------------------------------------------------------- the explain wrapper

const traceBody = (decisionId = 'd-00000000-0000-4000-8000-000000000016') => ({
  decisionId,
  found: true,
  trace: { outcome: 'advisory', reasonCodes: ['KEEP_CURRENT'], resolvedModel: null, usage: { known: false, inputTokens: null, outputTokens: null }, uncertainty: 'No calibration applies.', policyVersion: null, applied: false, rendered: 'trace' },
});
const explainContext = (home, ws, body, root = ws.workspaceRoot) => ({
  op: 'explain', client: 'cli', scopes: ['status'], workspace: { id: ws.workspaceId, root }, body, home,
  signal: new AbortController().signal, deadline: { budgetMs: 20_000, remainingMs: () => 20_000, expired: () => false }, store: undefined, killSwitchStopped: false, engine: undefined, trace: () => undefined,
});

test('explain wrapper: with a slice the trace gains the slice view; any other request passes through unchanged', async () => {
  const { home, ws } = workspace();
  await many(ws, 'T', 5, { outcome: 'pass' });
  const original = { op: 'explain', scope: 'status', budget: 'hot', handle: async () => ({ ok: true, body: traceBody() }) };
  const wrapped = withFirstTryExplain(original, () => 'auto');
  assert.deepEqual([wrapped.op, wrapped.scope, wrapped.budget], ['explain', 'status', 'hot']);
  const withSlice = await wrapped.handle(explainContext(home, ws, { decisionId: 'd-00000000-0000-4000-8000-000000000016', sliceId: 'issue-fix' }));
  assert.equal(withSlice.ok, true);
  assert.equal(surfacePayloadContract('explain').validate(withSlice.body).ok, true);
  const view = withSlice.body.trace.firstTry;
  assert.deepEqual([view.sliceId, view.setting, view.groups[0].verdict, view.groups[0].reasonCode], ['issue-fix', 'auto', 'first-try', 'FIRST_TRY_WORTH_IT']);
  assert.deepEqual(view, await firstTrySliceView({ ws, sliceId: 'issue-fix', setting: 'auto' }));
  // The setting is read per request.
  const lowered = await withFirstTryExplain(original, () => 'baseline').handle(explainContext(home, ws, { decisionId: 'd', sliceId: 'issue-fix' }));
  assert.equal(lowered.body.trace.firstTry.setting, 'baseline');
  // Without a slice, with an invalid slice id, with no workspace root: the answer is the original, untouched.
  for (const [body, root] of [[{ decisionId: 'd' }, undefined], [{ decisionId: 'd', sliceId: '../x' }, undefined], [{ decisionId: 'd', sliceId: 'issue-fix' }, null]]) {
    const out = await wrapped.handle(explainContext(home, ws, body, root));
    assert.deepEqual(out, { ok: true, body: traceBody() }, JSON.stringify(body));
  }
});

test('explain wrapper: a refusal, a not-found decision and a body that no longer fits the contract are passed through as they came', async () => {
  const { home, ws } = workspace();
  const ctx = explainContext(home, ws, { decisionId: 'd', sliceId: 'issue-fix' });
  const refusal = { ok: false, reasonCode: 'INVALID_REQUEST' };
  assert.deepEqual(await withFirstTryExplain({ op: 'explain', scope: 'status', budget: 'hot', handle: async () => refusal }, () => 'auto').handle(ctx), refusal);
  const missing = { ok: true, body: { decisionId: 'd-00000000-0000-4000-8000-000000000016', found: false, trace: null } };
  assert.deepEqual(await withFirstTryExplain({ op: 'explain', scope: 'status', budget: 'hot', handle: async () => missing }, () => 'auto').handle(ctx), missing);
  // A trace the contract would refuse once the view is added (an unknown key stands for a body of another shape) is not made worse.
  const odd = { ok: true, body: { ...traceBody(), trace: { ...traceBody().trace, surprise: true } } };
  assert.deepEqual(await withFirstTryExplain({ op: 'explain', scope: 'status', budget: 'hot', handle: async () => odd }, () => 'auto').handle(ctx), odd);
  // An unreadable setting source is not an error the person sees.
  const broken = await withFirstTryExplain({ op: 'explain', scope: 'status', budget: 'hot', handle: async () => ({ ok: true, body: traceBody() }) }, () => {
    throw new Error('settings unreadable');
  }).handle(ctx);
  assert.deepEqual(broken, { ok: true, body: traceBody() });
});

test('the views read the ledger only: opening them again changes nothing in it', async () => {
  const { home, ws } = workspace();
  await many(ws, 'T', 3, { outcome: 'pass' });
  const before = JSON.stringify(firstTryHistory(ws, { sliceId: 'issue-fix', baselineModelId: BASE, firstTryModelId: FIRST }));
  await firstTryStatusView({ home, ws, setting: 'auto' });
  await firstTrySliceView({ ws, sliceId: 'issue-fix', setting: 'auto' });
  await firstTryCostView({ ws, setting: 'auto' });
  assert.equal(JSON.stringify(firstTryHistory(ws, { sliceId: 'issue-fix', baselineModelId: BASE, firstTryModelId: FIRST })), before);
  assert.notEqual(before, JSON.stringify(EMPTY_FIRST_TRY_HISTORY));
});
