// Serving hosts R55 (design 8; E's RouteServingSchema): the serving view route and explain show.
// Which host the session goes through, the host the target would be written through, whether the
// route keeps it and why not, what the price rests on and each party's consent state. Pure:
// bundled registry, stub consent reader, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUNDLED_MODEL_REGISTRY as R, HOST_TARIFF_UNKNOWN, routeServingOf, servingView, sessionSignedInParties } from '../dist/index.js';

/** Consent: every maker granted; each host as given (a reason code, or granted); pinned hosts missing otherwise. */
const consent = (hosts = {}) => (party) => (Object.hasOwn(hosts, party) ? (hosts[party] === 'granted' ? { granted: true } : { granted: false, reasonCode: hosts[party] }) : ['openrouter', 'kilo', 'nvidia'].includes(party) ? { granted: false, reasonCode: 'PROVIDER_CONSENT_MISSING' } : { granted: true });
const GLM = { provider: 'zai', modelId: 'glm-5.3' };
const GLM_OR = { raw: 'openrouter/z-ai/glm-5.3', servingHost: 'openrouter' };
const view = (harness, sessionSpelling, extra = {}) =>
  routeServingOf({ registry: R, harness, sessionSpelling, target: GLM, seen: [], read: consent(), signedIn: sessionSignedInParties(R, harness, sessionSpelling, null), ...extra });
const pick = (v, keys) => Object.fromEntries(keys.map((k) => [k, v[k]]));
const ROUTE_KEYS = ['targetSpelling', 'targetServingHost', 'targetVia', 'hostDecision', 'hostReasonCode', 'seenHosts', 'tariffBasis', 'consent'];

test('R55: a gateway session keeps its gateway; the price is the gateway\'s own tariff, with its snapshot source', () => {
  const v = view('opencode', 'openrouter/moonshotai/kimi-k3', { seen: [GLM_OR] });
  assert.deepEqual(pick(v, ['spelling', 'provider', 'modelId', 'servingHost', 'via']), { spelling: 'openrouter/moonshotai/kimi-k3', provider: 'moonshot', modelId: 'kimi-k3', servingHost: 'openrouter', via: 'host' });
  assert.deepEqual(pick(v, ROUTE_KEYS), {
    targetSpelling: 'openrouter/z-ai/glm-5.3', targetServingHost: 'openrouter', targetVia: 'host', hostDecision: 'kept', hostReasonCode: null, seenHosts: ['openrouter'], tariffBasis: 'host',
    // The session runs through the gateway, so it is signed in there; the maker behind it is not.
    consent: { host: 'signed-in-default', maker: 'granted' },
  });
  assert.match(v.tariffSource.sourceId, /^[A-Za-z0-9-]+$/);
  assert.match(v.tariffSource.fetchedOn, /^\d{4}-\d{2}-\d{2}$/);
  // With no reader, the maker behind the gateway reads as needing consent.
  assert.equal(view('opencode', 'openrouter/moonshotai/kimi-k3', { seen: [GLM_OR], read: undefined }).consent.maker, 'required');
});

test('R55: a direct session shows a host change when the other host is granted, and why not when it is not', () => {
  const changed = view('opencode', 'moonshotai/kimi-k3', { seen: [GLM_OR], read: consent({ openrouter: 'granted' }) });
  assert.deepEqual([changed.servingHost, changed.via, changed.targetServingHost, changed.hostDecision, changed.consent], ['moonshot', 'maker', 'openrouter', 'changed', { host: 'granted', maker: 'granted' }]);
  // No grant for OpenRouter: not switched, for the reason route.turn gives; priced at the maker's own API.
  const noGrant = view('opencode', 'moonshotai/kimi-k3', { seen: [GLM_OR] });
  assert.deepEqual(pick(noGrant, ROUTE_KEYS), { targetSpelling: null, targetServingHost: null, targetVia: null, hostDecision: 'not-switched', hostReasonCode: 'HOST_CONSENT_REQUIRED', seenHosts: ['openrouter'], tariffBasis: 'host', consent: { host: null, maker: 'granted' } });
  assert.equal(noGrant.tariffSource, null, 'a maker\'s own price has no host snapshot');
  // Not seen anywhere: the host is not guessed.
  assert.deepEqual([view('opencode', 'moonshotai/kimi-k3').hostDecision, view('opencode', 'moonshotai/kimi-k3').hostReasonCode], ['not-switched', 'NOT_ON_SESSION_HOST']);
});

test('R55: consent states: a revoked gateway, a host a gateway forwards to, a host with no consent text, and the pair gate', () => {
  const revoked = view('opencode', 'openrouter/moonshotai/kimi-k3', { seen: [GLM_OR], read: consent({ openrouter: 'PROVIDER_CONSENT_REVOKED' }) });
  assert.deepEqual([revoked.hostDecision, revoked.hostReasonCode, revoked.consent.host], ['not-switched', 'HOST_CONSENT_REVOKED', 'revoked']);
  // Kilo's gateway forwards to OpenRouter: OpenRouter revoked blocks Kilo too.
  const kilo = view('kilocode', 'kilo/moonshotai/kimi-k3', { seen: [{ raw: 'kilo/z-ai/glm-5.3', servingHost: 'kilo' }], read: consent({ openrouter: 'PROVIDER_CONSENT_REVOKED' }) });
  assert.deepEqual([kilo.servingHost, kilo.hostDecision, kilo.hostReasonCode, kilo.consent.host], ['kilo', 'not-switched', 'HOST_CONSENT_REVOKED', 'blocked']);
  // NVIDIA has no consent text (owner: no text), and its GLM-5.3 price is a free tier: an estimate.
  const nvidia = servingView({ registry: R, harness: 'opencode', sessionSpelling: 'moonshotai/kimi-k3', targetSpelling: 'nvidia/z-ai/glm-5.3', read: consent({ nvidia: 'granted' }), signedIn: [] });
  assert.deepEqual([nvidia.targetServingHost, nvidia.tariffBasis, nvidia.tariffSource, nvidia.consent], ['nvidia', 'maker-price-estimate', null, { host: 'no-text', maker: 'granted' }]);
  // The maker behind the gateway not consented: the spelling is shown, and not switched for the pair.
  const pair = view('opencode', 'openrouter/moonshotai/kimi-k3', { seen: [GLM_OR], read: consent({ zai: 'PROVIDER_CONSENT_MISSING' }) });
  assert.deepEqual([pair.targetSpelling, pair.hostDecision, pair.consent.maker], ['openrouter/z-ai/glm-5.3', 'not-switched', 'required']);
  assert.match(pair.hostReasonCode, /^PROVIDER_CONSENT/);
  // B's LOW 35: the maker's state is the routing gate's. A maker with no consent text is never let
  // through by a sign-in (no signed-in default without text), but a stored grant is, as routing does.
  const noText = { ...R, entries: [...R.entries, { ...R.entries.find((e) => e.modelId === 'glm-5.3'), modelId: 'mystery-9', provider: 'mystery' }] };
  const makerOf = (read, signedIn) => servingView({ registry: noText, harness: 'opencode', sessionSpelling: 'moonshotai/kimi-k3', target: { provider: 'mystery', modelId: 'mystery-9' }, read, signedIn }).consent.maker;
  assert.equal(makerOf(consent({ mystery: 'PROVIDER_CONSENT_MISSING' }), ['mystery']), 'no-text', 'signed in, no text: routing still blocks it');
  assert.equal(makerOf(consent({ mystery: 'PROVIDER_CONSENT_MISSING' }), []), 'no-text');
  assert.equal(makerOf(consent({ mystery: 'granted' }), []), 'granted', 'a stored grant is what routing uses');
  // A signed-in default maker, and a marked one (Moonshot needs a grant even when signed in).
  const makerAt = (target, read, signedIn) => servingView({ registry: R, harness: 'opencode', sessionSpelling: 'moonshotai/kimi-k3', target, read, signedIn }).consent.maker;
  assert.equal(makerAt({ provider: 'zai', modelId: 'glm-5.3' }, consent({ zai: 'PROVIDER_CONSENT_MISSING' }), ['zai']), 'signed-in-default');
  assert.equal(makerAt({ provider: 'moonshot', modelId: 'kimi-k3' }, consent({ moonshot: 'PROVIDER_CONSENT_MISSING' }), ['moonshot']), 'required');
  assert.equal(makerAt({ provider: 'zai', modelId: 'glm-5.3' }, consent({ zai: 'PROVIDER_CONSENT_STALE' }), ['zai']), 'blocked');
  // A reader that throws or answers nonsense blocks; it never reads as granted.
  assert.equal(view('opencode', 'openrouter/moonshotai/kimi-k3', { seen: [GLM_OR], read: () => { throw new Error('x'); } }).consent.host, 'blocked');
  assert.equal(view('opencode', 'openrouter/moonshotai/kimi-k3', { seen: [GLM_OR], read: () => 'yes' }).consent.maker, 'blocked');
});

test('R55: a route priced only by estimate on its host says HOST_TARIFF_UNKNOWN; an unreadable session gives no view', () => {
  const registry = { ...R, servings: R.servings.map((s) => (s.host === 'openrouter' && s.modelId === 'glm-5.3' ? { ...s, tariff: null, tariffBasis: 'unknown' } : s)) };
  const est = view('opencode', 'openrouter/moonshotai/kimi-k3', { registry, seen: [GLM_OR] });
  assert.deepEqual([est.hostDecision, est.hostReasonCode, est.tariffBasis, est.tariffSource], ['kept', HOST_TARIFF_UNKNOWN, 'maker-price-estimate', null]);
  // No target: the session's own model and its host.
  const none = servingView({ registry: R, harness: 'opencode', sessionSpelling: 'openrouter/moonshotai/kimi-k3', signedIn: ['openrouter'] });
  assert.deepEqual(pick(none, ['targetSpelling', 'targetProvider', 'hostDecision', 'seenHosts', 'tariffBasis']), { targetSpelling: null, targetProvider: null, hostDecision: null, seenHosts: [], tariffBasis: 'host' });
  // F's shape checks: a Bedrock ARN, an unregistered or malformed spelling: no host lines at all.
  for (const sessionSpelling of ['bedrock-arn', 'unreadable-model', 'nobody/mystery-9', 'openrouter/z-ai/glm-5.3[1m]']) {
    assert.equal(servingView({ registry: R, harness: 'opencode', sessionSpelling, signedIn: [] }), null, sessionSpelling);
  }
  // A reason code that is not code-shaped is dropped, never shown as text.
  assert.equal(servingView({ registry: R, harness: 'opencode', sessionSpelling: 'moonshotai/kimi-k3', hostReasonCode: 'free text', signedIn: [] }).hostReasonCode, null);
});
