// Owner decisions 8c1f85d (a model served by several hosts), phase 1: until host support lands,
// a gateway or third-party id is unregistered on every path; the registry check reads every
// provider segment of a harness spelling; a route keeps the session's host and abstains when the
// host for its target is not known here.
import test from 'node:test';
import assert from 'node:assert/strict';

const core = await import('../dist/index.js');
const {
  BUNDLED_MODEL_REGISTRY: R,
  adviseSubagentRoute,
  emptyLearningState,
  harnessModelRef,
  hostKeptModelId,
  hostSpellings,
  learningSliceKey,
  registryModelOf,
  resolveHarnessModel,
  routeTurn,
  sessionSignedInProviders,
  validateModelRegistry,
} = core;
const { HARNESS_IDS: HARNESSES } = await import('@jevris/contracts');

// pinned-clock: every route here is decided at this time.
const NOW = Date.parse('2026-09-28T00:00:00Z');

const GATEWAY_IDS = [
  'openrouter/moonshotai/kimi-k3',
  'openrouter/anthropic/claude-opus-5-5',
  'nvidia/kimi-k3',
  'nvidia/moonshotai/kimi-k3',
  'kilo/anthropic/claude-sonnet-5',
  'openrouter/gpt-6-sol',
];

test('8c1f85d: one resolver: harnessModelRef agrees with registryModelOf on every harness, and a gateway id is unregistered everywhere', () => {
  const spellings = ['claude-opus-5-5', 'claude-opus-5-5[1m]', 'anthropic/claude-opus-5-5', 'moonshotai/kimi-k3', 'moonshotai-cn/kimi-k3', 'google-vertex/gemini-3.8-flash', 'gpt-6-sol', 'openai/gpt-6-sol', 'gemini-3.8-flash-high', ...GATEWAY_IDS];
  for (const raw of spellings) {
    for (const harness of HARNESSES) {
      const strict = registryModelOf(R, harness, raw);
      const ref = harnessModelRef(R, raw, harness);
      // Every harness spelling resolves to the same model through both; beyond them, only the
      // registry's own id or provider/id (the maker's spelling) resolves, where the harness runs it.
      if (strict !== null) assert.deepEqual([ref.registered, ref.modelId], [true, strict.modelId], `${harness} ${raw}`);
      else if (ref.registered) assert.ok(R.entries.some((e) => e.modelId === ref.modelId && [e.modelId, `${e.provider}/${e.modelId}`].includes(raw.replace(/\[1m\]$/, ''))), `${harness} ${raw}`);
      assert.equal(resolveHarnessModel(R, raw, harness)?.modelId ?? null, ref.registered ? ref.modelId : null, `${harness} ${raw}`);
    }
    // With no harness, it resolves only to a model some harness (or the registry's own id) names.
    const any = resolveHarnessModel(R, raw, null);
    if (any !== null) assert.ok(HARNESSES.some((h) => registryModelOf(R, h, raw)?.modelId === any.modelId) || R.entries.some((e) => e.modelId === any.modelId && [e.modelId, `${e.provider}/${e.modelId}`].includes(raw.replace(/\[1m\]$/, ''))), raw);
  }
  for (const raw of GATEWAY_IDS) {
    assert.equal(harnessModelRef(R, raw).registered, false, raw);
    assert.equal(resolveHarnessModel(R, raw, null), null, raw);
    for (const harness of HARNESSES) assert.equal(registryModelOf(R, harness, raw), null, `${harness} ${raw}`);
  }
  // The maker's own spellings still resolve without a harness.
  assert.deepEqual(resolveHarnessModel(R, 'moonshotai-cn/kimi-k3', null), { provider: 'moonshot', modelId: 'kimi-k3' });
  assert.deepEqual(resolveHarnessModel(R, 'claude-opus-5-5[1m]', null), { provider: 'anthropic', modelId: 'claude-opus-5-5' });
});

test('8c1f85d: a gateway session signs in no provider; the session model is read as the harness spelled it (bare-id fix)', () => {
  assert.deepEqual(sessionSignedInProviders(R, 'opencode', 'openrouter/moonshotai/kimi-k3'), []);
  assert.deepEqual(sessionSignedInProviders(R, null, 'openrouter/moonshotai/kimi-k3'), []);
  assert.deepEqual(sessionSignedInProviders(R, 'kilocode', 'nvidia/kimi-k3'), []);
  assert.deepEqual(sessionSignedInProviders(R, 'opencode', 'moonshotai-cn/kimi-k3'), ['moonshot']);
  // A registry id handed around by Jevris (no host named) counts on a harness that runs its provider.
  assert.deepEqual(sessionSignedInProviders(R, 'opencode', 'kimi-k3'), ['moonshot']);
  assert.deepEqual(sessionSignedInProviders(R, 'claude', 'claude-opus-5-5[1m]'), ['anthropic']);
});

test('8c1f85d HOLE 1: every provider segment of a harnessModels id must name the model\'s own provider', () => {
  const kimi = R.entries.findIndex((e) => e.modelId === 'kimi-k3');
  const withRow = (id) => ({ ...R, entries: R.entries.map((e, i) => (i === kimi ? { ...e, harnessModels: [...(e.harnessModels ?? []), { harness: 'opencode', id, effortVia: 'variant' }] } : e)) });
  for (const id of ['openrouter/moonshotai/kimi-k3', 'moonshotai/openrouter/kimi-k3', 'nvidia/kimi-k3']) {
    const checked = validateModelRegistry(withRow(id));
    assert.equal(checked.ok, false, id);
    assert.ok(checked.issues.some((issue) => issue.endsWith(':PROVIDER_ID_NOT_THIS_PROVIDER') || issue.endsWith(':HARNESS_ROW_IS_A_HOST')), id);
  }
  assert.equal(validateModelRegistry(withRow('moonshotai-cn/kimi-k3')).ok, true);
});

test('8c1f85d: a route keeps the session\'s host; another provider only through one spelling seen here', () => {
  const opus = { modelId: 'claude-opus-5-5', provider: 'anthropic' };
  const kimi = { modelId: 'kimi-k3', provider: 'moonshot' };
  const gemini = { modelId: 'gemini-3.7-flash', provider: 'google' };
  const gpt = { modelId: 'gpt-6-luna', provider: 'openai' };
  // Same provider: the session's segment, not providerIds[0].
  assert.deepEqual(hostKeptModelId(R, 'opencode', gemini, 'google-vertex/gemini-3.8-flash', false), { ok: true, id: 'google-vertex/gemini-3.7-flash' });
  assert.deepEqual(hostKeptModelId(R, 'kilocode', gemini, 'google/gemini-3.8-flash', false), { ok: true, id: 'google/gemini-3.7-flash' });
  // Another provider: one spelling (openai) and seen here; else the host is unknown.
  assert.deepEqual(hostKeptModelId(R, 'opencode', gpt, 'anthropic/claude-opus-5-5', true), { ok: true, id: 'openai/gpt-6-luna' });
  assert.deepEqual(hostKeptModelId(R, 'opencode', gpt, 'anthropic/claude-opus-5-5', false), { ok: false, reasonCode: 'HOST_UNKNOWN' });
  // Moonshot and Google have more than one host on OpenCode: never chosen for the session.
  assert.deepEqual(hostSpellings(R, 'opencode', 'moonshot', 'kimi-k3'), ['moonshot', 'moonshotai', 'moonshotai-cn']);
  assert.deepEqual(hostKeptModelId(R, 'opencode', kimi, 'anthropic/claude-opus-5-5', true), { ok: false, reasonCode: 'HOST_UNKNOWN' });
  assert.deepEqual(hostKeptModelId(R, 'opencode', gemini, 'anthropic/claude-opus-5-5', true), { ok: false, reasonCode: 'HOST_UNKNOWN' });
  // A gateway session keeps no host; a bare session id names none.
  assert.deepEqual(hostKeptModelId(R, 'opencode', opus, 'openrouter/anthropic/claude-sonnet-5', false), { ok: false, reasonCode: 'HOST_UNKNOWN' });
  assert.deepEqual(hostKeptModelId(R, 'opencode', gpt, 'gpt-6-sol', false), { ok: false, reasonCode: 'HOST_UNKNOWN' });
  // No provider segment in the harness's spelling: no host to keep.
  assert.deepEqual(hostKeptModelId(R, 'codex', { modelId: 'gpt-6-luna', provider: 'openai' }, 'gpt-6-sol', false), { ok: true, id: 'gpt-6-luna' });
  assert.deepEqual(hostKeptModelId(R, 'codex', opus, 'gpt-6-sol', true), { ok: false, reasonCode: 'NOT_ON_HARNESS' });
});

// ---------------------------------------------------------------------------------- route.turn

const SLICE = 'bounded-edit';
const OPEN = { taskId: 'task-1', risk: 'low', turnActuation: 'bounded-auto', turnReasonCode: null };

function promoted(modelId, baseline, extra = {}) {
  const state = emptyLearningState({ workspaceId: 'w-host', now: new Date(NOW).toISOString() });
  const key = learningSliceKey(SLICE, baseline, R);
  const last = state.versions[state.versions.length - 1];
  const version = { version: last.version + 1, parentVersion: last.version, createdAt: new Date(NOW).toISOString(), reason: 'promotion', reasonCode: 'PROMOTED', sliceId: key, slices: { ...last.slices, [key]: { mode: 'auto', modelId, baselineModelId: baseline, baselineRate: 0.9, ...extra } }, evidence: null };
  return { ...state, versions: [...state.versions, version] };
}

const consentAll = () => ({ granted: true });
const turn = (current, learning, extra = {}) =>
  routeTurn({ harness: 'opencode', current, registry: R, learning, sliceId: SLICE, scope: OPEN, mainSession: 'plugin-bounded-auto', killSwitchStopped: false, modelPin: null, nowMs: NOW, providerConsent: consentAll, ...extra });

test('8c1f85d: route.turn keeps the session\'s host, keeps its spelling on an effort-only change, and abstains on an unknown host', () => {
  // A Vertex session stays on Vertex (providerIds[0] would be google).
  const vertex = turn({ providerID: 'google-vertex', modelID: 'gemini-3.8-flash' }, promoted('gemini-3.7-flash', 'gemini-3.8-flash'));
  assert.deepEqual([vertex.outcome, vertex.actuate, vertex.model], ['switch', true, { providerID: 'google-vertex', modelID: 'gemini-3.7-flash' }], JSON.stringify(vertex));
  // Effort only: the session's own providerID and modelID, with the variant.
  const effort = turn({ providerID: 'google-vertex', modelID: 'gemini-3.8-flash' }, promoted('gemini-3.8-flash', 'gemini-3.8-flash', { effort: 'high' }));
  assert.deepEqual([effort.actuate, effort.model, effort.variant], [true, { providerID: 'google-vertex', modelID: 'gemini-3.8-flash' }, 'high'], JSON.stringify(effort));
  // Another provider: written only when seen on this harness under its one spelling.
  const unseen = turn({ providerID: 'anthropic', modelID: 'claude-opus-5-5' }, promoted('gpt-6-luna', 'claude-opus-5-5'));
  assert.deepEqual([unseen.outcome, unseen.reasonCode, unseen.actuate], ['abstain', 'NOT_ON_SESSION_HOST', false]);
  // R50: another maker's endpoint changes the session's host, so it acts only with route.host certified.
  const seen = turn({ providerID: 'anthropic', modelID: 'claude-opus-5-5' }, promoted('gpt-6-luna', 'claude-opus-5-5'), { locallyEligible: ['gpt-6-luna'], hostRouteCertified: true });
  assert.deepEqual([seen.actuate, seen.model], [true, { providerID: 'openai', modelID: 'gpt-6-luna' }]);
  assert.match(seen.text, /through openai \(this session uses anthropic\)/);
  const uncertified = turn({ providerID: 'anthropic', modelID: 'claude-opus-5-5' }, promoted('gpt-6-luna', 'claude-opus-5-5'), { locallyEligible: ['gpt-6-luna'] });
  assert.deepEqual([uncertified.outcome, uncertified.actuate, uncertified.reasonCode, uncertified.model], ['switch', false, 'ROUTE_HOST_NOT_CERTIFIED', { providerID: 'openai', modelID: 'gpt-6-luna' }]);
  // Kimi has two hosts on OpenCode: even seen and consented, the host is not chosen for the session.
  const kimi = turn({ providerID: 'anthropic', modelID: 'claude-opus-5-5' }, promoted('kimi-k3', 'claude-opus-5-5'), { locallyEligible: ['kimi-k3'] });
  assert.deepEqual([kimi.outcome, kimi.reasonCode], ['abstain', 'NOT_ON_SESSION_HOST']);
  // R50: a pinned gateway session reads as its model through that host; with no spelling of the
  // target seen there, the host is not guessed. A host Jevris does not pin stays unregistered.
  // (OpenRouter spells Opus 5.5 `anthropic/claude-opus-5.5`; the maker's own id is not its spelling.)
  const gateway = turn({ providerID: 'openrouter', modelID: 'anthropic/claude-opus-5.5' }, promoted('claude-sonnet-5', 'claude-opus-5-5'));
  assert.deepEqual([gateway.outcome, gateway.reasonCode], ['abstain', 'NOT_ON_SESSION_HOST']);
  assert.equal(turn({ providerID: 'openrouter', modelID: 'anthropic/claude-opus-5-5' }, promoted('claude-sonnet-5', 'claude-opus-5-5')).reasonCode, 'CURRENT_MODEL_UNREGISTERED');
  const unpinned = turn({ providerID: 'togetherai', modelID: 'anthropic/claude-opus-5-5' }, promoted('claude-sonnet-5', 'claude-opus-5-5'));
  assert.deepEqual([unpinned.outcome, unpinned.reasonCode], ['abstain', 'CURRENT_MODEL_UNREGISTERED']);
});

test('8c1f85d and R44: a subagent route keeps the session\'s host; an unreadable host is HOST_UNKNOWN, a model not seen there NOT_ON_SESSION_HOST', () => {
  const slices = (modelId) => {
    const base = emptyLearningState({ workspaceId: 'ws-sub', now: '2026-09-27T00:00:00Z' });
    return { ...base, versions: [...base.versions, { version: 1, parentVersion: 0, createdAt: '2026-09-27T01:00:00Z', reason: 'promotion', reasonCode: 'PROMOTED', sliceId: 'subagent:Explore', slices: { 'subagent:Explore': { mode: 'auto', modelId, baselineModelId: null, baselineRate: 0.9 } }, evidence: null }] };
  };
  const advise = (extra) => adviseSubagentRoute({ harness: 'opencode', subagentType: 'Explore', explicitModel: false, pins: { modelPin: null, effortPin: null }, registry: R, nowMs: NOW, unavailableModels: {}, signedPrior: null, consentedProviders: ['anthropic', 'google', 'moonshot', 'openai'], ...extra });
  const vertex = advise({ sessionModel: 'google-vertex/gemini-3.8-flash', learning: slices('gemini-3.7-flash'), locallyEligible: ['gemini-3.7-flash'] });
  assert.deepEqual([vertex.outcome, vertex.harnessModel], ['propose', 'google-vertex/gemini-3.7-flash'], JSON.stringify(vertex));
  assert.equal(advise({ sessionModel: 'anthropic/claude-opus-5-5', learning: slices('kimi-k3'), locallyEligible: ['kimi-k3'] }).reasonCode, 'NOT_ON_SESSION_HOST');
  assert.equal(advise({ sessionModel: 'anthropic/claude-opus-5-5', learning: slices('gpt-6-luna'), locallyEligible: null }).reasonCode, 'NOT_ON_SESSION_HOST');
  assert.equal(advise({ sessionModel: 'openrouter/anthropic/claude-opus-5-5', learning: slices('claude-sonnet-5'), locallyEligible: ['claude-sonnet-5'] }).reasonCode, 'HOST_UNKNOWN');
  const gpt = advise({ sessionModel: 'anthropic/claude-opus-5-5', learning: slices('gpt-6-luna'), locallyEligible: ['gpt-6-luna'] });
  assert.deepEqual([gpt.outcome, gpt.harnessModel], ['propose', 'openai/gpt-6-luna']);
});

// --------------------------------------------------------------------- R37: serving checks

const KIMI_TARIFF = { ...R.entries.find((e) => e.modelId === 'kimi-k3').tariff, version: 'openrouter-2026-09-27', sourceId: 'MODELSDEV-TEST' };
const OR_ROW = { harness: 'opencode', host: 'openrouter', segment: 'openrouter', signIns: ['api-key'], sourceIds: ['MODELSDEV-TEST'] };
const kimiServing = (extra = {}) => ({ host: 'openrouter', provider: 'moonshot', modelId: 'kimi-k3', hostModelId: 'moonshotai/kimi-k3', tariff: KIMI_TARIFF, tariffBasis: 'host', sourceIds: ['MODELSDEV-TEST'], ...extra });
const withServings = (servings, harnessHosts = [OR_ROW]) => ({ ...R, servings, harnessHosts });
const codes = (registry) => {
  const checked = validateModelRegistry(registry);
  return checked.ok ? [] : checked.issues.map((issue) => issue.slice(issue.lastIndexOf(':') + 1));
};

test('R37: a serving must name a registry entry, its own maker slug, a unique host id and no other model', () => {
  assert.deepEqual(codes(withServings([kimiServing()])), [], 'a well-formed serving passes');
  assert.deepEqual(codes(withServings([kimiServing({ modelId: 'kimi-k9', hostModelId: 'moonshotai/kimi-k9' })])), ['SERVING_NO_ENTRY']);
  // T-R4: an override cannot relabel a gateway's Moonshot id as another maker's model.
  assert.ok(codes(withServings([kimiServing({ provider: 'zai', modelId: 'glm-5.3', hostModelId: 'moonshotai/glm-5.3' })])).includes('SERVING_WRONG_MAKER'));
  assert.ok(codes(withServings([kimiServing({ hostModelId: 'unpinned-slug/kimi-k3' })])).includes('SERVING_WRONG_MAKER'), 'an unpinned maker slug is refused');
  assert.deepEqual(codes(withServings([kimiServing(), kimiServing()])), ['SERVING_DUPLICATE']);
  assert.ok(codes(withServings([kimiServing({ hostModelId: 'moonshotai/glm-5.3' })])).includes('SERVING_NAMES_ANOTHER_MODEL'));
  assert.deepEqual(codes(withServings([kimiServing({ hostModelId: 'moonshotai/Kimi-K3' })])), [], 'case is kept; the same model in another case is not another model');
  // A zero price is never a tariff (the contract refuses it too).
  assert.ok(codes(withServings([kimiServing({ tariff: { ...KIMI_TARIFF, inputPerMillion: 0, outputPerMillion: 0, inputMicroUsdPerMillion: 0, outputMicroUsdPerMillion: 0 } })])).includes('SERVING_FREE_PRICED'));
  // A harness a serving names must reach the host through a harnessHosts row.
  assert.deepEqual(codes(withServings([kimiServing({ harnesses: ['kilocode'] })])), ['SERVING_HARNESS_NO_HOST']);
  assert.deepEqual(codes(withServings([kimiServing({ harnesses: ['opencode'] })])), []);
});

test('R37: a harnessModels row cannot carry a serving host segment; host segments never overlap a maker id or alias (B LOW 17)', async () => {
  const { SERVING_HOSTS, PROVIDER_IDS } = await import('@jevris/contracts');
  const { PROVIDER_ID_ALIASES } = core;
  const segments = SERVING_HOSTS.flatMap((host) => Object.values(host.segments));
  const makerSpellings = new Set([...PROVIDER_IDS, ...Object.values(PROVIDER_ID_ALIASES).flat()]);
  for (const segment of segments) assert.equal(makerSpellings.has(segment), false, `${segment} must not be a maker id or alias`);
  const kimi = R.entries.findIndex((e) => e.modelId === 'kimi-k3');
  const withRow = (id) => ({ ...R, entries: R.entries.map((e, i) => (i === kimi ? { ...e, harnessModels: [...(e.harnessModels ?? []), { harness: 'opencode', id, effortVia: 'variant' }] } : e)) });
  assert.deepEqual(codes(withRow('openrouter/moonshotai/kimi-k3')), ['HARNESS_ROW_IS_A_HOST']);
  assert.deepEqual(codes(withRow('kilo/kimi-k3')), ['HARNESS_ROW_IS_A_HOST']);
});
