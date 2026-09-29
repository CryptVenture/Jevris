// The multi-provider registry wire (owner decision DOMAINS 7be3c43; routing design R2, R7, OD-3,
// with C): every addition is optional, so the bundled Anthropic snapshot stays valid; each new
// field is checked where it can be wrong.
import test from 'node:test';
import assert from 'node:assert/strict';

const c = await import('../dist/index.js');
const { BUNDLED_MODEL_REGISTRY } = await import('@jevris/core');

const clone = (value) => JSON.parse(JSON.stringify(value));
const valid = (registry) => c.ModelRegistryContract.validate(registry);
const codes = (registry) => {
  const result = valid(registry);
  return result.ok ? [] : result.issues.map((issue) => issue.code ?? issue.message);
};

function withEntry(patch) {
  const registry = clone(BUNDLED_MODEL_REGISTRY);
  registry.entries[0] = { ...registry.entries[0], ...patch(registry.entries[0]) };
  return registry;
}

test('the bundled snapshot is still valid, and the vocabularies are exported', () => {
  assert.equal(valid(clone(BUNDLED_MODEL_REGISTRY)).ok, true);
  assert.deepEqual([...c.PROVIDER_IDS], ['anthropic', 'openai', 'google', 'xai', 'zai', 'moonshot', 'deepseek', 'alibaba', 'minimax', 'mistral', 'meta']);
  assert.deepEqual([...c.SIGN_INS], ['api-key', 'subscription', 'workspace', 'unpaid']);
  assert.deepEqual([...c.EFFORT_VIA], ['flag', 'config', 'variant', 'model-name', 'none']);
  assert.deepEqual([...c.HARNESS_ID_TEMPLATES], ['{id}', '{provider}/{id}']);
});

test('harness access rows carry the harness defaults (R2)', () => {
  const registry = clone(BUNDLED_MODEL_REGISTRY);
  registry.harnessAccess[1] = { ...registry.harnessAccess[1], providerIds: ['anthropic'], idTemplate: '{provider}/{id}', signIns: ['api-key', 'subscription'], unattendedAllowed: true, effortVia: 'variant', effortLevels: ['low', 'high'], defaultEffort: null };
  assert.equal(valid(registry).ok, true, JSON.stringify(codes(registry)));
  for (const bad of [{ idTemplate: '{id}-{effort}' }, { signIns: ['api-key', 'api-key'] }, { signIns: ['oauth'] }, { effortVia: 'env' }, { providerIds: ['Bad Id'] }]) {
    const broken = clone(registry);
    broken.harnessAccess[1] = { ...broken.harnessAccess[1], ...bad };
    assert.equal(valid(broken).ok, false, JSON.stringify(bad));
  }
});

test('per-model harness rows: a harness model id everywhere but Antigravity, one row per harness (R2)', () => {
  const ok = withEntry(() => ({
    harnessModels: [
      { harness: 'codex', id: 'claude-opus-5-5', effortVia: 'config', efforts: { max: 'xhigh' } },
      { harness: 'antigravity', id: 'Claude Opus 5.5 (Thinking)', effortVia: 'model-name', efforts: { high: 'Claude Opus 5.5 (Thinking)' } },
      { harness: 'opencode', id: 'anthropic/claude-opus-5-5[1m]', effortVia: 'variant', effortLevels: ['low', 'medium'], defaultEffort: 'medium' },
    ],
  }));
  assert.equal(valid(ok).ok, true, JSON.stringify(codes(ok)));
  const display = withEntry(() => ({ harnessModels: [{ harness: 'codex', id: 'Claude Opus 5.5 (Thinking)', effortVia: 'config' }] }));
  assert.ok(codes(display).includes('NOT_A_HARNESS_MODEL_ID'), JSON.stringify(codes(display)));
  const twice = withEntry(() => ({ harnessModels: [{ harness: 'codex', id: 'a', effortVia: 'none' }, { harness: 'codex', id: 'b', effortVia: 'none' }] }));
  assert.ok(codes(twice).includes('DUPLICATE_HARNESS'));
  assert.equal(valid(withEntry(() => ({ harnessModels: [{ harness: 'codex', id: 'a', effortVia: 'none', efforts: { turbo: 'x' } }] }))).ok, false, 'an effort key outside the levels');
});

test('tariff: integer micro-USD beside the float form must agree; inclusive tiers; validUntil (R7)', () => {
  const priced = withEntry((entry) => ({
    tariff: {
      ...entry.tariff,
      inputMicroUsdPerMillion: Math.round(entry.tariff.inputPerMillion * 1e6),
      outputMicroUsdPerMillion: Math.round(entry.tariff.outputPerMillion * 1e6),
      storageMicroUsdPerMillionHour: 1_000_000,
      validUntil: '2026-11-21T00:00:00Z',
      tiers: [{ aboveInputTokens: 200_000, inputMultiplier: 2, outputMultiplier: 1.5, cacheMultiplier: null, inclusive: true }],
    },
  }));
  assert.equal(valid(priced).ok, true, JSON.stringify(codes(priced)));
  const disagree = clone(priced);
  disagree.entries[0].tariff.inputMicroUsdPerMillion += 1;
  assert.ok(codes(disagree).includes('PRICE_FORMS_DISAGREE'));
  const half = clone(priced);
  delete half.entries[0].tariff.outputMicroUsdPerMillion;
  assert.ok(codes(half).includes('INTEGER_PRICES_INCOMPLETE'));
  const fraction = clone(priced);
  fraction.entries[0].tariff.inputMicroUsdPerMillion = 1.5;
  assert.equal(valid(fraction).ok, false, 'integers only');
});

test('limits, caching, consent and data terms per sign-in', () => {
  const full = withEntry((entry) => ({
    maxInputTokens: 922_000,
    cache: { mode: 'explicit', ttls: ['5m', '1h'], minTokens: 1024, perModel: false },
    requiresProviderConsent: true,
    dataGovernance: {
      ...(entry.dataGovernance ?? { zdrEligible: false, requiredRetentionDays: null, sourceId: 'S1' }),
      bySignIn: [
        { signIn: 'api-key', trainsOnContent: false, retentionDays: 30, location: 'us', reasonCode: 'NO_TRAINING_API', sourceId: 'S1' },
        { signIn: 'workspace', trainsOnContent: null, retentionDays: null, location: null, reasonCode: 'TERMS_NOT_ESTABLISHED', sourceId: 'S1' },
      ],
    },
  }));
  assert.equal(valid(full).ok, true, JSON.stringify(codes(full)));
  const bad = clone(full);
  bad.entries[0].dataGovernance.bySignIn[0].reasonCode = 'no training';
  assert.equal(valid(bad).ok, false, 'codes only, never text');
});

test('a per-harness default baseline is a registry entry, one per harness (OD-3)', () => {
  const registry = clone(BUNDLED_MODEL_REGISTRY);
  registry.harnessDefaults = [{ harness: 'claude', baselineModelId: 'claude-opus-5-5' }, { harness: 'opencode', baselineModelId: 'claude-sonnet-5' }];
  assert.equal(valid(registry).ok, true, JSON.stringify(codes(registry)));
  registry.harnessDefaults.push({ harness: 'opencode', baselineModelId: 'gpt-9' });
  assert.ok(codes(registry).includes('DUPLICATE_HARNESS'));
  assert.ok(codes(registry).includes('DEFAULT_NOT_REGISTERED'));
});
