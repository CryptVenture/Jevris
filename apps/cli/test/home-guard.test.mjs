// ADM-01 (owner decision 2026-09-26): --home is optional and defaults to JEVRIS_HOME, else the
// real home. In the test environment a command without an explicit temporary home, or one that
// resolves to the real home, is refused loudly, so no test can reach the owner's home.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { main } = await import('../dist/cli.js');
const { testHomeRefusal } = await import('../dist/home-guard.js');

async function run(argv) {
  let text = '';
  const code = await main(argv, (chunk) => (text += chunk));
  return { code, text };
}

async function withEnv(patch, fn) {
  const saved = {};
  for (const key of Object.keys(patch)) {
    saved[key] = process.env[key];
    if (patch[key] === undefined) delete process.env[key];
    else process.env[key] = patch[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('testHomeRefusal: only in the test environment, for no explicit home or the real home', () => {
  const real = '/Users/owner';
  const opts = { platform: 'darwin', accountHome: real };
  assert.equal(testHomeRefusal({ home: real, source: 'os' }, {}, opts), null, 'outside tests the real home is the default');
  assert.equal(testHomeRefusal({ home: '/tmp/t1', source: 'os' }, { JEVRIS_TEST: '1' }, opts).reasonCode, 'HOME_REQUIRED_IN_TEST');
  assert.equal(testHomeRefusal({ home: '/tmp/t1', source: 'explicit' }, { JEVRIS_TEST: '1' }, opts), null);
  assert.equal(testHomeRefusal({ home: '/tmp/t1', source: 'JEVRIS_HOME' }, { JEVRIS_TEST: '1' }, opts), null);
  assert.equal(testHomeRefusal({ home: '/USERS/owner/', source: 'explicit' }, { JEVRIS_TEST: '1' }, opts).reasonCode, 'REAL_HOME_IN_TEST', 'the account home, case-folded on macOS');
  assert.equal(testHomeRefusal({ home: '/home/ci', source: 'JEVRIS_HOME' }, { JEVRIS_TEST: '1', JEVRIS_TEST_REAL_HOME: '/home/ci' }, { platform: 'linux', accountHome: null }).reasonCode, 'REAL_HOME_IN_TEST', "the runner's recorded real home");
});

test('an admin command in the test environment without --home or JEVRIS_HOME is refused loudly and touches nothing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jevris-home-guard-'));
  try {
    await withEnv({ JEVRIS_TEST: '1', JEVRIS_HOME: undefined, HOME: home, USERPROFILE: home }, async () => {
      for (const argv of [['doctor', '--harness', 'kilo'], ['install', '--dry-run'], ['uninstall', '--dry-run'], ['data', 'delete']]) {
        const refused = await run(argv);
        assert.equal(refused.code, 2, `${argv.join(' ')}: ${refused.text}`);
        assert.match(refused.text, /^refused \(HOME_REQUIRED_IN_TEST\): /, argv.join(' '));
      }
      const json = await run(['doctor', '--json']);
      assert.equal(JSON.parse(json.text).reasonCode, 'HOME_REQUIRED_IN_TEST');
      assert.deepEqual(await readdir(home), [], 'nothing was written');
      // An explicit temporary home works as before, and JEVRIS_HOME counts as explicit.
      const explicit = await run(['doctor', '--home', home, '--harness', 'kilo', '--json']);
      assert.equal(explicit.code, 0, explicit.text);
      await withEnv({ JEVRIS_HOME: home }, async () => assert.equal((await run(['doctor', '--harness', 'kilo', '--json'])).code, 0));
      // Help needs no home.
      assert.equal((await run(['install', '--help'])).code, 0);
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('an admin command in the test environment that names the real home is refused', async () => {
  const fake = await mkdtemp(join(tmpdir(), 'jevris-home-guard-real-'));
  try {
    await withEnv({ JEVRIS_TEST: '1', JEVRIS_TEST_REAL_HOME: fake }, async () => {
      const refused = await run(['uninstall', '--home', fake, '--dry-run']);
      assert.equal(refused.code, 2);
      assert.match(refused.text, /^refused \(REAL_HOME_IN_TEST\): /);
      assert.deepEqual(await readdir(fake), []);
    });
  } finally {
    await rm(fake, { recursive: true, force: true });
  }
});
