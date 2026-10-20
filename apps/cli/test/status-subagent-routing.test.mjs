// `jevris status` says whether Jevris can set a subagent's model for one call on each harness (its hooks.route certification) and
// what this workspace's recent launches got, so "Jevris seems to do nothing" is answerable from status alone. Pure rendering over the
// contract: no sidecar, no home, no harness binary.
import test from 'node:test';
import assert from 'node:assert/strict';

const { subagentRoutingLines } = await import('../dist/public/render.js');
const { StatusPayloadSchema, surfacePayloadContract } = await import('../../../packages/contracts/dist/index.js');

const view = (over = {}) => ({ harness: 'claude', version: '2.1.304', certified: true, certificationReasonCode: null, days: 7, launches: 0, routed: 0, advised: 0, leftAlone: 0, unknown: 0, reasons: [], ...over });

test('certified and used: the mode says what happens, the counts say what did, and the top reason is explained', () => {
  const lines = subagentRoutingLines([view({ launches: 12, routed: 2, advised: 1, leftAlone: 8, unknown: 1, reasons: [{ code: 'EXPLICIT_MODEL', count: 5 }, { code: 'RISK_HIGH', count: 3 }] })], 'bounded-auto');
  assert.deepEqual(lines, [
    'subagent routing claude 2.1.304: on (hooks.route certified); a launch that qualifies gets its model set for that one call',
    "  last 7 days: 12 launches: 2 had their model set for that call, 1 got advice only, 8 left on the session's model (EXPLICIT_MODEL 5, RISK_HIGH 3), 1 with no record of what was decided",
    '  most common reason, EXPLICIT_MODEL: the launch named its own model, which Jevris never overrides',
  ]);
});

test('the mode is named when it does not set a model: advise gives advice only, observe records only', () => {
  assert.match(subagentRoutingLines([view()], 'advise')[0], /on \(hooks\.route certified\); advice only in mode advise$/);
  assert.match(subagentRoutingLines([view()], 'observe')[0], /on \(hooks\.route certified\); recording only in mode observe$/);
  assert.equal(subagentRoutingLines([view()], 'bounded-auto')[1], '  last 7 days: no subagent launches seen in this workspace');
});

test('not certified: it says routing is off, why in words, and the one command that fixes it; a launch count still shows', () => {
  const cases = [
    ['NO_RECORD', /no signed certification record covers this harness here/],
    ['VERSION_OUT_OF_RANGE', /the installed version is outside the range its record covers/],
    ['EXPIRED', /its signed certification record has expired/],
    ['FEATURE_NOT_CERTIFIED', /the subagent route case did not pass when it was certified/],
  ];
  for (const [code, why] of cases) {
    const [head, count] = subagentRoutingLines([view({ certified: false, certificationReasonCode: code, launches: 4, leftAlone: 4, reasons: [{ code: 'NO_EVIDENCE', count: 4 }] })], 'bounded-auto');
    assert.match(head, /^subagent routing claude 2\.1\.304: off, hooks\.route is not certified \(/, code);
    assert.match(head, why, code);
    assert.match(head, /so a subagent keeps the model it is given; fix: jevris certify --harness all \(no model call\)$/, code);
    assert.match(count, /4 launches: 0 had their model set for that call, 0 got advice only, 4 left on the session's model \(NO_EVIDENCE 4\)/, code);
  }
  // No installed version recorded yet: certify is not the fix, a session or doctor is.
  assert.match(subagentRoutingLines([view({ version: null, certified: false, certificationReasonCode: 'HARNESS_VERSION_UNKNOWN' })], 'bounded-auto')[0], /^subagent routing claude: off, .*no installed version is recorded yet.*; start a session or run jevris doctor$/);
  // Antigravity has no actuator: say so, and do not send anyone to certify.
  const agy = subagentRoutingLines([view({ harness: 'antigravity', version: '1.2.14', certified: false, certificationReasonCode: 'NO_SUBAGENT_ACTUATOR' })], 'bounded-auto')[0];
  assert.match(agy, /^subagent routing antigravity 1\.2\.14: off, .*no hook that can set a subagent's model.*; advice text only$/);
  assert.doesNotMatch(agy, /certify/);
});

test('an unknown reason code is shown as itself, and the contract accepts the view and rejects a malformed one', () => {
  const lines = subagentRoutingLines([view({ launches: 1, leftAlone: 1, reasons: [{ code: 'SOMETHING_NEW', count: 1 }] })], 'bounded-auto');
  assert.equal(lines.length, 2, 'no explanation line for a code with no text');
  assert.match(lines[1], /SOMETHING_NEW 1/);
  const ok = view({ launches: 2, leftAlone: 2, reasons: [{ code: 'RISK_HIGH', count: 2 }] });
  const fields = StatusPayloadSchema.properties;
  assert.ok(fields.subagentRouting, 'status carries the field');
  const contract = surfacePayloadContract('status');
  assert.ok(contract, 'the status contract exists');
  const base = { jevrisMode: 'bounded-auto', killSwitch: 'clear', decisionHealth: 'healthy', degradedReason: null, routing: { modelPin: null, pinned: false }, activeWorkers: [], budget: { state: 'within', reservedMicroUsd: 0, limitMicroUsd: 1, spentMicroUsd: 0, resetsAt: '2026-11-01T00:00:00.000Z', workspace: null, exhaustedBy: null }, recentDecisions: [], unknownSlices: [], store: { state: 'ok', diagnostic: null } };
  const valid = (subagentRouting) => contract.validate({ ...base, subagentRouting });
  assert.equal(valid([ok]).ok, true, JSON.stringify(valid([ok])));
  assert.equal(valid([{ ...ok, version: 'latest' }]).ok, false, 'a version that is not x.y.z');
  assert.equal(valid([{ ...ok, launches: -1 }]).ok, false);
  assert.equal(valid([{ ...ok, extra: 1 }]).ok, false, 'no free-form field');
});
