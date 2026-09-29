import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { KeyringBlockedError, keyringBlockedInTests, openHostEntry } = await import('../dist/credential.js');
const { main } = await import('../dist/cli.js');

const root = fileURLToPath(new URL('../../..', import.meta.url));
const require = createRequire(import.meta.url);

function keyringLoaded() {
  return Object.keys(require.cache).some((key) => key.includes(`napi-rs${'/'}keyring`) || key.includes('napi-rs\\keyring') || /keyring\..*\.node$/.test(key));
}

test('keyringBlockedInTests reads JEVRIS_TEST and NODE_TEST_CONTEXT only', () => {
  assert.equal(keyringBlockedInTests({}), false);
  assert.equal(keyringBlockedInTests({ JEVRIS_TEST: '1' }), true);
  assert.equal(keyringBlockedInTests({ JEVRIS_TEST: '0' }), false);
  assert.equal(keyringBlockedInTests({ NODE_TEST_CONTEXT: 'child-v8' }), true);
  assert.equal(keyringBlockedInTests({ NODE_TEST_CONTEXT: '' }), false);
});

test('openHostEntry refuses inside a test process and never loads @napi-rs/keyring', async () => {
  assert.equal(keyringBlockedInTests(), true);
  await assert.rejects(openHostEntry('jevris-test-service', 'jevris-test-account'), (error) => {
    assert.equal(error instanceof KeyringBlockedError, true);
    assert.equal(error.code, 'ERR_JEVRIS_KEYRING_BLOCKED');
    return true;
  });
  let text = '';
  const code = await main(['credential', 'status'], (chunk) => {
    text += chunk;
  });
  assert.equal(typeof code, 'number');
  assert.equal(text.includes('ERR_JEVRIS'), false);
  assert.equal(keyringLoaded(), false);
});

test('a child with only JEVRIS_TEST=1 and no preload is refused before the binding loads', () => {
  const script = [
    "import { createRequire } from 'node:module';",
    `const { openHostEntry } = await import(${JSON.stringify(pathToFileURL(join(root, 'apps', 'cli', 'dist', 'credential.js')).href)});`,
    'let code = "none";',
    'try { await openHostEntry("jevris-test-service", "jevris-test-account"); } catch (error) { code = error.code ?? error.message; }',
    'const cache = Object.keys(createRequire(import.meta.url).cache);',
    'process.stdout.write(JSON.stringify({ code, loaded: cache.some((key) => key.includes("keyring")) }));',
  ].join('\n');
  const env = { PATH: process.env.PATH ?? '', JEVRIS_TEST: '1', HOME: process.env.HOME ?? '', USERPROFILE: process.env.USERPROFILE ?? '' };
  if (process.env.SystemRoot !== undefined) env.SystemRoot = process.env.SystemRoot;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    env,
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { code: 'ERR_JEVRIS_KEYRING_BLOCKED', loaded: false });
});

test('the runner preload blocks @napi-rs/keyring resolution for every test process', async (t) => {
  const options = process.env.NODE_OPTIONS ?? '';
  if (process.env.JEVRIS_TEST !== '1') {
    t.skip('not started by scripts/test.mjs');
    return;
  }
  assert.equal(options.includes('scripts/test-preload.mjs'), true);
  await assert.rejects(import('@napi-rs/keyring'), (error) => {
    assert.equal(error.code, 'ERR_JEVRIS_KEYRING_BLOCKED');
    return true;
  });
  assert.equal(keyringLoaded(), false);
});
