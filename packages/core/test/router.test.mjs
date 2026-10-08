import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const core = await import('../dist/index.js');
const contracts = await import('@jevris/contracts');
const { runOwnedWorker } = await import('@jevris/adapter-claude-sdk');
const {
  BUNDLED_MODEL_REGISTRY, validateModelRegistry, applyDiscovery, generationCostMicroUsd, filterCandidates, routeTask, expectedTotalCost,
  transitionCostMicroUsd, switchGuard, renderRouteAdvice, adviseMainRoute, AdviceOnce, readPins, escalationGate, failureFamilyOf, downgradeGate, chooseEffort,
  outageFallback, FallbackLedger, sliceCoverage, observeModel, checkCalibration, loadCalibration, calibrationFileFor, calibrationKeysFrom,
  runManagedWorker, DecisionBudget, registryModel, jevCostMicroUsd, JEV_TARIFF,
} = core;

const H = (c) => `sha256:${c.repeat(64)}`;
const ACCOUNT = 'acct-1';

/** A tariff without its integer micro-USD forms (R7), for tests that set the float prices. */
function floatPrices(tariff) {
  return Object.fromEntries(Object.entries(tariff).filter(([key]) => !key.includes('MicroUsd')));
}

function model(id, family, input, output, cacheRead, overrides = {}) {
  const base = BUNDLED_MODEL_REGISTRY.entries.find((entry) => entry.modelId === id);
  return {
    ...base,
    modelId: id,
    family,
    // The mechanics tests price cache writes at the input price (no write price), as before.
    // The float prices only: the bundled integer forms would disagree with these test prices.
    tariff: { ...floatPrices(base.tariff), inputPerMillion: input, outputPerMillion: output, cacheReadPerMillion: cacheRead, cacheWritePerMillion: null, cacheWrite1hPerMillion: null },
    accountEligibility: [{ accountId: ACCOUNT, eligible: true, checkedAt: '2026-09-22T00:00:00Z' }],
    effortLevels: ['low', 'medium', 'high'],
    health: 'healthy',
    ...overrides,
  };
}

/** The §8.1 models, eligible for the test account, with Opus 5 as the approved baseline. */
function registry(overrides = {}) {
  // A test registry of its own Anthropic entries: the bundled per-harness defaults, the other
  // providers' access rows and the servings name models and providers it lacks.
  const { harnessDefaults: _defaults, servings: _servings, ...bundled } = BUNDLED_MODEL_REGISTRY;
  return {
    ...bundled,
    harnessAccess: bundled.harnessAccess.filter((row) => row.provider === 'anthropic'),
    baselineModelId: 'claude-opus-5',
    entries: [
      model('claude-fable-5-1', 'fable', 10, 50, 0.25),
      model('claude-opus-5', 'opus', 5, 25, 0.5),
      model('claude-sonnet-5', 'sonnet', 2, 10, null),
      model('claude-haiku-4-5-20251001', 'haiku', 1, 5, null),
    ],
    ...overrides,
  };
}

function policy(overrides = {}) {
  return {
    managedAllowlist: null,
    allowedRegions: ['global'],
    requiredContextTokens: 50_000,
    requiredCapabilities: ['tools'],
    pins: { modelPin: null, effortPin: null },
    riskFloorFamilies: null,
    accountId: ACCOUNT,
    // Before any retirement date in the snapshot, so the mechanics tests do not age.
    nowMs: Date.parse('2026-09-26T00:00:00Z'),
    ...overrides,
  };
}

const VOLUME = { inputTokens: 2_000_000, outputTokens: 200_000 };
const ASSUMPTIONS = { verificationMicroUsd: 200_000, reworkMicroUsd: 3_000_000, routingOverheadMicroUsd: 21_000 };
const q = (modelId, lower, point, upper, sliceId = 'bounded-edit') => ({ modelId, sliceId, lower, point, upper, sourceId: 'holdout-synthetic-1' });

test('RTE-01: the bundled registry is sourced, exact and eligible for nothing until an account check', () => {
  assert.equal(validateModelRegistry(BUNDLED_MODEL_REGISTRY).ok, true);
  assert.equal(BUNDLED_MODEL_REGISTRY.snapshotId, 'multi-2026-10-08');
  assert.equal(BUNDLED_MODEL_REGISTRY.baselineModelId, 'claude-sonnet-5-5', 'Sonnet 5.5 is the Claude Code default and the registry baseline (Opus 5.5 until 2026-10-08)');
  const anthropic = BUNDLED_MODEL_REGISTRY.entries.filter((e) => e.provider === 'anthropic');
  assert.deepEqual(anthropic.map((e) => e.modelId), ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']);
  for (const entry of anthropic) {
    for (const id of [...entry.sourceIds, entry.tariff.sourceId, entry.lifecycle.sourceId, entry.dataGovernance.sourceId]) {
      const source = core.BUNDLED_REGISTRY_SOURCES[id];
      assert.ok(source !== undefined, `${entry.modelId}: source ${id} is listed`);
      assert.match(source.url, /^https:\/\/(platform|code)\.claude\.com\//);
      assert.equal(source.fetchedOn, '2026-10-08', 'each source keeps its latest fetch date');
    }
    assert.deepEqual(entry.accountEligibility, [], 'no invented eligibility');
    assert.equal(typeof entry.tariff.cacheWritePerMillion, 'number', 'the 5-minute write is sourced');
    assert.equal(entry.tariff.cacheWrite1hPerMillion, entry.tariff.inputPerMillion * 2, 'the 1-hour write is 2x input');
    assert.equal(entry.tariff.cacheWritePerMillion, entry.tariff.inputPerMillion * 1.25, 'the 5-minute write is 1.25x input');
    // Claude 4.6+ has no long-context tier, except Haiku 5.5: a prompt over 100,000 tokens is five times.
    assert.deepEqual(entry.tariff.tiers, entry.modelId === 'claude-haiku-5-5' ? [{ aboveInputTokens: 100_000, inputMultiplier: 5, outputMultiplier: 5, cacheMultiplier: 5 }] : undefined);
  }
  const model = (id) => registryModel(BUNDLED_MODEL_REGISTRY, id);
  const facts = (id) => [model(id).tariff.inputPerMillion, model(id).tariff.outputPerMillion, model(id).tariff.cacheReadPerMillion, model(id).contextTokens, model(id).maxOutputTokens];
  assert.deepEqual(facts('claude-opus-5-5'), [4, 20, 0.2, 1_000_000, 128_000]);
  assert.deepEqual(facts('claude-fable-5-1'), [10, 50, 0.25, 1_000_000, 128_000]);
  assert.deepEqual(facts('claude-opus-5'), [5, 25, 0.5, 1_000_000, 128_000]);
  assert.deepEqual(facts('claude-sonnet-5-5'), [2, 10, 0.1, 1_000_000, 128_000]);
  assert.deepEqual(facts('claude-haiku-5-5'), [0.1, 0.5, 0.01, 1_000_000, 128_000]);
  assert.deepEqual(facts('claude-sonnet-5'), [2, 10, 0.2, 1_000_000, 128_000]);
  assert.deepEqual(facts('claude-haiku-4-5-20251001'), [1, 5, 0.1, 200_000, 64_000]);
  assert.deepEqual([model('claude-opus-5-5').defaultEffort, model('claude-fable-5-1').defaultEffort, model('claude-sonnet-5-5').defaultEffort, model('claude-haiku-5-5').defaultEffort, model('claude-haiku-4-5-20251001').defaultEffort], ['medium', 'high', 'high', 'medium', null]);
  assert.deepEqual(BUNDLED_MODEL_REGISTRY.entries.filter((e) => e.effortSwitch?.keepsCache === true).map((e) => e.modelId), ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5'], 'per-message effort keeps the cache on these only');
  assert.deepEqual(anthropic.filter((e) => !e.dataGovernance.zdrEligible).map((e) => e.modelId), ['claude-fable-5-1'], 'Fable 5.1 is a Covered Model');
  assert.equal(model('claude-fable-5-1').dataGovernance.requiredRetentionDays, 30);
  assert.equal(model('claude-haiku-4-5-20251001').lifecycle.retirementNotBefore, '2026-10-15T00:00:00Z');
  assert.equal(filterCandidates(BUNDLED_MODEL_REGISTRY, policy()).eligible.length, 0);
  const duplicate = { ...BUNDLED_MODEL_REGISTRY, entries: [...BUNDLED_MODEL_REGISTRY.entries, BUNDLED_MODEL_REGISTRY.entries[0]] };
  assert.equal(validateModelRegistry(duplicate).ok, false);
  assert.equal(validateModelRegistry({ ...BUNDLED_MODEL_REGISTRY, baselineModelId: 'claude-opus-9' }).ok, false);
  const discovery = applyDiscovery(BUNDLED_MODEL_REGISTRY, ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-mystery-7'], 'anthropic');
  assert.deepEqual(discovery.unregistered, ['claude-mystery-7']);
  assert.equal(discovery.registry.entries.some((e) => e.modelId === 'claude-mystery-7'), false, 'discovery never adds an id');
  assert.equal(registryModel(discovery.registry, 'claude-haiku-4-5-20251001').health, 'unavailable');
  // An unknown cache price is charged at the input price: never cheaper than known.
  const unknown = { ...model('claude-sonnet-5').tariff, cacheReadPerMillion: null, cacheWritePerMillion: null, cacheWrite1hPerMillion: null };
  assert.equal(generationCostMicroUsd(unknown, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }), 2_000_000);
  assert.equal(generationCostMicroUsd(unknown, { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000, cacheTtl: '1h' }), 2_000_000);
});

test('RTE-01: lifecycle, ZDR, price tiers, scheduled prices and provider-aware lookup are routing facts', () => {
  const at = (date) => Date.parse(`${date}T00:00:00Z`);
  const eligible = (reg, extra = {}) => filterCandidates(reg, policy(extra));
  const reg = registry({
    entries: [
      model('claude-opus-5', 'opus', 5, 25, 0.5),
      model('claude-haiku-4-5-20251001', 'haiku', 1, 5, null),
      model('claude-fable-5-1', 'fable', 10, 50, 0.25),
    ],
  });
  // A model stays recommended until it is actually retired (DOMAINS 3ff4c0f, 9d1e7eb).
  // Paired: past Haiku 4.5's "not sooner than" date (2026-10-15) it still routes, with the warning
  // MODEL_RETIREMENT_DUE; the day before, no warning.
  const haiku = (reg2) => registryModel(reg2, 'claude-haiku-4-5-20251001');
  assert.ok(eligible(reg, { nowMs: at('2026-10-14') }).eligible.some((m) => m.modelId === 'claude-haiku-4-5-20251001'));
  assert.deepEqual(core.lifecycleCheck(haiku(reg), at('2026-10-14')), { usable: true });
  const due = eligible(reg, { nowMs: at('2026-10-15') });
  assert.ok(due.eligible.some((m) => m.modelId === 'claude-haiku-4-5-20251001'), 'a passed "not sooner than" date still routes');
  assert.deepEqual(due.eliminated, []);
  assert.deepEqual(core.lifecycleCheck(haiku(reg), at('2026-10-15')), { usable: true, warning: 'MODEL_RETIREMENT_DUE' });
  assert.deepEqual(core.lifecycleWarnings(reg, at('2026-10-15')), [{ modelId: 'claude-haiku-4-5-20251001', warning: 'MODEL_RETIREMENT_DUE' }]);
  // Paired: with a firm retiresOn (2026-11-26), Haiku 4.5 routes the day before and never from that day on.
  const firm = (lifecycle) => registry({
    entries: [
      model('claude-opus-5', 'opus', 5, 25, 0.5),
      model('claude-haiku-4-5-20251001', 'haiku', 1, 5, null, { lifecycle: { ...haiku(BUNDLED_MODEL_REGISTRY).lifecycle, ...lifecycle } }),
      model('claude-fable-5-1', 'fable', 10, 50, 0.25),
    ],
  });
  const announced = firm({ retiresOn: '2026-11-26T00:00:00Z' });
  assert.equal(core.firmRetirement(haiku(announced)), '2026-11-26T00:00:00Z');
  assert.equal(core.firmRetirement(haiku(reg)), null, 'a "not sooner than" date is not firm');
  assert.ok(eligible(announced, { nowMs: at('2026-11-25') }).eligible.some((m) => m.modelId === 'claude-haiku-4-5-20251001'));
  const retired = eligible(announced, { nowMs: at('2026-11-26') });
  assert.equal(retired.eligible.some((m) => m.modelId === 'claude-haiku-4-5-20251001'), false);
  assert.deepEqual(retired.eliminated, [{ modelId: 'claude-haiku-4-5-20251001', gate: 'lifecycle' }]);
  assert.deepEqual(core.lifecycleCheck(haiku(announced), at('2026-11-26')), { usable: false, reasonCode: 'MODEL_RETIRED' });
  // Deprecated: usable with a warning until its firm date; retired: never.
  const deprecated = firm({ status: 'deprecated', retiresOn: '2026-11-26T00:00:00Z' });
  assert.deepEqual(core.lifecycleCheck(haiku(deprecated), at('2026-11-25')), { usable: true, warning: 'MODEL_DEPRECATED' });
  assert.ok(eligible(deprecated, { nowMs: at('2026-11-25') }).eligible.some((m) => m.modelId === 'claude-haiku-4-5-20251001'), 'a deprecated model routes until it retires');
  assert.deepEqual(eligible(deprecated, { nowMs: at('2026-11-26') }).eliminated, [{ modelId: 'claude-haiku-4-5-20251001', gate: 'lifecycle' }]);
  assert.deepEqual(eligible(firm({ status: 'retired' }), { nowMs: at('2026-10-01') }).eliminated, [{ modelId: 'claude-haiku-4-5-20251001', gate: 'lifecycle' }]);
  assert.deepEqual(core.lifecycleCheck(haiku(firm({ status: 'retired' })), at('2026-10-01')), { usable: false, reasonCode: 'MODEL_RETIRED' });
  // The selection carries the warnings of the models it could still recommend.
  const warned = routeTask({ registry: reg, policy: policy({ nowMs: at('2026-10-15') }), sliceId: 'bounded-edit', volume: VOLUME, assumptions: ASSUMPTIONS, qualityFloor: 0.8, qualities: [] });
  assert.deepEqual(warned.lifecycleWarnings, [{ modelId: 'claude-haiku-4-5-20251001', warning: 'MODEL_RETIREMENT_DUE' }]);
  assert.equal(routeTask({ registry: reg, policy: policy({ nowMs: at('2026-10-14') }), sliceId: 'bounded-edit', volume: VOLUME, assumptions: ASSUMPTIONS, qualityFloor: 0.8, qualities: [] }).lifecycleWarnings, undefined);
  // A pin to a retired model is a conflict, never a route to it.
  const pinnedRetired = routeTask({ registry: announced, policy: policy({ nowMs: at('2026-11-26'), pins: { modelPin: 'claude-haiku-4-5-20251001', effortPin: null } }), sliceId: 'bounded-edit', volume: VOLUME, assumptions: ASSUMPTIONS, qualityFloor: 0.8, qualities: [] });
  assert.equal(pinnedRetired.reasonCode, 'PIN_CONFLICT');
  // A retired baseline is replaced by the best qualified candidate, not kept for a saving argument.
  const haikuBase = registry({ baselineModelId: 'claude-haiku-4-5-20251001', entries: [model('claude-haiku-4-5-20251001', 'haiku', 1, 5, null, { lifecycle: { ...haiku(BUNDLED_MODEL_REGISTRY).lifecycle, retiresOn: '2026-11-26T00:00:00Z' } }), model('claude-sonnet-5', 'sonnet', 2, 10, null)] });
  const haikuQualities = [q('claude-sonnet-5', 0.86, 0.9, 0.94), q('claude-haiku-4-5-20251001', 0.9, 0.95, 0.99)];
  const replaced = routeTask({ registry: haikuBase, policy: policy({ nowMs: at('2026-11-26') }), sliceId: 'bounded-edit', volume: VOLUME, assumptions: ASSUMPTIONS, qualityFloor: 0.8, qualities: haikuQualities });
  assert.deepEqual([replaced.outcome, replaced.modelId, replaced.reasonCode], ['select', 'claude-sonnet-5', 'BASELINE_RETIRING']);
  // Paired: past only its "not sooner than" date the baseline is kept.
  const kept = routeTask({ registry: haikuBase, policy: policy({ nowMs: at('2026-10-15') }), sliceId: 'bounded-edit', volume: VOLUME, assumptions: ASSUMPTIONS, qualityFloor: 0.8, qualities: haikuQualities });
  assert.notEqual(kept.reasonCode, 'BASELINE_RETIRING');
  // lifecycleStatus is the router's rule with its dates, for A's release gate.
  const bundledHaiku = haiku(BUNDLED_MODEL_REGISTRY);
  assert.deepEqual(core.lifecycleStatus(bundledHaiku, at('2026-10-14')), { recommended: true, retired: false, stale: false, warning: null, firmDate: null, notBeforeDate: '2026-10-15T00:00:00Z' });
  assert.deepEqual(core.lifecycleStatus(bundledHaiku, at('2026-10-15')), { recommended: true, retired: false, stale: false, warning: 'MODEL_RETIREMENT_DUE', firmDate: null, notBeforeDate: '2026-10-15T00:00:00Z' });
  const firmHaiku = { ...bundledHaiku, lifecycle: { ...bundledHaiku.lifecycle, retiresOn: '2026-11-26T00:00:00Z' } };
  assert.deepEqual([core.lifecycleStatus(firmHaiku, at('2026-11-26')).retired, core.lifecycleStatus(firmHaiku, at('2026-11-26')).stale], [true, true], 'still "active" past a firm date is stale data');
  assert.equal(core.lifecycleStatus(firmHaiku, at('2026-11-25')).retired, false);
  const retiredHaiku = { ...bundledHaiku, lifecycle: { ...bundledHaiku.lifecycle, status: 'retired', retiresOn: '2026-11-26T00:00:00Z' } };
  assert.deepEqual([core.lifecycleStatus(retiredHaiku, at('2026-11-26')).retired, core.lifecycleStatus(retiredHaiku, at('2026-11-26')).stale], [true, false]);
  // shippedModelReferences names the baseline and every published prior's model and effort.
  const refs = core.shippedModelReferences();
  assert.deepEqual(refs[0], { modelId: 'claude-sonnet-5-5', where: 'baseline', effort: null, detail: 'model registry multi-2026-10-08 baselineModelId' });
  assert.deepEqual(refs.filter((r) => r.where === 'priors').length, core.BUNDLED_PUBLIC_PRIORS.length);
  for (const r of refs) assert.ok(registryModel(BUNDLED_MODEL_REGISTRY, r.modelId) !== null, `${r.modelId} is in the bundled registry`);

  // Paired: a ZDR workspace never gets Fable 5.1; a standard workspace can.
  assert.ok(eligible(reg).eligible.some((m) => m.modelId === 'claude-fable-5-1'));
  const zdr = eligible(reg, { zeroDataRetention: true });
  assert.equal(zdr.eligible.some((m) => m.modelId === 'claude-fable-5-1'), false);
  assert.deepEqual(zdr.eliminated.filter((e) => e.modelId === 'claude-fable-5-1'), [{ modelId: 'claude-fable-5-1', gate: 'data-retention' }]);
  const { dataGovernance: _governance, ...noGovernance } = model('claude-opus-5', 'opus', 5, 25, 0.5);
  const unknownZdr = registry({ entries: [noGovernance] });
  assert.equal(eligible(unknownZdr, { zeroDataRetention: true }).eligible.length, 0, 'unknown retention is not ZDR eligible');
  const zdrRoute = routeTask({ registry: reg, policy: policy({ zeroDataRetention: true }), sliceId: 'bounded-edit', volume: VOLUME, assumptions: ASSUMPTIONS, qualityFloor: 0.8, qualities: [q('claude-fable-5-1', 0.97, 0.99, 1), q('claude-opus-5', 0.9, 0.94, 0.97)] });
  assert.notEqual(zdrRoute.modelId, 'claude-fable-5-1');

  // A long-context tier applies to the whole request above its threshold (OpenAI-style: 2x input, 1.5x output).
  const tiered = { ...registryModel(reg, 'claude-opus-5').tariff, cacheReadPerMillion: 0.5, tiers: [{ aboveInputTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5, cacheMultiplier: null }] };
  assert.equal(generationCostMicroUsd(tiered, { inputTokens: 272_000, outputTokens: 10_000 }), 1_360_000 + 250_000);
  assert.equal(generationCostMicroUsd(tiered, { inputTokens: 272_001, outputTokens: 10_000 }), Math.ceil(272_001 * 10) + 375_000);
  // Landscape gap 22: xAI's tier starts when the prompt reaches 200K (inclusive). Token counts are
  // integers, so `aboveInputTokens: 199_999` is exact; cached prompt tokens count toward it, and
  // the 2x applies to the whole request, reasoning (billed as output) included.
  const grok = { version: 'xai-2026-09-26', currency: 'USD', effectiveAt: '2026-09-26T00:00:00Z', inputPerMillion: 2, outputPerMillion: 6, cacheReadPerMillion: 0.5, cacheWritePerMillion: 2, sourceId: 'XAI-PRICING', tiers: [{ aboveInputTokens: 199_999, inputMultiplier: 2, outputMultiplier: 2, cacheMultiplier: 2 }] };
  assert.equal(generationCostMicroUsd(grok, { inputTokens: 199_999, outputTokens: 10_000 }), 399_998 + 60_000, 'below 200K: base prices');
  assert.equal(generationCostMicroUsd(grok, { inputTokens: 200_000, outputTokens: 10_000 }), 800_000 + 120_000, 'at 200K: 2x on the whole request');
  assert.equal(generationCostMicroUsd(grok, { inputTokens: 100_000, cacheReadTokens: 100_000, outputTokens: 10_000 }), 400_000 + 100_000 + 120_000, 'cached prompt tokens reach the threshold too');
  // A scheduled price applies from its date; the snapshot may record it before it takes effect.
  const { tiers: _tiers, ...untiered } = tiered;
  const scheduled = { ...untiered, scheduled: [{ effectiveAt: '2027-01-01T00:00:00Z', inputPerMillion: 10, outputPerMillion: 50, cacheReadPerMillion: 1, cacheWritePerMillion: 12.5, sourceId: 'S28' }] };
  assert.equal(core.tariffAt(scheduled, at('2026-12-31')).inputPerMillion, 5);
  assert.equal(core.tariffAt(scheduled, at('2027-01-01')).inputPerMillion, 10);
  const future = registry({ entries: [model('claude-opus-5', 'opus', 5, 25, 0.5, { tariff: scheduled })] });
  assert.equal(validateModelRegistry(future).ok, true, 'a known future price is recordable');
  assert.equal(filterCandidates(future, policy({ nowMs: at('2027-01-02') })).eligible[0].tariff.inputPerMillion, 10, 'the router prices at the routing time');
  const backwards = registry({ entries: [model('claude-opus-5', 'opus', 5, 25, 0.5, { tariff: { ...scheduled, scheduled: [{ ...scheduled.scheduled[0], effectiveAt: '2026-01-01T00:00:00Z' }] } })] });
  assert.equal(validateModelRegistry(backwards).ok, false);
  const badTiers = registry({ entries: [model('claude-opus-5', 'opus', 5, 25, 0.5, { tariff: { ...tiered, tiers: [tiered.tiers[0], tiered.tiers[0]] } })] });
  assert.equal(validateModelRegistry(badTiers).ok, false);

  // Provider-aware lookup: an id two providers list is ambiguous without a provider.
  const twice = registry({ entries: [model('claude-opus-5', 'opus', 5, 25, 0.5), model('claude-opus-5', 'opus', 6, 30, 0.6, { provider: 'bedrock' }), model('claude-sonnet-5', 'sonnet', 2, 10, null)], baselineModelId: 'claude-sonnet-5' });
  assert.equal(validateModelRegistry(twice).ok, true);
  assert.equal(registryModel(twice, 'claude-opus-5'), null);
  assert.equal(registryModel(twice, 'claude-opus-5', 'bedrock').tariff.inputPerMillion, 6);
  assert.equal(registryModel(twice, 'claude-opus-5', 'anthropic').tariff.inputPerMillion, 5);
  assert.equal(validateModelRegistry({ ...twice, baselineModelId: 'claude-opus-5' }).ok, false, 'an ambiguous baseline is refused');
  const retiredBaseline = { ...BUNDLED_MODEL_REGISTRY, entries: BUNDLED_MODEL_REGISTRY.entries.map((e) => (e.modelId === 'claude-sonnet-5-5' ? { ...e, lifecycle: { ...e.lifecycle, status: 'deprecated' } } : e)) };
  assert.equal(validateModelRegistry(retiredBaseline).ok, false, 'the baseline cannot be deprecated');
});

test('RTE-02: hard filters remove candidates before scoring and name the first failing gate', () => {
  const reg = registry({
    entries: [
      model('claude-fable-5-1', 'fable', 10, 50, 0.25, { regions: ['us'] }),
      model('claude-opus-5', 'opus', 5, 25, 0.5, { contextTokens: 32_000 }),
      model('claude-sonnet-5', 'sonnet', 2, 10, null, { capabilities: ['text'] }),
      model('claude-haiku-4-5-20251001', 'haiku', 1, 5, null, { accountEligibility: [{ accountId: ACCOUNT, eligible: false, checkedAt: '2026-09-22T00:00:00Z' }] }),
    ],
  });
  const gates = Object.fromEntries(filterCandidates(reg, policy({ allowedRegions: ['global', 'eu'] })).eliminated.map((e) => [e.modelId, e.gate]));
  assert.deepEqual(gates, { 'claude-fable-5-1': 'residency', 'claude-opus-5': 'context', 'claude-sonnet-5': 'tools', 'claude-haiku-4-5-20251001': 'account-eligibility' });
  const managed = filterCandidates(registry(), policy({ managedAllowlist: ['claude-sonnet-5'] }));
  assert.deepEqual(managed.eligible.map((m) => m.modelId), ['claude-sonnet-5']);
  const risk = filterCandidates(registry(), policy({ riskFloorFamilies: ['opus', 'fable'] }));
  assert.deepEqual(risk.eligible.map((m) => m.modelId).sort(), ['claude-fable-5-1', 'claude-opus-5']);
  const pinned = filterCandidates(registry(), policy({ pins: { modelPin: 'claude-opus-5', effortPin: null } }));
  assert.deepEqual(pinned.eligible.map((m) => m.modelId), ['claude-opus-5']);
  const noAccount = filterCandidates(registry(), policy({ accountId: null }));
  assert.equal(noAccount.eligible.length, 0);
  const down = filterCandidates(registry({ entries: [model('claude-opus-5', 'opus', 5, 25, 0.5, { health: 'unavailable' })], baselineModelId: 'claude-opus-5' }), policy());
  assert.deepEqual(down.eliminated, [{ modelId: 'claude-opus-5', gate: 'health' }]);
});

test('RTE-03: the section 19.3 worked example reproduces', () => {
  const reg = registry();
  const opus = registryModel(reg, 'claude-opus-5').tariff;
  const sonnet = registryModel(reg, 'claude-sonnet-5').tariff;
  const all = { inputTokens: 10_000_000, outputTokens: 1_000_000 };
  const baseline = generationCostMicroUsd(opus, all);
  assert.equal(baseline, 75_000_000);
  const mixed = generationCostMicroUsd(sonnet, { inputTokens: 6_000_000, outputTokens: 600_000 }) + generationCostMicroUsd(opus, { inputTokens: 4_000_000, outputTokens: 400_000 });
  assert.equal(mixed, 48_000_000);
  // 100 Jev evaluations of 5,000 input tokens.
  const jev = jevCostMicroUsd(500_000, 0, JEV_TARIFF);
  assert.equal(jev, 21_000);
  const parts = { generation: mixed, cacheTransition: 0, expectedRetry: 0, verification: 5_000_000, expectedRework: 0, routingOverhead: jev + 2_000_000 };
  const total = expectedTotalCost(parts);
  assert.equal(total, 55_021_000);
  assert.equal(Math.round((1 - total / baseline) * 1000) / 10, 26.6);
  const withRework = expectedTotalCost({ ...parts, expectedRework: 30_000_000 });
  assert.equal(withRework, 85_021_000);
  assert.equal(Math.round((withRework / baseline - 1) * 1000) / 10, 13.4);
});

test('RTE-03: unknown quality is shadow only, the floor eliminates, and a saving inside the interval keeps the baseline', () => {
  const reg = registry();
  const base = { registry: reg, policy: policy(), sliceId: 'bounded-edit', volume: VOLUME, assumptions: ASSUMPTIONS, qualityFloor: 0.8 };
  const selected = routeTask({ ...base, qualities: [q('claude-opus-5', 0.9, 0.94, 0.97), q('claude-sonnet-5', 0.86, 0.9, 0.94), q('claude-haiku-4-5-20251001', 0.6, 0.7, 0.8)] });
  assert.equal(selected.outcome, 'select');
  assert.equal(selected.modelId, 'claude-sonnet-5');
  assert.equal(selected.reasonCode, 'LOWEST_UTILITY_WITHIN_FLOOR');
  assert.ok(selected.saving.lower > 0);
  assert.deepEqual(selected.shadow, ['claude-fable-5-1'], 'no quality for the slice: shadow only');
  const gates = Object.fromEntries(selected.eliminated.map((e) => [e.modelId, e.gate]));
  assert.equal(gates['claude-haiku-4-5-20251001'], 'below-quality-floor');
  assert.equal(gates['claude-fable-5-1'], 'unknown-quality');
  for (const candidate of selected.scored) assert.ok(candidate.cost.lower <= candidate.cost.point && candidate.cost.point <= candidate.cost.upper);

  const wide = routeTask({ ...base, qualities: [q('claude-opus-5', 0.9, 0.94, 0.97), q('claude-sonnet-5', 0.8, 0.9, 0.99)], volume: { inputTokens: 100_000, outputTokens: 10_000 }, assumptions: { ...ASSUMPTIONS, reworkMicroUsd: 5_000_000 } });
  assert.equal(wide.outcome, 'keep-baseline');
  assert.equal(wide.reasonCode, 'SAVING_WITHIN_UNCERTAINTY');
  assert.equal(wide.modelId, 'claude-opus-5');
  assert.ok(wide.saving.point > 0 && wide.saving.lower <= 0, 'a positive point estimate inside the interval does not switch');

  const none = routeTask({ ...base, qualities: [q('claude-haiku-4-5-20251001', 0.5, 0.6, 0.7)] });
  assert.deepEqual([none.outcome, none.modelId, none.reasonCode], ['keep-baseline', 'claude-opus-5', 'NO_QUALIFIED_CANDIDATE']);
  const uncalibrated = routeTask({ ...base, qualityFloor: null, qualities: [q('claude-sonnet-5', 0.9, 0.95, 0.99)] });
  assert.equal(uncalibrated.reasonCode, 'NO_CALIBRATION');
  assert.ok(uncalibrated.shadow.includes('claude-sonnet-5'), 'without a calibration everything is shadow');
  const pinned = routeTask({ ...base, policy: policy({ pins: { modelPin: 'claude-fable-5-1', effortPin: null } }), qualities: [q('claude-sonnet-5', 0.9, 0.95, 0.99)] });
  assert.deepEqual([pinned.outcome, pinned.modelId, pinned.reasonCode], ['pinned', 'claude-fable-5-1', 'MODEL_PINNED']);
  const conflict = routeTask({ ...base, policy: policy({ pins: { modelPin: 'claude-opus-5', effortPin: null }, requiredContextTokens: 1_100_000 }), qualities: [] });
  assert.deepEqual([conflict.outcome, conflict.modelId, conflict.reasonCode], ['pinned', 'claude-opus-5', 'PIN_CONFLICT']);
});

test('RTE-05: the switch guard prices the warm prefix and enforces benefit, dwell and a switch cap', () => {
  const reg = registry();
  const opus = registryModel(reg, 'claude-opus-5');
  const sonnet = registryModel(reg, 'claude-sonnet-5');
  // Moving 100k warm tokens: re-encode on Sonnet ($2/M, no cache write price) minus a warm Opus cache read ($0.50/M).
  assert.equal(transitionCostMicroUsd({ from: opus, to: sonnet, warmPrefixTokens: 100_000, cacheWarm: true }), 150_000);
  assert.equal(transitionCostMicroUsd({ from: opus, to: sonnet, warmPrefixTokens: 100_000, cacheWarm: false }), 0, 'a cold cache re-encodes either way');
  assert.equal(transitionCostMicroUsd({ from: sonnet, to: sonnet, warmPrefixTokens: 100_000, cacheWarm: true }), 0);
  const saving = { lower: 300_000, point: 500_000, upper: 700_000 };
  const input = { transitionCostMicroUsd: 150_000, saving, unitsSinceLastSwitch: 3, switchesThisTask: 0, atBoundary: true };
  const allowed = switchGuard(input);
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.netBenefitMicroUsd, 150_000);
  assert.match(allowed.explanation, /Transition cost \$0\.1500/);
  assert.equal(switchGuard({ ...input, transitionCostMicroUsd: 295_000 }).reasonCode, 'BELOW_MINIMUM_BENEFIT');
  assert.equal(switchGuard({ ...input, unitsSinceLastSwitch: 1 }).reasonCode, 'DWELL');
  assert.equal(switchGuard({ ...input, switchesThisTask: 2 }).reasonCode, 'MAX_SWITCHES');
  assert.equal(switchGuard({ ...input, atBoundary: false }).reasonCode, 'NOT_AT_BOUNDARY');
  for (const decision of [switchGuard({ ...input, unitsSinceLastSwitch: 0 }), switchGuard({ ...input, atBoundary: false })]) assert.match(decision.explanation, /Transition cost/);
  // The dollars are labelled by how the harness is billed.
  assert.match(allowed.explanation, /\(warm prefix moved to the new model\), an API-equivalent estimate \(the harness billing mode is not known\);/);
  assert.match(switchGuard({ ...input, authMode: 'api-key' }).explanation, /\$0\.1500 \(warm prefix moved to the new model\), billed at API list price;/);
  assert.match(switchGuard({ ...input, authMode: 'subscription' }).explanation, /an API-equivalent estimate \(a subscription has no per-token charge; the real cost is usage-limit consumption\)/);
});

test('RTE-05, US10: a model switch is cold at the TTL write price; an effort change keeps the cache only where per-message effort exists', () => {
  const opus55 = registryModel(BUNDLED_MODEL_REGISTRY, 'claude-opus-5-5');
  const sonnet = registryModel(BUNDLED_MODEL_REGISTRY, 'claude-sonnet-5');
  const fable = registryModel(BUNDLED_MODEL_REGISTRY, 'claude-fable-5-1');
  const move = (from, to, cacheTtl) => transitionCostMicroUsd({ from, to, warmPrefixTokens: 200_000, cacheWarm: true, ...(cacheTtl === undefined ? {} : { cacheTtl }) });
  // The research worked examples (200K warm prefix): 0.2M x (target write - current read).
  assert.equal(move(opus55, sonnet), 460_000);
  assert.equal(move(sonnet, opus55), 960_000);
  assert.equal(move(opus55, fable), 2_460_000);
  assert.equal(move(opus55, fable, '1h'), 3_960_000, 'the 1-hour write Claude Code uses on subscriptions');
  assert.ok(move(opus55, sonnet, '1h') > move(opus55, sonnet, '5m'));
  // Paired: effort on Opus 5.5 (per-message effort) keeps the cache; on Sonnet 5 it restarts it.
  const effort = (model, platform = 'claude-api') => core.effortTransitionCostMicroUsd({ model, warmPrefixTokens: 200_000, cacheWarm: true, platform });
  assert.equal(effort(opus55), 0);
  assert.equal(effort(fable), 0);
  assert.equal(effort(sonnet), 460_000, 'a top-level effort change rewrites the prefix on the same model');
  assert.equal(effort(opus55, 'bedrock'), 960_000, 'per-message effort is not on Bedrock');
  assert.ok(effort(opus55) < move(opus55, sonnet), 'an effort change is cheaper than a cold model switch');
});

test('RTE-06: main-session advice names model, reason, cost basis and pin state; a pin is kept; each key prompts once', () => {
  const reg = registry();
  const selection = routeTask({ registry: reg, policy: policy(), sliceId: 'bounded-edit', volume: VOLUME, assumptions: ASSUMPTIONS, qualityFloor: 0.8, qualities: [q('claude-opus-5', 0.9, 0.94, 0.97), q('claude-sonnet-5', 0.86, 0.9, 0.94)] });
  const guard = switchGuard({ transitionCostMicroUsd: 150_000, saving: selection.saving, unitsSinceLastSwitch: 3, switchesThisTask: 0, atBoundary: true });
  const once = new AdviceOnce();
  const base = { registry: reg, scopeId: 'session-1', requestedModelId: 'claude-opus-5', observedModelId: 'claude-opus-5', selection, switchDecision: guard, costBasis: 'api-list-price', once };
  const first = renderRouteAdvice({ ...base, pins: { modelPin: null, effortPin: null } });
  assert.equal(first.shown, true);
  const advice = first.advice;
  assert.equal(contracts.RouteAdviceContract.validate(advice).ok, true);
  assert.deepEqual([advice.outcome, advice.recommendedModelId, advice.pinState, advice.costBasis], ['recommend', 'claude-sonnet-5', 'unpinned', 'api-list-price']);
  assert.match(advice.text, /Sonnet 5/);
  assert.match(advice.text, /API list prices/);
  assert.match(advice.text, /not a measured saving/);
  assert.equal(advice.estimate.transitionCostMicroUsd, 150_000);
  const again = renderRouteAdvice({ ...base, pins: { modelPin: null, effortPin: null } });
  assert.deepEqual([again.shown, again.reasonCode], [false, 'ALREADY_PROMPTED']);
  const pins = readPins({ modelPin: 'claude-opus-5', effortPin: 'high', extra: 'x' });
  assert.deepEqual(pins, { modelPin: 'claude-opus-5', effortPin: 'high' });
  assert.deepEqual(readPins({ modelPin: 'bad model; rm -rf', effortPin: 7 }), { modelPin: null, effortPin: null });
  const pinned = renderRouteAdvice({ ...base, once: new AdviceOnce(), pins });
  assert.deepEqual([pinned.advice.outcome, pinned.advice.pinState, pinned.advice.recommendedModelId], ['keep', 'pinned-kept', null]);
  assert.match(pinned.advice.text, /pin Opus 5 is kept/);
  const unknownBasis = renderRouteAdvice({ ...base, once: new AdviceOnce(), pins: { modelPin: null, effortPin: null }, costBasis: 'unknown' });
  assert.equal(unknownBasis.advice.estimate, null, 'no saving estimate without a known cost basis');
  const quota = renderRouteAdvice({ ...base, once: new AdviceOnce(), pins: { modelPin: null, effortPin: null }, costBasis: 'subscription-quota' });
  assert.match(quota.advice.text, /not money saved from a fixed plan/);
});

function choice(family, probability) {
  const probabilities = Object.fromEntries(core.FAILURE_FAMILIES.map((f) => [f, f === family ? probability : (1 - probability) / 7]));
  return { answers: { failureFamily: { type: 'choice', choice: family, probabilities, confidence: probability } } };
}

test('RTE-07: environment failures go to diagnosis; one bounded escalation, then a blocked report', () => {
  assert.equal(failureFamilyOf(choice('environment', 0.8)), 'environment');
  assert.equal(failureFamilyOf(choice('environment', 0.3)), 'unclear');
  assert.equal(failureFamilyOf(null), 'unclear');
  assert.ok(contracts.JevQuestionsContract === undefined || contracts.JevQuestionsContract.validate(core.FAILURE_FAMILY_QUESTIONS).ok);
  const reg = registry();
  const base = { currentModelId: 'claude-sonnet-5', escalationsUsed: 0, registry: reg, policy: policy() };
  for (const family of ['environment', 'test-misconfiguration', 'missing-context']) {
    const decision = escalationGate({ ...base, family });
    assert.equal(decision.action, 'diagnose', family);
    assert.equal(decision.targetModelId, null, 'a stronger model cannot fix the environment');
  }
  const first = escalationGate({ ...base, family: 'same-problem-repeated' });
  assert.deepEqual([first.action, first.targetModelId], ['escalate', 'claude-opus-5']);
  const second = escalationGate({ ...base, family: 'same-problem-repeated', currentModelId: 'claude-opus-5', escalationsUsed: 1 });
  assert.deepEqual([second.action, second.reasonCode], ['blocked-report', 'ESCALATION_BUDGET_USED']);
  assert.equal(escalationGate({ ...base, family: 'unclear' }).action, 'continue');
  assert.equal(escalationGate({ ...base, family: 'repair-exhausted', currentModelId: 'claude-fable-5-1' }).reasonCode, 'NO_STRONGER_ELIGIBLE_MODEL');
  assert.equal(escalationGate({ ...base, family: 'repair-exhausted', policy: policy({ pins: { modelPin: 'claude-sonnet-5', effortPin: null } }) }).reasonCode, 'MODEL_PINNED');
});

test('RTE-08: downgrade only at a safe handoff with complete criteria and readiness; effort from the registry, pin kept', () => {
  const ok = { atSafeHandoff: true, acceptanceCriteria: ['unit tests pass', 'no public API change'], readiness: 0.92, readinessThreshold: 0.85, sliceVerified: true };
  assert.deepEqual(downgradeGate(ok), { allowed: true, reasonCode: 'SAFE_DOWNGRADE' });
  assert.equal(downgradeGate({ ...ok, atSafeHandoff: false }).reasonCode, 'NOT_AT_SAFE_HANDOFF');
  assert.equal(downgradeGate({ ...ok, acceptanceCriteria: [] }).reasonCode, 'ACCEPTANCE_CRITERIA_INCOMPLETE');
  assert.equal(downgradeGate({ ...ok, acceptanceCriteria: ['tests pass', ' '] }).reasonCode, 'ACCEPTANCE_CRITERIA_INCOMPLETE');
  assert.equal(downgradeGate({ ...ok, sliceVerified: false }).reasonCode, 'SLICE_NOT_VERIFIED');
  assert.equal(downgradeGate({ ...ok, readiness: 0.6 }).reasonCode, 'READINESS_BELOW_THRESHOLD');
  assert.equal(downgradeGate({ ...ok, readiness: null, onlyModelSaysEasy: true }).reasonCode, 'MODEL_OPINION_NOT_EVIDENCE');
  const reg = registry();
  const sonnet = registryModel(reg, 'claude-sonnet-5');
  const none = { modelPin: null, effortPin: null };
  assert.deepEqual(chooseEffort(sonnet, 'high', none), { effort: 'high', reasonCode: 'EFFORT_SELECTED' });
  assert.deepEqual(chooseEffort(sonnet, 'max', none), { effort: null, reasonCode: 'EFFORT_UNSUPPORTED' });
  assert.deepEqual(chooseEffort(sonnet, 'low', { modelPin: null, effortPin: 'medium' }), { effort: 'medium', reasonCode: 'EFFORT_PINNED' });
  assert.deepEqual(chooseEffort(sonnet, 'low', { modelPin: null, effortPin: 'ultra' }), { effort: 'ultra', reasonCode: 'EFFORT_PIN_UNSUPPORTED' });
  assert.deepEqual(chooseEffort(registryModel(BUNDLED_MODEL_REGISTRY, 'claude-sonnet-5'), 'xhigh', none), { effort: 'xhigh', reasonCode: 'EFFORT_SELECTED' });
  assert.deepEqual(chooseEffort(registryModel(BUNDLED_MODEL_REGISTRY, 'claude-haiku-4-5-20251001'), 'high', none), { effort: null, reasonCode: 'EFFORT_NOT_EXPOSED' }, 'Haiku 4.5 has no effort parameter');
});

test('RTE-09: outage routing uses only the preapproved list and never broadens provider or region', () => {
  const reg = registry({
    entries: [
      model('claude-opus-5', 'opus', 5, 25, 0.5, { health: 'unavailable' }),
      model('claude-sonnet-5', 'sonnet', 2, 10, null),
      model('claude-haiku-4-5-20251001', 'haiku', 1, 5, null, { regions: ['global', 'us'] }),
      // Another provider (one allowed by default, so only the fallback rule refuses it).
      model('claude-fable-5-1', 'fable', 10, 50, 0.25, { provider: 'openai' }),
    ],
  });
  const ledger = new FallbackLedger();
  const approved = [{ fromModelId: 'claude-opus-5', toModelId: 'claude-sonnet-5' }];
  const base = { currentModelId: 'claude-opus-5', registry: reg, approved, policy: policy({ allowedRegions: ['global', 'us'] }), ledger };
  assert.deepEqual(outageFallback(base), { modelId: 'claude-sonnet-5', reasonCode: 'FALLBACK_APPROVED' });
  assert.deepEqual(outageFallback({ ...base, requestedModelId: 'claude-haiku-4-5-20251001' }), { modelId: null, reasonCode: 'FALLBACK_NOT_APPROVED' });
  assert.equal(outageFallback({ ...base, approved: [{ fromModelId: 'claude-opus-5', toModelId: 'claude-haiku-4-5-20251001' }] }).reasonCode, 'FALLBACK_BROADENS_REGION');
  assert.equal(outageFallback({ ...base, approved: [{ fromModelId: 'claude-opus-5', toModelId: 'claude-fable-5-1' }] }).reasonCode, 'FALLBACK_BROADENS_PROVIDER');
  assert.equal(outageFallback({ ...base, approved: [] }).reasonCode, 'NO_APPROVED_FALLBACK');
  assert.equal(outageFallback({ ...base, currentModelId: 'claude-sonnet-5' }).reasonCode, 'NOT_IN_OUTAGE');
  assert.equal(ledger.unauthorizedFallbacks, 0);
  assert.equal(ledger.refusedRequests, 1);
});

test('RTE-10 and RTE-11: unevaluated and unknown slices are named; requested and observed models stay apart', () => {
  const coverage = sliceCoverage({
    taxonomy: ['bounded-edit', 'refactor', 'security-fix'],
    qualities: [q('claude-sonnet-5', 0.8, 0.9, 0.95), q('claude-opus-5', 0.8, 0.9, 0.95, 'refactor')],
    observedSlices: ['bounded-edit', 'data-migration', 'unknown-slice'],
    permittedSlices: ['bounded-edit'],
  });
  assert.deepEqual(coverage, { evaluated: ['bounded-edit'], unevaluated: ['refactor', 'security-fix'], unknown: ['data-migration', 'unknown-slice'] });
  const substituted = observeModel({ requestedModelId: 'claude-sonnet-5', sdkModelId: 'claude-haiku-4-5-20251001', harnessModelId: 'claude-sonnet-5', usageReported: true });
  assert.deepEqual(substituted, { requestedModelId: 'claude-sonnet-5', observedModelId: 'claude-haiku-4-5-20251001', observedFrom: 'sdk', substituted: true, costPrecision: 'provider-reported' });
  const missing = observeModel({ requestedModelId: 'claude-sonnet-5', usageReported: false, costEstimated: true });
  assert.deepEqual([missing.observedModelId, missing.substituted, missing.costPrecision], ['unknown', null, 'estimate']);
  const harness = observeModel({ requestedModelId: 'claude-sonnet-5', sdkModelId: '', harnessModelId: 'claude-sonnet-5', usageReported: false });
  assert.deepEqual([harness.observedFrom, harness.substituted, harness.costPrecision], ['harness', false, 'unknown']);
});

const KEYS = generateKeyPairSync('ed25519');
const PRIVATE = KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' });
const PUBLIC = KEYS.publicKey.export({ type: 'spki', format: 'pem' });
const TRUSTED = new Map([['calibration-test-key', PUBLIC]]);
const NOW = Date.parse('2026-09-25T12:00:00Z');
const CONTEXT = {
  nowMs: NOW, decisionSpecId: 'worker-readiness', decisionSpecVersion: 'v1', questionHash: H('a'), modelId: 'jev-1.13.0', modelRevisionHash: H('b'), encoderHash: H('c'), sliceId: 'bounded-edit',
};

function unsignedArtifact(overrides = {}) {
  return {
    id: 'cal-worker-readiness-synthetic-1', schemaVersion: '1.0', releaseState: 'released', decisionSpecId: 'worker-readiness', decisionSpecVersion: 'v1',
    dataset: { id: 'synthetic-routing-corpus', version: 'v1', contentHash: H('d') }, questionHash: H('a'), model: { modelId: 'jev-1.13.0', revisionHash: H('b') }, encoderHash: H('c'),
    threshold: { metric: 'noul-probability', value: 0.8, errorBudget: 0.05 },
    permittedSlices: [{ sliceId: 'bounded-edit', calibrationSampleSize: 120, holdoutSampleSize: 60 }, { sliceId: 'tiny-slice', calibrationSampleSize: 12, holdoutSampleSize: 6 }],
    uncertaintyInterval: { lower: 0.82, upper: 0.93, confidenceLevel: 0.95, method: 'wilson' },
    reviewer: { id: 'reviewer-synthetic', reviewedAt: '2026-09-20T00:00:00Z' }, issuedAt: '2026-09-21T00:00:00Z', expiresAt: '2026-12-21T00:00:00Z', expiryConditions: ['model-revision-changed', 'encoder-changed', 'question-changed'],
    ...overrides,
  };
}

function signed(overrides = {}, key = PRIVATE, keyId = 'calibration-test-key') {
  return contracts.signRecord(unsignedArtifact(overrides), key, keyId);
}

test('RTE-04: a valid signed artifact is select-eligible; each failure abstains with a named reason', () => {
  const options = { trustedKeys: TRUSTED, context: CONTEXT };
  const ok = checkCalibration(signed(), options);
  assert.equal(ok.eligible, true, JSON.stringify(ok));
  assert.equal(ok.qualityFloor, 0.8);
  assert.equal(ok.keyId, 'calibration-test-key');
  const reason = (value, extra = {}) => {
    const decision = checkCalibration(value, { ...options, ...extra });
    assert.equal(decision.eligible, false);
    return `${decision.stage}:${decision.reasonCode}`;
  };
  assert.equal(reason(signed(), { context: { ...CONTEXT, nowMs: Date.parse('2027-01-01T00:00:00Z') } }), 'applies:EXPIRED');
  assert.equal(reason(signed(), { context: { ...CONTEXT, questionHash: H('e') } }), 'applies:QUESTION_MISMATCH');
  assert.equal(reason(signed(), { context: { ...CONTEXT, modelRevisionHash: H('e') } }), 'applies:MODEL_MISMATCH');
  assert.equal(reason(signed(), { context: { ...CONTEXT, encoderHash: H('e') } }), 'applies:ENCODER_MISMATCH');
  assert.equal(reason(signed(), { context: { ...CONTEXT, sliceId: 'tiny-slice' } }), 'applies:SLICE_TOO_SMALL');
  assert.equal(reason(signed(), { context: { ...CONTEXT, sliceId: 'other-slice' } }), 'applies:SLICE_NOT_PERMITTED');
  assert.equal(reason(signed({ releaseState: 'draft' })), 'applies:DRAFT');
  assert.equal(reason(signed(), { killSwitchStopped: true }), 'kill-switch:KILL_SWITCH');
  const tampered = { ...signed(), threshold: { metric: 'noul-probability', value: 0.5, errorBudget: 0.05 } };
  assert.equal(reason(tampered), 'signature:BAD_SIGNATURE', 'a threshold change is a policy release');
  const other = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.equal(reason(signed({}, other, 'someone-else')), 'signature:UNKNOWN_KEY');
  assert.equal(reason({ ...signed(), extra: true }), 'validate:INVALID_ARTIFACT');
  assert.equal(reason({ published: true, verdict: 'passed' }), 'validate:INVALID_ARTIFACT');
  // Validation runs before the signature: an invalid artifact never reaches key lookup.
  assert.equal(reason({ ...unsignedArtifact({ releaseState: 'published' }), signature: signed().signature }), 'validate:INVALID_ARTIFACT');
});

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-route-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test('RTE-04: the loader reads the release file byte-identically on every OS; hostile files abstain', async (t) => {
  const home = tempHome(t);
  const file = calibrationFileFor(home);
  const options = { home, trustedKeys: TRUSTED, context: CONTEXT };
  assert.deepEqual(await loadCalibration(options), { eligible: false, stage: 'read', reasonCode: 'NO_RELEASE', detail: 'no signed baseline release in this package and no calibration release in the config folder' });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `﻿${JSON.stringify(signed(), null, 2).replace(/\n/g, '\r\n')}`);
  assert.equal((await loadCalibration(options)).eligible, true, 'BOM and CRLF do not change the verdict');
  writeFileSync(file, '{"__proto__": {"polluted": true}}');
  assert.equal((await loadCalibration(options)).reasonCode, 'UNSAFE_KEYS');
  assert.equal({}.polluted, undefined);
  writeFileSync(file, 'not json');
  assert.equal((await loadCalibration(options)).reasonCode, 'NOT_JSON');
  writeFileSync(file, ' '.repeat(core.CALIBRATION_FILE_CAP + 1));
  assert.equal((await loadCalibration(options)).reasonCode, 'TOO_LARGE');
  const keys = calibrationKeysFrom(JSON.stringify({ keys: [{ keyId: 'k1', role: 'calibration', publicKeyPem: PUBLIC }, { keyId: 'k2', role: 'certification', publicKeyPem: PUBLIC }] }));
  assert.deepEqual([...keys.keys()], ['k1'], 'only calibration-role keys are trusted');
  assert.equal(calibrationKeysFrom('{bad').size, 0);
});

function fakeQuery(model, usage) {
  return (args) => ({
    close() {},
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', session_id: 'sess-1', model };
      yield {
        type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1', num_turns: 2, result: 'done', total_cost_usd: 0.1,
        usage: { input_tokens: usage.input, output_tokens: usage.output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        modelUsage: { [model]: { inputTokens: usage.input, outputTokens: usage.output, costUSD: 0.1 } },
      };
      void args;
    },
  });
}

test('RTE-12: signed synthetic release -> router -> reservation -> owned launch -> receipt; the kill switch stops the next selection', async (t) => {
  const home = tempHome(t);
  const file = calibrationFileFor(home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(signed()));
  let stopped = false;
  const launches = [];
  const budget = DecisionBudget.open(join(home, 'generation-budget.json'), { limitMicroUsd: 50_000_000 });
  const launch = async ({ model, maxBudgetUsd, reservationId }) => {
    launches.push({ model, reservationId });
    return runOwnedWorker({ prompt: 'implement the bounded edit', model, cwd: join(home, 'worktree'), allowedTools: ['Read', 'Edit'], maxTurns: 5, maxBudgetUsd, timeoutMs: 60_000, query: fakeQuery(model, { input: 1_500_000, output: 150_000 }) });
  };
  const input = (taskId) => ({
    taskId,
    workspaceId: 'w1',
    killSwitchStopped: () => stopped,
    loadCalibration: () => loadCalibration({ home, trustedKeys: TRUSTED, context: CONTEXT }),
    route: { registry: registry(), policy: policy(), volume: VOLUME, assumptions: ASSUMPTIONS, qualities: [q('claude-opus-5', 0.9, 0.94, 0.97), q('claude-sonnet-5', 0.86, 0.9, 0.94), q('claude-haiku-4-5-20251001', 0.6, 0.7, 0.8)] },
    budget,
    launch,
  });
  const first = await runManagedWorker(input('task-1'));
  assert.equal(first.launched, true, JSON.stringify(first));
  assert.equal(first.selection.modelId, 'claude-sonnet-5');
  const chosen = first.selection.scored.find((c) => c.modelId === 'claude-sonnet-5');
  assert.ok(chosen.quality.lower >= 0.8, 'the worker is within the quality floor');
  assert.equal(first.receipt.status, 'completed');
  assert.deepEqual([first.observation.requestedModelId, first.observation.observedModelId, first.observation.substituted], ['claude-sonnet-5', 'claude-sonnet-5', false]);
  assert.equal(first.settledMicroUsd, 4_500_000);
  const snapshot = await budget.snapshot();
  assert.equal(snapshot.committedMicroUsd, 4_500_000);
  assert.equal(snapshot.reservedMicroUsd, 0);
  assert.deepEqual(launches.map((l) => l.model), ['claude-sonnet-5']);
  stopped = true;
  const next = await runManagedWorker(input('task-2'));
  assert.deepEqual([next.launched, next.reasonCode], [false, 'KILL_SWITCH']);
  assert.equal(launches.length, 1, 'no launch after the kill switch');
  assert.equal((await budget.snapshot()).reservedMicroUsd, 0, 'nothing reserved after the kill switch');
  stopped = false;
  writeFileSync(file, JSON.stringify(signed({ releaseState: 'draft' })));
  const draft = await runManagedWorker(input('task-3'));
  assert.deepEqual([draft.launched, draft.reasonCode], [false, 'CALIBRATION_DRAFT']);
});

test('RTE-12 observe and advise: the router choice is recorded as a counterfactual with its policy version; nothing is reserved or launched', async (t) => {
  const home = tempHome(t);
  const file = calibrationFileFor(home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(signed()));
  const engine = core.createDecisionEngine({ transport: null, journalDir: join(home, 'decisions'), budget: null });
  const budget = DecisionBudget.open(join(home, 'generation-budget.json'), { limitMicroUsd: 50_000_000 });
  const launches = [];
  const run = (mode, taskId) =>
    runManagedWorker({
      taskId,
      workspaceId: 'w1',
      mode,
      killSwitchStopped: () => false,
      loadCalibration: () => loadCalibration({ home, trustedKeys: TRUSTED, context: CONTEXT }),
      route: { registry: registry(), policy: policy(), volume: VOLUME, assumptions: ASSUMPTIONS, qualities: [q('claude-opus-5', 0.9, 0.94, 0.97), q('claude-sonnet-5', 0.86, 0.9, 0.94)] },
      budget,
      launch: async (input) => {
        launches.push(input);
        throw new Error('no launch outside bounded-auto');
      },
      record: async ({ action, reasonCodes, mode: recorded }) => {
        const out = await engine.recordAdvice({ specId: 'worker-route', workspaceId: 'w1', evidenceRevision: 'r1', taskId, mode: recorded, action, reasonCodes });
        return out.ok ? out.decisionId : null;
      },
    });
  for (const [mode, reason] of [['observe', 'OBSERVE_MODE'], ['advise', 'ADVISE_MODE']]) {
    const result = await run(mode, `task-${mode}`);
    assert.deepEqual([result.launched, result.reasonCode, result.selection.modelId], [false, reason, 'claude-sonnet-5']);
    const record = await engine.lookup(result.decisionId);
    assert.deepEqual(record.proposedAction, { kind: 'route-worker', taskId: `task-${mode}`, modelId: 'claude-sonnet-5', profileId: 'managed-worker' });
    assert.deepEqual([record.outcome, record.mode, record.appliedAction, record.billingBasis], ['advisory', mode, null, 'no-provider-call']);
    assert.deepEqual(record.reasonCodes.slice(0, 2), [reason, 'COUNTERFACTUAL']);
    assert.ok(record.reasonCodes.includes('DECISION_ADVISORY'));
    assert.equal(contracts.DecisionRecordContract.validate(record).ok, true);
    const text = core.explainDecision(record);
    assert.match(text, new RegExp(`route-worker \\(model claude-sonnet-5 for task task-${mode}\\)`));
    assert.match(text, new RegExp(`Policy version ${record.policyVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }
  assert.deepEqual(launches, []);
  const snapshot = await budget.snapshot();
  assert.equal(snapshot.reservedMicroUsd + snapshot.committedMicroUsd, 0);
  const withCalibration = await engine.recordAdvice({ specId: 'main-route', workspaceId: 'w1', evidenceRevision: 'r1', action: { kind: 'advise', templateId: 'main-route', evidenceIds: [] }, reasonCodes: ['BELOW_MINIMUM_BENEFIT'], calibration: { id: 'cal-1', version: 'v1' } });
  const calibrated = await engine.lookup(withCalibration.decisionId);
  assert.deepEqual(calibrated.calibration, { id: 'cal-1', version: 'v1' }, 'route advice names the release it rests on');
  assert.equal(contracts.DecisionRecordContract.validate(calibrated).ok, true);
  assert.equal((await engine.lookup((await engine.recordAdvice({ specId: 'main-route', workspaceId: 'w1', evidenceRevision: 'r1', action: { kind: 'abstain', reasonCode: 'X' }, reasonCodes: [], calibration: { id: 'bad id', version: 'v1' } })).decisionId)).calibration, null, 'a malformed reference is dropped');
  assert.deepEqual(await engine.recordAdvice({ specId: 'bad id', workspaceId: 'w1', evidenceRevision: 'r1', action: { kind: 'abstain', reasonCode: 'X' }, reasonCodes: [] }), { ok: false, reasonCode: 'INVALID_REQUEST' });
});

test('RTE-06 surface port: adviseMainRoute(snapshot, registry, pins) returns contract advice; loadModelRegistry prefers a valid refresh', async (t) => {
  const snapshot = {
    sessionId: 's1', workspaceId: 'w1', revision: 'r1', mode: 'observe', requestedModelId: 'claude-opus-5', actualModelId: 'claude-opus-5',
    contextTokensEstimate: null, activeTaskIds: [], observedAt: '2026-09-25T12:00:00Z',
  };
  const open = adviseMainRoute(snapshot, BUNDLED_MODEL_REGISTRY, { modelPin: null, effortPin: null });
  assert.equal(contracts.RouteAdviceContract.validate(open).ok, true);
  assert.deepEqual([open.outcome, open.reasonCode, open.recommendedModelId], ['abstain', 'NO_ROUTE_DECISION', null]);
  const pinned = adviseMainRoute(snapshot, BUNDLED_MODEL_REGISTRY, { modelPin: 'claude-opus-5', effortPin: null });
  assert.deepEqual([pinned.outcome, pinned.pinState], ['keep', 'pinned-kept']);
  const home = tempHome(t);
  assert.equal(await core.loadModelRegistry({ home }), BUNDLED_MODEL_REGISTRY, 'no refresh: the bundled snapshot');
  const file = core.modelRegistryFile(home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(registry({ snapshotId: 'refresh-2026-10-01' })));
  assert.equal((await core.loadModelRegistry({ home })).snapshotId, 'refresh-2026-10-01');
  writeFileSync(file, JSON.stringify({ ...registry(), baselineModelId: 'claude-nonexistent' }));
  assert.equal(await core.loadModelRegistry({ home }), null, 'an invalid refresh never falls back to stale prices');
  writeFileSync(file, '{');
  assert.equal(await core.loadModelRegistry({ home }), null);
});
