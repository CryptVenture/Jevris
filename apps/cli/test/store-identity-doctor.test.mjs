import test from 'node:test';
import assert from 'node:assert/strict';

// DATA-10: doctor names what the store's host scope is derived from, never the id itself.

const { storeIdentityLine } = await import('../dist/host-health.js');
const { doctorLineSeverity } = await import('../dist/doctor-severity.js');

test('doctor names what the store identity comes from (DATA-10)', () => {
  const stable = storeIdentityLine({ ok: true, machineId: 'secret-id', source: 'ioplatformuuid', user: 'uid:501' });
  assert.equal(stable, 'storeIdentity: machine id (stable across network name changes)');
  assert.equal(stable.includes('secret-id'), false, 'never the raw id');
  assert.equal(doctorLineSeverity(stable), 'ok');
  const fallback = storeIdentityLine({ ok: false, reason: 'machine-id-unreadable' });
  assert.match(fallback, /^storeIdentity: host name \(machine-id-unreadable\); .*`jevris store adopt`/);
  assert.equal(doctorLineSeverity(fallback), 'info');
});
