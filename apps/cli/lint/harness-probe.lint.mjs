// Source-text checks moved out of apps/cli/test/harness-probe.test.mjs (QA-07).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the harness probe writes no hook manifest and doctor calls it without child_process', () => {
  const probeSource = readFileSync(new URL('../src/harness-probe.ts', import.meta.url), 'utf8');
  const doctorSource = readFileSync(new URL('../src/doctor.ts', import.meta.url), 'utf8');
  assert.equal(probeSource.includes('writeFile'), false);
  assert.equal(probeSource.includes('hooks.json'), false);
  assert.equal(probeSource.includes('2.1.278'), false);
  assert.equal(doctorSource.includes('probeInstalledHarness'), true);
  assert.equal(doctorSource.includes('node:child_process'), false);
});
