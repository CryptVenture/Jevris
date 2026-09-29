// `jevris egress status | approve | revoke` (GOV-01) through the built product, in temporary
// homes with stub harnesses and no keychain. Pairs:
// - approve from a pipe and from a test run is refused, from a terminal with the phrase it writes;
// - a wrong phrase writes nothing, the right one writes host.json (0600) and approves;
// - a managed policy that denies wins (approve refuses before asking), one that approves lets
//   approve reach the person;
// - approve and revoke change only `egress` in an existing host.json;
// - approve and revoke are audited; a revoke with nothing to revoke is not;
// - revoke needs no terminal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sandbox } from '../../../test/acceptance/lib.mjs';
import { managedHostSkip } from '../../../test/managed-host.mjs';

const { jevrisPaths } = await import('@jevris/platform');
const cliUrl = pathToFileURL(fileURLToPath(new URL('../../../dist/cli.mjs', import.meta.url))).href;
const PHRASE = 'approve egress';

function hostDocument(overrides = {}) {
  return {
    schemaVersion: '1.0',
    mode: 'observe',
    egress: 'deny-until-approved',
    retention: { rawArtifactRetentionDays: 3, decisionRetentionDays: 20 },
    budget: { maxRequestBytes: 4096 },
    pin: { model: 'jev-1.13.0', respectHumanPins: true },
    packPrivileges: ['advise'],
    credentialRef: 'host-secret:typesafe-primary',
    installerEnvName: 'JEVRIS_INSTALLER_KEY',
    allowUncalibratedActuation: false,
    ...overrides,
  };
}

async function box(t) {
  const b = await sandbox(t);
  const config = jevrisPaths({ home: b.home, env: b.env }).config;
  const hostFile = join(config, 'host.json');
  /**
   * The built CLI with stdin and stdout as a terminal, the phrase typed on stdin. The runner's
   * JEVRIS_TEST=1 is kept unless `testRun` is false: approve refuses in a test run even on a
   * terminal, so the person's path is exercised in a child that is not one (its home is still
   * the sandbox's temporary home).
   */
  const onTerminal = (argv, typed, { testRun = true } = {}) => {
    const env = { ...b.env, JEVRIS_SIDECAR_AUTOSTART: '0', JEVRIS_TERMINAL_CLI: cliUrl, JEVRIS_TERMINAL_ARGV: JSON.stringify(['egress', ...argv, '--no-color']) };
    if (testRun) env.JEVRIS_TEST = '1';
    else delete env.JEVRIS_TEST;
    const r = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', "for (const s of [process.stdin, process.stdout]) Object.defineProperty(s, 'isTTY', { value: true }); const { main } = await import(process.env.JEVRIS_TERMINAL_CLI); process.exitCode = await main(JSON.parse(process.env.JEVRIS_TERMINAL_ARGV));"],
      { env, cwd: b.work, input: `${typed}\n`, encoding: 'utf8', timeout: 60_000 },
    );
    return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const status = () => b.jevris(['egress', 'status'], { json: true });
  const auditKinds = () => {
    const path = join(b.home, `audit-${String(Date.now())}.jsonl`);
    const exported = b.jevris(['audit', 'export', path]);
    assert.equal(exported.code, 0, exported.stdout + exported.stderr);
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).kind);
  };
  return { ...b, config, hostFile, onTerminal, status, auditKinds };
}

test('egress status: denied by default, from no host.json, with what may be sent and whether the Jev key is present', { skip: managedHostSkip() }, async (t) => {
  const b = await box(t);
  const s = b.status();
  assert.equal(s.code, 0, s.stdout + s.stderr);
  assert.deepEqual([s.json.egress, s.json.setting, s.json.source.kind, s.json.reasonCode], ['not-approved', 'deny-until-approved', 'default', 'EGRESS_NOT_APPROVED']);
  assert.deepEqual(s.json.maySend.fieldClasses, ['categories', 'counts', 'reason codes', 'sizes', 'salted hashes']);
  assert.deepEqual([s.json.maySend.maxRequestBytes, s.json.maySend.retention], [131072, { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 }]);
  assert.equal(s.json.credential.jevKey, 'missing', 'the test keychain is never opened, so no key is seen');
  const text = b.jevris(['egress', 'status']).stdout;
  assert.match(text, /^Source egress is denied \(deny-until-approved\)\.$/m);
  assert.match(text, /^Jev key: not in the OS keychain \(jevris credential set\)$/m);
  assert.equal(existsSync(b.hostFile), false, 'status wrote host.json');
});

test('egress approve needs a person at a terminal: refused from a pipe and in a test run, written after the typed phrase', { skip: managedHostSkip() }, async (t) => {
  const b = await box(t);
  // A pipe (a model's shell, a script): refused, nothing written, nothing audited.
  const piped = b.jevris(['egress', 'approve'], { input: `${PHRASE}\n` });
  assert.equal(piped.code, 2, piped.stdout + piped.stderr);
  assert.match(piped.stdout, /needs a person at an interactive terminal/);
  // A terminal inside a test run: refused the same way.
  const inTest = b.onTerminal(['approve'], PHRASE);
  assert.equal(inTest.code, 2, inTest.stdout + inTest.stderr);
  assert.equal(existsSync(b.hostFile), false, 'a refused approve wrote host.json');

  // A terminal, the wrong phrase: the scope is shown, nothing is written.
  const wrong = b.onTerminal(['approve'], 'yes', { testRun: false });
  assert.equal(wrong.code, 2, wrong.stdout + wrong.stderr);
  assert.match(wrong.stdout, /Local deletion \(jevris data delete\) is not vendor deletion\./);
  assert.match(wrong.stdout, /at most 131072 bytes per request/);
  assert.match(wrong.stdout, /the phrase did not match\. Nothing changed\./);
  assert.equal(existsSync(b.hostFile), false);

  // The pair: the phrase approves, creating host.json owner-only with the defaults.
  const approved = b.onTerminal(['approve'], PHRASE, { testRun: false });
  assert.equal(approved.code, 0, approved.stdout + approved.stderr);
  assert.match(approved.stdout, /Source egress approved \(approved-scoped\) in .*host\.json, created with the defaults\./);
  const written = JSON.parse(readFileSync(b.hostFile, 'utf8'));
  assert.deepEqual([written.egress, written.mode, written.budget.maxRequestBytes, written.retention], ['approved-scoped', 'bounded-auto', 131072, { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 }]);
  if (process.platform !== 'win32') assert.equal(statSync(b.hostFile).mode & 0o777, 0o600);
  const s = b.status();
  assert.deepEqual([s.json.egress, s.json.source.kind, s.json.reasonCode], ['approved', 'host', null]);
  assert.ok(s.json.maySend.fieldClasses.some((c) => /redacted decision text/.test(c)));
  // Approving again changes nothing and asks nothing.
  const again = b.onTerminal(['approve'], '', { testRun: false });
  assert.deepEqual([again.code, /already approved/.test(again.stdout)], [0, true]);
  assert.deepEqual(b.auditKinds().filter((k) => k.startsWith('egress.')), ['egress.enable']);
});

test('approve and revoke change only egress in an existing host.json; revoke needs no terminal and is audited', { skip: managedHostSkip() }, async (t) => {
  const b = await box(t);
  mkdirSync(b.config, { recursive: true });
  const before = hostDocument();
  writeFileSync(b.hostFile, JSON.stringify(before));
  chmodSync(b.hostFile, 0o600);
  // Nothing to revoke yet: no change, no audit row.
  const idle = b.jevris(['egress', 'revoke'], { json: true });
  assert.deepEqual([idle.code, idle.json.changed], [0, false], idle.stdout);

  assert.equal(b.onTerminal(['approve'], PHRASE, { testRun: false }).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(b.hostFile, 'utf8')), { ...before, egress: 'approved-scoped' }, 'approve changed another field');
  const s = b.status();
  assert.deepEqual([s.json.maySend.maxRequestBytes, s.json.maySend.retention.decisionRetentionDays], [4096, 20], 'status reads the host caps');

  // Revoke from a pipe, inside a test run: allowed, because it only tightens.
  const revoked = b.jevris(['egress', 'revoke'], { json: true });
  assert.equal(revoked.code, 0, revoked.stdout + revoked.stderr);
  assert.deepEqual([revoked.json.changed, revoked.json.egress, revoked.json.created], [true, 'not-approved', false]);
  assert.deepEqual(JSON.parse(readFileSync(b.hostFile, 'utf8')), before, 'revoke changed another field');
  assert.equal(b.status().json.egress, 'not-approved');
  assert.deepEqual(b.auditKinds().filter((k) => k.startsWith('egress.')), ['egress.enable', 'egress.revoke']);
});

test('approve refuses an invalid host.json instead of replacing it', { skip: managedHostSkip() }, async (t) => {
  const b = await box(t);
  mkdirSync(b.config, { recursive: true });
  writeFileSync(b.hostFile, JSON.stringify({ ...hostDocument(), rawDays: 3 }));
  const refused = b.jevris(['egress', 'approve']);
  assert.equal(refused.code, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /Not approved \(HOST_POLICY_INVALID\)/);
  assert.equal(JSON.parse(readFileSync(b.hostFile, 'utf8')).rawDays, 3, 'the invalid file was replaced');
  assert.equal(b.status().json.reasonCode, 'HOST_POLICY_INVALID');
});

test('SR-4: a Jevris home inside a git work tree or a host.json others may write approves nothing: status names why and approve refuses before asking', { skip: managedHostSkip() }, async (t) => {
  const b = await box(t);
  mkdirSync(join(b.home, '.git'));
  assert.equal(b.status().json.reasonCode, 'JEVRIS_HOME_IN_WORK_TREE', 'even before any host.json exists');
  const refused = b.jevris(['egress', 'approve']);
  assert.equal(refused.code, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /^Not approved \(JEVRIS_HOME_IN_WORK_TREE\): the Jevris home is inside a git work tree/);
  assert.equal(existsSync(b.hostFile), false, 'nothing was written');
  // An approving host.json there counts for nothing either.
  mkdirSync(b.config, { recursive: true });
  writeFileSync(b.hostFile, JSON.stringify(hostDocument({ egress: 'approved-scoped' })), { mode: 0o600 });
  assert.deepEqual([b.status().json.egress, b.status().json.reasonCode], ['not-approved', 'JEVRIS_HOME_IN_WORK_TREE']);
  rmSync(join(b.home, '.git'), { recursive: true });
  assert.deepEqual([b.status().json.egress, b.status().json.reasonCode], ['approved', null]);
  if (process.platform !== 'win32') {
    chmodSync(b.hostFile, 0o666);
    assert.deepEqual([b.status().json.egress, b.status().json.reasonCode], ['not-approved', 'AUTHORITY_FILE_SHARED_WRITE']);
    const text = b.jevris(['egress', 'status']).stdout;
    assert.match(text, /reason: AUTHORITY_FILE_SHARED_WRITE: host\.json or organization\.json can be written by other users/);
  }
});

test('a managed policy that denies egress wins: approve refuses before asking; one that approves lets approve reach the person', { skip: managedHostSkip() }, async (t) => {
  const b = await box(t);
  const managed = join(b.dir, 'managed');
  mkdirSync(managed, { recursive: true, mode: 0o755 });
  chmodSync(managed, 0o755);
  const policy = (egress) => {
    writeFileSync(join(managed, 'policy.json'), JSON.stringify(hostDocument({ egress, mode: 'advise', budget: { maxRequestBytes: 65536 } })));
    chmodSync(join(managed, 'policy.json'), 0o644);
  };
  const env = { JEVRIS_TEST: '1', JEVRIS_TEST_MANAGED_DIR: managed };
  policy('deny-until-approved');
  const denied = b.jevris(['egress', 'approve'], { extraEnv: env });
  assert.equal(denied.code, 1, denied.stdout + denied.stderr);
  assert.match(denied.stdout, /Not approved \(MANAGED_POLICY_DENIES\): your organization's managed policy denies it/);
  assert.equal(existsSync(b.hostFile), false);
  const deniedStatus = b.jevris(['egress', 'status'], { json: true, extraEnv: env });
  assert.deepEqual([deniedStatus.json.egress, deniedStatus.json.source.kind, deniedStatus.json.reasonCode], ['not-approved', 'managed', 'MANAGED_POLICY_DENIES']);

  // The pair: an approving managed policy is in force as it is, and a host.json that denies
  // narrows it; approve then gets past the policy to the person check.
  policy('approved-scoped');
  assert.equal(b.jevris(['egress', 'status'], { json: true, extraEnv: env }).json.egress, 'approved');
  mkdirSync(b.config, { recursive: true });
  writeFileSync(b.hostFile, JSON.stringify(hostDocument()));
  chmodSync(b.hostFile, 0o600);
  const narrowed = b.jevris(['egress', 'status'], { json: true, extraEnv: env });
  assert.deepEqual([narrowed.json.egress, narrowed.json.source.narrowedBy], ['not-approved', ['host.json']]);
  const person = b.jevris(['egress', 'approve'], { extraEnv: env });
  assert.equal(person.code, 2, person.stdout);
  assert.match(person.stdout, /needs a person at an interactive terminal/);
});
