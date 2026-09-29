// R4 (owner decision DOMAINS 9d6a66d, C 68e8464): `jevris route learning` reads the loaded model
// registry, an administrator's override included, not the bundled one. A pin at the model's
// default effort in the override is the bare model, labelled without an effort.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sandbox } from '../../../test/acceptance/lib.mjs';

const core = await import('@jevris/core');

test('a pin at the override registry default effort is the bare model', async (t) => {
  const box = await sandbox(t);
  box.write('work/src/a.js', 'export const a = 1;\n');
  box.gitInit();
  // Bundled: Opus 5.5 defaults to medium, so a low pin is Opus 5.5 at low effort.
  const bundled = box.jevris(['route', 'learning', 'pin', 'bounded-edit', 'claude-opus-5-5', '--effort', 'low', '--yes']);
  assert.equal(bundled.code, 0, bundled.stdout + bundled.stderr);
  assert.match(bundled.stdout, /Pinned slice bounded-edit to claude-opus-5-5 at low effort;/);

  // The override makes low the default: the same pin is the bare model.
  const override = JSON.parse(JSON.stringify(core.BUNDLED_MODEL_REGISTRY));
  override.snapshotId = 'override-low-default';
  override.entries = override.entries.map((entry) => (entry.modelId === 'claude-opus-5-5' ? { ...entry, defaultEffort: 'low' } : entry));
  assert.equal(core.checkModelRegistry ? core.checkModelRegistry(override).ok : true, true);
  const file = core.modelRegistryFile(box.home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(override)}\n`);
  const overridden = box.jevris(['route', 'learning', 'pin', 'bounded-edit', 'claude-opus-5-5', '--effort', 'low', '--yes']);
  assert.equal(overridden.code, 0, overridden.stdout + overridden.stderr);
  assert.match(overridden.stdout, /Pinned slice bounded-edit to claude-opus-5-5;/);
});
