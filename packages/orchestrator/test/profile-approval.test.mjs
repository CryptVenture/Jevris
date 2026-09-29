import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileWorkspace, proposeChecks } from '@jevris/languages';
import { approveProposal, attachedHardware, openWorkspace, revokeApproval, runVerification, setHardwareRunner, verificationSupport } from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

function fixture() {
  const dir = tempDir('jv-profile-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'firmware'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  writeFileSync(join(repo, 'firmware', 'platformio.ini'), '[env:native]\n');
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  return { repo, ws, done: () => {
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    } };
}

test('an analyzer proposal flips verification to supported only after approval and back on revoke (VER-07)', async () => {
  const f = fixture();
  try {
    assert.equal(verificationSupport(f.ws).state, 'unsupported');
    const proposal = proposeChecks(profileWorkspace(f.repo), f.repo);
    const approved = await approveProposal(f.ws, proposal, 'analyzer:jevris.npm');
    assert.notEqual(approved.ok, false, JSON.stringify(approved));
    const support = verificationSupport(f.ws);
    assert.equal(support.state, 'supported');
    assert.deepEqual(support.approvedCheckIds, ['firmware-pio-test-device', 'firmware-pio-test-native', 'test']);
    await revokeApproval(f.ws);
    assert.equal(verificationSupport(f.ws).state, 'unsupported');
  } finally {
    f.done();
  }
});

test('a hardware-bound check records not-run until this host attaches that hardware (VER-07)', async () => {
  const f = fixture();
  try {
    await approveProposal(f.ws, proposeChecks(profileWorkspace(f.repo), f.repo), 'analyzer');
    const out = await runVerification(f.ws, { taskId: null, checkIds: ['firmware-pio-test-device'] });
    assert.equal(out.ran.length, 1);
    assert.equal(out.ran[0].receipt.outcome, 'not-run');
    await setHardwareRunner(f.ws, 'platformio-device', true);
    assert.deepEqual(attachedHardware(f.ws), ['platformio-device']);
    await setHardwareRunner(f.ws, 'platformio-device', false);
    assert.deepEqual(attachedHardware(f.ws), []);
    await assert.rejects(setHardwareRunner(f.ws, 'bad name', true));
  } finally {
    f.done();
  }
});
