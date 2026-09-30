// The built product end to end against a real sidecar in a temp HOME: every public CLI command,
// every MCP tool over stdio and every hook fixture of every harness (CMD-01..08, TOOL-01..10,
// HKR-01). The same scenario runs from the installed tarball in the pack smoke.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { surfaceE2E } from '../../../scripts/surface-e2e.mjs';
import { managedHostSkip } from '../../../test/managed-host.mjs';

const ROOT = join(import.meta.dirname, '..', '..', '..');

/**
 * Steps that wait on another domain, with the owner. A pending step that passes is reported so
 * it can be removed; any other failing step fails the test.
 */
const PENDING = {};

test('every CLI command, MCP tool and hook event works end to end against the sidecar', { skip: managedHostSkip(), timeout: 500_000 }, async (t) => {
  const report = await surfaceE2E({
    bin: join(ROOT, 'bin', 'jevris.mjs'),
    mcp: join(ROOT, 'plugins', 'shared', 'mcp.js'),
    hook: join(ROOT, 'dist', 'hook.mjs'),
  });
  const failed = report.steps.filter((step) => !step.ok && !Object.hasOwn(PENDING, step.name));
  assert.deepEqual(failed, [], 'every step outside the pending list passes');
  for (const step of report.steps) {
    if (Object.hasOwn(PENDING, step.name)) t.diagnostic(`${step.ok ? 'fixed, remove from PENDING' : 'pending'}: ${step.name} (${PENDING[step.name]})`);
  }
  const names = report.steps.map((step) => step.name);
  assert.equal(names.filter((name) => name.startsWith('cli ')).length >= 8, true);
  assert.equal(names.filter((name) => name.startsWith('mcp jevris_')).length, 17);
  assert.equal(names.filter((name) => name.startsWith('mock: mcp jevris_')).length, 17, 'the mock-provider pass covers every tool');
  assert.equal(names.filter((name) => name.startsWith('hook ')).length >= 40, true);
});
