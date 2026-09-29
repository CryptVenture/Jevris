import { lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A real enterprise-managed policy on this machine (GOV-05) wins over every test setting: the
 * product never lets JEVRIS_TEST_MANAGED_DIR replace it, and a managed kill switch stops every
 * Jevris effect. Tests that assume a host without managed policy, and tests that exercise
 * managed behaviour through JEVRIS_TEST_MANAGED_DIR, skip on such a machine with one reason
 * naming the location, instead of failing. The product rule is unchanged.
 *
 * `managedHostSkip()` is the `skip` option for those tests: false on an unmanaged host, else the
 * reason. `probe` is a test-only seam; JEVRIS_TEST_SIMULATE_MANAGED_HOST=1 makes the helper
 * report a managed host (it can only make tests skip, never change what the product reads).
 */

const ENTERPRISE = new URL('../apps/cli/dist/enterprise-policy.js', import.meta.url);

function defaultExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

async function loadEnterprise() {
  try {
    return await import(ENTERPRISE.href);
  } catch {
    return undefined;
  }
}

const enterprise = await loadEnterprise();

/** The real managed location on this OS (never the test override). */
export function realManagedPolicyDir(platform = process.platform, env = process.env) {
  if (enterprise !== undefined) return enterprise.managedPolicyDir(platform, env);
  if (platform === 'darwin') return '/Library/Application Support/Jevris';
  if (platform === 'win32') return `${env.ProgramData ?? 'C:\\ProgramData'}\\Jevris`;
  return '/etc/jevris';
}

/**
 * Where a real managed policy is present, or null. On Windows the policy registry key counts
 * too (read through the product's own reader, with the test override removed).
 */
export function realManagedPolicyLocation(probe = {}) {
  const platform = probe.platform ?? process.platform;
  const env = probe.env ?? process.env;
  if (probe.simulate === true || (probe.simulate === undefined && env.JEVRIS_TEST_SIMULATE_MANAGED_HOST === '1')) {
    return realManagedPolicyDir(platform, env);
  }
  const exists = probe.exists ?? defaultExists;
  const dir = realManagedPolicyDir(platform, env);
  if (exists(dir)) return dir;
  if (platform === 'win32' && probe.exists === undefined && enterprise !== undefined) {
    const { JEVRIS_TEST_MANAGED_DIR: _override, ...realEnv } = env;
    try {
      const ks = enterprise.readManagedKillSwitch({ platform, env: realEnv });
      const policy = enterprise.readManagedPolicy({ platform, env: realEnv });
      if (ks.source === 'registry' || (policy.state !== 'absent' && policy.source === 'registry')) return enterprise.MANAGED_REGISTRY_KEY;
    } catch {
      // unreadable: the product fails closed; so do these tests
      return enterprise.MANAGED_REGISTRY_KEY;
    }
  }
  return null;
}

/** The `skip` option: false on an unmanaged host, else one reason naming the location. */
export function managedHostSkip(probe = {}) {
  const where = realManagedPolicyLocation(probe);
  if (where === null) return false;
  return `this machine has a real managed Jevris policy at ${where}; it wins over test settings (GOV-05), so this test, which needs a host without one, is skipped`;
}

export const MANAGED_HOST_HELPER = fileURLToPath(import.meta.url);
