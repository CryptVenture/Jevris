// The mode ceilings (SSOT §4.2 "Managed policy"; docs/configuration.md): organization.json,
// host.json and the managed policy each cap `mode` (and routing.managedWorkers), the lowest wins,
// and configure names the layer that set it. A file SR-4 refuses as an authority still caps, with
// its reason code; one that cannot be read safely or fails the contract caps at the defaults.
// Temporary homes only; the managed policy through JEVRIS_TEST_MANAGED_DIR.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jevrisPaths } from '@jevris/platform';
import { surfacePayloadContract } from '@jevris/contracts';
import { DEFAULT_CONFIG, loadEffectiveConfig, readEffectiveConfig } from '../dist/index.js';
import { managedHostSkip } from '../../../test/managed-host.mjs';
import { tempDir } from './temp-dirs.mjs';

const policy = (mode) => ({
  schemaVersion: '1.0',
  mode,
  egress: 'deny-until-approved',
  retention: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 },
  budget: { maxRequestBytes: 131072 },
  pin: { model: 'jev-1.13.0', respectHumanPins: true },
  packPrivileges: [],
  credentialRef: 'host-secret:typesafe-primary',
  installerEnvName: 'JEVRIS_INSTALLER_KEY',
  allowUncalibratedActuation: false,
});

function fixture(mode = 'advise') {
  const dir = tempDir('jv-ceiling-');
  const home = join(dir, 'home');
  mkdirSync(home);
  const configDir = jevrisPaths({ home }).config;
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, mode }));
  const write = (name, value) => writeFileSync(join(configDir, name), typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  return { dir, home, configDir, write };
}

test('no ceiling file: your mode, from your file', () => {
  const f = fixture();
  const eff = readEffectiveConfig({ home: f.home });
  assert.equal(eff.config.mode, 'advise');
  assert.equal(eff.modeSource, 'user');
  assert.equal(readEffectiveConfig({ home: join(f.dir, 'empty') }).modeSource, 'defaults');
});

test('host.json caps the mode and managed workers, and configure names it', async () => {
  const f = fixture();
  f.write('host.json', policy('observe'));
  const eff = readEffectiveConfig({ home: f.home });
  assert.equal(eff.config.mode, 'observe');
  assert.equal(eff.config.routing.managedWorkers, 'observe', 'managed workers never exceed the ceiling');
  assert.equal(eff.modeSource, 'host');
  assert.ok(eff.narrowed.some((n) => n.layer === 'host' && n.key === 'mode' && n.from === 'advise' && n.to === 'observe'));
  const payload = await loadEffectiveConfig({ home: f.home, workspaceRoot: null, sourceEgress: async () => 'not-approved' });
  assert.equal(surfacePayloadContract('configure').validate(payload).ok, true);
  assert.equal(payload.effective.mode, 'observe');
  assert.equal(payload.effective.modeSource, 'host');
  // A bounded-auto host (what `jevris egress approve` writes by default) is no ceiling.
  f.write('host.json', policy('bounded-auto'));
  assert.equal(readEffectiveConfig({ home: f.home }).config.mode, 'advise');
  assert.equal(readEffectiveConfig({ home: f.home }).modeSource, 'user');
});

test('organization.json and host.json together: the lower wins, and names its layer', () => {
  const f = fixture();
  f.write('organization.json', policy('observe'));
  f.write('host.json', policy('off'));
  let eff = readEffectiveConfig({ home: f.home });
  assert.equal(eff.config.mode, 'off');
  assert.equal(eff.modeSource, 'host');
  f.write('organization.json', policy('off'));
  f.write('host.json', policy('advise'));
  eff = readEffectiveConfig({ home: f.home });
  assert.equal(eff.config.mode, 'off');
  assert.equal(eff.modeSource, 'organization');
});

test('a policy file refused as an authority still caps, with its reason code as an issue', { skip: process.platform === 'win32' ? 'POSIX file modes' : false }, () => {
  const f = fixture();
  f.write('host.json', policy('observe'));
  chmodSync(join(f.configDir, 'host.json'), 0o664);
  const eff = readEffectiveConfig({ home: f.home });
  assert.equal(eff.config.mode, 'observe', 'a ceiling grants nothing, so a shared-write file still caps');
  assert.ok(eff.issues.some((i) => i.path === 'host:' && i.code === 'AUTHORITY_FILE_SHARED_WRITE'), JSON.stringify(eff.issues));
});

test('an invalid or unreadable policy file caps at the defaults, with an issue', { skip: process.platform === 'win32' ? 'symbolic links need privileges on Windows' : false }, () => {
  const f = fixture();
  f.write('host.json', '{ not json');
  let eff = readEffectiveConfig({ home: f.home });
  assert.equal(eff.config.mode, 'observe');
  assert.equal(eff.modeSource, 'host');
  assert.ok(eff.issues.some((i) => i.path === 'host:' && i.code === 'INVALID_JSON'));
  f.write('host.json', { schemaVersion: '1.0', mode: 'advise' });
  eff = readEffectiveConfig({ home: f.home });
  assert.equal(eff.config.mode, 'observe');
  assert.ok(eff.issues.some((i) => i.path === 'host:' && i.code === 'INVALID_POLICY'));
  // A symbolic link is never followed: it caps at the defaults too.
  const real = join(f.dir, 'elsewhere.json');
  writeFileSync(real, JSON.stringify(policy('bounded-auto')));
  f.write('host.json', policy('bounded-auto'));
  const org = join(f.configDir, 'organization.json');
  symlinkSync(real, org);
  eff = readEffectiveConfig({ home: f.home });
  assert.equal(eff.config.mode, 'observe');
  assert.equal(eff.modeSource, 'organization');
  assert.ok(eff.issues.some((i) => i.path === 'organization:' && i.code === 'AUTHORITY_FILE_SYMLINK'));
});

test('the managed policy caps the mode too; a refused one fails closed to the defaults', { skip: managedHostSkip() }, (t) => {
  const f = fixture();
  const managed = join(f.dir, 'managed');
  mkdirSync(managed, { mode: 0o755 });
  const saved = { dir: process.env.JEVRIS_TEST_MANAGED_DIR, test: process.env.JEVRIS_TEST };
  process.env.JEVRIS_TEST = '1';
  process.env.JEVRIS_TEST_MANAGED_DIR = managed;
  t.after(() => {
    if (saved.dir === undefined) delete process.env.JEVRIS_TEST_MANAGED_DIR;
    else process.env.JEVRIS_TEST_MANAGED_DIR = saved.dir;
    if (saved.test === undefined) delete process.env.JEVRIS_TEST;
    else process.env.JEVRIS_TEST = saved.test;
  });
  writeFileSync(join(managed, 'policy.json'), JSON.stringify(policy('off')), { mode: 0o644 });
  let eff = readEffectiveConfig({ home: f.home });
  assert.equal(eff.config.mode, 'off');
  assert.equal(eff.modeSource, 'managed');
  if (process.platform !== 'win32') {
    writeFileSync(join(managed, 'policy.json'), JSON.stringify(policy('bounded-auto')), { mode: 0o666 });
    chmodSync(join(managed, 'policy.json'), 0o666);
    eff = readEffectiveConfig({ home: f.home });
    assert.equal(eff.config.mode, 'observe', 'a refused managed policy caps at the defaults');
    assert.ok(eff.issues.some((i) => i.path === 'managed:' && i.code === 'MANAGED_WRITABLE_BY_OTHERS'), JSON.stringify(eff.issues));
  }
});
