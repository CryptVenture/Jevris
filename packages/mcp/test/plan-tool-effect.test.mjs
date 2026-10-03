// Review of the plan slice hints (item 5): `jevris_plan` was labelled `read` and said "Read-only", but a
// plan check now records up to 256 advisory decisions in the local journal and, with Jev on, may spend
// Jev budget (at most 8 questions). It is advice that records, like `jevris_plan_route`, so it carries
// the `advise` effect and says so. The `advise` and `read` classes both give `readOnlyHint: true`, so
// no client sees a change in its annotations.
import test from 'node:test';
import assert from 'node:assert/strict';

const { TOOLS } = await import('../dist/server.js');
const { annotationsFor } = await import('../dist/tools.js');

const tool = (name) => TOOLS.find((t) => t.name === name);

test('jevris_plan is an advice tool that records, and its description says so instead of "Read-only"', () => {
  const plan = tool('jevris_plan');
  assert.equal(plan.effect, 'advise');
  assert.doesNotMatch(plan.description, /Read-only/i);
  assert.match(plan.description, /advice only/i);
  assert.match(plan.description, /records one advisory decision per labelled task/i);
  assert.match(plan.description, /Jev/);
  assert.match(plan.description, /sliceSuggestions/, 'the field it carries is still named');
  assert.match(plan.description, /cycles, unknown dependencies/, 'and what it validates');
});

test('the annotations clients see are unchanged: read-only, not destructive, idempotent, closed world', () => {
  assert.deepEqual(annotationsFor(tool('jevris_plan')), { title: 'Validate a plan', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
});

test('a tool that says "Read-only" has the read effect, so a description never claims what its class does not', () => {
  for (const t of TOOLS) {
    if (/\bRead-only\b/.test(t.description)) assert.equal(t.effect, 'read', `${t.name} says Read-only but is ${t.effect}`);
  }
});

test('the other advice tools that record decisions keep their class', () => {
  for (const name of ['jevris_plan_route', 'jevris_recover']) assert.equal(tool(name).effect, 'advise', name);
});
