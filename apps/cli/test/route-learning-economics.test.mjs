// §22.2 economics in use (owner 827fc87) through the built CLI: `jevris route learning status`
// reports, per slice and arm, the cost and wall time per verified task against the approved
// default (C's sliceEconomics), in its text and in its JSON. Temporary HOME, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from '../../../test/acceptance/lib.mjs';

const core = await import('@jevris/core');
const { workspaceIdFor } = await import('../dist/public/context.js');

const SLICE = 'bounded-edit';
const BASE = 'claude-opus-5-5';
const CAND = 'claude-sonnet-5';

test('route learning status reports cost and wall time per verified task for each arm against the default (§22.2 in use)', async (t) => {
  const box = await sandbox(t);
  box.write('work/src/a.js', 'export const a = 1;\n');
  box.gitInit();
  const workspaceId = workspaceIdFor(box.work);
  let state = core.emptyLearningState({ workspaceId, now: '2026-09-26T00:00:00Z' });
  let seq = 0;
  const record = (overrides) => {
    seq += 1;
    const r = core.recordRouteOutcome(state, {
      eventId: `ev-${seq}`, routeId: `route-${seq}`, sliceId: SLICE, modelId: BASE, rulesModelId: BASE, policyVersion: 0,
      kind: 'verified-pass', labelSource: 'verification-receipt', receiptId: `rc-${seq}`, explored: false, propensity: 0.95, risk: 'low',
      costMicroUsd: 2_000_000, latencyMs: 60_000, at: `2026-09-26T00:00:${String(seq).padStart(2, '0')}Z`, authMode: 'api-key', ...overrides,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    state = r.state;
  };
  // The default: 3 of 4 verified at $2 and 60 s a route. Sonnet 5 on a subscription: 1 of 2, the API-equivalent estimate.
  for (const kind of ['verified-pass', 'verified-pass', 'verified-pass', 'verified-fail']) record({ kind });
  record({ modelId: CAND, costMicroUsd: null, apiEquivalentMicroUsd: 400_000, tokens: 800_000, latencyMs: 30_000, authMode: 'subscription', explored: true, propensity: 0.05 });
  record({ modelId: CAND, kind: 'verified-fail', costMicroUsd: null, apiEquivalentMicroUsd: 600_000, tokens: 1_200_000, latencyMs: 20_000, authMode: 'subscription', explored: true, propensity: 0.05 });
  assert.deepEqual(await core.saveLearningState(box.home, state), { ok: true });

  const text = box.jevris(['route', 'learning', 'status']);
  assert.equal(text.code, 0, text.stdout + text.stderr);
  assert.match(text.stdout, /^Per verified task claude-opus-5-5: \$2\.6667 billed, 1\.3 min wall time, 3 verified over 4 routes \(the default\)\.$/m);
  assert.match(text.stdout, /^Per verified task claude-sonnet-5: \$1\.0000 API-equivalent, 2000000 tokens, 0\.8 min wall time, 1 verified over 2 routes \(vs claude-opus-5-5: cost 0\.38x, usage n\/a, time 0\.63x\)\.$/m);

  const json = box.jevris(['route', 'learning', 'status'], { json: true });
  assert.equal(json.code, 0, json.stdout + json.stderr);
  const slice = json.json.slices.find((s) => s.sliceId === SLICE);
  assert.ok(slice.lines.some((l) => l.startsWith('Per verified task claude-sonnet-5:')));
  assert.equal(slice.economics.defaultArmId, BASE);
  assert.deepEqual(slice.economics.arms.map((a) => [a.armId, a.verified, a.apiEquivalentPerVerifiedMicroUsd, a.wallMsPerVerified, a.costRatioVsDefault]), [[BASE, 3, 2_666_667, 80_000, 1], [CAND, 1, 1_000_000, 50_000, 0.375]]);
});

test('route learning status names the local-evidence guard: how many more local outcomes each arm needs before any switch', async (t) => {
  const box = await sandbox(t);
  box.write('work/src/a.js', 'export const a = 1;\n');
  box.gitInit();
  const workspaceId = workspaceIdFor(box.work);
  let state = core.emptyLearningState({ workspaceId, now: '2026-09-26T00:00:00Z' });
  for (let i = 1; i <= 5; i += 1) {
    const r = core.recordRouteOutcome(state, {
      eventId: `ev-${i}`, routeId: `route-${i}`, sliceId: SLICE, modelId: BASE, rulesModelId: BASE, policyVersion: 0,
      kind: 'verified-pass', labelSource: 'verification-receipt', receiptId: `rc-${i}`, explored: false, propensity: 0.9, risk: 'low',
      costMicroUsd: 2_000_000, latencyMs: 60_000, at: `2026-09-26T00:00:0${String(i)}Z`, authMode: 'api-key',
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    state = r.state;
  }
  assert.deepEqual(await core.saveLearningState(box.home, state), { ok: true });
  const remaining = core.MIN_LOCAL_PER_ARM - 5;
  const text = box.jevris(['route', 'learning', 'status']);
  assert.equal(text.code, 0, text.stdout + text.stderr);
  assert.match(text.stdout, new RegExp(`^Waiting for ${String(remaining)} more local outcomes on claude-opus-5-5 \\(the default\\) before any switch\\.$`, 'm'));
  const json = box.jevris(['route', 'learning', 'status'], { json: true });
  const slice = json.json.slices.find((s) => s.sliceId === SLICE);
  assert.deepEqual(slice.guard, { minLocalPerArm: core.MIN_LOCAL_PER_ARM, waiting: [{ armId: BASE, local: 5, remaining }] });
});
