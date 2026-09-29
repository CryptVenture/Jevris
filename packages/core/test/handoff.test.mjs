import test from 'node:test';
import assert from 'node:assert/strict';
import { importPortableCapsule } from '../dist/index.js';


const TRANSCRIPT = 'TRANSCRIPT_MUST_NOT_CROSS';

function capsule() {
  return {
    schemaVersion: '1.0',
    capsuleId: 'cap1',
    workspaceId: 'ws1',
    taskId: 'task1',
    policyVersion: 'pol1',
    evidenceRevision: 'rev1',
    userConstraints: [],
    taskIds: ['task1'],
    approvals: [
      { id: 'expired', scope: 'read', expiresAtMs: 1000, authorizesEffect: true },
      { id: 'older', scope: 'read', expiresAtMs: 999, authorizesEffect: true },
      { id: 'live', scope: 'read', expiresAtMs: 1001, authorizesEffect: true },
    ],
    sourceHashes: [],
    openChecks: [{ id: 'check1', state: 'open' }],
    restoreQueued: false,
    providerCalls: 0,
    applied: false,
    toolPermission: false,
    transcript: TRANSCRIPT,
  };
}

test('import drops expired approvals, omits transcripts, and does not actuate', () => {
  const nowMs = 1000;
  const result = importPortableCapsule(capsule(), nowMs, 'read');
  const text = JSON.stringify(result);
  assert.equal(text.includes(TRANSCRIPT), false);
  assert.equal(text.includes('expired'), false);
  assert.equal(text.includes('older'), false);
  assert.equal(Object.hasOwn(result, 'transcript'), false);
  assert.equal(Object.hasOwn(result, 'hookSpecificOutput'), false);
  assert.equal(text.includes('hookSpecificOutput'), false);
  assert.equal(text.includes('hookEventName'), false);
  const ids = result.approvals.map((item) => item.id);
  assert.equal(ids.includes('expired'), false);
  assert.equal(ids.includes('older'), false);
  assert.equal(ids.includes('live'), true);
  assert.equal(result.approvals.find((item) => item.id === 'live').authorizesEffect, false);
  const check = result.openChecks.find((item) => item.id === 'check1');
  assert.equal(check.state, 'open');
  assert.notEqual(check.state, 'passed');
  assert.equal(result.mode, 'blocked');
  assert.equal(result.functionality, 'reduced');
  assert.equal(result.authorizesEffect, false);
  assert.equal(result.applied, false);
  assert.equal(result.toolPermission, false);
  assert.equal(result.providerCalls, 0);
});

test('a missing target control stays blocked and is not Claude control JSON', () => {
  const input = capsule();
  delete input.targetControl;
  const result = importPortableCapsule(input, 1000, 'other-scope');
  assert.equal(result.mode, 'blocked');
  assert.equal(result.functionality, 'reduced');
  assert.equal(Object.hasOwn(result, 'hookSpecificOutput'), false);
  assert.equal(result.authorizesEffect, false);
  assert.equal(result.applied, false);
  assert.equal(result.toolPermission, false);
  assert.equal(result.providerCalls, 0);
});
