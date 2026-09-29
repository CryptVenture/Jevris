// Serving hosts R49 (design 6.4; owner decision OQ-4): route learning keys arms per model, and the
// serving host a route ran through only prices the list-price comparison. A side whose tariff on
// the session's host is only the maker's list price as an estimate never promotes on price.
// Deterministic: bundled registry, no network, no billing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUNDLED_MODEL_REGISTRY,
  MIN_LOCAL_PER_ARM,
  apiEquivalentCostMicroUsd,
  emptyLearningState,
  generationCostMicroUsd,
  parseLearningState,
  reconcileSlice,
  recordRouteOutcome,
  registryModel,
} from '../dist/index.js';

const NOW = '2026-09-26T00:00:00Z';
const SLICE = 'bounded-edit';
const BASE = 'claude-opus-5-5';
const CAND = 'claude-sonnet-5';
const REGISTRY = BUNDLED_MODEL_REGISTRY;

let seq = 0;
function event(overrides = {}) {
  seq += 1;
  return {
    eventId: `ev-h${seq}`,
    routeId: `route-h${seq}`,
    sliceId: SLICE,
    modelId: BASE,
    rulesModelId: BASE,
    policyVersion: 0,
    kind: 'verified-pass',
    labelSource: 'verification-receipt',
    receiptId: `rcpt-h${seq}`,
    explored: false,
    propensity: 0.95,
    risk: 'low',
    costMicroUsd: null,
    latencyMs: 60_000,
    at: `2026-09-25T${String(Math.floor(seq / 3600) % 24).padStart(2, '0')}:${String(Math.floor(seq / 60) % 60).padStart(2, '0')}:${String(seq % 60).padStart(2, '0')}Z`,
    ...overrides,
  };
}

function record(state, e) {
  const r = recordRouteOutcome(state, e);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.state;
}

/** Local outcomes on both arms with no resource figures, so the list-price step decides the resource check. */
function evidence(servingHost) {
  let s = emptyLearningState({ workspaceId: 'ws-hosts', now: NOW, settings: { explorationRate: 0 } });
  const rate = { [BASE]: 0.7, [CAND]: 0.8 };
  for (const arm of [BASE, CAND]) {
    for (let i = 0; i < MIN_LOCAL_PER_ARM; i += 1) {
      s = record(s, event({ modelId: arm, explored: arm !== BASE, propensity: arm === BASE ? 0.9 : 0.05, kind: i < Math.round(MIN_LOCAL_PER_ARM * rate[arm]) ? 'verified-pass' : 'verified-fail', ...(servingHost === undefined ? {} : { servingHost }) }));
    }
  }
  return s;
}

const PRIORS = {
  releaseId: 'cal-hosts-test',
  priors: [
    { sliceId: SLICE, modelId: BASE, rate: 0.68, pseudoCount: 30, sampleSize: 30, sourceId: 'cal-hosts-test' },
    { sliceId: SLICE, modelId: CAND, rate: 0.8, pseudoCount: 30, sampleSize: 30, sourceId: 'cal-hosts-test' },
  ],
};

const reconcile = (state, extra = {}) => reconcileSlice({ state, sliceId: SLICE, baselineModelId: BASE, eligibleModelIds: [BASE, CAND], now: NOW, registry: REGISTRY, automaticAllowed: true, priors: PRIORS, ...extra });

test('R49: an outcome carries the serving host it ran through; the arm key stays per model', () => {
  let s = emptyLearningState({ workspaceId: 'ws-hosts', now: NOW });
  const r = recordRouteOutcome(s, event({ servingHost: 'openrouter' }));
  assert.equal(r.ok, true, JSON.stringify(r));
  s = r.state;
  assert.deepEqual(Object.keys(s.arms[SLICE]), [BASE], 'OQ-5: one arm per model, whatever the host');
  // The host survives a save and load.
  assert.equal(parseLearningState(JSON.parse(JSON.stringify(s))).events.at(-1).servingHost, 'openrouter');
  // A maker host is a valid host too, and an older record without one still records.
  assert.equal(recordRouteOutcome(s, event({ servingHost: 'anthropic' })).ok, true);
  assert.equal(recordRouteOutcome(s, event({})).ok, true);
  // A host that is not an id is refused, and nothing is recorded.
  for (const bad of ['', 'open router', 'a/b', 42, null]) {
    const refused = recordRouteOutcome(s, event({ servingHost: bad }));
    assert.deepEqual([refused.ok, refused.reasonCode, refused.detail], [false, 'INVALID_EVENT', 'servingHost'], String(bad));
  }
});

test('R49: the list-price comparison uses the tariffs on the session host; a maker host or none keeps the makers\' list prices', () => {
  for (const servingHost of [undefined, null, 'anthropic', 'openrouter', 'kilo']) {
    const r = reconcile(evidence(), servingHost === undefined ? {} : { servingHost });
    assert.equal(r.outcome, 'activated', `${servingHost}: ${JSON.stringify([r.outcome, r.reasonCode])}`);
    assert.equal(r.version.evidence.resourceBasis, 'list-price', String(servingHost));
    assert.equal(r.version.evidence.candidate.modelId, CAND);
  }
});

test('R49: through a host whose tariff is only the maker price as an estimate, no promotion on price (RESOURCE_UNKNOWN)', () => {
  // NVIDIA serves neither Claude model in the snapshot: both sides would be estimates.
  const nvidia = reconcile(evidence(), { servingHost: 'nvidia' });
  assert.deepEqual([nvidia.outcome, nvidia.reasonCode], ['no-change', 'RESOURCE_UNKNOWN']);
  // One side unknown is enough: OpenRouter without its Sonnet 5 tariff.
  const partial = { ...REGISTRY, servings: REGISTRY.servings.filter((s) => !(s.host === 'openrouter' && s.modelId === CAND)) };
  const one = reconcile(evidence(), { servingHost: 'openrouter', registry: partial });
  assert.deepEqual([one.outcome, one.reasonCode], ['no-change', 'RESOURCE_UNKNOWN']);
  // Two tariffs for one model on one host are not one known price either.
  const twice = REGISTRY.servings.find((s) => s.host === 'openrouter' && s.modelId === CAND);
  const doubled = { ...REGISTRY, servings: [...REGISTRY.servings, { ...twice, hostModelId: `${twice.hostModelId}-alt` }] };
  const two = reconcile(evidence(), { servingHost: 'openrouter', registry: doubled });
  assert.deepEqual([two.outcome, two.reasonCode], ['no-change', 'RESOURCE_UNKNOWN']);
});

test('R49: API-equivalent cost through a pinned host uses its snapshot tariff, else the maker\'s list price', () => {
  const volume = { inputTokens: 200_000, outputTokens: 40_000, cacheReadTokens: 100_000 };
  const maker = generationCostMicroUsd(registryModel(REGISTRY, BASE).tariff, volume);
  const served = REGISTRY.servings.find((s) => s.host === 'openrouter' && s.modelId === BASE);
  assert.equal(apiEquivalentCostMicroUsd(REGISTRY, BASE, volume), maker);
  assert.equal(apiEquivalentCostMicroUsd(REGISTRY, BASE, volume, null), maker);
  assert.equal(apiEquivalentCostMicroUsd(REGISTRY, BASE, volume, 'anthropic'), maker);
  assert.equal(apiEquivalentCostMicroUsd(REGISTRY, BASE, volume, 'openrouter'), generationCostMicroUsd(served.tariff, volume));
  // A host with no tariff for the model: the maker's price stands in.
  assert.equal(apiEquivalentCostMicroUsd(REGISTRY, BASE, volume, 'nvidia'), maker);
  // An unknown host name is not a host Jevris prices: the maker's price.
  assert.equal(apiEquivalentCostMicroUsd(REGISTRY, BASE, volume, 'mystery-host'), maker);
  assert.equal(apiEquivalentCostMicroUsd(REGISTRY, 'mystery-9', volume, 'openrouter'), null);
});
