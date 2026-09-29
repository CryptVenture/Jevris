// DOMAINS 9d6a66d: route learning reads the loaded registry (a placed override or an admitted
// entry), not the bundled one. A model the bundled registry does not hold keeps its default
// effort as its default arm, from the recorded outcome through exploration, the released
// qualities and explain. Deterministic: a temporary HOME, no network, no billing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUNDLED_MODEL_REGISTRY,
  armKey,
  armLabel,
  defaultEffortOf,
  explainSliceLearning,
  explorationChoice,
  learnFromOutcome,
  loadLearningState,
  pinSlice,
  emptyLearningState,
  releasedQualities,
  validateModelRegistry,
} from '../dist/index.js';

const SLICE = 'bounded-edit';
const BASE = 'claude-opus-5-5';
const EXTRA = 'claude-test-9';
const NOW = '2026-09-26T12:00:00Z';

/** The bundled registry plus one model it does not hold, with `medium` as its default effort. */
function loadedRegistry() {
  const sonnet = BUNDLED_MODEL_REGISTRY.entries.find((e) => e.modelId === 'claude-sonnet-5');
  const extra = { ...sonnet, modelId: EXTRA, displayName: 'Test 9', defaultEffort: 'medium' };
  const checked = validateModelRegistry({ ...BUNDLED_MODEL_REGISTRY, snapshotId: 'admin-2026-09-27', entries: [...BUNDLED_MODEL_REGISTRY.entries, extra] });
  assert.equal(checked.ok, true, JSON.stringify(checked));
  return checked.registry;
}

test('DOMAINS 9d6a66d: arm keys, labels and pins read the loaded registry for a model the bundled one does not hold', () => {
  const registry = loadedRegistry();
  assert.equal(defaultEffortOf(EXTRA), null, 'the bundled registry does not know the model');
  assert.equal(defaultEffortOf(EXTRA, registry), 'medium');
  assert.equal(armKey(EXTRA, 'medium'), `${EXTRA}@medium`);
  assert.equal(armKey(EXTRA, 'medium', registry), EXTRA, 'its default effort is its default arm');
  assert.equal(armKey(EXTRA, 'high', registry), `${EXTRA}@high`);
  assert.equal(armLabel(EXTRA, 'medium', registry), EXTRA);
  const state = emptyLearningState({ workspaceId: 'ws-loaded', now: NOW });
  const pinned = pinSlice(state, SLICE, EXTRA, NOW, 'medium', registry);
  const policy = pinned.versions.at(-1).slices[SLICE];
  assert.deepEqual([policy.modelId, policy.effort], [EXTRA, undefined], 'a pin at the default effort names the bare model');
});

test('DOMAINS 9d6a66d: an outcome at the loaded default effort is recorded on the default arm; exploration and released qualities agree', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'jevris-loaded-registry-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const registry = loadedRegistry();
  const event = {
    eventId: 'ev-1', routeId: 'route-1', sliceId: SLICE, modelId: EXTRA, rulesModelId: BASE, policyVersion: 0, kind: 'verified-pass',
    labelSource: 'verification-receipt', receiptId: 'rcpt-1', explored: false, propensity: 0.95, risk: 'low', costMicroUsd: 1_000_000,
    latencyMs: 60_000, at: '2026-09-26T00:00:01Z', authMode: 'api-key', effort: 'medium',
  };
  const learned = await learnFromOutcome({ home, workspaceId: 'ws-loaded', event, baselineModelId: BASE, eligibleModelIds: [BASE, EXTRA], now: NOW, registry });
  assert.equal(learned.recorded, true, JSON.stringify(learned));
  const state = await loadLearningState({ home, workspaceId: 'ws-loaded' });
  assert.deepEqual(Object.keys(state.arms[SLICE]).sort(), [EXTRA], 'one arm: the bare model, not model@medium');
  assert.equal(state.events[0].effort, undefined);
  // Exploration names the model's default arm the same way.
  const choice = explorationChoice({ state, sliceId: SLICE, defaultModelId: EXTRA, defaultEffort: 'medium', eligibleModelIds: [EXTRA], random: () => 0.99, registry, nowMs: Date.parse(NOW) });
  assert.equal(choice.modelId, EXTRA);
  // A release quality measured at the loaded default effort is the model's default-effort quality.
  const artifact = { id: 'cal-x', modelQualities: [{ modelId: EXTRA, sliceId: SLICE, effort: 'medium', lower: 0.8, point: 0.85, upper: 0.9, sampleSize: 40 }] };
  assert.deepEqual(releasedQualities(artifact, SLICE).map((q) => q.modelId), [], 'bundled: medium is not its default');
  assert.deepEqual(releasedQualities(artifact, SLICE, registry).map((q) => q.modelId), [EXTRA]);
  // Explain labels it, and falls back to the loaded registry's baseline.
  const x = explainSliceLearning(state, SLICE, undefined, { registry });
  assert.ok(x.lines.some((line) => line.startsWith(`Local ${EXTRA}:`)), JSON.stringify(x.lines));
});
