import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testFiles } from './test-hygiene.lint.mjs';

/**
 * Negative-lock tests (QA-02, §22.2). A negative lock asserts that a gate stays failed, a
 * holdout stays empty or a platform or harness stays unsupported whatever the evidence, so the
 * suite would break the day the evidence arrives. The rule is a paired conditional test:
 * missing or invalid evidence gives not-a-pass, and valid synthetic evidence gives pass.
 *
 * A test that refuses a bad input ("a failed probe stays unsupported") is not a negative
 * lock. A test is one when it holds the negative outcome on valid input, or on a fixture that
 * encodes the negative state.
 *
 * The ratchet that listed the remaining findings is empty and gone: every finding fails lint.
 */

const root = fileURLToPath(new URL('..', import.meta.url));

export const NEGATIVE_LOCK = [
  { id: 'empty-holdout-title', pattern: /\btest\(\s*['"`][^'"`]*\bholdout (?:is|stays|remains) empty/ },
  { id: 'unsupported-despite-evidence', pattern: /\btest\(\s*['"`][^'"`]*\b(?:stays|remains) (?:unsupported|uncertified|not passed|failed) (?:when|with|even|despite)[^'"`]*\b(?:present|approved|valid|signed|fresh|passing)\b/ },
  { id: 'gate-never-passed', pattern: /assert\.notEqual\([^)]*\b(?:qualityGate|gate|verdict|status)\b[^)]*,\s*['"]passed?['"]\s*\)/ },
  { id: 'empty-holdout-fixture', pattern: /assert\.\w+\([^)]*['"]holdout-empty-[\d-]+['"]/ },
];

/** Finding ids (`path:rule`) in one test file's text. */
export function negativeLocks(text) {
  const found = new Set();
  for (const line of text.split('\n')) {
    for (const rule of NEGATIVE_LOCK) if (rule.pattern.test(line)) found.add(rule.id);
  }
  return [...found].sort();
}

function findings() {
  const out = [];
  for (const file of testFiles()) {
    const rel = relative(root, file).split(sep).join('/');
    for (const id of negativeLocks(readFileSync(file, 'utf8'))) out.push(`${rel}:${id}`);
  }
  return out.sort();
}

// The ratchet emptied (QA-02 done); there is no allowlist, so any negative lock fails lint.
test('no negative-lock test anywhere; paired conditional tests only (QA-02)', () => {
  assert.deepEqual(findings(), [], 'write a paired test: missing or invalid evidence gives not-a-pass, valid synthetic evidence gives pass');
});

test('the detector separates negative locks from refusals of bad input (QA-02)', () => {
  assert.deepEqual(negativeLocks("test('the frozen holdout is empty and the gate is not passed', () => {"), ['empty-holdout-title']);
  assert.deepEqual(negativeLocks("test('verification stays unsupported when a runner manifest is present', async () => {"), ['unsupported-despite-evidence']);
  assert.deepEqual(negativeLocks("  assert.notEqual(parsed.qualityGate, 'passed');"), ['gate-never-passed']);
  assert.deepEqual(negativeLocks("  assert.equal(record.holdoutId, 'holdout-empty-2026-09-23');"), ['empty-holdout-fixture']);
  assert.deepEqual(negativeLocks("test('a non-zero doctor exit, a timeout, or a non-dotted token stays unsupported', async () => {"), []);
  assert.deepEqual(negativeLocks("test('a missing target control stays blocked', () => {"), []);
  assert.deepEqual(negativeLocks("test('an unsigned record gives not-a-pass and a signed one passes', () => {"), []);
});
