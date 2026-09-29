// Serving hosts R50 (design 4.3 to 6.3; B's condition; the coordinator's route.host rule): route.turn
// through a gateway session. The session is read through the one resolver; a route passes consent
// for its pair; it acts only at known tariffs (HOST_TARIFF_UNKNOWN) and, through a pinned host or
// onto another host, only with route.host certified (ROUTE_HOST_NOT_CERTIFIED). Pure: bundled
// registry, stub consent, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUNDLED_MODEL_REGISTRY as R, HOST_TARIFF_UNKNOWN, ROUTE_HOST_NOT_CERTIFIED, emptyLearningState, hostTariffGuard, learningSliceKey, routeTurn } from '../dist/index.js';

// pinned-clock: inside the bundled snapshot's lifecycle windows.
const NOW = Date.parse('2026-09-28T00:00:00Z');
const SLICE = 'bounded-edit';
const OPEN = { taskId: 'task-1', risk: 'low', turnActuation: 'bounded-auto', turnReasonCode: null };

function promoted(modelId, baseline) {
  const state = emptyLearningState({ workspaceId: 'w-hosts', now: new Date(NOW).toISOString() });
  const key = learningSliceKey(SLICE, baseline, R);
  const last = state.versions[state.versions.length - 1];
  const version = { version: last.version + 1, parentVersion: last.version, createdAt: new Date(NOW).toISOString(), reason: 'promotion', reasonCode: 'PROMOTED', sliceId: key, slices: { ...last.slices, [key]: { mode: 'auto', modelId, baselineModelId: baseline, baselineRate: 0.9 } }, evidence: null };
  return { ...state, versions: [...state.versions, version] };
}

/** Consent: every maker granted; each host as given (a reason code, or granted). */
const consent = (hosts = {}) => (party) => (Object.hasOwn(hosts, party) ? (hosts[party] === 'granted' ? { granted: true } : { granted: false, reasonCode: hosts[party] }) : ['openrouter', 'kilo', 'nvidia'].includes(party) ? { granted: false, reasonCode: 'PROVIDER_CONSENT_MISSING' } : { granted: true });
const seenAt = (spellings) => (modelId) => spellings.filter((s) => s.modelId === modelId).map(({ raw, servingHost }) => ({ raw, servingHost }));
const GLM_OR = { modelId: 'glm-5.3', raw: 'openrouter/z-ai/glm-5.3', servingHost: 'openrouter' };
const GLM_KILO = { modelId: 'glm-5.3', raw: 'kilo/z-ai/glm-5.3', servingHost: 'kilo' };
const GLM_NV = { modelId: 'glm-5.3', raw: 'nvidia/z-ai/glm-5.3', servingHost: 'nvidia' };
const KIMI_OR = { providerID: 'openrouter', modelID: 'moonshotai/kimi-k3' };

const turn = (current, extra = {}, harness = 'opencode') =>
  routeTurn({ harness, current, registry: R, learning: promoted('glm-5.3', 'kimi-k3'), sliceId: SLICE, scope: OPEN, mainSession: 'plugin-bounded-auto', killSwitchStopped: false, modelPin: null, nowMs: NOW, providerConsent: consent(), hostRouteCertified: true, ...extra });

test('R50: a gateway session routes through its own gateway with route.host certified, and is advice without it', () => {
  const on = turn(KIMI_OR, { seen: seenAt([GLM_OR]) });
  assert.deepEqual([on.outcome, on.actuate, on.reasonCode, on.model], ['switch', true, 'PROMOTED_SAVING', { providerID: 'openrouter', modelID: 'z-ai/glm-5.3' }], JSON.stringify(on));
  assert.doesNotMatch(on.text, /this session uses/, 'the host is kept, so no host note');
  // The gateway is signed in (the session runs through it, OQ-3): no grant is needed for it.
  const off = turn(KIMI_OR, { seen: seenAt([GLM_OR]), hostRouteCertified: false });
  assert.deepEqual([off.outcome, off.actuate, off.reasonCode, off.model], ['switch', false, ROUTE_HOST_NOT_CERTIFIED, { providerID: 'openrouter', modelID: 'z-ai/glm-5.3' }]);
  assert.match(off.text, /Not switched \(ROUTE_HOST_NOT_CERTIFIED\)/);
  // Absent certification is not certification.
  assert.equal(turn(KIMI_OR, { seen: seenAt([GLM_OR]), hostRouteCertified: undefined }).actuate, false);
  // Nothing of the target seen on the gateway: the host is not guessed.
  const unseen = turn(KIMI_OR, { seen: seenAt([]) });
  assert.deepEqual([unseen.outcome, unseen.reasonCode], ['abstain', 'NOT_ON_SESSION_HOST']);
});

test('R50: the pair gate: the maker needs consent through a gateway, a revoked gateway blocks, and so does a host the gateway forwards to', () => {
  const maker = turn(KIMI_OR, { seen: seenAt([GLM_OR]), providerConsent: consent({ zai: 'PROVIDER_CONSENT_MISSING' }) });
  assert.equal(maker.outcome, 'abstain');
  assert.match(maker.reasonCode, /^PROVIDER_CONSENT/);
  // The session's own gateway revoked: not used, and the reason says so.
  const revoked = turn(KIMI_OR, { seen: seenAt([GLM_OR]), providerConsent: consent({ openrouter: 'PROVIDER_CONSENT_REVOKED' }) });
  assert.deepEqual([revoked.outcome, revoked.reasonCode], ['abstain', 'HOST_CONSENT_REVOKED'], JSON.stringify(revoked));
  // Kilo's gateway forwards to OpenRouter (02a1d4f4): OpenRouter revoked blocks a Kilo route too.
  const kiloSession = { providerID: 'kilo', modelID: 'moonshotai/kimi-k3' };
  const kiloOk = turn(kiloSession, { seen: seenAt([GLM_KILO]) }, 'kilocode');
  assert.deepEqual([kiloOk.actuate, kiloOk.model], [true, { providerID: 'kilo', modelID: 'z-ai/glm-5.3' }], JSON.stringify(kiloOk));
  const downstream = turn(kiloSession, { seen: seenAt([GLM_KILO]), providerConsent: consent({ openrouter: 'PROVIDER_CONSENT_REVOKED' }) }, 'kilocode');
  assert.deepEqual([downstream.outcome, downstream.reasonCode], ['abstain', 'HOST_CONSENT_REVOKED'], JSON.stringify(downstream));
  assert.match(downstream.text, /openrouter/);
});

test('R50 (OQ-1): a direct session takes the one other host seen only when consented, certified and priced', () => {
  const direct = { providerID: 'moonshotai', modelID: 'kimi-k3' };
  // OpenRouter is not signed in for a direct session: without a grant it is not used.
  const noGrant = turn(direct, { seen: seenAt([GLM_OR]) });
  assert.deepEqual([noGrant.outcome, noGrant.reasonCode], ['abstain', 'HOST_CONSENT_REQUIRED'], JSON.stringify(noGrant));
  const granted = turn(direct, { seen: seenAt([GLM_OR]), providerConsent: consent({ openrouter: 'granted' }) });
  assert.deepEqual([granted.actuate, granted.model], [true, { providerID: 'openrouter', modelID: 'z-ai/glm-5.3' }], JSON.stringify(granted));
  assert.match(granted.text, /through openrouter \(this session uses moonshot\)/);
  assert.equal(turn(direct, { seen: seenAt([GLM_OR]), providerConsent: consent({ openrouter: 'granted' }), hostRouteCertified: false }).reasonCode, ROUTE_HOST_NOT_CERTIFIED);
  // NVIDIA has no consent text (owner: no text), and its GLM-5.3 price is a free tier: never used.
  const nvidia = turn(direct, { seen: seenAt([GLM_NV]), providerConsent: consent({ nvidia: 'granted' }) });
  assert.deepEqual([nvidia.outcome, nvidia.reasonCode], ['abstain', 'HOST_CONSENT_REQUIRED'], JSON.stringify(nvidia));
});

test('R50 (B\'s condition): a route acts only at known tariffs on both sides; otherwise it is advice with HOST_TARIFF_UNKNOWN', () => {
  const unknownAt = (host, modelId) => ({ ...R, servings: R.servings.map((s) => (s.host === host && s.modelId === modelId ? { ...s, tariff: null, tariffBasis: 'unknown' } : s)) });
  const at = (registry) => routeTurn({ harness: 'opencode', current: KIMI_OR, registry, learning: promoted('glm-5.3', 'kimi-k3'), sliceId: SLICE, scope: OPEN, mainSession: 'plugin-bounded-auto', killSwitchStopped: false, modelPin: null, nowMs: NOW, providerConsent: consent(), hostRouteCertified: true, seen: seenAt([GLM_OR]) });
  // The target's tariff on the gateway is not known.
  const target = at(unknownAt('openrouter', 'glm-5.3'));
  assert.deepEqual([target.outcome, target.actuate, target.reasonCode, target.model], ['switch', false, HOST_TARIFF_UNKNOWN, { providerID: 'openrouter', modelID: 'z-ai/glm-5.3' }], JSON.stringify(target));
  // The session's own model (the baseline) priced only by estimate there: no action either.
  const baseline = at(unknownAt('openrouter', 'kimi-k3'));
  assert.deepEqual([baseline.actuate, baseline.reasonCode], [false, HOST_TARIFF_UNKNOWN]);
  // The mode and scope gates still come first, in the order a person would fix them.
  const advice = routeTurn({ harness: 'opencode', current: KIMI_OR, registry: unknownAt('openrouter', 'glm-5.3'), learning: promoted('glm-5.3', 'kimi-k3'), sliceId: SLICE, scope: OPEN, mainSession: 'advice-only', killSwitchStopped: false, modelPin: null, nowMs: NOW, providerConsent: consent(), hostRouteCertified: true, seen: seenAt([GLM_OR]) });
  assert.equal(advice.reasonCode, 'MAIN_SESSION_ADVICE_ONLY');
});

test('R50: hostTariffGuard, the one guard every actuator calls', () => {
  // No host, or a maker id (its own, or another maker's API, which the router reads as its own maker): known.
  for (const servingHost of [undefined, null, 'moonshot', 'anthropic']) assert.equal(hostTariffGuard(R, [{ servingHost, modelId: 'kimi-k3' }]), null, String(servingHost));
  // B's LOW 33: a host string that is neither pinned nor a maker is never priced as if direct.
  for (const servingHost of ['togetherai', 'together', 'OpenRouter']) assert.equal(hostTariffGuard(R, [{ servingHost, modelId: 'kimi-k3' }]), HOST_TARIFF_UNKNOWN, servingHost);
  assert.equal(hostTariffGuard(R, [{ servingHost: 'openrouter', modelId: 'kimi-k3' }, { servingHost: 'openrouter', modelId: 'glm-5.3' }]), null);
  // A free tier, a missing serving, or a model the router named as an estimate: refused.
  assert.equal(hostTariffGuard(R, [{ servingHost: 'nvidia', modelId: 'glm-5.3' }]), HOST_TARIFF_UNKNOWN);
  assert.equal(hostTariffGuard(R, [{ servingHost: 'openrouter', modelId: 'kimi-k3' }, { servingHost: 'nvidia', modelId: 'claude-opus-5-5' }]), HOST_TARIFF_UNKNOWN);
  assert.equal(hostTariffGuard(R, [{ modelId: 'kimi-k3' }], ['kimi-k3']), HOST_TARIFF_UNKNOWN);
  assert.equal(hostTariffGuard(R, [{ modelId: 'kimi-k3' }], ['glm-5.3']), null, 'only the sides checked count');
  // No model on a side, or an unlisted one with no host, is left to the caller's own checks; an
  // unlisted model through a pinned host is refused (B's defence in depth).
  assert.equal(hostTariffGuard(R, [{ servingHost: 'openrouter', modelId: null }, { modelId: 'mystery-9' }]), null);
  assert.equal(hostTariffGuard(R, [{ servingHost: 'openrouter', modelId: 'mystery-9' }]), HOST_TARIFF_UNKNOWN);
});
