import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from './temp-dirs.mjs';


const { openStore, closeStore, billingReport } = await import('../dist/index.js');

function tempDir() {
  return makeTempDir('jevris-store-labels-');
}

test('billing labels stay separate and savingMicroUsd stays null', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'labels.sqlite');
  try {
    const opened = openStore({
      path: dbPath,
      role: 'in-process-test',
      workspaceId: 'wsA',
      hostScope: 'host-a',
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    const report = billingReport(opened);
    assert.equal(report.nonOwnedBilling, 'unknown');
    assert.equal(report.savingMicroUsd, null);
    assert.notEqual(report.savingMicroUsd, 0n);
    assert.equal(report.applied, false);
    assert.equal(report.subscriptionActual, 'unknown');
    assert.equal(report.apiEquivalentEstimate, 'unmeasured');
    assert.equal(report.counterfactualHypothetical, 'hypothetical');

    const subscription = billingReport(opened, { subscriptionActual: 4n });
    assert.equal(subscription.subscriptionActual, 4n);
    assert.equal(typeof subscription.subscriptionActual, 'bigint');
    assert.equal(subscription.apiEquivalentEstimate, 'unmeasured');
    assert.equal(subscription.counterfactualHypothetical, 'hypothetical');
    assert.equal(subscription.savingMicroUsd, null);
    assert.notEqual(subscription.savingMicroUsd, 0n);
    assert.notEqual(subscription.savingMicroUsd, 4n);
    assert.notEqual(subscription.apiEquivalentEstimate, 4n);
    assert.notEqual(subscription.counterfactualHypothetical, 4n);
    assert.equal(subscription.applied, false);
    assert.equal(subscription.nonOwnedBilling, 'unknown');

    const estimate = billingReport(opened, { apiEquivalentEstimate: 9n });
    assert.equal(estimate.apiEquivalentEstimate, 9n);
    assert.equal(estimate.subscriptionActual, 'unknown');
    assert.equal(estimate.counterfactualHypothetical, 'hypothetical');
    assert.equal(estimate.savingMicroUsd, null);
    assert.notEqual(estimate.subscriptionActual, 9n);

    const counterfactual = billingReport(opened, { counterfactualHypothetical: 3n });
    assert.equal(counterfactual.counterfactualHypothetical, 3n);
    assert.equal(counterfactual.subscriptionActual, 'unknown');
    assert.equal(counterfactual.apiEquivalentEstimate, 'unmeasured');
    assert.equal(counterfactual.savingMicroUsd, null);
    assert.notEqual(counterfactual.savingMicroUsd, 3n);
    assert.notEqual(counterfactual.subscriptionActual, 3n);
    assert.notEqual(counterfactual.apiEquivalentEstimate, 3n);
    closeStore(opened);
  } finally {
    removeTempDir(dir);
  }
});
