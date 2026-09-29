import test from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';


const { runDoctor, formatDoctor } = await import('../dist/doctor.js');
const { finishDoctor } = await import('../dist/cli.js');
const { classifyEnvironment } = await import('../dist/platform.js');
const { installPlugin } = await import('../dist/install.js');
const { deleteJevrisData, uninstallPlugin } = await import('../dist/uninstall.js');
const { jevrisPaths } = await import('../../../packages/platform/dist/index.js');

/** The Jevris data directory for this OS (~/.jevris on darwin, XDG data on linux). */
function dataDir(home) {
  return jevrisPaths({ home }).data;
}
const { assertProductHooksAbsentOrCertified } = await import(
  new URL('../test/product-hooks.mjs', import.meta.url),
);

const REPO_ROOT = join(import.meta.dirname, '../../..');
const PRODUCT_HOOKS = join(REPO_ROOT, 'plugins', 'claude', 'hooks', 'hooks.json');
const CLEAN_FIXTURE = join(import.meta.dirname, '../../../fixtures/install/with spaces/jevris');
const ALL_ACTUATOR_IDS = [
  'pretooluse-deny',
  'worker.route',
  'verification',
  'windows-launcher',
  'claude.adapter',
  'codex.adapter',
  'antigravity.adapter',
  'opencode.adapter',
  'kilocode.adapter',
];
/** windows-launcher is a row only on Windows. */
const actuatorIds = (platform) => ALL_ACTUATOR_IDS.filter((id) => id !== 'windows-launcher' || platform === 'win32');

async function productHooksSnapshot() {
  try {
    return { exists: true, bytes: await readFile(PRODUCT_HOOKS) };
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return { exists: false, bytes: null };
    }
    throw error;
  }
}

function assertHooksUnchanged(before, after) {
  assert.equal(after.exists, before.exists);
  if (before.bytes === null) {
    assert.equal(after.bytes, null);
    return;
  }
  assert.equal(Buffer.from(after.bytes).equals(before.bytes), true);
}

function healthyInstallRunner() {
  return async (file, args, options) => {
    assert.equal(file, 'claude');
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 2000);
    assert.equal(Array.isArray(args), true);
    const argv = [...args];
    assert.equal(argv.includes('hooks'), false);
    if (argv[0] === '--version') {
      return { stdout: '2.1.281\n', code: 0, spawned: true };
    }
    assert.deepEqual(argv, ['doctor']);
    return { stdout: '', code: 0, spawned: true };
  };
}

test('a healthy install with version 2.1.281 and doctor exit 0 does not certify actuators', async () => {
  const before = await productHooksSnapshot();
  const report = await runDoctor({
    versionProbe: () => '2.1.281',
    platform: 'darwin',
    nodeVersion: 'v24.18.1',
    packs: [],
    certificationRecords: [],
    fixtureHashes: {},
    harnessRunner: healthyInstallRunner(),
  });
  assertHooksUnchanged(before, await productHooksSnapshot());

  assert.equal(report.harnessVersion, '2.1.281');
  assert.equal(report.harnessProbe.health, 'installation-only');
  assert.equal(report.harnessProbe.eventProbe, 'did-not-pass');
  assert.equal(report.harnessProbe.actuators, 'unsupported');
  // The doctor above is asked about darwin, whatever OS runs this test.
  assert.deepEqual(
    report.actuators.map((row) => row.id),
    actuatorIds('darwin'),
  );
  for (const row of report.actuators) {
    assert.equal(row.status, 'unsupported');
    assert.equal(row.fixtureHash, null);
  }

  const text = formatDoctor(report);
  for (const id of actuatorIds('darwin')) {
    assert.equal(text.includes(`actuator ${id}: certified`), false);
    assert.equal(text.includes(`actuator ${id}: unsupported`), true);
  }
  assert.equal(text.includes('enforced'), false);

  let written = '';
  const code = finishDoctor(text, (chunk) => {
    written += chunk;
  });
  assert.equal(code, 0);
  assert.equal(written, text);
});

function destinationOf(home) {
  return resolve(home, '.claude', 'skills', 'jevris');
}

function settingsOf(home) {
  return resolve(home, '.claude', 'settings.json');
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function withHome(fn) {
  const parent = await mkdtemp(join(tmpdir(), 'jevris-reg-'));
  const home = join(parent, 'with spaces');
  await mkdir(home, { recursive: true });
  try {
    await fn(home);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

async function filesUnder(root) {
  const found = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(relative(root, path));
    }
  }
  await walk(root);
  return found.sort();
}

async function sourceWithoutHooks() {
  const parent = await mkdtemp(join(tmpdir(), 'jevris-src-'));
  const source = join(parent, 'with spaces');
  await cp(CLEAN_FIXTURE, source, { recursive: true });
  await rm(join(source, 'hooks'), { recursive: true, force: true });
  return { parent, source };
}

test('install and uninstall change only owned entries', async () => {
  const hooksBefore = await productHooksSnapshot();
  assert.equal(
    classifyEnvironment({ platform: 'linux', nodeVersion: 'v24.18.1', env: {} }),
    'local',
  );

  const stripped = await sourceWithoutHooks();
  try {
    await withHome(async (home) => {
      const installed = await installPlugin({
        home,
        source: stripped.source,
        platform: 'linux',
      });
      assert.equal(installed.ok, true);
      assert.equal(installed.installStatus, 'reduced');
      assert.equal(await exists(join(destinationOf(home), 'hooks', 'hooks.json')), false);
      assert.equal(await exists(settingsOf(home)), false);
      const removed = await uninstallPlugin({ home });
      assert.equal(removed.ok, true);
      assert.equal(await exists(destinationOf(home)), false);
      assert.equal(await exists(settingsOf(home)), false);
      assert.deepEqual(await filesUnder(home), [relative(home, join(dataDir(home), 'install-receipt.json'))]);
      const deleted = await deleteJevrisData({ home });
      assert.equal(deleted.ok, true);
      assert.deepEqual(await filesUnder(home), []);
      assert.equal(await exists(dataDir(home)), false);
    });
  } finally {
    await rm(stripped.parent, { recursive: true, force: true });
  }

  await withHome(async (home) => {
    const otherDir = join(home, '.claude', 'skills', 'other-plugin');
    const otherFile = join(otherDir, 'keep.txt');
    const otherBytes = new TextEncoder().encode('other-plugin-bytes\n');
    await mkdir(otherDir, { recursive: true });
    await writeFile(otherFile, otherBytes);
    const settings = settingsOf(home);
    const original = '{"theme":"plain","enabledPlugins":{"other@skills-dir":true}}\n';
    await writeFile(settings, original);

    const mutated = '{"theme":"plain","enabledPlugins":{"other@skills-dir":true},"concurrent":1}\n';
    let sawInstallRead = false;
    const refusedInstall = await installPlugin({
      home,
      source: CLEAN_FIXTURE,
      enable: true,
      platform: 'linux',
      afterSettingsRead: async () => {
        sawInstallRead = true;
        await writeFile(settings, mutated);
      },
    });
    assert.equal(sawInstallRead, true);
    assert.equal(refusedInstall.ok, false);
    assert.equal(refusedInstall.installStatus, 'refused');
    assert.equal(await readFile(settings, 'utf8'), mutated);
    assert.equal(await exists(destinationOf(home)), false);
    assert.equal(Buffer.from(await readFile(otherFile)).equals(otherBytes), true);

    await writeFile(settings, original);
    const installed = await installPlugin({
      home,
      source: CLEAN_FIXTURE,
      enable: true,
      platform: 'linux',
    });
    assert.equal(installed.ok, true);
    const installedSettings = await readFile(settings, 'utf8');
    const installedDoc = JSON.parse(installedSettings);
    assert.equal(installedDoc.theme, 'plain');
    assert.equal(installedDoc.enabledPlugins['other@skills-dir'], true);
    assert.equal(installedDoc.enabledPlugins['jevris@skills-dir'], true);
    assert.equal(Object.keys(installedDoc.enabledPlugins).length, 2);
    const copiedHooks = join(destinationOf(home), 'hooks', 'hooks.json');
    assert.equal(resolve(copiedHooks) === resolve(PRODUCT_HOOKS), false);
    assert.equal(
      Buffer.from(await readFile(copiedHooks)).equals(await readFile(join(CLEAN_FIXTURE, 'hooks', 'hooks.json'))),
      true,
    );

    const uninstallMutated = '{"theme":"plain","concurrent":2}\n';
    let sawUninstallRead = false;
    const refusedUninstall = await uninstallPlugin({
      home,
      afterSettingsRead: async () => {
        sawUninstallRead = true;
        await writeFile(settings, uninstallMutated);
      },
    });
    assert.equal(sawUninstallRead, true);
    assert.equal(refusedUninstall.ok, false);
    assert.equal(await readFile(settings, 'utf8'), uninstallMutated);
    assert.equal(await exists(destinationOf(home)), true);
    assert.equal(await exists(dataDir(home)), true);

    await writeFile(settings, installedSettings);
    const removed = await uninstallPlugin({ home });
    assert.equal(removed.ok, true);
    assert.equal(await exists(destinationOf(home)), false);
    const after = JSON.parse(await readFile(settings, 'utf8'));
    assert.equal(after.theme, 'plain');
    assert.equal(after.enabledPlugins['other@skills-dir'], true);
    assert.equal(Object.hasOwn(after.enabledPlugins, 'jevris@skills-dir'), false);
    assert.equal(await exists(dataDir(home)), true);
    assert.equal(Buffer.from(await readFile(otherFile)).equals(otherBytes), true);
    const deleted = await deleteJevrisData({ home });
    assert.equal(deleted.ok, true);
    assert.equal(await exists(dataDir(home)), false);
    assert.equal(after.theme, 'plain');
    assert.equal(Buffer.from(await readFile(otherFile)).equals(otherBytes), true);
    assert.equal(await exists(join(home, '.claude')), true);
  });
  // The uninstallPlugin-never-calls-deleteJevrisData source check is in apps/cli/lint/install.lint.mjs (QA-07).
  assertHooksUnchanged(hooksBefore, await productHooksSnapshot());
});

const UI_LOCALHOST = 'UI localhost is not the worker.';
const US36_THEN_CLAIMS = [
  'passes arguments correctly',
  'passed arguments',
  'private IPC',
  'produces valid protocol JSON',
  'produced protocol JSON',
  'protocol JSON',
];

function validPack(overrides = {}) {
  return {
    schemaVersion: '1.0',
    id: 'jevris.route',
    version: '1.0.0',
    maturity: 'experimental',
    description: 'PACK_BODY_CANARY',
    requiresCapabilities: ['worker.route'],
    fallbackCapabilities: ['advise'],
    decisionSpecs: ['failureFamily'],
    actions: ['advise'],
    dataScopes: ['task-metadata'],
    defaultMode: 'advise',
    conflicts: ['jevris.other'],
    fixtures: ['fixture-a'],
    ...overrides,
  };
}

function assertActuatorsUnsupported(report, text, platform = 'darwin') {
  assert.deepEqual(
    report.actuators.map((row) => row.id),
    actuatorIds(platform),
  );
  for (const row of report.actuators) {
    assert.equal(row.status, 'unsupported');
    assert.equal(text.includes(`actuator ${row.id}: certified`), false);
    assert.equal(text.includes(`actuator ${row.id}: unsupported`), true);
  }
  assert.equal(report.harnessProbe.eventProbe, 'did-not-pass');
  assert.equal(report.harnessProbe.actuators, 'unsupported');
  assert.equal(text.includes('enforced'), false);
  assert.equal(text.includes(UI_LOCALHOST) === (report.environmentStatus === 'reduced'), true);
}

test('remote, container, unprobed, and win32 environments stay uncertified', async () => {
  const hooksBefore = await productHooksSnapshot();
  await assertProductHooksAbsentOrCertified();

  assert.equal(
    classifyEnvironment({
      platform: 'win32',
      nodeVersion: 'v24.18.1',
      env: { CLAUDE_CODE_REMOTE: 'true', SSH_CONNECTION: '203.0.113.4 1 198.51.100.8 22' },
      inContainer: true,
    }),
    'reduced',
  );
  assert.equal(classifyEnvironment({ platform: 'darwin', nodeVersion: 'v26.5.0', env: {} }), 'local');
  assert.equal(classifyEnvironment({ platform: 'linux', nodeVersion: 'v24.18.1', env: {} }), 'local');

  const reducedCases = [
    { env: { CLAUDE_CODE_REMOTE: 'true' } },
    { env: { SSH_CONNECTION: '203.0.113.4 51324 198.51.100.8 22' } },
    { env: { SSH_CLIENT: '203.0.113.4 51324 22' } },
    { env: { KUBERNETES_SERVICE_HOST: '10.0.0.1' } },
    { env: {}, inContainer: true },
  ];
  for (const fields of reducedCases) {
    assert.equal(classifyEnvironment({ platform: 'darwin', nodeVersion: 'v24.18.1', ...fields }), 'reduced');
    const report = await runDoctor({
      versionProbe: () => '2.1.281',
      platform: 'darwin',
      nodeVersion: 'v24.18.1',
      packs: [validPack(), validPack({ id: 'jevris.empty', fallbackCapabilities: [] })],
      certificationRecords: [],
      fixtureHashes: {},
      harnessRunner: healthyInstallRunner(),
      ...fields,
    });
    assert.equal(report.environmentStatus, 'reduced');
    const text = formatDoctor(report);
    assert.equal(text.includes(UI_LOCALHOST), true);
    assertActuatorsUnsupported(report, text);
    assert.equal(report.packs[0].disposition, 'advice');
    assert.equal(report.packs[0].missingCapabilities[0], 'worker.route');
    assert.equal(report.packs[1].disposition, 'disabled');
    assert.equal(text.includes('PACK_BODY_CANARY'), false);
    let written = '';
    assert.equal(finishDoctor(text, (chunk) => {
      written += chunk;
    }), 0);
    assert.equal(written, text);
  }

  const win = await runDoctor({
    versionProbe: () => '2.1.281',
    platform: 'win32',
    nodeVersion: 'v24.18.1',
    env: { CLAUDE_CODE_REMOTE: 'true' },
    inContainer: true,
    packs: [validPack()],
    certificationRecords: [],
    fixtureHashes: {},
    harnessRunner: healthyInstallRunner(),
  });
  const winText = formatDoctor(win);
  assert.equal(win.environmentStatus, 'reduced');
  assert.equal(win.installStatus, 'reduced');
  assertActuatorsUnsupported(win, winText, 'win32');
  assert.equal(win.actuators.find((row) => row.id === 'windows-launcher').status, 'unsupported');
  assert.equal(win.packs[0].disposition, 'advice');
  for (const claim of US36_THEN_CLAIMS) {
    assert.equal(winText.includes(claim), false, claim);
  }
  assert.equal(finishDoctor(winText, () => {}), 0);

  const node26 = await runDoctor({
    versionProbe: () => '2.1.281',
    platform: 'linux',
    nodeVersion: 'v26.5.0',
    packs: [],
    certificationRecords: [],
    fixtureHashes: {},
    harnessRunner: healthyInstallRunner(),
  });
  const node26Text = formatDoctor(node26);
  assert.equal(node26.environmentStatus, 'local');
  assertActuatorsUnsupported(node26, node26Text);

  const missing = await runDoctor({
    versionProbe: () => '2.1.281',
    platform: 'darwin',
    nodeVersion: 'v24.18.1',
    packs: [validPack({ fallbackCapabilities: [] })],
    certificationRecords: [],
    fixtureHashes: {},
    harnessRunner: async () => ({ stdout: '', code: 1, spawned: false }),
  });
  const missingText = formatDoctor(missing);
  assert.equal(missing.harnessProbe.health, 'unsupported');
  assert.equal(missing.harnessProbe.binaryPresent, false);
  assert.equal(missing.harnessProbe.versionToken, null);
  assertActuatorsUnsupported(missing, missingText);
  assert.equal(missing.packs[0].disposition, 'disabled');
  assert.equal(missingText.includes('enforced'), false);

  await assertProductHooksAbsentOrCertified();
  assertHooksUnchanged(hooksBefore, await productHooksSnapshot());
});
