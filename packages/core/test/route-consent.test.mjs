// Serving hosts R45 (design 5.1; owner decisions c8e933d, OQ-2 and OQ-3; B's MEDIUM 19): consent per
// (host, maker) pair, with a gateway's downstream host blocking when it is revoked.
import test from 'node:test';
import assert from 'node:assert/strict';

const core = await import('../dist/index.js');
const { BUNDLED_MODEL_REGISTRY: R, hostConsent, blockedDownstream, routeConsentGate, HOST_CONSENT_REQUIRED, HOST_CONSENT_REVOKED } = core;

/** A reader from a table: party to state; anything absent is missing. */
const reader = (table) => (party) => {
  const state = table[party];
  if (state === undefined || state === 'missing') return { granted: false, reasonCode: 'PROVIDER_CONSENT_MISSING' };
  if (state === 'granted') return { granted: true };
  if (state === 'revoked') return { granted: false, reasonCode: 'PROVIDER_CONSENT_REVOKED' };
  if (state === 'stale') return { granted: false, reasonCode: 'PROVIDER_CONSENT_STALE' };
  if (state === 'throws') throw new Error('store closed');
  if (state === 'future') return { granted: false, reasonCode: 'PROVIDER_CONSENT_FUTURE' };
  return 'garbage';
};

test('R45: a host alone: revoke, stale and unreadable block; a grant or a signed-in session allows; NVIDIA never', () => {
  const at = (host, state, signedIn = []) => {
    const got = hostConsent(host, signedIn, reader({ [host]: state }));
    return got.allowed ? 'allow' : got.reasonCode;
  };
  for (const host of ['openrouter', 'kilo']) {
    assert.equal(at(host, 'granted'), 'allow');
    assert.equal(at(host, 'missing', [host]), 'allow', 'OQ-3: the signed-in default');
    assert.equal(at(host, 'missing'), HOST_CONSENT_REQUIRED);
    for (const state of ['revoked', 'stale', 'throws', 'garbage']) assert.equal(at(host, state, [host]), HOST_CONSENT_REVOKED, `${host} ${state}`);
  }
  // No text (OQ-2): never, whatever is stored or signed in.
  assert.equal(at('nvidia', 'granted', ['nvidia']), HOST_CONSENT_REQUIRED);
  assert.equal(at('nvidia', 'missing', ['nvidia']), HOST_CONSENT_REQUIRED);
  // Not a pinned host (a maker id, an unpinned host): never through this path.
  assert.equal(at('togetherai', 'granted', ['togetherai']), HOST_CONSENT_REQUIRED);
  assert.equal(at('moonshot', 'granted', ['moonshot']), HOST_CONSENT_REQUIRED);
});

test('R45: the pair truth table: host x maker, each granted, revoked, stale, missing or unreadable', () => {
  const states = ['granted', 'revoked', 'stale', 'missing', 'throws'];
  // GLM-5.3 (zai: signed-in default allowed) through OpenRouter, from a session signed in to OpenRouter only.
  for (const h of states) {
    for (const m of states) {
      const got = routeConsentGate(R, ['openrouter'], reader({ openrouter: h, zai: m }), { provider: 'zai', servingHost: 'openrouter', via: 'host' });
      const makerOk = m === 'granted';
      const hostOk = h === 'granted' || h === 'missing';
      assert.equal(got.allowed, makerOk && hostOk, `host ${h} maker ${m}: ${JSON.stringify(got)}`);
      if (!makerOk) assert.equal(got.party, 'zai', 'the maker is named first');
      else if (!hostOk) assert.deepEqual([got.party, got.reasonCode, got.downstream], ['openrouter', HOST_CONSENT_REVOKED, false]);
    }
  }
  // A gateway session does not sign in the maker: without a grant for zai the route is blocked.
  const unsigned = routeConsentGate(R, ['openrouter'], reader({}), { provider: 'zai', servingHost: 'openrouter', via: 'host' });
  assert.deepEqual([unsigned.allowed, unsigned.party, unsigned.reasonCode], [false, 'zai', 'PROVIDER_CONSENT_REQUIRED']);
  // Signed in to both: allowed with no grants at all (OD-4 and OQ-3).
  assert.equal(routeConsentGate(R, ['openrouter', 'zai'], reader({}), { provider: 'zai', servingHost: 'openrouter', via: 'host' }).allowed, true);
});

test('R45: Moonshot through OpenRouter needs both; Moonshot stays always-required whichever host serves it', () => {
  const kimi = { provider: 'moonshot', servingHost: 'openrouter', via: 'host' };
  assert.equal(routeConsentGate(R, ['openrouter', 'moonshot'], reader({}), kimi).allowed, false, 'signed in is not enough for Moonshot');
  assert.equal(routeConsentGate(R, ['openrouter'], reader({ moonshot: 'granted' }), kimi).allowed, true);
  assert.equal(routeConsentGate(R, [], reader({ moonshot: 'granted' }), kimi).allowed, false, 'the host needs its own standing');
  assert.equal(routeConsentGate(R, [], reader({ moonshot: 'granted', openrouter: 'granted' }), kimi).allowed, true);
  // Through NVIDIA: never.
  const nv = routeConsentGate(R, ['nvidia'], reader({ moonshot: 'granted', nvidia: 'granted' }), { ...kimi, servingHost: 'nvidia' });
  assert.deepEqual([nv.allowed, nv.party, nv.reasonCode], [false, 'nvidia', HOST_CONSENT_REQUIRED]);
});

test("R45 (B's MEDIUM 19): a Kilo Gateway route is blocked when OpenRouter, which it forwards to, is revoked, stale or unreadable", () => {
  const glm = { provider: 'zai', servingHost: 'kilo', via: 'host' };
  const signed = ['kilo', 'zai'];
  assert.equal(routeConsentGate(R, signed, reader({}), glm).allowed, true, 'OpenRouter unset: no grant is needed for it');
  for (const state of ['revoked', 'stale', 'throws', 'garbage']) {
    const got = routeConsentGate(R, signed, reader({ openrouter: state }), glm);
    assert.deepEqual([got.allowed, got.party, got.reasonCode, got.downstream], [false, 'openrouter', HOST_CONSENT_REVOKED, true], state);
  }
  assert.equal(routeConsentGate(R, signed, reader({ openrouter: 'granted' }), glm).allowed, true);
  assert.equal(blockedDownstream('kilo', reader({ openrouter: 'revoked' })), 'openrouter');
  assert.equal(blockedDownstream('openrouter', reader({ kilo: 'revoked' })), null, 'forwarding is one-way');
});

test('R45: a direct route needs only the maker, as before', () => {
  assert.equal(routeConsentGate(R, ['zai'], reader({ openrouter: 'revoked' }), { provider: 'zai', servingHost: 'zai', via: 'maker' }).allowed, true);
  assert.equal(routeConsentGate(R, [], reader({}), { provider: 'zai', servingHost: 'zai', via: 'maker' }).allowed, false);
  assert.equal(routeConsentGate(R, ['anthropic'], reader({}), { provider: 'anthropic', servingHost: 'anthropic', via: 'maker' }).allowed, true);
  // A "direct" route whose host is not its maker is not direct.
  const odd = routeConsentGate(R, ['zai', 'openrouter'], reader({}), { provider: 'zai', servingHost: 'openrouter', via: 'maker' });
  assert.deepEqual([odd.allowed, odd.reasonCode], [false, HOST_CONSENT_REQUIRED]);
});

test("R45 (B's LOW 21): a reason code the gate does not know blocks, in the maker path, the host path and downstream", () => {
  const future = reader({ zai: 'future', openrouter: 'future' });
  const maker = core.providerConsentGate(R, ['zai'], future);
  assert.deepEqual(maker.blocked.find((b) => b.provider === 'zai'), { provider: 'zai', reasonCode: 'PROVIDER_CONSENT_UNREADABLE' });
  assert.equal(maker.consentedProviders.includes('zai'), false);
  assert.deepEqual(hostConsent('openrouter', ['openrouter'], future), { allowed: false, reasonCode: HOST_CONSENT_REVOKED });
  assert.equal(blockedDownstream('kilo', reader({ openrouter: 'future' })), 'openrouter');
  // "No row" is still not a block.
  assert.equal(core.providerConsentGate(R, ['zai'], reader({})).consentedProviders.includes('zai'), true);
});
