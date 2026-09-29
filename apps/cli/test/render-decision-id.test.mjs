// MEM-04, REC-01, CMD-02: checkpoint and recover answers may name the decision they were recorded
// as. The field is optional in the contract (absent or null when no decision was recorded), a
// malformed id is refused, and the CLI prints it with the command that explains it.
import test from 'node:test';
import assert from 'node:assert/strict';

const c = await import('../../../packages/contracts/dist/index.js');
const { renderHuman } = await import('../dist/public/render.js');

const checkpoint = {
  capsuleId: 'cap-1',
  handle: 'capsule:cap-1',
  written: true,
  retained: { constraints: 1, changedFiles: 0, openChecks: 0, unresolved: 0, hypotheses: 0 },
  items: [{ kind: 'constraint', text: 'Keep the public API stable.' }],
  compactionTriggered: false,
};
const recover = {
  classification: 'repeated-failure',
  action: 'rerun-check-once',
  advice: 'Run the failing check once more.',
  signals: { failures: 3, distinctFingerprints: 1, maxRepeat: 3, environmentFailures: 0 },
  rejectedApproaches: [],
};
const result = (command, payload) => ({
  schemaVersion: '1.0',
  command,
  mode: 'full',
  sidecar: { state: 'running', reasonCode: null, message: null },
  workspace: { id: 'ws-0123456789abcdef', root: null },
  summary: 'A summary.',
  result: payload,
});

for (const [op, payload] of [['checkpoint', checkpoint], ['recover', recover]]) {
  test(`${op}: decisionId is optional, nullable and checked`, () => {
    const contract = c.surfacePayloadContract(op);
    assert.equal(contract.validate(payload).ok, true, 'absent');
    assert.equal(contract.validate({ ...payload, decisionId: null }).ok, true, 'null');
    assert.equal(contract.validate({ ...payload, decisionId: 'd-1f2e' }).ok, true, 'an id');
    assert.equal(contract.validate({ ...payload, decisionId: '../d' }).ok, false, 'a malformed id');
    assert.equal(contract.validate({ ...payload, decisionId: 7 }).ok, false, 'not a string');
  });

  test(`${op}: the CLI names the decision and how to explain it, and prints nothing when there is none`, () => {
    assert.match(renderHuman(result(op, { ...payload, decisionId: 'd-1f2e' })), /^decision: d-1f2e \(jevris explain d-1f2e\)$/m);
    assert.doesNotMatch(renderHuman(result(op, { ...payload, decisionId: null })), /^decision:/m);
    assert.doesNotMatch(renderHuman(result(op, payload)), /^decision:/m);
  });
}
