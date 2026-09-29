// Host consent texts (serving-hosts design 5.3, R40; owner decision c8e933d, OQ-2 and OQ-3): the
// pinned gateways have texts with the signed-in default that say plainly the downstream provider
// may train on what you send by default; NVIDIA has none; the maps are disjoint; every text is dated.
import test from 'node:test';
import assert from 'node:assert/strict';

const c = await import('../dist/index.js');
const DATE = /\b20\d\d-\d\d-\d\d\b/;

test('OpenRouter and the Kilo Gateway have texts with the signed-in default; NVIDIA has none', () => {
  assert.deepEqual(Object.keys(c.SERVING_HOST_CONSENT_TEXT).sort(), ['kilo', 'openrouter']);
  for (const id of Object.keys(c.SERVING_HOST_CONSENT_TEXT)) assert.ok(c.SERVING_HOST_IDS.includes(id), `${id} is a pinned host`);
  assert.equal(c.consentText('nvidia'), undefined, 'NVIDIA cannot be granted, so it is never routed to');
  for (const [id, text] of Object.entries(c.SERVING_HOST_CONSENT_TEXT)) {
    assert.equal(text.alwaysRequired, false, id);
    assert.equal(text.version, `${id}-2026-09-28`);
    assert.ok(Object.isFrozen(text), id);
    assert.ok(typeof text.name === 'string' && text.name.length > 0, `${id}.name`);
    for (const field of ['training', 'storage', 'forwarding', 'source']) assert.ok(typeof text[field] === 'string' && text[field].length > 40, `${id}.${field}`);
  }
  assert.ok(Object.isFrozen(c.SERVING_HOST_CONSENT_TEXT));
});

test('each gateway text says the downstream provider may train by default, and names its terms', () => {
  const or = c.SERVING_HOST_CONSENT_TEXT.openrouter;
  assert.match(or.training, /may train on what you send/);
  assert.match(or.training, /data_collection "allow"/);
  assert.match(or.storage, /minimum of 3 months/);
  assert.match(or.forwarding, /18 endpoints/);
  const kilo = c.SERVING_HOST_CONSENT_TEXT.kilo;
  assert.match(kilo.training, /may train on what you send by default/);
  assert.match(kilo.training, /perpetual, irrevocable/);
  assert.match(kilo.training, /source code/);
  assert.match(kilo.forwarding, /through OpenRouter/);
  assert.match(kilo.forwarding, /never routes to Auto Free/);
});

test('every maker and host text has a dated source, and the maps are disjoint', () => {
  for (const [id, text] of [...Object.entries(c.PROVIDER_CONSENT_TEXT), ...Object.entries(c.SERVING_HOST_CONSENT_TEXT)]) {
    assert.match(text.source, DATE, id);
    assert.match(text.source, /https:\/\//, id);
  }
  for (const id of Object.keys(c.SERVING_HOST_CONSENT_TEXT)) assert.ok(!Object.hasOwn(c.PROVIDER_CONSENT_TEXT, id), id);
  assert.equal(c.consentText('openrouter'), c.SERVING_HOST_CONSENT_TEXT.openrouter);
  assert.equal(c.consentText('moonshot'), c.PROVIDER_CONSENT_TEXT.moonshot);
  assert.equal(c.consentText('vercel'), undefined);
  assert.equal(c.consentText('__proto__'), undefined);
  assert.equal(c.providerConsentPhrase('openrouter'), 'consent to openrouter');
});

test('the Moonshot and Google texts name the China endpoint and Vertex AI, as new versions', () => {
  const moonshot = c.PROVIDER_CONSENT_TEXT.moonshot;
  assert.equal(moonshot.version, 'moonshot-2026-09-28');
  assert.match(moonshot.storage, /Singapore/);
  assert.match(moonshot.storage, /mainland China/);
  assert.match(moonshot.training, /moonshotai-cn/);
  assert.equal(moonshot.alwaysRequired, true);
  const google = c.PROVIDER_CONSENT_TEXT.google;
  assert.equal(google.version, 'google-2026-09-28');
  assert.match(google.training, /Vertex AI \(google-vertex\)/);
  assert.match(google.storage, /24-hour TTL/);
});
