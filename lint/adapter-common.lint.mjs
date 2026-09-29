import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Adapter core drift (HKR-02, D-F2). Every harness adapter package carries the same
 * `src/common.ts`, byte for byte, so the five harness adapters share one screening, bounding
 * and hashing core while keeping zero runtime imports. Edit one copy, then copy it to the rest.
 */

const root = fileURLToPath(new URL('..', import.meta.url));

/** Harness hook adapters. `adapter-claude-sdk` is the Agent SDK session port, not a hook adapter. */
export const HARNESS_ADAPTERS = ['adapter-antigravity', 'adapter-claude-code', 'adapter-codex', 'adapter-kilocode', 'adapter-opencode'];

export function adapterCores(base = root) {
  const dir = join(base, 'packages');
  return HARNESS_ADAPTERS.filter((name) => existsSync(join(dir, name))).map((name) => ({ name, path: join(dir, name, 'src', 'common.ts') }));
}

test('every adapter package has a src/common.ts', () => {
  const cores = adapterCores();
  assert.ok(cores.length >= 4, 'adapter packages found');
  assert.deepEqual(cores.filter(({ path }) => !existsSync(path)).map(({ name }) => name), []);
});

test('every adapter src/common.ts is byte-identical to adapter-codex (HKR-02)', () => {
  const cores = adapterCores().filter(({ path }) => existsSync(path));
  const reference = readFileSync(join(root, 'packages', 'adapter-codex', 'src', 'common.ts'));
  const drifted = cores.filter(({ path }) => !readFileSync(path).equals(reference)).map(({ name }) => `packages/${name}/src/common.ts`);
  assert.deepEqual(drifted, []);
});
