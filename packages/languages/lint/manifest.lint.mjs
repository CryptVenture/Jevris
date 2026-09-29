import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-text checks moved from packages/languages/test/manifest.test.mjs (QA-07). Lint reads src/ and needs no build.
function repoRoot() {
  return fileURLToPath(new URL('../../..', import.meta.url));
}

const DOCTOR_SENTENCE = 'verification remains unsupported until an approved runner manifest exists.';
const SHELL_NAMES = ['bash', 'zsh', 'dash', 'csh', 'ksh', 'fish', 'jq', 'powershell'];
const root = repoRoot();

test('a spaced path stays one argv element and shell stays false (source)', () => {
  const source = readFileSync(join(root, 'packages/languages/src/launcher.ts'), 'utf8');
  for (const name of SHELL_NAMES) {
    assert.equal(source.includes(name), false, name);
  }
  assert.equal(source.includes('/bin/sh'), false);
  assert.equal(source.includes('child_process'), false);
  assert.equal(source.includes('node:process'), false);
  assert.equal(source.includes('spawnSync'), false);
  assert.equal(source.includes('execFile'), false);
  // The only platform knowledge is the shared spawn planner import (BLD-06); no OS branch here.
  assert.equal(source.includes('process.platform'), false);
});

test('win32 can run and no certification record uses platform win32 (source)', () => {
  const doctor = readFileSync(join(root, 'apps/cli/src/doctor.ts'), 'utf8');
  assert.equal(doctor.includes(DOCTOR_SENTENCE), true);
  assert.equal(doctor.includes('The certified Windows launcher is not present.'), true);
});

test('an unknown stack gets triage and checkpoints without a receipt (source)', () => {
  const source = readFileSync(join(root, 'packages/languages/src/manifest.ts'), 'utf8');
  assert.equal(source.includes('child_process'), false);
  assert.equal(source.includes('spawnSync'), false);
  assert.equal(source.includes('runDeclaredCheck'), false);
  assert.equal(source.includes('@jevris/store'), false);
  assert.equal(source.includes('openStore'), false);
});

test('a passed frame is refused before spawn and a model sentence is not a passed claim (source)', () => {
  const gate = readFileSync(join(root, 'packages/store/src/receipt-gate.ts'), 'utf8');
  const passedAt = gate.indexOf('passedClaim(frame)');
  const spawnAt = gate.indexOf('spawnSync(');
  assert.equal(passedAt >= 0 && spawnAt > passedAt, true);
  assert.equal(gate.includes('shell: false'), true);
  assert.equal(gate.includes('env: {}'), true);
  assert.equal(gate.includes('jevCommand'), false);
});
