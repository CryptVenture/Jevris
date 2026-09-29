import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { load, story } from './lib.mjs';
import { ASSUMPTIONS, SLICE, VOLUME, calibrationSigner, policy, quality, registry } from './router-fixture.mjs';

// US06: a slice with a released calibration and fresh evidence; an eligible managed worker is
// created. The released calibration is external evidence (EVL-12, RLS-11), so this is the
// conditional pair: with a signed release that applies (synthetic, signed here) the router
// selects within the quality floor, reserves the generation budget and launches; without a
// release nothing is selected, reserved or launched. The owned launch is a fake SDK session.

async function managedWorker(box, core, signer, { withRelease }) {
  const file = core.calibrationFileFor(box.home);
  mkdirSync(dirname(file), { recursive: true });
  if (withRelease) writeFileSync(file, JSON.stringify(signer.release()));
  const budget = core.DecisionBudget.open(join(box.home, 'generation-budget.json'), { limitMicroUsd: 50_000_000 });
  const launches = [];
  const result = await core.runManagedWorker({
    taskId: 'task-routine-1',
    workspaceId: 'w-us06',
    killSwitchStopped: () => false,
    loadCalibration: () => core.loadCalibration({ home: box.home, trustedKeys: signer.trustedKeys, context: core.workerCalibrationContext({ sliceId: SLICE, nowMs: Date.now() }) }),
    route: { registry: await registry(), policy: policy(), volume: VOLUME, assumptions: ASSUMPTIONS, qualities: [quality('claude-opus-5', 0.9, 0.94, 0.97), quality('claude-sonnet-5', 0.86, 0.9, 0.94), quality('claude-haiku-4-5-20251001', 0.6, 0.7, 0.8)] },
    budget,
    launch: async ({ model, maxBudgetUsd, reservationId }) => {
      launches.push({ model, maxBudgetUsd, reservationId });
      return { status: 'completed', requestedModel: model, actualModel: model, usage: { inputTokens: 1_500_000, outputTokens: 150_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, costUsd: 4.5 };
    },
  });
  return { result, launches, budget: await budget.snapshot() };
}

story('US06', async ({ then, sandbox, evidence }) => {
  const core = await load('core');
  const signer = await calibrationSigner();
  const released = await managedWorker(await sandbox(), core, signer, { withRelease: true });
  const bare = await managedWorker(await sandbox(), core, signer, { withRelease: false });
  evidence({ released: { reasonCode: released.result.selection?.reasonCode, model: released.result.selection?.modelId, reserved: released.result.reservedMicroUsd }, bare: bare.result.reasonCode });

  await then('The selected profile meets the quality floor, has a reservation, and retains the mandatory verification plan', () => {
    const { result } = released;
    assert.equal(result.launched, true, JSON.stringify(result));
    // Quality floor: the released threshold (0.8) against the chosen model's lower bound.
    assert.equal(result.selection.modelId, 'claude-sonnet-5');
    const chosen = result.selection.scored.find((c) => c.modelId === result.selection.modelId);
    assert.ok(chosen.quality.lower >= 0.8, `quality ${chosen.quality.lower} is below the floor`);
    assert.ok(result.selection.eliminated.some((e) => e.modelId === 'claude-haiku-4-5-20251001' && e.gate === 'below-quality-floor'));
    // Reservation: made before the launch, and the launch runs under it.
    assert.ok(result.reservedMicroUsd > 0);
    assert.deepEqual(released.launches.map((l) => l.reservationId), [result.reservationId]);
    assert.equal(released.budget.committedMicroUsd, result.settledMicroUsd, 'the reservation settled from reported usage');
    // Verification: every candidate is priced with the mandatory verification cost; a cheaper
    // model never wins by dropping it.
    // (It grows with expected retries: each retry is verified again.)
  for (const candidate of result.selection.scored) assert.ok(candidate.breakdown.verification >= ASSUMPTIONS.verificationMicroUsd, JSON.stringify(candidate.breakdown));
    // The other half of the pair: no release, no selection, no reservation, no launch.
    assert.deepEqual([bare.result.launched, bare.result.reasonCode], [false, 'CALIBRATION_NO_RELEASE']);
    assert.deepEqual(bare.launches, []);
    assert.equal(bare.budget.reservedMicroUsd + bare.budget.committedMicroUsd, 0);
  });
});
