// Sonnet-first routing where people look (owner decision 2026-09-30, visibility): the pure helpers
// behind `jevris status`, `jevris explain --slice` and `jevris cost-report`. They must answer from
// the router's own functions: the same verdict, the same exploration shares, the same ladder.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUNDLED_MODEL_REGISTRY as REGISTRY,
  DEFAULT_LEARNING_SETTINGS as SETTINGS,
  EMPTY_FIRST_TRY_HISTORY,
  EMPTY_FIRST_TRY_STATS,
  filterCandidates,
  firstTryPhase,
  firstTryShares,
  firstTryVerdict,
  decideFirstTry,
  harnessFirstTry,
  nextTaskShare,
} from '../dist/index.js';

const VOLUME = { inputTokens: 150_000, outputTokens: 20_000 };
const OVERHEAD = { verificationMicroUsd: 0 };
const NOW = Date.parse('2026-10-01T00:00:00Z');
const stats = (over) => ({ ...EMPTY_FIRST_TRY_STATS, ...over });

const phaseTable = [
  ['the day-1 prior rule is "learning"', { mode: 'first-try', reasonCode: 'DAY_1_PRIOR' }, 'learning'],
  ['a first-try verdict that pays', { mode: 'first-try', reasonCode: 'FIRST_TRY_WORTH_IT' }, 'first-try'],
  ['held by the anti-flap floor on first-try', { mode: 'first-try', reasonCode: 'ANTI_FLAP' }, 'first-try'],
  ['held by the anti-flap floor on baseline', { mode: 'baseline', reasonCode: 'ANTI_FLAP' }, 'baseline-first'],
  ['demoted below break-even', { mode: 'baseline', reasonCode: 'FIRST_TRY_BELOW_BREAK_EVEN' }, 'baseline-first'],
  ['demoted as not cheaper per verified task', { mode: 'baseline', reasonCode: 'NOT_CHEAPER_PER_VERIFIED' }, 'baseline-first'],
  ['demoted as worse than the baseline', { mode: 'baseline', reasonCode: 'WORSE_THAN_BASELINE' }, 'baseline-first'],
  ['baseline first, not yet proven', { mode: 'baseline', reasonCode: 'BASELINE_FIRST_NOT_PROVEN' }, 'baseline-first'],
];
for (const [name, verdict, expected] of phaseTable) {
  test(`firstTryPhase: ${name}`, () => {
    assert.equal(firstTryPhase(verdict), expected);
  });
}

test('firstTryPhase follows firstTryVerdict on real histories: learning under the floor, first-try when it pays, baseline-first after five failures', () => {
  const candidate = { breakEven: 0.5, overheadMicroUsd: 0 };
  const settings = { nonInferiorityMargin: SETTINGS.nonInferiorityMargin, activateBelow: SETTINGS.activateBelow, deactivateAbove: SETTINGS.deactivateAbove, flapFloor: SETTINGS.flapFloor, minLocalPerArm: SETTINGS.minLocalPerArm };
  const phase = (firstTry) => firstTryPhase(firstTryVerdict({ history: { ...EMPTY_FIRST_TRY_HISTORY, firstTry: stats(firstTry) }, candidate, settings }));
  assert.equal(phase({}), 'learning');
  assert.equal(phase({ tasks: 4, firstAttemptPass: 4, verified: 4 }), 'learning');
  assert.equal(phase({ tasks: 5, firstAttemptPass: 5, verified: 5 }), 'first-try');
  assert.equal(phase({ tasks: 5, firstAttemptFail: 5, escalated: 5, verified: 5 }), 'baseline-first');
});

const sharesTable = [
  ['defaults, control under the floor', { ...SETTINGS }, 0, { cap: 0.1, control: 0.1 }],
  ['defaults, control at the floor', { ...SETTINGS }, SETTINGS.flapFloor, { cap: 0.1, control: 0.05 }],
  ['exploration off', { ...SETTINGS, explorationRate: 0, adviseExplorationRate: 0 }, 50, { cap: 0, control: 0 }],
  ['an advise rate above the 10% cap is capped', { ...SETTINGS, adviseExplorationRate: 0.5, explorationRate: 0.3 }, 50, { cap: 0.1, control: 0.1 }],
  ['a negative rate reads as zero', { ...SETTINGS, adviseExplorationRate: -1, explorationRate: -1 }, 0, { cap: 0, control: 0 }],
];
for (const [name, settings, controlTasks, expected] of sharesTable) {
  test(`firstTryShares: ${name}`, () => {
    assert.deepEqual(firstTryShares(settings, { control: stats({ tasks: controlTasks }) }), expected);
  });
}

test('nextTaskShare: the control share while on first-try, the exploration share of the first try while on baseline', () => {
  const shares = { cap: 0.1, control: 0.05 };
  assert.deepEqual(nextTaskShare({ mode: 'first-try' }, shares), { arm: 'control', share: 0.05 });
  assert.deepEqual(nextTaskShare({ mode: 'baseline' }, shares), { arm: 'first-try', share: 0.1 });
});

function eligible() {
  const providers = [...new Set(REGISTRY.entries.map((e) => e.provider))];
  return filterCandidates(REGISTRY, { managedAllowlist: null, allowedRegions: ['global'], requiredContextTokens: 0, requiredCapabilities: [], pins: { modelPin: null, effortPin: null }, riskFloorFamilies: null, accountId: null, locallyEligible: REGISTRY.entries.map((e) => e.modelId), automated: true, consentedProviders: providers, nowMs: NOW }).eligible;
}

test('the assignment still draws against the shares the views report (decideFirstTry is unchanged by sharing them)', () => {
  const decide = (history, random) =>
    decideFirstTry({ setting: 'auto', risk: 'low', automated: true, learningEnabled: true, eligible: eligible(), baselineModelId: 'claude-opus-5-5', volume: VOLUME, overhead: OVERHEAD, history, settings: SETTINGS, random: () => random });
  // First-try slice, control under the floor: the control share is the 10% cap.
  const young = decide(EMPTY_FIRST_TRY_HISTORY, 0.05);
  assert.deepEqual([young.route, young.propensity, young.verdict.mode], ['control', 0.1, 'first-try']);
  assert.equal(decide(EMPTY_FIRST_TRY_HISTORY, 0.1).route, 'first-try');
  // Control at the floor: 5%.
  const settled = { ...EMPTY_FIRST_TRY_HISTORY, control: stats({ tasks: SETTINGS.flapFloor }) };
  assert.deepEqual([decide(settled, 0.04).route, decide(settled, 0.04).propensity], ['control', 0.05]);
  assert.equal(decide(settled, 0.05).route, 'first-try');
  assert.deepEqual(firstTryShares(SETTINGS, settled), { cap: 0.1, control: 0.05 });
});

const harnessTable = [
  ['claude', { on: true, first: 'claude-sonnet-5-5', baseline: 'claude-opus-5-5' }],
  ['codex', { on: true, first: 'gpt-6-luna', baseline: 'gpt-6.1-sol' }],
  ['antigravity', { on: false, reasonCode: 'NO_CHEAPER_RUNG', baseline: 'gemini-3.8-flash', strongerIsPreview: true }],
  // Kilo and OpenCode have no default of their own: the registry's baseline, so the Claude ladder.
  ['kilocode', { on: true, first: 'claude-sonnet-5-5', baseline: 'claude-opus-5-5' }],
  ['opencode', { on: true, first: 'claude-sonnet-5-5', baseline: 'claude-opus-5-5' }],
];
for (const [harness, want] of harnessTable) {
  test(`harnessFirstTry: ${harness} from the real registry`, () => {
    const got = harnessFirstTry({ registry: REGISTRY, harness, volume: VOLUME, overhead: OVERHEAD, nowMs: NOW });
    assert.equal(got.harness, harness);
    assert.equal(got.baselineModelId, want.baseline);
    assert.equal(got.on, want.on);
    if (want.on) {
      assert.equal(got.candidate.modelId, want.first);
      assert.ok(got.candidate.stepUpModelIds.includes(want.baseline));
      assert.ok(got.candidate.breakEven <= 0.75);
    } else {
      assert.deepEqual([got.reasonCode, got.strongerIsPreview], [want.reasonCode, want.strongerIsPreview]);
    }
  });
}

test('harnessFirstTry: a retired or unavailable first-try model is not a rung, so the next cheaper active model is', () => {
  const retire = (modelId, patch) => ({ ...REGISTRY, entries: REGISTRY.entries.map((e) => (e.modelId === modelId ? { ...e, ...patch(e) } : e)) });
  const retired = retire('claude-sonnet-5-5', (e) => ({ lifecycle: { ...e.lifecycle, status: 'retired' } }));
  assert.equal(harnessFirstTry({ registry: retired, harness: 'claude', volume: VOLUME, overhead: OVERHEAD, nowMs: NOW }).candidate.modelId, 'claude-haiku-4-5-20251001');
  const unavailable = retire('claude-sonnet-5-5', () => ({ health: 'unavailable' }));
  assert.equal(harnessFirstTry({ registry: unavailable, harness: 'claude', volume: VOLUME, overhead: OVERHEAD, nowMs: NOW }).candidate.modelId, 'claude-haiku-4-5-20251001');
});

test('harnessFirstTry: with no preview above its baseline the harness says its stronger model is not a preview; a harness the registry does not reach is off with its baseline', () => {
  const noPreview = { ...REGISTRY, entries: REGISTRY.entries.filter((e) => e.lifecycle?.status !== 'preview') };
  const got = harnessFirstTry({ registry: noPreview, harness: 'antigravity', volume: VOLUME, overhead: OVERHEAD, nowMs: NOW });
  assert.deepEqual([got.on, got.reasonCode, got.strongerIsPreview], [false, 'NO_CHEAPER_RUNG', false]);
  const unreached = harnessFirstTry({ registry: { ...REGISTRY, harnessAccess: [] }, harness: 'claude', volume: VOLUME, overhead: OVERHEAD, nowMs: NOW });
  assert.deepEqual([unreached.on, unreached.reasonCode, unreached.baselineModelId], [false, 'BASELINE_NOT_ELIGIBLE', 'claude-opus-5-5']);
});
