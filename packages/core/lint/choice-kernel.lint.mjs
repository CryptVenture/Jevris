import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-text checks moved from packages/core/test/choice-kernel.test.mjs (QA-07). Lint reads src/ and needs no build.
function repoRoot() {
  return fileURLToPath(new URL('../../..', import.meta.url));
}

test('contracts type authority fields as literal false and appliedAction as literal null', () => {
  const source = readFileSync(new URL('../../contracts/src/index.ts', import.meta.url), 'utf8');
  for (const field of ['authorityGranted', 'consentFabricated', 'verified', 'persisted']) {
    assert.match(source, new RegExp(`readonly ${field}: false;`));
    assert.equal(source.includes(`readonly ${field}: boolean`), false);
    assert.equal(source.includes(`${field}?: boolean`), false);
  }
  assert.match(source, /readonly appliedAction: null;/);
  assert.equal(/readonly appliedAction: (?!null;)/.test(source), false);
  assert.match(source, /export interface PlannedAction \{[^}]*readonly kind: 'abstain';/s);
  assert.equal(source.includes('grant-permission'), false);
  assert.equal(/kind: '(grant|workflow|verified|permission)/.test(source), false);
});

test('authority literals are assigned in one record builder', () => {
  const source = readFileSync(new URL('../src/kernel.ts', import.meta.url), 'utf8');
  assert.equal((source.match(/authorityGranted:\s*false/g) ?? []).length, 1);
  assert.equal((source.match(/consentFabricated:\s*false/g) ?? []).length, 1);
  assert.equal((source.match(/verified:\s*false/g) ?? []).length, 1);
  assert.equal((source.match(/persisted:\s*false/g) ?? []).length, 1);
  assert.equal((source.match(/appliedAction:\s*null/g) ?? []).length, 1);
  const start = source.indexOf('function buildRecord');
  assert.notEqual(start, -1);
  const signature = source.slice(start, source.indexOf('{', start));
  for (const field of ['authorityGranted', 'consentFabricated', 'verified', 'persisted', 'appliedAction']) {
    assert.equal(signature.includes(field), false);
  }
  assert.ok((source.match(/return buildRecord\(/g) ?? []).length >= 3);
  assert.equal(/confidence\s*[><]=?/.test(source), false);
  assert.equal(source.includes('0.99'), false);
  assert.equal(source.includes('CONFIDENCE_THRESHOLD'), false);
});

test('product action type has no grant kind and does not import the reference client', () => {
  const contracts = readFileSync(new URL('../../contracts/src/index.ts', import.meta.url), 'utf8');
  const validator = readFileSync(new URL('../src/validate-choice.ts', import.meta.url), 'utf8');
  const kernel = readFileSync(new URL('../src/kernel.ts', import.meta.url), 'utf8');
  assert.match(contracts, /readonly kind: 'abstain';/);
  assert.equal(/kind:\s*'grant/.test(contracts), false);
  assert.equal(contracts.includes('grant-permission'), false);
  assert.match(validator, /if \(!optionKeys\.includes\(answer\.choice\)\)/);
  for (const source of [contracts, validator, kernel]) {
    assert.equal(source.includes('ssot_docs/reference'), false);
    assert.equal(source.includes("from 'node:http'"), false);
    assert.equal(source.includes('https://api.typesafe.ai'), false);
  }
  assert.equal(validator.includes('grant-permission'), false);
});
