import test from 'node:test';
import assert from 'node:assert/strict';

// The GOV-14 evidence producer: every THREAT_CASES case is mapped, a case passes only when
// each test it names ran and passed, and pipe-squat is not applicable off Windows.

const { CASE_TESTS, caseResults, tapOutcomes } = await import('../scripts/threat-model-suite.mjs');
const { THREAT_CASES } = await import('@jevris/contracts');

test('every threat-model case is mapped to at least one product test (GOV-14)', () => {
  assert.deepEqual(Object.keys(CASE_TESTS).sort(), [...THREAT_CASES].sort());
  for (const [id, spec] of Object.entries(CASE_TESTS)) assert.ok(spec.tests.length > 0, id);
});

test('a case passes only when every named test ran and passed; a skip or a missing test fails it (GOV-14)', () => {
  const allPass = new Map();
  for (const spec of Object.values(CASE_TESTS)) for (const [, name] of spec.tests) allPass.set(`${name} (X-01)`, 'pass');
  const onLinux = caseResults(allPass, 'linux');
  assert.deepEqual(onLinux.filter((item) => !item.passed && !item.notApplicable), []);
  assert.deepEqual(onLinux.find((item) => item.id === 'pipe-squat'), { id: 'pipe-squat', passed: false, notApplicable: true });
  assert.equal(caseResults(allPass, 'win32').find((item) => item.id === 'pipe-squat').passed, true);

  const skipped = new Map(allPass);
  const [, crossUser] = CASE_TESTS['cross-user-ipc'].tests[0];
  skipped.set(`${crossUser} (X-01)`, 'skip');
  assert.equal(caseResults(skipped, 'linux').find((item) => item.id === 'cross-user-ipc').passed, false);

  const missing = new Map([...allPass].filter(([name]) => !name.startsWith(CASE_TESTS.replay.tests[0][1])));
  assert.equal(caseResults(missing, 'darwin').find((item) => item.id === 'replay').passed, false);
});

test('TAP lines map to pass, fail and skip, and a repeated name keeps its worst outcome', () => {
  const tap = ['ok 1 - alpha case', 'not ok 2 - beta case', 'ok 3 - gamma case # SKIP no second user', '    ok 1 - nested case', 'ok 4 - beta case', 'not ok 5 - alpha case'].join('\n');
  const outcomes = tapOutcomes(tap);
  assert.equal(outcomes.get('alpha case'), 'fail');
  assert.equal(outcomes.get('beta case'), 'fail');
  assert.equal(outcomes.get('gamma case'), 'skip');
  assert.equal(outcomes.get('nested case'), 'pass');
});
