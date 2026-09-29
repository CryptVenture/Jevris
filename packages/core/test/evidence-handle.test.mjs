import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';


const {
  distillToolOutput,
  importCapsuleClaim,
  surfaceContradiction,
  adviseCompaction,
  auditOmissions,
} = await import('../dist/index.js');

const SOURCE_CANARY = 'SOURCE_CANARY_do_not_copy';


function repoRoot() {
  return fileURLToPath(new URL('../../..', import.meta.url));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assertNoLeak(value) {
  const text = JSON.stringify(value);
  assert.equal(text.includes(SOURCE_CANARY), false);
  assert.equal(text.includes('\u001b'), false);
  assert.equal(Object.hasOwn(value, 'source'), false);
}

test('distill keeps the handle and does not replace a failure', () => {
  const body = 'Error: assertion failed';
  const view = distillToolOutput({
    kind: 'tool-output',
    handle: 'handle-fail',
    body,
    errorState: 'failed',
    offsets: [{ start: 0, end: 5 }],
    source: SOURCE_CANARY,
  });
  assert.equal(view.handle, 'handle-fail');
  assert.equal(view.hash, sha256(body));
  assert.equal(view.errorState, 'failed');
  assert.deepEqual(view.offsets, [{ start: 0, end: 5 }]);
  assert.equal(view.passthrough, false);
  assert.equal(view.text.includes('succeeded'), false);
  assertNoLeak(view);
  const fabricated = distillToolOutput({
    kind: 'tool-output',
    handle: 'handle-lie',
    body: 'the tool succeeded',
    errorState: 'failed',
    offsets: [{ start: 0, end: 3 }],
  });
  assert.equal(fabricated.handle, 'handle-lie');
  assert.equal(fabricated.errorState, 'failed');
  assert.equal(fabricated.hash, sha256('the tool succeeded'));
  assert.equal(fabricated.text.includes('succeeded'), false);
  assert.equal(fabricated.passthrough, false);
  const ansi = distillToolOutput({
    kind: 'tool-output',
    handle: 'handle-ansi',
    body: 'Error: \u001b[31mfailed\u001b[0m',
    errorState: 'failed',
    offsets: [{ start: 0, end: 5 }],
  });
  assert.equal(ansi.errorState, 'failed');
  assert.equal(JSON.stringify(ansi).includes('\u001b'), false);
});

test('an unknown type passes through unchanged', () => {
  const original = { type: 'mystery', n: 1 };
  const passed = distillToolOutput(original);
  assert.equal(passed.passthrough, true);
  assert.equal(passed.value, original);
  assert.equal(typeof passed.hash, 'string');
  assert.equal(passed.hash.length, 64);
  const numberValue = distillToolOutput(7);
  assert.equal(numberValue.passthrough, true);
  assert.equal(numberValue.value, 7);
});

test('a capsule claim stays a hypothesis and a contradiction does not replace a requirement', () => {
  const claim = importCapsuleClaim({
    text: 'cache is the root cause',
    provenanceId: 'prov-session',
    status: 'accepted',
    source: SOURCE_CANARY,
  });
  assert.equal(claim.status, 'hypothesis');
  assert.equal(claim.provenanceId, 'prov-session');
  assert.equal(claim.acceptedRequirement, false);
  assertNoLeak(claim);
  const surfaced = surfaceContradiction({
    claims: ['accepted fact', 'newer guess'],
    acceptedRequirementId: 'req-keep',
    replacementId: 'req-new',
    source: SOURCE_CANARY,
  });
  assert.deepEqual(surfaced.claims, ['accepted fact', 'newer guess']);
  assert.equal(surfaced.acceptedRequirementId, 'req-keep');
  assertNoLeak(surfaced);
});

test('compaction advice has no replacement summary and omissions restore mandatory ids', () => {
  const allowed = adviseCompaction({ pending: 'work', source: SOURCE_CANARY });
  assert.equal(allowed.nativeAllowed, true);
  assert.equal(allowed.deferred, false);
  assert.equal(typeof allowed.boundary, 'string');
  assert.equal(allowed.boundary.length > 0, true);
  assert.equal(Object.hasOwn(allowed, 'replacementSummary'), false);
  assert.equal(JSON.stringify(allowed).includes('replacementSummary'), false);
  assertNoLeak(allowed);
  const deferred = adviseCompaction({ safeTriggerEvidence: true });
  assert.equal(deferred.deferred, true);
  assert.equal(deferred.nativeAllowed, true);
  const sentence = adviseCompaction({ safeTriggerEvidence: 'the model says defer' });
  assert.equal(sentence.deferred, false);
  assert.equal(sentence.nativeAllowed, true);
  const audit = auditOmissions({
    mandatoryConstraintIds: ['pin-model', 'no-egress'],
    presentConstraintIds: ['pin-model'],
    score: 0.01,
    source: SOURCE_CANARY,
  });
  assert.deepEqual(audit.missingConstraintIds, ['no-egress']);
  assert.deepEqual(audit.restoredMandatoryIds, ['pin-model', 'no-egress']);
  assertNoLeak(audit);
  const root = repoRoot();
  const hooks = readFileSync(join(root, 'plugins/claude/hooks/hooks.json'), 'utf8');
  assert.equal(hooks.includes('/Users/'), false);
  assert.equal(hooks.includes('/Volumes/'), false);
  assert.equal(hooks.includes('${CLAUDE_PLUGIN_ROOT}/bin/hook.js'), true);
});
