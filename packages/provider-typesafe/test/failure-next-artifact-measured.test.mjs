// Why the repeated-failure advice does not ask Jev which artifact to get next (decision of 2026-10-04). The rule the
// decision set: keep a question that reads the failure's first line only if it clears the floors (a provider confidence
// of 0.6 and a margin of 0.15 over the runner-up) on most cases and picks the expected artifact on those that clear.
// fixtures/failure-next-artifact-measured.json holds the numbers of the real jev-1.13.0 answers (24: twelve synthetic
// failure lines, two runs each, with the first line as one screened span and source egress approved), and this test
// applies the rule to them. If a later run of the question clears the rule, re-measure before asking it again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const core = await import('@jevris/core');
const provider = await import('../dist/index.js');
const MEASURED = JSON.parse(readFileSync(new URL('./fixtures/failure-next-artifact-measured.json', import.meta.url), 'utf8'));

test('the measured answers: the Choice on the failure\'s first line cleared the floors in 2 of 24, so it is not asked', () => {
  const rows = MEASURED.rows;
  assert.equal(rows.length, 24);
  assert.equal(new Set(rows.map((r) => r.id)).size, 12, 'twelve kinds of failure, two runs each');
  const clears = (r) => r.confidence >= core.INTENT_MIN_CONFIDENCE && r.margin >= core.INTENT_MIN_MARGIN;
  assert.equal(provider.FAILURE_MIN_CONFIDENCE, core.INTENT_MIN_CONFIDENCE, 'the floors are the product\'s, not tuned for this question');
  const cleared = rows.filter(clears);
  assert.deepEqual(cleared.map((r) => r.id), ['build-config', 'build-config'], 'one kind of failure, both runs');
  assert.ok(cleared.length * 2 < rows.length, 'most cases do not clear the floors, so the rule says remove the question');
  assert.ok(cleared.every((r) => r.choice === r.expected), 'where it cleared it was right: that alone does not keep a question that clears on 1 case of 12');
  assert.equal(rows.filter((r) => r.choice === r.expected).length, 10, 'and it ranked the expected artifact first in 10 of 24');
  const confidences = rows.map((r) => r.confidence).sort((a, b) => a - b);
  assert.equal(confidences[Math.floor(confidences.length / 2)] < core.INTENT_MIN_CONFIDENCE, true, 'the median confidence is under the floor');
  // The failures the product's own rule calls environmental never reach the question in any case (the rules are sure).
  assert.deepEqual(rows.filter((r) => r.environmentalByRule).map((r) => r.id).sort(), ['network-refused', 'network-refused', 'permission-denied', 'permission-denied']);
  for (const r of rows) assert.deepEqual(Object.keys(r).sort(), ['choice', 'confidence', 'environmentalByRule', 'expected', 'id', 'inputTokens', 'kind', 'margin', 'outputTokens', 'repeat', 'sufficientNoul'], 'numbers and fixed labels only');
});

test('nothing asks it any more: the adviser has no Choice, with or without egress, and C05 takes no engine', () => {
  assert.equal(core.checkEvidenceSufficiency.length, 1);
  for (const id of Object.keys(provider.FAILURE_ARTIFACT_TEXT)) assert.deepEqual(Object.keys(provider.FAILURE_ARTIFACT_TEXT[id]), ['phrase'], `${id} has a phrase for the advice line and no option text`);
  const plan = provider.planFailureAdvice(provider.failureContextOf(provider.parseFailureFeatures({ toolClass: 'shell', exitClass: 'nonzero', family: 'shell:nonzero', signature: 'aaaaaaaaaaaaaaaa', commandDigest: 'cccccccccccccccc', environmental: false, elapsed: 'lt10s', present: [] }), { attempts: 2, sameCommand: true, editsSince: 0, unsure: false, previous: null }, 2));
  assert.deepEqual([plan.step, plan.next, plan.rulesCode, plan.askSame], ['artifact', 'failing-test-output', 'REPEATED_FAILURE_NEXT_RULES', false]);
});
