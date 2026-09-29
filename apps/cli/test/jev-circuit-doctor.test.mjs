// Decision ea2af91a (status and doctor both show a disabled Jev), with B's ruling on how doctor
// reads it: from a running sidecar's status only, never the circuit file, and never starting the
// sidecar. One action line while Jev is disabled, in status's words; none otherwise, and none for
// a field that does not fit the status contract. A temp home only: no sidecar runs here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.JEVRIS_SIDECAR_AUTOSTART = '0';

const { jevCircuitDoctorLines, jevCircuitDoctorLinesFrom } = await import('../dist/jev-circuit-doctor.js');
const { doctorLineSeverity } = await import('../dist/doctor-severity.js');

const billing = { state: 'disabled', reasonCode: 'PROVIDER_BILLING', reasonClass: 'BILLING', since: '2026-09-28T04:10:00.000Z', command: 'jevris credential reenable' };
const account = { state: 'disabled', reasonCode: 'PROVIDER_DISABLED', reasonClass: 'ACCOUNT', since: null, command: 'jevris credential reenable' };
const auth = { state: 'disabled', reasonCode: 'PROVIDER_DISABLED', reasonClass: 'AUTH', since: '2026-09-28T04:10:00.000Z', command: 'jevris credential set' };

test('a disabled Jev in the running sidecar status is one action line naming the command that clears it', () => {
  const [b] = jevCircuitDoctorLinesFrom({ jevCircuit: billing });
  assert.equal(b, 'jev: disabled for billing (PROVIDER_BILLING) since 2026-09-28T04:10Z; Jevris decides rules-only; after fixing billing, run jevris credential reenable');
  assert.equal(doctorLineSeverity(b), 'action');
  const [a] = jevCircuitDoctorLinesFrom({ jevCircuit: account });
  assert.equal(a, 'jev: disabled for the account (PROVIDER_DISABLED); Jevris decides rules-only; after fixing the account, run jevris credential reenable');
  assert.equal(doctorLineSeverity(a), 'action');
  const [k] = jevCircuitDoctorLinesFrom({ jevCircuit: auth });
  assert.match(k, /^jev: disabled for its API key \(PROVIDER_DISABLED\) since 2026-09-28T04:10Z; [^\n]*a 401 clears only with a new key: jevris credential set$/);
  assert.equal(doctorLineSeverity(k), 'action');
});

test('no line when Jev is not disabled, no sidecar answers, or the field does not fit the contract', () => {
  for (const status of [null, undefined, 'text', {}, { jevCircuit: null }]) assert.deepEqual(jevCircuitDoctorLinesFrom(status), [], JSON.stringify(status));
  for (const field of [
    { ...billing, reasonCode: 'PROVIDER_DISABLED' },
    { ...auth, command: 'jevris credential reenable' },
    { ...billing, fingerprint: 'abc' },
    { ...billing, reasonClass: 'OTHER' },
    { ...billing, since: 'yesterday' },
  ]) {
    assert.deepEqual(jevCircuitDoctorLinesFrom({ jevCircuit: field }), [], JSON.stringify(field));
  }
});

test('doctor asks only a sidecar that is already running: none runs in a temp home, so no line', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'jevris-jev-doctor-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(await jevCircuitDoctorLines(dir), []);
  assert.deepEqual(await jevCircuitDoctorLines(dir, async () => ({ jevCircuit: billing })), [jevCircuitDoctorLinesFrom({ jevCircuit: billing })[0]]);
  assert.deepEqual(
    await jevCircuitDoctorLines(dir, async () => {
      throw new Error('remote text that is never shown');
    }),
    [],
  );
});
