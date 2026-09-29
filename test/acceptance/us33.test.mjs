import assert from 'node:assert/strict';
import { join } from 'node:path';
import { load, story } from './lib.mjs';

// US33: Claude usage runs on a subscription (a fixed plan), not per-request API charges. The cost
// report is built the way the product builds it: the store's billingReport, then evals
// buildCostReport. The API-equivalent figure is what the observed usage would cost at the
// registry's API list prices. Nothing reports a per-request bill on a subscription, so the
// actual stays unknown; the counterfactual stays a hypothesis; no saving is claimed.

story('US33', async ({ then, sandbox, evidence }) => {
  const core = await load('core');
  const evals = await load('evals');
  const store = await load('store');
  const box = await sandbox();
  const opened = store.openStore({ path: join(box.dir, 'us33.sqlite'), role: 'in-process-test', workspaceId: 'ws-us33', hostScope: 'host-us33' });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  // A week of subscription work: what the harness reported for the sessions.
  const usage = { inputTokens: 3_200_000, outputTokens: 240_000, cacheReadTokens: 1_800_000, cacheWriteTokens: 0 };
  const sonnet = core.registryModel(core.BUNDLED_MODEL_REGISTRY, 'claude-sonnet-5');
  const apiEquivalent = BigInt(core.generationCostMicroUsd(sonnet.tariff, usage));
  const billing = store.billingReport(opened, { apiEquivalentEstimate: apiEquivalent });
  store.closeStore(opened);
  const report = evals.buildCostReport(billing, { billingMode: 'subscription' });
  evidence({ billing: { ...billing, apiEquivalentEstimate: String(billing.apiEquivalentEstimate) }, report });

  await then('Actual billing/credits, API-equivalent estimates and hypothetical counterfactual savings are separate labelled measures', () => {
    assert.deepEqual(Object.keys(report).filter((k) => ['actual', 'apiEquivalent', 'counterfactual'].includes(k)), ['actual', 'apiEquivalent', 'counterfactual']);
    assert.deepEqual([report.actual.label, report.actual.value, report.actual.precision], ['subscription credits used', 'unknown', 'unknown']);
    assert.deepEqual([report.apiEquivalent.label, report.apiEquivalent.value, report.apiEquivalent.precision], ['API list-price equivalent', Number(apiEquivalent), 'estimate']);
    assert.ok(report.apiEquivalent.value > 0);
    assert.deepEqual([report.counterfactual.label, report.counterfactual.value, report.counterfactual.precision], ['counterfactual (not observed)', 'hypothetical', 'hypothetical']);
    assert.equal(report.savingMicroUsd, null);
    assert.equal(billing.savingMicroUsd, null);
    assert.ok(report.notes.some((n) => /not money removed from the fixed plan/.test(n)));
    assert.equal(/\bsaved\b/i.test(JSON.stringify(report)), false);
  });
});
