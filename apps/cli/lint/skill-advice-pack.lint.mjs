// Source-text checks moved out of apps/cli/test/skill-advice-pack.test.mjs (QA-07).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('jevris.skill-advice is advice data: no product module names it', () => {
  const install = readFileSync(join(import.meta.dirname, '../src/install.ts'), 'utf8');
  const shortlist = readFileSync(join(import.meta.dirname, '../src/shortlist.ts'), 'utf8');
  const command = readFileSync(join(import.meta.dirname, '../src/cli.ts'), 'utf8');
  const doctor = readFileSync(join(import.meta.dirname, '../src/doctor.ts'), 'utf8');
  assert.equal(install.includes('skill-advice'), false);
  assert.equal(shortlist.includes('skill-advice'), false);
  assert.equal(shortlist.includes('pack.json'), false);
  assert.equal(command.includes('skill-advice'), false);
  assert.equal(doctor.includes('skill-advice'), false);
});
