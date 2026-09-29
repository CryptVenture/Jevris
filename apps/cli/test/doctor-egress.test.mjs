// E's request (e13356f, `jevris egress`): doctor's egress line names its fix. Denial is by design,
// so the line stays info. A denial only an administrator or a file fix can lift points to
// `jevris egress status`; an approval shows as allow. Temp homes only; the Jev key is never read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { doctorLineSeverity } = await import('../dist/doctor-severity.js');
const { runDoctorCommand, withEgressFix } = await import('../dist/doctor-cli.js');
const { defaultHostDocument } = await import('../dist/egress-command.js');
const { jevrisPaths } = await import('@jevris/platform');

const root = fileURLToPath(new URL('../../..', import.meta.url));
const cli = { available: () => false, run: async () => ({ spawned: false, code: -1, stdout: '' }) };

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-doctor-egress-'));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3 }));
  return home;
}

async function doctorLines(home) {
  let out = '';
  await runDoctorCommand({ home, json: true, values: {}, root, cli, policies: [], env: { PATH: '' } }, (chunk) => (out += chunk));
  return JSON.parse(out).lines;
}

const APPROVE = 'egressReasonCode: EGRESS_NOT_APPROVED (nothing leaves this machine until you approve it; fix: run jevris egress approve (interactive))';

test('not approved: the egress line names jevris egress approve, and stays info', async (t) => {
  const home = tempHome(t);
  const lines = await doctorLines(home);
  assert.deepEqual(lines.find((line) => line.text.startsWith('egressReasonCode: ')), { text: APPROVE, severity: 'info' });
  assert.deepEqual(lines.find((line) => line.text.startsWith('egressDecision: ')), { text: 'egressDecision: deny', severity: 'info' });
});

test('an invalid host.json points to jevris egress status, which says why; approve would not help', async (t) => {
  const home = tempHome(t);
  const config = jevrisPaths({ home }).config;
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'host.json'), '{"egress":');
  const line = (await doctorLines(home)).find((item) => item.text.startsWith('egressReasonCode: '));
  assert.deepEqual(line, { text: 'egressReasonCode: EGRESS_NOT_APPROVED (nothing leaves this machine: HOST_POLICY_INVALID; jevris egress status shows why)', severity: 'info' });
});

test('an approval in host.json shows as allow, with no reason line', async (t) => {
  const home = tempHome(t);
  const config = jevrisPaths({ home }).config;
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'host.json'), JSON.stringify(defaultHostDocument('approved-scoped')));
  const lines = await doctorLines(home);
  assert.equal(lines.find((line) => line.text.startsWith('egressDecision: ')).text, 'egressDecision: allow');
  assert.equal(lines.some((line) => line.text.startsWith('egressReasonCode: ')), false);
});

test('SR-4: an approval from a home inside a git work tree does not count, and doctor says why', async (t) => {
  const home = tempHome(t);
  const config = jevrisPaths({ home }).config;
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'host.json'), JSON.stringify(defaultHostDocument('approved-scoped')), { mode: 0o600 });
  mkdirSync(join(home, '.git'));
  const lines = await doctorLines(home);
  assert.equal(lines.find((line) => line.text.startsWith('egressDecision: ')).text, 'egressDecision: deny');
  assert.deepEqual(lines.find((line) => line.text.startsWith('egressReasonCode: ')), { text: 'egressReasonCode: EGRESS_NOT_APPROVED (nothing leaves this machine: JEVRIS_HOME_IN_WORK_TREE; jevris egress status shows why)', severity: 'info' });
});

test('withEgressFix: managed and organization denials point to egress status; a line is suffixed once', () => {
  for (const code of ['MANAGED_POLICY_DENIES', 'MANAGED_POLICY_REFUSED', 'ORGANIZATION_DENIES', 'HOST_POLICY_INVALID', 'AUTHORITY_FILE_SYMLINK', 'AUTHORITY_FILE_SHARED_WRITE', 'AUTHORITY_FILE_IN_WORK_TREE', 'JEVRIS_HOME_IN_WORK_TREE']) {
    const text = withEgressFix('egressDecision: deny\negressReasonCode: EGRESS_NOT_APPROVED\n', code);
    assert.equal(text, `egressDecision: deny\negressReasonCode: EGRESS_NOT_APPROVED (nothing leaves this machine: ${code}; jevris egress status shows why)\n`);
    assert.equal(doctorLineSeverity(text.split('\n')[1]), 'info');
  }
  assert.equal(withEgressFix(`${APPROVE}\n`, null), `${APPROVE}\n`);
  assert.equal(withEgressFix('egressReasonCode: EGRESS_NOT_APPROVED', 'EGRESS_NOT_APPROVED'), APPROVE);
});
