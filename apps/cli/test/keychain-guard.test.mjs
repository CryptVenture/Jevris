// The keychain guard (owner report 2026-09-26: "A keychain cannot be found" dialogs). A real
// harness under a HOME that is not the account's looks for a login keychain that does not
// exist, and macOS shows a dialog. So a harness status probe never runs under a foreign HOME,
// whatever the test flags say, and in a test run a real harness binary outside the temporary
// folder is never started: the tripwire throws instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { spawnTripwire, launchTree, probeRefusal, foreignHomeRefusal, isTripwireBinary } = await import('../dist/live-harness.js');
const bin = fileURLToPath(new URL('../../../bin/jevris.mjs', import.meta.url));

test('the tripwire: in a test run a real harness path outside the temporary folder throws; a stub inside it and a live smoke do not', () => {
  for (const file of ['/opt/homebrew/bin/codex', '/usr/local/bin/claude', '/usr/bin/security', 'C:\\Program Files\\agy\\agy.exe', '/Applications/x/antigravity-ide']) {
    assert.throws(() => spawnTripwire(file, { JEVRIS_TEST: '1' }), /jevris test tripwire: refused to start the real/, file);
  }
  assert.throws(() => launchTree('/opt/homebrew/bin/codex', ['login', 'status']), /tripwire/, 'launchTree is covered');
  const dir = mkdtempSync(join(tmpdir(), 'jevris-tripwire-'));
  try {
    assert.doesNotThrow(() => spawnTripwire(join(dir, 'claude'), { JEVRIS_TEST: '1' }), 'a stub in the temporary folder');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.doesNotThrow(() => spawnTripwire(process.execPath, { JEVRIS_TEST: '1' }), 'node is not a harness');
  assert.doesNotThrow(() => spawnTripwire('/opt/homebrew/bin/codex', { JEVRIS_TEST: '1', JEVRIS_LIVE_HARNESS: '1' }), 'a live smoke');
  assert.equal(isTripwireBinary('C:\\x\\claude.cmd'), true);
  assert.equal(isTripwireBinary('/x/claude-stub'), false);
});

test('a status probe never runs under a foreign HOME, whatever the flags; the account home is allowed', () => {
  const account = userInfo().homedir;
  const dir = mkdtempSync(join(tmpdir(), 'jevris-foreign-home-'));
  try {
    assert.equal(foreignHomeRefusal({ HOME: dir, USERPROFILE: dir }), 'not probed: non-default home');
    assert.equal(foreignHomeRefusal({ HOME: account, USERPROFILE: account }, dir), 'not probed: non-default home', 'a --home elsewhere');
    assert.equal(foreignHomeRefusal({ HOME: account, USERPROFILE: account }), null);
    assert.equal(probeRefusal({ HOME: account, USERPROFILE: account }), 'not probed: test run', 'a test run is never probed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('jevris doctor with a temp HOME and a logging fake claude and codex first on PATH asks neither for its login', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-doctor-fake-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fakes = join(dir, 'bin');
  const home = join(dir, 'home');
  mkdirSync(fakes);
  mkdirSync(home);
  const log = join(dir, 'calls.log');
  const script = join(fakes, 'fake.cjs');
  writeFileSync(script, `require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n'); if (process.argv[3] === '--version') console.log('1.0.0');\n`);
  for (const name of ['claude', 'codex']) {
    if (process.platform === 'win32') writeFileSync(join(fakes, `${name}.cmd`), `@"${process.execPath}" "%~dp0fake.cjs" ${name} %*\r\n`);
    else {
      writeFileSync(join(fakes, name), `#!${process.execPath}\nprocess.argv.splice(2, 0, ${JSON.stringify(name)});\nrequire(${JSON.stringify(script)});\n`);
      chmodSync(join(fakes, name), 0o755);
    }
  }
  // No test flags: this is the ad-hoc run (pack smoke, acceptance, `node --test <file>`) that
  // popped the dialogs. The foreign HOME alone must stop the probe.
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string' && !/^(JEVRIS_TEST|JEVRIS_NO_LIVE_HARNESS|NODE_TEST_CONTEXT|JEVRIS_LIVE_HARNESS)$/.test(key)) env[key] = value;
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  Object.assign(env, { [pathKey]: `${fakes}${delimiter}${env[pathKey] ?? ''}`, HOME: home, USERPROFILE: home, JEVRIS_HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), CODEX_HOME: join(home, '.codex') });
  const ran = spawnSync(process.execPath, [bin, 'doctor', '--home', home], { env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /^harness claude auth: .*not probed: non-default home\)$/m);
  assert.match(ran.stdout, /^harness codex auth: .*not probed: non-default home\)$/m);
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  const probes = calls.filter((argv) => argv.includes('auth') || argv.includes('login'));
  assert.deepEqual(probes, [], `a login probe ran: ${JSON.stringify(probes)}`);
});
