// A.R77 (decision ea2af91a): status carries Jev disabled for billing, the account or its key
// (B fills it from C2's circuit snapshot) as `jevCircuit`, with a fixed reason code, since when
// and the one command that clears it; the pairs are fixed by the contract. Contract and render only.
import test from 'node:test';
import assert from 'node:assert/strict';

const { jevCircuitLine } = await import('../dist/public/render.js');
const { JevCircuitStatusSchema, StatusPayloadSchema, defineContract, jsonSchemaOf } = await import('../../../packages/contracts/dist/index.js');

const View = defineContract({ name: 'JevCircuitTest', description: 'test', schema: JevCircuitStatusSchema });
const billing = { state: 'disabled', reasonCode: 'PROVIDER_BILLING', reasonClass: 'BILLING', since: '2026-09-28T04:10:00.000Z', command: 'jevris credential reenable' };
const account = { ...billing, reasonCode: 'PROVIDER_DISABLED', reasonClass: 'ACCOUNT' };
const auth = { ...billing, reasonCode: 'PROVIDER_DISABLED', reasonClass: 'AUTH', command: 'jevris credential set' };

test('jevCircuit is an optional status field; only the fixed pairs validate, and nothing beyond the view', () => {
  const status = jsonSchemaOf(StatusPayloadSchema);
  assert.ok('jevCircuit' in status.properties);
  assert.equal(status.required.includes('jevCircuit'), false);
  for (const v of [billing, account, auth, { ...billing, since: null }]) assert.equal(View.validate(v).ok, true, JSON.stringify(v));
  for (const v of [
    { ...billing, reasonCode: 'PROVIDER_DISABLED' },
    { ...account, reasonCode: 'PROVIDER_BILLING' },
    { ...auth, command: 'jevris credential reenable' },
    { ...billing, command: 'jevris credential set' },
    { ...billing, state: 'open' },
    { ...billing, fingerprint: 'abcdef0123456789' },
    { ...billing, command: 'rm -rf /' },
  ]) assert.equal(View.validate(v).ok, false, JSON.stringify(v));
});

test('the status line: why, since when and the one command', () => {
  assert.equal(jevCircuitLine(billing), 'jev: disabled for billing (PROVIDER_BILLING) since 2026-09-28T04:10Z; Jevris decides rules-only; after fixing billing, run jevris credential reenable');
  assert.equal(jevCircuitLine({ ...account, since: null }), 'jev: disabled for the account (PROVIDER_DISABLED); Jevris decides rules-only; after fixing the account, run jevris credential reenable');
  assert.equal(jevCircuitLine(auth), 'jev: disabled for its API key (PROVIDER_DISABLED) since 2026-09-28T04:10Z; Jevris decides rules-only; a 401 clears only with a new key: jevris credential set');
});
