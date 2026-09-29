// DRY plugin rule, KIL-01, OPC-01, CDX-01, AGY-01, SKL-03: every supported harness keeps its
// own folder plugins/<harness>/ with a valid harness.json, the manifest agrees with the
// harness's adapter (hooks, events, certifiable features), and installing from it into a temp
// HOME renders that harness's complete tree from the shared sources: skills, plugin, MCP entry
// and hooks. Temp homes only; no harness binary runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { main } = await import('../dist/cli.js');
const { GLOBAL_HARNESSES } = await import('../dist/global-harness.js');
const { parseHarnessManifest, mcpEntry } = await import('../dist/harness-manifest.js');
const { adapterCapabilities } = await import('../dist/conformance-run.js');
const { parseJsoncTree, nodeValue } = await import('../dist/jsonc-edit.js');
const { PUBLIC_COMMAND_NAMES } = await import('../../../packages/contracts/dist/index.js');
const claudeAdapter = await import('@jevris/adapter-claude-code');
const codexAdapter = await import('@jevris/adapter-codex');
const agyAdapter = await import('@jevris/adapter-antigravity');
const kiloAdapter = await import('@jevris/adapter-kilocode');
const opencodeAdapter = await import('@jevris/adapter-opencode');

const root = fileURLToPath(new URL('../../..', import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const manifestPath = (harness) => join(root, 'plugins', harness, 'harness.json');

async function manifestOf(harness) {
  const parsed = parseHarnessManifest(await readFile(manifestPath(harness), 'utf8'), harness);
  assert.equal(parsed.problem, null, `${harness}: ${parsed.problem}`);
  return parsed.manifest;
}

/** A manifest path with the default $CONFIG and $CODEX_HOME, under `home`. */
function place(home, path) {
  const [head, ...rest] = path.split('/');
  const base = head === '$CONFIG' ? '.config' : head === '$CODEX_HOME' ? '.codex' : head;
  return join(home, base, ...rest);
}

const HOOKS = {
  claude: Object.keys(claudeAdapter.CLAUDE_EVENTS),
  codex: [...codexAdapter.REGISTERED_EVENTS],
  antigravity: [...agyAdapter.REGISTERED_EVENTS],
  kilocode: [...kiloAdapter.HOOK_KEYS],
  opencode: [...opencodeAdapter.HOOK_KEYS],
};
const PLUGIN_ADAPTERS = { kilocode: kiloAdapter, opencode: opencodeAdapter };

test('every supported harness has its own plugins/<harness>/harness.json, and nothing else claims to be one', async () => {
  assert.deepEqual([...GLOBAL_HARNESSES].sort(), ['antigravity', 'claude', 'codex', 'kilocode', 'opencode']);
  for (const harness of GLOBAL_HARNESSES) assert.ok(existsSync(manifestPath(harness)), `plugins/${harness}/harness.json is missing`);
  const folders = (await readdir(join(root, 'plugins'), { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name !== 'shared').map((entry) => entry.name);
  assert.deepEqual(folders.sort(), [...GLOBAL_HARNESSES].sort(), 'one folder per harness, plus plugins/shared');
});

test('each manifest agrees with its adapter: hooks, bus events and certifiable features', async () => {
  for (const harness of GLOBAL_HARNESSES) {
    const manifest = await manifestOf(harness);
    assert.deepEqual(manifest.hooks, HOOKS[harness], `${harness}: hooks are the adapter's registered set`);
    const capable = adapterCapabilities(harness);
    const features = ['plugin.install', 'mcp.tools', 'skills.discovery', 'hooks.observe', ...(capable.context ? ['hooks.context'] : []), ...(capable.route ? ['hooks.route'] : []), 'worker.route', 'models.list', ...(capable.session ? ['session.route', 'models.list-hosts', 'route.host'] : []), ...(harness === 'antigravity' ? [] : ['access.detect']), ...(harness === 'antigravity' || harness === 'codex' ? [] : ['access.session']), ...(harness === 'codex' ? ['access.usage-read'] : [])];
    assert.deepEqual(manifest.features, features, `${harness}: features are what certify can prove`);
    assert.ok(Object.keys(manifest.unsupported).length > 0, `${harness}: the parity row names what is unsupported`);
    const adapter = PLUGIN_ADAPTERS[harness];
    if (adapter === undefined) continue;
    for (const type of manifest.events) {
      const info = { id: 'msg_1', sessionID: 'ses_1', role: 'assistant', time: { created: 1, completed: 2 }, providerID: 'p', modelID: 'm', tokens: { input: 1, output: 1 } };
      const result = adapter.normalize({ hookKey: 'event', event: { type, properties: { sessionID: 'ses_1', info } } });
      assert.equal(result.ok, true, `${harness}: bus event ${type} is forwarded (${JSON.stringify(result).slice(0, 120)})`);
    }
    for (const fixture of adapter.FIXTURES) {
      const type = fixture.native?.event?.type;
      if (typeof type === 'string' && fixture.kind !== null) assert.ok(manifest.events.includes(type), `${harness}: the manifest lists ${type}`);
    }
    assert.equal(adapter.normalize({ hookKey: 'event', event: { type: 'message.part.updated', properties: {} } }).ok, false, 'noise is not forwarded');
  }
});

const ADAPTERS = { claude: claudeAdapter, codex: codexAdapter, antigravity: agyAdapter, kilocode: kiloAdapter, opencode: opencodeAdapter };

test('each parity row states the subagent facts: Jevris makes no permission decision there, and only a harness with a stop gate holds the parent\'s Stop', async () => {
  for (const harness of GLOBAL_HARNESSES) {
    const reason = (await manifestOf(harness)).unsupported.subagents;
    assert.equal(typeof reason, 'string', `${harness}: the parity row has a subagents entry`);
    assert.match(reason, /^Jevris makes no permission decision in a subagent, so .+ governs? it/, `${harness}: the native permissions are the control`);
    if (typeof ADAPTERS[harness].stopContinuationResponse === 'function') {
      assert.match(reason, /the verification gate holds only the parent's Stop, never SubagentStop/, `${harness}: the gate answers only the parent's Stop`);
    } else {
      assert.match(reason, /no [A-Za-z]+ stop is held/, `${harness}: this harness has no stop gate`);
    }
  }
});

test('the manifest parser refuses a wrong harness, a path that leaves the home, and a shim manifest without its MCP entry', async () => {
  const kilo = JSON.parse(await readFile(manifestPath('kilocode'), 'utf8'));
  const check = (value, harness = 'kilocode') => parseHarnessManifest(JSON.stringify(value), harness).problem;
  assert.equal(check(kilo), null);
  assert.equal(check(kilo, 'opencode'), 'harness is not opencode');
  assert.equal(check({ ...kilo, plugin: { ...kilo.plugin, path: '../outside/jevris.js' } }), 'plugin.path');
  assert.equal(check({ ...kilo, plugin: { ...kilo.plugin, path: '/abs/jevris.js' } }), 'plugin.path');
  assert.equal(check({ ...kilo, skills: { ...kilo.skills, dir: '$HOME/x' } }), 'skills');
  const { mcp: _mcp, ...noMcp } = kilo;
  assert.equal(check(noMcp), 'mcp');
  assert.equal(check({ ...kilo, mcp: { ...kilo.mcp, entry: { command: ['node', 'fixed.js'] } } }), 'mcp.entry names no $MCP');
  assert.equal(check({ ...kilo, plugin: { ...kilo.plugin, export: 'both' } }), 'plugin.export');
  assert.equal(check({ ...kilo, unsupported: { statusLine: '' } }), 'unsupported');
  assert.equal(parseHarnessManifest('not json', 'kilocode').problem, 'not JSON');
  assert.deepEqual(mcpEntry({ command: ['node', '$MCP'], n: 1 }, '/r/mcp.js'), { command: ['node', '/r/mcp.js'], n: 1 });
});

async function run(argv) {
  let text = '';
  const code = await main(argv, (chunk) => (text += chunk));
  return { code, text };
}

const jsonc = async (path) => nodeValue(parseJsoncTree(await readFile(path, 'utf8')));

test('installing each harness from its manifest renders its complete tree: skills, plugin, MCP entry and hooks', async () => {
  for (const harness of GLOBAL_HARNESSES) {
    const home = await mkdtemp(join(tmpdir(), `jevris-manifest-${harness}-`));
    try {
      const manifest = await manifestOf(harness);
      const { code, text } = await run(['install', '--harness', manifest.launcher, '--home', home, '--yes', '--no-smoke']);
      assert.equal(code, 0, `${harness}: ${text}`);
      // Skills: all eight, rendered with the manifest's profile.
      const skills = place(home, manifest.skills.dir);
      const folders = (await readdir(skills)).sort();
      assert.deepEqual(folders, PUBLIC_COMMAND_NAMES.map((name) => `${manifest.skills.namespace}${name}`).sort(), `${harness}: eight skills`);
      const status = await readFile(join(skills, `${manifest.skills.namespace}status`, 'SKILL.md'), 'utf8');
      assert.match(status, new RegExp(`^---\\nname: ${manifest.skills.namespace}status\\n`));
      assert.equal(status.includes('allowed-tools:'), manifest.skills.allowedToolsPrefix !== null, `${harness}: allowed-tools only where the harness reads it`);
      // Plugin, MCP entry and hooks.
      const plugin = place(home, manifest.plugin.path);
      assert.ok(existsSync(plugin), `${harness}: plugin at ${manifest.plugin.path}`);
      let mcpArgs;
      let hookNames;
      if (harness === 'kilocode' || harness === 'opencode') {
        const shim = await readFile(plugin, 'utf8');
        assert.ok(shim.includes(`const HARNESS_ID = '${harness}';`) && shim.includes(`const LAUNCHER_NAME = '${manifest.launcher}';`), `${harness}: shim rendered with the manifest values`);
        assert.equal(shim.includes('@JEVRIS_'), false);
        assert.equal(shim.includes('const JEVRIS_RUNTIME = null;'), false, `${harness}: bound to the runtime`);
        const dir = place(home, manifest.mcp.dir);
        const config = await jsonc(existsSync(join(dir, `${manifest.mcp.file}.jsonc`)) ? join(dir, `${manifest.mcp.file}.jsonc`) : join(dir, `${manifest.mcp.file}.json`));
        let server = config;
        for (const key of manifest.mcp.key) server = server[key];
        mcpArgs = server.command;
        assert.equal(config.$schema, manifest.mcp.schema ?? undefined, `${harness}: $schema only when the manifest names one`);
        hookNames = manifest.hooks.filter((key) => shim.includes(`'${key}'`));
      } else if (harness === 'claude') {
        const pluginJson = JSON.parse(await readFile(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8'));
        assert.deepEqual([pluginJson.name, pluginJson.version, pluginJson.author, pluginJson.license, typeof pluginJson.homepage], ['jevris', pkg.version, { name: pkg.author }, pkg.license, 'string'], 'CLA-01: version, author, license and homepage from package.json');
        mcpArgs = JSON.parse(await readFile(join(plugin, '.mcp.json'), 'utf8')).mcpServers.jevris.args;
        const hooks = JSON.parse(await readFile(join(plugin, 'hooks', 'hooks.json'), 'utf8')).hooks;
        hookNames = Object.keys(hooks);
        assert.match(JSON.stringify(hooks), /runtime\/[^"]+\/dist\/hook\.mjs/, 'claude: hooks run the runtime hook launcher');
      } else if (harness === 'codex') {
        const pluginJson = JSON.parse(await readFile(join(plugin, 'plugin.json'), 'utf8'));
        assert.deepEqual([pluginJson.$schema, pluginJson.version, pluginJson.author], ['https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', pkg.version, { name: pkg.author }], 'CDX-01: agent-plugins schema, version and author');
        mcpArgs = JSON.parse(await readFile(join(plugin, 'mcp.json'), 'utf8')).mcpServers.jevris.args;
        hookNames = Object.keys(JSON.parse(await readFile(join(plugin, 'hooks', 'hooks.json'), 'utf8')).hooks);
      } else {
        mcpArgs = JSON.parse(await readFile(join(plugin, 'mcp_config.json'), 'utf8')).mcpServers.jevris.args;
        hookNames = Object.keys(JSON.parse(await readFile(join(plugin, 'hooks.json'), 'utf8'))['jevris-observe']).filter((key) => key !== 'enabled');
      }
      assert.deepEqual(mcpArgs.slice(-2), ['--harness', harness], `${harness}: the MCP server is told which harness it serves`);
      assert.match(mcpArgs[mcpArgs.length - 3].split('\\').join('/'), /runtime\/[^/]+\/plugins\/shared\/mcp\.js$/, `${harness}: the one shared MCP server`);
      assert.deepEqual(hookNames, manifest.hooks, `${harness}: every manifest hook is registered`);
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
});

test('ADM-05: doctor runs the MCP handshake and the hook fixture through each installed harness command, and says when nothing is installed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jevris-doctor-smoke-'));
  try {
    const before = await run(['doctor', '--home', home, '--harness', 'kilo', '--json']);
    assert.deepEqual(JSON.parse(before.text).harnesses[0].smoke, [], 'nothing installed, nothing run');
    assert.equal((await run(['install', '--harness', 'kilo', '--home', home, '--yes', '--no-smoke'])).code, 0);
    const { code, text } = await run(['doctor', '--home', home, '--harness', 'kilo']);
    assert.equal(code, 0);
    assert.match(text, /^harness kilocode mcp handshake: ok \(/m);
    assert.match(text, /^harness kilocode hook fixture: ok \(/m);
    const row = JSON.parse((await run(['doctor', '--home', home, '--harness', 'kilo', '--json'])).text).harnesses[0];
    assert.deepEqual(row.smoke.map((item) => [item.harness, item.check, item.ok]), [['kilocode', 'mcp', true], ['kilocode', 'hook', true]]);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
