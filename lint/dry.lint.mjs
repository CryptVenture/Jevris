import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS_MANIFESTS, NATIVE_MANIFESTS, PLUGIN_FILES, duplicatePlugins, harnessManifestProblem, isAllowedPluginPath, manifestProblem } from '../scripts/release-policy.mjs';

/**
 * DRY plugin rule. Git keeps one shared plugin source (plugins/shared) plus each harness's own
 * manifests. Every other plugin file is generated at install into the target home, so a tracked
 * generated artifact, a rendered tree in dist/plugins, or two files under plugins/ that repeat
 * each other all fail here.
 */

const root = fileURLToPath(new URL('..', import.meta.url));

// In a git checkout the check reads what git tracks; in an exported tree (a CI cell tarball or
// a source archive) there is no .git, so it reads the files on disk instead.
const inGit = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' });
const gitRoot = inGit.status === 0 && relative(inGit.stdout.trim(), root) === '';

function tracked(prefix) {
  if (!gitRoot) return walk(join(root, prefix));
  const run = spawnSync('git', ['ls-files', '-z', '--', prefix], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.split('\0').filter((path) => path.length > 0);
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(relative(root, full).split('\\').join('/'));
  }
  return out;
}

test('git tracks only the shared plugin source and the per-harness manifests (DRY)', () => {
  const files = tracked('plugins');
  const generated = files.filter((path) => !isAllowedPluginPath(path));
  assert.deepEqual(generated, [], 'generated plugin files are tracked; render them at install instead');
  for (const path of PLUGIN_FILES) assert.equal(files.includes(path), true, `${path} is not tracked`);
  assert.equal(files.some((path) => path.startsWith('plugins/shared/skills/') && path.endsWith('/SKILL.md')), true, 'no shared skill source is tracked');
});

test('each of the five harnesses keeps its folder with a valid manifest (DRY)', () => {
  assert.deepEqual(Object.keys(HARNESS_MANIFESTS).sort(), ['antigravity', 'claude', 'codex', 'kilocode', 'opencode']);
  const files = tracked('plugins');
  const problems = [];
  for (const [harness, path] of Object.entries(HARNESS_MANIFESTS)) {
    if (!path.startsWith(`plugins/${harness}/`)) problems.push(`${harness}: ${path} is outside plugins/${harness}/`);
    else if (!files.includes(path) || !existsSync(join(root, path))) problems.push(`${harness}: ${path} is not tracked`);
    else {
      const problem = harnessManifestProblem(harness, readFileSync(join(root, path), 'utf8'));
      if (problem !== null) problems.push(`${harness}: ${path} ${problem}`);
    }
  }
  for (const [harness, path] of Object.entries(NATIVE_MANIFESTS)) {
    const problem = existsSync(join(root, path)) ? manifestProblem(readFileSync(join(root, path), 'utf8')) : 'is missing';
    if (problem !== null) problems.push(`${harness}: ${path} ${problem}`);
  }
  assert.deepEqual(problems, []);
});

test('nothing renders plugin trees into dist/plugins (DRY)', () => {
  assert.deepEqual(walk(join(root, 'dist', 'plugins')), []);
  if (gitRoot) assert.deepEqual(tracked('dist'), [], 'dist/ is build output and is not tracked');
});

test('no two plugin files are identical or near-identical (DRY)', () => {
  const paths = [...new Set([...tracked('plugins'), ...walk(join(root, 'dist', 'plugins'))])].filter((path) => existsSync(join(root, path)));
  const found = duplicatePlugins(paths.map((path) => ({ path, bytes: readFileSync(join(root, path)) })));
  assert.deepEqual(found.map((pair) => `${pair.a} and ${pair.b}: ${pair.kind}`), []);
});

test('the duplicate check catches copies, reformatted copies and near copies (DRY)', () => {
  const body = Array.from({ length: 20 }, (_, i) => `line ${i} of the skill body`).join('\n');
  const near = body.replace('line 3 of', 'line three of');
  const found = duplicatePlugins([
    { path: 'a/SKILL.md', bytes: Buffer.from(body) },
    { path: 'b/SKILL.md', bytes: Buffer.from(body) },
    { path: 'c/SKILL.md', bytes: Buffer.from(`  ${body.toUpperCase()}\n\n`) },
    { path: 'd/SKILL.md', bytes: Buffer.from(near) },
    { path: 'e/SKILL.md', bytes: Buffer.from('a different skill entirely\nwith its own words\n'.repeat(8)) },
  ]);
  const kinds = Object.fromEntries(found.map((pair) => [`${pair.a}|${pair.b}`, pair.kind]));
  assert.equal(kinds['a/SKILL.md|b/SKILL.md'], 'identical');
  assert.equal(kinds['a/SKILL.md|c/SKILL.md'], 'identical-after-whitespace');
  assert.match(kinds['a/SKILL.md|d/SKILL.md'], /^near-identical \(95% of lines\)$/);
  assert.equal(found.some((pair) => pair.a === 'e/SKILL.md' || pair.b === 'e/SKILL.md'), false);
  assert.equal(isAllowedPluginPath('plugins/claude/skills/plan/SKILL.md'), false);
  assert.equal(isAllowedPluginPath('plugins/claude/bin/hook.js'), false);
  assert.equal(isAllowedPluginPath('plugins\\shared\\skills\\plan\\SKILL.md'), true);
  assert.equal(manifestProblem('{"name":"jevris","description":"d"}'), null);
  assert.equal(manifestProblem('{"name":"other","description":"d"}'), 'does not name the plugin "jevris"');
  assert.equal(manifestProblem('{"name":"jevris"}'), 'has no description');
  assert.equal(manifestProblem('[]'), 'is not a JSON object');
  assert.equal(manifestProblem('{'), 'is not JSON');
  const kilo = {
    harness: 'kilocode',
    launcher: 'kilo',
    displayName: 'Kilo Code',
    skills: { dir: '$CONFIG/kilo/skills', namespace: 'jevris-', allowedToolsPrefix: null, userInvocationField: null },
    plugin: { path: '.config/kilo/plugin/jevris.js', export: 'default', template: 'plugins/shared/shim.js' },
    hooks: [],
    features: [],
    events: ['session.idle'],
    unsupported: { 'permission-deny': 'no deny surface' },
    mcp: { dir: '.config/kilo', file: 'kilo.json', key: ['mcp', 'jevris'], schema: null, entry: { type: 'local', command: ['node', '$MCP'] } },
  };
  assert.equal(harnessManifestProblem('kilocode', JSON.stringify(kilo)), null);
  assert.equal(harnessManifestProblem('opencode', JSON.stringify(kilo)), 'names harness "kilocode", not opencode');
  assert.equal(harnessManifestProblem('kilocode', JSON.stringify({ ...kilo, launcher: 'agy' })), 'names launcher "agy", not kilo');
  assert.equal(harnessManifestProblem('kilocode', JSON.stringify({ ...kilo, mcp: undefined })), 'has no valid mcp entry (dir, file, key, schema, entry)');
  assert.equal(harnessManifestProblem('kilocode', JSON.stringify({ ...kilo, plugin: { path: 'x' } })), 'plugin.export is not "default" or "named"');
  assert.equal(harnessManifestProblem('kilocode', JSON.stringify({ ...kilo, plugin: { ...kilo.plugin, template: 'plugins/kilocode/jevris.js' } })), 'plugin.template is not plugins/shared/shim.js');
  assert.equal(harnessManifestProblem('kilocode', JSON.stringify({ ...kilo, skills: '.config/kilo/skills' })), 'has no valid skills entry (dir, namespace, allowedToolsPrefix, userInvocationField)');
  assert.equal(harnessManifestProblem('kilocode', JSON.stringify({ ...kilo, skills: { ...kilo.skills, dir: '../outside' } })), 'skills.dir is not home-relative');
  assert.equal(harnessManifestProblem('kilocode', JSON.stringify({ ...kilo, extra: { any: 1 } })), null);
  assert.equal(harnessManifestProblem('claude', JSON.stringify({ ...kilo, harness: 'claude', launcher: 'claude', plugin: { path: '.claude/plugins/jevris-local', marketplace: 'jevris-local' }, mcp: undefined, events: undefined })), null);
});
