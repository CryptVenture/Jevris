import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// GOV-05: on a machine with a real managed Jevris policy, the tests that need a host without
// one skip with a reason naming the location. The product rule (a real managed policy wins over
// JEVRIS_TEST_MANAGED_DIR) is unchanged; nothing here writes to /Library or /etc.

const { managedHostSkip, realManagedPolicyDir, realManagedPolicyLocation } = await import('./managed-host.mjs');

test('the skip reason names the real managed location only when one is present (GOV-05)', () => {
  assert.equal(realManagedPolicyDir('darwin'), '/Library/Application Support/Jevris');
  assert.equal(realManagedPolicyDir('linux'), '/etc/jevris');
  const seen = [];
  const present = managedHostSkip({ platform: 'darwin', env: {}, exists: (path) => (seen.push(path), true) });
  assert.deepEqual(seen, ['/Library/Application Support/Jevris'], 'only the real location is probed, never a test override');
  assert.match(present, /real managed Jevris policy at \/Library\/Application Support\/Jevris/);
  assert.match(present, /skipped/);
  assert.equal(managedHostSkip({ platform: 'linux', env: { JEVRIS_TEST_MANAGED_DIR: '/tmp/x' }, exists: () => false }), false);
  assert.equal(realManagedPolicyLocation({ platform: 'linux', env: {}, exists: () => false }), null);
  assert.match(managedHostSkip({ platform: 'linux', env: { JEVRIS_TEST_SIMULATE_MANAGED_HOST: '1' } }), /at \/etc\/jevris/);
});

test('a simulated managed host skips the tests that need an unmanaged one instead of failing them (GOV-05)', () => {
  const file = fileURLToPath(new URL('../apps/cli/test/enterprise-policy.test.mjs', import.meta.url));
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], {
    encoding: 'utf8',
    // A child test run of its own: without the parent's NODE_TEST_CONTEXT it reports in TAP.
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_TEST_CONTEXT')), JEVRIS_TEST_SIMULATE_MANAGED_HOST: '1' },
    timeout: 120_000,
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const where = realManagedPolicyDir();
  const skipped = run.stdout.split('\n').filter((line) => /# SKIP this machine has a real managed Jevris policy at /.test(line));
  assert.equal(skipped.length, 3, run.stdout);
  // The TAP reporter escapes a backslash in a skip reason as two (a Windows path).
  for (const line of skipped) assert.ok(line.includes(where.replace(/\\/g, '\\\\')), line);
  assert.match(run.stdout, /^# fail 0$/m);
  // The tests that do not depend on the host still run.
  assert.match(run.stdout, /^ok \d+ - managed locations per OS/m);
});
