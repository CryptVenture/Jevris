// Sonnet-first routing (owner decision 2026-09-30): the ladder, the break-even, the verdict and
// the route's assignment, from the real bundled registry. Pure: no provider, no file, no clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUNDLED_MODEL_REGISTRY as REGISTRY,
  DEFAULT_LEARNING_SETTINGS as SETTINGS,
  EMPTY_FIRST_TRY_HISTORY,
  EMPTY_FIRST_TRY_STATS,
  breakEven,
  costPerVerified,
  decideFirstTry,
  filterCandidates,
  firstTryCandidate,
  firstTryNote,
  firstTryVerdict,
  routeBaseline,
  stepUpTarget,
} from '../dist/index.js';

const VOLUME = { inputTokens: 150_000, outputTokens: 20_000 };
const OVERHEAD = { verificationMicroUsd: 0 };
const PROVIDERS = [...new Set(REGISTRY.entries.map((e) => e.provider))];

/** Every model the router's gates let through when local evidence exists for all of them. */
function eligible(extra = {}) {
  return filterCandidates(REGISTRY, {
    managedAllowlist: null,
    allowedRegions: ['global'],
    requiredContextTokens: 0,
    requiredCapabilities: [],
    pins: { modelPin: null, effortPin: null },
    riskFloorFamilies: null,
    accountId: null,
    locallyEligible: REGISTRY.entries.map((e) => e.modelId),
    automated: true,
    consentedProviders: PROVIDERS,
    nowMs: Date.parse('2026-09-30T00:00:00Z'),
    ...extra,
  }).eligible;
}

const stats = (over) => ({ ...EMPTY_FIRST_TRY_STATS, ...over });
const SETTLED = { nonInferiorityMargin: SETTINGS.nonInferiorityMargin, activateBelow: SETTINGS.activateBelow, deactivateAbove: SETTINGS.deactivateAbove, flapFloor: SETTINGS.flapFloor, minLocalPerArm: SETTINGS.minLocalPerArm };

test('ladder: Claude Code starts on Sonnet 5.5 and hands off to Opus 5.5 (from the real registry)', () => {
  const baseline = routeBaseline(REGISTRY, 'claude', null);
  assert.equal(baseline, 'claude-opus-5-5');
  const c = firstTryCandidate({ eligible: eligible(), baselineModelId: baseline, volume: VOLUME, overhead: OVERHEAD });
  assert.equal('none' in c, false);
  assert.equal(c.modelId, 'claude-sonnet-5-5');
  assert.deepEqual([...c.stepUpModelIds], ['claude-opus-5-5', 'claude-fable-5-1']);
  assert.ok(Math.abs(c.breakEven - 0.5) < 1e-9, `Sonnet costs half of Opus per attempt: ${c.breakEven}`);
  assert.ok(!c.ladder.some((r) => r.modelId === 'claude-sonnet-5' && r.status !== 'legacy'), 'a legacy model is not an active rung');
});

test('ladder: Codex starts on GPT-6 Luna (same family) and Antigravity has no first try (no cheaper rung, preview above)', () => {
  const codex = firstTryCandidate({ eligible: eligible(), baselineModelId: routeBaseline(REGISTRY, 'codex', null), volume: VOLUME, overhead: OVERHEAD });
  assert.equal(codex.modelId, 'gpt-6-luna');
  assert.equal(codex.chosenBy, 'family');
  assert.equal(codex.stepUpModelIds[0], 'gpt-6-sol');
  assert.ok(!codex.stepUpModelIds.includes('gpt-5.6-luna'), 'only rungs dearer than the baseline are fallbacks');
  const agy = firstTryCandidate({ eligible: eligible(), baselineModelId: routeBaseline(REGISTRY, 'antigravity', null), volume: VOLUME, overhead: OVERHEAD });
  assert.deepEqual(agy, { none: true, reasonCode: 'NO_CHEAPER_RUNG' });
});

test('ladder: a model the router left out (not eligible here, preview, consent) is never a rung', () => {
  const noSonnet = eligible({ locallyEligible: ['claude-opus-5-5', 'claude-haiku-4-5-20251001'] });
  const c = firstTryCandidate({ eligible: noSonnet, baselineModelId: 'claude-opus-5-5', volume: VOLUME, overhead: OVERHEAD });
  assert.equal(c.modelId, 'claude-haiku-4-5-20251001', 'with no evidence for Sonnet 5.5 the next eligible rung stands');
  const none = firstTryCandidate({ eligible: eligible({ locallyEligible: ['claude-opus-5-5'] }), baselineModelId: 'claude-opus-5-5', volume: VOLUME, overhead: OVERHEAD });
  assert.deepEqual(none, { none: true, reasonCode: 'NO_CHEAPER_RUNG' });
  const offline = firstTryCandidate({ eligible: eligible({ locallyEligible: ['claude-sonnet-5-5'] }), baselineModelId: 'claude-opus-5-5', volume: VOLUME, overhead: OVERHEAD });
  assert.deepEqual(offline, { none: true, reasonCode: 'BASELINE_NOT_ELIGIBLE' });
  // Another vendor is never a first try for this baseline.
  const c2 = firstTryCandidate({ eligible: eligible(), baselineModelId: 'gemini-3.8-flash', volume: VOLUME, overhead: OVERHEAD });
  assert.deepEqual(c2, { none: true, reasonCode: 'NO_CHEAPER_RUNG' });
});

test('break-even: p* = (cS + h) / (cO + h), so overhead makes the rule stricter, and a dearer first try is refused', () => {
  assert.equal(breakEven({ firstTryAttemptMicroUsd: 500, stepUpAttemptMicroUsd: 1000, overheadMicroUsd: 0 }), 0.5);
  const withOverhead = breakEven({ firstTryAttemptMicroUsd: 500, stepUpAttemptMicroUsd: 1000, overheadMicroUsd: 500 });
  assert.ok(Math.abs(withOverhead - 2 / 3) < 1e-9);
  assert.equal(breakEven({ firstTryAttemptMicroUsd: 1000, stepUpAttemptMicroUsd: 1000, overheadMicroUsd: 0 }), 1);
  // Overhead that pushes the break-even above the cap removes the candidate.
  const heavy = firstTryCandidate({ eligible: eligible(), baselineModelId: 'claude-opus-5-5', volume: VOLUME, overhead: { verificationMicroUsd: 10_000_000 } });
  assert.deepEqual(heavy, { none: true, reasonCode: 'BREAK_EVEN_TOO_HIGH' });
});

test('verdict: prior-only under the anti-flap floor, demotes a first try that fails too often, and never invents quality', () => {
  const candidate = firstTryCandidate({ eligible: eligible(), baselineModelId: 'claude-opus-5-5', volume: VOLUME, overhead: OVERHEAD });
  const day1 = firstTryVerdict({ history: EMPTY_FIRST_TRY_HISTORY, candidate, settings: SETTLED });
  assert.equal(day1.mode, 'first-try');
  assert.equal(day1.reasonCode, 'DAY_1_PRIOR');
  assert.equal(day1.pBelowBreakEven, null, 'no outcomes: no posterior claim');
  const four = firstTryVerdict({ history: { ...EMPTY_FIRST_TRY_HISTORY, firstTry: stats({ tasks: 4, firstAttemptFail: 4 }) }, candidate, settings: SETTLED });
  assert.equal(four.mode, 'first-try', 'under 5 labelled tasks the prior rule stands');
  const bad = firstTryVerdict({ history: { ...EMPTY_FIRST_TRY_HISTORY, firstTry: stats({ tasks: 5, firstAttemptFail: 5, escalated: 5, verified: 5 }) }, candidate, settings: SETTLED });
  assert.equal(bad.mode, 'baseline');
  assert.equal(bad.reasonCode, 'FIRST_TRY_BELOW_BREAK_EVEN');
  assert.equal(bad.changed, true);
  assert.ok(bad.pBelowBreakEven > SETTINGS.deactivateAbove);
  const good = firstTryVerdict({ history: { ...EMPTY_FIRST_TRY_HISTORY, firstTry: stats({ tasks: 6, firstAttemptPass: 6, verified: 6 }) }, candidate, settings: SETTLED });
  assert.equal(good.mode, 'first-try');
  assert.equal(good.reasonCode, 'FIRST_TRY_WORTH_IT');
  assert.equal(good.changed, false);
});

test('verdict: the cost of the hand-off counts. A first try that verifies but costs more per verified task than the control goes back', () => {
  const candidate = firstTryCandidate({ eligible: eligible(), baselineModelId: 'claude-opus-5-5', volume: VOLUME, overhead: OVERHEAD });
  const firstTry = stats({ tasks: 8, firstAttemptPass: 6, firstAttemptFail: 2, escalated: 2, verified: 8, costMicroUsd: 8 * 1_300_000, costKnownTasks: 8 });
  const control = stats({ tasks: 6, verified: 6, costMicroUsd: 6 * 1_000_000, costKnownTasks: 6 });
  assert.ok(costPerVerified(firstTry) > costPerVerified(control));
  const v = firstTryVerdict({ history: { firstTry, control, state: null }, candidate, settings: SETTLED });
  assert.equal(v.mode, 'baseline');
  assert.equal(v.reasonCode, 'NOT_CHEAPER_PER_VERIFIED');
  // The same history with a cheaper first try stays on first-try.
  const cheap = firstTryVerdict({ history: { firstTry: { ...firstTry, costMicroUsd: 8 * 700_000 }, control, state: null }, candidate, settings: SETTLED });
  assert.equal(cheap.mode, 'first-try');
});

test('verdict: anti-flap after a change, and coming back needs 12 finished tasks and P(below break-even) under 0.10', () => {
  const candidate = firstTryCandidate({ eligible: eligible(), baselineModelId: 'claude-opus-5-5', volume: VOLUME, overhead: OVERHEAD });
  const demoted = { mode: 'baseline', changedAtFinished: 5 };
  const flap = firstTryVerdict({ history: { firstTry: stats({ tasks: 8, firstAttemptPass: 8, verified: 8 }), control: EMPTY_FIRST_TRY_STATS, state: demoted }, candidate, settings: SETTLED });
  assert.equal(flap.mode, 'baseline');
  assert.equal(flap.reasonCode, 'ANTI_FLAP');
  const few = firstTryVerdict({ history: { firstTry: stats({ tasks: 11, firstAttemptPass: 11, verified: 11 }), control: EMPTY_FIRST_TRY_STATS, state: { mode: 'baseline', changedAtFinished: 5 } }, candidate, settings: SETTLED });
  assert.equal(few.mode, 'baseline', 'under 12 finished tasks it does not come back');
  assert.equal(few.reasonCode, 'BASELINE_FIRST_NOT_PROVEN');
  const back = firstTryVerdict({ history: { firstTry: stats({ tasks: 14, firstAttemptPass: 14, verified: 14 }), control: EMPTY_FIRST_TRY_STATS, state: { mode: 'baseline', changedAtFinished: 5 } }, candidate, settings: SETTLED });
  assert.equal(back.mode, 'first-try');
  assert.equal(back.changed, true);
});

test('route: only a low-risk, automated route with learning on is assigned; the assignment is randomized with its propensity', () => {
  const base = { setting: 'auto', risk: 'low', automated: true, learningEnabled: true, eligible: eligible(), baselineModelId: 'claude-opus-5-5', volume: VOLUME, overhead: OVERHEAD, history: EMPTY_FIRST_TRY_HISTORY, settings: SETTINGS };
  for (const [over, code] of [[{ setting: 'baseline' }, 'FIRST_TRY_OFF'], [{ risk: 'medium' }, 'RISK_NOT_LOW'], [{ risk: 'high' }, 'RISK_NOT_LOW'], [{ risk: 'unknown' }, 'RISK_NOT_LOW'], [{ automated: false }, 'NOT_AUTOMATED'], [{ learningEnabled: false }, 'LEARNING_OFF']]) {
    const d = decideFirstTry({ ...base, ...over, random: () => 0.99 });
    assert.equal(d.route, 'baseline', code);
    assert.equal(d.reasonCode, code);
  }
  const ft = decideFirstTry({ ...base, random: () => 0.5 });
  assert.equal(ft.route, 'first-try');
  assert.equal(ft.reasonCode, 'FIRST_TRY');
  assert.equal(ft.candidate.modelId, 'claude-sonnet-5-5');
  assert.ok(Math.abs(ft.propensity - 0.9) < 1e-9, 'control takes the 10% cap until it has 5 tasks');
  const ctl = decideFirstTry({ ...base, random: () => 0.05 });
  assert.equal(ctl.route, 'control');
  assert.equal(ctl.reasonCode, 'FIRST_TRY_CONTROL');
  const established = decideFirstTry({ ...base, history: { ...EMPTY_FIRST_TRY_HISTORY, control: stats({ tasks: 5, verified: 5 }) }, random: () => 0.07 });
  assert.equal(established.route, 'first-try', 'once the control has 5 tasks its share is the 5% rate');
  // After a demotion the first try is the explored arm at the 10% cap.
  const demoted = { ...EMPTY_FIRST_TRY_HISTORY, state: { mode: 'baseline', changedAtFinished: 5 }, firstTry: stats({ tasks: 5, firstAttemptFail: 5 }) };
  const explored = decideFirstTry({ ...base, history: demoted, random: () => 0.05 });
  assert.equal(explored.route, 'first-try');
  assert.equal(explored.reasonCode, 'FIRST_TRY_EXPLORED');
  const held = decideFirstTry({ ...base, history: demoted, random: () => 0.5 });
  assert.equal(held.route, 'control');
  const note = firstTryNote(ft);
  assert.equal(note.firstTryModelId, 'claude-sonnet-5-5');
  assert.equal(note.baselineModelId, 'claude-opus-5-5');
  assert.equal(firstTryNote({ route: 'baseline', reasonCode: 'RISK_NOT_LOW' }), null);
});

test('hand-off target: the baseline, else the next dearer rung; none when nothing stronger can run', () => {
  assert.equal(stepUpTarget(['claude-opus-5-5', 'claude-fable-5-1'], new Set()), 'claude-opus-5-5');
  assert.equal(stepUpTarget(['claude-opus-5-5', 'claude-fable-5-1'], new Set(['claude-opus-5-5'])), 'claude-fable-5-1');
  assert.equal(stepUpTarget(['claude-opus-5-5'], new Set(['claude-opus-5-5'])), null);
});
