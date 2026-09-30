// Installer v2 through the CLI (ADM-01..07, CLA-01): the runtime copy, the Claude skills-dir
// plugin, the --dry-run / --yes flow, backups and restore, home-relative receipts, and the
// hook safety scan. Every test uses a temp home; no harness binary is ever started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedHostSkip } from '../../../test/managed-host.mjs';

const { main } = await import('../dist/cli.js');
const { scanHooks } = await import('../dist/hook-scan.js');
const { parseRuntimeManifest, prunedDependencyFile } = await import('../dist/runtime-install.js');
const { jevrisPaths } = await import('../../../packages/platform/dist/index.js');

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const cleanFixture = join(import.meta.dirname, '../../../fixtures/install/with spaces/jevris');
const hostileFixture = join(import.meta.dirname, '../../../fixtures/install/hostile/jevris');

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function withHome(fn) {
  const parent = await mkdtemp(join(tmpdir(), 'jevris-v2-'));
  const home = join(parent, 'home dir');
  await mkdir(home, { recursive: true });
  try {
    await fn(home, parent);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

async function run(argv, hooks) {
  let text = '';
  const code = await main(argv, (chunk) => (text += chunk), hooks);
  return { code, text };
}

const data = (home) => jevrisPaths({ home }).data;
const settingsOf = (home) => join(home, '.claude', 'settings.json');
const marketOf = (home) => join(home, '.claude', 'plugins', 'jevris-local');
const pluginOf = (home) => join(marketOf(home), 'plugins', 'jevris');

/** A package root with the repo's shipped files and an edited manifest (no dependencies). */
async function fakeRoot(parent, mutate) {
  const root = join(parent, 'package root');
  await mkdir(join(root, 'dist', 'runtime'), { recursive: true });
  for (const name of ['package.json', 'bin', 'plugins', 'assets']) await cp(join(repoRoot, name), join(root, name), { recursive: true, dereference: true });
  for (const name of ['cli.mjs', 'hook.mjs', 'sidecar.mjs', 'chunks']) {
    if (await exists(join(repoRoot, 'dist', name))) await cp(join(repoRoot, 'dist', name), join(root, 'dist', name), { recursive: true });
  }
  const manifest = JSON.parse(await readFile(join(repoRoot, 'dist', 'runtime', 'manifest.json'), 'utf8'));
  manifest.runtimeDependencies = {};
  manifest.optionalDependencies = {};
  await writeFile(join(root, 'dist', 'runtime', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (mutate !== undefined) await mutate(root);
  return root;
}

// ---------------------------------------------------------------- the hook safety scan (ADM-07)

function handler(overrides = {}) {
  return { type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/bin/hook.js', '--harness', 'claude'], timeout: 5, ...overrides };
}

async function scanDoc(doc, pluginName = 'jevris') {
  const dir = await mkdtemp(join(tmpdir(), 'jevris-scan-'));
  try {
    await mkdir(join(dir, '.claude-plugin'), { recursive: true });
    await mkdir(join(dir, 'hooks'), { recursive: true });
    await writeFile(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: pluginName }));
    await writeFile(join(dir, 'hooks', 'hooks.json'), JSON.stringify(doc));
    return (await scanHooks(dir)).accepted;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const hooksDoc = (event, h) => ({ hooks: { [event]: [{ hooks: [h] }] } });

test('the scan accepts the spaced fixture, the product plugin, Stop and SubagentStop, and a path containing sh or jq', async () => {
  assert.equal((await scanHooks(cleanFixture)).accepted, true);
  assert.equal((await scanHooks(join(repoRoot, 'plugins', 'claude'))).accepted, true);
  assert.equal(await scanDoc(hooksDoc('Stop', handler())), true);
  assert.equal(await scanDoc(hooksDoc('SubagentStop', handler())), true);
  assert.equal(await scanDoc(hooksDoc('SessionStart', handler({ args: ['/Users/shelly/jq-tools/bash-hook.mjs'] }))), true);
});

test('the scan refuses shells, inline code, prompts, long or missing timeouts, and a foreign plugin name', async () => {
  assert.equal((await scanHooks(hostileFixture)).accepted, false);
  const noTimeout = handler();
  delete noTimeout.timeout;
  for (const bad of [
    handler({ type: 'prompt' }),
    handler({ type: 'agent' }),
    handler({ timeout: 31 }),
    noTimeout,
    handler({ command: 'bash' }),
    handler({ command: '/bin/sh' }),
    handler({ command: 'jq' }),
    handler({ command: 'C:\\Windows\\System32\\cmd.exe' }),
    handler({ command: 'npx' }),
    handler({ args: ['-e', 'process.exit(0)'] }),
    handler({ args: ['hook.js', '|', 'tee'] }),
    handler({ args: ['$(whoami)'] }),
    handler({ args: ['a && b'] }),
  ]) {
    assert.equal(await scanDoc(hooksDoc('SessionStart', bad)), false, JSON.stringify(bad));
  }
  assert.equal(await scanDoc(hooksDoc('SessionStart', handler()), 'other'), false);
});

test('a symlink that leaves the plugin root is refused', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'jevris-scan-link-'));
  try {
    const source = join(parent, 'plugin');
    await cp(cleanFixture, source, { recursive: true });
    await writeFile(join(parent, 'outside.txt'), 'outside\n');
    await symlink(join(parent, 'outside.txt'), join(source, 'escape.txt'));
    assert.equal((await scanHooks(source)).accepted, false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('an install whose packaged Claude hooks fail the scan changes nothing', async () => {
  await withHome(async (home, parent) => {
    const root = await fakeRoot(parent, async (dir) => {
      await writeFile(join(dir, 'plugins', 'claude', 'hooks', 'hooks.json'), JSON.stringify(hooksDoc('SessionStart', handler({ command: 'bash' }))));
    });
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(settingsOf(home), '{"theme":"plain"}\n');
    const { code, text } = await run(['install', '--home', home, '--harness', 'claude', '--yes', '--no-smoke'], { packageRoot: root });
    assert.equal(code, 1);
    assert.match(text, /safety scan/);
    assert.equal(await readFile(settingsOf(home), 'utf8'), '{"theme":"plain"}\n');
    assert.equal(await exists(pluginOf(home)), false);
    assert.equal(await exists(join(data(home), 'runtime', '1.2.0')), false);
  });
});

// ---------------------------------------------------------------- Claude through the CLI (CLA-01)

test('install --harness claude --yes writes a local marketplace plugin under ~/.claude/plugins pointed at the runtime copy (SKL-03)', async () => {
  await withHome(async (home) => {
    await mkdir(join(home, '.claude', 'skills', 'other-plugin'), { recursive: true });
    await writeFile(join(home, '.claude', 'skills', 'other-plugin', 'keep.txt'), 'other\n');
    await writeFile(settingsOf(home), '{"theme":"plain","enabledPlugins":{"other@skills-dir":true}}\n');
    const { code, text } = await run(['install', '--home', home, '--harness', 'claude', '--yes']);
    assert.equal(code, 0, text);
    assert.equal(text.includes('\u001b'), false);
    const runtime = join(data(home), 'runtime', '1.2.0');
    assert.equal(await exists(join(runtime, '.jevris-runtime.json')), true);
    const hooks = await readFile(join(pluginOf(home), 'hooks', 'hooks.json'), 'utf8');
    const mcp = await readFile(join(pluginOf(home), '.mcp.json'), 'utf8');
    for (const text of [hooks, mcp]) {
      assert.equal(text.includes('${CLAUDE_PLUGIN_ROOT}'), false);
      assert.equal(text.includes(runtime.split('\\').join('/')), true);
      assert.equal(text.includes(repoRoot.split('\\').join('/').replace(/\/$/, '')), false);
      assert.equal(text.includes('_npx'), false);
    }
    assert.match(hooks, /--harness/);
    assert.equal(await exists(join(pluginOf(home), 'skills', 'status', 'SKILL.md')), true);
    const settings = JSON.parse(await readFile(settingsOf(home), 'utf8'));
    assert.equal(settings.theme, 'plain');
    assert.deepEqual(settings.enabledPlugins, { 'other@skills-dir': true, 'jevris@jevris-local': true });
    assert.deepEqual(settings.extraKnownMarketplaces, { 'jevris-local': { source: { source: 'directory', path: marketOf(home) } } });
    assert.equal(await exists(join(home, '.claude', 'skills', 'jevris')), false, 'nothing under ~/.claude/skills (OpenCode reads it)');
    const marketplace = JSON.parse(await readFile(join(marketOf(home), '.claude-plugin', 'marketplace.json'), 'utf8'));
    assert.deepEqual(marketplace.plugins.map((item) => [item.name, item.source, item.version]), [['jevris', './plugins/jevris', '1.2.0']]);
    assert.equal(JSON.parse(await readFile(join(pluginOf(home), '.claude-plugin', 'plugin.json'), 'utf8')).version, '1.2.0');
    assert.equal(await readFile(join(home, '.claude', 'skills', 'other-plugin', 'keep.txt'), 'utf8'), 'other\n');
    // ADM-06: the receipt holds home-relative paths only.
    const receipt = await readFile(join(data(home), 'claude-install-receipt.json'), 'utf8');
    const parsed = JSON.parse(receipt);
    assert.equal(parsed.schemaVersion, '2.1');
    assert.equal(receipt.includes(home), false);
    assert.ok(parsed.files.every((file) => !file.path.startsWith('/') && !/^[A-Za-z]:/.test(file.path)));
  });
});

test('uninstall removes only Jevris: the plugin, the enabledPlugins key, the receipt; siblings stay byte-identical', async () => {
  await withHome(async (home) => {
    await mkdir(join(home, '.claude', 'skills', 'other-plugin'), { recursive: true });
    await writeFile(join(home, '.claude', 'skills', 'other-plugin', 'keep.txt'), 'other\n');
    const seeded = '{\n  "theme": "plain"\n}\n';
    await writeFile(settingsOf(home), seeded);
    assert.equal((await run(['install', '--home', home, '--harness', 'claude', '--yes'])).code, 0);
    const removed = await run(['uninstall', '--home', home, '--harness', 'claude']);
    assert.equal(removed.code, 0, removed.text);
    assert.equal(await exists(pluginOf(home)), false);
    assert.equal(await readFile(settingsOf(home), 'utf8'), seeded);
    assert.equal(await readFile(join(home, '.claude', 'skills', 'other-plugin', 'keep.txt'), 'utf8'), 'other\n');
    assert.equal(await exists(join(data(home), 'claude-install-receipt.json')), false);
    assert.equal(await exists(join(data(home), 'runtime', '1.2.0')), false, 'no receipt uses the runtime any more');
  });
});

test('a Jevris file the user changed after install is kept by uninstall and reported', async () => {
  await withHome(async (home) => {
    assert.equal((await run(['install', '--home', home, '--harness', 'claude', '--yes'])).code, 0);
    const skill = join(pluginOf(home), 'skills', 'status', 'SKILL.md');
    await writeFile(skill, 'my notes\n');
    const removed = await run(['uninstall', '--home', home, '--harness', 'claude']);
    assert.equal(removed.code, 0, removed.text);
    assert.equal(await readFile(skill, 'utf8'), 'my notes\n');
    assert.match(removed.text, /kept/i);
  });
});

test('oversized, dangerous-key and non-object settings refuse the install and stay byte-identical', async () => {
  for (const raw of [`{${'x'.repeat(1_100_000)}`, '{"constructor":1,"unrelated":true}', '[1,2,3]', '{"a":']) {
    await withHome(async (home) => {
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(settingsOf(home), raw);
      const { code } = await run(['install', '--home', home, '--harness', 'claude', '--yes']);
      assert.equal(code, 1, raw.slice(0, 20));
      assert.equal(await readFile(settingsOf(home), 'utf8'), raw);
      assert.equal(await exists(pluginOf(home)), false);
    });
  }
});

test('a concurrent settings edit refuses the install, keeps the edit and restores every Jevris file', async () => {
  await withHome(async (home) => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(settingsOf(home), '{"theme":"plain"}\n');
    const mutated = '{"theme":"plain","concurrent":1}\n';
    let saw = false;
    const { code } = await run(['install', '--home', home, '--harness', 'claude', '--yes'], {
      afterConfigRead: async (path) => {
        if (!path.endsWith('settings.json')) return;
        saw = true;
        await writeFile(settingsOf(home), mutated);
      },
    });
    assert.equal(saw, true);
    assert.equal(code, 1);
    assert.equal(await readFile(settingsOf(home), 'utf8'), mutated);
    assert.equal(await exists(pluginOf(home)), false);
    assert.equal(await exists(join(data(home), 'claude-install-receipt.json')), false);
  });
});

// ---------------------------------------------------------------- the CLI flow (ADM-01, ADM-02)

test('--dry-run prints every planned file, changes nothing and exits 0', async () => {
  await withHome(async (home) => {
    const { code, text } = await run(['install', '--home', home, '--dry-run']);
    assert.equal(code, 0, text);
    for (const path of ['~/.claude/plugins/jevris-local/plugins/jevris/hooks/hooks.json', '~/.config/kilo/plugin/jevris.js', '~/.codex/plugins/jevris/plugin.json', '~/.config/opencode/plugins/jevris.js', '~/.gemini/config/plugins/jevris/hooks.json']) {
      assert.equal(text.includes(path), true, path);
    }
    assert.deepEqual(await readdir(home), []);
  });
});

test('without --yes a non-interactive install prints the plan, changes nothing and exits 0 (owner directive)', async () => {
  await withHome(async (home) => {
    const { code, text } = await run(['install', '--home', home, '--harness', 'kilocode'], { isTTY: false });
    assert.equal(code, 0, 'a plan printed without a terminal is not a failure');
    assert.equal(text.trimEnd().split('\n').at(-1), 'Nothing was changed: this was the plan only. Re-run with --yes to apply it.');
    assert.deepEqual(await readdir(home), []);
  });
});

test('an interactive install asks first; a no changes nothing', async () => {
  await withHome(async (home) => {
    let asked = '';
    const { code, text: declined } = await run(['install', '--home', home, '--harness', 'opencode'], {
      isTTY: true,
      confirm: async (question) => {
        asked = question;
        return false;
      },
    });
    assert.equal(code, 2);
    assert.match(asked, /Apply/);
    assert.match(declined, /Nothing was changed, so this exits 2\.\n$/);
    assert.deepEqual(await readdir(home), []);
  });
});

test('a missing home, an unknown harness and a retired gemini name exit 2 and change nothing', async () => {
  const absent = join(tmpdir(), `jevris-absent-${process.pid}-${Date.now()}`);
  assert.equal((await run(['install', '--home', absent, '--yes'])).code, 2);
  assert.equal(await exists(absent), false);
  await withHome(async (home) => {
    for (const name of ['gemini', 'nosuch']) {
      const { code, text } = await run(['install', '--home', home, '--harness', name, '--yes']);
      assert.equal(code, 2);
      assert.match(text, /unknown harness/);
    }
    assert.deepEqual(await readdir(home), []);
  });
});

test('--json prints one JSON document with the changes and the runtime', async () => {
  await withHome(async (home) => {
    const { code, text } = await run(['install', '--home', home, '--harness', 'codex', '--yes', '--json']);
    assert.equal(code, 0);
    const doc = JSON.parse(text);
    assert.equal(doc.ok, true);
    assert.equal(doc.command, 'install');
    assert.equal(doc.runtime.version, '1.2.0');
    assert.ok(doc.changes.some((change) => change.path.endsWith('.codex/plugins/jevris/plugin.json')));
  });
});

test('a failing post-install smoke restores every file and removes the new runtime (ADM-04)', async () => {
  await withHome(async (home, parent) => {
    const root = await fakeRoot(parent, async (dir) => {
      await writeFile(join(dir, 'plugins', 'shared', 'mcp.js'), 'process.exit(3);\n');
    });
    const seeded = '{\n  "mcp": {\n    "other": {"type": "local", "command": ["x"]}\n  }\n}\n';
    await mkdir(join(home, '.config', 'kilo'), { recursive: true });
    await writeFile(join(home, '.config', 'kilo', 'kilo.json'), seeded);
    const { code, text } = await run(['install', '--home', home, '--harness', 'kilocode', '--yes'], { packageRoot: root });
    assert.equal(code, 1);
    assert.match(text, /smoke/);
    assert.equal(await readFile(join(home, '.config', 'kilo', 'kilo.json'), 'utf8'), seeded);
    assert.equal(await exists(join(home, '.config', 'kilo', 'plugin', 'jevris.js')), false);
    assert.equal(await exists(join(data(home), 'runtime', '1.2.0')), false);
    assert.equal(await exists(join(data(home), 'kilocode-install-receipt.json')), false);
  });
});

test('a second install reuses the identical runtime, and backups keep at most five sets', async () => {
  await withHome(async (home) => {
    for (let i = 0; i < 7; i += 1) {
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(settingsOf(home), `{"round":${i}}\n`);
      assert.equal((await run(['install', '--home', home, '--harness', 'claude', '--yes', '--no-smoke'])).code, 0);
    }
    const sets = await readdir(join(data(home), 'backups'));
    assert.ok(sets.length <= 5, sets.join(','));
    const runtimes = (await readdir(join(data(home), 'runtime'))).filter((name) => !name.startsWith('.'));
    assert.deepEqual(runtimes, ['1.2.0']);
  });
});

test('data delete after uninstall leaves no Jevris path in the home', { skip: managedHostSkip() }, async () => {
  await withHome(async (home) => {
    assert.equal((await run(['install', '--home', home, '--yes', '--no-smoke'])).code, 0);
    assert.equal((await run(['uninstall', '--home', home, '--keep-data'])).code, 0);
    assert.equal((await run(['data', 'delete', '--home', home])).code, 0);
    const left = [];
    const walk = async (dir) => {
      for (const name of await readdir(dir)) {
        const path = join(dir, name);
        if (/jevris/i.test(name)) left.push(path);
        if ((await lstat(path)).isDirectory()) await walk(path);
      }
    };
    await walk(home);
    assert.deepEqual(left, []);
  });
});

// ---------------------------------------------------------------- runtime manifest (ADM-03)

test('the runtime manifest refuses unsafe entries, and only other-platform prebuilds are pruned', () => {
  const base = { schemaVersion: 1, name: '@webventures/jevris', version: '1.2.0', engines: {}, entries: { mcp: 'plugins/shared/mcp.js', hook: 'dist/hook.mjs', cli: 'dist/cli.mjs' }, files: ['dist/'], runtimeDependencies: {}, optionalDependencies: {} };
  assert.notEqual(parseRuntimeManifest(JSON.stringify(base)), null);
  assert.equal(parseRuntimeManifest(JSON.stringify({ ...base, entries: { ...base.entries, mcp: '../escape.js' } })), null);
  assert.equal(parseRuntimeManifest(JSON.stringify({ ...base, entries: { ...base.entries, mcp: '/abs.js' } })), null);
  assert.equal(parseRuntimeManifest(JSON.stringify({ ...base, runtimeDependencies: { 'bad name!': '1' } })), null);
  // The build's source (A d449a54) is kept only as a 40-hex commit or null with a boolean dirty flag.
  const sha = 'a'.repeat(40);
  assert.deepEqual(parseRuntimeManifest(JSON.stringify({ ...base, source: { commit: sha, dirty: false } })).source, { commit: sha, dirty: false });
  assert.deepEqual(parseRuntimeManifest(JSON.stringify({ ...base, source: { commit: null, dirty: true } })).source, { commit: null, dirty: true });
  for (const source of [{ commit: 'abc', dirty: false }, { commit: sha.toUpperCase(), dirty: false }, { commit: sha, dirty: 'no' }, { commit: sha }, 'odd']) {
    const parsed = parseRuntimeManifest(JSON.stringify({ ...base, source }));
    assert.notEqual(parsed, null, 'a malformed source never rejects the manifest');
    assert.equal(parsed.source, undefined, JSON.stringify(source));
  }
  assert.equal(parseRuntimeManifest(JSON.stringify(base)).source, undefined);
  assert.equal(prunedDependencyFile('better-sqlite3', 'deps/sqlite3.c', 'linux', 'x64'), true);
  assert.equal(prunedDependencyFile('better-sqlite3', 'prebuilds/darwin-arm64.node', 'linux', 'x64'), true);
  assert.equal(prunedDependencyFile('better-sqlite3', 'prebuilds/linux-x64.node', 'linux', 'x64'), false);
  assert.equal(prunedDependencyFile('better-sqlite3', 'prebuilds/linuxmusl-x64.node', 'linux', 'x64'), false);
  assert.equal(prunedDependencyFile('better-sqlite3', 'prebuilds/win32-x64.node', 'win32', 'x64'), false);
  assert.equal(prunedDependencyFile('better-sqlite3', 'lib/index.js', 'linux', 'x64'), false);
  assert.equal(prunedDependencyFile('other', 'deps/x.c', 'linux', 'x64'), false);
});

test('every admin command answers --help and -h with its own help and exit 0, changing nothing (ADM-01)', async () => {
  const { helpText } = await import('../dist/admin-cli.js');
  const commands = [
    [['install'], 'install'],
    [['uninstall'], 'uninstall'],
    [['doctor'], 'doctor'],
    [['certify'], 'certify'],
    [['data', 'delete'], 'data'],
  ];
  await withHome(async (home) => {
    for (const [argv, key] of commands) {
      for (const flag of ['--help', '-h']) {
        const { code, text } = await run([...argv, flag, '--home', home]);
        assert.equal(code, 0, `${argv.join(' ')} ${flag}`);
        assert.equal(text, `${helpText(key)}\n`);
        assert.match(text, /^Usage: jevris /);
        assert.match(text, /Exit codes: 0 /);
      }
    }
    assert.deepEqual(await readdir(home), [], 'help never writes');
  });
  const certify = helpText('certify');
  for (const needle of ['JEVRIS_LIVE_HARNESS=1', '--evidence <dir>', '--signing-key', '--key-id', '0 certified', '1 not certified']) assert.ok(certify.includes(needle), needle);
});

test('doctor names the scripted test worker port in text and --json while it is asked for, and null without it', async () => {
  await withHome(async (home) => {
    const saved = { script: process.env.JEVRIS_TEST_WORKER_SCRIPT };
    try {
      delete process.env.JEVRIS_TEST_WORKER_SCRIPT;
      const quiet = JSON.parse((await run(['doctor', '--home', home, '--json', '--harness', 'kilo'])).text);
      assert.equal(quiet.testWorkerPort, null);
      process.env.JEVRIS_TEST_WORKER_SCRIPT = 'relative.json';
      const loud = JSON.parse((await run(['doctor', '--home', home, '--json', '--harness', 'kilo'])).text);
      assert.match(loud.testWorkerPort, /^test worker port refused \((NOT_TEST_MODE|NO_TEST_HOME_MARKER|SCRIPT_NOT_ABSOLUTE)\): owned workers use the Agent SDK$/);
      const text = (await run(['doctor', '--home', home, '--harness', 'kilo'])).text;
      assert.equal(text.split('\n').filter((line) => line.startsWith('test worker port')).length, 1, 'the text form prints the line once');
    } finally {
      if (saved.script === undefined) delete process.env.JEVRIS_TEST_WORKER_SCRIPT;
      else process.env.JEVRIS_TEST_WORKER_SCRIPT = saved.script;
    }
  });
});

test('doctor --json carries the test provider override line, and null without one', async () => {
  await withHome(async (home) => {
    const saved = process.env.JEVRIS_TEST_PROVIDER_URL;
    try {
      delete process.env.JEVRIS_TEST_PROVIDER_URL;
      const plain = await run(['doctor', '--home', home, '--json', '--harness', 'kilo']);
      assert.equal(plain.code, 0);
      const quiet = JSON.parse(plain.text);
      assert.equal(quiet.providerOverride, null);
      assert.deepEqual(quiet.harnesses.map((row) => [row.harness, row.installed]), [['kilocode', false]]);
      process.env.JEVRIS_TEST_PROVIDER_URL = 'http://10.0.0.5:1';
      const loud = JSON.parse((await run(['doctor', '--home', home, '--json', '--harness', 'kilo'])).text);
      assert.match(loud.providerOverride, /test provider override refused \(PROVIDER_OVERRIDE_NOT_LOOPBACK\)/);
      const text = (await run(['doctor', '--home', home, '--harness', 'kilo'])).text;
      assert.equal(text.split('\n').filter((line) => line.startsWith('test provider override')).length, 1, 'the text form prints the line once');
    } finally {
      if (saved === undefined) delete process.env.JEVRIS_TEST_PROVIDER_URL;
      else process.env.JEVRIS_TEST_PROVIDER_URL = saved;
    }
  });
});

test('on POSIX no installed file names a backslash form of a real path (pack-smoke registered entries)', { skip: process.platform === 'win32' ? 'POSIX only' : false }, async () => {
  await withHome(async (home) => {
    const { code, text } = await run(['install', '--home', home, '--yes', '--no-smoke']);
    assert.equal(code, 0, text);
    const { realpath } = await import('node:fs/promises');
    const real = await realpath(home);
    const forms = [...new Set([home, real])].flatMap((path) => {
      const back = path.split('/').join('\\');
      return [back, back.split('\\').join('\\\\')];
    });
    const walk = async (dir, out) => {
      for (const name of await readdir(dir)) {
        const path = join(dir, name);
        const st = await lstat(path);
        if (st.isDirectory()) {
          if (path !== join(data(home), 'runtime')) await walk(path, out);
        } else if (st.isFile()) out.push(path);
      }
      return out;
    };
    const files = await walk(home, []);
    assert.ok(files.length > 20, 'the five harnesses wrote their files');
    for (const file of files) {
      const body = await readFile(file, 'utf8');
      for (const form of forms) assert.equal(body.includes(form), false, `${file} holds ${form}`);
    }
  });
});

test('data delete purges the kill switch files when clear, and with the switch stopped exits 2 and keeps everything (GOV-04)', { skip: managedHostSkip() }, async () => {
  const { activateKillSwitch, killSwitchDataPaths } = await import('../dist/kill-switch.js');
  const present = async (paths) => (await Promise.all(paths.map(exists))).filter(Boolean).length;
  await withHome(async (home) => {
    assert.equal((await run(['install', '--home', home, '--harness', 'kilocode', '--yes', '--no-smoke'])).code, 0);
    const stopped = await activateKillSwitch({ home, actor: 'tester', channel: 'cli', reason: 'test' });
    assert.equal(stopped.stopped, true);
    const flagged = await present(killSwitchDataPaths(home));
    assert.ok(flagged >= 1);
    const refused = await run(['data', 'delete', '--home', home, '--json']);
    assert.equal(refused.code, 2, refused.text);
    assert.equal(JSON.parse(refused.text).reasonCode, 'KILL_SWITCH_ACTIVE');
    assert.equal(await exists(data(home)), true, 'the data stays while stopped');
    assert.equal(await present(killSwitchDataPaths(home)), flagged, 'and so does the stop');
    const uninstalled = await run(['uninstall', '--home', home, '--delete-data']);
    assert.notEqual(uninstalled.code, 0);
    assert.match(uninstalled.text, /kill-switch clear/);
    assert.equal(await present(killSwitchDataPaths(home)), flagged);
  });
  await withHome(async (home) => {
    assert.equal((await run(['install', '--home', home, '--harness', 'kilocode', '--yes', '--no-smoke'])).code, 0);
    const deleted = await run(['data', 'delete', '--home', home]);
    assert.equal(deleted.code, 0, deleted.text);
    assert.equal(await exists(data(home)), false);
    assert.equal(await present(killSwitchDataPaths(home)), 0);
  });
});

test('a user edit to config.toml after install survives uninstall byte for byte: comments, neighbouring tables, key order and final newline', async () => {
  const seed = '# my codex config\nmodel = "gpt-5" # inline note\n\n[profiles.work]\n# before Jevris\nmodel = "o3"\n';
  const edits = [
    (text) => `${text}\n# user edit after install\n`,
    (text) => `${text}\n[profiles.after]\nmodel = "o4" # added after Jevris\n`,
    (text) => text.replace('# my codex config\n', '# my codex config\n# edited at the top\n'),
  ];
  for (const [index, edit] of edits.entries()) {
    await withHome(async (home) => {
      const file = join(home, '.codex', 'config.toml');
      await mkdir(join(home, '.codex'), { recursive: true });
      await writeFile(file, seed);
      assert.equal((await run(['install', '--home', home, '--harness', 'codex', '--yes', '--no-smoke'])).code, 0);
      const installed = await readFile(file, 'utf8');
      assert.ok(installed.startsWith(seed), 'install only appends');
      await writeFile(file, edit(installed));
      const removed = await run(['uninstall', '--home', home, '--harness', 'codex']);
      assert.equal(removed.code, 0, removed.text);
      assert.equal(await readFile(file, 'utf8'), edit(seed), `edit ${index}`);
    });
  }
});

test('a user edit to settings.json after install survives uninstall byte for byte', async () => {
  const seed = '{\n  // user comment\n  "theme": "dark",\n  "enabledPlugins": {\n    "other@market": true\n  }\n}\n';
  await withHome(async (home) => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(settingsOf(home), seed);
    assert.equal((await run(['install', '--home', home, '--harness', 'claude', '--yes', '--no-smoke'])).code, 0);
    const installed = await readFile(settingsOf(home), 'utf8');
    const edited = installed.replace('{\n', '{\n  "userEditAfterInstall": true,\n');
    await writeFile(settingsOf(home), edited);
    assert.equal((await run(['uninstall', '--home', home, '--harness', 'claude'])).code, 0);
    assert.equal(await readFile(settingsOf(home), 'utf8'), seed.replace('{\n', '{\n  "userEditAfterInstall": true,\n'));
  });
});

/** A Claude CLI stand-in: records calls and rewrites settings.json the way Claude does (sorted, pretty). */
function claudeStub(home) {
  const calls = [];
  const rewrite = async () => {
    const text = await readFile(settingsOf(home), 'utf8');
    const sort = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])])) : value);
    const { parseJsoncTree, nodeValue } = await import('../dist/jsonc-edit.js');
    await writeFile(settingsOf(home), `${JSON.stringify(sort(nodeValue(parseJsoncTree(text))), null, 2)}\n`);
  };
  return {
    calls,
    cli: {
      available: (file) => file === 'claude',
      run: async (file, args, _timeout, env) => {
        calls.push({ file, args: [...args], home: env?.HOME });
        if (args[0] === 'plugin' && !args.includes('--version')) await rewrite();
        return { spawned: true, code: 0, stdout: args[0] === '--version' ? '2.1.282 (Claude Code)\n' : '' };
      },
    },
  };
}

test('SKL-03: install runs claude plugin marketplace add and install with HOME set to the target home; a reformatting rewrite of settings is undone', async () => {
  await withHome(async (home) => {
    await mkdir(join(home, '.claude'), { recursive: true });
    const seed = '{\n  // mine\n  "theme": "dark",\n  "hooks": { "Stop": [] },\n  "extraKnownMarketplaces": { "team": { "source": { "source": "github", "repo": "o/r" } } },\n  "enabledPlugins": { "other@team": true }\n}\n';
    await writeFile(settingsOf(home), seed);
    const stub = claudeStub(home);
    // --no-certify: this stub stands for claude in the target home only (certify is covered in install-setup.test).
    const { code, text } = await run(['install', '--home', home, '--harness', 'claude', '--yes', '--no-smoke', '--no-certify'], { harnessCli: stub.cli });
    assert.equal(code, 0, text);
    assert.match(text, /^mode: reduced \(observe only until certified: jevris certify --harness all\)$/m, 'skipped certification says so');
    const plugin = stub.calls.filter((call) => call.args[0] === 'plugin');
    assert.deepEqual(plugin.map((call) => call.args), [
      ['plugin', 'marketplace', 'add', marketOf(home)],
      ['plugin', 'install', 'jevris@jevris-local'],
    ]);
    assert.ok(plugin.every((call) => typeof call.home === 'string' && call.home.endsWith('home dir')), 'HOME is the target home');
    const after = await readFile(settingsOf(home), 'utf8');
    assert.ok(after.includes('// mine'), 'the rewrite was undone: the user comment is back');
    const parsed = JSON.parse(after.replace('  // mine\n', ''));
    assert.deepEqual(parsed.enabledPlugins, { 'other@team': true, 'jevris@jevris-local': true });
    assert.deepEqual(Object.keys(parsed.extraKnownMarketplaces), ['team', 'jevris-local']);
    const receipt = JSON.parse(await readFile(join(data(home), 'claude-install-receipt.json'), 'utf8'));
    assert.deepEqual(receipt.cli.map((step) => step.uninstallArgs), [
      ['plugin', 'uninstall', 'jevris@jevris-local'],
      ['plugin', 'marketplace', 'remove', 'jevris-local'],
    ]);
    stub.calls.length = 0;
    const removed = await run(['uninstall', '--home', home, '--harness', 'claude'], { harnessCli: stub.cli });
    assert.equal(removed.code, 0, removed.text);
    assert.deepEqual(stub.calls.filter((call) => call.args[0] === 'plugin').map((call) => call.args.slice(0, 3)), [
      ['plugin', 'uninstall', 'jevris@jevris-local'],
      ['plugin', 'marketplace', 'remove'],
    ]);
    assert.equal(await readFile(settingsOf(home), 'utf8'), seed, 'only the Jevris keys were removed, every other byte kept');
    assert.equal(await exists(marketOf(home)), false);
  });
});

test('AGY-01: install registers the plugin with agy from a private staging copy, never from its own destination (agy refuses that), and removes the copy', async () => {
  await withHome(async (home) => {
    const plugin = join(home, '.gemini', 'config', 'plugins', 'jevris');
    const calls = [];
    const cli = {
      available: (file) => file === 'agy',
      run: async (file, args, _timeout, env) => {
        const source = args[0] === 'plugin' && args[1] === 'install' ? args[2] : null;
        // What agy 1.2.11 does: refuse its own destination, otherwise copy the source over it.
        const copied = source === null ? null : JSON.parse(await readFile(join(source, 'plugin.json'), 'utf8')).name;
        calls.push({ file, args: [...args], home: env?.HOME, copied });
        if (source === plugin) return { spawned: true, code: 1, stdout: '' };
        return { spawned: true, code: 0, stdout: '' };
      },
    };
    const { code, text } = await run(['install', '--home', home, '--harness', 'antigravity', '--yes', '--no-smoke'], { harnessCli: cli });
    assert.equal(code, 0, text);
    const install = calls.filter((call) => call.args[1] === 'install');
    assert.equal(install.length, 1, JSON.stringify(calls));
    assert.notEqual(install[0].args[2], plugin, 'agy is never asked to install its own destination');
    assert.ok(install[0].args[2].startsWith(data(home)), 'the staging copy is under the Jevris data folder');
    assert.equal(install[0].copied, 'jevris', 'the staging copy held the plugin when agy ran');
    assert.ok(typeof install[0].home === 'string' && install[0].home.endsWith('home dir'), 'HOME is the target home');
    assert.equal(await exists(install[0].args[2]), false, 'the staging copy is removed');
    assert.equal(await exists(join(data(home), 'staging')), false);
    assert.equal(await exists(join(plugin, 'plugin.json')), true);
    const receipt = JSON.parse(await readFile(join(data(home), 'antigravity-install-receipt.json'), 'utf8'));
    assert.deepEqual(receipt.cli.map((step) => step.uninstallArgs), [['plugin', 'uninstall', 'jevris']]);
  });
});
test('SKL-03 migration: a 1.2 skills-directory install (receipt 2.1) upgrades to the marketplace plugin and leaves nothing under ~/.claude/skills', async () => {
  await withHome(async (home) => {
    const { sha256 } = await import('../dist/owned-install.js');
    const old = join(home, '.claude', 'skills', 'jevris');
    const files = { '.claude-plugin/plugin.json': '{"name":"jevris","description":"Installed is not enforced."}\n', 'skills/status/SKILL.md': '---\nname: status\n---\nJevris status\n' };
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(join(old, ...rel.split('/').slice(0, -1)), { recursive: true });
      await writeFile(join(old, ...rel.split('/')), body);
    }
    await writeFile(join(home, '.claude', 'skills', 'mine.md'), 'mine\n');
    const settings = '{\n  "theme": "dark",\n  "enabledPlugins": {\n    "jevris@skills-dir": true\n  }\n}\n';
    await writeFile(settingsOf(home), settings);
    await mkdir(data(home), { recursive: true });
    const receipt = {
      schemaVersion: '2.1',
      pluginId: 'jevris@skills-dir',
      runtimeVersion: '1.2.0',
      files: Object.entries(files).map(([rel, body]) => ({ path: `.claude/skills/jevris/${rel}`, sha256: sha256(new TextEncoder().encode(body)) })),
      dirs: ['.claude/skills/jevris/skills/status', '.claude/skills/jevris/skills', '.claude/skills/jevris/.claude-plugin', '.claude/skills/jevris'],
      edits: [
        {
          file: '.claude/settings.json',
          format: 'json',
          pointer: '/enabledPlugins/jevris@skills-dir',
          strip: { kind: 'json-key', path: ['enabledPlugins', 'jevris@skills-dir'], keep: 0 },
          preHash: 'a'.repeat(64),
          postHash: 'b'.repeat(64),
          splices: [],
          created: false,
        },
      ],
    };
    await writeFile(join(data(home), 'claude-install-receipt.json'), JSON.stringify(receipt));
    const { code, text } = await run(['install', '--home', home, '--harness', 'claude', '--yes', '--no-smoke']);
    assert.equal(code, 0, text);
    assert.equal(await exists(old), false, 'the old plugin folder is gone');
    assert.equal(await readFile(join(home, '.claude', 'skills', 'mine.md'), 'utf8'), 'mine\n', 'a user file beside it stays');
    const now = JSON.parse(await readFile(settingsOf(home), 'utf8'));
    assert.deepEqual(now.enabledPlugins, { 'jevris@jevris-local': true });
    assert.equal(JSON.parse(await readFile(join(data(home), 'claude-install-receipt.json'), 'utf8')).pluginId, 'jevris@jevris-local');
  });
});

test('v1 migration: the real v1 Claude receipt shape removes only what it lists and is Jevris; the rest is kept', async () => {
  await withHome(async (home) => {
    const old = join(home, '.claude', 'skills', 'jevris');
    await mkdir(join(old, '.claude-plugin'), { recursive: true });
    await writeFile(join(old, '.claude-plugin', 'plugin.json'), '{"name":"jevris","description":"Installed is not enforced.","defaultEnabled":false}');
    await mkdir(join(home, '.claude', 'skills', 'gsd'), { recursive: true });
    await writeFile(join(home, '.claude', 'skills', 'gsd', 'SKILL.md'), 'gsd\n');
    await writeFile(settingsOf(home), '{"enabledPlugins":{"jevris@skills-dir":true,"gsd@skills-dir":true}}\n');
    await mkdir(data(home), { recursive: true });
    const outside = join(home, '..', 'outside-jevris');
    await writeFile(
      join(data(home), 'install-receipt.json'),
      JSON.stringify({ schemaVersion: '1.0', pluginId: 'jevris@skills-dir', ownedPaths: [old, join(home, '.claude', 'skills', 'gsd'), outside] }),
    );
    await writeFile(outside, 'not in the home\n');
    try {
      const { code, text } = await run(['install', '--home', home, '--harness', 'claude', '--yes', '--no-smoke']);
      assert.equal(code, 0, text);
      assert.equal(await exists(old), false);
      assert.equal(await readFile(join(home, '.claude', 'skills', 'gsd', 'SKILL.md'), 'utf8'), 'gsd\n', 'listed but not Jevris: kept');
      assert.equal(await readFile(outside, 'utf8'), 'not in the home\n', 'outside the home: never touched');
      assert.deepEqual(JSON.parse(await readFile(settingsOf(home), 'utf8')).enabledPlugins, { 'gsd@skills-dir': true, 'jevris@jevris-local': true });
      assert.equal(await exists(join(data(home), 'install-receipt.json')), false);
    } finally {
      await rm(outside, { force: true });
    }
  });
});

/** Every SKILL.md a glob `<pattern>/**\/SKILL.md` finds under a root, following symlinks like OpenCode and Kilo do. */
async function skillFiles(root, tops) {
  const found = [];
  const walk = async (dir, depth) => {
    if (depth > 16) return;
    let names;
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      let st;
      try {
        st = await (await import('node:fs/promises')).stat(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) await walk(path, depth + 1);
      else if (name === 'SKILL.md') found.push(path);
    }
  };
  for (const top of tops) await walk(join(root, top), 0);
  return found;
}

async function skillNames(files) {
  const names = [];
  for (const file of files) {
    const match = /^---\r?\n[\s\S]*?^name:\s*(.+)$/m.exec(await readFile(file, 'utf8'));
    names.push(match === null ? `(no name: ${file})` : match[1].trim());
  }
  return names;
}

test('SKL-03: with all five installed, OpenCode and Kilo each find exactly the 9 jevris-* skills, with no duplicate, through every folder they scan', async () => {
  const { SKILL_NAMES } = await import('../../../packages/contracts/dist/index.js');
  const expected = SKILL_NAMES.map((name) => `jevris-${name}`).sort();
  await withHome(async (home) => {
    const { code, text } = await run(['install', '--home', home, '--yes', '--no-smoke']);
    assert.equal(code, 0, text);
    // Both read skills/**/SKILL.md under ~/.claude and ~/.agents (no env opt-out is set).
    const external = await skillFiles(home, [join('.claude', 'skills'), join('.agents', 'skills')]);
    // OpenCode: {skill,skills}/**/SKILL.md in ~/.config/opencode (and ~/.opencode).
    const opencode = await skillFiles(home, ['skill', 'skills'].flatMap((dir) => [join('.config', 'opencode', dir), join('.opencode', dir)]));
    // Kilo: {skill,skills}/**/SKILL.md in ~/.config/kilo, ~/.kilo and ~/.kilocode.
    const kilo = await skillFiles(home, ['skill', 'skills'].flatMap((dir) => [join('.config', 'kilo', dir), join('.kilo', dir), join('.kilocode', dir)]));
    for (const [harness, files] of [['opencode', [...external, ...opencode]], ['kilo', [...external, ...kilo]]]) {
      const names = await skillNames(files);
      assert.deepEqual([...names].sort(), expected, harness);
      assert.equal(new Set(names).size, names.length, `${harness}: no duplicate skill name`);
    }
    assert.deepEqual(external, [], 'nothing Jevris under ~/.claude/skills or ~/.agents/skills');
    // Claude sees its 9 un-prefixed skills inside the marketplace plugin.
    const claude = await skillNames(await skillFiles(home, [join('.claude', 'plugins', 'jevris-local')]));
    assert.deepEqual([...claude].sort(), [...SKILL_NAMES].sort());
  });
});
