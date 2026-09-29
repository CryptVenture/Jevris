// RTE-05, CMD-03, TOOL-02: the route op's switch facts. `jevris route` takes --remaining-input,
// --remaining-output, --context-tokens, --warm-prefix, --cold-cache and --mid-step, and
// jevris_plan_route takes remaining, contextTokens and session. Both end in the same checked
// input; an incomplete or malformed fact is refused before any sidecar call, never guessed.
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

test('route takes the remaining work, the context size and the session facts', () => {
  const full = parseOpInput('route', {
    currentModel: 'claude-opus-5',
    remaining: { inputTokens: 100_000, outputTokens: 10_000 },
    contextTokens: 50_000,
    session: { warmPrefixTokens: 150_000, cacheWarm: false, atBoundary: true, unitsSinceLastSwitch: 3, switchesThisTask: 1 },
  });
  assert.equal(full.ok, true, JSON.stringify(full));
  assert.deepEqual(full.input.remaining, { inputTokens: 100_000, outputTokens: 10_000 });
  assert.equal(full.input.contextTokens, 50_000);
  assert.deepEqual(full.input.session, { warmPrefixTokens: 150_000, cacheWarm: false, atBoundary: true, unitsSinceLastSwitch: 3, switchesThisTask: 1 });
  const bare = parseOpInput('route', {});
  assert.deepEqual([bare.input.remaining, bare.input.contextTokens, bare.input.session], [null, null, null]);
  assert.deepEqual(parseOpInput('route', { session: { warmPrefixTokens: 0 } }).input.session, { warmPrefixTokens: 0 }, 'unset flags stay unset');
  for (const authMode of ['api-key', 'subscription', 'unknown']) {
    assert.deepEqual(parseOpInput('route', { session: { warmPrefixTokens: 1, authMode } }).input.session, { warmPrefixTokens: 1, authMode });
  }
});

test('an incomplete or malformed switch fact is refused', () => {
  for (const bad of [
    { remaining: { inputTokens: 1 } },
    { remaining: { inputTokens: -1, outputTokens: 1 } },
    { remaining: { inputTokens: 1.5, outputTokens: 1 } },
    { remaining: { inputTokens: 100_000_001, outputTokens: 1 } },
    { remaining: { inputTokens: 1, outputTokens: 1, extra: 1 } },
    { remaining: [1, 2] },
    { contextTokens: '5' },
    { session: { cacheWarm: true } },
    { session: { warmPrefixTokens: 1, atBoundary: 'no' } },
    { session: { warmPrefixTokens: 1, extra: 1 } },
    { session: { warmPrefixTokens: 1, switchesThisTask: -1 } },
    { session: { warmPrefixTokens: 1, authMode: 'oauth' } },
    { session: { warmPrefixTokens: 1, authMode: null } },
    { session: { authMode: 'api-key' } },
  ]) {
    assert.equal(parseOpInput('route', bad).ok, false, JSON.stringify(bad));
  }
});

test('the MCP route tool offers the same facts', () => {
  const props = TOOLS.find((tool) => tool.name === 'jevris_plan_route').inputSchema.properties;
  assert.deepEqual(props.remaining.required, ['inputTokens', 'outputTokens']);
  assert.equal(props.contextTokens.type, 'integer');
  assert.deepEqual(props.session.required, ['warmPrefixTokens']);
  assert.equal(props.session.additionalProperties, false);
  assert.deepEqual(props.session.properties.authMode.enum, ['api-key', 'subscription', 'unknown']);
});

test('the CLI flags reach the check: a whole set answers, half a pair or a session flag without its prefix is a usage error', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-route-session-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const work = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(work, '.git'), { recursive: true });
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^(JEVRIS_|XDG_|CLAUDE_)/.test(key)) env[key] = value;
  Object.assign(env, { HOME: home, USERPROFILE: home, JEVRIS_HOME: home, JEVRIS_TEST: '1', JEVRIS_SIDECAR_AUTOSTART: '0' });
  const route = (...argv) => spawnSync(process.execPath, [bin, 'route', '--model', 'claude-opus-5', ...argv, '--json'], { env, cwd: work, encoding: 'utf8' });
  const whole = route('--remaining-input', '100000', '--remaining-output', '10000', '--context-tokens', '50000', '--warm-prefix', '150000', '--cold-cache');
  assert.equal(whole.status, 0, `${whole.stdout} ${whole.stderr}`);
  assert.equal(JSON.parse(whole.stdout).result.applied, false);
  const billed = route('--warm-prefix', '150000', '--auth-mode', 'subscription');
  assert.equal(billed.status, 0, `${billed.stdout} ${billed.stderr}`);
  // G20: --auth-mode alone scopes the advice to the sign-in; it needs no warm prefix.
  const scoped = route('--auth-mode', 'api-key');
  assert.equal(scoped.status, 0, `${scoped.stdout} ${scoped.stderr}`);
  for (const [argv, field] of [
    [['--remaining-input', '100000'], /remaining\.outputTokens/],
    [['--warm-prefix', 'lots'], /session\.warmPrefixTokens/],
    [['--mid-step'], /session\.warmPrefixTokens/],
    [['--warm-prefix', '1', '--auth-mode', 'oauth'], /authMode/],
    [['--context-tokens', '-5'], /Unknown option|contextTokens/],
  ]) {
    const refused = route(...argv);
    assert.equal(refused.status, 2, `${argv.join(' ')}: ${refused.stdout}`);
    assert.match(`${refused.stdout}${refused.stderr}`, field);
  }
});
