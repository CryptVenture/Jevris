// R30, OD-4: which providers the provider-consent gate lets through. A current grant allows; a
// revoke or stale grant blocks even while signed in; Kimi and DeepSeek always need a grant; else
// signed in allows and not signed in blocks.
import test from 'node:test';
import assert from 'node:assert/strict';

const core = await import('../dist/index.js');
const { BUNDLED_MODEL_REGISTRY: R, PROVIDER_CONSENT_REQUIRED, filterCandidates, providerConsentGate } = core;

const reader = (rows) => (provider) => rows[provider] ?? { granted: false, reasonCode: 'PROVIDER_CONSENT_MISSING' };

test('OD-4: a signed-in provider passes with no stored row; one not signed in is blocked', () => {
  const gate = providerConsentGate(R, ['anthropic'], reader({}));
  assert.deepEqual(gate.consentedProviders, ['anthropic']);
  assert.deepEqual(gate.blocked.map((b) => b.provider), ['deepseek', 'google', 'moonshot', 'openai', 'xai', 'zai']);
  assert.ok(gate.blocked.every((b) => b.reasonCode === PROVIDER_CONSENT_REQUIRED));
});

test('OD-4: a revoke or a stale grant blocks even while signed in; a current grant allows without a sign-in', () => {
  const gate = providerConsentGate(R, ['anthropic', 'openai', 'google'], reader({
    openai: { granted: false, reasonCode: 'PROVIDER_CONSENT_REVOKED' },
    google: { granted: false, reasonCode: 'PROVIDER_CONSENT_STALE' },
    xai: { granted: true },
  }));
  assert.deepEqual(gate.consentedProviders, ['anthropic', 'xai']);
  const why = Object.fromEntries(gate.blocked.map((b) => [b.provider, b.reasonCode]));
  assert.equal(why.openai, 'PROVIDER_CONSENT_REVOKED');
  assert.equal(why.google, 'PROVIDER_CONSENT_STALE');
});

test('7be3c43: Kimi and DeepSeek need a current grant even while signed in', () => {
  const gate = providerConsentGate(R, ['moonshot', 'deepseek'], reader({ deepseek: { granted: true } }));
  assert.ok(gate.consentedProviders.includes('deepseek'));
  assert.ok(!gate.consentedProviders.includes('moonshot'));
  assert.equal(gate.blocked.find((b) => b.provider === 'moonshot').reasonCode, PROVIDER_CONSENT_REQUIRED);
});

test('HIGH 6: consent that cannot be read blocks every provider, even the signed-in default', () => {
  for (const read of [() => { throw new Error('store closed'); }, () => ({ granted: false, reasonCode: 'PROVIDER_CONSENT_UNREADABLE' }), () => 'garbage']) {
    const gate = providerConsentGate(R, ['anthropic', 'moonshot'], read);
    assert.deepEqual(gate.consentedProviders, []);
    assert.equal(gate.blocked.find((b) => b.provider === 'anthropic').reasonCode, 'PROVIDER_CONSENT_UNREADABLE');
    assert.equal(gate.blocked.find((b) => b.provider === 'moonshot').reasonCode, 'PROVIDER_CONSENT_UNREADABLE');
  }
});

test('HIGH 5: the always-consent set is pinned in code; a placed registry can add a mark but never drop one', () => {
  const { signedInDefaultAllowed, filterCandidates: filter } = core;
  assert.deepEqual(['anthropic', 'openai', 'google', 'xai', 'zai', 'moonshot', 'deepseek', 'acme'].map(signedInDefaultAllowed), [true, true, true, true, true, false, false, false]);
  // An override that drops Kimi's and DeepSeek's marks: still blocked while signed in without a grant.
  const unmarked = { ...R, entries: R.entries.map((e) => ({ ...e, requiresProviderConsent: false })) };
  const gate = providerConsentGate(unmarked, ['anthropic', 'moonshot', 'deepseek'], reader({}));
  assert.deepEqual(gate.consentedProviders, ['anthropic']);
  // An override that adds an unmarked provider with no consent text: never allowed by the signed-in default.
  const acme = { ...R.entries.find((e) => e.modelId === 'gpt-6-sol'), provider: 'acme', modelId: 'acme-1', requiresProviderConsent: false };
  const added = { ...R, entries: [...R.entries, acme] };
  assert.equal(providerConsentGate(added, ['acme'], reader({})).blocked.find((b) => b.provider === 'acme').reasonCode, PROVIDER_CONSENT_REQUIRED);
  // The router's fallback (no consent list) applies the same pinned set.
  const result = filter(added, {
    managedAllowlist: null, allowedRegions: ['global', 'cn', 'sg', 'us', 'unspecified', 'eu'], requiredContextTokens: 1, requiredCapabilities: [], pins: { modelPin: null, effortPin: null },
    // pinned-clock: the routing time the gates are read at.
    riskFloorFamilies: null, accountId: null, locallyEligible: added.entries.map((e) => e.modelId), nowMs: Date.parse('2026-09-28T00:00:00Z'),
  });
  const gateOf = (id) => result.eliminated.find((e) => e.modelId === id)?.gate ?? 'eligible';
  assert.deepEqual([gateOf('acme-1'), gateOf('kimi-k3'), gateOf('claude-opus-5-5')], ['provider-consent', 'provider-consent', 'eligible']);
});

test('HIGH 5: a placed registry cannot relabel one provider\'s models as another\'s', () => {
  const { validateModelRegistry, registrySpellingIssues } = core;
  assert.deepEqual(registrySpellingIssues(R), []);
  // A DeepSeek access row that claims OpenCode's `anthropic` provider id.
  const relabel = { ...R, harnessAccess: R.harnessAccess.map((row) => (row.harness === 'opencode' && row.provider === 'deepseek' ? { ...row, providerIds: ['anthropic'] } : row)) };
  const refused = validateModelRegistry(relabel);
  assert.equal(refused.ok, false);
  assert.match(refused.issues.join(' '), /providerIds\/0:PROVIDER_ID_NOT_THIS_PROVIDER/);
  // A model's own harness spelling that names another provider, or another registered model.
  const spelled = (id) => ({ ...R, entries: R.entries.map((e) => (e.modelId === 'kimi-k3' ? { ...e, harnessModels: [{ harness: 'opencode', id, effortVia: 'variant' }] } : e)) });
  assert.match(validateModelRegistry(spelled('anthropic/kimi-k3')).issues.join(' '), /PROVIDER_ID_NOT_THIS_PROVIDER/);
  assert.match(validateModelRegistry(spelled('moonshotai/claude-opus-5-5')).issues.join(' '), /NAMES_ANOTHER_MODEL/);
  assert.equal(validateModelRegistry(spelled('moonshotai/kimi-k3')).ok, true);
});

test('the gate result feeds the router: a blocked provider\'s models are eliminated with gate provider-consent', () => {
  const gate = providerConsentGate(R, ['anthropic', 'moonshot'], reader({}));
  const result = filterCandidates(R, {
    managedAllowlist: null, allowedRegions: ['global', 'cn', 'sg', 'us', 'unspecified', 'eu'], requiredContextTokens: 1, requiredCapabilities: [], pins: { modelPin: null, effortPin: null },
    // pinned-clock: the routing time the gates are read at.
    riskFloorFamilies: null, accountId: null, locallyEligible: R.entries.map((e) => e.modelId), nowMs: Date.parse('2026-09-28T00:00:00Z'), consentedProviders: gate.consentedProviders,
  });
  const gateOf = (id) => result.eliminated.find((e) => e.modelId === id)?.gate ?? 'eligible';
  assert.equal(gateOf('claude-opus-5-5'), 'eligible');
  assert.equal(gateOf('kimi-k3'), 'provider-consent');
  assert.equal(gateOf('gpt-6-sol'), 'provider-consent', 'not signed in to OpenAI and no grant');
});
