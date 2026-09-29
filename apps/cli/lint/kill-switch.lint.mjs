// Source-text checks moved out of apps/cli/test/kill-switch-install.test.mjs and
// apps/cli/test/kill-switch.test.mjs (QA-07).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('off, credential deletion, and uninstall are separate commands from the drill', () => {
  const cli = readFileSync(fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'utf8');
  // uninstall and data delete are the admin commands (G18 removed their legacy branches in cli.ts).
  const admin = readFileSync(fileURLToPath(new URL('../src/admin-cli.ts', import.meta.url)), 'utf8');
  assert.equal(admin.includes("command === 'uninstall'"), true);
  assert.equal(admin.includes("command === 'data'"), true);
  assert.equal(cli.includes("command === 'credential'"), true);
  assert.equal(cli.includes("sub === 'rollback'"), true);
  const credential = readFileSync(fileURLToPath(new URL('../src/credential.ts', import.meta.url)), 'utf8');
  assert.equal(credential.includes('export async function clearHostSecret'), true);
  const uninstall = readFileSync(fileURLToPath(new URL('../src/uninstall.ts', import.meta.url)), 'utf8');
  assert.equal(uninstall.includes('export async function uninstallPlugin'), true);
  assert.equal(uninstall.includes('export async function deleteJevrisData'), true);
  const runtime = readFileSync(
    fileURLToPath(new URL('../../../packages/core/src/runtime.ts', import.meta.url)),
    'utf8',
  );
  assert.equal(runtime.includes("mode: 'off'"), true);
});

test('the kill switch reader does not note a missing process or read the environment', () => {
  const reader = readFileSync(new URL('../src/kill-switch.ts', import.meta.url), 'utf8');
  assert.equal(reader.includes('noteMissingProcess'), false);
  assert.equal(reader.includes('process.env'), false);
});
