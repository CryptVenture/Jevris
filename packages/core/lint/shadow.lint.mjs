import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-text checks moved from packages/core/test/shadow.test.mjs (QA-07). Lint reads src/ and needs no build.
function repoRoot() {
  return fileURLToPath(new URL('../../..', import.meta.url));
}

test('the contracts barrel re-exports the comparison type and keeps the pinned model (source)', () => {
  const barrel = readFileSync(new URL('../../contracts/src/index.ts', import.meta.url), 'utf8');
  assert.equal(barrel.includes('export type { ShadowComparisonFile }'), true);
});

test('shadow does not widen observe, the runtime module, or the hook adapter (source)', () => {
  const observe = readFileSync(new URL('../src/observe.ts', import.meta.url), 'utf8');
  const observeContract = readFileSync(new URL('../../contracts/src/observe.ts', import.meta.url), 'utf8');
  assert.equal(observe.includes("mode: 'observe'"), true);
  assert.equal(observe.includes("mode: 'shadow'"), false);
  assert.equal(observeContract.includes("mode: 'observe'"), true);
  assert.equal(observeContract.includes("mode: 'shadow'"), false);

  const banned = [
    'runtime.js',
    'kernel.js',
    'hook-adapter.js',
    'ledger.js',
    '@typesafe-ai/sdk',
    'ssot_docs/reference',
    'api.typesafe.ai',
    'fetch(',
  ];
  const shadow = readFileSync(new URL('../src/shadow.ts', import.meta.url), 'utf8');
  const contract = readFileSync(new URL('../../contracts/src/shadow.ts', import.meta.url), 'utf8');
  for (const item of banned) {
    assert.equal(shadow.includes(item), false, item);
    assert.equal(contract.includes(item), false, item);
  }
  const runtime = readFileSync(new URL('../src/runtime.ts', import.meta.url), 'utf8');
  const hook = readFileSync(new URL('../src/hook-adapter.ts', import.meta.url), 'utf8');
  assert.equal(runtime.includes('shadow.js'), false);
  assert.equal(hook.includes('shadow.js'), false);
});

const CLOSED_REASONS = ['preference', 'unavailable-context', 'error', 'unspecified'];

test('the contracts barrel re-exports the feedback type and does not widen the comparison (source)', () => {
  const barrel = readFileSync(new URL('../../contracts/src/index.ts', import.meta.url), 'utf8');
  const contract = readFileSync(new URL('../../contracts/src/shadow.ts', import.meta.url), 'utf8');
  assert.equal(barrel.includes('RecommendationFeedbackFile'), true);
  assert.equal(contract.includes('FEEDBACK_KEYS'), true);
  for (const reason of CLOSED_REASONS) {
    assert.equal(contract.includes(`'${reason}'`), true, reason);
  }
});

test('rules do not import shadow and the draft contract stays unpublished (source)', () => {
  const barrel = readFileSync(new URL('../../contracts/src/index.ts', import.meta.url), 'utf8');
  const contract = readFileSync(new URL('../../contracts/src/shadow.ts', import.meta.url), 'utf8');
  const shadow = readFileSync(new URL('../src/shadow.ts', import.meta.url), 'utf8');
  const rules = readFileSync(new URL('../src/rules.ts', import.meta.url), 'utf8');
  const runtime = readFileSync(new URL('../src/runtime.ts', import.meta.url), 'utf8');
  assert.equal(rules.includes('shadow.js'), false);
  assert.equal(rules.includes("from './shadow"), false);
  assert.equal(runtime.includes('shadow.js'), false);
  assert.equal(shadow.includes('allowUncalibratedActuation'), false);
  assert.equal(shadow.includes('homedir'), false);
  assert.equal(shadow.includes('.jevris/packs'), false);
  assert.equal(shadow.includes('loadPacks'), false);
  assert.equal(contract.includes('DRAFT_KEYS'), true);
  assert.equal(contract.includes("'calibration-proposal'"), true);
  assert.equal(barrel.includes('CalibrationDraftFile'), true);
});
