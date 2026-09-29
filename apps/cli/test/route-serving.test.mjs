// Serving hosts R55 (design 8): route and explain carry an optional `serving` view (C fills it from
// R50's spellTarget) and render the model with its serving host, the host decision, each party's
// consent and what the price rests on; the data line goes through resolveSpelling, so a gateway
// spelling shows the host's line beside the maker's. Contract and render only: no sidecar.
import test from 'node:test';
import assert from 'node:assert/strict';

const { renderHuman, servingLines } = await import('../dist/public/render.js');
const { resultDataTermsLine, hostDataTermsLine, modelDataTermsLine } = await import('../dist/data-terms.js');
const { surfacePayloadContract, defineContract, RouteServingSchema, consentText } = await import('../../../packages/contracts/dist/index.js');
const { BUNDLED_MODEL_REGISTRY } = await import('../../../packages/core/dist/index.js');

const Serving = defineContract({ name: 'RouteServingTest', description: 'test', schema: RouteServingSchema });

const gateway = {
  spelling: 'openrouter/moonshotai/kimi-k3',
  provider: 'moonshot',
  modelId: 'kimi-k3',
  servingHost: 'openrouter',
  via: 'host',
  targetSpelling: null,
  targetProvider: null,
  targetModelId: null,
  targetServingHost: null,
  targetVia: null,
  hostDecision: 'kept',
  hostReasonCode: null,
  seenHosts: ['openrouter'],
  tariffBasis: 'host',
  tariffSource: { sourceId: 'MODELSDEV-2075e967', fetchedOn: '2026-09-28' },
  consent: { host: 'granted', maker: 'granted' },
};

const envelope = (command, result) => ({ command, summary: command, mode: 'full', workspace: { root: null }, sidecar: { state: 'running', reasonCode: null, message: null }, result });
const routeResult = (serving) => ({
  main: { currentModel: 'kimi-k3', modelPin: null, pinState: 'unpinned', outcome: 'keep', recommendedModel: null, reasonCode: 'KEEP_CURRENT', costBasis: 'api-list-price', text: 'x', adviceKey: null, harness: 'kilocode', authMode: 'api-key', serving },
  worker: { outcome: 'abstain', recommendedModel: null, reasonCode: 'NO_CALIBRATION', text: 'y' },
  applied: false,
});

test('the serving view: optional and nullable on route and explain, host spellings allowed, nothing beyond the view', () => {
  assert.equal(Serving.validate(gateway).ok, true);
  assert.equal(surfacePayloadContract('route').validate(routeResult(gateway)).ok, true);
  assert.equal(surfacePayloadContract('route').validate(routeResult(null)).ok, true);
  const direct = { ...gateway, spelling: 'claude-opus-5-5[1m]', provider: 'anthropic', modelId: 'claude-opus-5-5', servingHost: 'anthropic', via: 'maker', seenHosts: [], tariffSource: null, consent: { host: null, maker: 'signed-in-default' } };
  assert.equal(Serving.validate(direct).ok, true);
  for (const bad of [
    { ...gateway, servingHost: 'acme' },
    { ...gateway, via: 'proxy' },
    { ...gateway, consent: { host: 'granted', maker: 'granted', hostTextVersion: 'x' } },
    { ...gateway, consent: { host: 'maybe', maker: 'granted' } },
    { ...gateway, tariffBasis: 'unknown' },
    { ...gateway, tariffSource: { sourceId: 'S', fetchedOn: 'yesterday' } },
    { ...gateway, seenHosts: ['openrouter', 'openrouter'] },
    { ...gateway, spelling: 'https://example.com/model' },
    { ...gateway, url: 'x' },
  ]) assert.equal(Serving.validate(bad).ok, false, JSON.stringify(bad).slice(0, 160));
});

test('the lines: the host a model goes through, the host decision, consent per party and the price basis', () => {
  assert.deepEqual(servingLines(gateway), [
    'model: openrouter/moonshotai/kimi-k3 = kimi-k3 (moonshot), served by openrouter (gateway)',
    'host: kept (openrouter)',
    'consent: host openrouter granted; maker moonshot granted (jevris consent provider says why)',
    'host price: openrouter tariff (MODELSDEV-2075e967, 2026-09-28)',
  ]);
  const changed = { ...gateway, spelling: 'kilo/z-ai/glm-5.3', provider: 'zai', modelId: 'glm-5.3', servingHost: 'kilo', targetSpelling: 'zai/glm-5.3', targetProvider: 'zai', targetModelId: 'glm-5.3', targetServingHost: 'zai', targetVia: 'maker', hostDecision: 'changed', seenHosts: ['zai'], tariffSource: null, consent: { host: null, maker: 'signed-in-default' } };
  assert.deepEqual(servingLines(changed), [
    'model: kilo/z-ai/glm-5.3 = glm-5.3 (zai), served by kilo (gateway)',
    'target: zai/glm-5.3 = glm-5.3 (zai), direct from zai',
    'host: changed to zai (the only host seen for it here: zai)',
    'consent: maker zai signed in default (jevris consent provider says why)',
    "host price: zai's list price",
  ]);
  const refused = { ...gateway, targetSpelling: 'openrouter/z-ai/glm-5.3', targetProvider: 'zai', targetModelId: 'glm-5.3', targetServingHost: 'openrouter', targetVia: 'host', hostDecision: 'not-switched', hostReasonCode: 'NOT_ON_SESSION_HOST', seenHosts: ['kilo', 'zai'], tariffBasis: 'maker-price-estimate', tariffSource: null, consent: { host: 'signed-in-default', maker: 'required' } };
  const lines = servingLines(refused);
  assert.match(lines[2], /^host: not switched: NOT_ON_SESSION_HOST \(.+\) \(seen through kilo, zai\)$/);
  assert.equal(lines[3], 'consent: host openrouter signed in default; maker zai required (jevris consent provider says why)');
  assert.equal(lines[4], "host price: estimate: zai's list price (openrouter tariff unknown)");

  const route = renderHuman(envelope('route', routeResult(gateway)));
  assert.match(route, /^model: openrouter\/moonshotai\/kimi-k3 = kimi-k3 \(moonshot\), served by openrouter \(gateway\)$/m);
  assert.doesNotMatch(renderHuman(envelope('route', routeResult(null))), /^host:/m, 'no view, no lines');
});

test('the data line goes through resolveSpelling: a gateway spelling shows the host\'s line and the maker\'s', () => {
  const registry = BUNDLED_MODEL_REGISTRY;
  const hostLine = hostDataTermsLine(registry, 'openrouter/moonshotai/kimi-k3', 'kilocode');
  assert.equal(hostLine, `data terms (openrouter, the serving host): ${consentText('openrouter').training}`);
  assert.equal(hostDataTermsLine(registry, 'moonshotai/kimi-k3', 'kilocode'), null, "a maker's own API has no host line");
  assert.equal(hostDataTermsLine(registry, 'openrouter/moonshotai/kimi-k3', null), null, 'no harness, no resolver');
  const maker = modelDataTermsLine(registry, 'openrouter/moonshotai/kimi-k3', 'api-key', 'kilocode');
  if (maker !== null) assert.match(maker, /^data terms \(moonshot, served by openrouter\): /);
  // Without the harness the gateway spelling stays unregistered: no maker's terms are guessed.
  assert.equal(modelDataTermsLine(registry, 'openrouter/moonshotai/kimi-k3', 'api-key'), null);
  const both = resultDataTermsLine(envelope('route', routeResult(gateway)), registry);
  assert.ok(both.startsWith(hostLine), both);
});
