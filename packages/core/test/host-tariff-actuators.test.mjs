// Serving hosts R50 (B's condition): every actuator refuses to act on a price it only estimates.
// route.turn is covered in route-turn-hosts.test.mjs; this file covers an owned worker's launch
// (runManagedWorker, bounded-auto) and the subagent route (R51, adviseSubagentRoute's
// blockedReason). Deterministic: bundled registry, a stub launch, temp HOME.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUNDLED_MODEL_REGISTRY as R, DecisionBudget, HOST_TARIFF_UNKNOWN, adviseSubagentRoute, emptyLearningState, LAUNCH_NOT_STARTED, routeAccessGates, runManagedWorker, subagentLearningKey } from '../dist/index.js';

const SLICE = 'bounded-edit';
const POLICY = {
  managedAllowlist: null,
  allowedRegions: ['global', 'unspecified', 'cn', 'sg'],
  requiredContextTokens: 50_000,
  requiredCapabilities: [],
  pins: { modelPin: null, effortPin: null },
  riskFloorFamilies: null,
  accountId: null,
  locallyEligible: ['kimi-k3', 'claude-opus-5-5'],
  consentedProviders: ['moonshot', 'anthropic'],
  // pinned-clock: inside the bundled snapshot's lifecycle windows.
  nowMs: Date.parse('2026-09-28T00:00:00Z'),
};
const q = (modelId) => ({ modelId, sliceId: SLICE, lower: 0.9, point: 0.95, upper: 0.99, sourceId: 'holdout-synthetic-1' });
const released = async () => ({ eligible: true, artifact: {}, keyId: 'k-test', qualityFloor: 0.8, sliceId: SLICE });

async function worker(t, { registry = R, servingHost, hostRoute, receipt } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'jevris-host-tariff-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const launches = [];
  const budget = DecisionBudget.open(join(home, 'generation-budget.json'), { limitMicroUsd: 50_000_000 });
  const result = await runManagedWorker({
    taskId: 'task-1',
    workspaceId: 'ws-1',
    killSwitchStopped: () => false,
    loadCalibration: released,
    route: {
      registry,
      policy: { ...POLICY, ...(servingHost === undefined ? {} : { servingHost }) },
      volume: { inputTokens: 400_000, outputTokens: 40_000 },
      assumptions: { verificationMicroUsd: 200_000, reworkMicroUsd: 3_000_000, routingOverheadMicroUsd: 21_000 },
      qualities: [q('kimi-k3'), q('claude-opus-5-5')],
      baselineModelId: 'claude-opus-5-5',
    },
    budget,
    launch: async ({ model }) => {
      launches.push(model);
      if (receipt !== undefined) return { requestedModel: model, ...receipt };
      return { status: 'completed', requestedModel: model, actualModel: model, usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, costUsd: null };
    },
    mode: 'bounded-auto',
    ...(hostRoute === undefined ? {} : { hostRoute }),
  });
  return { result, launches, budget };
}

test('R50: an owned worker launches at known tariffs: direct, or through a host that prices both sides', async (t) => {
  const direct = await worker(t);
  assert.deepEqual([direct.result.launched, direct.launches], [true, ['kimi-k3']], JSON.stringify(direct.result));
  const gateway = await worker(t, { servingHost: 'openrouter', hostRoute: { certified: true, read: workerConsent() } });
  assert.deepEqual([gateway.result.launched, gateway.launches], [true, ['kimi-k3']], JSON.stringify(gateway.result));
});

/** Consent for an owned worker: every maker granted, each host as given, pinned hosts with no row otherwise. */
const workerConsent = (hosts = {}) => (party) => (Object.hasOwn(hosts, party) ? (hosts[party] === 'granted' ? { granted: true } : { granted: false, reasonCode: hosts[party] }) : ['openrouter', 'kilo', 'nvidia'].includes(party) ? { granted: false, reasonCode: 'PROVIDER_CONSENT_MISSING' } : { granted: true });

test('R50 on owned workers: a launch through a pinned gateway needs route.host certified and the pair\'s consent; no host is as before', async (t) => {
  // Not certified, or no certification passed at all: never launched through the gateway.
  for (const hostRoute of [undefined, { certified: false, read: workerConsent() }]) {
    const off = await worker(t, { servingHost: 'openrouter', hostRoute });
    assert.deepEqual([off.result.launched, off.result.reasonCode, off.launches], [false, 'ROUTE_HOST_NOT_CERTIFIED', []], JSON.stringify(off.result));
  }
  // The gateway revoked, or the maker behind it without a grant (a gateway session is not signed in to the maker).
  const revoked = await worker(t, { servingHost: 'openrouter', hostRoute: { certified: true, read: workerConsent({ openrouter: 'PROVIDER_CONSENT_REVOKED' }) } });
  assert.deepEqual([revoked.result.launched, revoked.result.reasonCode, revoked.launches], [false, 'HOST_CONSENT_REVOKED', []], JSON.stringify(revoked.result));
  const maker = await worker(t, { servingHost: 'openrouter', hostRoute: { certified: true, read: workerConsent({ moonshot: 'PROVIDER_CONSENT_MISSING' }) } });
  assert.deepEqual([maker.result.launched, maker.launches], [false, []], JSON.stringify(maker.result));
  assert.match(maker.result.reasonCode, /^PROVIDER_CONSENT/);
  // Kilo forwards to OpenRouter: OpenRouter revoked blocks a Kilo launch too.
  const kilo = await worker(t, { servingHost: 'kilo', hostRoute: { certified: true, read: workerConsent({ openrouter: 'PROVIDER_CONSENT_REVOKED' }) } });
  assert.deepEqual([kilo.result.launched, kilo.result.reasonCode], [false, 'HOST_CONSENT_REVOKED'], JSON.stringify(kilo.result));
  // No host, null, or a maker id: today's behaviour, with no certification asked.
  for (const servingHost of [undefined, null, 'anthropic']) {
    const direct = await worker(t, { servingHost });
    assert.deepEqual([direct.result.launched, direct.launches], [true, ['kimi-k3']], `${servingHost} ${JSON.stringify(direct.result)}`);
  }
});

test('R50: an owned worker never launches when the choice or its baseline is priced by estimate on the route host (HOST_TARIFF_UNKNOWN)', async (t) => {
  // NVIDIA prices Kimi K3 as a free tier and does not serve Opus 5.5: both sides are estimates.
  const nvidia = await worker(t, { servingHost: 'nvidia' });
  assert.deepEqual([nvidia.result.launched, nvidia.result.reasonCode, nvidia.launches], [false, HOST_TARIFF_UNKNOWN, []], JSON.stringify(nvidia.result));
  // Only the baseline's tariff unknown on OpenRouter: still refused.
  const noOpus = { ...R, servings: R.servings.filter((s) => !(s.host === 'openrouter' && s.modelId === 'claude-opus-5-5')) };
  const baseline = await worker(t, { registry: noOpus, servingHost: 'openrouter' });
  assert.deepEqual([baseline.result.launched, baseline.result.reasonCode, baseline.launches], [false, HOST_TARIFF_UNKNOWN, []], JSON.stringify(baseline.result));
  assert.ok(baseline.result.selection.costEstimates.includes('claude-opus-5-5'));
  // B's LOW 33: a host that is neither pinned nor a maker fails closed; it is never the maker's price.
  const unpinned = await worker(t, { servingHost: 'together' });
  assert.deepEqual([unpinned.result.launched, unpinned.result.reasonCode, unpinned.launches], [false, HOST_TARIFF_UNKNOWN, []], JSON.stringify(unpinned.result));
  // A maker id as the session's host is a direct route: launched at the maker's tariff.
  const maker = await worker(t, { servingHost: 'anthropic' });
  assert.deepEqual([maker.result.launched, maker.launches], [true, ['kimi-k3']], JSON.stringify(maker.result));
});

// ------------------------------------------------------------------ R51: the subagent route

function subagentLearning(modelId, harness = 'opencode') {
  const state = emptyLearningState({ workspaceId: 'w-sub', now: '2026-09-27T00:00:00Z' });
  const key = subagentLearningKey('Plan', harness, R);
  return { ...state, versions: [...state.versions, { version: 1, parentVersion: 0, createdAt: '2026-09-27T01:00:00Z', reason: 'promotion', reasonCode: 'PROMOTED', sliceId: key, slices: { [key]: { mode: 'auto', modelId, baselineModelId: 'claude-opus-5-5', baselineRate: 0.9 } }, evidence: null }] };
}
const hostsConsent = (party) => (party === 'openrouter' || party === 'kilo' || party === 'nvidia' ? { granted: false, reasonCode: 'PROVIDER_CONSENT_MISSING' } : { granted: true });
const subagent = (extra = {}) =>
  adviseSubagentRoute({
    harness: 'opencode',
    subagentType: 'Plan',
    explicitModel: false,
    sessionModel: 'openrouter/moonshotai/kimi-k3',
    pins: { modelPin: null, effortPin: null },
    registry: R,
    nowMs: POLICY.nowMs,
    unavailableModels: {},
    learning: subagentLearning('glm-5.3'),
    consentedProviders: ['moonshot', 'zai', 'anthropic'],
    locallyEligible: ['glm-5.3'],
    seen: (modelId) => (modelId === 'glm-5.3' ? [{ raw: 'openrouter/z-ai/glm-5.3', servingHost: 'openrouter' }] : []),
    providerConsent: hostsConsent,
    hostRouteCertified: true,
    ...extra,
  });

test('R51: a subagent keeps the parent\'s gateway; applied only certified and at known tariffs, otherwise explained (blockedReason)', () => {
  const ok = subagent();
  assert.deepEqual([ok.outcome, ok.harnessModel, ok.blockedReason], ['propose', 'openrouter/z-ai/glm-5.3', null], JSON.stringify(ok));
  const uncertified = subagent({ hostRouteCertified: false });
  assert.deepEqual([uncertified.outcome, uncertified.blockedReason], ['propose', 'ROUTE_HOST_NOT_CERTIFIED']);
  assert.match(uncertified.text, /Not applied \(ROUTE_HOST_NOT_CERTIFIED\)/);
  // The child's tariff on the gateway unknown, or the parent's own model priced by estimate there.
  for (const modelId of ['glm-5.3', 'kimi-k3']) {
    const registry = { ...R, servings: R.servings.map((s) => (s.host === 'openrouter' && s.modelId === modelId ? { ...s, tariff: null, tariffBasis: 'unknown' } : s)) };
    const est = subagent({ registry });
    assert.deepEqual([est.outcome, est.blockedReason], ['propose', HOST_TARIFF_UNKNOWN], modelId);
    assert.match(est.text, /Not applied \(HOST_TARIFF_UNKNOWN\)/);
  }
  // Without B's reader, no pinned host is used and a gateway parent reads as an unknown host (phase 1).
  assert.equal(subagent({ providerConsent: undefined }).reasonCode, 'HOST_UNKNOWN');
  // A same-maker route through the maker stays under hooks.route alone: no route.host gate.
  const direct = subagent({ sessionModel: 'anthropic/claude-opus-5-5', learning: subagentLearning('claude-sonnet-5'), locallyEligible: ['claude-sonnet-5'], seen: () => [], hostRouteCertified: false });
  assert.deepEqual([direct.outcome, direct.harnessModel, direct.blockedReason], ['propose', 'anthropic/claude-sonnet-5', null], JSON.stringify(direct));
});

test('F\'s 057e8553: a bedrock-arn parent never routes, and on Kilo and OpenCode neither does a parent with no model (its host is unknown)', () => {
  assert.deepEqual([subagent({ sessionModel: 'bedrock-arn' }).outcome, subagent({ sessionModel: 'bedrock-arn' }).reasonCode], ['abstain', 'HOST_UNKNOWN']);
  assert.deepEqual([subagent({ sessionModel: null }).outcome, subagent({ sessionModel: null }).reasonCode], ['abstain', 'HOST_UNKNOWN']);
  // Claude Code names no host: a bedrock-arn session abstains, and one with no model keeps routing its alias.
  const claude = (sessionModel) =>
    adviseSubagentRoute({ harness: 'claude', subagentType: 'Plan', explicitModel: false, sessionModel, pins: { modelPin: null, effortPin: null }, registry: R, nowMs: POLICY.nowMs, unavailableModels: {}, learning: subagentLearning('claude-sonnet-5', 'claude'), consentedProviders: ['anthropic'] });
  assert.equal(claude('bedrock-arn').reasonCode, 'HOST_UNKNOWN');
  assert.equal(claude(null).outcome, 'propose', JSON.stringify(claude(null)));
});

test('R52 (C\'s LOW A): through a pinned host the router is offered only makers whose pair consent passes there, so it never picks a launch the gate refuses', () => {
  // Every candidate reached on OpenCode with an API key: each maker counts as signed in directly.
  const scopes = { 'kimi-k3': { harness: 'opencode', authMode: 'api-key' }, 'glm-5.3': { harness: 'opencode', authMode: 'api-key' }, 'claude-opus-5-5': { harness: 'opencode', authMode: 'api-key' } };
  // No stored grants for makers; OpenRouter itself has no row either.
  const noGrants = () => ({ granted: false, reasonCode: 'PROVIDER_CONSENT_MISSING' });
  const direct = routeAccessGates(R, { candidateScopes: scopes }, noGrants).consentedProviders;
  assert.ok(direct.includes('zai') && direct.includes('anthropic'), JSON.stringify(direct));
  // Through OpenRouter the session is signed in to OpenRouter only: no maker behind it without its grant.
  assert.deepEqual(routeAccessGates(R, { candidateScopes: scopes, servingHost: 'openrouter' }, noGrants).consentedProviders, []);
  // A grant for Z.ai lets it through the gateway; OpenRouter revoked lets nothing through.
  const zai = (party) => (party === 'zai' ? { granted: true } : noGrants());
  assert.deepEqual(routeAccessGates(R, { candidateScopes: scopes, servingHost: 'openrouter' }, zai).consentedProviders, ['zai']);
  const revoked = (party) => (party === 'openrouter' ? { granted: false, reasonCode: 'PROVIDER_CONSENT_REVOKED' } : zai(party));
  assert.deepEqual(routeAccessGates(R, { candidateScopes: scopes, servingHost: 'openrouter' }, revoked).consentedProviders, []);
  // Kilo forwards to OpenRouter: OpenRouter revoked blocks a Kilo route too.
  assert.deepEqual(routeAccessGates(R, { candidateScopes: scopes, servingHost: 'kilo' }, revoked).consentedProviders, []);
  // No host, null, or a maker id: the maker gate as before.
  for (const servingHost of [undefined, null, 'anthropic']) assert.deepEqual(routeAccessGates(R, { candidateScopes: scopes, servingHost }, noGrants).consentedProviders, direct, String(servingHost));
});

test('D\'s port refusal before any child starts (spawned: false) releases the reservation and records no run; a started run with no usage is still held', async (t) => {
  const refused = await worker(t, { receipt: { status: 'failed', actualModel: null, usage: null, costUsd: null, spawned: false } });
  assert.deepEqual([refused.result.launched, refused.result.reasonCode, refused.launches], [false, LAUNCH_NOT_STARTED, ['kimi-k3']], JSON.stringify(refused.result));
  const idle = await refused.budget.snapshot();
  assert.deepEqual([idle.reservedMicroUsd, idle.heldMicroUsd, idle.committedMicroUsd, idle.holds], [0, 0, 0, 0], JSON.stringify(idle));
  // A run that started and reported no usage: unknown spend, held for reconciliation as before.
  const unknown = await worker(t, { receipt: { status: 'failed', actualModel: null, usage: null, costUsd: null } });
  assert.equal(unknown.result.launched, true);
  const held = await unknown.budget.snapshot();
  assert.deepEqual([held.holds, held.heldMicroUsd > 0], [1, true], JSON.stringify(held));
});
