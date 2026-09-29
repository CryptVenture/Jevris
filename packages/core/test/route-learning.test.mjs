// Route learning in use (C16, C52, SSOT §18.5), baseline first: day-1 routing from the signed
// baseline's priors alone, a per-workspace Beta posterior that every deterministic outcome
// updates, activation on the posterior criterion, fast demotion, human pins and `off` winning,
// versioned and reversible policy, capped weighted exploration, and a compact aggregate that
// outlives the 30-day raw window. Deterministic: seeded random, no network, no billing, a
// temporary HOME.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  BUNDLED_MODEL_REGISTRY,
  BUNDLED_PUBLIC_PRIORS,
  DEFAULT_LEARNING_SETTINGS,
  LABEL_SOURCE_OF,
  LEARNING_LIMITS,
  OUTCOME_KINDS,
  OWNER_LOCKED_LEARNING_THRESHOLDS,
  MACHINE_PRIOR_WEIGHT,
  DecisionBudget,
  EFFORT_LEVELS,
  acceptProposal,
  armKey,
  armPosterior,
  realizedEconomics,
  sliceEconomics,
  ECONOMICS_MIN_VERIFIED,
  MIN_LOCAL_PER_ARM,
  localEvidenceShortfall,
  armTransitionCostMicroUsd,
  parseArmKey,
  automaticPromotionReady,
  baselinePriorsFromRelease,
  betaCdf,
  betaQuantile,
  emptyLearningState,
  explainSliceLearning,
  explorationChoice,
  harmProbability,
  learnFromOutcome,
  learnedQualities,
  learningSettings,
  learningStateFile,
  loadLearningState,
  newcombeDifference,
  pinSlice,
  parseLearningState,
  reconcileLearning,
  reconcileSlice,
  recordRouteOutcome,
  rejectProposal,
  releasedQualities,
  requiredPerArm,
  resetLearning,
  rollbackLearning,
  routeLabels,
  rulesAttribution,
  runManagedWorker,
  saveLearningState,
  sliceEvidence,
  slicePolicy,
  unpinSlice,
  usageLimitStatus,
  wilsonInterval,
} from '../dist/index.js';

const NOW = '2026-09-26T00:00:00Z';
/** Registry checks (lifecycle, prices) run at the test's time, never the real clock: a bundled model's retirement date must not change a result. */
const NOW_MS = Date.parse(NOW);
const SLICE = 'bounded-edit';
// Opus 5.5 is the registry baseline; Sonnet 5 is cheaper at list price.
const BASE = 'claude-opus-5-5';
const CAND = 'claude-sonnet-5';
const ELIGIBLE = [BASE, CAND];
const REGISTRY = BUNDLED_MODEL_REGISTRY;

/** A signed baseline's priors: `supported` shows Sonnet 5 ahead (day-1 active), otherwise behind (advise). */
function baseline({ base = 0.68, cand = 0.8, n = 30 } = {}) {
  return {
    releaseId: 'cal-baseline-test',
    priors: [
      { sliceId: SLICE, modelId: BASE, rate: base, pseudoCount: n, sampleSize: n, sourceId: 'cal-baseline-test' },
      { sliceId: SLICE, modelId: CAND, rate: cand, pseudoCount: n, sampleSize: n, sourceId: 'cal-baseline-test' },
    ],
  };
}
const SUPPORTED = baseline();
const UNSUPPORTED = baseline({ base: 0.684, cand: 0.643 });

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let seq = 0;
function event(overrides = {}) {
  seq += 1;
  const verified = overrides.kind === undefined || overrides.kind.startsWith('verified');
  return {
    eventId: `ev-${seq}`,
    routeId: `route-${seq}`,
    sliceId: SLICE,
    modelId: BASE,
    rulesModelId: BASE,
    policyVersion: 0,
    kind: 'verified-pass',
    labelSource: 'verification-receipt',
    receiptId: verified ? `rcpt-${seq}` : null,
    explored: false,
    propensity: 0.95,
    risk: 'low',
    costMicroUsd: 2_000_000,
    latencyMs: 60_000,
    at: `2026-09-26T${String(Math.floor(seq / 3600) % 24).padStart(2, '0')}:${String(Math.floor(seq / 60) % 60).padStart(2, '0')}:${String(seq % 60).padStart(2, '0')}Z`,
    ...overrides,
  };
}

function record(state, e) {
  const r = recordRouteOutcome(state, e);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.state;
}

/**
 * The local-evidence guard (DOMAINS 223a21f): this workspace's own randomized outcomes on each arm,
 * `MIN_LOCAL_PER_ARM` of them at about the priors' rates, so a supported slice may switch.
 */
function localEvents(arms = [BASE, CAND], n = MIN_LOCAL_PER_ARM, { resources = true, rates = {} } = {}) {
  // Recorded the day before NOW, so a switch at NOW starts its demotion window and flap floor after them.
  const at = () => `2026-09-25T${String(Math.floor(seq / 3600) % 24).padStart(2, '0')}:${String(Math.floor(seq / 60) % 60).padStart(2, '0')}:${String(seq % 60).padStart(2, '0')}Z`;
  const rate = { [BASE]: 0.7, [CAND]: 0.8, [`${BASE}@low`]: 0.8, [`${BASE}@high`]: 0.85, ...rates };
  const cost = { [BASE]: 2_000_000, [CAND]: 1_000_000, [`${BASE}@low`]: 1_000_000, [`${BASE}@high`]: 3_000_000 };
  const out = [];
  for (const arm of arms) {
    const [modelId, effort] = arm.split('@');
    for (let i = 0; i < n; i += 1) {
      out.push(event({ at: at(), modelId, ...(effort === undefined ? {} : { effort }), explored: arm !== BASE, propensity: arm === BASE ? 0.9 : 0.05, kind: i < Math.round(n * rate[arm]) ? 'verified-pass' : 'verified-fail', costMicroUsd: resources ? cost[arm] : null }));
    }
  }
  return out;
}

/**
 * The local-evidence guard (DOMAINS 223a21f): this workspace's own randomized outcomes on each arm,
 * `MIN_LOCAL_PER_ARM` of them at about the priors' rates, so a supported slice may switch.
 */
function localEvidence(state, arms = [BASE, CAND], n = MIN_LOCAL_PER_ARM, options = {}) {
  return localEvents(arms, n, options).reduce((s, e) => record(s, e), state);
}

/** Outcomes for both arms: each verified with its own probability and cost. */
function simulate(state, { n, base = 0.8, cand = 0.8, baseCost = 2_000_000, candCost = 1_000_000, seed = 1, at, baseTokens, candTokens, baseLatency = 60_000, candLatency = 60_000, authMode } = {}) {
  const random = mulberry(seed);
  let s = state;
  for (let i = 0; i < n; i += 1) {
    for (const [modelId, p, cost, explored, tokens, latencyMs] of [[BASE, base, baseCost, false, baseTokens, baseLatency], [CAND, cand, candCost, true, candTokens, candLatency]]) {
      const pass = random() < p;
      s = record(s, event({ modelId, explored, propensity: explored ? 0.05 : 0.95, kind: pass ? 'verified-pass' : 'verified-fail', costMicroUsd: cost, latencyMs, ...(tokens === undefined ? {} : { tokens }), ...(authMode === undefined ? {} : { authMode }), ...(at === undefined ? {} : { at }) }));
    }
  }
  return s;
}

const reconcile = (state, extra = {}) => reconcileSlice({ state, sliceId: SLICE, baselineModelId: BASE, eligibleModelIds: ELIGIBLE, now: NOW, registry: REGISTRY, automaticAllowed: true, ...extra });

test('R9 (OD-5): usage is compared only within one vendor\'s pool; across vendors, API-equivalent dollars, labelled an estimate', async () => {
  const { resourceObjective } = await import('../dist/index.js');
  assert.deepEqual(resourceObjective('subscription', 'gpt-6-luna', BASE, REGISTRY), { objective: 'api-key', crossVendor: true });
  assert.deepEqual(resourceObjective('unknown', 'gemini-3.8-flash', BASE, REGISTRY), { objective: 'api-key', crossVendor: true });
  assert.deepEqual(resourceObjective('subscription', CAND, BASE, REGISTRY), { objective: 'subscription', crossVendor: false });
  assert.deepEqual(resourceObjective('api-key', 'gpt-6-luna', BASE, REGISTRY), { objective: 'api-key', crossVendor: false });
  assert.deepEqual(resourceObjective('subscription', 'mystery-9', BASE, REGISTRY), { objective: 'subscription', crossVendor: false });
  // The same simulated arms, with the candidate registered under another vendor.
  const other = { ...REGISTRY, entries: REGISTRY.entries.map((e) => (e.modelId === CAND ? { ...e, provider: 'openai' } : e)) };
  // Fewer plan tokens but more dollars: within one vendor it saves usage; across vendors the dollars decide.
  const s = simulate(emptyLearningState({ workspaceId: 'ws-1', now: NOW }), { n: 200, seed: 3, baseCost: 1_000_000, candCost: 2_000_000, baseTokens: 3_000_000, candTokens: 1_000_000 });
  assert.equal(reconcile(s, { authMode: 'subscription' }).outcome, 'activated');
  const cross = reconcile(s, { authMode: 'subscription', registry: other });
  assert.deepEqual([cross.outcome, cross.reasonCode, cross.evidence.objective, cross.evidence.crossVendor], ['no-change', 'NOT_CHEAPER_PER_VERIFIED', 'api-key', true]);
  // Fewer dollars but more plan tokens: across vendors it is taken, and explain says it is an estimate.
  const t = simulate(emptyLearningState({ workspaceId: 'ws-1', now: NOW }), { n: 200, seed: 3, baseCost: 2_000_000, candCost: 1_000_000, baseTokens: 1_000_000, candTokens: 3_000_000 });
  assert.equal(reconcile(t, { authMode: 'subscription' }).reasonCode, 'MORE_USAGE_PER_VERIFIED');
  const taken = reconcile(t, { authMode: 'subscription', registry: other });
  assert.deepEqual([taken.outcome, taken.version.evidence.objective, taken.version.evidence.crossVendor], ['activated', 'api-key', true]);
  assert.match(explainSliceLearning(taken.state, SLICE, { registry: other }).lines.join('\n'), /Resource check for v1: API-equivalent dollars, an estimate \(the models are from different vendors/);
});

test('C16: labels are deterministic outcomes only; a model judgement, a missing receipt or a mismatched source is refused', () => {
  const s = emptyLearningState({ workspaceId: 'ws-1', now: NOW });
  assert.deepEqual(recordRouteOutcome(s, event({ labelSource: 'model-judgement' })), { ok: false, reasonCode: 'LABEL_NOT_DETERMINISTIC', detail: 'model-judgement' });
  assert.equal(recordRouteOutcome(s, event({ kind: 'reverted', labelSource: 'verification-receipt' })).reasonCode, 'LABEL_NOT_DETERMINISTIC');
  assert.equal(recordRouteOutcome(s, event({ receiptId: null })).reasonCode, 'RECEIPT_MISSING');
  assert.equal(recordRouteOutcome(s, event({ explored: true, propensity: null })).reasonCode, 'INVALID_EVENT');
  assert.equal(recordRouteOutcome(s, event({ sliceId: '../etc' })).reasonCode, 'INVALID_EVENT');
  const e = event();
  const s1 = record(s, e);
  assert.equal(recordRouteOutcome(s1, e).reasonCode, 'DUPLICATE_EVENT');
  // Only the known fields are stored: no workspace text reaches the state.
  const s2 = record(s, event({ prompt: 'refactor the secret module with token sk-live-123' }));
  assert.equal(JSON.stringify(s2).includes('sk-live'), false);
  assert.equal(JSON.stringify(s2).includes('prompt'), false);
});

test('C16: a revert or retry turns an earlier pass into a failure in the aggregate; stale and cancelled routes are counted but never labelled', () => {
  let s = emptyLearningState({ workspaceId: 'ws-1', now: NOW });
  s = record(s, event({ routeId: 'r-a' }));
  assert.deepEqual([s.arms[SLICE][BASE].successes, s.arms[SLICE][BASE].failures], [1, 0]);
  s = record(s, event({ routeId: 'r-a', kind: 'reverted', labelSource: 'revert', receiptId: null }));
  assert.deepEqual([s.arms[SLICE][BASE].successes, s.arms[SLICE][BASE].failures, s.arms[SLICE][BASE].routes], [0, 1, 1]);
  s = record(s, event({ routeId: 'r-b' }));
  s = record(s, event({ routeId: 'r-b', kind: 'retried', labelSource: 'retry', receiptId: null }));
  s = record(s, event({ routeId: 'r-c' }));
  s = record(s, event({ routeId: 'r-d', kind: 'stale', labelSource: 'stale-result', receiptId: null }));
  s = record(s, event({ routeId: 'r-e', kind: 'cancelled', labelSource: 'cancellation', receiptId: null }));
  const labels = Object.fromEntries(routeLabels(s.events).map((l) => [l.routeId, l.label]));
  assert.deepEqual(labels, { 'r-a': 'failure', 'r-b': 'failure', 'r-c': 'success', 'r-d': 'unlabelled', 'r-e': 'unlabelled' });
  const arm = sliceEvidence(s, SLICE).find((a) => a.modelId === BASE);
  assert.deepEqual([arm.labelled, arm.successes, arm.staleOrCancelled], [3, 1, 2]);
  // The two-event routes cost the sum of their events.
  assert.equal(s.arms[SLICE][BASE].costSumMicroUsd, 7 * 2_000_000);
  assert.equal(s.arms[SLICE][BASE].costCount, 5);
});

test('C16 P2: a revert or retry overturns a pass only within 30 days of that pass (SPEC §18.5); a revert or retry of an unknown route is refused', () => {
  const day = (n) => new Date(NOW_MS + n * 86_400_000).toISOString(); // pinned-clock: offsets from the test's fixed time
  let s = emptyLearningState({ workspaceId: 'ws-1', now: NOW });
  s = record(s, event({ routeId: 'r-late', at: day(0) }));
  s = record(s, event({ routeId: 'r-in', at: day(1) }));
  // r-late's first event is 30.5 days back: its pass stands, and the counts do not move.
  for (const [kind, labelSource] of [['retried', 'retry'], ['reverted', 'revert']]) {
    const late = recordRouteOutcome(s, event({ routeId: 'r-late', kind, labelSource, receiptId: null, at: day(30.5) }));
    assert.deepEqual([late.ok, late.reasonCode, late.detail], [false, 'EVENT_EXPIRED', 'relabel-window'], kind);
  }
  // Day 30 from r-in's first event: still inside the window, so the pass becomes a failure.
  s = record(s, event({ routeId: 'r-in', kind: 'reverted', labelSource: 'revert', receiptId: null, costMicroUsd: null, latencyMs: null, at: day(31) }));
  assert.deepEqual([s.arms[SLICE][BASE].successes, s.arms[SLICE][BASE].failures, s.arms[SLICE][BASE].routes], [1, 1, 2]);
  assert.deepEqual(Object.fromEntries(routeLabels(s.events).map((l) => [l.routeId, l.label])), { 'r-in': 'failure' }, 'r-late left the 30-day window');
  // A revert of a route this state does not hold (never recorded, or pruned) is refused, so no success stays counted beside it.
  assert.deepEqual(recordRouteOutcome(s, event({ routeId: 'r-none', kind: 'reverted', labelSource: 'revert', receiptId: null, at: day(31) })), { ok: false, reasonCode: 'ROUTE_UNKNOWN' });
  // So is a retry that would be a route's only event: a failed run is labelled run-incomplete first (D 5dd03d0).
  assert.deepEqual(recordRouteOutcome(s, event({ routeId: 'r-retry', kind: 'retried', labelSource: 'retry', receiptId: null, at: day(31) })), { ok: false, reasonCode: 'ROUTE_UNKNOWN' });
  // A later pass never overturns a failure.
  s = record(s, event({ routeId: 'r-in', at: day(31) }));
  assert.equal(routeLabels(s.events).find((l) => l.routeId === 'r-in').label, 'failure');
  // The window runs from the pass, not from an earlier unlabelled event of the same route.
  let t2 = emptyLearningState({ workspaceId: 'ws-1', now: NOW });
  t2 = record(t2, event({ routeId: 'r-stale', kind: 'stale', labelSource: 'stale-result', receiptId: null, at: day(0) }));
  t2 = record(t2, event({ routeId: 'r-stale', at: day(10) }));
  t2 = record(t2, event({ routeId: 'r-stale', kind: 'retried', labelSource: 'retry', receiptId: null, costMicroUsd: null, latencyMs: null, at: day(35) }));
  assert.equal(routeLabels(t2.events).find((l) => l.routeId === 'r-stale').label, 'failure');
});

test('C16 P2: an owned run that ended without a receipt is a failure (run-incomplete), with its cost counted once', () => {
  assert.ok(OUTCOME_KINDS.includes('run-incomplete'));
  assert.equal(LABEL_SOURCE_OF['run-incomplete'], 'run-incomplete');
  let s = emptyLearningState({ workspaceId: 'ws-1', now: NOW });
  s = record(s, event({ routeId: 'r-inc', kind: 'run-incomplete', labelSource: 'run-incomplete', receiptId: null, costMicroUsd: 700_000 }));
  // The escalation that follows is a retry with no new spend on this route.
  s = record(s, event({ routeId: 'r-inc', kind: 'retried', labelSource: 'retry', receiptId: null, costMicroUsd: null, latencyMs: null }));
  const label = routeLabels(s.events).find((l) => l.routeId === 'r-inc');
  assert.deepEqual([label.label, label.costMicroUsd], ['failure', 700_000]);
  assert.deepEqual([s.arms[SLICE][BASE].successes, s.arms[SLICE][BASE].failures, s.arms[SLICE][BASE].routes], [0, 1, 1]);
  // A receipt is never part of it, and it cannot borrow another kind's source.
  assert.equal(recordRouteOutcome(s, event({ kind: 'run-incomplete', labelSource: 'retry', receiptId: null })).reasonCode, 'LABEL_NOT_DETERMINISTIC');
  assert.equal(recordRouteOutcome(s, event({ kind: 'verified-fail', labelSource: 'run-incomplete' })).reasonCode, 'LABEL_NOT_DETERMINISTIC');
});

test('C16 P2: every outcome kind has exactly one deterministic label source, exported for the producer', () => {
  assert.deepEqual(Object.keys(LABEL_SOURCE_OF).sort(), [...OUTCOME_KINDS].sort());
  assert.ok(Object.isFrozen(LABEL_SOURCE_OF));
  const s = emptyLearningState({ workspaceId: 'ws-1', now: NOW });
  for (const kind of OUTCOME_KINDS) {
    const verified = kind.startsWith('verified');
    const other = Object.values(LABEL_SOURCE_OF).find((source) => source !== LABEL_SOURCE_OF[kind]);
    assert.equal(recordRouteOutcome(s, event({ kind, labelSource: LABEL_SOURCE_OF[kind], receiptId: verified ? 'rcpt-x' : null })).ok, kind !== 'reverted' && kind !== 'retried', kind);
    assert.equal(recordRouteOutcome(s, event({ kind, labelSource: other, receiptId: verified ? 'rcpt-x' : null })).reasonCode, 'LABEL_NOT_DETERMINISTIC', kind);
  }
});

test('C16 guard: a signed baseline alone never switches a slice; it switches once both arms have the locked minimum of local randomized outcomes; an unsupported one stays advise', () => {
  const fresh = emptyLearningState({ workspaceId: 'ws-1', now: NOW });
  // The baseline supports Sonnet 5, but no local outcome exists yet: no switch (DOMAINS 223a21f).
  const day1 = reconcile(fresh, { priors: SUPPORTED });
  assert.deepEqual([day1.outcome, day1.reasonCode], ['no-change', 'LOCAL_EVIDENCE_SHORT']);
  assert.ok(day1.evidence.harmProbability < 0.1, 'the posterior supports it; only the guard holds it');
  assert.deepEqual(day1.waitingFor, [{ armId: BASE, local: 0, remaining: MIN_LOCAL_PER_ARM }, { armId: CAND, local: 0, remaining: MIN_LOCAL_PER_ARM }]);
  assert.deepEqual(day1.state.baseline[SLICE], SUPPORTED, 'the signed priors are snapshotted for the write side');
  assert.equal(slicePolicy(day1.state, SLICE).mode, 'advise');
  // One short of the minimum on the candidate still holds; the minimum on both switches.
  const almost = localEvidence(localEvidence(fresh, [BASE]), [CAND], MIN_LOCAL_PER_ARM - 1);
  const held = reconcile(almost, { priors: SUPPORTED });
  assert.deepEqual([held.reasonCode, held.waitingFor], ['LOCAL_EVIDENCE_SHORT', [{ armId: CAND, local: MIN_LOCAL_PER_ARM - 1, remaining: 1 }]]);
  const both = localEvidence(fresh);
  assert.deepEqual(localEvidenceShortfall(both, SLICE, CAND, BASE), []);
  const switched = reconcile(both, { priors: SUPPORTED });
  assert.equal(switched.outcome, 'activated', JSON.stringify(switched.evidence ?? switched));
  assert.deepEqual([switched.version.version, switched.version.reason, switched.version.reasonCode], [1, 'promotion', 'POSTERIOR_NON_INFERIOR']);
  assert.deepEqual(slicePolicy(switched.state, SLICE), { mode: 'auto', modelId: CAND, baselineModelId: BASE, baselineRate: switched.version.evidence.baselinePosterior.mean });
  // Only randomized outcomes count: high-risk (or unlogged) routes give no propensity and no guard credit.
  let unlogged = fresh;
  for (const modelId of [BASE, CAND]) for (let i = 0; i < MIN_LOCAL_PER_ARM; i += 1) unlogged = record(unlogged, event({ modelId, risk: 'high', propensity: null, costMicroUsd: modelId === BASE ? 2_000_000 : 1_000_000 }));
  assert.equal(reconcile(unlogged, { priors: SUPPORTED }).reasonCode, 'LOCAL_EVIDENCE_SHORT');
  // The guard is locked: a setting can raise it, never lower it.
  assert.equal(learningSettings({ minLocalPerArm: 1 }).minLocalPerArm, MIN_LOCAL_PER_ARM);
  assert.equal(learningSettings({ minLocalPerArm: 40 }).minLocalPerArm, 40);
  const advise = reconcile(both, { priors: UNSUPPORTED });
  assert.equal(advise.outcome, 'no-change');
  assert.notEqual(advise.reasonCode, 'LOCAL_EVIDENCE_SHORT');
  // A candidate outside the router's eligible set is never activated.
  assert.equal(reconcile(both, { priors: SUPPORTED, eligibleModelIds: [BASE] }).reasonCode, 'CANDIDATE_NOT_ELIGIBLE');
  // Review mode turns the switch into a proposal, under the same guard.
  const review = reconcile(localEvidence(emptyLearningState({ workspaceId: 'ws-1', now: NOW, settings: { promotionMode: 'review' } })), { priors: SUPPORTED });
  assert.equal(review.outcome, 'proposed');
  assert.equal(reconcile(emptyLearningState({ workspaceId: 'ws-1', now: NOW, settings: { promotionMode: 'review' } }), { priors: SUPPORTED }).reasonCode, 'LOCAL_EVIDENCE_SHORT');
});

test('C16 product path: a slice switched on local evidence routes a low-risk managed worker to the candidate; high risk keeps the baseline', async (t) => {
  const state = reconcile(localEvidence(emptyLearningState({ workspaceId: 'ws-1', now: NOW, settings: { explorationRate: 0 } })), { priors: SUPPORTED }).state;
  const low = await worker(t, { state });
  assert.equal(low.result.launched, true, JSON.stringify(low.result));
  assert.deepEqual(low.launches, [CAND]);
  assert.equal(low.result.learning.sliceMode, 'auto');
  assert.equal(low.result.learning.policyVersion, 1);
  for (const risk of ['high', 'unknown']) {
    const held = await worker(t, { state, risk });
    assert.equal(held.result.launched, false, risk);
    assert.equal(held.result.reasonCode, 'LEARNING_ADVISE');
    assert.deepEqual(held.launches, []);
  }
});

test('C16: every local outcome moves the posterior; enough good outcomes activate a slice the baseline did not support', () => {
  let s = reconcile(emptyLearningState({ workspaceId: 'ws-1', now: NOW }), { priors: UNSUPPORTED }).state;
  const harm = (st) => harmProbability(armPosterior(st, SLICE, CAND), armPosterior(st, SLICE, BASE), 0.075);
  const before = harm(s);
  assert.deepEqual(armPosterior(s, SLICE, CAND).prior, { rate: 0.643, pseudoCount: 30, sourceId: 'cal-baseline-test' });
  // One good candidate outcome lowers the harm probability; one failure raises it.
  const good = record(s, event({ modelId: CAND, costMicroUsd: 1_000_000 }));
  assert.ok(harm(good) < before);
  assert.ok(harm(record(s, event({ modelId: CAND, kind: 'verified-fail' }))) > before);
  assert.deepEqual(armPosterior(good, SLICE, CAND).local, { successes: 1, failures: 0 });
  // A run where the candidate verifies at 85% and the baseline at 70% (both drawn in a fixed order).
  let activatedAfter = null;
  for (let i = 0; i < 80 && activatedAfter === null; i += 1) {
    s = record(s, event({ modelId: CAND, costMicroUsd: 1_000_000, kind: i % 20 < 17 ? 'verified-pass' : 'verified-fail' }));
    s = record(s, event({ modelId: BASE, kind: i % 10 < 7 ? 'verified-pass' : 'verified-fail' }));
    const r = reconcile(s);
    s = r.state;
    if (r.outcome === 'activated') {
      activatedAfter = i + 1;
      assert.deepEqual([r.version.reason, r.version.reasonCode], ['promotion', 'POSTERIOR_NON_INFERIOR']);
    }
  }
  assert.ok(activatedAfter !== null && activatedAfter <= 40, `activated after ${String(activatedAfter)} outcomes per arm`);
  assert.equal(slicePolicy(s, SLICE).modelId, CAND);
});

test('C52: demotion is fast and automatic: a failing candidate returns the slice to the baseline within a few outcomes', () => {
  const active = reconcile(localEvidence(emptyLearningState({ workspaceId: 'ws-1', now: NOW })), { priors: SUPPORTED }).state;
  let s = active;
  let demotedAfter = null;
  let result = null;
  for (let i = 0; i < 40 && demotedAfter === null; i += 1) {
    s = record(s, event({ modelId: CAND, kind: i % 4 === 0 ? 'verified-pass' : 'verified-fail', costMicroUsd: 1_000_000, policyVersion: 1 }));
    result = reconcile(s);
    s = result.state;
    if (result.outcome === 'demoted') demotedAfter = i + 1;
  }
  assert.ok(demotedAfter !== null && demotedAfter <= 20, `demoted after ${String(demotedAfter)} outcomes: ${JSON.stringify(result.evidence?.harmProbability)}`);
  // The posterior or the recent window, whichever sees it first.
  assert.ok(['POSTERIOR_REGRESSION', 'WINDOW_REGRESSION'].includes(result.reasonCode), result.reasonCode);
  assert.deepEqual([result.version.reason, result.version.parentVersion], ['demotion', 1]);
  assert.equal(slicePolicy(s, SLICE).mode, 'advise');
  assert.equal(slicePolicy(s, SLICE).modelId, null);
  // Reactivation waits for the flap floor: 5 new labelled outcomes after the change.
  const late = '2026-09-26T23:59:59Z';
  const strong = reconcile(simulate(emptyLearningState({ workspaceId: 'ws-1', now: NOW }), { n: 200, seed: 3 })).state;
  assert.equal(slicePolicy(strong, SLICE).mode, 'auto');
  const dropped = reconcile(strong, { eligibleModelIds: [BASE], now: late });
  assert.equal(dropped.reasonCode, 'MODEL_INELIGIBLE');
  let floor = dropped.state;
  assert.equal(reconcile(floor, { now: late }).reasonCode, 'FLAP_FLOOR');
  for (let i = 0; i < 4; i += 1) floor = record(floor, event({ at: '2026-09-27T01:00:00Z', eventId: `f-${i}`, routeId: `f-${i}` }));
  assert.equal(reconcile(floor, { now: '2026-09-27T02:00:00Z' }).reasonCode, 'FLAP_FLOOR');
  floor = record(floor, event({ at: '2026-09-27T01:00:00Z', eventId: 'f-4', routeId: 'f-4' }));
  assert.equal(reconcile(floor, { now: '2026-09-27T02:00:00Z' }).outcome, 'activated');
  // An ineligible candidate is demoted at once, and so is a slice whose baseline model changed.
  assert.equal(reconcile(active, { eligibleModelIds: [BASE] }).reasonCode, 'MODEL_INELIGIBLE');
  assert.equal(reconcile(active, { baselineModelId: 'claude-opus-5', eligibleModelIds: [...ELIGIBLE, 'claude-opus-5'] }).reasonCode, 'BASELINE_CHANGED');
});

test('C52: a sudden drop after a long good history demotes on the recent window even while the posterior is still fine', () => {
  let s = reconcile(localEvidence(emptyLearningState({ workspaceId: 'ws-1', now: NOW })), { priors: SUPPORTED }).state;
  for (let i = 0; i < 400; i += 1) s = record(s, event({ modelId: CAND, costMicroUsd: 1_000_000, at: '2026-09-27T00:00:00Z', eventId: `h-${i}`, routeId: `h-${i}` }));
  assert.equal(reconcile(s).reasonCode, 'WITHIN_MARGIN');
  let r = null;
  for (let i = 0; i < 20; i += 1) {
    s = record(s, event({ modelId: CAND, kind: 'verified-fail', costMicroUsd: 1_000_000, at: '2026-09-28T00:00:00Z', eventId: `d-${i}`, routeId: `d-${i}` }));
    r = reconcile(s, { now: '2026-09-28T00:00:01Z' });
    s = r.state;
    if (r.outcome === 'demoted') break;
  }
  assert.equal(r.outcome, 'demoted');
  assert.equal(r.reasonCode, 'WINDOW_REGRESSION');
  assert.ok(harmProbability(armPosterior(s, SLICE, CAND), armPosterior(s, SLICE, BASE), 0.075) < 0.4, 'the posterior alone had not crossed');
});

test('C16: a human pin always wins; pinned to advice never launches; unpin returns the slice to the baseline and posterior', async (t) => {
  const active = reconcile(localEvidence(emptyLearningState({ workspaceId: 'ws-1', now: NOW, settings: { explorationRate: 0 } })), { priors: SUPPORTED }).state;
  const pinned = pinSlice(active, SLICE, BASE, NOW);
  assert.deepEqual(slicePolicy(pinned, SLICE), { mode: 'pinned', modelId: BASE, baselineModelId: null, baselineRate: null });
  // Failures or successes never change a pinned slice.
  let s = pinned;
  for (let i = 0; i < 30; i += 1) s = record(s, event({ modelId: BASE, kind: 'verified-fail' }));
  assert.deepEqual([reconcile(s).outcome, reconcile(s).reasonCode], ['no-change', 'SLICE_PINNED']);
  const ran = await worker(t, { state: pinned });
  assert.deepEqual(ran.launches, [BASE]);
  assert.equal(ran.result.selection.reasonCode, 'PINNED_BY_USER');
  assert.equal(explorationChoice({ state: pinned, sliceId: SLICE, defaultModelId: BASE, eligibleModelIds: ELIGIBLE, random: () => 0, mode: 'bounded-auto', risk: 'low' }).reasonCode, 'SLICE_PINNED');
  const adviceOnly = await worker(t, { state: pinSlice(active, SLICE, null, NOW), random: () => 0 });
  assert.equal(adviceOnly.result.launched, false);
  assert.deepEqual(adviceOnly.launches, []);
  const unpinned = unpinSlice(pinned, SLICE, NOW);
  assert.equal(slicePolicy(unpinned, SLICE).mode, 'advise');
  assert.equal(reconcile(unpinned).outcome, 'activated', 'the baseline decides again after an unpin');
});

test('C16: learning off stops every switch and all exploration in the workspace; outcomes are still counted', async (t) => {
  const active = reconcile(localEvidence(emptyLearningState({ workspaceId: 'ws-1', now: NOW })), { priors: SUPPORTED }).state;
  const off = { ...active, settings: learningSettings({ ...active.settings, enabled: false }) };
  assert.deepEqual([reconcile(off).outcome, reconcile(off).reasonCode], ['no-change', 'LEARNING_OFF']);
  assert.equal(explorationChoice({ state: off, sliceId: SLICE, defaultModelId: BASE, eligibleModelIds: ELIGIBLE, random: () => 0, mode: 'bounded-auto', risk: 'low' }).reasonCode, 'LEARNING_OFF');
  const r = await worker(t, { state: off, random: () => 0 });
  assert.equal(r.result.launched, false);
  assert.equal(r.result.reasonCode, 'ADVISE_MODE');
  assert.deepEqual(r.launches, []);
  assert.equal(record(off, event()).arms[SLICE][BASE].successes, off.arms[SLICE][BASE].successes + 1);
  assert.match(explainSliceLearning(off, SLICE).lines[0], /route learning is off/);
});

test('C16 retention: the aggregate outlives the 30-day raw window; outcomes older than 30 days still count after pruning', () => {
  let s = reconcile(emptyLearningState({ workspaceId: 'ws-1', now: NOW }), { priors: UNSUPPORTED }).state;
  for (let i = 0; i < 50; i += 1) s = record(s, event({ modelId: CAND, costMicroUsd: 1_000_000, at: '2026-09-01T12:00:00Z', eventId: `old-${i}`, routeId: `old-${i}`, kind: i < 45 ? 'verified-pass' : 'verified-fail' }));
  const posteriorBefore = armPosterior(s, SLICE, CAND);
  assert.equal(s.events.length, 50);
  // 40 days later: the raw window moves on and drops the old events; the counts stay.
  s = record(s, event({ modelId: BASE, at: '2026-10-11T12:00:00Z', eventId: 'late-1', routeId: 'late-1' }));
  assert.equal(s.events.length, 1, 'only the recent event is kept raw');
  assert.equal(s.events.some((e) => e.routeId.startsWith('old-')), false);
  assert.deepEqual([s.arms[SLICE][CAND].successes, s.arms[SLICE][CAND].failures, s.arms[SLICE][CAND].routes], [45, 5, 50]);
  assert.deepEqual(armPosterior(s, SLICE, CAND), posteriorBefore, 'the candidate posterior is unchanged by the window moving');
  // An outcome older than the window is refused, not half-counted.
  assert.equal(recordRouteOutcome(s, event({ at: '2026-09-02T00:00:00Z' })).reasonCode, 'EVENT_EXPIRED');
  // The file holds no text; the stored aggregate is what reloads.
  assert.equal(LEARNING_LIMITS.windowDays, 30);
  const json = JSON.stringify(s);
  assert.equal(/problem|prompt|diff|patch/.test(json), false);
});

test('C16: exploration only in bounded-auto at low risk, capped at 10%, weighted by the posterior, with exact propensities', () => {
  // Model arms only here; effort arms have their own test.
  const s = emptyLearningState({ workspaceId: 'ws-1', now: NOW, settings: { explorationRate: 0.5, effortArms: [] } });
  assert.equal(s.settings.explorationRate, LEARNING_LIMITS.explorationCap);
  const base = { state: s, sliceId: SLICE, defaultModelId: BASE, eligibleModelIds: ELIGIBLE, random: () => 0 };
  assert.equal(explorationChoice({ ...base, mode: 'advise', risk: 'low' }).reasonCode, 'NOT_AUTOMATED');
  for (const risk of ['medium', 'high', 'unknown']) assert.equal(explorationChoice({ ...base, mode: 'bounded-auto', risk }).reasonCode, 'RISK_NOT_LOW');
  // One alternative with no evidence either way: all of the exploration share.
  assert.deepEqual(explorationChoice({ ...base, mode: 'bounded-auto', risk: 'low' }), { modelId: CAND, effort: null, explored: true, propensity: 0.1, reasonCode: 'EXPLORED' });
  assert.deepEqual(explorationChoice({ ...base, mode: 'bounded-auto', risk: 'low', random: () => 0.5 }), { modelId: BASE, effort: null, explored: false, propensity: 0.9, reasonCode: 'DEFAULT' });
  // Two alternatives: the one more likely within the margin gets the larger share, and the propensities sum to the rate.
  const withPriors = { ...s, baseline: { [SLICE]: { releaseId: 'r', priors: [...SUPPORTED.priors, { sliceId: SLICE, modelId: 'claude-opus-5', rate: 0.6, pseudoCount: 30, sampleSize: 30, sourceId: 'r' }] } } };
  const three = [BASE, CAND, 'claude-opus-5'];
  const picks = [0, 0.99].map((r2) => {
    let call = 0;
    return explorationChoice({ ...base, state: withPriors, eligibleModelIds: three, random: () => (call++ === 0 ? 0 : r2), mode: 'bounded-auto', risk: 'low' });
  });
  assert.deepEqual(picks.map((p) => p.modelId).sort(), ['claude-opus-5', CAND].sort());
  const byModel = Object.fromEntries(picks.map((p) => [p.modelId, p.propensity]));
  assert.ok(byModel[CAND] > byModel['claude-opus-5']);
  assert.ok(Math.abs(byModel[CAND] + byModel['claude-opus-5'] - 0.1) < 1e-5);
  // A retired model is never explored: Haiku 4.5 with a firm retiresOn of 2026-11-01 (DOMAINS 9d1e7eb).
  const late = Date.parse('2026-11-01T00:00:00Z');
  const haikuRetires = { ...REGISTRY, entries: REGISTRY.entries.map((e) => (e.modelId === 'claude-haiku-4-5-20251001' ? { ...e, lifecycle: { ...e.lifecycle, retiresOn: '2026-11-01T00:00:00Z' } } : e)) };
  assert.equal(explorationChoice({ ...base, eligibleModelIds: [BASE, 'claude-haiku-4-5-20251001'], registry: haikuRetires, nowMs: late, mode: 'bounded-auto', risk: 'low' }).reasonCode, 'NO_ELIGIBLE_ALTERNATIVE');
  // Paired: past only its "not sooner than" date (2026-10-15) it is still explored.
  assert.equal(explorationChoice({ ...base, eligibleModelIds: [BASE, 'claude-haiku-4-5-20251001'], registry: REGISTRY, nowMs: late, mode: 'bounded-auto', risk: 'low' }).reasonCode, 'EXPLORED');
  // Over many routes the explored share is the advise-only rate (10%, the cap) until the slice has
  // switched, then the default rate (5%) (DOMAINS 223a21f); exploration off stays off.
  const share = (state) => {
    const r = mulberry(9);
    let n = 0;
    for (let i = 0; i < 20_000; i += 1) if (explorationChoice({ ...base, state, random: r, mode: 'bounded-auto', risk: 'low' }).explored) n += 1;
    return n / 20_000;
  };
  const advising = emptyLearningState({ workspaceId: 'ws-1', now: NOW });
  assert.ok(share(advising) > 0.095 && share(advising) < 0.105, String(share(advising)));
  const switched = reconcile(localEvidence(advising), { priors: SUPPORTED }).state;
  assert.equal(slicePolicy(switched, SLICE).mode, 'auto');
  assert.ok(share(switched) > 0.045 && share(switched) < 0.055, String(share(switched)));
  assert.equal(explorationChoice({ ...base, state: emptyLearningState({ workspaceId: 'ws-1', now: NOW, settings: { explorationRate: 0 } }), mode: 'bounded-auto', risk: 'low' }).reasonCode, 'EXPLORATION_OFF');
});

test('C16: a model almost surely worse than the default by more than the margin is not explored (futility)', () => {
  const s = simulate(emptyLearningState({ workspaceId: 'ws-1', now: NOW, settings: { effortArms: [] } }), { n: 60, base: 0.9, cand: 0.4, seed: 2 });
  assert.equal(explorationChoice({ state: s, sliceId: SLICE, defaultModelId: BASE, eligibleModelIds: ELIGIBLE, random: () => 0, mode: 'bounded-auto', risk: 'low' }).reasonCode, 'NO_ELIGIBLE_ALTERNATIVE');
  const close = simulate(emptyLearningState({ workspaceId: 'ws-1', now: NOW, settings: { effortArms: [] } }), { n: 60, base: 0.8, cand: 0.78, seed: 2 });
  assert.equal(explorationChoice({ state: close, sliceId: SLICE, defaultModelId: BASE, eligibleModelIds: ELIGIBLE, random: () => 0, mode: 'bounded-auto', risk: 'low' }).reasonCode, 'EXPLORED');
});

test('C16: every change is a new version; pin, unpin, reset and rollback are reversible and never rewrite history', () => {
  const s1 = reconcile(localEvidence(emptyLearningState({ workspaceId: 'ws-1', now: NOW })), { priors: SUPPORTED }).state;
  const s2 = pinSlice(s1, SLICE, BASE, NOW);
  const s3 = unpinSlice(s2, SLICE, NOW);
  assert.equal(slicePolicy(s3, SLICE).mode, 'advise');
  const s4 = rollbackLearning(s3, 1, NOW);
  assert.equal(s4.ok, true);
  assert.equal(slicePolicy(s4.state, SLICE).modelId, CAND);
  assert.equal(rollbackLearning(s3, 99, NOW).reasonCode, 'VERSION_UNKNOWN');
  const withEvidence = simulate(s4.state, { n: 5 });
  const s5 = resetLearning(withEvidence, NOW);
  assert.equal(slicePolicy(s5, SLICE).mode, 'advise');
  assert.equal(s5.events.length, withEvidence.events.length);
  assert.deepEqual(s5.arms, withEvidence.arms, 'a reset keeps the outcomes');
  assert.deepEqual(s5.versions.map((v) => v.reason), ['bundled-default', 'promotion', 'pin', 'unpin', 'rollback', 'reset']);
  assert.deepEqual(s5.versions.map((v) => v.version), [0, 1, 2, 3, 4, 5]);
  const cleared = resetLearning(withEvidence, NOW, { clearEvidence: true });
  assert.deepEqual([cleared.events.length, Object.keys(cleared.arms).length], [0, 0]);
});

test('C16: review mode proposes; the user accepts or rejects, and nothing changes without them', () => {
  const s0 = localEvidence(emptyLearningState({ workspaceId: 'ws-1', now: NOW, settings: { promotionMode: 'review' } }));
  const ev = reconcile(s0, { priors: SUPPORTED });
  assert.equal(ev.outcome, 'proposed');
  assert.equal(slicePolicy(ev.state, SLICE).mode, 'advise');
  assert.equal(reconcile(ev.state).proposal.proposalId, ev.proposal.proposalId, 'asking again keeps the same pending proposal');
  assert.equal(slicePolicy(rejectProposal(ev.state, ev.proposal.proposalId), SLICE).mode, 'advise');
  const accepted = acceptProposal(ev.state, ev.proposal.proposalId, '2026-09-27T00:00:00Z');
  assert.equal(accepted.ok, true);
  assert.deepEqual([slicePolicy(accepted.state, SLICE).mode, slicePolicy(accepted.state, SLICE).modelId, accepted.version.reason], ['auto', CAND, 'accepted-proposal']);
  assert.equal(acceptProposal(accepted.state, ev.proposal.proposalId, NOW).reasonCode, 'PROPOSAL_NOT_PENDING');
  // The CLI's shipped wording for a pending proposal.
  assert.match(explainSliceLearning(ev.state, SLICE).lines.join('\n'), /Pending proposal lp-[0-9a-f]+: claude-sonnet-5 is non-inferior to claude-opus-5-5/);
});

test('C16: explain shows the baseline prior and the local evidence separately, then the posterior, with each public prior and its source', () => {
  let s = reconcile(localEvidence(emptyLearningState({ workspaceId: 'ws-1', now: NOW, settings: { priorSlices: { [SLICE]: 'terminal' } } })), { priors: SUPPORTED }).state;
  s = simulate(s, { n: 20, seed: 3 });
  const x = explainSliceLearning(s, SLICE);
  assert.equal(x.policy.mode, 'auto');
  assert.deepEqual(x.baseline, SUPPORTED);
  assert.deepEqual(x.posteriors.map((p) => [p.modelId, p.prior.pseudoCount, p.local.successes + p.local.failures]), [[BASE, 30, 20 + MIN_LOCAL_PER_ARM], [CAND, 30, 20 + MIN_LOCAL_PER_ARM]]);
  assert.equal(x.posteriors.find((p) => p.modelId === BASE).harmVsBaseline, null);
  assert.ok(x.posteriors.find((p) => p.modelId === CAND).harmVsBaseline >= 0);
  const text = x.lines.join('\n');
  assert.match(text, /^Slice bounded-edit: active, claude-sonnet-5 \(baseline claude-opus-5-5 at \d+\.\d%\), policy v1\.$/m);
  assert.match(text, /^Set by v1 \(promotion, POSTERIOR_NON_INFERIOR\)/m);
  assert.match(text, /^Baseline claude-sonnet-5: 80\.0% from 30 outcomes, counted as 30, signed release cal-baseline-test\.$/m);
  assert.match(text, /^Local claude-sonnet-5: \d+\/32 verified .*API-equivalent estimate \$1\.0000 per route\.$/m);
  assert.match(text, /^Posterior claude-sonnet-5: mean \d+\.\d% \(prior 30 \+ local 32\), P\(worse than the baseline by more than 7\.5%\) \d+\.\d%\.$/m);
  assert.match(text, /Prior claude-opus-5-5 \(max\): 63\.1% over 198 trials on terminal-bench@4\.0 .*AA-CAI https:\/\/artificialanalysis\.ai.* published 2026-09-26, fetched 2026-09-26/);
  assert.match(text, /Active when P\(worse by more than 7\.5%\) < 10\.0% and each arm has 12 local randomized outcomes, demoted above 40\.0%; exploration 10\.0% of low-risk routes while advise-only, 5\.0% once switched; 5 outcomes after a change before reactivation; effort arms low, high on the baseline model; automatic\./);
  // A slice with no signed baseline says so.
  assert.match(explainSliceLearning(emptyLearningState({ workspaceId: 'ws-1', now: NOW }), SLICE).lines.join('\n'), /Baseline: no signed baseline release for this slice\.\nNo local outcomes yet\./);
});

test('C16: the rules-only counterfactual is attributed on every route, never as a saving', () => {
  let s = emptyLearningState({ workspaceId: 'ws-1', now: NOW });
  s = record(s, event({ rulesModelId: BASE, modelId: BASE }));
  s = record(s, event({ rulesModelId: BASE, modelId: CAND, kind: 'verified-fail' }));
  s = record(s, event({ rulesModelId: CAND, modelId: CAND }));
  s = record(s, event({ rulesModelId: null, modelId: BASE }));
  assert.deepEqual(rulesAttribution(s), [{ sliceId: SLICE, routes: 3, agreedWithRules: 2, differedFromRules: 1, agreedSuccessRate: 1, differedSuccessRate: 0, savingClaim: null }]);
});

test('C16: advice estimates combine local outcomes with bounded public priors; an effort mismatch halves the prior', () => {
  const s = emptyLearningState({ workspaceId: 'ws-1', now: NOW, settings: { priorSlices: { [SLICE]: 'terminal' } } });
  const q = learnedQualities(s, SLICE, REGISTRY);
  const opus55 = q.find((e) => e.modelId === BASE);
  // Opus 5.5's default effort is medium; its published result is at max, so it counts as half of 30.
  const ci = wilsonInterval(0.6313 * 15, 15);
  assert.equal(opus55.point, 0.6313);
  assert.equal(opus55.lower, Math.round(ci.lower * 1e6) / 1e6);
  assert.equal(opus55.sourceId, 'local-learning:v0');
  const withLocal = simulate(s, { n: 100, base: 0.9, cand: 0.5, seed: 8 });
  assert.ok(learnedQualities(withLocal, SLICE, REGISTRY).find((e) => e.modelId === BASE).point > 0.85);
  assert.deepEqual(learnedQualities(s, 'other-slice', REGISTRY), []);
});

test('C16: settings are clamped to the hard limits; the defaults are the locked thresholds', () => {
  const s = learningSettings({ explorationRate: 0.5, nonInferiorityMargin: 0.3, activateBelow: 0.9, deactivateAbove: 0.05, flapFloor: 0, promotionMode: 'yolo', priorWeight: 500, demotionWindow: 1 });
  assert.deepEqual(
    [s.explorationRate, s.nonInferiorityMargin, s.activateBelow, s.deactivateAbove, s.flapFloor, s.promotionMode, s.priorWeight, s.demotionWindow, s.enabled],
    [0.1, 0.1, 0.25, 0.25, 1, 'automatic', 100, 10, true],
  );
  const d = learningSettings({});
  const t = OWNER_LOCKED_LEARNING_THRESHOLDS;
  assert.deepEqual([d.explorationRate, d.nonInferiorityMargin, d.activateBelow, d.deactivateAbove, d.flapFloor, d.priorWeight, d.demotionWindow], [t.explorationRate, t.nonInferiorityMargin, t.activateBelow, t.deactivateAbove, t.flapFloor, t.priorWeight, t.demotionWindow]);
  assert.equal(DEFAULT_LEARNING_SETTINGS.promotionMode, 'automatic');
  // For comparison only: the fixed-sample test the posterior design replaces.
  assert.deepEqual([requiredPerArm(0.05), requiredPerArm(0.075), requiredPerArm(0.1)], [406, 181, 102]);
});

test('C16: the posterior thresholds are owner-locked; the readiness check is satisfied', () => {
  const ready = automaticPromotionReady();
  assert.equal(ready.ready, true);
  assert.equal(OWNER_LOCKED_LEARNING_THRESHOLDS, ready.thresholds);
  const { decisionRef, ...values } = ready.thresholds;
  assert.match(decisionRef, /2026-09-26/);
  assert.deepEqual(values, { explorationRate: 0.05, adviseExplorationRate: 0.1, minLocalPerArm: MIN_LOCAL_PER_ARM, nonInferiorityMargin: 0.075, activateBelow: 0.1, deactivateAbove: 0.4, flapFloor: 5, priorWeight: 30, machinePriorWeight: MACHINE_PRIOR_WEIGHT, demotionWindow: 20, lockedOn: '2026-09-26' });
  // The machine prior's cap is its own locked number, equal to the local minimum (DOMAINS 43990b1).
  assert.deepEqual([MACHINE_PRIOR_WEIGHT, MACHINE_PRIOR_WEIGHT === MIN_LOCAL_PER_ARM], [12, true]);
  assert.match(decisionRef, /43990b1/);
  // A caller can hold automatic back (for example before a person confirms): a proposal instead.
  assert.equal(reconcile(localEvidence(emptyLearningState({ workspaceId: 'ws-1', now: NOW })), { priors: SUPPORTED, automaticAllowed: false }).outcome, 'proposed');
});

test('C16: the bundled public priors carry a source, url and dates, and name registry models', () => {
  for (const p of BUNDLED_PUBLIC_PRIORS) {
    assert.match(p.url, /^https:\/\//);
    assert.match(p.publishedOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(p.fetchedOn, '2026-09-26');
    assert.ok(p.successRate > 0 && p.successRate < 1);
    assert.ok(REGISTRY.entries.some((m) => m.modelId === p.modelId), p.modelId);
  }
});

test('C16: the Beta, Wilson and Newcombe arithmetic matches known values', () => {
  assert.ok(Math.abs(betaCdf(0.5, 2, 3) - 0.6875) < 1e-9);
  assert.ok(Math.abs(betaCdf(0.3, 1, 1) - 0.3) < 1e-9);
  assert.ok(Math.abs(betaQuantile(0.5, 10, 10) - 0.5) < 1e-9);
  // Equal, tight posteriors: harm is tiny. A candidate 10 points behind with tight posteriors: harm is large.
  const P = (r, n) => ({ alpha: 0.5 + r * n, beta: 0.5 + (1 - r) * n });
  assert.ok(harmProbability(P(0.7, 2000), P(0.7, 2000), 0.075) < 0.001);
  assert.ok(harmProbability(P(0.6, 2000), P(0.7, 2000), 0.075) > 0.9);
  // The published Fable 5.1 vs Opus 5.5 rows (DeepSWE, 339 each): about 17.5%; at 30 pseudo-outcomes about 38.5%.
  assert.ok(Math.abs(harmProbability(P(0.6431, 339), P(0.6844, 339), 0.075) - 0.1749) < 0.002);
  assert.ok(Math.abs(harmProbability(P(0.6431, 30), P(0.6844, 30), 0.075) - 0.3852) < 0.002);
  const w = wilsonInterval(81, 263);
  assert.ok(Math.abs(w.lower - 0.2553) < 1e-3 && Math.abs(w.upper - 0.3662) < 1e-3);
  const d = newcombeDifference(56, 70, 48, 80, 1.959964);
  assert.ok(Math.abs(d.lower - 0.0524) < 1e-3 && Math.abs(d.upper - 0.3339) < 1e-3, JSON.stringify(d));
});

test('C16: a signed beta-posterior release gives the baseline priors, capped at the prior weight; any other release gives none', () => {
  const artifact = {
    id: 'cal-baseline-1',
    uncertaintyInterval: { lower: 0.5, upper: 0.8, confidenceLevel: 0.9, method: 'beta-posterior' },
    modelQualities: [
      { modelId: BASE, sliceId: SLICE, lower: 0.6, point: 0.68, upper: 0.75, sampleSize: 339 },
      { modelId: CAND, sliceId: SLICE, lower: 0.5, point: 0.7, upper: 0.85, sampleSize: 12 },
      { modelId: CAND, sliceId: 'other', lower: 0.5, point: 0.7, upper: 0.85, sampleSize: 12 },
    ],
  };
  assert.deepEqual(baselinePriorsFromRelease(artifact, SLICE), [
    { sliceId: SLICE, modelId: BASE, rate: 0.68, sampleSize: 339, pseudoCount: 30, sourceId: 'cal-baseline-1' },
    { sliceId: SLICE, modelId: CAND, rate: 0.7, sampleSize: 12, pseudoCount: 12, sourceId: 'cal-baseline-1' },
  ]);
  assert.deepEqual(baselinePriorsFromRelease({ ...artifact, uncertaintyInterval: { ...artifact.uncertaintyInterval, method: 'wilson' } }, SLICE), []);
});

test('C16: the state persists per workspace under the Jevris data directory; a corrupt or foreign file loads as nothing; version 1 migrates', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jevris-learning-'));
  try {
    const s = simulate(reconcile(localEvidence(emptyLearningState({ workspaceId: 'ws-1', now: NOW })), { priors: SUPPORTED }).state, { n: 5 });
    assert.deepEqual(await saveLearningState(home, s), { ok: true });
    const file = learningStateFile(home, 'ws-1');
    assert.ok(file.startsWith(home));
    assert.match(file, /route-learning/);
    assert.deepEqual(await loadLearningState({ home, workspaceId: 'ws-1' }), s);
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(await loadLearningState({ home, workspaceId: 'ws-2' }), null);
    assert.throws(() => learningStateFile(home, '../escape'));
    await writeFile(file, '{"schemaVersion":"jevris-route-learning-2","workspaceId":"ws-1","versions":[],"arms":{},"baseline":{},"events":[],"proposals":[]}');
    assert.equal(await loadLearningState({ home, workspaceId: 'ws-1' }), null);
    await writeFile(file, 'not json');
    assert.equal(await loadLearningState({ home, workspaceId: 'ws-1' }), null);
    // A negative count or a model-judgement label is refused whole.
    for (const mutate of [(b) => (b.arms[SLICE][BASE].successes = -1), (b) => (b.events[0].labelSource = 'model-judgement')]) {
      const bad = JSON.parse(JSON.stringify(s));
      mutate(bad);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(bad));
      assert.equal(await loadLearningState({ home, workspaceId: 'ws-1' }), null);
    }
    assert.equal((await readFile(file, 'utf8')).includes('model-judgement'), true);
    // A version 1 file (raw events only) migrates by replaying its events into the aggregate.
    const v1 = { schemaVersion: 'jevris-route-learning-1', workspaceId: 'ws-1', settings: {}, versions: s.versions.slice(0, 1), events: s.events, proposals: [] };
    await writeFile(file, JSON.stringify(v1));
    const migrated = await loadLearningState({ home, workspaceId: 'ws-1' });
    assert.equal(migrated.schemaVersion, 'jevris-route-learning-2');
    assert.deepEqual(migrated.arms, s.arms);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('C16: learnFromOutcome records and reconciles against the snapshotted baseline; a regression demotes at once; a model-judgement label is refused', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jevris-learning-'));
  try {
    const first = await learnFromOutcome({ home, workspaceId: 'ws-9', event: event(), baselineModelId: BASE, eligibleModelIds: ELIGIBLE, now: NOW, registry: REGISTRY });
    assert.deepEqual(first, { recorded: true, reasonCode: 'NO_CANDIDATE', regression: 'no-change', promotion: 'no-change', proposalId: null, version: 0, saved: true });
    const refused = await learnFromOutcome({ home, workspaceId: 'ws-9', event: event({ labelSource: 'model-judgement' }), baselineModelId: BASE, eligibleModelIds: ELIGIBLE, now: NOW });
    assert.deepEqual([refused.recorded, refused.reasonCode], [false, 'LABEL_NOT_DETERMINISTIC']);
    // The workspace's own randomized outcomes on both arms (the local-evidence guard), then the
    // route side snapshots a supported baseline and switches the slice.
    for (const e of localEvents()) assert.equal((await learnFromOutcome({ home, workspaceId: 'ws-9', event: e, baselineModelId: BASE, eligibleModelIds: ELIGIBLE, now: NOW, registry: REGISTRY })).recorded, true);
    const routed = await reconcileLearning({ home, workspaceId: 'ws-9', sliceId: SLICE, baselineModelId: BASE, eligibleModelIds: ELIGIBLE, now: NOW, priors: SUPPORTED, registry: REGISTRY });
    assert.deepEqual([routed.result.outcome, routed.saved], ['activated', true]);
    // Reconciling again changes nothing and writes nothing.
    assert.deepEqual([(await reconcileLearning({ home, workspaceId: 'ws-9', sliceId: SLICE, baselineModelId: BASE, eligibleModelIds: ELIGIBLE, now: NOW, priors: SUPPORTED, registry: REGISTRY })).saved], [false]);
    // Failing candidate outcomes demote it on the write side, from the snapshotted priors.
    let last = null;
    for (let i = 0; i < 25 && last?.regression !== 'demoted'; i += 1) last = await learnFromOutcome({ home, workspaceId: 'ws-9', event: event({ modelId: CAND, kind: 'verified-fail', costMicroUsd: 1_000_000 }), baselineModelId: BASE, eligibleModelIds: ELIGIBLE, now: NOW, registry: REGISTRY });
    assert.equal(last.regression, 'demoted');
    assert.ok(['POSTERIOR_REGRESSION', 'WINDOW_REGRESSION'].includes(last.reasonCode), last.reasonCode);
    const loaded = await loadLearningState({ home, workspaceId: 'ws-9' });
    assert.equal(slicePolicy(loaded, SLICE).mode, 'advise');
    // Concurrent outcomes in one process are serialized: none is lost.
    await Promise.all(Array.from({ length: 8 }, () => learnFromOutcome({ home, workspaceId: 'ws-9', event: event(), baselineModelId: BASE, eligibleModelIds: ELIGIBLE, now: NOW })));
    const after = await loadLearningState({ home, workspaceId: 'ws-9' });
    assert.equal(after.arms[SLICE][BASE].routes, loaded.arms[SLICE][BASE].routes + 8);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('C16: the resource check follows the harness billing: dollars on an API key, usage-limit consumption on a subscription', () => {
  // Local outcomes at equal quality; the candidate costs more API-equivalent dollars but uses fewer tokens of the plan.
  const s = simulate(emptyLearningState({ workspaceId: 'ws-1', now: NOW }), { n: 200, seed: 3, baseCost: 1_000_000, candCost: 2_000_000, baseTokens: 3_000_000, candTokens: 1_000_000 });
  // With enough verified tasks on both arms, the realized cost per verified task decides.
  assert.equal(reconcile(s, { authMode: 'api-key' }).reasonCode, 'NOT_CHEAPER_PER_VERIFIED');
  const sub = reconcile(s, { authMode: 'subscription' });
  assert.equal(sub.outcome, 'activated');
  assert.equal(sub.version.evidence.objective, 'subscription');
  // A scarcer model's quota costs more: weight Sonnet 5 at 4x and it no longer saves usage.
  const scarce = simulate(emptyLearningState({ workspaceId: 'ws-1', now: NOW, settings: { quotaWeights: { [CAND]: 4 } } }), { n: 200, seed: 3, baseCost: 1_000_000, candCost: 2_000_000, baseTokens: 3_000_000, candTokens: 1_000_000 });
  assert.equal(reconcile(scarce, { authMode: 'subscription' }).reasonCode, 'MORE_USAGE_PER_VERIFIED');
  // Faster at no more than 10% more usage also qualifies on a subscription.
  const fast = simulate(emptyLearningState({ workspaceId: 'ws-1', now: NOW }), { n: 200, seed: 3, baseTokens: 1_000_000, candTokens: 1_050_000, baseLatency: 100_000, candLatency: 50_000 });
  assert.equal(reconcile(fast, { authMode: 'subscription' }).outcome, 'activated');
  // Unknown billing needs both lower dollars and no more usage.
  assert.equal(reconcile(s, { authMode: 'unknown' }).reasonCode, 'NOT_CHEAPER_PER_VERIFIED');
});

test('C16: a usage-limit hit is capacity, not quality: counted, never labelled, and the model is not explored or launched until reset', async (t) => {
  let s = emptyLearningState({ workspaceId: 'ws-1', now: NOW });
  assert.equal(recordRouteOutcome(s, event({ kind: 'usage-limited', labelSource: 'verification-receipt' })).reasonCode, 'LABEL_NOT_DETERMINISTIC');
  assert.equal(recordRouteOutcome(s, event({ limitResetAt: '2026-09-26T05:00:00Z' })).reasonCode, 'INVALID_EVENT');
  s = record(s, event({ routeId: 'r-lim', modelId: CAND, kind: 'usage-limited', labelSource: 'harness-limit', receiptId: null, at: '2026-09-26T01:00:00Z', limitResetAt: '2026-09-26T06:00:00Z', authMode: 'subscription' }));
  assert.equal(routeLabels(s.events)[0].label, 'unlabelled');
  assert.deepEqual([s.arms[SLICE][CAND].usageLimited, s.arms[SLICE][CAND].successes, s.arms[SLICE][CAND].failures], [1, 0, 0]);
  const at = (iso) => usageLimitStatus(s, CAND, Date.parse(iso));
  assert.deepEqual(at('2026-09-26T02:00:00Z'), { limited: true, near: true, resetAt: '2026-09-26T06:00:00.000Z', recentHits: 1 });
  assert.deepEqual(at('2026-09-26T07:00:00Z'), { limited: false, near: true, resetAt: null, recentHits: 1 });
  assert.deepEqual(at('2026-09-28T07:00:00Z'), { limited: false, near: false, resetAt: null, recentHits: 0 });
  const noReset = record(emptyLearningState({ workspaceId: 'ws-1', now: NOW }), event({ modelId: CAND, kind: 'usage-limited', labelSource: 'harness-limit', receiptId: null, at: '2026-09-26T01:00:00Z' }));
  assert.equal(usageLimitStatus(noReset, CAND, Date.parse('2026-09-26T05:59:00Z')).limited, true);
  assert.equal(usageLimitStatus(noReset, CAND, Date.parse('2026-09-26T06:01:00Z')).limited, false);
  const modelArmsOnly = { ...s, settings: { ...s.settings, effortArms: [] } };
  assert.equal(explorationChoice({ state: modelArmsOnly, sliceId: SLICE, defaultModelId: BASE, eligibleModelIds: ELIGIBLE, random: () => 0, mode: 'bounded-auto', risk: 'low', nowMs: Date.parse('2026-09-26T07:00:00Z') }).reasonCode, 'NO_ELIGIBLE_ALTERNATIVE');
  // The limit is the model's: the baseline model's effort arms may still be explored.
  for (const r of [0, 0.5, 0.99]) {
    let call = 0;
    const choice = explorationChoice({ state: s, sliceId: SLICE, defaultModelId: BASE, eligibleModelIds: ELIGIBLE, random: () => (call++ === 0 ? 0 : r), mode: 'bounded-auto', risk: 'low', nowMs: Date.parse('2026-09-26T07:00:00Z') });
    assert.deepEqual([choice.explored, choice.modelId], [true, BASE]);
    assert.ok(['low', 'high'].includes(choice.effort));
  }
  assert.equal(explainSliceLearning(s, SLICE).lines.some((l) => /1 usage-limit hits/.test(l)), true);
  // An active slice whose candidate is inside its limit does not launch it, and says when it resets.
  let active = reconcile(localEvidence(emptyLearningState({ workspaceId: 'ws-1', now: NOW, settings: { explorationRate: 0 } })), { priors: SUPPORTED }).state;
  active = record(active, event({ routeId: 'r-lim2', modelId: CAND, kind: 'usage-limited', labelSource: 'harness-limit', receiptId: null, at: '2026-09-25T23:00:00Z', limitResetAt: '2026-09-26T04:00:00Z' }));
  const r = await worker(t, { state: active });
  assert.equal(r.result.launched, false);
  assert.equal(r.result.reasonCode, 'MODEL_USAGE_LIMITED');
  assert.deepEqual(r.result.learning.usageLimit, { modelId: CAND, resetAt: '2026-09-26T04:00:00.000Z' });
  assert.deepEqual(r.launches, []);
});

const ACCOUNT = 'acct-1';
function workerRegistry() {
  return {
    ...REGISTRY,
    entries: REGISTRY.entries.map((m) => ({ ...m, health: 'healthy', accountEligibility: [{ accountId: ACCOUNT, eligible: true, checkedAt: '2026-09-22T00:00:00Z' }] })),
  };
}
const NO_RELEASE = async () => ({ eligible: false, stage: 'read', reasonCode: 'NO_RELEASE' });

async function worker(t, { state, risk = 'low', random = () => 0.99, mode = 'bounded-auto', allowlist = null, authMode, loadCalibration = NO_RELEASE, qualities = [] }) {
  const home = await mkdtemp(join(tmpdir(), 'jevris-learning-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const launches = [];
  const result = await runManagedWorker({
    taskId: 'task-1',
    workspaceId: 'ws-1',
    killSwitchStopped: () => false,
    loadCalibration,
    route: {
      registry: workerRegistry(),
      policy: { managedAllowlist: allowlist, allowedRegions: ['global'], requiredContextTokens: 0, requiredCapabilities: ['tools'], pins: { modelPin: null, effortPin: null }, riskFloorFamilies: null, accountId: ACCOUNT, nowMs: Date.parse(NOW) },
      volume: { inputTokens: 400_000, outputTokens: 40_000 },
      assumptions: { verificationMicroUsd: 200_000, reworkMicroUsd: 3_000_000, routingOverheadMicroUsd: 21_000 },
      qualities,
    },
    budget: DecisionBudget.open(join(home, 'generation-budget.json'), { limitMicroUsd: 50_000_000 }),
    launch: async ({ model, effort }) => {
      launches.push(effort === undefined ? model : `${model}@${effort}`);
      return { status: 'completed', requestedModel: model, actualModel: model, usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, costUsd: null };
    },
    mode,
    learning: { state, sliceId: SLICE, risk, random, ...(authMode === undefined ? {} : { authMode }) },
  });
  return { result, launches };
}

test('C16 P2/P3: the learning note carries the rules-only choice, the baseline and the eligible models, whatever the route ran', async (t) => {
  const state = emptyLearningState({ workspaceId: 'ws-1', now: NOW });
  const released = async () => ({ eligible: true, artifact: {}, keyId: 'k-test', qualityFloor: 0.8, sliceId: SLICE });
  const qualities = [
    { modelId: BASE, sliceId: SLICE, lower: 0.9, point: 0.94, upper: 0.97, sourceId: 'holdout-synthetic-1' },
    { modelId: CAND, sliceId: SLICE, lower: 0.86, point: 0.9, upper: 0.94, sourceId: 'holdout-synthetic-1' },
  ];
  // The released calibration picks the cheaper model within the floor; that is the rules-only choice.
  const ruled = await worker(t, { state, loadCalibration: released, qualities });
  assert.equal(ruled.result.launched, true, JSON.stringify(ruled.result));
  assert.deepEqual(ruled.launches, [CAND]);
  assert.deepEqual([ruled.result.learning.rulesModelId, ruled.result.learning.baselineModelId], [CAND, BASE]);
  // An explored route still logs what the rules would have run.
  const explored = await worker(t, { state, loadCalibration: released, qualities, random: () => 0 });
  assert.equal(explored.result.selection.reasonCode, 'EXPLORED');
  assert.equal(explored.result.learning.rulesModelId, CAND);
  // The allowlist narrows the eligible models the outcome is reconciled with.
  const narrowed = await worker(t, { state, allowlist: [BASE] });
  assert.deepEqual(narrowed.result.learning.eligibleModelIds, [BASE]);
  assert.equal(narrowed.result.learning.rulesModelId, BASE);
  // The note's rulesModelId is what the outcome event carries: arm C counts it.
  const s = record(state, event({ modelId: CAND, rulesModelId: ruled.result.learning.rulesModelId }));
  assert.deepEqual(rulesAttribution(s).map((a) => [a.routes, a.agreedWithRules]), [[1, 1]]);
});

test('C16 product path: without a release an advise slice does not launch, but a low-risk route may explore and says so', async (t) => {
  const state = emptyLearningState({ workspaceId: 'ws-1', now: NOW });
  const kept = await worker(t, { state });
  assert.equal(kept.result.launched, false);
  assert.equal(kept.result.reasonCode, 'CALIBRATION_NO_RELEASE');
  const { eligibleModelIds, ...note } = kept.result.learning;
  assert.deepEqual(note, { policyVersion: 0, sliceMode: 'advise', exploration: { modelId: BASE, effort: null, explored: false, propensity: 0.9, reasonCode: 'DEFAULT' }, authMode: 'unknown', usageLimit: null, effort: null, baselineModelId: BASE, rulesModelId: BASE });
  assert.ok(eligibleModelIds.includes(BASE) && eligibleModelIds.includes(CAND), JSON.stringify(eligibleModelIds));
  const explored = await worker(t, { state, random: () => 0 });
  assert.equal(explored.result.launched, true);
  assert.equal(explored.result.selection.reasonCode, 'EXPLORED');
  assert.equal(explored.launches.length, 1);
  assert.notEqual(explored.launches[0], BASE);
  for (const risk of ['high', 'unknown']) {
    const r = await worker(t, { state, risk, random: () => 0 });
    assert.equal(r.result.launched, false);
    assert.equal(r.result.learning.exploration.reasonCode, 'RISK_NOT_LOW');
  }
  const allowed = await worker(t, { state, random: () => 0, allowlist: [CAND] });
  assert.deepEqual(allowed.launches, [CAND], 'exploration stays inside the allowlist');
  // With the baseline model allowed, its effort arms are explored too, and the launch carries the effort.
  const efforts = await worker(t, { state, random: () => 0, allowlist: [BASE, CAND] });
  assert.equal(efforts.launches.length, 1);
  assert.ok([CAND, `${BASE}@low`, `${BASE}@high`].includes(efforts.launches[0]), efforts.launches[0]);
  assert.equal(efforts.result.learning.effort, efforts.result.learning.exploration.effort);
});

test('C16 product path: after a demotion the slice keeps the baseline model, but exploration still gathers evidence', async (t) => {
  let s = reconcile(localEvidence(emptyLearningState({ workspaceId: 'ws-1', now: NOW })), { priors: SUPPORTED }).state;
  for (let i = 0; i < 30 && slicePolicy(s, SLICE).mode === 'auto'; i += 1) s = reconcile(record(s, event({ modelId: CAND, kind: 'verified-fail', costMicroUsd: 1_000_000 }))).state;
  assert.equal(slicePolicy(s, SLICE).mode, 'advise');
  const held = await worker(t, { state: s });
  assert.deepEqual([held.result.launched, held.result.reasonCode], [false, 'LEARNING_ADVISE']);
  const advised = await worker(t, { state: s, mode: 'advise' });
  assert.equal(advised.result.reasonCode, 'CALIBRATION_NO_RELEASE');
});

test('C16 product path: on a subscription an active slice uses its candidate without a dollar comparison', async (t) => {
  const s0 = simulate(emptyLearningState({ workspaceId: 'ws-1', now: NOW, settings: { explorationRate: 0 } }), { n: 200, seed: 3, baseCost: 1_000_000, candCost: 2_000_000, baseTokens: 3_000_000, candTokens: 1_000_000 });
  const active = reconcile(s0, { authMode: 'subscription' }).state;
  assert.equal(slicePolicy(active, SLICE).modelId, CAND);
  const r = await worker(t, { state: active, authMode: 'subscription' });
  assert.equal(r.result.launched, true, JSON.stringify(r.result));
  assert.equal(r.result.selection.modelId, CAND);
  assert.equal(r.result.learning.authMode, 'subscription');
});

// ---------------------------------------------------------------------------------------------
// Effort arms (owner decision 2026-09-26: effort routing from day 1 on the baseline model).

const LOW = `${BASE}@low`;
const HIGH = `${BASE}@high`;

/** A signed baseline with effort arms of the baseline model (the owner's seed would supply these). */
function effortBaseline({ base = 0.68, low = 0.8, high = null, n = 30, measured = false } = {}) {
  const prior = (effort, rate, extra = {}) => ({ sliceId: SLICE, modelId: BASE, ...(effort === null ? {} : { effort }), rate, pseudoCount: n, sampleSize: n, sourceId: 'cal-effort-test', ...extra });
  return {
    releaseId: 'cal-effort-test',
    priors: [
      prior(null, base, measured ? { meanCostMicroUsd: 2_400_000, meanTokens: 440_000 } : {}),
      ...(low === null ? [] : [prior('low', low, measured ? { meanCostMicroUsd: 1_500_000, meanTokens: 300_000 } : {})]),
      ...(high === null ? [] : [prior('high', high, measured ? { meanCostMicroUsd: 3_600_000, meanTokens: 600_000 } : {})]),
    ],
  };
}

test('C16 effort: arm keys are (model, effort); the default effort is the bare model; events, state and releases carry the effort', async () => {
  assert.deepEqual(EFFORT_LEVELS, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(armKey(BASE, 'medium'), BASE, "Opus 5.5's default effort is medium");
  assert.equal(armKey(BASE, null), BASE);
  assert.equal(armKey(BASE, 'low'), LOW);
  assert.equal(armKey(CAND, 'high'), CAND, "Sonnet 5's default effort is high");
  assert.deepEqual(parseArmKey(LOW), { modelId: BASE, effort: 'low' });
  assert.deepEqual(parseArmKey(BASE), { modelId: BASE, effort: null });
  let s = emptyLearningState({ workspaceId: 'ws-1', now: NOW });
  s = record(s, event({ effort: 'low' }));
  s = record(s, event({ effort: 'medium', kind: 'verified-fail' }));
  s = record(s, event({}));
  assert.deepEqual(Object.keys(s.arms[SLICE]).sort(), [BASE, LOW].sort());
  assert.deepEqual([s.arms[SLICE][LOW].successes, s.arms[SLICE][BASE].successes, s.arms[SLICE][BASE].failures], [1, 1, 1]);
  assert.equal(recordRouteOutcome(s, event({ effort: 'extreme' })).reasonCode, 'INVALID_EVENT');
  assert.deepEqual(sliceEvidence(s, SLICE).map((a) => [a.armId, a.modelId, a.effort]), [[BASE, BASE, null], [LOW, BASE, 'low']]);
  assert.deepEqual([armPosterior(s, SLICE, LOW).effort, armPosterior(s, SLICE, LOW).modelId], ['low', BASE]);
  // The state round-trips with its arm keys.
  const home = await mkdtemp(join(tmpdir(), 'jevris-learning-'));
  try {
    await saveLearningState(home, s);
    const loaded = await loadLearningState({ home, workspaceId: 'ws-1' });
    assert.deepEqual(loaded.arms, s.arms);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
  // A signed release may measure a model at several efforts; its default effort names the bare arm.
  const artifact = {
    id: 'cal-effort-1',
    uncertaintyInterval: { lower: 0.5, upper: 0.8, confidenceLevel: 0.9, method: 'beta-posterior' },
    modelQualities: [
      { modelId: BASE, sliceId: SLICE, effort: 'medium', lower: 0.5, point: 0.68, upper: 0.8, sampleSize: 12, meanCostMicroUsd: 2_400_000, meanTokens: 440_000 },
      { modelId: BASE, sliceId: SLICE, effort: 'low', lower: 0.5, point: 0.66, upper: 0.8, sampleSize: 12 },
    ],
  };
  // The router compares models at their default effort only: the low-effort row is route learning's.
  assert.deepEqual(releasedQualities(artifact, SLICE).map((q) => [q.modelId, q.point]), [[BASE, 0.68]]);
  assert.deepEqual(baselinePriorsFromRelease(artifact, SLICE), [
    { sliceId: SLICE, modelId: BASE, rate: 0.68, sampleSize: 12, pseudoCount: 12, sourceId: 'cal-effort-1', meanCostMicroUsd: 2_400_000, meanTokens: 440_000 },
    { sliceId: SLICE, modelId: BASE, effort: 'low', rate: 0.66, sampleSize: 12, pseudoCount: 12, sourceId: 'cal-effort-1' },
  ]);
});

test('C16 effort: a cheaper effort arm of the baseline model switches on local evidence and launches with its effort', async (t) => {
  const r = reconcile(localEvidence(emptyLearningState({ workspaceId: 'ws-1', now: NOW, settings: { explorationRate: 0 } }), [BASE, `${BASE}@low`]), { priors: effortBaseline() });
  assert.equal(r.outcome, 'activated');
  assert.deepEqual(slicePolicy(r.state, SLICE), { mode: 'auto', modelId: BASE, effort: 'low', baselineModelId: BASE, baselineRate: armPosterior(r.state, SLICE, BASE).mean });
  assert.deepEqual([r.version.reason, r.version.reasonCode, r.version.evidence.resourceBasis], ['promotion', 'POSTERIOR_NON_INFERIOR', 'local']);
  const run = await worker(t, { state: r.state });
  assert.equal(run.result.launched, true, JSON.stringify(run.result));
  assert.deepEqual(run.launches, [LOW]);
  assert.deepEqual([run.result.selection.reasonCode, run.result.effort, run.result.learning.effort], ['LEARNED_EFFORT', 'low', 'low']);
  // Only a low-risk route takes the effort arm.
  const held = await worker(t, { state: r.state, risk: 'high' });
  assert.deepEqual([held.result.launched, held.result.reasonCode], [false, 'LEARNING_ADVISE']);
  // An unsupported effort arm stays advise: the same rule, P(worse by more than 7.5%) < 10%.
  const weak = reconcile(localEvidence(emptyLearningState({ workspaceId: 'ws-1', now: NOW }), [BASE, `${BASE}@low`]), { priors: effortBaseline({ low: 0.62 }) });
  assert.deepEqual([weak.outcome, weak.reasonCode], ['no-change', 'NOT_SUPPORTED']);
  // Measured per-arm resources from the release decide the resource check when present.
  // (Local outcomes without resource figures, so the local resource check has nothing to go on.)
  const measured = reconcile(localEvidence(emptyLearningState({ workspaceId: 'ws-1', now: NOW }), [BASE, `${BASE}@low`], MIN_LOCAL_PER_ARM, { resources: false }), { priors: effortBaseline({ measured: true }), authMode: 'subscription' });
  assert.equal(measured.version.evidence.resourceBasis, 'measured');
  const explain = explainSliceLearning(measured.state, SLICE).lines.join('\n');
  assert.match(explain, /^Slice bounded-edit: active, claude-opus-5-5 at low effort \(baseline claude-opus-5-5 at \d+\.\d%\)/m);
  assert.match(explain, /^Baseline claude-opus-5-5 at low effort: 80\.0% from 30 outcomes/m);
  assert.match(explain, /^Resource check for v1: usage-limit consumption \(subscription\), from the release's measured arms; an effort change on one model keeps its cache \(no transition cost\), a model change does not\.$/m);
});

test('C16 effort: an effort change on a cache-keeping model has zero transition cost; a model change does not', async () => {
  const core = await import('../dist/index.js');
  const warm = { registry: REGISTRY, warmPrefixTokens: 200_000, cacheWarm: true, platform: 'claude-api' };
  assert.equal(armTransitionCostMicroUsd({ ...warm, from: { modelId: BASE, effort: null }, to: { modelId: BASE, effort: 'low' } }), 0);
  assert.equal(armTransitionCostMicroUsd({ ...warm, from: { modelId: BASE, effort: 'low' }, to: { modelId: BASE, effort: 'high' } }), 0);
  assert.equal(armTransitionCostMicroUsd({ ...warm, from: { modelId: BASE, effort: 'medium' }, to: { modelId: BASE, effort: null } }), 0);
  assert.ok(armTransitionCostMicroUsd({ ...warm, from: { modelId: BASE, effort: null }, to: { modelId: CAND, effort: null } }) > 0, 'a model has its own cache');
  // Sonnet 5 has no per-message effort: an effort change rewrites its prefix.
  assert.ok(armTransitionCostMicroUsd({ ...warm, from: { modelId: CAND, effort: null }, to: { modelId: CAND, effort: 'low' } }) > 0);
  assert.equal(armTransitionCostMicroUsd({ ...warm, from: { modelId: 'no-such-model', effort: null }, to: { modelId: BASE, effort: null } }), null);
  // No platform defaults to Claude's: per-message effort is a Claude API feature, so elsewhere
  // (Codex, or Opus 5.5 through OpenCode) an effort change rewrites the prefix.
  assert.ok(armTransitionCostMicroUsd({ ...warm, platform: 'opencode', from: { modelId: BASE, effort: null }, to: { modelId: BASE, effort: 'low' } }) > 0);
  assert.deepEqual([core.effortChangeKeepsCache(BASE, REGISTRY, 'claude-api'), core.effortChangeKeepsCache(BASE, REGISTRY, 'codex')], [true, false]);
});

test('C16 effort: demotion is fast and restores the baseline model at its default effort', async (t) => {
  let s = reconcile(localEvidence(emptyLearningState({ workspaceId: 'ws-1', now: NOW, settings: { explorationRate: 0 } }), [BASE, `${BASE}@low`]), { priors: effortBaseline() }).state;
  assert.equal(slicePolicy(s, SLICE).effort, 'low');
  let steps = 0;
  while (slicePolicy(s, SLICE).mode === 'auto' && steps < 30) {
    steps += 1;
    s = reconcile(record(s, event({ effort: 'low', kind: 'verified-fail' }))).state;
  }
  assert.ok(steps <= 10, `demoted after ${String(steps)} failures`);
  const demoted = slicePolicy(s, SLICE);
  assert.deepEqual(demoted, { mode: 'advise', modelId: null, baselineModelId: BASE, baselineRate: demoted.baselineRate });
  assert.equal('effort' in demoted, false, 'no effort: the model default');
  // The posterior, the recent window or the realized cost per verified task, whichever sees it first.
  assert.ok(['POSTERIOR_REGRESSION', 'WINDOW_REGRESSION', 'NOT_CHEAPER_PER_VERIFIED'].includes(s.versions.at(-1).reasonCode), s.versions.at(-1).reasonCode);
  const run = await worker(t, { state: s });
  assert.deepEqual([run.result.launched, run.result.reasonCode, run.result.learning.effort, run.launches], [false, 'LEARNING_ADVISE', null, []]);
  assert.match(explainSliceLearning(s, SLICE).lines[0], /advice only \(managed workers keep the baseline model at its default effort/);
});

test('C16 effort: a pin fixes both the model and the effort; learning never changes it', async (t) => {
  const s0 = reconcile(localEvidence(emptyLearningState({ workspaceId: 'ws-1', now: NOW, settings: { explorationRate: 0.1 } }), [BASE, `${BASE}@low`]), { priors: effortBaseline() }).state;
  const pinned = pinSlice(s0, SLICE, BASE, NOW, 'high');
  assert.deepEqual(slicePolicy(pinned, SLICE), { mode: 'pinned', modelId: BASE, effort: 'high', baselineModelId: null, baselineRate: null });
  assert.equal(reconcile(pinned).reasonCode, 'SLICE_PINNED');
  const run = await worker(t, { state: pinned, random: () => 0 });
  assert.deepEqual([run.result.selection.reasonCode, run.launches, run.result.learning.exploration.reasonCode], ['PINNED_BY_USER', [HIGH], 'SLICE_PINNED']);
  // A pin at the default effort is a pin to the model; an effort without a model, or an unknown one, is refused.
  assert.equal('effort' in slicePolicy(pinSlice(s0, SLICE, BASE, NOW, 'medium'), SLICE), false);
  assert.throws(() => pinSlice(s0, SLICE, null, NOW, 'low'), /invalid effort/);
  assert.throws(() => pinSlice(s0, SLICE, BASE, NOW, 'turbo'), /invalid effort/);
  assert.match(explainSliceLearning(pinned, SLICE).lines[0], /pinned to claude-opus-5-5 at high effort/);
  // Unpinned, the baseline decides again: the cheaper effort arm.
  assert.equal(slicePolicy(reconcile(unpinSlice(pinned, SLICE, NOW)).state, SLICE).effort, 'low');
});

test('C16 effort: a costlier effort activates only as a probable upgrade when no cheaper arm is supported, and is demoted when the gain fades', () => {
  // No cheaper arm, high effort clearly better: an upgrade.
  const up = reconcile(localEvidence(emptyLearningState({ workspaceId: 'ws-1', now: NOW }), [BASE, `${BASE}@high`]), { priors: effortBaseline({ base: 0.55, low: null, high: 0.85 }) });
  assert.equal(up.outcome, 'activated');
  assert.deepEqual([slicePolicy(up.state, SLICE).effort, slicePolicy(up.state, SLICE).direction], ['high', 'upgrade']);
  assert.ok(up.version.evidence.notBetterProbability < 0.1);
  assert.match(explainSliceLearning(up.state, SLICE).lines[0], /at high effort \(an upgrade: probably better, costs more\)/);
  // Only probably better: an equal high effort is not an upgrade, however much evidence says it is equal.
  let equal = emptyLearningState({ workspaceId: 'ws-1', now: NOW, settings: { effortArms: ['high'] } });
  for (let i = 0; i < 300; i += 1) {
    const kind = i % 10 < 7 ? 'verified-pass' : 'verified-fail';
    equal = record(record(equal, event({ effort: 'high', kind })), event({ kind }));
  }
  const eq = reconcile(equal);
  assert.deepEqual([eq.outcome, eq.reasonCode], ['no-change', 'NOT_BETTER']);
  assert.ok(eq.evidence.harmProbability < 0.1 && eq.evidence.notBetterProbability > 0.4);
  // A supported cheaper arm wins over an upgrade.
  const both = reconcile(localEvidence(emptyLearningState({ workspaceId: 'ws-1', now: NOW }), [BASE, `${BASE}@low`, `${BASE}@high`]), { priors: effortBaseline({ base: 0.55, low: 0.8, high: 0.85 }) });
  assert.equal(slicePolicy(both.state, SLICE).effort, 'low');
  // The upgrade is demoted once local outcomes show no gain.
  let s = up.state;
  let steps = 0;
  // Locally, high effort passes 5 in 10 and the default 7 in 10: the gain was not real.
  while (slicePolicy(s, SLICE).mode === 'auto' && steps < 100) {
    steps += 1;
    s = record(s, event({ effort: 'high', kind: steps % 10 < 5 ? 'verified-pass' : 'verified-fail' }));
    s = reconcile(record(s, event({ kind: steps % 10 < 7 ? 'verified-pass' : 'verified-fail' }))).state;
  }
  assert.equal(slicePolicy(s, SLICE).mode, 'advise', `still active after ${String(steps)} rounds`);
  // The switch rested on 12 local outcomes per arm as well as the prior, so it takes a little longer to unwind.
  assert.ok(steps <= 60, `demoted after ${String(steps)} rounds`);
  assert.ok(['POSTERIOR_REGRESSION', 'WINDOW_REGRESSION'].includes(s.versions.at(-1).reasonCode), s.versions.at(-1).reasonCode);
});

test('C16 effort: exploration covers the effort arms of the baseline model only, with exact propensities', () => {
  const s = emptyLearningState({ workspaceId: 'ws-1', now: NOW });
  const picks = new Map();
  for (const r2 of [0, 0.34, 0.67, 0.99]) {
    let call = 0;
    const c = explorationChoice({ state: s, sliceId: SLICE, defaultModelId: BASE, eligibleModelIds: ELIGIBLE, random: () => (call++ === 0 ? 0 : r2), mode: 'bounded-auto', risk: 'low', registry: REGISTRY, nowMs: NOW_MS });
    picks.set(armKey(c.modelId, c.effort), c.propensity);
  }
  assert.deepEqual([...picks.keys()].sort(), [HIGH, LOW, CAND].sort(), 'Sonnet 5 at its default only; Opus 5.5 at low and high');
  // An advise-only slice explores at the 10% cap (DOMAINS 223a21f), shared evenly with no evidence.
  for (const p of picks.values()) assert.ok(Math.abs(p - 0.1 / 3) < 1e-5, String(p));
  // From an active effort arm, the default effort is an alternative.
  let call = 0;
  const back = explorationChoice({ state: s, sliceId: SLICE, defaultModelId: BASE, defaultEffort: 'low', eligibleModelIds: [BASE], random: () => (call++ === 0 ? 0 : 0), mode: 'bounded-auto', risk: 'low', registry: REGISTRY, nowMs: NOW_MS });
  assert.deepEqual([back.modelId, back.effort], [BASE, null]);
  // Haiku 4.5 has no effort levels: a baseline without effort gets no effort arms.
  const haiku = explorationChoice({ state: s, sliceId: SLICE, defaultModelId: 'claude-haiku-4-5-20251001', eligibleModelIds: ['claude-haiku-4-5-20251001'], random: () => 0, mode: 'bounded-auto', risk: 'low', registry: REGISTRY, nowMs: NOW_MS });
  assert.equal(haiku.reasonCode, 'NO_ELIGIBLE_ALTERNATIVE');
});

// ---------------------------------------------------------------------------------------------
// §22.2 economics in use (owner 827fc87): cost and wall time per verified task, per arm, against
// the approved default; a cheaper arm that is not cheaper per verified task returns to the default.

/** The default on a key (3 of 4 verified at $2, 60 s) and a candidate on a subscription, one of whose routes was retried. */
function economicsState() {
  let s = emptyLearningState({ workspaceId: 'ws-1', now: NOW });
  for (const kind of ['verified-pass', 'verified-pass', 'verified-pass', 'verified-fail']) s = record(s, event({ kind, costMicroUsd: 2_000_000, latencyMs: 60_000, authMode: 'api-key' }));
  const sub = { modelId: CAND, costMicroUsd: null, authMode: 'subscription', explored: true, propensity: 0.05 };
  const first = event({ ...sub, apiEquivalentMicroUsd: 500_000, tokens: 1_000_000, latencyMs: 30_000 });
  s = record(s, first);
  s = record(s, event({ ...sub, routeId: first.routeId, kind: 'retried', labelSource: 'retry', receiptId: null, apiEquivalentMicroUsd: 100_000, tokens: 200_000, latencyMs: 10_000 }));
  s = record(s, event({ ...sub, apiEquivalentMicroUsd: 400_000, tokens: 800_000, latencyMs: 20_000 }));
  return s;
}

test('C16 economics: cost and wall time per verified task are recorded per arm, the default included; retries count, and a subscription route counts its API-equivalent estimate', () => {
  const s = economicsState();
  // An event's API-equivalent estimate must be a non-negative number.
  assert.equal(recordRouteOutcome(s, event({ apiEquivalentMicroUsd: -1 })).reasonCode, 'INVALID_EVENT');
  const e = sliceEconomics(s, SLICE, BASE);
  assert.equal(e.defaultArmId, BASE);
  assert.equal(e.minVerified, ECONOMICS_MIN_VERIFIED);
  const [d, c] = e.arms;
  // The default: $8 over 4 routes for 3 verified tasks; 240 s of wall time.
  assert.deepEqual(
    [d.armId, d.isDefault, d.routes, d.verified, d.costPerVerifiedMicroUsd, d.apiEquivalentPerVerifiedMicroUsd, d.wallMsPerVerified, d.costRatioVsDefault],
    [BASE, true, 4, 3, 2_666_667, 2_666_667, 80_000, 1],
  );
  // The candidate: the retried route is a failure whose spend still counts; no billed dollars,
  // $1.00 API-equivalent, 2M tokens and 50 s for its one verified task.
  assert.deepEqual(
    [c.armId, c.isDefault, c.routes, c.verified, c.costPerVerifiedMicroUsd, c.apiEquivalentPerVerifiedMicroUsd, c.tokensPerVerified, c.usagePerVerified, c.wallMsPerVerified],
    [CAND, false, 2, 1, null, 1_000_000, 2_000_000, 2_000_000, 50_000],
  );
  assert.deepEqual([c.costRatioVsDefault, c.wallRatioVsDefault, c.usageRatioVsDefault], [0.375, 0.625, null]);
  // A default with no outcome yet is still listed first, with nothing per verified task.
  const fresh = sliceEconomics(emptyLearningState({ workspaceId: 'ws-1', now: NOW }), SLICE, BASE);
  assert.deepEqual(fresh.arms.map((a) => [a.armId, a.verified, a.apiEquivalentPerVerifiedMicroUsd]), [[BASE, 0, null]]);
});

test('C16 economics: explain shows cost and wall time per verified task for each arm against the default, as lines and as numbers', async () => {
  const s = economicsState();
  const x = explainSliceLearning(s, SLICE);
  assert.equal(x.economics.defaultArmId, BASE, 'the approved default is the registry baseline when the slice names none');
  assert.deepEqual(x.economics.arms.map((a) => a.armId), [BASE, CAND]);
  assert.ok(x.lines.includes(`Per verified task ${BASE}: $2.6667 billed, 1.3 min wall time, 3 verified over 4 routes (the default).`), x.lines.join('\n'));
  const line = x.lines.find((l) => l.startsWith(`Per verified task ${CAND}:`));
  assert.match(line, /\$1\.0000 API-equivalent, 2000000 tokens, 0\.8 min wall time, 1 verified over 2 routes \(vs claude-opus-5-5: cost 0\.3[78]x, usage n\/a, time 0\.63x\)/);
  // The saved state round-trips the figures; a state written before the API-equivalent sums reads its billed costs for them.
  const home = await mkdtemp(join(tmpdir(), 'jevris-learning-'));
  try {
    await saveLearningState(home, s);
    assert.deepEqual(sliceEconomics(await loadLearningState({ home, workspaceId: 'ws-1' }), SLICE, BASE), sliceEconomics(s, SLICE, BASE));
    const old = JSON.parse(JSON.stringify(s));
    for (const arm of Object.values(old.arms[SLICE])) {
      delete arm.equivalentSumMicroUsd;
      delete arm.equivalentCount;
    }
    await writeFile(learningStateFile(home, 'ws-1'), JSON.stringify(old));
    const migrated = sliceEconomics(await loadLearningState({ home, workspaceId: 'ws-1' }), SLICE, BASE);
    assert.deepEqual(migrated.arms.map((a) => a.apiEquivalentPerVerifiedMicroUsd), [2_666_667, null]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

/** A slice activated on day 1 to the cheaper Sonnet 5, then 30 routes on each arm on a key; 3 candidate routes are retried. */
function inPractice(candCostMicroUsd, authMode = 'api-key', tokens = {}) {
  // The guard's local outcomes: all verified, with no resource figures of their own.
  const activated = reconcile(localEvidence(emptyLearningState({ workspaceId: 'ws-1', now: NOW, settings: { explorationRate: 0 } }), [BASE, CAND], MIN_LOCAL_PER_ARM, { resources: false, rates: { [BASE]: 1, [CAND]: 1 } }), { priors: SUPPORTED });
  assert.equal(activated.outcome, 'activated');
  let s = activated.state;
  for (let i = 0; i < 30; i += 1) s = record(s, event({ kind: i < 28 ? 'verified-pass' : 'verified-fail', costMicroUsd: 1_000_000, tokens: tokens.base ?? null, authMode }));
  for (let i = 0; i < 30; i += 1) {
    const e = event({ modelId: CAND, costMicroUsd: candCostMicroUsd, tokens: tokens.cand ?? null, authMode });
    s = record(s, e);
    if (i < 3) s = record(s, event({ routeId: e.routeId, modelId: CAND, kind: 'retried', labelSource: 'retry', receiptId: null, costMicroUsd: candCostMicroUsd, tokens: tokens.cand ?? null, authMode }));
  }
  return reconcile(s, { authMode });
}

test('C16 economics: a cheaper arm that is not cheaper per verified task in practice returns to the default; the same arm at a lower realized cost stays', () => {
  // $0.90 a route looks cheaper than the default's $1.00, but 3 retries make it $1.07 per verified task against $1.05.
  const reverted = inPractice(900_000);
  assert.equal(reverted.outcome, 'demoted');
  assert.equal(reverted.reasonCode, 'NOT_CHEAPER_PER_VERIFIED');
  assert.equal(reverted.version.reason, 'demotion');
  assert.equal(reverted.version.evidence.resourceBasis, 'local');
  assert.deepEqual([reverted.version.evidence.candidate.apiEquivalentPerVerifiedMicroUsd, reverted.version.evidence.baseline.apiEquivalentPerVerifiedMicroUsd], [1_066_154, 1_050_000]);
  assert.deepEqual([slicePolicy(reverted.state, SLICE).mode, slicePolicy(reverted.state, SLICE).modelId], ['advise', null]);
  // It does not come straight back: the same realized economics refuse it again.
  const again = reconcile(reverted.state, { authMode: 'api-key' });
  assert.deepEqual([again.outcome, again.reasonCode], ['no-change', 'NOT_CHEAPER_PER_VERIFIED']);
  // Paired: the same arm, quality and retries at $0.70 a route is $0.83 per verified task, and stays.
  const kept = inPractice(700_000);
  assert.deepEqual([kept.outcome, kept.reasonCode], ['no-change', 'WITHIN_MARGIN']);
  // On a subscription the usage per verified task decides the same way.
  const usage = inPractice(null, 'subscription', { base: 1_000_000, cand: 900_000 });
  assert.deepEqual([usage.outcome, usage.reasonCode], ['demoted', 'MORE_USAGE_PER_VERIFIED']);
  const lessUsage = inPractice(null, 'subscription', { base: 1_000_000, cand: 700_000 });
  assert.deepEqual([lessUsage.outcome, lessUsage.reasonCode], ['no-change', 'WITHIN_MARGIN']);
});

test('C16 economics: the realized economics need enough verified tasks on both arms, and are deterministic', () => {
  const arm = (armId, successes, dollars, usage = null, wall = null) => ({ armId, successes, apiEquivalentPerVerifiedMicroUsd: dollars, usagePerVerified: usage, wallMsPerVerified: wall });
  const min = ECONOMICS_MIN_VERIFIED;
  assert.equal(realizedEconomics(arm(CAND, min - 1, 1), arm(BASE, min, 2), 'api-key'), null);
  assert.equal(realizedEconomics(arm(CAND, min, 1), arm(BASE, min - 1, 2), 'api-key'), null);
  assert.equal(realizedEconomics(arm(CAND, min, null), arm(BASE, min, 2), 'api-key'), null);
  assert.deepEqual(realizedEconomics(arm(CAND, min, 1), arm(BASE, min, 2), 'api-key'), { reason: null });
  assert.deepEqual(realizedEconomics(arm(CAND, min, 2), arm(BASE, min, 2), 'api-key'), { reason: 'NOT_CHEAPER_PER_VERIFIED' });
  assert.deepEqual(realizedEconomics(arm(CAND, min, 1, 11), arm(BASE, min, 2, 10), 'unknown'), { reason: 'MORE_USAGE_PER_VERIFIED' });
  // A subscription: faster per verified task by 10% at no more than 10% more usage still qualifies.
  assert.deepEqual(realizedEconomics(arm(CAND, min, null, 105, 90), arm(BASE, min, null, 100, 100), 'subscription'), { reason: null });
  assert.deepEqual(realizedEconomics(arm(CAND, min, null, 105, 95), arm(BASE, min, null, 100, 100), 'subscription'), { reason: 'MORE_USAGE_PER_VERIFIED' });
  // The same outcomes give the same decision and evidence every time: no model's judgement, no randomness.
  assert.deepEqual(inPractice(900_000).version.evidence, inPractice(900_000).version.evidence);
});

test('C16 economics: an upgrade arm is never reverted for costing more per verified task; it stays on the strict rule', () => {
  const up = reconcile(localEvidence(emptyLearningState({ workspaceId: 'ws-1', now: NOW, settings: { explorationRate: 0 } }), [BASE, `${BASE}@high`]), { priors: effortBaseline({ base: 0.55, low: null, high: 0.85 }) });
  assert.equal(up.outcome, 'activated');
  assert.equal(slicePolicy(up.state, SLICE).direction, 'upgrade');
  let s = up.state;
  for (let i = 0; i < 10; i += 1) s = record(s, event({ costMicroUsd: 1_000_000, authMode: 'api-key' }));
  for (let i = 0; i < 10; i += 1) s = record(s, event({ effort: 'high', costMicroUsd: 3_000_000, authMode: 'api-key' }));
  const r = reconcile(s, { authMode: 'api-key' });
  assert.deepEqual([r.outcome, r.reasonCode], ['no-change', 'WITHIN_MARGIN']);
  assert.ok(r.evidence.candidate.apiEquivalentPerVerifiedMicroUsd > r.evidence.baseline.apiEquivalentPerVerifiedMicroUsd);
});

test('C16 no baseline: every arm starts from Beta(1/2, 1/2), nothing activates, and the default serves every route that does not explore', () => {
  const s = emptyLearningState({ workspaceId: 'ws-1', now: NOW });
  for (const arm of [BASE, CAND, `${BASE}@low`, `${BASE}@high`]) {
    const p = armPosterior(s, SLICE, arm);
    assert.deepEqual([p.alpha, p.beta, p.mean, p.prior.pseudoCount, p.prior.sourceId], [0.5, 0.5, 0.5, 0, null]);
  }
  const r = reconcile(s, { priors: null });
  assert.equal(r.outcome, 'no-change');
  assert.equal(slicePolicy(r.state, SLICE).mode, 'advise');
  const choose = (random) => explorationChoice({ state: s, sliceId: SLICE, defaultModelId: BASE, eligibleModelIds: ELIGIBLE, random, mode: 'bounded-auto', risk: 'low', registry: REGISTRY, nowMs: NOW_MS });
  // 90% of low-risk routes while the slice is advise-only: the default at its default effort.
  const kept = choose(() => 0.5);
  assert.deepEqual([kept.modelId, kept.effort, kept.explored, kept.reasonCode, kept.propensity], [BASE, null, false, 'DEFAULT', 0.9]);
  // 10% (the cap while advise-only): one of the other arms, each weighted by its posterior, with an exact propensity.
  let call = 0;
  const explored = choose(() => (call++ === 0 ? 0 : 0.5));
  assert.equal(explored.explored, true);
  assert.ok(explored.propensity > 0 && explored.propensity < 0.1);
  // Anything but a low-risk bounded-auto route keeps the default.
  assert.equal(explorationChoice({ state: s, sliceId: SLICE, defaultModelId: BASE, eligibleModelIds: ELIGIBLE, random: () => 0, mode: 'bounded-auto', risk: 'high' }).modelId, BASE);
});

test('C16 guard: explain and status name the local-evidence guard: how many more local outcomes each arm needs before any switch', () => {
  let s = localEvidence(emptyLearningState({ workspaceId: 'ws-1', now: NOW }), [BASE], 5);
  s = localEvidence(s, [`${BASE}@low`], 3);
  const x = explainSliceLearning(s, SLICE);
  assert.equal(x.guard.minLocalPerArm, MIN_LOCAL_PER_ARM);
  assert.deepEqual(x.guard.waiting, [{ armId: BASE, local: 5, remaining: MIN_LOCAL_PER_ARM - 5 }, { armId: `${BASE}@low`, local: 3, remaining: MIN_LOCAL_PER_ARM - 3 }]);
  assert.ok(x.lines.includes(`Waiting for ${String(MIN_LOCAL_PER_ARM - 5)} more local outcomes on claude-opus-5-5 (the default) before any switch.`), x.lines.join('\n'));
  assert.ok(x.lines.includes(`Waiting for ${String(MIN_LOCAL_PER_ARM - 3)} more local outcomes on claude-opus-5-5 at low effort before a switch to it.`), x.lines.join('\n'));
  // A high-risk route (no propensity) is not randomized and earns no guard credit.
  const unlogged = record(s, event({ risk: 'high', propensity: null }));
  assert.equal(explainSliceLearning(unlogged, SLICE).guard.waiting[0].local, 5);
  // Once switched, and on a pinned slice or with learning off, there is nothing to wait for.
  const switched = reconcile(localEvidence(emptyLearningState({ workspaceId: 'ws-1', now: NOW }), [BASE, CAND]), { priors: SUPPORTED }).state;
  assert.equal(slicePolicy(switched, SLICE).mode, 'auto');
  assert.equal(explainSliceLearning(switched, SLICE).guard, null);
  assert.equal(explainSliceLearning(switched, SLICE).lines.some((l) => l.startsWith('Waiting for')), false);
  assert.equal(explainSliceLearning(pinSlice(s, SLICE, BASE, NOW), SLICE).guard, null);
  assert.equal(explainSliceLearning({ ...s, settings: learningSettings({ enabled: false }) }, SLICE).guard, null);
  // A state saved before the guard's count existed counts it again from the raw window.
  const { randomizedLabelled: _dropped, ...old } = s.arms[SLICE][BASE];
  const reparsed = parseLearningState(JSON.parse(JSON.stringify({ ...s, arms: { [SLICE]: { ...s.arms[SLICE], [BASE]: old } } })));
  assert.equal(reparsed.arms[SLICE][BASE].randomizedLabelled, 5);
});
