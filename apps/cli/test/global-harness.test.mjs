// Installer v2 per harness (KIL-01, CDX-01, CDX-02, OPC-01, OPC-02, AGY-01..03, SKL-02):
// what each harness gets, where, pointing at the runtime copy; and that uninstall takes it
// all back. Temp homes only; no harness binary runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../dist/cli.js';
import { codexHookCommands, codexHooksJson, antigravityHooksJson, harnessExecutableEnv, pointAtRuntime, runHarnessCli, substituteShim } from '../dist/global-harness.js';
import { resolveExecutable } from '../../../packages/platform/dist/index.js';
import { jevrisPaths } from '../../../packages/platform/dist/index.js';
import { PUBLIC_COMMAND_NAMES } from '../../../packages/contracts/dist/index.js';

function hasKey(value, key) {
  if (Array.isArray(value)) return value.some((item) => hasKey(item, key));
  if (value === null || typeof value !== 'object') return false;
  return Object.keys(value).some((name) => name === key || hasKey(value[name], key));
}

/**
 * The installed hook never emits permissionDecision: run it on a PreToolUse event in a temp home
 * (no sidecar, no autostart) and check its answer at any depth. A deny-list mention in the bundle
 * is not an emitted key, so the text check looks for the key being written. The one write allowed
 * is Codex's certified route (OD-6): `allow` together with `updatedInput`, never on its own.
 */
const OD6_ROUTE_WRITE = /permissionDecision"?\s*:\s*["']allow["']\s*,\s*updatedInput\b/g;
function assertNoPermissionDecision(hookPath, harness, home, text) {
  const writes = text.replace(OD6_ROUTE_WRITE, '');
  assert.equal(/permissionDecision"?\s*:/.test(writes), false, `${hookPath} writes permissionDecision`);
  const event = { hook_event_name: 'PreToolUse', session_id: 's-1', cwd: home, tool_name: 'Bash', tool_input: { command: 'ls' } };
  const run = spawnSync(process.execPath, [hookPath, '--harness', harness], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    timeout: 20_000,
    env: { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, JEVRIS_HOME: join(home, '.jevris'), JEVRIS_SIDECAR_AUTOSTART: '0', JEVRIS_HOOK_OBSERVE_ONLY: '1' },
  });
  assert.equal(run.status, 0, `${hookPath} exit`);
  const out = run.stdout.trim();
  if (out.length > 0) assert.equal(hasKey(JSON.parse(out), 'permissionDecision'), false, out);
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function withHome(prefix, fn) {
  const home = await mkdtemp(join(tmpdir(), prefix));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function install(home, harness) {
  let text = '';
  const code = await main(['install', '--yes', '--home', home, ...(harness === undefined ? [] : ['--harness', harness])], (chunk) => (text += chunk));
  assert.equal(code, 0, text);
  return text;
}

async function uninstall(home, harness) {
  let text = '';
  const code = await main(['uninstall', '--home', home, ...(harness === undefined ? [] : ['--harness', harness])], (chunk) => (text += chunk));
  assert.equal(code, 0, text);
  return text;
}

const runtimeOf = (home) => join(jevrisPaths({ home }).data, 'runtime', '1.2.0');
const hookOf = (home) => join(runtimeOf(home), 'dist', 'hook.mjs');
const mcpOf = (home) => join(runtimeOf(home), 'plugins', 'shared', 'mcp.js');

/** SKL-02: the folder equals the frontmatter name, and outside Claude that name is jevris-<name>. */
async function assertNamespacedSkills(dir) {
  const folders = (await readdir(dir)).sort();
  assert.deepEqual(folders, PUBLIC_COMMAND_NAMES.map((name) => `jevris-${name}`).sort(), 'SKL-01: all eight skills, once each');
  for (const folder of folders) {
    assert.match(folder, /^jevris-[a-z]+$/);
    const text = await readFile(join(dir, folder, 'SKILL.md'), 'utf8');
    const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim();
    assert.equal(name, folder, `${folder} name`);
    assert.match(text, /^description:/m, `${folder} description`);
    assert.equal(/\bnpx\b/.test(text), false, `${folder} names npx`);
  }
}

test('Kilo: a runtime-bound plugin, mcp.jevris in an existing kilo.jsonc, jevris-* skills, nothing else', async () => {
  await withHome('jevris-kilo-', async (home) => {
    const configDir = join(home, '.config', 'kilo');
    await mkdir(join(configDir, 'plugin'), { recursive: true });
    const seeded = '{\n  // user comment\n  "$schema": "https://app.kilo.ai/config.json",\n  "mcp": { "other": { "type": "remote", "url": "https://example.invalid/mcp" } }\n}\n';
    await writeFile(join(configDir, 'kilo.jsonc'), seeded);
    await install(home, 'kilocode');
    const plugin = await readFile(join(configDir, 'plugin', 'jevris.js'), 'utf8');
    assert.equal(plugin.includes(`const JEVRIS_RUNTIME = ${JSON.stringify({ node: 'node', launcher: hookOf(home) })};`), true);
    assert.equal(plugin.includes('const JEVRIS_RUNTIME = null;'), false);
    assert.equal(await exists(join(configDir, 'plugin', 'package.json')), false, 'FIX-15: no package.json in the shared plugin folder');
    assert.equal(await exists(join(configDir, 'kilo.json')), false);
    const text = await readFile(join(configDir, 'kilo.jsonc'), 'utf8');
    assert.equal(text.includes('// user comment'), true);
    assert.match(text, /"other"/);
    assert.equal(text.includes(mcpOf(home).split('\\').join('\\\\')), true);
    assert.equal(text.includes('npx'), false);
    await assertNamespacedSkills(join(home, '.config', 'kilo', 'skills'));
    assert.equal(existsSync(join(home, '.kilo')), false, 'nothing in the legacy ~/.kilo folder');
    assert.equal(await exists(join(home, '.claude')), false);
    const hook = await readFile(hookOf(home), 'utf8');
    assertNoPermissionDecision(hookOf(home), 'kilo', home, hook);
    await uninstall(home, 'kilocode');
    assert.equal(await readFile(join(configDir, 'kilo.jsonc'), 'utf8'), seeded);
    assert.equal(await exists(join(configDir, 'plugin', 'jevris.js')), false);
    assert.equal(await exists(join(home, '.kilo')), false);
  });
});

test('OpenCode: one exported plugin function, a schema-stamped opencode.json, jevris-* skills', async () => {
  await withHome('jevris-opencode-', async (home) => {
    await install(home, 'opencode');
    const dir = join(home, '.config', 'opencode');
    const plugin = await readFile(join(dir, 'plugins', 'jevris.js'), 'utf8');
    assert.equal((plugin.match(/^export /gm) ?? []).length, 1);
    assert.match(plugin, /export const JevrisPlugin = server;/);
    assert.equal(plugin.includes(hookOf(home).split('\\').join('\\\\')), true);
    const config = JSON.parse(await readFile(join(dir, 'opencode.json'), 'utf8'));
    assert.equal(config.$schema, 'https://opencode.ai/config.json');
    assert.deepEqual(config.mcp.jevris, { type: 'local', command: ['node', mcpOf(home), '--harness', 'opencode'], enabled: true });
    await assertNamespacedSkills(join(dir, 'skills'));
    await uninstall(home, 'opencode');
    assert.equal(await exists(join(home, '.config')), false);
  });
});

test('Codex: a portable plugin in the personal marketplace, enabled in config.toml, absolute hook commands', async () => {
  await withHome('jevris-codex-', async (home) => {
    await mkdir(join(home, '.codex'), { recursive: true });
    const toml = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n';
    await writeFile(join(home, '.codex', 'config.toml'), toml);
    const text = await install(home, 'codex');
    const plugin = join(home, '.codex', 'plugins', 'jevris');
    assert.equal(JSON.parse(await readFile(join(plugin, 'plugin.json'), 'utf8')).name, 'jevris');
    const mcp = JSON.parse(await readFile(join(plugin, 'mcp.json'), 'utf8'));
    assert.deepEqual(mcp.mcpServers.jevris, { type: 'stdio', command: 'node', args: [mcpOf(home), '--harness', 'codex'] });
    const hooks = await readFile(join(plugin, 'hooks', 'hooks.json'), 'utf8');
    assert.equal(hooks.includes('${PLUGIN_ROOT}'), false);
    for (const group of Object.values(JSON.parse(hooks).hooks)) {
      for (const handler of group[0].hooks) {
        assert.match(handler.command, /^node '.+' --harness codex$/);
        if (process.platform === 'win32') assert.match(handler.commandWindows, /^node ".+" --harness codex$/);
        else assert.equal(Object.hasOwn(handler, 'commandWindows'), false, 'no backslash form of a POSIX path');
        assert.ok(handler.timeout > 0 && handler.timeout <= 30);
      }
    }
    await assertNamespacedSkills(join(plugin, 'skills'));
    const market = JSON.parse(await readFile(join(home, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
    assert.equal(market.name, 'jevris-local');
    const entry = market.plugins.find((item) => item.name === 'jevris');
    assert.equal(entry.source.path, './.codex/plugins/jevris');
    const after = await readFile(join(home, '.codex', 'config.toml'), 'utf8');
    assert.equal(after.startsWith(toml), true);
    assert.match(after, /\[plugins\."jevris@jevris-local"\]\nenabled = true/);
    assert.match(text, /\/hooks/, 'the next step names the /hooks trust review');
    const hook = await readFile(hookOf(home), 'utf8');
    assertNoPermissionDecision(hookOf(home), 'codex', home, hook);
    await uninstall(home, 'codex');
    assert.equal(await readFile(join(home, '.codex', 'config.toml'), 'utf8'), toml);
    assert.equal(await exists(plugin), false);
    assert.equal(await exists(join(home, '.agents')), false);
  });
});

test('Antigravity: plugin with its own MCP config and an observe hook group disabled until certified; never PreToolUse', async () => {
  await withHome('jevris-agy-', async (home) => {
    await install(home, 'antigravity');
    const plugin = join(home, '.gemini', 'config', 'plugins', 'jevris');
    assert.equal(JSON.parse(await readFile(join(plugin, 'plugin.json'), 'utf8')).name, 'jevris');
    const mcp = JSON.parse(await readFile(join(plugin, 'mcp_config.json'), 'utf8'));
    assert.deepEqual(mcp.mcpServers.jevris, { command: 'node', args: [mcpOf(home), '--harness', 'antigravity'] });
    const hooks = JSON.parse(await readFile(join(plugin, 'hooks.json'), 'utf8'));
    assert.equal(hooks['jevris-observe'].enabled, false);
    assert.equal(Object.hasOwn(hooks['jevris-observe'], 'PreToolUse'), false, 'D-F1 / AGY-03');
    assert.match(JSON.stringify(hooks), /--harness agy --event PostToolUse/);
    await assertNamespacedSkills(join(plugin, 'skills'));
    assert.equal(await exists(join(home, '.gemini', 'config', 'mcp_config.json')), false, 'no global MCP entry');
    const hook = await readFile(hookOf(home), 'utf8');
    assertNoPermissionDecision(hookOf(home), 'agy', home, hook);
    await uninstall(home, 'antigravity');
    assert.equal(await exists(join(home, '.gemini')), false);
  });
  const enabled = JSON.parse(antigravityHooksJson('/home/u/.jevris/runtime/1.2.0/dist/hook.mjs', true));
  assert.equal(enabled['jevris-observe'].enabled, true);
});

test('omitting --harness installs all five and a plain uninstall removes every harness file', async () => {
  await withHome('jevris-all-', async (home) => {
    await install(home);
    for (const path of [
      join(home, '.claude', 'plugins', 'jevris-local', 'plugins', 'jevris', 'hooks', 'hooks.json'),
      join(home, '.config', 'kilo', 'plugin', 'jevris.js'),
      join(home, '.config', 'opencode', 'plugins', 'jevris.js'),
      join(home, '.codex', 'plugins', 'jevris', 'plugin.json'),
      join(home, '.gemini', 'config', 'plugins', 'jevris', 'plugin.json'),
    ]) {
      assert.equal(await exists(path), true, path);
    }
    await uninstall(home);
    const left = (await readdir(home)).filter((name) => name !== '.jevris' && name !== '.local');
    assert.deepEqual(left, []);
  });
});

test('pure renderers: Windows hook commands, shim substitution and skill renaming', () => {
  const windows = codexHookCommands('C:\\Users\\Ann Lee\\AppData\\Local\\Jevris\\runtime\\1.2.0\\dist\\hook.mjs', ['--harness', 'codex']);
  assert.equal(windows.commandWindows, 'node "C:\\Users\\Ann Lee\\AppData\\Local\\Jevris\\runtime\\1.2.0\\dist\\hook.mjs" --harness codex');
  assert.equal(windows.command, "node 'C:/Users/Ann Lee/AppData/Local/Jevris/runtime/1.2.0/dist/hook.mjs' --harness codex");
  assert.equal(codexHookCommands("/home/o'neil/hook.mjs"), null, 'a quote in the path is refused');
  const posix = JSON.parse(codexHooksJson('/home/ann/.jevris/runtime/1.2.0/dist/hook.mjs', 'darwin'));
  const win = JSON.parse(codexHooksJson('C:\\Users\\Ann\\AppData\\Local\\Jevris\\runtime\\1.2.0\\dist\\hook.mjs', 'win32'));
  for (const groups of Object.values(posix.hooks)) {
    assert.equal(Object.hasOwn(groups[0].hooks[0], 'commandWindows'), false);
    assert.equal(JSON.stringify(groups).includes('\\\\'), false);
  }
  for (const groups of Object.values(win.hooks)) assert.match(groups[0].hooks[0].commandWindows, /^node "C:\\Users\\Ann\\.+hook\.mjs" --harness codex$/);
  assert.equal(codexHookCommands('/home/u/hook.mjs', ['--harness', 'codex; rm']), null);
  assert.equal(substituteShim('a\nconst JEVRIS_RUNTIME = null;\nb', '/r/hook.mjs'), 'a\nconst JEVRIS_RUNTIME = {"node":"node","launcher":"/r/hook.mjs"};\nb');
  assert.equal(substituteShim('no runtime line', '/r/hook.mjs'), null);
  assert.equal(substituteShim('const JEVRIS_RUNTIME = null;\nconst JEVRIS_RUNTIME = null;', '/r'), null);
  // The Claude plugin runs the runtime's own hook launcher and MCP server; no other plugin file may be named.
  const entries = { hook: 'C:\\R\\dist\\hook.mjs', mcp: '/r/plugins/shared/mcp.js' };
  assert.equal(pointAtRuntime('{"args":["${CLAUDE_PLUGIN_ROOT}/bin/hook.js","${CLAUDE_PLUGIN_ROOT}/bin/mcp.js"]}', entries), '{"args":["C:/R/dist/hook.mjs","/r/plugins/shared/mcp.js"]}');
  assert.equal(pointAtRuntime('{"args":["${CLAUDE_PLUGIN_ROOT}/bin/other.js"]}', entries), null);
});

test('AGY-06: on Windows agy is also found in %LOCALAPPDATA%\\agy\\bin; PATH comes first and nothing else changes', () => {
  const env = { Path: 'C:\\Tools', LOCALAPPDATA: 'C:\\Users\\A B\\AppData\\Local\\', PATHEXT: '.EXE;.CMD' };
  const searched = harnessExecutableEnv('agy', env, 'win32');
  assert.equal(searched.Path, 'C:\\Tools;C:\\Users\\A B\\AppData\\Local\\agy\\bin');
  const exe = 'C:\\Users\\A B\\AppData\\Local\\agy\\bin\\agy.exe';
  assert.equal(resolveExecutable('agy', { platform: 'win32', env: searched, isExecutableFile: (path) => path === exe }), exe);
  assert.equal(resolveExecutable('agy', { platform: 'win32', env, isExecutableFile: (path) => path === exe }), null, 'PATH alone misses it');
  assert.equal(harnessExecutableEnv('agy', env, 'darwin'), env);
  assert.equal(harnessExecutableEnv('codex', env, 'win32'), env);
  assert.equal(harnessExecutableEnv('agy', { Path: 'C:\\Tools' }, 'win32').Path, 'C:\\Tools');
  assert.equal(harnessExecutableEnv('agy', { LOCALAPPDATA: 'D:\\L' }, 'win32').PATH, 'D:\\L\\agy\\bin');
});

test("runHarnessCli with a working directory sets PWD to it: Kilo and OpenCode read their directory from PWD (the owner's certify run, ROOTS_OUTSIDE_CASE)", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jevris-pwd-'));
  try {
    const script = 'process.stdout.write(JSON.stringify({ pwd: process.env.PWD, cwd: process.cwd() }))';
    const ran = await runHarnessCli(process.execPath, ['-e', script], 20_000, { PATH: process.env.PATH, PWD: '/somewhere/else' }, { cwd: dir });
    assert.equal(ran.code, 0);
    const seen = JSON.parse(ran.stdout);
    assert.equal(seen.pwd, dir, 'PWD names the working directory, not the caller\'s');
    const { realpath } = await import('node:fs/promises');
    assert.equal(await realpath(seen.cwd), await realpath(dir));
    const without = await runHarnessCli(process.execPath, ['-e', script], 20_000, { PATH: process.env.PATH, PWD: '/somewhere/else' });
    assert.equal(JSON.parse(without.stdout).pwd, '/somewhere/else', 'without a working directory the environment is unchanged');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
