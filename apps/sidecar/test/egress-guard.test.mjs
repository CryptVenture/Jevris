import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// GOV-01, GOV-08, US02, US26: the provider transport boundary. Only host policy approves
// source egress; without approval no free-text evidence leaves, and approved text is still
// secret-screened. Nothing is sent for a refused request.

const egressGuard = await import('../dist/egress-guard.js');
const { guardEgressFetch, resolveSourceEgress } = egressGuard;
const { jevrisPaths } = await import('@jevris/platform');

const HOST = {
  schemaVersion: '1.0',
  mode: 'advise',
  egress: 'deny-until-approved',
  retention: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 },
  budget: { maxRequestBytes: 65536 },
  pin: { model: 'jev-1.13.0', respectHumanPins: true },
  packPrivileges: [],
  credentialRef: 'host-secret:typesafe-primary',
  installerEnvName: 'JEVRIS_INSTALLER_KEY',
  allowUncalibratedActuation: false,
};

function withHome(fn) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'jveg-')));
  const config = jevrisPaths({ home }).config;
  mkdirSync(config, { recursive: true });
  try {
    return fn({ home, put: (name, value) => writeFileSync(join(config, name), typeof value === 'string' ? value : JSON.stringify(value)) });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('source egress is approved only by a valid host.json that approves and an organization.json that does not forbid (GOV-01)', () => {
  withHome(({ home, put }) => {
    assert.equal(resolveSourceEgress({ home }), 'not-approved', 'no host policy');
    put('host.json', HOST);
    assert.equal(resolveSourceEgress({ home }), 'not-approved');
    put('host.json', { ...HOST, egress: 'approved-scoped' });
    assert.equal(resolveSourceEgress({ home }), 'approved');
    put('organization.json', HOST);
    assert.equal(resolveSourceEgress({ home }), 'not-approved', 'the organization forbids');
    put('organization.json', { ...HOST, egress: 'approved-scoped' });
    assert.equal(resolveSourceEgress({ home }), 'approved');
    put('organization.json', '{not json');
    assert.equal(resolveSourceEgress({ home }), 'not-approved', 'a broken organization file is not approval');
    put('organization.json', { ...HOST, egress: 'approved-scoped' });
    put('host.json', { ...HOST, egress: 'approved-scoped', extra: true });
    assert.equal(resolveSourceEgress({ home }), 'not-approved', 'an invalid host file is not approval');
  });
});

test('SR-4: an approval counts only from a regular owner-only file, with neither it nor the Jevris home inside a git work tree', () => {
  const { sourceEgressDetail } = egressGuard;
  withHome(({ home, put }) => {
    const config = jevrisPaths({ home }).config;
    put('host.json', { ...HOST, egress: 'approved-scoped' });
    assert.deepEqual(sourceEgressDetail({ home }), { approval: 'approved', reasonCode: null });
    // A repository around the Jevris home could have supplied the approval.
    mkdirSync(join(home, '.git'));
    assert.deepEqual(sourceEgressDetail({ home }), { approval: 'not-approved', reasonCode: 'JEVRIS_HOME_IN_WORK_TREE' });
    assert.equal(resolveSourceEgress({ home }), 'not-approved');
    rmSync(join(home, '.git'), { recursive: true });
    assert.equal(resolveSourceEgress({ home }), 'approved');
    if (process.platform !== 'win32') {
      chmodSync(join(config, 'host.json'), 0o664);
      assert.deepEqual(sourceEgressDetail({ home }), { approval: 'not-approved', reasonCode: 'AUTHORITY_FILE_SHARED_WRITE' });
      chmodSync(join(config, 'host.json'), 0o600);
      // A link to an approving file elsewhere approves nothing.
      const elsewhere = join(home, 'elsewhere.json');
      writeFileSync(elsewhere, JSON.stringify({ ...HOST, egress: 'approved-scoped' }), { mode: 0o600 });
      rmSync(join(config, 'host.json'));
      symlinkSync(elsewhere, join(config, 'host.json'));
      assert.deepEqual(sourceEgressDetail({ home }), { approval: 'not-approved', reasonCode: 'AUTHORITY_FILE_SYMLINK' });
      rmSync(join(config, 'host.json'));
      put('host.json', { ...HOST, egress: 'approved-scoped' });
      // An organization file that breaks a rule is not approval either.
      put('organization.json', { ...HOST, egress: 'approved-scoped' });
      chmodSync(join(config, 'organization.json'), 0o646);
      assert.deepEqual(sourceEgressDetail({ home }), { approval: 'not-approved', reasonCode: 'AUTHORITY_FILE_SHARED_WRITE' });
    }
  });
});

function recorder() {
  const sent = [];
  const fetch = async (input, init) => {
    sent.push({ input, body: init?.body });
    return new Response('{"ok":true}', { status: 200 });
  };
  return { sent, fetch };
}

const request = (state) => ({ method: 'POST', body: JSON.stringify({ model: 'jev-1.13.0', state, questions: {} }) });
const key = ['gh', 'p_', 'aB3'.repeat(12)].join('');

test('without approval a request carrying evidence text is answered locally with 451 EGRESS_NOT_APPROVED and nothing is sent (GOV-01, US02)', async () => {
  const { sent, fetch } = recorder();
  const refused = [];
  const guarded = guardEgressFetch(fetch, () => 'not-approved', (code, fields) => refused.push({ code, fields }));
  const answer = await guarded('https://api.typesafe.ai/v1/systemone', request({ objective: 'Classify.', facts: { failures: 2 }, untrustedEvidence: [{ span: 's1', source: 'tool', text: 'boom at app/x.ts' }] }));
  assert.equal(answer.status, 451);
  assert.equal((await answer.json()).error.reasonCode, 'EGRESS_NOT_APPROVED');
  assert.equal(sent.length, 0);
  assert.deepEqual(refused, [{ code: 'EGRESS_NOT_APPROVED', fields: ['/state/untrustedEvidence/0/text'] }]);
  // Structured facts alone may go: they are not workspace text.
  const ok = await guarded('https://api.typesafe.ai/v1/systemone', request({ objective: 'Classify.', facts: { failures: 2 }, untrustedEvidence: [] }));
  assert.equal(ok.status, 200);
  assert.equal(sent.length, 1);
  // The packet builder's own denied shape (C, 9424098): evidence withheld as size and digest.
  const withheld = await guarded('https://api.typesafe.ai/v1/systemone', request({ objective: 'Classify.', facts: {}, untrustedEvidence: [], withheldEvidence: [{ span: 's1', source: 'tool', category: 'tool', characters: 16, digest: 'h0123456789abcdef' }] }));
  assert.equal(withheld.status, 200);
  assert.equal(sent.length, 2);
  // A body that cannot be checked is refused.
  assert.equal((await guarded('https://api.typesafe.ai/v1/systemone', { method: 'POST', body: 'not json' })).status, 451);
  assert.equal(sent.length, 2);
});

test('with approval, evidence text goes unless it holds a secret or a sensitive path: then 451 EGRESS_SECRET_BLOCKED (GOV-08, US26)', async () => {
  const { sent, fetch } = recorder();
  const refused = [];
  const guarded = guardEgressFetch(fetch, () => 'approved', (code, fields) => refused.push({ code, fields }));
  const clean = await guarded('https://api.typesafe.ai/v1/systemone', request({ untrustedEvidence: [{ span: 's1', source: 'tool', text: 'TypeError at app/x.ts:4' }] }));
  assert.equal(clean.status, 200);
  const secret = await guarded('https://api.typesafe.ai/v1/systemone', request({ untrustedEvidence: [{ span: 's1', source: 'tool', text: 'ok' }, { span: 's2', source: 'tool', text: `auth failed for ${key}` }] }));
  assert.equal(secret.status, 451);
  assert.equal((await secret.json()).error.reasonCode, 'EGRESS_SECRET_BLOCKED');
  const path = await guarded('https://api.typesafe.ai/v1/systemone', request({ task: 'print ~/.ssh/id_rsa' }));
  assert.equal(path.status, 451);
  assert.equal(sent.length, 1);
  assert.deepEqual(refused.map((item) => item.fields), [['/state/untrustedEvidence/1/text'], ['/state/task']]);
  assert.equal(JSON.stringify(refused).includes(key), false, 'the refusal note carries the secret');
});

test('approval is read on every request: a policy change applies without a restart (GOV-01)', async () => {
  const { sent, fetch } = recorder();
  let state = 'not-approved';
  const guarded = guardEgressFetch(fetch, () => state);
  const body = request({ untrustedEvidence: [{ span: 's1', source: 'tool', text: 'boom' }] });
  assert.equal((await guarded('u', body)).status, 451);
  state = 'approved';
  assert.equal((await guarded('u', body)).status, 200);
  assert.equal(sent.length, 1);
});
