import test from 'node:test';
import assert from 'node:assert/strict';

const { classifyEnvironment } = await import('../dist/platform.js');

const HOSTS = ['linux', 'darwin', 'win32'];
const NODE_VERSION = 'v22.13.1';

function assertNoCertifiedField(result) {
  assert.equal(Object.hasOwn(Object(result), 'certified'), false);
}

test('linux, darwin, and win32 with a non-empty node version and empty env are local', () => {
  assert.equal(NODE_VERSION.length > 0, true);
  for (const platform of HOSTS) {
    const result = classifyEnvironment({ platform, nodeVersion: NODE_VERSION, env: {} });
    assert.equal(result, 'local');
    assertNoCertifiedField(result);
  }
});

test('an empty platform is unsupported', () => {
  const result = classifyEnvironment({ platform: '', nodeVersion: NODE_VERSION, env: {} });
  assert.equal(result, 'unsupported');
  assertNoCertifiedField(result);
});

test('SSH_CONNECTION set is reduced on linux, darwin, and win32', () => {
  for (const platform of HOSTS) {
    const result = classifyEnvironment({
      platform,
      nodeVersion: NODE_VERSION,
      env: { SSH_CONNECTION: '203.0.113.4 51324 198.51.100.8 22' },
    });
    assert.equal(result, 'reduced');
    assertNoCertifiedField(result);
  }
});
