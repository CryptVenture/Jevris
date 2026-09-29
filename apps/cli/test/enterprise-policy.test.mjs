import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jevrisPaths } from '@jevris/platform';
import { managedHostSkip } from '../../../test/managed-host.mjs';

// GOV-05: managed policy and the enterprise kill switch load from admin-owned locations with
// ownership checks; user files only narrow and carry provenance `user`; a world-writable managed
// file is refused; a user's own stop or clear is distinguished from the enterprise controls.

const ep = await import('../dist/enterprise-policy.js');
const { loadHostPolicy } = await import('../dist/host-policy.js');
const ks = await import('../dist/kill-switch.js');
const { runRuntimeCommand } = await import('../dist/runtime-commands.js');
const { resolveSourceEgress } = await import('../../sidecar/dist/egress-guard.js');
const { resolveRetention } = await import('../../sidecar/dist/retention-policy.js');

const POSIX = process.platform !== 'win32';

function policy(overrides = {}) {
  return {
    schemaVersion: '1.0',
    mode: 'advise',
    egress: 'approved-scoped',
    retention: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 },
    budget: { maxRequestBytes: 131072 },
    pin: { model: 'jev-1.13.0', respectHumanPins: true },
    packPrivileges: ['advise', 'abstain'],
    credentialRef: 'host-secret:typesafe-primary',
    installerEnvName: 'JEVRIS_INSTALLER_KEY',
    allowUncalibratedActuation: false,
    ...overrides,
  };
}

/** A managed directory (test override) and a user home, cleaned up afterwards. */
function setup(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'b-managed-')));
  const managed = join(root, 'managed');
  const home = join(root, 'home');
  const workspace = join(root, 'work');
  for (const dir of [managed, home, workspace]) mkdirSync(dir, { recursive: true, mode: 0o755 });
  chmodSync(managed, 0o755);
  const saved = { dir: process.env.JEVRIS_TEST_MANAGED_DIR, test: process.env.JEVRIS_TEST };
  process.env.JEVRIS_TEST = '1';
  process.env.JEVRIS_TEST_MANAGED_DIR = managed;
  t.after(() => {
    if (saved.dir === undefined) delete process.env.JEVRIS_TEST_MANAGED_DIR;
    else process.env.JEVRIS_TEST_MANAGED_DIR = saved.dir;
    if (saved.test === undefined) delete process.env.JEVRIS_TEST;
    else process.env.JEVRIS_TEST = saved.test;
    rmSync(root, { recursive: true, force: true });
  });
  const config = jevrisPaths({ home }).config;
  mkdirSync(config, { recursive: true });
  const put = (dir, name, value, mode = 0o644) => {
    const path = join(dir, name);
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
    chmodSync(path, mode);
    return path;
  };
  return { managed, home, workspace, config, put };
}

test('managed locations per OS, and the Windows ACL and registry parsers (GOV-05)', () => {
  assert.equal(ep.managedPolicyDir('darwin'), '/Library/Application Support/Jevris');
  assert.equal(ep.managedPolicyDir('linux'), '/etc/jevris');
  assert.match(ep.managedPolicyDir('win32', { ProgramData: 'D:\\ProgramData' }), /^D:\\ProgramData[\\/]Jevris$/);
  assert.equal(ep.aclAdminOnlyWrite([{ principal: 'NT AUTHORITY\\SYSTEM', rights: '(I)(F)' }, { principal: 'BUILTIN\\Administrators', rights: '(I)(F)' }, { principal: 'BUILTIN\\Users', rights: '(I)(RX)' }]), true);
  assert.equal(ep.aclAdminOnlyWrite([{ principal: 'BUILTIN\\Users', rights: '(I)(M)' }]), false, 'users may modify');
  assert.equal(ep.aclAdminOnlyWrite([{ principal: 'Everyone', rights: '(W)' }]), false);
  assert.equal(ep.aclAdminOnlyWrite([{ principal: 'Everyone', rights: '(DENY)(W)' }]), true, 'a deny entry grants nothing');
  const reg = '\r\nHKEY_LOCAL_MACHINE\\Software\\Policies\\Jevris\r\n    KillSwitch    REG_DWORD    0x1\r\n';
  assert.deepEqual(ep.parseRegQuery(reg, 'KillSwitch'), { type: 'REG_DWORD', data: '0x1' });
  assert.equal(ep.parseRegQuery(reg, 'Policy'), undefined);
});

test('a valid managed policy is the base; user files only narrow it and carry provenance user (GOV-05)', { skip: managedHostSkip() }, async (t) => {
  const { managed, home, workspace, config, put } = setup(t);
  assert.deepEqual(ep.readManagedPolicy(), { state: 'absent' });
  put(managed, 'policy.json', policy({ egress: 'deny-until-approved', retention: { rawArtifactRetentionDays: 5, decisionRetentionDays: 20 } }));
  const read = ep.readManagedPolicy();
  assert.equal(read.state, 'ok', JSON.stringify(read));

  // The user's host.json approves egress: that widens the managed policy, so it is ignored.
  put(config, 'host.json', policy());
  let loaded = await loadHostPolicy({ home, workspace });
  assert.equal(loaded.source, 'managed');
  assert.equal(loaded.document.egress, 'deny-until-approved');
  assert.equal(loaded.reasonCode, 'POLICY_WIDEN');
  assert.equal(resolveSourceEgress({ home }), 'not-approved');

  // A user file that narrows is applied.
  put(config, 'host.json', policy({ egress: 'deny-until-approved', mode: 'observe', retention: { rawArtifactRetentionDays: 2, decisionRetentionDays: 20 } }));
  loaded = await loadHostPolicy({ home, workspace });
  assert.equal(loaded.reasonCode, undefined);
  assert.equal(loaded.document.mode, 'observe');
  assert.equal(loaded.document.retention.rawArtifactRetentionDays, 2);
  const layered = ep.layerPolicy(read, loaded.document, undefined);
  assert.deepEqual(layered.userLayers, [{ file: 'host.json', provenance: 'user', applied: true, reasonCode: null }]);

  // The managed policy approves egress: the user can still narrow it to denied, never widen.
  put(managed, 'policy.json', policy());
  put(config, 'host.json', policy({ egress: 'deny-until-approved' }));
  assert.equal(resolveSourceEgress({ home }), 'not-approved', 'the user narrowed egress');
  rmSync(join(config, 'host.json'));
  assert.equal(resolveSourceEgress({ home }), 'approved', 'the managed policy alone approves');
  // Retention is capped by the managed policy as well.
  put(managed, 'policy.json', policy({ retention: { rawArtifactRetentionDays: 3, decisionRetentionDays: 9 } }));
  assert.deepEqual(resolveRetention({ home }).policy, { rawArtifactRetentionDays: 3, decisionRetentionDays: 9 });
});

test('a world-writable, non-admin, symlinked or raw-key managed file is refused and approves nothing (GOV-05)', { skip: managedHostSkip() || !POSIX && 'POSIX modes; the Windows ACL check is unit-tested above' }, async (t) => {
  const { managed, home, workspace, put } = setup(t);
  const path = put(managed, 'policy.json', policy(), 0o666);
  assert.deepEqual([ep.readManagedPolicy().state, ep.readManagedPolicy().reasonCode], ['refused', 'MANAGED_WRITABLE_BY_OTHERS']);
  const loaded = await loadHostPolicy({ home, workspace });
  assert.deepEqual([loaded.active, loaded.reasonCode], [false, 'MANAGED_POLICY_REFUSED']);
  assert.equal(resolveSourceEgress({ home }), 'not-approved');
  assert.ok(resolveRetention({ home }).issues.includes('MANAGED_POLICY_REFUSED'));

  chmodSync(path, 0o644);
  chmodSync(managed, 0o777);
  assert.equal(ep.readManagedPolicy().reasonCode, 'MANAGED_WRITABLE_BY_OTHERS', 'a writable managed directory');
  chmodSync(managed, 0o755);
  assert.equal(ep.readManagedPolicy().state, 'ok');

  rmSync(path);
  const elsewhere = put(home, 'fake.json', policy());
  symlinkSync(elsewhere, path);
  assert.equal(ep.readManagedPolicy().reasonCode, 'MANAGED_SYMLINK');
  rmSync(path);
  put(managed, 'policy.json', { ...policy(), apiKey: 'x' });
  assert.equal(ep.readManagedPolicy().reasonCode, 'MANAGED_RAW_KEY');
  put(managed, 'policy.json', { ...policy(), extra: true });
  assert.equal(ep.readManagedPolicy().reasonCode, 'MANAGED_INVALID');
});

test('the enterprise kill switch stops Jevris; the user cannot clear it, and a user stop is told apart (GOV-05)', { skip: managedHostSkip() }, async (t) => {
  const { managed, home, put } = setup(t);
  const interactive = { interactive: () => true, actor: 'dev' };
  const run = async (args) => {
    let text = '';
    const code = await runRuntimeCommand([...args, '--home', home], (chunk) => (text += chunk), interactive);
    return { code, text };
  };
  assert.equal(await ks.readKillSwitchStopped(home), false);
  put(managed, 'kill-switch.json', { stopped: true, reason: 'incident 42' });
  assert.equal(await ks.readKillSwitchStopped(home), true, 'the user has no flag, and Jevris is stopped');
  let r = await run(['kill-switch', 'status']);
  assert.match(r.text, /kill switch: stopped/);
  assert.match(r.text, /stopped by your organization \(managed file\): incident 42; only an administrator can lift it/);
  assert.match(r.text, /your flag: no flag set/);
  r = await run(['kill-switch', 'clear']);
  assert.equal(r.code, 1);
  assert.match(r.text, /still stopped by your organization's kill switch/);
  assert.equal(await ks.readKillSwitchStopped(home), true);

  // The administrator lifts it: the user's own flag decides again.
  put(managed, 'kill-switch.json', { stopped: false });
  assert.equal(await ks.readKillSwitchStopped(home), false);
  r = await run(['kill-switch', 'activate', '--reason', 'mine']);
  assert.equal(r.code, 0);
  r = await run(['kill-switch', 'status', '--json']);
  const status = JSON.parse(r.text.trim().split('\n').at(-1));
  assert.deepEqual([status.state, status.managed.stopped, status.reason], ['stopped', false, 'mine'], 'a user stop, not the organization');
  assert.equal((await run(['kill-switch', 'clear'])).code, 0);

  // A malformed or tampered enterprise switch fails closed.
  put(managed, 'kill-switch.json', '{not json');
  assert.equal(await ks.readKillSwitchStopped(home), true);
  if (POSIX) {
    put(managed, 'kill-switch.json', { stopped: false }, 0o666);
    const managedSwitch = ep.readManagedKillSwitch();
    assert.deepEqual([managedSwitch.stopped, managedSwitch.refused], [true, 'MANAGED_WRITABLE_BY_OTHERS']);
  }
});

test('Windows: the ACL decides a managed file, and the policy registry key is read when no file exists (GOV-05)', (t) => {
  const { managed, put } = setup(t);
  put(managed, 'policy.json', policy());
  const acl = (target, users) => `${target} NT AUTHORITY\\SYSTEM:(I)(F)\r\n    BUILTIN\\Administrators:(I)(F)\r\n    BUILTIN\\Users:(I)(${users})\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`;
  const env = { JEVRIS_TEST: '1', JEVRIS_TEST_MANAGED_DIR: managed, SystemRoot: 'C:\\Windows' };
  const exec = (users) => (_command, args) => ({ status: 0, stdout: acl(args[0], users) });
  assert.equal(ep.readManagedPolicy({ platform: 'win32', env, exec: exec('RX') }).state, 'ok');
  assert.equal(ep.readManagedPolicy({ platform: 'win32', env, exec: exec('M') }).reasonCode, 'MANAGED_WRITABLE_BY_OTHERS');

  const registry = (values) => (command, args) => {
    const name = args[3];
    if (!command.endsWith('reg.exe') || !(name in values)) return { status: 1, stdout: '' };
    return { status: 0, stdout: `\r\nHKEY_LOCAL_MACHINE\\Software\\Policies\\Jevris\r\n    ${name}    ${values[name]}\r\n` };
  };
  const winEnv = { ProgramData: 'Q:\\NoSuchProgramData', SystemRoot: 'C:\\Windows' };
  const fromRegistry = ep.readManagedPolicy({ platform: 'win32', env: winEnv, exec: registry({ Policy: `REG_SZ    ${JSON.stringify(policy({ egress: 'deny-until-approved' }))}` }) });
  assert.deepEqual([fromRegistry.state, fromRegistry.source, fromRegistry.document?.egress], ['ok', 'registry', 'deny-until-approved']);
  assert.equal(ep.readManagedKillSwitch({ platform: 'win32', env: winEnv, exec: registry({ KillSwitch: 'REG_DWORD    0x1' }) }).stopped, true);
  assert.equal(ep.readManagedKillSwitch({ platform: 'win32', env: winEnv, exec: registry({ KillSwitch: 'REG_DWORD    0x0' }) }).stopped, false);
  assert.equal(ep.readManagedKillSwitch({ platform: 'win32', env: winEnv, exec: registry({}) }).stopped, false);
  assert.equal(ep.readManagedKillSwitch({ platform: 'win32', env: winEnv, exec: registry({ KillSwitch: 'REG_SZ    yes' }) }).stopped, true, 'a malformed value fails closed');
});
