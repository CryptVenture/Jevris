// Serving hosts R44 (design 4.3 and 4.4; owner decisions 8c1f85d and c8e933d, OQ-1): the session's
// host, the spelling a route writes for its target (rules 1 to 3), and the signed-in parties.
import test from 'node:test';
import assert from 'node:assert/strict';

const core = await import('../dist/index.js');
const { BUNDLED_MODEL_REGISTRY: R, spellTarget, sessionHost, servingTariffKnown, sessionSignedInParties, ranHereParties, ranHereProviders, validateModelRegistry } = core;

const TARIFF = { ...R.entries.find((e) => e.modelId === 'kimi-k3').tariff, version: 'openrouter-2026-09-27', sourceId: 'MODELSDEV-TEST' };
const row = (harness, host) => ({ harness, host, segment: host, signIns: ['api-key'], sourceIds: ['MODELSDEV-TEST'] });
const serving = (host, provider, modelId, hostModelId, extra = {}) => ({ host, provider, modelId, hostModelId, tariff: TARIFF, tariffBasis: 'host', sourceIds: ['MODELSDEV-TEST'], ...extra });

/** The bundled registry plus OpenRouter on both harnesses, the Kilo Gateway on Kilo and NVIDIA on OpenCode. */
const REG = {
  ...R,
  harnessHosts: [row('opencode', 'openrouter'), row('kilocode', 'openrouter'), row('kilocode', 'kilo'), row('opencode', 'nvidia')],
  servings: [
    serving('openrouter', 'moonshot', 'kimi-k3', 'moonshotai/kimi-k3'),
    serving('kilo', 'moonshot', 'kimi-k3', 'moonshotai/kimi-k3'),
    serving('kilo', 'zai', 'glm-5.3', 'z-ai/glm-5.3'),
    serving('openrouter', 'zai', 'glm-5.3', 'z-ai/glm-5.3'),
    serving('openrouter', 'deepseek', 'deepseek-flash', 'deepseek/deepseek-flash', { tariff: null, tariffBasis: 'unknown' }),
    serving('nvidia', 'moonshot', 'kimi-k3', 'moonshotai/kimi-k3', { tariff: null, tariffBasis: 'free-tier' }),
  ],
};

const KIMI = { provider: 'moonshot', modelId: 'kimi-k3' };
const GLM = { provider: 'zai', modelId: 'glm-5.3' };
const seen = (...raws) => raws.map((raw) => ({ raw, servingHost: 'as-stored' }));
const spell = (extra) => spellTarget({ registry: REG, harness: 'opencode', target: KIMI, sessionModel: 'anthropic/claude-opus-5-5', seen: [], eligibleHere: false, ...extra });
const ok = (r) => (r.ok ? [r.id, r.servingHost, r.via, r.rule, r.hostChanged, r.hostRoute] : [r.reasonCode, r.seenHosts]);
const ANY_HOST = { hostRoutes: true, hostAllowed: () => true };

test('R44: the test registry is valid', () => {
  const checked = validateModelRegistry(REG);
  assert.equal(checked.ok, true, JSON.stringify(checked.issues));
});

test('R44: sessionHost is the resolver on the session spelling', () => {
  assert.deepEqual([sessionHost(REG, 'opencode', 'openrouter/moonshotai/kimi-k3').servingHost, sessionHost(REG, 'opencode', 'moonshotai-cn/kimi-k3').servingHost], ['openrouter', 'moonshot']);
  assert.equal(sessionHost(REG, 'opencode', 'togetherai/moonshotai/kimi-k3'), null);
  assert.equal(sessionHost(REG, 'opencode', null), null);
});

test('R44 rule 1: the session keeps its host; the same maker keeps its endpoint; an effort-only change keeps the exact spelling', () => {
  // Same maker through the session's own endpoint (phase 1, 8c1f85d): no new evidence needed.
  const vertex = spell({ target: { provider: 'google', modelId: 'gemini-3.7-flash' }, sessionModel: 'google-vertex/gemini-3.8-flash' });
  assert.deepEqual(ok(vertex), ['google-vertex/gemini-3.7-flash', 'google', 'maker', 1, false, false]);
  // Effort only: the exact spelling, host or not.
  assert.deepEqual(ok(spell({ sessionModel: 'moonshotai-cn/kimi-k3' })), ['moonshotai-cn/kimi-k3', 'moonshot', 'maker', 1, false, false]);
  assert.deepEqual(ok(spell({ sessionModel: 'openrouter/moonshotai/kimi-k3', ...ANY_HOST })), ['openrouter/moonshotai/kimi-k3', 'openrouter', 'host', 1, false, true]);
  // A gateway session keeps its gateway, when the target's spelling there has been seen.
  const gw = spell({ target: GLM, sessionModel: 'openrouter/moonshotai/kimi-k3', seen: seen('openrouter/z-ai/glm-5.3'), ...ANY_HOST });
  assert.deepEqual(ok(gw), ['openrouter/z-ai/glm-5.3', 'openrouter', 'host', 1, false, true]);
  // The session's gateway serves it but that spelling was never seen, and nothing else was: abstain.
  assert.deepEqual(ok(spell({ target: GLM, sessionModel: 'openrouter/moonshotai/kimi-k3', ...ANY_HOST })), ['NOT_ON_SESSION_HOST', []]);
});

test('R44 rule 2 (OQ-1): the one other host seen, allowed and with a known tariff; the host change is stated', () => {
  // A Moonshot-direct Kilo session; GLM-5.3 seen only through the Kilo Gateway.
  const kilo = { harness: 'kilocode', target: GLM, sessionModel: 'moonshotai/kimi-k3', seen: seen('kilo/z-ai/glm-5.3') };
  assert.deepEqual(ok(spell({ ...kilo, ...ANY_HOST })), ['kilo/z-ai/glm-5.3', 'kilo', 'host', 2, true, true]);
  // Not allowed (R45's pair gate says no), or host routes still off: abstain, naming where it was seen.
  assert.deepEqual(ok(spell({ ...kilo, hostRoutes: true, hostAllowed: (h) => h !== 'kilo' })), ['NOT_ON_SESSION_HOST', ['kilo']]);
  assert.deepEqual(ok(spell(kilo)), ['NOT_ON_SESSION_HOST', ['kilo']]);
  // A tariff that is unknown or free-tier is not a known tariff (OQ-4).
  assert.deepEqual(ok(spell({ target: { provider: 'deepseek', modelId: 'deepseek-flash' }, seen: seen('openrouter/deepseek/deepseek-flash'), ...ANY_HOST })), ['NOT_ON_SESSION_HOST', ['openrouter']]);
  assert.deepEqual(ok(spell({ sessionModel: 'openai/gpt-6-sol', seen: seen('nvidia/moonshotai/kimi-k3'), ...ANY_HOST })), ['NOT_ON_SESSION_HOST', ['nvidia']]);
  // Another maker's own API is a host change too, but not a host route.
  assert.deepEqual(ok(spell({ seen: seen('moonshotai-cn/kimi-k3') })), ['moonshotai-cn/kimi-k3', 'moonshot', 'maker', 2, true, false]);
  // Leaving a gateway session for a maker's API is a host route.
  assert.deepEqual(ok(spell({ target: GLM, sessionModel: 'openrouter/moonshotai/kimi-k3', seen: seen('zai/glm-5.3'), ...ANY_HOST })), ['zai/glm-5.3', 'zai', 'maker', 2, true, true]);
});

test('R44 rule 3: two hosts seen, two endpoints of one maker seen, or a stale spelling: abstain; choosing is advice only', () => {
  assert.deepEqual(ok(spell({ seen: seen('openrouter/moonshotai/kimi-k3', 'moonshotai/kimi-k3'), ...ANY_HOST })), ['NOT_ON_SESSION_HOST', ['moonshot', 'openrouter']]);
  assert.deepEqual(ok(spell({ seen: seen('moonshotai/kimi-k3', 'moonshotai-cn/kimi-k3') })), ['NOT_ON_SESSION_HOST', ['moonshot']]);
  // A stored spelling is re-read through today's registry: one that no longer resolves is not evidence.
  assert.deepEqual(ok(spell({ seen: seen('togetherai/moonshotai/kimi-k3'), ...ANY_HOST })), ['NOT_ON_SESSION_HOST', []]);
  // A stored host is never trusted over the resolver.
  assert.deepEqual(ok(spell({ seen: [{ raw: 'moonshotai/kimi-k3', servingHost: 'openrouter' }] })), ['moonshotai/kimi-k3', 'moonshot', 'maker', 2, true, false]);
});

test('R44: phase 1 answers hold while host routes are off; a v1 offer (no spellings) uses local eligibility', () => {
  // An unreadable or gateway session gives no host: HOST_UNKNOWN (fail closed), with or without host routes.
  assert.equal(spell({ sessionModel: 'togetherai/moonshotai/kimi-k3', ...ANY_HOST }).reasonCode, 'HOST_UNKNOWN');
  assert.equal(spell({ sessionModel: 'openrouter/moonshotai/kimi-k3', target: GLM, seen: seen('zai/glm-5.3') }).reasonCode, 'HOST_UNKNOWN');
  // A host spelling is never written with host routes off, even as the only one seen.
  assert.equal(spell({ seen: seen('openrouter/moonshotai/kimi-k3') }).reasonCode, 'NOT_ON_SESSION_HOST');
  // v1: eligible here and the maker has one spelling: written; two endpoints: not chosen.
  assert.deepEqual(ok(spell({ target: GLM, eligibleHere: true })), ['NOT_ON_SESSION_HOST', []], 'Z.ai has two endpoints on OpenCode');
  assert.deepEqual(ok(spell({ target: { provider: 'openai', modelId: 'gpt-6-luna' }, eligibleHere: true })), ['openai/gpt-6-luna', 'openai', 'maker', 2, true, false]);
  assert.deepEqual(ok(spell({ target: { provider: 'openai', modelId: 'gpt-6-luna' } })), ['NOT_ON_SESSION_HOST', []]);
  // B's LOW 20: a v2 spelling recorded for T that no longer resolves is not a v1 offer, so no fallback.
  assert.deepEqual(ok(spell({ target: { provider: 'openai', modelId: 'gpt-6-luna' }, eligibleHere: true, seen: seen('openrouter/openai/gpt-6-luna') })), ['NOT_ON_SESSION_HOST', []]);
  // No session (an owned worker with no link): rule 2 only.
  assert.deepEqual(ok(spell({ sessionModel: null, seen: seen('moonshotai/kimi-k3') })), ['moonshotai/kimi-k3', 'moonshot', 'maker', 2, false, false]);
  // A harness with no provider segment names no host; one that cannot name the model at all says so.
  assert.deepEqual(ok(spellTarget({ registry: REG, harness: 'claude', target: { provider: 'anthropic', modelId: 'claude-sonnet-5' }, sessionModel: 'claude-opus-5-5', seen: [], eligibleHere: false })), ['claude-sonnet-5', 'anthropic', 'maker', 1, false, false]);
  assert.equal(spellTarget({ registry: REG, harness: 'codex', target: KIMI, sessionModel: 'gpt-6-sol', seen: [], eligibleHere: false }).reasonCode, 'NOT_ON_HARNESS');
});

test('R44: servingTariffKnown: the maker price, or a host tariff; never unknown or free-tier', () => {
  assert.equal(servingTariffKnown(REG, 'moonshot', 'moonshot', 'kimi-k3'), true);
  assert.equal(servingTariffKnown(REG, 'openrouter', 'moonshot', 'kimi-k3'), true);
  assert.equal(servingTariffKnown(REG, 'nvidia', 'moonshot', 'kimi-k3'), false);
  assert.equal(servingTariffKnown(REG, 'openrouter', 'deepseek', 'deepseek-flash'), false);
  assert.equal(servingTariffKnown(REG, 'togetherai', 'moonshot', 'kimi-k3'), false);
});

test('R44 (design 4.4): a gateway session and a gateway run sign in the gateway, never the maker behind it', () => {
  assert.deepEqual(sessionSignedInParties(REG, 'opencode', 'openrouter/moonshotai/kimi-k3', null), ['openrouter']);
  assert.deepEqual(sessionSignedInParties(REG, 'opencode', 'moonshotai-cn/kimi-k3', null), ['moonshot']);
  assert.deepEqual(sessionSignedInParties(REG, 'claude', 'claude-opus-5-5[1m]', 'anthropic'), ['anthropic']);
  assert.deepEqual(sessionSignedInParties(REG, 'opencode', 'togetherai/moonshotai/kimi-k3', null), []);
  const run = (modelId, raw, servingHost) => ({ harness: 'opencode', authMode: 'api-key', modelId, firstAt: '2026-09-28T00:00:00Z', lastAt: '2026-09-28T00:00:00Z', raw, servingHost, source: 'reported' });
  const offer = {
    listings: [],
    runs: [
      run('kimi-k3', 'openrouter/moonshotai/kimi-k3', 'openrouter'),
      run('glm-5.3', null, null), // v1: a direct spelling
      run('deepseek-flash', 'deepseek/deepseek-flash', 'deepseek'),
      run('not-a-model', 'kilo/x/not-a-model', 'kilo'),
      // Re-read, not trusted: a stored host that disagrees with the resolver, and a stale spelling.
      run('gpt-6-luna', 'openai/gpt-6-luna', 'openrouter'),
      run('gemini-3.7-flash', 'togetherai/google/gemini-3.7-flash', 'togetherai'),
    ],
  };
  assert.deepEqual(ranHereParties(REG, offer), ['deepseek', 'openai', 'openrouter', 'zai']);
  // The maker-only list (today's gate input) drops every run with a host that is not its maker, rather than crediting Moonshot.
  assert.deepEqual(ranHereProviders(REG, offer), ['deepseek', 'zai']);
  assert.deepEqual(ranHereParties(REG, null), []);
});
