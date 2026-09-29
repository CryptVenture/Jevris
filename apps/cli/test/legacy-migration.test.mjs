// ADM-06, SKL-03: upgrading a real v1.x home. fixtures/legacy-v1 is a copy of a developer
// machine's v1 install: the eight v1 receipts and every file they list, byte for byte (the
// home path replaced by @HOME@), the real ~/.codex/hooks.json the v1 Codex receipt claims
// (GSD hooks only), and the Jevris entries v1 wrote into shared configs, set in stand-in user
// content. The migration runs on a temp copy; it never touches a real home.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const { main } = await import('../dist/cli.js');
const { parseJsoncTree, nodeValue } = await import('../dist/jsonc-edit.js');
const { jevrisPaths } = await import('../../../packages/platform/dist/index.js');

const fixture = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'legacy-v1');
const manifest = JSON.parse(await readFile(join(fixture, 'manifest.json'), 'utf8'));

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function run(argv) {
  let text = '';
  const code = await main(argv, (chunk) => (text += chunk));
  return { code, text };
}

const jsonc = (text) => nodeValue(parseJsoncTree(text));

/** Copies the fixture into a fresh temp home, rebasing @HOME@. */
async function materialize() {
  const parent = await mkdtemp(join(tmpdir(), 'jevris-legacy-'));
  const home = join(parent, 'home');
  // Every @HOME@ sits inside a JSON, JSONC or TOML basic string, where a Windows home's
  // backslashes are written escaped, as v1 wrote them there (the same on POSIX: nothing to escape).
  const inString = JSON.stringify(home).slice(1, -1);
  for (const rel of manifest.files) {
    const bytes = await readFile(join(fixture, 'home', rel));
    const target = join(home, ...rel.split('/'));
    await mkdir(dirname(target), { recursive: true });
    const text = bytes.toString('utf8');
    await writeFile(target, text.includes(manifest.token) ? text.split(manifest.token).join(inString) : bytes);
  }
  return { parent, home };
}

function v1Owned(home) {
  const out = [];
  for (const rel of manifest.files.filter((item) => item.startsWith('.jevris/') && item.endsWith('receipt.json'))) out.push(rel);
  return out.map((rel) => join(home, rel));
}

test('a copied real v1 home upgrades: v1 files and receipts go, user files and hooks stay byte for byte, shared configs lose only Jevris entries', async () => {
  const { parent, home } = await materialize();
  try {
    const receipts = v1Owned(home);
    assert.equal(receipts.length, 8, 'the fixture holds the eight v1 receipts');
    const owned = [];
    for (const receipt of receipts) owned.push(...JSON.parse(await readFile(receipt, 'utf8')).ownedPaths);
    const keep = ['.codex/hooks.json', '.codex/hooks/gsd-check-update.js', '.kilo/skills/gsd-help/SKILL.md', '.config/opencode/skills/gsd-help/SKILL.md', '.claude/skills/gsd-help/SKILL.md'];
    const before = Object.fromEntries(await Promise.all(keep.map(async (rel) => [rel, await readFile(join(home, rel), 'utf8')])));
    assert.equal(/hooks[\\/]jevris\.js|--harness/.test(before['.codex/hooks.json']), false, 'the real hooks.json v1 listed has no Jevris entry');

    const v1Bytes = new Map();
    for (const path of owned) if (!path.endsWith('hooks.json') && (await exists(path)) && !(await lstat(path)).isDirectory()) v1Bytes.set(path, await readFile(path, 'utf8'));
    const { code, text } = await run(['install', '--home', home, '--yes', '--no-smoke']);
    assert.equal(code, 0, text);

    // v2 writes its own Kilo and OpenCode plugin file at the v1 path; the v1 bytes are gone.
    const rewritten = new Set([join(home, '.config', 'kilo', 'plugin', 'jevris.js'), join(home, '.config', 'opencode', 'plugins', 'jevris.js')]);
    for (const path of owned) {
      if (path.endsWith('hooks.json')) continue;
      if (rewritten.has(path)) {
        assert.equal(await readFile(path, 'utf8') === v1Bytes.get(path), false, `v1 plugin replaced: ${path}`);
        continue;
      }
      assert.equal(await exists(path), false, `v1 path removed: ${path}`);
    }
    for (const rel of keep) assert.equal(await readFile(join(home, rel), 'utf8'), before[rel], `kept byte for byte: ${rel}`);
    const data = jevrisPaths({ home }).data;
    const left = (await readdir(data)).filter((name) => name.endsWith('install-receipt.json')).sort();
    assert.deepEqual(left, ['antigravity-install-receipt.json', 'claude-install-receipt.json', 'codex-install-receipt.json', 'kilocode-install-receipt.json', 'opencode-install-receipt.json']);
    for (const name of left) assert.equal(JSON.parse(await readFile(join(data, name), 'utf8')).schemaVersion, '2.1');

    const kilo = jsonc(await readFile(join(home, '.config', 'kilo', 'kilo.jsonc'), 'utf8'));
    assert.equal(kilo.model, 'user/model');
    assert.match(kilo.mcp.jevris.command[1], /runtime[\\/]1\.2\.0[\\/].*mcp\.m?js$/, 'the MCP entry now points at the runtime copy');
    const opencode = jsonc(await readFile(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
    assert.deepEqual(opencode.mcp['user-server'], { type: 'local', command: ['user-server'] });
    assert.match(opencode.mcp.jevris.command[1], /runtime/);
    const gemini = JSON.parse(await readFile(join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8'));
    assert.deepEqual(Object.keys(gemini.mcpServers), ['user-server'], 'the plugin carries its own MCP config');
    const toml = await readFile(join(home, '.codex', 'config.toml'), 'utf8');
    assert.equal(toml.includes('[mcp_servers.jevris]'), false);
    assert.ok(toml.startsWith('# user codex config\nmodel = "gpt-5"\n\n[profiles.work]\nmodel = "o3"\n'));
    const settings = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(settings.enabledPlugins, { 'gsd@skills-dir': true, 'jevris@jevris-local': true });
    assert.equal(await exists(join(home, '.claude', 'skills', 'jevris')), false);
    for (const dir of [join(home, '.kilo', 'skills'), join(home, '.config', 'opencode', 'skills')]) {
      const names = (await readdir(dir)).sort();
      assert.equal(names.includes('status'), false, `${dir}: the un-prefixed v1 skills are gone`);
      assert.ok(names.includes('gsd-help'));
    }

    const removed = await run(['uninstall', '--home', home]);
    assert.equal(removed.code, 0, removed.text);
    for (const rel of keep) assert.equal(await readFile(join(home, rel), 'utf8'), before[rel], `still kept after uninstall: ${rel}`);
    const finalKilo = jsonc(await readFile(join(home, '.config', 'kilo', 'kilo.jsonc'), 'utf8'));
    assert.deepEqual(finalKilo, { $schema: 'https://kilo.ai/config.json', model: 'user/model' });
    const finalOpencode = jsonc(await readFile(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
    assert.deepEqual(Object.keys(finalOpencode.mcp), ['user-server']);
    assert.deepEqual(JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8')).enabledPlugins, { 'gsd@skills-dir': true });
    assert.equal((await readFile(join(home, '.codex', 'config.toml'), 'utf8')).trimEnd(), '# user codex config\nmodel = "gpt-5"\n\n[profiles.work]\nmodel = "o3"');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('the migration dry run lists every v1 removal and changes nothing', async () => {
  const { parent, home } = await materialize();
  try {
    const snapshot = async () => {
      const out = [];
      const walk = async (dir) => {
        for (const name of await readdir(dir)) {
          const path = join(dir, name);
          if ((await lstat(path)).isDirectory()) await walk(path);
          else out.push([path, await readFile(path, 'utf8')]);
        }
      };
      await walk(home);
      return out.sort();
    };
    const before = await snapshot();
    const { code, text } = await run(['install', '--home', home, '--dry-run']);
    assert.equal(code, 0, text);
    assert.match(text, /old Jevris (file|folder)/);
    assert.match(text, /\.kilo\/skills\/status/);
    // Two old receipts (install and interface), or an old receipt and the unlisted v1 paths,
    // name the same folder: the plan lists it once, with the first reason.
    const steps = text.split('\n').filter((line) => /^\s+(delete|keep|strip|edit|create|replace)\s/.test(line));
    assert.deepEqual(steps.filter((line, i) => steps.indexOf(line) !== i), [], 'no step is listed twice');
    for (const path of ['~/.claude/skills/jevris', '~/.codex/hooks/jevris.js', '~/.agents/plugins/jevris', '~/.gemini/antigravity-cli/plugins/jevris']) {
      assert.equal(steps.filter((line) => line.includes(`delete      ${path}  (`)).length, 1, path);
    }
    assert.deepEqual(await snapshot(), before);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
