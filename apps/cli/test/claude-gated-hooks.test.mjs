// B's MEDIUM 26 (access limits R68): the Claude plugin never lists StopFailure. Install adds it,
// registered as Stop is, only when a record certifies access.session for the installed binary.
// Temp homes and an unavailable stand-in CLI only; no harness binary runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { installGlobal, withGatedClaudeHooks, certifiedClaudeGates, CLAUDE_GATED_HOOKS } = await import('../dist/global-harness.js');
const root = join(import.meta.dirname, '..', '..', '..');
const source = readFileSync(join(root, 'plugins', 'claude', 'hooks', 'hooks.json'), 'utf8');

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-gated-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function find(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = find(path, name);
      if (found !== null) return found;
    } else if (path.endsWith(name)) return path;
  }
  return null;
}

test('the plugin lists no gated event; withGatedClaudeHooks adds each as Stop is registered', () => {
  const hooks = JSON.parse(source).hooks;
  assert.equal(hooks.StopFailure, undefined, 'the source never registers StopFailure');
  assert.deepEqual(CLAUDE_GATED_HOOKS, { StopFailure: 'access.session' });
  assert.equal(withGatedClaudeHooks(source, []), source, 'nothing certified, nothing changed');
  const gated = JSON.parse(withGatedClaudeHooks(source, ['StopFailure']));
  assert.deepEqual(gated.hooks.StopFailure, hooks.Stop);
  assert.deepEqual({ ...gated.hooks, StopFailure: undefined }, { ...hooks, StopFailure: undefined }, 'every other event is as the plugin has it');
  assert.equal(withGatedClaudeHooks('{"hooks":{}}', ['StopFailure']), null, 'no Stop entry to copy');
  assert.equal(withGatedClaudeHooks('{not json', ['StopFailure']), null);
});

test('certifiedClaudeGates asks for each gated event\'s own feature on claude', async () => {
  const asked = [];
  assert.deepEqual(await certifiedClaudeGates(async (harness, featureId) => (asked.push([harness, featureId]), true)), ['StopFailure']);
  assert.deepEqual(asked, [['claude', 'access.session']]);
  assert.deepEqual(await certifiedClaudeGates(async () => false), []);
});

for (const certified of [false, true]) {
  test(`install renders StopFailure ${certified ? 'when' : 'only when'} access.session is certified (${certified ? 'certified' : 'not certified'})`, async (t) => {
    const home = tempHome(t);
    const cli = { available: () => false, run: async () => ({ spawned: false, code: 1, stdout: '' }) };
    const gate = async (harness, featureId) => certified && harness === 'claude' && featureId === 'access.session';
    const result = await installGlobal({ home, root, harness: 'claude', cli, env: { HOME: home, PATH: '' }, smoke: false }, gate);
    assert.equal(result.ok, true, JSON.stringify(result).slice(0, 400));
    const file = find(join(home, '.claude'), join('jevris', 'hooks', 'hooks.json'));
    assert.ok(file, 'the plugin hooks.json was written');
    const hooks = JSON.parse(readFileSync(file, 'utf8')).hooks;
    assert.equal(hooks.StopFailure !== undefined, certified);
    if (certified) assert.deepEqual(hooks.StopFailure, hooks.Stop, 'the same launcher, arguments and timeout as Stop');
    assert.doesNotMatch(readFileSync(file, 'utf8'), /\$\{CLAUDE_PLUGIN_ROOT\}/, 'every entry points at the runtime');
  });
}
