// A capability consult waits for the engine at most the background budget (5 s) when its caller names no deadline, and
// never longer than the op has left. A test run's budget scale (JEVRIS_TEST_BUDGET_SCALE, only under JEVRIS_TEST=1)
// lengthens that cap with the background budget; a caller's own deadline is never scaled.
import test from 'node:test';
import assert from 'node:assert/strict';

const { consultChoice } = await import('../dist/index.js');

const base = { capabilityId: 'C29', specVersion: '1', objective: 'o', workspaceId: 'ws-1', evidenceRevision: 'r1', evidence: [], instructions: 'pick', options: { a: 'A', b: 'B' }, rules: () => ({ choice: 'b', reasonCode: 'R' }) };

/** The deadline the consult gave the engine, under these environment variables (undefined removes one). */
async function specDeadline(vars, extra = {}) {
  const calls = [];
  const engine = { async decide(request) { calls.push(request); return { abstained: true, reasonCode: 'LOW_CONFIDENCE', decisionId: 'dec-1', fallback: 'rules-only' }; } };
  const before = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await consultChoice(engine, { ...base, ...extra });
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(calls.length, 1, 'the engine was asked once');
  return calls[0].spec.deadlineMs;
}

test('the consult default wait is 5 s, scaled with the background budget in a test run, and the op\'s time left still ends it first', async () => {
  assert.equal(await specDeadline({ JEVRIS_TEST: '1', JEVRIS_TEST_BUDGET_SCALE: undefined }), 5000);
  assert.equal(await specDeadline({ JEVRIS_TEST: '1', JEVRIS_TEST_BUDGET_SCALE: '6' }), 30_000);
  // Without JEVRIS_TEST=1 the variable is ignored.
  assert.equal(await specDeadline({ JEVRIS_TEST: undefined, JEVRIS_TEST_BUDGET_SCALE: '6' }), 5000);
  // The op's remaining time less the margin ends the wait, scaled or not.
  assert.equal(await specDeadline({ JEVRIS_TEST: '1', JEVRIS_TEST_BUDGET_SCALE: '6' }, { remainingMs: 2150 }), 2000);
  assert.equal(await specDeadline({ JEVRIS_TEST: undefined, JEVRIS_TEST_BUDGET_SCALE: undefined }, { remainingMs: 900 }), 750);
  // A deadline the caller names is the caller's: never scaled.
  assert.equal(await specDeadline({ JEVRIS_TEST: '1', JEVRIS_TEST_BUDGET_SCALE: '6' }, { deadlineMs: 1000 }), 1000);
});
