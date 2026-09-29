import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedHostSkip } from '../../../test/managed-host.mjs';


const { installPlugin } = await import('../dist/install.js');
const { scanHooks } = await import('../dist/hook-scan.js');
const { main } = await import('../dist/cli.js');
const { runDoctor } = await import('../dist/doctor.js');
const { deleteJevrisData, uninstallPlugin } = await import('../dist/uninstall.js');
const { jevrisPaths } = await import('../../../packages/platform/dist/index.js');

/** The Jevris data directory for this OS: ~/.jevris on darwin, XDG data on linux, LOCALAPPDATA on win32. */
function dataDir(home) {
  return jevrisPaths({ home }).data;
}

const cleanFixture = join(import.meta.dirname, '../../../fixtures/install/with spaces/jevris');
const hostileFixture = join(import.meta.dirname, '../../../fixtures/install/hostile/jevris');

function repoRoot() {
  return fileURLToPath(new URL('../../..', import.meta.url));
}

function destinationOf(home) {
  return resolve(home, '.claude', 'skills', 'jevris');
}

function settingsOf(home) {
  return resolve(home, '.claude', 'settings.json');
}

function receiptOf(home) {
  return join(dataDir(home), 'install-receipt.json');
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function assertSameBytes(actual, expected) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  assert.equal(left.equals(right), true);
}

async function withHome(fn) {
  const parent = await mkdtemp(join(tmpdir(), 'jevris-home-'));
  const home = join(parent, 'with spaces');
  await mkdir(home, { recursive: true });
  try {
    await fn(home);
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function seedSiblings(home) {
  const other = join(home, '.claude', 'skills', 'other-plugin', 'keep.txt');
  await mkdir(join(home, '.claude', 'skills', 'other-plugin'), { recursive: true });
  const otherBytes = new TextEncoder().encode('other-plugin-bytes\n');
  const settingsBytes = new TextEncoder().encode('{"unrelated":true}\n');
  await writeFile(other, otherBytes);
  await writeFile(settingsOf(home), settingsBytes);
  const canary = join(dataDir(home), 'canary.txt');
  await mkdir(dataDir(home), { recursive: true });
  const canaryBytes = new TextEncoder().encode('ledger-canary\n');
  await writeFile(canary, canaryBytes);
  return { other, otherBytes, settingsBytes, canary, canaryBytes };
}

async function runMain(args, afterSettingsRead) {
  let text = '';
  const code = await main(
    args,
    (chunk) => {
      text += chunk;
    },
    afterSettingsRead === undefined ? undefined : { afterSettingsRead },
  );
  return { code, text };
}

function assertPlainStatus(text, word) {
  assert.equal(text.includes(word), true);
  assert.equal(text.includes('enforced'), false);
  assert.equal(text.includes('certified'), false);
  assert.equal(text.includes('\u001b'), false);
}

function commandHandler(overrides = {}) {
  return {
    type: 'command',
    command: 'node',
    args: ['${CLAUDE_PLUGIN_ROOT}/bin/hook.js'],
    timeout: 5,
    ...overrides,
  };
}

function hooksDoc(event, handler) {
  return { hooks: { [event]: [{ hooks: [handler] }] } };
}

async function sourceFromClean(mutate) {
  const parent = await mkdtemp(join(tmpdir(), 'jevris-src-'));
  const source = join(parent, 'with spaces');
  await cp(cleanFixture, source, { recursive: true });
  if (mutate) await mutate(source);
  return { parent, source };
}

test('scanHooks accepts the spaced-path fixture and rejects the hostile fixture', async () => {
  const clean = await scanHooks(cleanFixture);
  const hostile = await scanHooks(hostileFixture);
  assert.equal(clean.accepted, true);
  assert.equal(hostile.accepted, false);
});

test('a direct installPlugin call that omits platform stays reduced', async () => {
  await withHome(async (home) => {
    const result = await installPlugin({ home, source: cleanFixture });
    assert.equal(result.installStatus, 'reduced');
    assert.equal(result.ok, true);
    assert.equal(Object.hasOwn(result, 'platform'), false);
  });
});

test('enable preserves an unrelated plugin key and sets only jevris@skills-dir', async () => {
  await withHome(async (home) => {
    await mkdir(join(home, '.claude'), { recursive: true });
    const raw = '{"theme":"plain","enabledPlugins":{"other@skills-dir":true}}\n';
    await writeFile(settingsOf(home), raw);
    const result = await installPlugin({ home, source: cleanFixture, enable: true, platform: 'linux' });
    assert.equal(result.installStatus, 'reduced');
    assert.equal(result.ok, true);
    const doc = JSON.parse(await readFile(settingsOf(home), 'utf8'));
    assert.equal(doc.theme, 'plain');
    assert.equal(doc.enabledPlugins['other@skills-dir'], true);
    assert.equal(doc.enabledPlugins['jevris@skills-dir'], true);
    assert.equal(Object.keys(doc.enabledPlugins).length, 2);
    assert.equal(Object.hasOwn(doc, 'sourceEgress'), false);
    assert.equal(Object.hasOwn(doc, 'permissions'), false);
    assert.equal(Object.hasOwn(doc, 'bypassPermissions'), false);
  });
});

test('enable does not write a settings path other than .claude/settings.json', async () => {
  await withHome(async (home) => {
    const result = await installPlugin({ home, source: cleanFixture, enable: true, platform: 'darwin' });
    assert.equal(result.ok, true);
    assert.equal(result.installStatus, 'reduced');
    const settings = settingsOf(home);
    const doc = JSON.parse(await readFile(settings, 'utf8'));
    assert.equal(doc.enabledPlugins['jevris@skills-dir'], true);
    assert.equal(await exists(join(home, '.claude', 'settings.local.json')), false);
    assert.equal(await exists(join(home, '.claude', 'settings.json.bak')), false);
    assert.equal(await exists(join(home, 'settings.json')), false);
    assert.equal(await exists(join(destinationOf(home), 'settings.json')), false);
    const names = await readdir(join(home, '.claude'));
    assert.equal(names.includes('settings.json'), true);
    assert.equal(names.some((name) => name.endsWith('.tmp') || name.endsWith('.bak')), false);
  });
});

test('a tree with plugin.json and no hooks.json copies and does not create a hooks file', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'jevris-nohook-'));
  const source = join(parent, 'with spaces');
  await mkdir(join(source, '.claude-plugin'), { recursive: true });
  await writeFile(
    join(source, '.claude-plugin', 'plugin.json'),
    await readFile(join(cleanFixture, '.claude-plugin', 'plugin.json')),
  );
  try {
    await withHome(async (home) => {
      const result = await installPlugin({ home, source });
      const destination = destinationOf(home);
      assert.equal(result.ok, true);
      assert.equal(result.installStatus, 'reduced');
      assert.equal(await exists(join(destination, '.claude-plugin', 'plugin.json')), true);
      assert.equal(await exists(join(destination, 'hooks', 'hooks.json')), false);
      assert.equal(await exists(join(destination, 'hooks.json')), false);
      assert.equal(await exists(settingsOf(home)), false);
    });
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('uninstall after install removes only the jevris skill folder and leaves siblings and .jevris', async () => {
  await withHome(async (home) => {
    const seeded = await seedSiblings(home);
    const installed = await installPlugin({ home, source: cleanFixture, platform: 'darwin' });
    assert.equal(installed.ok, true);
    const destination = destinationOf(home);
    assert.equal(await exists(destination), true);
    const result = await uninstallPlugin({ home });
    assert.equal(result.ok, true);
    assert.equal(await exists(destination), false);
    assertSameBytes(await readFile(seeded.other), seeded.otherBytes);
    const settings = JSON.parse(await readFile(settingsOf(home), 'utf8'));
    assert.equal(settings.unrelated, true);
    assert.equal(Object.hasOwn(settings, 'sourceEgress'), false);
    assert.equal(Object.hasOwn(settings, 'permissions'), false);
    assertSameBytes(await readFile(seeded.canary), seeded.canaryBytes);
    assert.equal(await exists(dataDir(home)), true);
    assert.equal(await exists(join(home, '.claude')), true);
    assert.equal(await exists(join(home, '.claude', 'skills', 'other-plugin')), true);
  });
});

test('uninstall removes only jevris@skills-dir and drops an empty enabledPlugins object', async () => {
  await withHome(async (home) => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      settingsOf(home),
      '{"theme":"plain","enabledPlugins":{"other@skills-dir":true}}\n',
    );
    const installed = await installPlugin({
      home,
      source: cleanFixture,
      enable: true,
      platform: 'darwin',
    });
    assert.equal(installed.ok, true);
    const result = await uninstallPlugin({ home });
    assert.equal(result.ok, true);
    const doc = JSON.parse(await readFile(settingsOf(home), 'utf8'));
    assert.equal(doc.theme, 'plain');
    assert.equal(doc.enabledPlugins['other@skills-dir'], true);
    assert.equal(Object.hasOwn(doc.enabledPlugins, 'jevris@skills-dir'), false);
    assert.equal(Object.hasOwn(doc, 'sourceEgress'), false);
    assert.equal(Object.hasOwn(doc, 'permissions'), false);
    assert.equal(Object.hasOwn(doc, 'bypassPermissions'), false);
    assert.equal(await exists(destinationOf(home)), false);
    assert.equal(await exists(dataDir(home)), true);
  });
  await withHome(async (home) => {
    const installed = await installPlugin({
      home,
      source: cleanFixture,
      enable: true,
      platform: 'linux',
    });
    assert.equal(installed.ok, true);
    const result = await uninstallPlugin({ home });
    assert.equal(result.ok, true);
    const doc = JSON.parse(await readFile(settingsOf(home), 'utf8'));
    assert.equal(Object.hasOwn(doc, 'enabledPlugins'), false);
    assert.equal(await exists(destinationOf(home)), false);
    assert.equal(await exists(receiptOf(home)), true);
  });
});

test('a receipt that also lists a sibling plugin path does not delete that sibling', async () => {
  await withHome(async (home) => {
    const seeded = await seedSiblings(home);
    const installed = await installPlugin({ home, source: cleanFixture, platform: 'linux' });
    assert.equal(installed.ok, true);
    const sibling = join(home, '.claude', 'skills', 'other-plugin');
    const receipt = JSON.parse(await readFile(receiptOf(home), 'utf8'));
    receipt.ownedPaths.push(sibling);
    receipt.ownedPaths.push(join(home, '.claude'));
    receipt.ownedPaths.push(dataDir(home));
    await writeFile(receiptOf(home), JSON.stringify(receipt));
    const result = await uninstallPlugin({ home });
    assert.equal(result.ok, true);
    assert.equal(await exists(destinationOf(home)), false);
    assert.equal(await exists(sibling), true);
    assertSameBytes(await readFile(seeded.other), seeded.otherBytes);
    assertSameBytes(await readFile(seeded.canary), seeded.canaryBytes);
    assert.equal(await exists(join(home, '.claude')), true);
    assert.equal(await exists(dataDir(home)), true);
  });
});

test('a skill-folder symlink named in the receipt is not removed', async () => {
  await withHome(async (home) => {
    const sibling = join(home, '.claude', 'skills', 'other-plugin');
    await mkdir(sibling, { recursive: true });
    const keep = new TextEncoder().encode('sibling-keep\n');
    await writeFile(join(sibling, 'keep.txt'), keep);
    const skill = destinationOf(home);
    await symlink(sibling, skill);
    await mkdir(dataDir(home), { recursive: true });
    await writeFile(
      receiptOf(home),
      JSON.stringify({
        schemaVersion: '1.0',
        pluginId: 'jevris@skills-dir',
        ownedPaths: [skill, sibling],
      }),
    );
    const result = await uninstallPlugin({ home });
    assert.equal(result.ok, true);
    assert.equal(await exists(skill), true);
    assertSameBytes(await readFile(join(sibling, 'keep.txt')), keep);
    assert.equal(await exists(join(home, '.claude')), true);
  });
});

test('a missing receipt deletes the skill folder only when plugin.json name is jevris', async () => {
  await withHome(async (home) => {
    const seeded = await seedSiblings(home);
    await installPlugin({ home, source: cleanFixture, platform: 'darwin' });
    await rm(receiptOf(home), { force: true });
    const result = await uninstallPlugin({ home });
    assert.equal(result.ok, true);
    assert.equal(await exists(destinationOf(home)), false);
    assertSameBytes(await readFile(seeded.other), seeded.otherBytes);
    assertSameBytes(await readFile(seeded.canary), seeded.canaryBytes);
  });
  await withHome(async (home) => {
    const seeded = await seedSiblings(home);
    await installPlugin({ home, source: cleanFixture, platform: 'darwin' });
    await rm(receiptOf(home), { force: true });
    const pluginPath = join(destinationOf(home), '.claude-plugin', 'plugin.json');
    const parsed = JSON.parse(await readFile(pluginPath, 'utf8'));
    parsed.name = 'other';
    await writeFile(pluginPath, JSON.stringify(parsed));
    const result = await uninstallPlugin({ home });
    assert.equal(result.ok, true);
    assert.equal(await exists(destinationOf(home)), true);
    assertSameBytes(await readFile(seeded.other), seeded.otherBytes);
    assert.equal(await exists(dataDir(home)), true);
  });
});

test('a second uninstall with the folder already gone leaves .jevris and the sibling plugin', async () => {
  await withHome(async (home) => {
    const seeded = await seedSiblings(home);
    await installPlugin({ home, source: cleanFixture, platform: 'linux' });
    const first = await uninstallPlugin({ home });
    assert.equal(first.ok, true);
    assert.equal(await exists(destinationOf(home)), false);
    const second = await uninstallPlugin({ home });
    assert.equal(second.ok, true);
    assertSameBytes(await readFile(seeded.other), seeded.otherBytes);
    assertSameBytes(await readFile(seeded.canary), seeded.canaryBytes);
    assert.equal(await exists(dataDir(home)), true);
    assert.equal(await exists(join(home, '.claude', 'skills', 'other-plugin')), true);
    const { code, text } = await runMain(['uninstall', '--home', home]);
    assert.equal(code, 0);
    assert.equal(text.includes('removed'), true);
    assert.equal(text.includes('enforced'), false);
    assert.equal(text.includes('\u001b'), false);
    assertSameBytes(await readFile(seeded.canary), seeded.canaryBytes);
  });
});

test('main uninstall exits 0 for owned-entry removal and does not spawn a process', async () => {
  await withHome(async (home) => {
    const seeded = await seedSiblings(home);
    await installPlugin({ home, source: cleanFixture, platform: 'darwin' });
    const { code, text } = await runMain(['uninstall', '--home', home]);
    assert.equal(code, 0);
    assert.equal(text.includes('removed'), true);
    assert.equal(text.includes('refused'), false);
    assert.equal(text.includes('enforced'), false);
    assert.equal(text.includes('certified'), false);
    assert.equal(text.includes('\u001b'), false);
    assert.equal(await exists(destinationOf(home)), false);
    assertSameBytes(await readFile(seeded.other), seeded.otherBytes);
    assertSameBytes(await readFile(seeded.canary), seeded.canaryBytes);
    assert.equal(await exists(join(home, '.claude')), true);
  });
});

test('data delete removes .jevris and does not remove .claude or a sibling skill', async () => {
  await withHome(async (home) => {
    const seeded = await seedSiblings(home);
    await installPlugin({ home, source: cleanFixture, platform: 'darwin' });
    const destination = destinationOf(home);
    assert.equal(await exists(destination), true);
    const result = await deleteJevrisData({ home });
    assert.equal(result.ok, true);
    assert.equal(await exists(dataDir(home)), false);
    assert.equal(await exists(receiptOf(home)), false);
    assert.equal(await exists(destination), true);
    assert.equal(await exists(join(home, '.claude')), true);
    assert.equal(await exists(join(home, '.claude', 'skills', 'other-plugin')), true);
    assertSameBytes(await readFile(seeded.other), seeded.otherBytes);
    const plugin = await readFile(join(destination, '.claude-plugin', 'plugin.json'));
    assert.equal(plugin.byteLength > 0, true);
  });
});

test('data delete of an absent .jevris directory deletes nothing', { skip: managedHostSkip() }, async () => {
  await withHome(async (home) => {
    const sibling = join(home, '.claude', 'skills', 'other-plugin', 'keep.txt');
    await mkdir(join(home, '.claude', 'skills', 'other-plugin'), { recursive: true });
    const bytes = new TextEncoder().encode('stay\n');
    await writeFile(sibling, bytes);
    const result = await deleteJevrisData({ home });
    assert.equal(result.ok, true);
    assert.equal(await exists(dataDir(home)), false);
    assert.equal(await exists(join(home, '.claude')), true);
    assertSameBytes(await readFile(sibling), bytes);
    const { code, text } = await runMain(['data', 'delete', '--home', home]);
    assert.equal(code, 0);
    assert.equal(text.includes('removed'), true);
    assert.equal(text.includes('enforced'), false);
    assert.equal(text.includes('certified'), false);
    assert.equal(text.includes('\u001b'), false);
    assertSameBytes(await readFile(sibling), bytes);
    assert.equal(await exists(join(home, '.claude')), true);
  });
});

test('a .jevris symlink into .claude is refused and the target remains', async () => {
  await withHome(async (home) => {
    const secret = join(home, '.claude', 'secrets', 'keep.txt');
    await mkdir(join(home, '.claude', 'secrets'), { recursive: true });
    const bytes = new TextEncoder().encode('claude-secret\n');
    await writeFile(secret, bytes);
    await mkdir(dirname(dataDir(home)), { recursive: true });
    await symlink(join(home, '.claude', 'secrets'), dataDir(home));
    const result = await deleteJevrisData({ home });
    assert.equal(result.ok, false);
    assertSameBytes(await readFile(secret), bytes);
    assert.equal(await exists(join(home, '.claude', 'secrets')), true);
    assert.equal(await exists(dataDir(home)), true);
    const { code, text } = await runMain(['data', 'delete', '--home', home]);
    assert.equal(code, 2);
    assert.equal(text.includes('refused'), true);
    assert.equal(text.includes('enforced'), false);
    assert.equal(text.includes('\u001b'), false);
    assertSameBytes(await readFile(secret), bytes);
    assert.equal(await exists(join(home, '.claude')), true);
  });
  await withHome(async (home) => {
    await mkdir(dataDir(home), { recursive: true });
    await writeFile(join(dataDir(home), 'canary.txt'), 'gone-after-real-delete');
    const removed = await deleteJevrisData({ home });
    assert.equal(removed.ok, true);
    assert.equal(await exists(dataDir(home)), false);
  });
});

test('a .jevris symlink to the home directory is refused', async () => {
  await withHome(async (home) => {
    const marker = join(home, 'home-marker.txt');
    const bytes = new TextEncoder().encode('home-marker\n');
    await writeFile(marker, bytes);
    await mkdir(dirname(dataDir(home)), { recursive: true });
    await symlink(home, dataDir(home));
    const result = await deleteJevrisData({ home });
    assert.equal(result.ok, false);
    assertSameBytes(await readFile(marker), bytes);
    assert.equal(await exists(marker), true);
    assert.equal(await exists(dataDir(home)), true);
    const { code, text } = await runMain(['data', 'delete', '--home', home]);
    assert.equal(code, 2);
    assert.equal(text.includes('refused'), true);
    assertSameBytes(await readFile(marker), bytes);
  });
  await withHome(async (home) => {
    await mkdir(dataDir(home), { recursive: true });
    await writeFile(join(dataDir(home), 'canary.txt'), 'real-root');
    const removed = await deleteJevrisData({ home });
    assert.equal(removed.ok, true);
    assert.equal(await exists(dataDir(home)), false);
  });
});

test('data delete does not follow a symlink inside .jevris into .claude', async () => {
  await withHome(async (home) => {
    const secret = join(home, '.claude', 'secrets', 'keep.txt');
    await mkdir(join(home, '.claude', 'secrets'), { recursive: true });
    const bytes = new TextEncoder().encode('keep-claude\n');
    await writeFile(secret, bytes);
    await mkdir(dataDir(home), { recursive: true });
    await symlink(join(home, '.claude', 'secrets'), join(dataDir(home), 'link'));
    await writeFile(join(dataDir(home), 'canary.txt'), 'canary');
    const result = await deleteJevrisData({ home });
    assert.equal(result.ok, true);
    assert.equal(await exists(dataDir(home)), false);
    assert.equal(await exists(join(home, '.claude')), true);
    assertSameBytes(await readFile(secret), bytes);
  });
});

test('uninstall leaves the .jevris canary until data delete and does not call it', async () => {
  await withHome(async (home) => {
    const seeded = await seedSiblings(home);
    await installPlugin({ home, source: cleanFixture, platform: 'linux' });
    const uninstalled = await uninstallPlugin({ home });
    assert.equal(uninstalled.ok, true);
    assert.equal(await exists(destinationOf(home)), false);
    assertSameBytes(await readFile(seeded.canary), seeded.canaryBytes);
    assert.equal(await exists(dataDir(home)), true);
    const deleted = await deleteJevrisData({ home });
    assert.equal(deleted.ok, true);
    assert.equal(await exists(dataDir(home)), false);
    assert.equal(await exists(seeded.canary), false);
    assert.equal(await exists(join(home, '.claude')), true);
    assert.equal(await exists(join(home, '.claude', 'skills', 'other-plugin')), true);
    assertSameBytes(await readFile(seeded.other), seeded.otherBytes);
  });
});

test('main data delete removes only the data root', { skip: managedHostSkip() }, async () => {
  await withHome(async (home) => {
    const seeded = await seedSiblings(home);
    await installPlugin({ home, source: cleanFixture, platform: 'darwin' });
    const destination = destinationOf(home);
    const { code, text } = await runMain(['data', 'delete', '--home', home]);
    assert.equal(code, 0);
    assert.equal(text.includes('removed'), true);
    assert.equal(text.includes('refused'), false);
    assert.equal(text.includes('enforced'), false);
    assert.equal(text.includes('certified'), false);
    assert.equal(text.includes('\u001b'), false);
    assert.equal(await exists(dataDir(home)), false);
    assert.equal(await exists(destination), true);
    assert.equal(await exists(join(home, '.claude')), true);
    assertSameBytes(await readFile(seeded.other), seeded.otherBytes);
    assert.equal(await exists(join(destination, '.claude-plugin', 'plugin.json')), true);
  });
});

test('product tree doctor reports unsupported actuators and does not claim a product-tree absence', async () => {
  let probeCalls = 0;
  const report = await runDoctor({
    platform: 'darwin',
    nodeVersion: '24.18.1',
    env: {},
    packs: [],
    certificationRecords: [],
    fixtureHashes: {},
    versionProbe: () => '2.1.280',
    harnessRunner: async (file, args, options) => {
      probeCalls += 1;
      assert.equal(file, 'claude');
      assert.equal(options.shell, false);
      assert.equal(Array.isArray(args), true);
      assert.equal(args.includes('hooks'), false);
      return { stdout: args[0] === '--version' ? '2.1.280\n' : '', code: 0, spawned: true };
    },
  });
  assert.equal(probeCalls, 2);
  assert.equal(report.actuators.length > 0, true);
  for (const row of report.actuators) {
    assert.equal(row.status, 'unsupported');
  }
  const root = repoRoot();
  const harness = JSON.parse(await readFile(join(root, 'fixtures', 'gates', 'harness.json'), 'utf8'));
  assert.equal(harness.gate, 'harness');
  if (harness.verdict === 'pass') {
    const probed = JSON.parse(await readFile(join(root, 'fixtures', 'evidence', 'harness-probe.json'), 'utf8'));
    assert.equal(probed.eventProbe, 'passed');
    assert.equal(probed.actuators, 'unsupported');
    assert.equal(probed.applied, false);
  } else {
    assert.equal(harness.verdict, 'not-a-pass');
  }
  const mcp = JSON.parse(await readFile(join(root, 'plugins', 'claude', '.mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers.jevris.command, 'node');
  assert.deepEqual(mcp.mcpServers.jevris.args, ['${CLAUDE_PLUGIN_ROOT}/bin/mcp.js', '--harness', 'claude']);
  assert.equal(JSON.stringify(mcp).includes('npx'), false);
  assert.equal(JSON.stringify(mcp).includes('apiKey'), false);
});
