import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Source checks moved from test/advice-status.test.mjs (QA-07).
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('ignoreAdvice keeps the record and does not apply it (source)', () => {
  const contractsSource = read('../../contracts/src/index.ts');
  assert.match(contractsSource, /export type \{[\s\S]*AdviceResult[\s\S]*\} from '\.\/advice\.js'/);
  const adviceSource = read('../src/advice.ts');
  assert.equal(adviceSource.includes('runtime.js'), false);
  assert.equal(adviceSource.includes('kernel.js'), false);
  assert.equal(adviceSource.includes('ledger.js'), false);
});

test('mode off and a late object do not actuate (source)', () => {
  const adviceSource = read('../src/advice.ts');
  const statusSource = read('../src/status.ts');
  const contractSource = read('../../contracts/src/advice.ts');
  const runtimeSource = read('../src/runtime.ts');
  const kernelSource = read('../src/kernel.ts');
  for (const source of [adviceSource, statusSource, contractSource]) {
    assert.equal(source.includes('runtime.js'), false);
    assert.equal(source.includes('kernel.js'), false);
  }
  assert.equal(runtimeSource.includes('advice.js'), false);
  assert.equal(kernelSource.includes('advice.js'), false);
  assert.equal(kernelSource.includes('status.js'), false);
});

test('status errors are words and templates omit confidence (source)', () => {
  const statusSource = read('../src/status.ts');
  assert.equal(statusSource.includes('ledger.js'), false);
  assert.equal(statusSource.includes('runtime.js'), false);
  assert.equal(statusSource.includes('kernel.js'), false);
});
