import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

const { main } = await import('../dist/cli.js');
const { parseJsonc } = await import('../dist/jsonc-edit.js');
const { jevrisPaths } = await import('../../../packages/platform/dist/index.js');
const { REGISTERED_EVENTS: CODEX_EVENTS } = await import('../../../packages/adapter-codex/dist/index.js');

/** The runtime copy every registration points at (ADM-03). */
function runtimeFile(home, ...parts) {
  return join(dataDir(home), 'runtime', '1.2.0', ...parts);
}

/** The Jevris data directory for this OS (~/.jevris on darwin, XDG data on linux). */
function dataDir(home) {
  return jevrisPaths({ home }).data;
}

/** Home-relative, '/'-separated data and state roots Jevris keeps until data delete. */
function dataRoots(home) {
  const paths = jevrisPaths({ home });
  const roots = [paths.data, paths.state].map((root) => relative(home, root).split('\\').join('/'));
  return [...new Set(roots)];
}

/** 'inside' for a data root or anything in it, 'ancestor' for a parent folder of one. */
function dataRelation(roots, rel) {
  if (roots.some((root) => rel === root || rel.startsWith(`${root}/`))) return 'inside';
  if (roots.some((root) => root.startsWith(`${rel}/`))) return 'ancestor';
  return 'outside';
}

const GSD_SESSION = '"/usr/local/bin/node" "/home/u/.codex/hooks/gsd-check-update.js"';
const GSD_POST = '"/usr/local/bin/node" "/home/u/.codex/hooks/gsd-context-monitor.js"';

const SEED = {
  '.codex/hooks.json': `${JSON.stringify(
    {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: GSD_SESSION }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: GSD_POST, timeout: 10 }] }],
      },
    },
    null,
    2,
  )}\n`,
  '.codex/hooks/package.json': '{"type":"commonjs"}\n',
  '.codex/hooks/gsd-check-update.js': "'use strict';\nmodule.exports = {};\n",
  '.codex/hooks/run.js': "'use strict';\n// foreign run.js\n",
  '.codex/hooks/operator-frame.js': "'use strict';\n// foreign operator frame\n",
  '.codex/hooks/vendor/lib.js': "'use strict';\n// foreign vendor\n",
  '.codex/config.toml': [
    '# user config',
    'model = "gpt-5.5"',
    '',
    '[mcp_servers.docs]',
    'command = "docs-mcp"',
    'env = { TOKEN_NAME = "DOCS" }',
    '',
    '[projects."/home/u/repo"]',
    'trust_level = "trusted"',
    '',
  ].join('\n'),
  '.config/kilo/kilo.jsonc': [
    '// my kilo settings',
    '{',
    '  "$schema": "https://app.kilo.ai/config.json",',
    '  /* servers */',
    '  "mcp": {',
    '    "other": { "type": "remote", "url": "https://example.invalid/mcp" }, // keep',
    '  },',
    '}',
    '',
  ].join('\n'),
  '.config/kilo/plugin/package.json': '{"name":"user-plugins","type":"commonjs"}\n',
  '.config/kilo/plugin/user.js': 'module.exports = {};\n',
  '.config/opencode/opencode.jsonc': [
    '{',
    '  // opencode',
    '  "model": "anthropic/claude",',
    '  "mcp": {}',
    '}',
    '',
  ].join('\n'),
  '.agents/plugins/marketplace.json': `${JSON.stringify(
    { name: 'personal', plugins: [{ name: 'gsd', source: { source: 'local', path: './gsd' } }] },
    null,
    2,
  )}\n`,
  '.gemini/config/mcp_config.json': `${JSON.stringify({ mcpServers: { other: { command: 'other-mcp' } } }, null, 4)}\n`,
  '.claude/settings.json': `${JSON.stringify({ theme: 'dark', enabledPlugins: { 'gsd@local': true } }, null, 2)}\n`,
};

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function withHome(fn) {
  const parent = await mkdtemp(join(tmpdir(), 'jevris-safety-'));
  const home = join(parent, 'home dir');
  await mkdir(home, { recursive: true });
  try {
    await fn(home);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

async function seed(home, files = SEED) {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(home, ...rel.split('/'));
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, text);
  }
}

function snapshot(home) {
  const out = {};
  const roots = dataRoots(home);
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = relative(home, full).split('\\').join('/');
      if (dataRelation(roots, rel) === 'inside') continue;
      const st = lstatSync(full);
      if (st.isDirectory()) walk(full);
      else out[rel] = sha(readFileSync(full));
    }
  };
  walk(home);
  return out;
}

async function run(args, hooks) {
  let text = '';
  const code = await main(
    args,
    (chunk) => {
      text += chunk;
    },
    hooks,
  );
  return { code, text };
}

function read(home, rel) {
  return readFileSync(join(home, ...rel.split('/')), 'utf8');
}

function jevrisHandlers(config) {
  const found = [];
  for (const [event, groups] of Object.entries(config.hooks ?? {})) {
    for (const group of groups) {
      for (const handler of group.hooks ?? []) {
        if (String(handler.command).includes('jevris')) found.push({ event, handler });
      }
    }
  }
  return found;
}

test('install then uninstall of every harness leaves a GSD-seeded home byte-identical (FIX-01, FIX-02, FIX-04, FIX-15)', async () => {
  await withHome(async (home) => {
    await seed(home);
    const before = snapshot(home);
    const installed = await run(['install', '--yes', '--home', home, '--platform', 'linux', '--enable']);
    assert.equal(installed.code, 0, installed.text);
    for (const rel of ['.codex/hooks/package.json', '.codex/hooks/run.js', '.codex/hooks/operator-frame.js', '.codex/hooks/vendor/lib.js', '.config/kilo/plugin/package.json', '.config/kilo/plugin/user.js']) {
      assert.equal(snapshot(home)[rel], before[rel], `${rel} changed on install`);
    }
    assert.deepEqual(readdirSync(join(home, '.codex', 'hooks')).sort(), ['gsd-check-update.js', 'operator-frame.js', 'package.json', 'run.js', 'vendor']);
    const kilo = read(home, '.config/kilo/kilo.jsonc');
    for (const comment of ['// my kilo settings', '/* servers */', '// keep']) assert.equal(kilo.includes(comment), true, comment);
    const kiloValue = parseJsonc(kilo);
    assert.equal(kiloValue.mcp.other.type, 'remote');
    assert.equal(kiloValue.mcp.jevris.command[1], runtimeFile(home, 'plugins', 'shared', 'mcp.js'));
    const opencode = parseJsonc(read(home, '.config/opencode/opencode.jsonc'));
    assert.equal(opencode.mcp.jevris.command[1], runtimeFile(home, 'plugins', 'shared', 'mcp.js'));
    assert.equal(read(home, '.config/opencode/opencode.jsonc').includes('// opencode'), true);
    assert.equal(existsSync(join(home, '.config', 'opencode', 'opencode.json')), false);
    assert.equal(existsSync(join(home, '.config', 'kilo', 'kilo.json')), false);
    const market = JSON.parse(read(home, '.agents/plugins/marketplace.json'));
    assert.deepEqual(market.plugins.map((plugin) => plugin.name), ['gsd', 'jevris']);
    const toml = read(home, '.codex/config.toml');
    assert.equal(toml.startsWith(SEED['.codex/config.toml']), true);
    assert.equal(toml.includes('[plugins."jevris@personal"]'), true, 'enabled in the existing marketplace');
    assert.equal(read(home, '.codex/hooks.json'), SEED['.codex/hooks.json'], 'hooks live in the plugin, not the shared hooks.json');
    assert.equal(read(home, '.gemini/config/mcp_config.json'), SEED['.gemini/config/mcp_config.json'], 'the Antigravity plugin carries its own MCP config');
    const settings = JSON.parse(read(home, '.claude/settings.json'));
    assert.equal(settings.enabledPlugins['jevris@jevris-local'], true);
    assert.equal(read(home, '.claude/settings.json').startsWith('{\n  "theme": "dark",'), true);

    const removed = await run(['uninstall', '--home', home]);
    assert.equal(removed.code, 0, removed.text);
    assert.deepEqual(snapshot(home), before);
  });
});

test('codex keeps GSD handlers and registers absolute, cwd-independent plugin hook commands with a Windows form (FIX-01, FIX-15, FIX-17)', async () => {
  await withHome(async (home) => {
    await seed(home);
    const installed = await run(['install', '--yes', '--home', home, '--harness', 'codex', '--platform', 'darwin']);
    assert.equal(installed.code, 0, installed.text);
    assert.equal(read(home, '.codex/hooks.json'), SEED['.codex/hooks.json']);
    const config = JSON.parse(read(home, '.codex/plugins/jevris/hooks/hooks.json'));
    assert.deepEqual(Object.keys(config.hooks).sort(), [...CODEX_EVENTS].sort());
    assert.equal(Object.hasOwn(config.hooks, 'PermissionRequest'), false);
    const entry = runtimeFile(home, 'dist', 'hook.mjs');
    for (const groups of Object.values(config.hooks)) {
      const handler = groups[0].hooks[0];
      assert.equal(handler.type, 'command');
      assert.equal(handler.command, `node '${entry.split('\\').join('/')}' --harness codex`);
      if (process.platform === 'win32') assert.equal(handler.commandWindows, `node "${entry.split('/').join('\\')}" --harness codex`);
      else assert.equal(Object.hasOwn(handler, 'commandWindows'), false);
      assert.ok(handler.timeout > 0 && handler.timeout <= 30);
      assert.equal(isAbsolute(/'([^']+)'/.exec(handler.command)[1]), true);
    }
    assert.equal(read(home, '.codex/hooks/package.json'), SEED['.codex/hooks/package.json']);
    const cwd = await mkdtemp(join(tmpdir(), 'jevris-anycwd-'));
    try {
      const handler = Object.values(config.hooks)[0][0].hooks[0];
      const shell = process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', handler.commandWindows]] : ['/bin/sh', ['-c', handler.command]];
      for (const stdin of ['', '{"hook_event_name":"PreToolUse","session_id":"s","turn_id":"t","tool_name":"Bash","tool_input":{"command":"ls"}}']) {
        const result = spawnSync(shell[0], shell[1], {
          cwd,
          input: stdin,
          encoding: 'utf8',
          env: { ...process.env, HOME: home, USERPROFILE: home, JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0', JEVRIS_HOOK_OBSERVE_ONLY: '1' },
          shell: false,
          windowsVerbatimArguments: process.platform === 'win32',
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(/permissionDecision"?\s*:/.test(result.stdout), false);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test('receipts record owned files with hashes and shared files only as edits (FIX-03)', async () => {
  await withHome(async (home) => {
    await seed(home);
    assert.equal((await run(['install', '--yes', '--home', home, '--platform', 'linux'])).code, 0);
    const shared = new Set(
      ['.codex/hooks.json', '.codex/config.toml', '.agents/plugins/marketplace.json', '.config/kilo/kilo.jsonc', '.config/opencode/opencode.jsonc', '.gemini/config/mcp_config.json'],
    );
    for (const name of ['codex', 'kilocode', 'opencode', 'antigravity']) {
      const receipt = JSON.parse(readFileSync(join(dataDir(home), `${name}-install-receipt.json`), 'utf8'));
      assert.equal(receipt.schemaVersion, '2.1');
      assert.equal(Object.hasOwn(receipt, 'ownedPaths'), false);
      assert.equal(receipt.files.length > 0, true);
      for (const file of receipt.files) {
        assert.match(file.sha256, /^[0-9a-f]{64}$/);
        assert.equal(isAbsolute(file.path), false, 'ADM-06: home-relative');
        assert.equal(shared.has(file.path), false, file.path);
        assert.equal(sha(readFileSync(join(home, ...file.path.split('/')))), file.sha256);
      }
      assert.equal(receipt.edits.length > 0, name !== 'antigravity');
      for (const edit of receipt.edits) {
        assert.equal(shared.has(edit.file), true, edit.file);
        assert.match(edit.preHash, /^[0-9a-f]{64}$/);
        assert.match(edit.postHash, /^[0-9a-f]{64}$/);
        assert.equal(sha(readFileSync(join(home, ...edit.file.split('/')))), edit.postHash);
        assert.equal(typeof (edit.pointer ?? edit.table), 'string');
        assert.equal(edit.created, false);
      }
    }
    const codex = JSON.parse(readFileSync(join(dataDir(home), 'codex-install-receipt.json'), 'utf8'));
    assert.equal(codex.edits.some((edit) => edit.file.endsWith('hooks.json')), false);
    const toml = codex.edits.find((edit) => edit.file.endsWith('config.toml'));
    assert.equal(toml.preHash, sha(SEED['.codex/config.toml']));
    assert.match(JSON.stringify(toml), /jevris@personal/);
  });
});

test('a user edit after install survives uninstall; only the Jevris entries go (FIX-02)', async () => {
  await withHome(async (home) => {
    await seed(home);
    assert.equal((await run(['install', '--yes', '--home', home, '--platform', 'linux'])).code, 0);
    const marketPath = join(home, '.agents', 'plugins', 'marketplace.json');
    const market = JSON.parse(read(home, '.agents/plugins/marketplace.json'));
    market.plugins.push({ name: 'later', source: { source: 'local', path: './later' } });
    await writeFile(marketPath, `${JSON.stringify(market, null, 2)}\n`);
    await writeFile(join(home, '.codex', 'config.toml'), `${read(home, '.codex/config.toml')}\n[mcp_servers.later]\ncommand = "later"\n`);
    const opencodePath = join(home, '.config', 'opencode', 'opencode.jsonc');
    await writeFile(opencodePath, read(home, '.config/opencode/opencode.jsonc').replace('"model"', '"theme": "user",\n  "model"'));
    assert.equal((await run(['uninstall', '--home', home])).code, 0);
    const left = JSON.parse(read(home, '.agents/plugins/marketplace.json'));
    assert.deepEqual(left.plugins.map((plugin) => plugin.name), ['gsd', 'later']);
    assert.equal(read(home, '.codex/hooks.json'), SEED['.codex/hooks.json']);
    const toml = read(home, '.codex/config.toml');
    assert.equal(toml.includes('jevris@personal'), false);
    assert.equal(toml.includes('[mcp_servers.later]'), true);
    assert.equal(toml.includes('[mcp_servers.docs]'), true);
    const opencode = parseJsonc(read(home, '.config/opencode/opencode.jsonc'));
    assert.equal(opencode.theme, 'user');
    assert.equal(Object.hasOwn(opencode.mcp, 'jevris'), false);
    assert.equal(read(home, '.config/opencode/opencode.jsonc').includes('// opencode'), true);
  });
});

test('a Jevris-created config is removed only while unedited; an edited one keeps the user content (FIX-02)', async () => {
  await withHome(async (home) => {
    assert.equal((await run(['install', '--yes', '--home', home, '--harness', 'opencode', '--platform', 'linux'])).code, 0);
    const created = join(home, '.config', 'opencode', 'opencode.json');
    assert.equal(existsSync(created), true);
    assert.equal((await run(['uninstall', '--home', home, '--harness', 'opencode'])).code, 0);
    assert.equal(existsSync(created), false);
    assert.equal(existsSync(join(home, '.config', 'opencode')), false);
    assert.equal((await run(['install', '--yes', '--home', home, '--harness', 'opencode', '--platform', 'linux'])).code, 0);
    const edited = JSON.parse(readFileSync(created, 'utf8'));
    edited.theme = 'mine';
    await writeFile(created, JSON.stringify(edited, null, 2));
    assert.equal((await run(['uninstall', '--home', home, '--harness', 'opencode'])).code, 0);
    assert.deepEqual(JSON.parse(readFileSync(created, 'utf8')), { $schema: 'https://opencode.ai/config.json', theme: 'mine' });
  });
});

test('a concurrent edit between read and write refuses install and uninstall and keeps the edit (FIX-03)', async () => {
  await withHome(async (home) => {
    await seed(home);
    const before = snapshot(home);
    const concurrent = '# concurrent\n[mcp_servers.docs]\ncommand = "docs-mcp"\n';
    // Every read of config.toml is followed by another writer's change, so the last read
    // before the write is always stale.
    let writes = 0;
    const refused = await run(['install', '--yes', '--home', home, '--harness', 'codex', '--platform', 'linux'], {
      afterConfigRead: async (path) => {
        writes += 1;
        if (path.endsWith('config.toml')) await writeFile(path, `${concurrent}# ${writes}\n`);
      },
    });
    assert.equal(refused.code, 1);
    assert.match(refused.text, /refused/);
    assert.equal(read(home, '.codex/config.toml').startsWith(concurrent), true);
    const after = snapshot(home);
    delete after['.codex/config.toml'];
    const expected = { ...before };
    delete expected['.codex/config.toml'];
    assert.deepEqual(after, expected);
    assert.equal(existsSync(join(dataDir(home), 'codex-install-receipt.json')), false);
    assert.equal(existsSync(join(home, '.codex', 'plugins', 'jevris')), false);
  });
  await withHome(async (home) => {
    await seed(home);
    assert.equal((await run(['install', '--yes', '--home', home, '--harness', 'codex', '--platform', 'linux'])).code, 0);
    const installed = snapshot(home);
    const mutated = `${read(home, '.codex/config.toml')}\n# concurrent\n`;
    const refused = await run(['uninstall', '--home', home, '--harness', 'codex'], {
      afterConfigRead: async (path) => {
        if (path.endsWith('config.toml')) await writeFile(path, mutated);
      },
    });
    assert.equal(refused.code, 1);
    assert.equal(read(home, '.codex/config.toml'), mutated);
    const after = snapshot(home);
    delete after['.codex/config.toml'];
    delete installed['.codex/config.toml'];
    assert.deepEqual(after, installed);
    assert.equal(existsSync(join(dataDir(home), 'codex-install-receipt.json')), true);
  });
});

test('foreign files in ~/.codex/hooks and changed owned files survive install, failed install and uninstall (FIX-16)', async () => {
  await withHome(async (home) => {
    await seed(home);
    const foreign = ['.codex/hooks/package.json', '.codex/hooks/run.js', '.codex/hooks/operator-frame.js', '.codex/hooks/vendor/lib.js'];
    const bytes = Object.fromEntries(foreign.map((rel) => [rel, read(home, rel)]));
    const conflict = join(home, '.codex', 'plugins', 'jevris', 'skills', 'jevris-status', 'SKILL.md');
    await mkdir(join(conflict, '..'), { recursive: true });
    await writeFile(conflict, 'a user skill with the same name\n');
    const before = snapshot(home);
    const failed = await run(['install', '--yes', '--home', home, '--harness', 'codex', '--platform', 'linux']);
    assert.equal(failed.code, 1);
    assert.deepEqual(snapshot(home), before);
    await rm(join(home, '.codex', 'plugins', 'jevris'), { recursive: true, force: true });
    assert.equal((await run(['install', '--yes', '--home', home, '--harness', 'codex', '--platform', 'linux'])).code, 0);
    for (const rel of foreign) assert.equal(read(home, rel), bytes[rel], rel);
    const changedOwned = join(home, '.codex', 'plugins', 'jevris', 'skills', 'jevris-status', 'SKILL.md');
    await writeFile(changedOwned, '// edited by the user\n');
    const unlisted = join(home, '.codex', 'plugins', 'jevris', 'notes.txt');
    await writeFile(unlisted, 'mine\n');
    assert.equal((await run(['uninstall', '--home', home, '--harness', 'codex'])).code, 0);
    for (const rel of foreign) assert.equal(read(home, rel), bytes[rel], rel);
    assert.equal(readFileSync(changedOwned, 'utf8'), '// edited by the user\n');
    assert.equal(readFileSync(unlisted, 'utf8'), 'mine\n');
    assert.equal(existsSync(join(home, '.codex', 'plugins', 'jevris', 'plugin.json')), false);
    assert.equal(existsSync(join(home, '.codex', 'plugins', 'jevris', 'hooks', 'hooks.json')), false);
  });
});

test('Kilo writes no package.json into the shared plugin directory (FIX-15)', async () => {
  await withHome(async (home) => {
    assert.equal((await run(['install', '--yes', '--home', home, '--harness', 'kilocode', '--platform', 'darwin'])).code, 0);
    assert.equal(existsSync(join(home, '.config', 'kilo', 'plugin', 'jevris.js')), true);
    assert.equal(existsSync(join(home, '.config', 'kilo', 'plugin', 'package.json')), false);
    assert.equal(existsSync(join(home, '.config', 'kilo', 'jevris')), false, 'the runtime lives in the data folder');
    assert.equal(existsSync(join(home, '.kilo', 'bin')), false);
  });
});

test('a legacy v1 receipt strips shared configs instead of deleting them (FIX-02, FIX-12 state)', async () => {
  await withHome(async (home) => {
    const legacyHandler = { type: 'command', command: 'node ".codex/hooks/jevris.js"', commandWindows: 'node ".codex/hooks/jevris.js"' };
    const legacyHooks = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: GSD_SESSION }] }, { hooks: [legacyHandler] }], Stop: [{ hooks: [legacyHandler] }] } };
    await seed(home, {
      '.codex/hooks.json': JSON.stringify(legacyHooks),
      '.codex/hooks/jevris.js': 'export const id = "jevris";\n',
      '.codex/hooks/package.json': '{"type":"commonjs"}\n',
      '.codex/hooks/run.js': '// could be anyone\n',
      '.codex/config.toml': '[mcp_servers.docs]\ncommand = "docs"\n\n[mcp_servers.jevris]\ncommand = "node"\nargs = ["/x/mcp.js"]\n',
      '.agents/plugins/jevris/plugin.json': '{"name":"jevris"}\n',
    });
    await mkdir(dataDir(home), { recursive: true });
    await writeFile(
      join(dataDir(home), 'codex-install-receipt.json'),
      JSON.stringify({ schemaVersion: '1.0', pluginId: 'jevris@codex', ownedPaths: [join(home, '.codex', 'hooks', 'jevris.js'), join(home, '.codex', 'hooks.json')] }),
    );
    await writeFile(
      join(dataDir(home), 'codex-interface-receipt.json'),
      JSON.stringify({ schemaVersion: '1.0', pluginId: 'jevris@codex-interface', ownedPaths: [join(home, '.agents', 'plugins', 'jevris'), join(home, '.codex', 'config.toml')] }),
    );
    assert.equal((await run(['uninstall', '--home', home, '--harness', 'codex'])).code, 0);
    const hooks = JSON.parse(read(home, '.codex/hooks.json'));
    assert.deepEqual(hooks, { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: GSD_SESSION }] }] } });
    assert.equal(existsSync(join(home, '.codex', 'hooks', 'jevris.js')), false);
    assert.equal(read(home, '.codex/hooks/package.json'), '{"type":"commonjs"}\n');
    assert.equal(read(home, '.codex/hooks/run.js'), '// could be anyone\n');
    assert.equal(read(home, '.codex/config.toml'), '[mcp_servers.docs]\ncommand = "docs"\n');
    assert.equal(existsSync(join(home, '.agents', 'plugins', 'jevris')), false);
    assert.equal(existsSync(join(dataDir(home), 'codex-install-receipt.json')), false);
    assert.equal(existsSync(join(dataDir(home), 'codex-interface-receipt.json')), false);
  });
});

test('install over a legacy Codex install cleans stale relative handlers and records the cleaned pre-state (D-02)', async () => {
  await withHome(async (home) => {
    const legacyHandler = { type: 'command', command: 'node ".codex/hooks/jevris.js"' };
    const gsdGroup = { hooks: [{ type: 'command', command: GSD_SESSION }] };
    const clean = `${JSON.stringify({ hooks: { SessionStart: [gsdGroup] } }, null, 2)}\n`;
    const legacy = `${JSON.stringify({ hooks: { SessionStart: [gsdGroup, { hooks: [legacyHandler] }] } }, null, 2)}\n`;
    await seed(home, { '.codex/hooks.json': legacy });
    assert.equal((await run(['install', '--yes', '--home', home, '--harness', 'codex', '--platform', 'linux'])).code, 0);
    const config = JSON.parse(read(home, '.codex/hooks.json'));
    assert.equal(jevrisHandlers(config).some(({ handler }) => handler.command.includes('.codex/hooks/jevris.js')), false);
    assert.equal((await run(['uninstall', '--home', home, '--harness', 'codex'])).code, 0);
    assert.equal(read(home, '.codex/hooks.json'), clean);
  });
});

function entriesOutsideData(home) {
  const out = [];
  const roots = dataRoots(home);
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = relative(home, full).split('\\').join('/');
      const relation = dataRelation(roots, rel);
      if (relation === 'inside') continue;
      if (lstatSync(full).isDirectory()) {
        // A parent of the kept data directory (for example ~/.local/share) stays with it.
        if (relation !== 'ancestor') out.push(`${rel}/`);
        walk(full);
      } else out.push(rel);
    }
  };
  walk(home);
  return out;
}

test('per-harness uninstall on an empty home removes every file and folder Jevris created, including shared parents (FIX-16)', async () => {
  await withHome(async (home) => {
    // The temp home sits under a symlinked tmp on macOS, so this also proves receipts
    // are matched on the real home path.
    assert.equal((await run(['install', '--yes', '--home', home, '--platform', 'linux', '--enable'])).code, 0);
    assert.equal(entriesOutsideData(home).includes('.config/'), true);
    assert.equal(entriesOutsideData(home).includes('.claude/plugins/jevris-local/'), true);
    for (const harness of ['kilocode', 'opencode', 'codex', 'antigravity', 'claude']) {
      assert.equal((await run(['uninstall', '--home', home, '--harness', harness])).code, 0, harness);
    }
    const left = entriesOutsideData(home);
    assert.deepEqual(left.filter((entry) => entry !== '.claude/' && entry !== '.claude/settings.json'), []);
    assert.equal(existsSync(join(dataDir(home), 'leftover-dirs.json')), false);
  });
});
