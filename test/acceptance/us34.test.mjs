import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { load, story } from './lib.mjs';
import { ASSUMPTIONS, SLICE, VOLUME, calibrationSigner, policy, quality, registry } from './router-fixture.mjs';

// US34: the released worker-readiness calibration was made for jev-1.13.0, the current question
// text and the current state encoder. Each of the three changes in turn. The loader refuses the
// release for the changed context, so automated routing stops (nothing is reserved or launched),
// and drift detection disables automation without touching the threshold. Automation comes back
// only with a new artifact for the new context that a reviewer released after its holdout
// (staged) evaluation: a draft, an unreviewed or an unsigned artifact does not restore it.

const C = (sliceId, probability, outcome) => ({ sliceId, probability, outcome });
const cases = (high, low, lowFailures) => [...Array.from({ length: high }, () => C(SLICE, 0.9, true)), ...Array.from({ length: low }, (_, i) => C(SLICE, 0.3, i >= lowFailures))];

story('US34', async ({ then, sandbox, evidence }) => {
  const core = await load('core');
  const evals = await load('evals');
  const { contentHash } = await load('contracts');
  const box = await sandbox();
  const signer = await calibrationSigner();
  const file = core.calibrationFileFor(box.home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(signer.release()));
  const reg = await registry();
  const budget = core.DecisionBudget.open(join(box.home, 'generation-budget.json'), { limitMicroUsd: 50_000_000 });
  const launches = [];
  const route = (context, trustedKeys = signer.trustedKeys) =>
    core.runManagedWorker({
      taskId: `task-${launches.length}-${Math.random().toString(36).slice(2, 8)}`,
      workspaceId: 'w-us34',
      killSwitchStopped: () => false,
      loadCalibration: () => core.loadCalibration({ home: box.home, trustedKeys, context }),
      route: { registry: reg, policy: policy(), volume: VOLUME, assumptions: ASSUMPTIONS, qualities: [quality('claude-opus-5', 0.92, 0.95, 0.98), quality('claude-sonnet-5', 0.91, 0.94, 0.97)] },
      budget,
      launch: async (input) => {
        launches.push(input.model);
        return { status: 'completed', requestedModel: input.model, actualModel: input.model, usage: null, costUsd: null };
      },
    });
  const now = Date.now();
  const current = core.workerCalibrationContext({ sliceId: SLICE, nowMs: now });
  const newModel = core.workerCalibrationContext({ sliceId: SLICE, nowMs: now, modelId: 'jev-1.14.0' });
  const changed = {
    model: await route(newModel),
    question: await route({ ...current, questionHash: contentHash({ questions: 'reworded' }) }),
    encoder: await route({ ...current, encoderHash: contentHash({ encoderId: 'jevris-conservative-v2' }) }),
  };
  const drift = evals.detectDrift(
    { decisionSpecId: current.decisionSpecId, calibrationId: 'cal-worker-readiness-acceptance', modelId: 'jev-1.13.0', questionHash: current.questionHash, encoderHash: current.encoderHash, policyHash: contentHash({ policy: 1 }), sliceMix: { [SLICE]: 1 }, threshold: 0.8 },
    { modelId: 'jev-1.14.0', questionHash: current.questionHash, encoderHash: current.encoderHash, policyHash: contentHash({ policy: 1 }), sliceCounts: { [SLICE]: 60 }, observedAt: new Date(now).toISOString() },
  );

  // A new artifact for jev-1.14.0: proposed from the corpus, staged on the holdout, reviewed.
  const proposed = evals.proposeCalibration({
    id: 'cal-worker-readiness-1-14', decisionSpecId: newModel.decisionSpecId, decisionSpecVersion: newModel.decisionSpecVersion,
    dataset: { id: 'synthetic-routing-corpus', version: 'v2', contentHash: `sha256:${'e'.repeat(64)}` }, questionHash: newModel.questionHash,
    model: { modelId: 'jev-1.14.0', revisionHash: newModel.modelRevisionHash }, encoderHash: newModel.encoderHash, errorBudget: 0.05,
    calibration: cases(100, 20, 10), holdout: cases(50, 10, 5), minimumSliceSamples: 30,
    issuedAt: new Date(now - 86_400_000).toISOString(), expiresAt: new Date(now + 30 * 86_400_000).toISOString(),
  });
  writeFileSync(file, JSON.stringify(proposed.proposal));
  const whileDraft = await route(newModel);
  const unapproved = evals.releaseProposal(proposed.proposal, { reviewerId: 'reviewer-acceptance', reviewedAt: new Date(now).toISOString(), approved: false }, { privateKeyPem: signer.privateKeyPem, keyId: signer.keyId });
  const released = evals.releaseProposal(proposed.proposal, { reviewerId: 'reviewer-acceptance', reviewedAt: new Date(now).toISOString(), approved: true }, { privateKeyPem: signer.privateKeyPem, keyId: signer.keyId });
  writeFileSync(file, JSON.stringify(released.artifact));
  const restored = await route(newModel);
  evidence({ changed: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.reasonCode])), drift, holdout: proposed.holdout, whileDraft: whileDraft.reasonCode, restored: restored.launched });

  await then('The mismatch disables that automated decision until a compatible artifact passes review and staged evaluation', async () => {
    assert.deepEqual(
      Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, [v.launched, v.reasonCode]])),
      { model: [false, 'CALIBRATION_MODEL_MISMATCH'], question: [false, 'CALIBRATION_QUESTION_MISMATCH'], encoder: [false, 'CALIBRATION_ENCODER_MISMATCH'] },
    );
    assert.equal((await budget.snapshot()).reservedMicroUsd, 0);
    assert.deepEqual([drift.drifted, drift.automationDisabled], [true, true]);
    assert.equal(drift.threshold, 0.8, 'drift never changes the threshold');
    assert.deepEqual(drift.kinds, ['model-drift']);
    // Staged evaluation: the proposal carries its holdout report and is a draft until reviewed.
    assert.equal(proposed.ok, true, JSON.stringify(proposed));
    assert.ok(proposed.holdout.length > 0 && proposed.holdout.every((h) => h.sliceId === SLICE));
    assert.equal(proposed.proposal.releaseState, 'draft');
    assert.equal(whileDraft.launched, false, 'a draft restored automation');
    assert.deepEqual(unapproved, { ok: false, reasonCode: 'NOT_APPROVED' });
    // Only the reviewed, signed release for the new model restores routing.
    assert.equal(released.ok, true, JSON.stringify(released));
    assert.equal(restored.launched, true, JSON.stringify(restored));
    assert.deepEqual(launches, ['claude-sonnet-5']);
  });
});
