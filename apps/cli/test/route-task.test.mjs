// Owner decision 2026-10-01 (Jev as an active decision aid): `jevris route` and jevris_plan_route
// take what is known of the task (title, paths, check ids) so the slice can be classified when no
// sliceId is given. Parsed and bounded before any sidecar call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { parseOpInput } = await import('../dist/public/inputs.js');
const { TOOLS } = await import('../../../packages/mcp/dist/main.js');
const bin = fileURLToPath(new URL('../../../bin/jevris.mjs', import.meta.url));

test('route takes a task { title, paths, checkIds }, bounded; an empty one is no task', () => {
  const ok = parseOpInput('route', { task: { title: 'fix the parser', paths: ['src/a.ts'], checkIds: ['test'] } });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(ok.input.task, { title: 'fix the parser', paths: ['src/a.ts'], checkIds: ['test'] });
  assert.equal(parseOpInput('route', {}).input.task, undefined);
  assert.equal(parseOpInput('route', { task: {} }).input.task, undefined);
  for (const bad of [{ task: 'x' }, { task: [] }, { task: { extra: 1 } }, { task: { paths: 'a' } }, { task: { paths: [''] } }, { task: { checkIds: ['has space'] } }, { task: { title: 'x'.repeat(2001) } }, { task: { paths: Array.from({ length: 65 }, (_, i) => `f${i}.ts`) } }]) {
    assert.equal(parseOpInput('route', bad).ok, false, JSON.stringify(bad).slice(0, 80));
  }
});

test('the MCP route tool offers the same task object', () => {
  const props = TOOLS.find((tool) => tool.name === 'jevris_plan_route').inputSchema.properties;
  assert.equal(props.task.additionalProperties, false);
  assert.deepEqual(Object.keys(props.task.properties).sort(), ['checkIds', 'paths', 'title']);
  assert.equal(props.task.properties.paths.maxItems, 64);
});

test('the CLI flags --title, --path and --check reach the check and are listed in the help', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-route-task-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const work = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(work, '.git'), { recursive: true });
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^(JEVRIS_|XDG_|CLAUDE_)/.test(key)) env[key] = value;
  Object.assign(env, { HOME: home, USERPROFILE: home, JEVRIS_HOME: home, JEVRIS_TEST: '1', JEVRIS_SIDECAR_AUTOSTART: '0' });
  const run = (...argv) => spawnSync(process.execPath, [bin, 'route', ...argv], { env, cwd: work, encoding: 'utf8' });
  const ok = run('--model', 'claude-opus-5', '--title', 'fix the parser', '--path', 'src/a.ts', '--path', 'test/a.test.mjs', '--check', 'test', '--json');
  assert.equal(ok.status, 0, `${ok.stdout} ${ok.stderr}`);
  assert.equal(JSON.parse(ok.stdout).result.applied, false);
  const bad = run('--model', 'claude-opus-5', '--check', 'has space', '--json');
  assert.equal(bad.status, 2, bad.stdout);
  const help = run('--help');
  for (const flag of ['--title', '--path', '--check']) assert.match(help.stdout, new RegExp(flag));
});
