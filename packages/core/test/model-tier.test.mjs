// Tiered routing (owner decision 2026-10-08): the shared, pure, provider-neutral model tier. The rules table, the floor and
// ceiling, and the ladder of every harness's own models from the real bundled registry: an Anthropic session gets Anthropic
// rungs, a Codex session OpenAI's, an Antigravity session Google's, a Kilo or OpenCode session whatever provider it runs. No
// provider, no file, no clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUNDLED_MODEL_REGISTRY as REGISTRY,
  DEFAULT_TASK_VOLUME,
  TIER_JEV_LABEL,
  TIER_RULES_LABEL,
  buildTierLadder,
  filterCandidates,
  harnessHasDefault,
  hasTierSignals,
  judgeModelTier,
  modelTierQuestions,
  rulesTier,
  sessionBaseline,
  tierNoteOf,
  tierSignalsOf,
} from '../dist/index.js';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const PROVIDERS = [...new Set(REGISTRY.entries.map((e) => e.provider))];
const providerOf = (id) => REGISTRY.entries.find((e) => e.modelId === id).provider;

/** Every model the router's gates let through when local evidence exists for all of them (zero-data-retention not required). */
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
    nowMs: NOW,
    ...extra,
  }).eligible;
}

const ladderOf = (baselineModelId, models = eligible()) => buildTierLadder({ eligible: models, baselineModelId, volume: DEFAULT_TASK_VOLUME });
const idsOf = (ladder) => ladder.candidates.map((c) => c.modelId);

/** A signal set with every field at its quiet default. */
const quiet = (over = {}) => ({ ...tierSignalsOf({ hints: {} }), ...over });
const tierOf = (hints, extra = {}) => rulesTier(tierSignalsOf({ hints, ...extra }));

test('rules: very hard work steps up, each on its own signal', async () => {
  const up = (name, got, code) => {
    assert.equal(got.tier, 'step-up', name);
    assert.ok(got.reasons.includes(code), `${name}: ${JSON.stringify(got.reasons)}`);
  };
  up('auth path', tierOf({ paths: ['src/auth/login.ts'], checkIds: ['test'] }), 'TIER_PROTECTED_PATH');
  up('secrets path', tierOf({ paths: ['config/.env'], checkIds: ['test'] }), 'TIER_PROTECTED_PATH');
  up('ci path', tierOf({ paths: ['.github/workflows/ci.yml'], checkIds: ['test'] }), 'TIER_PROTECTED_PATH');
  up('migrations path', tierOf({ paths: ['db/migrations/001.sql'], checkIds: ['test'] }), 'TIER_PROTECTED_PATH');
  up('a protected reason code alone (a glob scope)', rulesTier(quiet({ files: 1, riskReasons: ['PROTECTED_DEPLOY'], risk: 'high' })), 'TIER_PROTECTED_PATH');
  up('a migration', tierOf({ title: 'migrate the billing tables to the new schema', paths: ['src/a.ts'], checkIds: ['test'] }), 'TIER_MIGRATION');
  up('a refactor over 8 files', rulesTier(quiet({ sliceId: 'refactor', files: 9, checks: 1, risk: 'medium' })), 'TIER_WIDE_CHANGE');
  up('a feature over 8 files', rulesTier(quiet({ sliceId: 'feature', files: 12, checks: 1, risk: 'medium' })), 'TIER_WIDE_CHANGE');
  up('an unbounded scope on a feature', rulesTier(quiet({ sliceId: 'feature', files: 1, riskReasons: ['SCOPE_UNBOUNDED'], risk: 'medium' })), 'TIER_WIDE_CHANGE');
  up('the same failure at the repair limit, not environmental', rulesTier(quiet({ files: 2, checks: 1, failedAttempts: 3, maxRepairAttempts: 3 })), 'TIER_REPEATED_FAILURE');
  up('a failed run on the baseline', rulesTier(quiet({ files: 2, checks: 1, baselineRunFailed: true })), 'TIER_BASELINE_FAILED');
  up('a plan 4 deep', rulesTier(quiet({ files: 2, checks: 1, planDepth: 4 })), 'TIER_DEEP_PLAN');
  up('a blocked hand-off', rulesTier(quiet({ files: 2, checks: 1, handOffBlocked: true })), 'TIER_HANDOFF_BLOCKED');
});

test('rules: what is NOT a step up', async () => {
  // A lockfile-only protected change is not a step up (owner decision 7), and it is not low risk either.
  const lock = tierOf({ paths: ['package-lock.json'], checkIds: ['test'] });
  assert.equal(lock.tier, 'baseline');
  assert.ok(!lock.reasons.includes('TIER_PROTECTED_PATH'));
  assert.equal(rulesTier(quiet({ files: 1, checks: 1, riskReasons: ['PROTECTED_LOCKFILE'], risk: 'high', protectedClasses: ['PROTECTED_LOCKFILE'] })).tier, 'baseline');
  // A lockfile beside an auth file is a step up, by the auth file.
  assert.equal(tierOf({ paths: ['package-lock.json', 'src/auth/token.ts'], checkIds: ['test'] }).tier, 'step-up');
  // Exactly 8 files is not over 8; plan depth 3 is not 4; fewer failures than the limit, or an environmental one, is not a step up.
  assert.equal(rulesTier(quiet({ sliceId: 'refactor', files: 8, checks: 1, risk: 'medium' })).tier, 'baseline');
  assert.equal(rulesTier(quiet({ files: 2, checks: 1, planDepth: 3, risk: 'medium' })).tier, 'baseline');
  assert.equal(rulesTier(quiet({ files: 2, checks: 1, failedAttempts: 2, maxRepairAttempts: 3, risk: 'medium' })).tier, 'baseline');
  assert.equal(rulesTier(quiet({ files: 2, checks: 1, failedAttempts: 3, maxRepairAttempts: 3, failureEnvironmental: true, risk: 'medium' })).tier, 'baseline');
  // A wide change of another kind (a bug fix across 12 files) is the baseline's to do.
  assert.equal(rulesTier(quiet({ sliceId: 'issue-fix', files: 12, checks: 1, risk: 'medium' })).tier, 'baseline');
});

test('rules: a step down only for read-only work, or low risk with a check and at most 5 files', async () => {
  const docs = tierOf({ paths: ['docs/guide.md', 'README.md'], checkIds: [] });
  assert.deepEqual([docs.tier, docs.reasons, docs.settled], ['step-down', ['TIER_READ_ONLY_WORK'], true]);
  assert.equal(tierOf({ title: 'review the open pull request', paths: [], checkIds: [] }).tier, 'step-down');
  assert.equal(tierOf({ title: 'research the options for caching', paths: [], checkIds: [] }).tier, 'step-down');
  const small = tierOf({ title: 'fix the label', paths: ['src/label.ts'], checkIds: ['test'] });
  assert.deepEqual([small.tier, small.reasons, small.settled], ['step-down', ['TIER_LOW_RISK_BOUNDED'], false], 'not settled: Jev may be asked');
  // Not low: no check, over 5 files, medium risk, a failure open, a protected class touched.
  assert.equal(tierOf({ paths: ['src/label.ts'], checkIds: [] }).tier, 'baseline', 'no acceptance check');
  assert.equal(rulesTier(quiet({ files: 6, checks: 1, risk: 'low' })).tier, 'baseline');
  assert.equal(rulesTier(quiet({ files: 2, checks: 1, risk: 'medium' })).tier, 'baseline');
  assert.equal(rulesTier(quiet({ files: 2, checks: 1, risk: 'low', failedAttempts: 1, maxRepairAttempts: 3 })).tier, 'baseline', 'no step down while a failure is open');
  // Docs under an auth folder are not read-only work.
  assert.equal(tierOf({ paths: ['src/auth/README.md'], checkIds: [] }).tier, 'step-up');
  // Review of a source file the task would edit is not read-only.
  assert.equal(rulesTier(quiet({ files: 2, checks: 1, risk: 'medium', readOnlyWork: false })).tier, 'baseline');
  // Nothing known at all: the baseline, and Jev has nothing to go on.
  const none = rulesTier(tierSignalsOf({ hints: {} }));
  assert.deepEqual([none.tier, none.reasons, hasTierSignals(tierSignalsOf({ hints: {} }))], ['baseline', ['TIER_NO_SIGNALS'], false]);
});

test('the signals are content-free: counts, categories and codes, never a path or a title', async () => {
  const signals = tierSignalsOf({ hints: { title: 'fix ZZSECRETTITLEZZ in the lexer', paths: ['src/zzsecretpathzz/lexer.ts'], checkIds: ['unit-tests'] } });
  assert.equal(JSON.stringify(signals).includes('ZZSECRET'), false);
  assert.equal(JSON.stringify(signals).toLowerCase().includes('zzsecretpathzz'), false);
  assert.deepEqual([signals.files, signals.checks, signals.verb], [1, 1, 'fix']);
  assert.deepEqual(Object.keys(signals).sort(), ['baselineRunFailed', 'checks', 'failedAttempts', 'failureEnvironmental', 'files', 'handOffBlocked', 'maxRepairAttempts', 'planDepth', 'protectedClasses', 'readOnlyWork', 'risk', 'riskReasons', 'sliceId', 'verb']);
});

test('ladders are provider-neutral: each harness gets the rungs of the provider its baseline belongs to', async () => {
  // Claude Code, Sonnet 5.5 baseline: Haiku 5.5 below, Opus 5.5 above. Fable 5.1 (not ZDR eligible) and the legacy models are never rungs.
  const claude = ladderOf('claude-sonnet-5-5');
  assert.deepEqual(idsOf(claude), ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
  assert.deepEqual([claude.baselineIndex, claude.stepDownIndex, claude.stepUpIndex], [1, 0, 2]);
  assert.deepEqual([...claude.stepUpModelIds], ['claude-opus-5-5']);
  // Codex, GPT-6.1 Sol baseline: OpenAI's own rungs, a sibling at almost the same price (GPT-5.6 Terra) is not a tier.
  const codex = ladderOf('gpt-6.1-sol');
  assert.ok(codex.candidates.every((c) => c.provider === 'openai'), JSON.stringify(idsOf(codex)));
  assert.deepEqual(idsOf(codex), ['gpt-6-luna', 'gpt-5.6-luna', 'gpt-6.1-sol', 'gpt-5.6-sol', 'gpt-6-astra']);
  assert.equal(idsOf(codex)[codex.stepDownIndex], 'gpt-6-luna', 'the newest cheaper rung, as the first try names it');
  assert.equal(idsOf(codex)[codex.stepUpIndex], 'gpt-5.6-sol');
  // Antigravity, Gemini 3.8 Flash baseline: Google has no other active rung a tier away (3.7 Flash is a sibling, 3.1 Pro a preview), so nothing to step to.
  const agy = ladderOf('gemini-3.8-flash');
  assert.deepEqual(idsOf(agy), ['gemini-3.8-flash']);
  assert.deepEqual([agy.stepDownIndex, agy.stepUpIndex, [...agy.stepUpModelIds]], [null, null, []]);
  // Kilo and OpenCode run whatever provider the session runs: each session model gets its own provider's ladder.
  for (const [model, provider] of [['gpt-6-sol', 'openai'], ['claude-opus-5-5', 'anthropic'], ['grok-4.7', 'xai'], ['glm-5.3', 'zai'], ['gemini-3.8-flash', 'google']]) {
    // The administrator's region policy decides which providers' models are eligible at all (xAI is US-hosted, Z.ai Singapore).
    const ladder = ladderOf(model, eligible({ allowedRegions: ['global', 'us', 'sg'] }));
    assert.equal('none' in ladder, false, model);
    assert.ok(ladder.candidates.length >= 1);
    assert.ok(ladder.candidates.every((c) => c.provider === provider), `${model}: ${JSON.stringify(idsOf(ladder))}`);
    assert.equal(ladder.candidates[ladder.baselineIndex].modelId, model);
  }
});

test('an OpenAI baseline never gets an Anthropic model, whatever the tier, and every baseline stays inside its own provider', async () => {
  const all = eligible();
  for (const baseline of REGISTRY.entries.map((e) => e.modelId)) {
    const ladder = ladderOf(baseline, all);
    if ('none' in ladder) continue;
    const provider = providerOf(baseline);
    assert.ok(idsOf(ladder).every((id) => providerOf(id) === provider), `${baseline}: ${JSON.stringify(idsOf(ladder))}`);
    assert.ok(ladder.stepUpModelIds.every((id) => providerOf(id) === provider), baseline);
    assert.ok(ladder.candidates.length <= 7, 'baseline plus at most three each side');
  }
  // A Codex session with a step-up signal names an OpenAI rung and never a Claude one.
  const decision = await tierDecision('gpt-6.1-sol', { hints: { paths: ['src/auth/login.ts'], checkIds: ['test'] } });
  assert.equal(decision.tier, 'step-up');
  assert.equal(providerOf(decision.targetModelId), 'openai');
  assert.equal(decision.targetModelId, 'gpt-5.6-sol');
  assert.ok(decision.candidates.every((id) => providerOf(id) === 'openai'));
});

/** The rules-only decision for a baseline (no Jev, no record). */
async function tierDecision(baselineModelId, input, models = eligible()) {
  const signals = input.signals ?? tierSignalsOf(input);
  return judgeModelTier(null, { signals, eligible: models, baselineModelId, volume: DEFAULT_TASK_VOLUME }, { workspaceId: 'w-tier', evidenceRevision: 'rev-1' }, { assist: 'off', record: false });
}

test('never Fable 5.1 (not ZDR eligible) unless it is the baseline; a model must be active and a real price step', async () => {
  assert.ok(!idsOf(ladderOf('claude-opus-5-5')).includes('claude-fable-5-1'), 'Opus 5.5 does not step up to Fable');
  assert.ok(!ladderOf('claude-sonnet-5-5').stepUpModelIds.includes('claude-fable-5-1'));
  const fable = ladderOf('claude-fable-5-1');
  assert.equal(fable.candidates[fable.baselineIndex].modelId, 'claude-fable-5-1', 'a Fable session keeps its own model as the baseline');
  assert.equal(fable.stepUpIndex, null);
  // Legacy and preview models are not rungs; Haiku 4.5 (legacy) never displaces Haiku 5.5.
  assert.ok(!idsOf(ladderOf('claude-sonnet-5-5')).includes('claude-haiku-4-5-20251001'));
  assert.ok(!idsOf(ladderOf('gemini-3.8-flash')).includes('gemini-3.1-pro-preview'));
  // A baseline that is not among the eligible models gives no ladder.
  assert.deepEqual(ladderOf('claude-sonnet-5-5', eligible().filter((m) => m.provider !== 'anthropic')), { none: true, reasonCode: 'TIER_BASELINE_NOT_ELIGIBLE' });
});

test('the ladder uses only the models the caller passes: an ineligible rung is never offered', async () => {
  const noOpus = eligible().filter((m) => m.modelId !== 'claude-opus-5-5');
  const claude = ladderOf('claude-sonnet-5-5', noOpus);
  assert.deepEqual(idsOf(claude), ['claude-haiku-5-5', 'claude-sonnet-5-5']);
  assert.equal(claude.stepUpIndex, null);
  // The rules still say step up, and with no rung the answer is the baseline with the reason (never a made-up model).
  const d = await tierDecision('claude-sonnet-5-5', { hints: { paths: ['src/auth/login.ts'], checkIds: ['test'] } }, noOpus);
  assert.deepEqual([d.tier, d.targetModelId, d.basis], ['baseline', 'claude-sonnet-5-5', 'tier-rule']);
  assert.ok(d.reasonCodes.includes('TIER_NO_STEP_UP_RUNG') && d.reasonCodes.includes('TIER_PROTECTED_PATH'));
});

test('the rules\' tier on each harness\'s own models, labelled as a rules-based default', async () => {
  const hard = { hints: { paths: ['src/auth/login.ts'], checkIds: ['test'] } };
  const easy = { hints: { paths: ['docs/guide.md'], checkIds: [] } };
  const plain = { hints: { title: 'adjust the pagination', paths: ['src/page.ts', 'src/list.ts'], checkIds: ['test'] }, risk: 'medium' };
  const cases = [
    // [harness, session model, step-up target, step-down target]
    ['claude', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'],
    ['codex', 'gpt-6.1-sol', 'gpt-5.6-sol', 'gpt-6-luna'],
    ['kilocode', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-6-luna'],
    ['opencode', 'claude-opus-5-5', null, 'claude-sonnet-5-5'],
    ['antigravity', 'gemini-3.8-flash', null, null],
  ];
  for (const [harness, model, up, down] of cases) {
    const baseline = sessionBaseline(REGISTRY, harness, model);
    assert.equal(baseline, model, harness);
    const hardTier = await tierDecision(baseline, hard);
    const easyTier = await tierDecision(baseline, easy);
    const plainTier = await tierDecision(baseline, plain);
    assert.equal(plainTier.tier, 'baseline', harness);
    assert.equal(plainTier.targetModelId, model, harness);
    assert.equal(hardTier.targetModelId, up ?? model, `${harness} step-up target`);
    assert.equal(hardTier.tier, up === null ? 'baseline' : 'step-up', harness);
    assert.equal(easyTier.tier, down === null ? 'baseline' : 'step-down', harness);
    if (down !== null) assert.equal(providerOf(easyTier.targetModelId), providerOf(model), harness);
    for (const d of [hardTier, easyTier, plainTier]) {
      assert.equal(d.basis, 'tier-rule');
      assert.equal(d.label, TIER_RULES_LABEL);
      assert.equal(d.label, 'Rules-based default - not a learned route, not a signed prior');
      assert.equal(d.asked, false);
    }
  }
  // OpenCode on Opus 5.5: nothing above it (Fable is not a rung), so the hard task stays on Opus with the reason named.
  assert.ok((await tierDecision('claude-opus-5-5', hard)).reasonCodes.includes('TIER_NO_STEP_UP_RUNG'));
});

test('a session baseline is the session\'s own model; a harness with no default of its own and an unknown model has none', async () => {
  assert.equal(harnessHasDefault(REGISTRY, 'claude'), true);
  assert.equal(harnessHasDefault(REGISTRY, 'codex'), true);
  assert.equal(harnessHasDefault(REGISTRY, 'antigravity'), true);
  assert.equal(harnessHasDefault(REGISTRY, 'kilocode'), false);
  assert.equal(harnessHasDefault(REGISTRY, 'opencode'), false);
  assert.equal(sessionBaseline(REGISTRY, 'claude', null), 'claude-sonnet-5-5');
  assert.equal(sessionBaseline(REGISTRY, 'codex', null), 'gpt-6.1-sol');
  assert.equal(sessionBaseline(REGISTRY, 'antigravity', 'not-a-model'), 'gemini-3.8-flash');
  for (const harness of ['kilocode', 'opencode']) {
    assert.equal(sessionBaseline(REGISTRY, harness, 'gpt-6.1-sol'), 'gpt-6.1-sol', harness);
    assert.equal(sessionBaseline(REGISTRY, harness, 'gemini-3.8-flash'), 'gemini-3.8-flash', harness);
    assert.equal(sessionBaseline(REGISTRY, harness, null), null, `${harness}: never the Claude fallback`);
    assert.equal(sessionBaseline(REGISTRY, harness, 'not-a-model'), null, harness);
  }
  assert.equal(sessionBaseline(REGISTRY, null, null), null);
});

test('the question is fixed text that depends on the number of candidates only', async () => {
  for (let n = 2; n <= 8; n += 1) {
    const q = modelTierQuestions(n);
    assert.deepEqual(Object.keys(q.model.criteria), [...'ABCDEFGH'.slice(0, n), 'unknown']);
    assert.deepEqual(modelTierQuestions(n), q, 'the same text every time');
  }
  const text = JSON.stringify(modelTierQuestions(3));
  for (const id of REGISTRY.entries.map((e) => e.modelId)) assert.equal(text.includes(id), false, `${id} must not be in the question text`);
  assert.deepEqual(Object.keys(modelTierQuestions(99).model.criteria).length, 9, 'capped at eight labels');
});

test('the note carries ids, codes and the label, no text', async () => {
  const d = await tierDecision('claude-sonnet-5-5', { hints: { paths: ['src/auth/login.ts'], checkIds: ['test'] } });
  const note = tierNoteOf(d);
  assert.deepEqual([note.tier, note.targetModelId, note.baselineModelId, note.basis, note.label], ['step-up', 'claude-opus-5-5', 'claude-sonnet-5-5', 'tier-rule', TIER_RULES_LABEL]);
  assert.deepEqual([...note.stepUpModelIds], ['claude-opus-5-5']);
  assert.equal(JSON.stringify(note).includes('auth/login'), false);
  assert.notEqual(TIER_JEV_LABEL, TIER_RULES_LABEL);
});
