import assert from 'node:assert/strict';
import { load, story } from './lib.mjs';
import { ASSUMPTIONS, SLICE, VOLUME, policy, quality, registry } from './router-fixture.mjs';

// US11: the workspace's data scope does not allow the cheaper model (managed allowlist) and
// restricts region and provider. The router removes the model in its hard filters before any
// cost or quality is computed, and an outage fallback never widens region or provider. (Fable
// is relabelled to another provider that is allowed by default, so only the fallback rule refuses it.)

story('US11', async ({ then, evidence }) => {
  const core = await load('core');
  const reg = await registry({ 'claude-haiku-4-5-20251001': { regions: ['global', 'us'] }, 'claude-fable-5-1': { provider: 'openai' } });
  const scope = policy({ managedAllowlist: ['claude-opus-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001'], allowedRegions: ['global', 'us'] });
  const qualities = [quality('claude-opus-5', 0.9, 0.94, 0.97), quality('claude-sonnet-5', 0.88, 0.93, 0.96), quality('claude-haiku-4-5-20251001', 0.85, 0.9, 0.94), quality('claude-fable-5-1', 0.9, 0.95, 0.98)];
  const selection = core.routeTask({ registry: reg, policy: scope, sliceId: SLICE, volume: VOLUME, assumptions: ASSUMPTIONS, qualityFloor: 0.8, qualities });
  const filtered = core.filterCandidates(reg, scope);

  // Opus has an outage; the approved fallback list is the only source of alternatives.
  const outage = await registry({ 'claude-opus-5': { health: 'unavailable' }, 'claude-haiku-4-5-20251001': { regions: ['global', 'us'] }, 'claude-fable-5-1': { provider: 'openai' } });
  const ledger = new core.FallbackLedger();
  const base = { currentModelId: 'claude-opus-5', registry: outage, policy: policy({ allowedRegions: ['global'] }), ledger };
  const widerRegion = core.outageFallback({ ...base, approved: [{ fromModelId: 'claude-opus-5', toModelId: 'claude-haiku-4-5-20251001' }] });
  const otherProvider = core.outageFallback({ ...base, approved: [{ fromModelId: 'claude-opus-5', toModelId: 'claude-fable-5-1' }] });
  const unapproved = core.outageFallback({ ...base, approved: [], requestedModelId: 'claude-sonnet-5' });
  const approved = core.outageFallback({ ...base, approved: [{ fromModelId: 'claude-opus-5', toModelId: 'claude-sonnet-5' }] });
  evidence({ eliminated: selection.eliminated, widerRegion, otherProvider, unapproved, approved });

  await then('The model is removed before scoring', () => {
    assert.deepEqual(filtered.eliminated.find((e) => e.modelId === 'claude-sonnet-5'), { modelId: 'claude-sonnet-5', gate: 'managed-allowlist' });
    assert.equal(selection.scored.some((c) => c.modelId === 'claude-sonnet-5'), false, 'the disallowed model was scored');
    assert.equal(selection.shadow.includes('claude-sonnet-5'), false, 'the disallowed model is not even shadowed');
    assert.notEqual(selection.modelId, 'claude-sonnet-5');
  });

  await then('no fallback broadens region or provider authority', () => {
    assert.deepEqual(widerRegion, { modelId: null, reasonCode: 'FALLBACK_BROADENS_REGION' });
    assert.deepEqual(otherProvider, { modelId: null, reasonCode: 'FALLBACK_BROADENS_PROVIDER' });
    assert.equal(unapproved.modelId, null);
    assert.deepEqual(approved, { modelId: 'claude-sonnet-5', reasonCode: 'FALLBACK_APPROVED' });
    assert.equal(ledger.unauthorizedFallbacks, 0);
  });
});
