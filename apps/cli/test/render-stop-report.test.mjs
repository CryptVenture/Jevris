// VER-05, US23: the last unverified stop report reaches verify and status. The field is
// optional (absent or null when there is none), its shape is checked, and the CLI prints it.
import test from 'node:test';
import assert from 'node:assert/strict';

const c = await import('../../../packages/contracts/dist/index.js');
const { renderHuman } = await import('../dist/public/render.js');

const report = { outcome: 'unverified', text: 'Unverified: unit has no current passing receipt.', at: '2026-09-26T10:00:00.000Z', missingEvidence: ['unit'], uncoveredRequirements: ['REQ-1'] };
const verify = { ran: false, readiness: 'not-verified', checks: [], missing: ['unit'] };
const status = {
  jevrisMode: 'observe', killSwitch: 'clear', decisionHealth: 'healthy', degradedReason: null,
  routing: { modelPin: null, pinned: false }, activeWorkers: [], budget: { state: 'within', reservedMicroUsd: 0, limitMicroUsd: 5000000 },
  recentDecisions: [], unknownSlices: [], store: { state: 'ok', diagnostic: null },
};
const wrap = (command, result) => ({ schemaVersion: '1.0', command, mode: 'full', sidecar: { state: 'running', reasonCode: null, message: null }, workspace: { id: 'ws-0123456789abcdef', root: null }, summary: 'A summary.', result });

for (const [op, payload] of [['verify', verify], ['status', status]]) {
  test(`${op}: stopReport is optional, nullable and checked`, () => {
    const contract = c.surfacePayloadContract(op);
    assert.equal(contract.validate(payload).ok, true, JSON.stringify(contract.validate(payload)));
    assert.equal(contract.validate({ ...payload, stopReport: null }).ok, true);
    assert.equal(contract.validate({ ...payload, stopReport: report }).ok, true);
    assert.equal(contract.validate({ ...payload, stopReport: { ...report, outcome: 'verified' } }).ok, false, 'only an unverified stop is reported');
    assert.equal(contract.validate({ ...payload, stopReport: { ...report, text: 'x'.repeat(1001) } }).ok, false);
    assert.equal(contract.validate({ ...payload, stopReport: { ...report, at: 'yesterday' } }).ok, false);
    assert.equal(contract.validate({ ...payload, stopReport: { ...report, missingEvidence: ['../x'] } }).ok, false);
  });

  test(`${op}: the CLI prints the last stop, and nothing when there is none`, () => {
    const text = renderHuman(wrap(op, { ...payload, stopReport: report }));
    assert.match(text, /^last stop \(2026-09-26T10:00:00\.000Z\): Unverified: unit has no current passing receipt\.$/m);
    assert.match(text, /^last stop missing evidence: unit$/m);
    assert.match(text, /^last stop uncovered requirements: REQ-1$/m);
    assert.doesNotMatch(renderHuman(wrap(op, { ...payload, stopReport: null })), /last stop/);
    assert.doesNotMatch(renderHuman(wrap(op, payload)), /last stop/);
  });
}
