import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { load, story } from './lib.mjs';
import { ASSUMPTIONS, SLICE, VOLUME, calibrationSigner, policy, quality, registry } from './router-fixture.mjs';

// US07: a task in a language/framework slice no evaluation covered. Bounded-auto routing is
// considered with a signed release for another slice (the conditional pair: the same release
// does select on its own slice). On the unknown slice the route abstains and the baseline stays;
// the slice is named in the route surface and in the coverage report.

const UNKNOWN = 'elixir-phoenix';

story('US07', async ({ then, sandbox, evidence }) => {
  const core = await load('core');
  const provider = await load('provider-typesafe');
  const { createDeadline } = await load('platform');
  const box = await sandbox();
  const signer = await calibrationSigner();
  const file = core.calibrationFileFor(box.home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(signer.release()));
  const budget = core.DecisionBudget.open(join(box.home, 'generation-budget.json'), { limitMicroUsd: 50_000_000 });
  const launches = [];
  const reg = await registry();
  const qualities = [quality('claude-opus-5', 0.9, 0.94, 0.97), quality('claude-sonnet-5', 0.86, 0.9, 0.94)];
  const worker = (sliceId) =>
    core.runManagedWorker({
      taskId: `task-${sliceId}`,
      workspaceId: 'w-us07',
      killSwitchStopped: () => false,
      loadCalibration: () => core.loadCalibration({ home: box.home, trustedKeys: signer.trustedKeys, context: core.workerCalibrationContext({ sliceId, nowMs: Date.now() }) }),
      route: { registry: reg, policy: policy(), volume: VOLUME, assumptions: ASSUMPTIONS, qualities },
      budget,
      launch: async (input) => {
        launches.push(input);
        return { status: 'completed', requestedModel: input.model, actualModel: input.model, usage: null, costUsd: null };
      },
    });
  const unknown = await worker(UNKNOWN);
  // Without a calibration floor the router itself keeps the baseline for the unknown slice.
  const direct = core.routeTask({ registry: reg, policy: policy(), sliceId: UNKNOWN, volume: VOLUME, assumptions: ASSUMPTIONS, qualityFloor: null, qualities });
  const known = await worker(SLICE);
  // The route surface (the sidecar's route op) for a task on the unknown slice.
  const route = provider.sidecarOps.find((def) => def.op === 'route');
  const surfaced = await route.handle({
    op: 'route', client: 'cli', scopes: ['advice'], workspace: { id: 'w-us07', root: box.work }, body: { currentModel: 'claude-opus-5', sliceId: UNKNOWN },
    home: box.home, signal: new AbortController().signal, deadline: createDeadline(2000), store: undefined, killSwitchStopped: false, engine: undefined, trace() {},
  });
  const coverage = core.sliceCoverage({ taxonomy: [SLICE], qualities, observedSlices: [SLICE, UNKNOWN], permittedSlices: [SLICE] });
  evidence({ unknown: unknown.reasonCode, direct: [direct.outcome, direct.reasonCode], worker: surfaced.body?.worker, coverage });

  await then('The route abstains or preserves the approved baseline', () => {
    assert.deepEqual([unknown.launched, unknown.reasonCode], [false, 'CALIBRATION_SLICE_NOT_PERMITTED']);
    assert.deepEqual([direct.outcome, direct.modelId, direct.reasonCode], ['keep-baseline', 'claude-opus-5-5', 'NO_CALIBRATION'], 'the registry baseline (Opus 5.5 in this story\'s registry) is kept');
    assert.equal(surfaced.ok, true, JSON.stringify(surfaced));
    assert.equal(surfaced.body.worker.outcome, 'abstain');
    assert.equal(surfaced.body.applied, false);
    // Only the evaluated slice launched (the release itself works).
    assert.equal(known.launched, true, JSON.stringify(known));
    assert.deepEqual(launches.map((l) => l.model), ['claude-sonnet-5']);
  });

  await then('the unknown slice is visible in the report', () => {
    assert.deepEqual(coverage.unknown, [UNKNOWN]);
    assert.deepEqual(coverage.evaluated, [SLICE]);
    assert.match(surfaced.body.worker.text, /calibration/i);
  });
});
