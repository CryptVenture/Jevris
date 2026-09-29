// ADM-01: --home is optional and defaults to the OS home directory; in the test environment
// (JEVRIS_TEST=1) a command that names no home (no --home, no JEVRIS_HOME) is refused, so a test
// never touches the real HOME. Each pair runs the same command both ways, with HOME pointed at
// a temporary folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../../../bin/jevris.mjs', import.meta.url));
const REFUSAL = /refused \(HOME_REQUIRED_IN_TEST\)/;
const REAL = /refused \(REAL_HOME_IN_TEST\)/;

function box(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-home-default-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const home = join(dir, 'home');
  const work = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(work, '.git'), { recursive: true });
  return { home, work };
}

function jevris({ home, work }, argv, { testEnv, input, extra = {} } = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^(JEVRIS_|XDG_|CLAUDE_)/.test(key)) env[key] = value;
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'), JEVRIS_SIDECAR_AUTOSTART: '0', JEVRIS_NO_LIVE_HARNESS: '1' });
  if (testEnv) env.JEVRIS_TEST = '1';
  Object.assign(env, extra);
  return spawnSync(process.execPath, [bin, ...argv], { env, cwd: work, input, encoding: 'utf8' });
}

const COMMANDS = [
  ['status', ['status', '--json']],
  ['checkpoint', ['checkpoint', '--objective', 'x', '--json']],
  ['evidence get', ['evidence', 'get', 'output:none', '--json']],
  ['verify profile', ['verify', 'profile', '--json']],
  ['verify required', ['verify', 'required', 'unit', '--json']],
  ['task reconcile', ['task', 'reconcile', 'T1', '--applied', '--yes', '--json']],
  ['cost-report', ['cost-report', '--json']],
  ['shortlist', ['shortlist', '--intent', 'fix a bug']],
];

for (const [name, argv] of COMMANDS) {
  test(`${name}: without --home it uses the OS home; under JEVRIS_TEST=1 it refuses and writes nothing`, (t) => {
    const paths = box(t);
    const plain = jevris(paths, argv);
    assert.doesNotMatch(`${plain.stdout}${plain.stderr}`, REFUSAL, `${name} refused outside the test environment`);
    assert.notEqual(plain.status, 2, `${name} failed without --home: ${plain.stdout} ${plain.stderr}`);
    const fresh = box(t);
    const refused = jevris(fresh, argv, { testEnv: true });
    assert.equal(refused.status, 2, `${name} ran in the test environment without a home: ${refused.stdout}`);
    assert.match(`${refused.stdout}${refused.stderr}`, REFUSAL);
    assert.deepEqual(readdirSync(fresh.home), [], `${name} wrote into the home it refused`);
    // Naming a temporary home, by flag or by JEVRIS_HOME, runs it.
    const named = jevris(fresh, [...argv, '--home', fresh.home], { testEnv: true });
    assert.doesNotMatch(`${named.stdout}${named.stderr}`, /refused \(/);
    const viaEnv = jevris(fresh, argv, { testEnv: true, extra: { JEVRIS_HOME: fresh.home } });
    assert.doesNotMatch(`${viaEnv.stdout}${viaEnv.stderr}`, /refused \(/);
    // Naming the runner's recorded real home is refused too, and nothing is written there.
    const real = box(t);
    const toReal = jevris(real, [...argv, '--home', real.home], { testEnv: true, extra: { JEVRIS_TEST_REAL_HOME: real.home } });
    assert.equal(toReal.status, 2, `${name} ran against the real home: ${toReal.stdout}`);
    assert.match(`${toReal.stdout}${toReal.stderr}`, REAL);
    assert.deepEqual(readdirSync(real.home), []);
  });
}

test('the MCP surface entry follows the same rule', (t) => {
  const paths = box(t);
  const refused = jevris(paths, ['__surface', 'status'], { testEnv: true, input: '{}' });
  assert.equal(refused.status, 2);
  assert.match(refused.stdout, REFUSAL);
  const plain = jevris(paths, ['__surface', 'status'], { input: '{}' });
  assert.equal(plain.status, 0, plain.stdout);
  assert.equal(JSON.parse(plain.stdout).command, 'status');
});
