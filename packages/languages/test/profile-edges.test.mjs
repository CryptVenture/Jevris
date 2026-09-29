import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileWorkspace, spawnVersionProbe } from '../dist/index.js';

function temp(t) {
  const root = mkdtempSync(join(tmpdir(), 'jevris-profile-edge-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('the default version probe runs a program without a shell and returns its first line; a missing program is null', () => {
  const probe = spawnVersionProbe(process.env, 10_000);
  const line = probe(process.execPath, ['--version']);
  assert.equal(line, process.version);
  assert.equal(probe(join(tmpdir(), 'jevris-no-such-program-7f3a'), ['--version']), null);
});

test('an unreadable root profiles as empty and a malformed package.json yields no script facts', (t) => {
  const missing = profileWorkspace(join(tmpdir(), 'jevris-profile-missing-9c1e'), { probe: () => null });
  assert.deepEqual(missing.stacks, []);
  assert.equal(missing.truncated, false);
  const root = temp(t);
  writeFileSync(join(root, 'package.json'), '{ not json');
  writeFileSync(join(root, 'yarn.lock'), '');
  const profile = profileWorkspace(root, { probe: () => null });
  assert.equal(profile.stacks.length, 1);
  assert.equal(profile.stacks[0].stack, 'yarn');
  assert.deepEqual(profile.stacks[0].facts, {});
});

test('the walk stops at the directory cap and says it was truncated', (t) => {
  const root = temp(t);
  for (let i = 0; i < 2_001; i += 1) mkdirSync(join(root, `d${String(i).padStart(4, '0')}`));
  const profile = profileWorkspace(root, { probe: () => null, maxDepth: 1 });
  assert.equal(profile.truncated, true);
  const shallow = profileWorkspace(root, { probe: () => null, maxDepth: 0 });
  assert.equal(shallow.truncated, false);
});
