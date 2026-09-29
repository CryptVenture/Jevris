import test from 'node:test';
import assert from 'node:assert/strict';

// W07: status says decisions are degraded while Jev is down (outage, overload, open circuit,
// refused egress), and one successful decision clears it.

const { providerDownReason } = await import('../dist/state.js');

const at = (ms) => new Date(ms).toISOString();
const NOW = Date.parse('2026-09-25T12:00:00Z');

test('the latest decision falling back because of the provider marks decisions degraded (W07, PRV-08)', () => {
  for (const reasonCode of ['CIRCUIT_OPEN', 'PROVIDER_ERROR', 'PROVIDER_DISABLED', 'DEADLINE', 'EGRESS_NOT_APPROVED']) {
    const reason = providerDownReason([{ decisionId: 'd1', outcome: 'abstained', reasonCode, at: at(NOW - 60_000) }], NOW);
    assert.match(reason ?? '', new RegExp(`Jev is unavailable \\(${reasonCode}\\); decisions run rules-only`), reasonCode);
  }
});

test('a successful latest decision, an unrelated refusal, an old failure or no decision is not degraded (W07)', () => {
  assert.equal(providerDownReason([{ reasonCode: 'APPLIED', outcome: 'planned', at: at(NOW) }, { reasonCode: 'CIRCUIT_OPEN', at: at(NOW - 1000) }], NOW), null);
  assert.equal(providerDownReason([{ reasonCode: 'BUDGET', outcome: 'abstained', at: at(NOW) }], NOW), null);
  assert.equal(providerDownReason([{ reasonCode: 'CIRCUIT_OPEN', outcome: 'abstained', at: at(NOW - 16 * 60_000) }], NOW), null);
  assert.equal(providerDownReason([], NOW), null);
  assert.equal(providerDownReason([{ reasonCode: 'CIRCUIT_OPEN', at: 'not a time' }], NOW), null);
});
