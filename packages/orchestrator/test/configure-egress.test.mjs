// `jevris configure show` reports source egress as the host decision the egress guard enforces
// (B's resolveSourceEgress, a0d0b99), the same answer as `jevris egress status` (E e13356f), and
// never the `privacy.sourceEgress` preference in jevris.config.json on its own. Pairs:
// - the loader: an approving host decision shows approved-scoped; a user file that says
//   approved-scoped without host approval shows deny-until-approved;
// - through the built product in a temporary home: after `jevris egress approve` at a terminal,
//   configure show agrees with egress status; after revoke, both deny.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { jevrisPaths } from '@jevris/platform';
import { DEFAULT_CONFIG, loadEffectiveConfig, setConfigValue } from '../dist/index.js';
import { sandbox } from '../../../test/acceptance/lib.mjs';
import { managedHostSkip } from '../../../test/managed-host.mjs';
import { tempDir } from './temp-dirs.mjs';

const cliUrl = pathToFileURL(fileURLToPath(new URL('../../../dist/cli.mjs', import.meta.url))).href;

test('configure show reports the host egress decision, not the jevris.config.json preference (GOV-01, SET-02)', async () => {
  const home = tempDir('jv-cfg-egress-');
  const config = jevrisPaths({ home }).config;
  mkdirSync(config, { recursive: true });
  const approved = async () => 'approved';
  const denied = async () => 'not-approved';
  // No user file: the host decision decides either way.
  assert.equal((await loadEffectiveConfig({ home, workspaceRoot: null, sourceEgress: approved })).effective.sourceEgress, 'approved-scoped');
  assert.equal((await loadEffectiveConfig({ home, workspaceRoot: null, sourceEgress: denied })).effective.sourceEgress, 'deny-until-approved');
  // A user file that asks for egress does not approve it; with host approval it shows approved.
  writeFileSync(join(config, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, privacy: { ...DEFAULT_CONFIG.privacy, sourceEgress: 'approved-scoped' } }));
  const preferred = await loadEffectiveConfig({ home, workspaceRoot: null, sourceEgress: denied });
  assert.deepEqual([preferred.source, preferred.valid, preferred.effective.sourceEgress], ['file', true, 'deny-until-approved']);
  assert.equal((await loadEffectiveConfig({ home, workspaceRoot: null, sourceEgress: approved })).effective.sourceEgress, 'approved-scoped');
  // Provenance (E beb0359): the value is the host decision; the user file's value is only a preference.
  const fields = (p) => [p.effective.sourceEgress, p.effective.sourceEgressSource, p.effective.sourceEgressPreference];
  assert.deepEqual(fields(preferred), ['deny-until-approved', 'host-policy', 'approved-scoped']);
  // The setter answers the same way (it read the user file before, and reported it as the decision).
  const set = await setConfigValue({ home, key: 'mode', value: 'observe', dryRun: false, sourceEgress: denied });
  assert.deepEqual(fields(set), ['deny-until-approved', 'host-policy', 'approved-scoped']);
  const dry = await setConfigValue({ home, key: 'mode', value: 'advise', dryRun: true, sourceEgress: approved });
  assert.deepEqual(fields(dry), ['approved-scoped', 'host-policy', 'approved-scoped']);
  // No valid user file: no preference.
  writeFileSync(join(config, 'jevris.config.json'), '{ not json');
  assert.deepEqual(fields(await loadEffectiveConfig({ home, workspaceRoot: null, sourceEgress: approved })), ['approved-scoped', 'host-policy', null]);
  // A resolver that fails is not approval.
  const failing = await loadEffectiveConfig({ home, workspaceRoot: null, sourceEgress: async () => { throw new Error('unavailable'); } });
  assert.equal(failing.effective.sourceEgress, 'deny-until-approved');
});

test('after jevris egress approve, configure show agrees with egress status; after revoke both deny (GOV-01, E e13356f)', { skip: managedHostSkip() }, async (t) => {
  const b = await sandbox(t);
  // approve needs a person at a terminal outside a test run; the home is still the sandbox's.
  const onTerminal = (argv, typed) => {
    const env = { ...b.env, JEVRIS_SIDECAR_AUTOSTART: '0', JEVRIS_TERMINAL_CLI: cliUrl, JEVRIS_TERMINAL_ARGV: JSON.stringify(['egress', ...argv, '--no-color']) };
    delete env.JEVRIS_TEST;
    const r = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', "for (const s of [process.stdin, process.stdout]) Object.defineProperty(s, 'isTTY', { value: true }); const { main } = await import(process.env.JEVRIS_TERMINAL_CLI); process.exitCode = await main(JSON.parse(process.env.JEVRIS_TERMINAL_ARGV));"],
      { env, cwd: b.work, input: `${typed}\n`, encoding: 'utf8', timeout: 60_000 },
    );
    return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const both = () => {
    const egress = b.jevris(['egress', 'status'], { json: true });
    const shown = b.jevris(['configure', 'show'], { json: true });
    assert.equal(egress.code, 0, egress.stdout + egress.stderr);
    const payload = shown.json?.payload ?? shown.json?.result ?? shown.json;
    assert.equal(payload.effective.sourceEgressSource, 'host-policy');
    return { status: egress.json.egress, shown: payload.effective.sourceEgress };
  };
  assert.deepEqual(both(), { status: 'not-approved', shown: 'deny-until-approved' });
  const approved = onTerminal(['approve'], 'approve egress');
  assert.equal(approved.code, 0, approved.out);
  assert.deepEqual(both(), { status: 'approved', shown: 'approved-scoped' });
  const revoked = b.jevris(['egress', 'revoke']);
  assert.equal(revoked.code, 0, revoked.stdout + revoked.stderr);
  assert.deepEqual(both(), { status: 'not-approved', shown: 'deny-until-approved' });
});
