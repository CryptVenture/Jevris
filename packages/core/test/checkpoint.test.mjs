import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


const {
  persistMandatoryFacts,
  loadMatchingSubset,
  handleCheckpointHook,
  issueLocalCallerToken,
  authorizeLocalCaller,
} = await import('../dist/index.js');

const CAPSULE_KEYS = [
  'schemaVersion',
  'capsuleId',
  'workspaceId',
  'taskId',
  'policyVersion',
  'evidenceRevision',
  'userConstraints',
  'taskIds',
  'approvals',
  'sourceHashes',
  'openChecks',
  'restoreQueued',
  'providerCalls',
  'applied',
  'toolPermission',
];

const TRANSCRIPT = '/tmp/jevris-do-not-open.jsonl';
const COMPAT_TEXT = 'Use Node 22 or 24.';
const SECURITY_TEXT = 'Do not grant a tool permission.';
const APPROVAL_LINE = 'Historical approval appr1 scope read does not authorize a new effect.';

function fixture(name) {
  return readFileSync(new URL(`../../../fixtures/hooks/${name}`, import.meta.url), 'utf8');
}

function acceptedCaller() {
  const issued = issueLocalCallerToken({
    user: 'dev-one',
    pid: 4242,
    nowMs: 1000,
    expiresAtMs: 5000,
  });
  assert.equal(issued.ok, true);
  const credential = {
    user: 'dev-one',
    pid: 4242,
    expiresAtMs: 5000,
    token: issued.token,
  };
  const presented = {
    host: '127.0.0.1',
    user: 'dev-one',
    pid: 4242,
    token: issued.token,
  };
  const auth = authorizeLocalCaller(presented, 'dev-one', 4242, credential, 1000, false);
  assert.equal(auth.decision, 'accept');
  return {
    expectedUser: 'dev-one',
    expectedPid: 4242,
    credential,
    presented,
    consumed: false,
    nowMs: 1000,
    deadlineAtMs: 1000,
  };
}

test('mandatory facts persist under a due deadline and one missing constraint is restored', async () => {
  const caller = acceptedCaller();
  const dir = mkdtempSync(join(tmpdir(), 'jevris-checkpoint-'));
  const destination = join(dir, 'capsule.json');
  let rankCalls = 0;
  function rank() {
    rankCalls += 1;
    throw new Error('rank must not run');
  }
  const facts = {
    capsuleId: 'cap1',
    workspaceId: 'ws1',
    taskId: 'taskA',
    policyVersion: 'policyV1',
    evidenceRevision: 'revA',
    taskIds: ['taskA'],
    userConstraints: [
      { id: 'compat1', kind: 'compatibility', text: COMPAT_TEXT },
      { id: 'sec1', kind: 'security', text: SECURITY_TEXT },
    ],
    approvals: [{ id: 'appr1', scope: 'read', expiresAtMs: 9000, authorizesEffect: true }],
    sourceHashes: [{ path: 'src/app.ts', hash: 'abc123hash' }],
    openChecks: [{ id: 'check1', state: 'open' }],
    rank,
  };
  const preStdin = fixture('pre-compact.json');
  const postStdin = fixture('post-compact.json');
  const startStdin = fixture('session-start-compact.json');
  assert.equal(existsSync(TRANSCRIPT), false);
  assert.equal(existsSync('src/app.ts'), false);

  try {
    const persisted = await persistMandatoryFacts({ ...caller, ...facts, destination });
    assert.equal(persisted.providerCalls, 0);
    assert.equal(persisted.applied, false);
    assert.equal(persisted.toolPermission, false);
    assert.equal(rankCalls, 0);

    const pre = await handleCheckpointHook({
      ...caller,
      ...facts,
      destination,
      stdin: preStdin,
    });
    assert.equal(pre.exitCode, 0);
    assert.equal(pre.stdout, '');
    assert.equal(rankCalls, 0);
    assert.equal(existsSync(destination), true);
    assert.equal(existsSync(TRANSCRIPT), false);
    assert.equal(existsSync('src/app.ts'), false);

    const file = JSON.parse(readFileSync(destination, 'utf8'));
    assert.deepEqual(Object.keys(file), CAPSULE_KEYS);
    assert.equal(file.providerCalls, 0);
    assert.equal(file.applied, false);
    assert.equal(file.toolPermission, false);
    assert.equal(file.userConstraints[0].text, COMPAT_TEXT);
    assert.equal(file.userConstraints[1].text, SECURITY_TEXT);
    assert.equal(file.approvals[0].authorizesEffect, false);
    assert.equal(file.approvals[0].id, 'appr1');
    assert.equal(file.openChecks[0].id, 'check1');
    assert.equal(file.openChecks[0].state, 'open');
    assert.deepEqual(file.sourceHashes, [{ path: 'src/app.ts', hash: 'abc123hash' }]);
    assert.equal(file.taskIds.includes('taskA'), true);

    const loaded = await loadMatchingSubset({
      ...caller,
      destination,
      workspaceId: 'ws1',
      taskId: 'taskA',
    });
    assert.equal(loaded.matched, true);
    assert.equal(loaded.authorizesEffect, false);
    assert.equal(loaded.toolPermission, false);
    assert.equal(loaded.applied, false);
    assert.equal(loaded.providerCalls, 0);
    assert.equal(loaded.subset.userConstraints[1].text, SECURITY_TEXT);
    assert.equal(loaded.subset.approvals[0].authorizesEffect, false);

    const other = await loadMatchingSubset({
      ...caller,
      destination,
      workspaceId: 'ws1',
      taskId: 'taskB',
    });
    assert.equal(other.matched, false);
    assert.equal(other.subset, null);
    assert.equal(other.authorizesEffect, false);

    const post = await handleCheckpointHook({
      ...caller,
      ...facts,
      destination,
      stdin: postStdin,
    });
    assert.equal(post.exitCode, 0);
    assert.equal(post.stdout, '');
    const queued = JSON.parse(readFileSync(destination, 'utf8'));
    assert.equal(queued.restoreQueued, true);
    assert.equal(queued.userConstraints[1].id, 'sec1');
    assert.equal(queued.userConstraints[1].text, SECURITY_TEXT);
    assert.equal(JSON.stringify(queued).includes('Kept compat1'), false);

    const start = await handleCheckpointHook({
      ...caller,
      ...facts,
      destination,
      stdin: startStdin,
    });
    assert.equal(start.exitCode, 0);
    assert.equal(start.providerCalls, 0);
    const restored = JSON.parse(start.stdout);
    const context = restored.hookSpecificOutput.additionalContext;
    assert.equal(restored.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.equal(context.includes(SECURITY_TEXT), true);
    assert.equal(context.includes(APPROVAL_LINE), true);
    assert.equal(context.includes('?'), false);
    assert.equal(context.includes('\u001b'), false);
    const after = JSON.parse(readFileSync(destination, 'utf8'));
    assert.equal(after.providerCalls, 0);
    assert.equal(existsSync(TRANSCRIPT), false);
    assert.equal(existsSync('src/app.ts'), false);
    assert.equal(rankCalls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function baseFacts() {
  return {
    capsuleId: 'cap1',
    workspaceId: 'ws1',
    taskId: 'taskA',
    policyVersion: 'policyV1',
    evidenceRevision: 'revA',
    taskIds: ['taskA'],
    userConstraints: [
      { id: 'compat1', kind: 'compatibility', text: COMPAT_TEXT },
      { id: 'sec1', kind: 'security', text: SECURITY_TEXT },
    ],
    approvals: [{ id: 'appr1', scope: 'read', expiresAtMs: 9000, authorizesEffect: true }],
    sourceHashes: [{ path: 'src/app.ts', hash: 'abc123hash' }],
    openChecks: [{ id: 'check1', state: 'open' }],
    optionalSpans: [{ start: 1, end: 4 }],
    hypothesis: 'HYPOTHESIS_CANARY_do_not_store',
  };
}

test('a rejected caller writes nothing and PreCompact still allows compaction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-checkpoint-'));
  const destination = join(dir, 'capsule.json');
  let rankCalls = 0;
  try {
    const result = await persistMandatoryFacts({
      ...baseFacts(),
      destination,
      expectedUser: 'dev-one',
      expectedPid: 4242,
      credential: null,
      presented: { host: 'localhost' },
      consumed: false,
      nowMs: 1000,
      deadlineAtMs: 1000,
      rank() {
        rankCalls += 1;
        throw new Error('rank must not run');
      },
    });
    assert.equal(result.reasonCode, 'CALLER_REJECTED');
    assert.equal(result.providerCalls, 0);
    assert.equal(existsSync(destination), false);
    assert.equal(rankCalls, 0);

    const pre = await handleCheckpointHook({
      ...baseFacts(),
      destination,
      expectedUser: 'dev-one',
      expectedPid: 4242,
      credential: null,
      presented: { host: 'localhost' },
      consumed: false,
      nowMs: 1000,
      stdin: fixture('pre-compact.json'),
    });
    assert.equal(pre.exitCode, 0);
    assert.equal(pre.stdout, '');
    assert.equal(pre.providerCalls, 0);
    assert.equal(existsSync(destination), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('optional spans and a hypothesis are absent from the closed capsule', async () => {
  const caller = acceptedCaller();
  const dir = mkdtempSync(join(tmpdir(), 'jevris-checkpoint-'));
  const destination = join(dir, 'capsule.json');
  try {
    const result = await persistMandatoryFacts({ ...caller, ...baseFacts(), destination });
    assert.equal(result.reasonCode, 'ACCEPTED');
    const text = readFileSync(destination, 'utf8');
    const file = JSON.parse(text);
    assert.deepEqual(Object.keys(file), CAPSULE_KEYS);
    assert.equal(text.includes('optionalSpans'), false);
    assert.equal(text.includes('HYPOTHESIS_CANARY_do_not_store'), false);
    assert.equal(text.includes('hypothesis'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a passed open check refuses the whole write', async () => {
  const caller = acceptedCaller();
  const dir = mkdtempSync(join(tmpdir(), 'jevris-checkpoint-'));
  const destination = join(dir, 'capsule.json');
  const facts = baseFacts();
  facts.openChecks = [{ id: 'check1', state: 'passed' }];
  try {
    const result = await persistMandatoryFacts({ ...caller, ...facts, destination });
    assert.equal(result.reasonCode, 'INVALID_CAPSULE');
    assert.equal(result.providerCalls, 0);
    assert.equal(existsSync(destination), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an oversized capsule writes nothing and a later valid call keeps both constraints', async () => {
  const caller = acceptedCaller();
  const dir = mkdtempSync(join(tmpdir(), 'jevris-checkpoint-'));
  const destination = join(dir, 'capsule.json');
  const huge = baseFacts();
  huge.userConstraints = [
    { id: 'compat1', kind: 'compatibility', text: 'Q'.repeat(131072) },
    { id: 'sec1', kind: 'security', text: SECURITY_TEXT },
  ];
  try {
    const over = await persistMandatoryFacts({ ...caller, ...huge, destination });
    assert.equal(over.reasonCode, 'OVERSIZE');
    assert.equal(over.providerCalls, 0);
    assert.equal(existsSync(destination), false);

    const later = await persistMandatoryFacts({ ...caller, ...baseFacts(), destination });
    assert.equal(later.reasonCode, 'ACCEPTED');
    const file = JSON.parse(readFileSync(destination, 'utf8'));
    assert.equal(file.userConstraints.length, 2);
    assert.equal(file.userConstraints[0].text, COMPAT_TEXT);
    assert.equal(file.userConstraints[1].text, SECURITY_TEXT);
    assert.equal(JSON.stringify(file).includes('Q'.repeat(64)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a summary that already contains every constraint id clears restore and injects nothing', async () => {
  const caller = acceptedCaller();
  const dir = mkdtempSync(join(tmpdir(), 'jevris-checkpoint-'));
  const destination = join(dir, 'capsule.json');
  const facts = { ...caller, ...baseFacts(), destination };
  try {
    await persistMandatoryFacts(facts);
    const missing = await handleCheckpointHook({
      ...facts,
      stdin: fixture('post-compact.json'),
    });
    assert.equal(missing.stdout, '');
    assert.equal(JSON.parse(readFileSync(destination, 'utf8')).restoreQueued, true);

    const present = await handleCheckpointHook({
      ...facts,
      stdin: JSON.stringify({
        hook_event_name: 'PostCompact',
        trigger: 'auto',
        compact_summary: 'compat1 and sec1 both remain.',
      }),
    });
    assert.equal(present.exitCode, 0);
    assert.equal(present.stdout, '');
    const file = JSON.parse(readFileSync(destination, 'utf8'));
    assert.equal(file.restoreQueued, false);
    assert.equal(file.userConstraints[1].text, SECURITY_TEXT);

    const start = await handleCheckpointHook({
      ...facts,
      stdin: fixture('session-start-compact.json'),
    });
    assert.equal(start.exitCode, 0);
    assert.equal(start.stdout, '');
    assert.equal(start.providerCalls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('continuation loads only the matching workspace and task', async () => {
  const caller = acceptedCaller();
  const dir = mkdtempSync(join(tmpdir(), 'jevris-checkpoint-'));
  const destination = join(dir, 'capsule.json');
  let evaluateCalls = 0;
  function evaluate() {
    evaluateCalls += 1;
    throw new Error('evaluate must not run');
  }
  try {
    const persisted = await persistMandatoryFacts({ ...caller, ...baseFacts(), destination, evaluate });
    assert.equal(persisted.reasonCode, 'ACCEPTED');
    assert.equal(persisted.providerCalls, 0);
    assert.equal(evaluateCalls, 0);
    const stored = readFileSync(destination);

    const matched = await loadMatchingSubset({
      ...caller,
      destination,
      workspaceId: 'ws1',
      taskId: 'taskA',
      evaluate,
    });
    assert.equal(matched.matched, true);
    assert.equal(matched.providerCalls, 0);
    assert.equal(matched.authorizesEffect, false);
    assert.equal(matched.toolPermission, false);
    assert.equal(matched.applied, false);
    assert.equal(matched.subset.userConstraints[0].id, 'compat1');
    assert.equal(matched.subset.userConstraints[0].text, COMPAT_TEXT);
    assert.equal(matched.subset.userConstraints[1].id, 'sec1');
    assert.equal(matched.subset.userConstraints[1].text, SECURITY_TEXT);
    assert.equal(evaluateCalls, 0);

    const otherTask = await loadMatchingSubset({
      ...caller,
      destination,
      workspaceId: 'ws1',
      taskId: 'taskB',
      evidenceRevision: 'revB',
      evaluate,
    });
    assert.equal(otherTask.matched, false);
    assert.equal(otherTask.subset, null);
    assert.equal(otherTask.authorizesEffect, false);
    assert.equal(otherTask.toolPermission, false);
    assert.equal(otherTask.applied, false);
    assert.equal(otherTask.providerCalls, 0);
    const afterTask = JSON.parse(readFileSync(destination, 'utf8'));
    assert.equal(afterTask.taskId, 'taskA');
    assert.equal(afterTask.openChecks[0].id, 'check1');
    assert.equal(afterTask.openChecks[0].state, 'open');
    assert.equal(evaluateCalls, 0);

    const otherWorkspace = await loadMatchingSubset({
      ...caller,
      destination,
      workspaceId: 'ws2',
      taskId: 'taskA',
      evaluate,
    });
    assert.equal(otherWorkspace.matched, false);
    assert.equal(otherWorkspace.subset, null);
    assert.equal(otherWorkspace.authorizesEffect, false);
    assert.equal(otherWorkspace.toolPermission, false);
    assert.equal(otherWorkspace.applied, false);
    assert.equal(otherWorkspace.providerCalls, 0);
    assert.equal(JSON.parse(readFileSync(destination, 'utf8')).workspaceId, 'ws1');

    const beforeReject = readFileSync(destination);
    const rejected = await loadMatchingSubset({
      destination,
      workspaceId: 'ws1',
      taskId: 'taskA',
      expectedUser: 'dev-one',
      expectedPid: 4242,
      credential: null,
      presented: { host: 'localhost' },
      consumed: false,
      nowMs: 1000,
      evaluate,
    });
    assert.equal(rejected.matched, false);
    assert.equal(rejected.subset, null);
    assert.equal(rejected.authorizesEffect, false);
    assert.equal(rejected.toolPermission, false);
    assert.equal(rejected.applied, false);
    assert.equal(rejected.providerCalls, 0);
    assert.deepEqual(readFileSync(destination), beforeReject);
    assert.deepEqual(readFileSync(destination), stored);
    assert.equal(evaluateCalls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('expired and scope-changed approvals stay visible and a revision mismatch marks checks stale', async () => {
  const caller = acceptedCaller();
  const dir = mkdtempSync(join(tmpdir(), 'jevris-checkpoint-'));
  const destination = join(dir, 'capsule.json');
  const fresh = join(dir, 'fresh.json');
  const facts = {
    ...baseFacts(),
    approvals: [
      { id: 'appr1', scope: 'read', expiresAtMs: 500, authorizesEffect: true },
      { id: 'apprEq', scope: 'read', expiresAtMs: 1000, authorizesEffect: true },
      { id: 'appr2', scope: 'read', expiresAtMs: 9000, authorizesEffect: true },
    ],
  };
  let evaluateCalls = 0;
  function evaluate() {
    evaluateCalls += 1;
    throw new Error('evaluate must not run');
  }
  try {
    const persisted = await persistMandatoryFacts({ ...caller, ...facts, destination, evaluate });
    assert.equal(persisted.reasonCode, 'ACCEPTED');
    assert.equal(evaluateCalls, 0);

    const loaded = await loadMatchingSubset({
      ...caller,
      destination,
      workspaceId: 'ws1',
      taskId: 'taskA',
      nowMs: 1000,
      scope: 'write',
      evidenceRevision: 'revB',
      evaluate,
    });
    assert.equal(loaded.matched, true);
    assert.equal(loaded.authorizesEffect, false);
    assert.equal(loaded.toolPermission, false);
    assert.equal(loaded.applied, false);
    assert.equal(loaded.providerCalls, 0);
    assert.equal(loaded.subset.userConstraints[0].id, 'compat1');
    assert.equal(loaded.subset.userConstraints[0].text, COMPAT_TEXT);
    assert.equal(loaded.subset.userConstraints[1].id, 'sec1');
    assert.equal(loaded.subset.userConstraints[1].text, SECURITY_TEXT);
    assert.equal(loaded.subset.approvals.length, 3);
    assert.equal(loaded.subset.approvals[0].id, 'appr1');
    assert.equal(loaded.subset.approvals[0].scope, 'read');
    assert.equal(loaded.subset.approvals[0].expiresAtMs, 500);
    assert.equal(loaded.subset.approvals[0].authorizesEffect, false);
    assert.equal(loaded.subset.approvals[1].id, 'apprEq');
    assert.equal(loaded.subset.approvals[1].scope, 'read');
    assert.equal(loaded.subset.approvals[1].expiresAtMs, 1000);
    assert.equal(loaded.subset.approvals[1].authorizesEffect, false);
    assert.equal(loaded.subset.approvals[2].id, 'appr2');
    assert.equal(loaded.subset.approvals[2].authorizesEffect, false);
    assert.equal(loaded.subset.openChecks[0].id, 'check1');
    assert.equal(loaded.subset.openChecks[0].state, 'stale');
    assert.equal(Object.hasOwn(loaded, 'permissionDecision'), false);
    assert.equal(Object.hasOwn(loaded.subset, 'permissionDecision'), false);
    assert.equal(JSON.stringify(loaded).includes('permissionDecision'), false);
    assert.equal(JSON.stringify(loaded).includes('"toolPermission":true'), false);
    assert.equal(evaluateCalls, 0);

    const onDisk = JSON.parse(readFileSync(destination, 'utf8'));
    assert.deepEqual(Object.keys(onDisk), CAPSULE_KEYS);
    assert.equal(onDisk.openChecks[0].state, 'stale');
    assert.equal(onDisk.openChecks[0].state === 'passed', false);
    assert.equal(JSON.stringify(onDisk).includes('"passed"'), false);
    assert.equal(onDisk.userConstraints[0].text, COMPAT_TEXT);
    assert.equal(onDisk.userConstraints[1].text, SECURITY_TEXT);
    assert.equal(onDisk.approvals.length, 3);
    assert.equal(onDisk.approvals[0].id, 'appr1');
    assert.equal(onDisk.evidenceRevision, 'revA');
    assert.equal(onDisk.toolPermission, false);

    const later = await loadMatchingSubset({
      ...caller,
      destination,
      workspaceId: 'ws1',
      taskId: 'taskA',
      nowMs: 1000,
      scope: 'read',
      evidenceRevision: 'revA',
      evaluate,
    });
    assert.equal(later.matched, true);
    assert.equal(later.authorizesEffect, false);
    assert.equal(later.subset.openChecks[0].state === 'passed', false);
    assert.equal(later.subset.openChecks[0].state, 'stale');
    assert.equal(later.subset.approvals.length, 3);
    assert.equal(later.subset.approvals[2].id, 'appr2');
    assert.equal(later.subset.approvals[2].scope, 'read');
    assert.equal(later.subset.approvals[2].authorizesEffect, false);
    assert.equal(JSON.parse(readFileSync(destination, 'utf8')).openChecks[0].state, 'stale');

    const freshPersist = await persistMandatoryFacts({ ...caller, ...baseFacts(), destination: fresh });
    assert.equal(freshPersist.reasonCode, 'ACCEPTED');
    const sameRevision = await loadMatchingSubset({
      ...caller,
      destination: fresh,
      workspaceId: 'ws1',
      taskId: 'taskA',
      nowMs: 1000,
      scope: 'read',
      evidenceRevision: 'revA',
      evaluate,
    });
    assert.equal(sameRevision.matched, true);
    assert.equal(sameRevision.authorizesEffect, false);
    assert.equal(sameRevision.toolPermission, false);
    assert.equal(sameRevision.applied, false);
    assert.equal(sameRevision.subset.openChecks[0].state, 'open');
    assert.equal(sameRevision.subset.approvals.length, 1);
    assert.equal(sameRevision.subset.approvals[0].id, 'appr1');
    assert.equal(sameRevision.subset.approvals[0].scope, 'read');
    assert.equal(sameRevision.subset.approvals[0].authorizesEffect, false);
    assert.equal(JSON.parse(readFileSync(fresh, 'utf8')).openChecks[0].state, 'open');

    const omittedScope = await loadMatchingSubset({
      ...caller,
      destination: fresh,
      workspaceId: 'ws1',
      taskId: 'taskA',
      nowMs: 1000,
      evidenceRevision: 'revA',
      evaluate,
    });
    assert.equal(omittedScope.subset.approvals.length, 1);
    assert.equal(omittedScope.subset.approvals[0].authorizesEffect, false);
    assert.equal(omittedScope.subset.openChecks[0].state, 'open');
    assert.equal(omittedScope.toolPermission, false);
    assert.equal(evaluateCalls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function preCompactStdin(trigger) {
  const body = {
    hook_event_name: 'PreCompact',
    transcript_path: TRANSCRIPT,
  };
  if (trigger !== undefined) body.trigger = trigger;
  return JSON.stringify(body);
}

function assertEmptyAllow(result) {
  assert.equal(result.exitCode, 0);
  assert.notEqual(result.exitCode, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.providerCalls, 0);
  assert.equal(result.stdout.includes('decision'), false);
  assert.equal(result.stdout.includes('block'), false);
  assert.equal(result.stdout.includes('updatedSummary'), false);
  assert.equal(result.stdout.includes('replacementContext'), false);
  assert.equal(result.stdout.includes('additionalContext'), false);
}

test('auto, manual, unknown, and a second PreCompact allow compaction', async () => {
  const caller = acceptedCaller();
  const dir = mkdtempSync(join(tmpdir(), 'jevris-checkpoint-'));
  const destination = join(dir, 'capsule.json');
  const missingParent = join(dir, 'missing-parent', 'capsule.json');
  let evaluateCalls = 0;
  function evaluate() {
    evaluateCalls += 1;
    throw new Error('evaluate must not run');
  }
  const facts = { ...caller, ...baseFacts(), destination, evaluate };
  try {
    const manual = await handleCheckpointHook({
      ...facts,
      stdin: preCompactStdin('manual'),
      proactive: true,
      nativeAutoDeferral: true,
      decision: 'block',
    });
    assertEmptyAllow(manual);
    assert.equal(evaluateCalls, 0);
    const stored = JSON.parse(readFileSync(destination, 'utf8'));
    assert.deepEqual(Object.keys(stored), CAPSULE_KEYS);
    assert.equal(Object.hasOwn(stored, 'decision'), false);
    assert.equal(JSON.stringify(stored).includes('block'), false);
    assert.equal(stored.userConstraints[1].text, SECURITY_TEXT);
    assert.equal(stored.toolPermission, false);

    const auto = await handleCheckpointHook({
      ...facts,
      stdin: preCompactStdin('auto'),
      proactive: true,
      nativeAutoDeferral: true,
    });
    assertEmptyAllow(auto);

    const unknown = await handleCheckpointHook({
      ...facts,
      stdin: preCompactStdin('proactive'),
    });
    assertEmptyAllow(unknown);

    const missingTrigger = await handleCheckpointHook({
      ...facts,
      stdin: preCompactStdin(undefined),
    });
    assertEmptyAllow(missingTrigger);

    const second = await handleCheckpointHook({
      ...facts,
      stdin: preCompactStdin('auto'),
      nativeAutoDeferral: true,
      proactive: true,
    });
    assertEmptyAllow(second);
    assert.equal(JSON.parse(readFileSync(destination, 'utf8')).toolPermission, false);
    assert.equal(evaluateCalls, 0);

    const orphan = await handleCheckpointHook({
      ...facts,
      destination: missingParent,
      stdin: preCompactStdin('auto'),
      proactive: true,
      nativeAutoDeferral: true,
    });
    assertEmptyAllow(orphan);
    assert.equal(orphan.providerCalls, 0);
    assert.equal(existsSync(missingParent), false);
    assert.equal(evaluateCalls, 0);

    const post = await handleCheckpointHook({
      ...facts,
      stdin: fixture('post-compact.json'),
    });
    assert.equal(post.stdout, '');
    const start = await handleCheckpointHook({
      ...facts,
      stdin: fixture('session-start-compact.json'),
    });
    assert.equal(start.exitCode, 0);
    assert.equal(start.providerCalls, 0);
    const restored = JSON.parse(start.stdout);
    assert.equal(restored.hookSpecificOutput.additionalContext.includes(SECURITY_TEXT), true);
    assert.equal(restored.hookSpecificOutput.additionalContext.includes('?'), false);
    assert.equal(evaluateCalls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restore is injected only at compact, resume, or UserPromptSubmit', async () => {
  const caller = acceptedCaller();
  const dir = mkdtempSync(join(tmpdir(), 'jevris-checkpoint-'));
  const destination = join(dir, 'capsule.json');
  const expiredDest = join(dir, 'expired.json');
  const mismatchDest = join(dir, 'mismatch.json');
  const hugeDest = join(dir, 'huge.json');
  const facts = { ...caller, ...baseFacts(), destination };
  const expiredLine = 'Historical approval appr1 scope read is expired and does not authorize a new effect.';
  const mismatchLine =
    'Historical approval appr1 scope read does not match the current scope and does not authorize a new effect.';
  const hugeText = 'S'.repeat(12000);
  try {
    await persistMandatoryFacts(facts);
    const queued = await handleCheckpointHook({
      ...facts,
      stdin: fixture('post-compact.json'),
    });
    assert.equal(queued.stdout, '');
    assert.equal(queued.providerCalls, 0);
    assert.equal(JSON.parse(readFileSync(destination, 'utf8')).restoreQueued, true);

    const resume = await handleCheckpointHook({
      ...facts,
      stdin: fixture('session-start-resume.json'),
    });
    assert.equal(resume.exitCode, 0);
    assert.equal(resume.providerCalls, 0);
    assert.equal(resume.toolPermission, false);
    assert.notEqual(resume.stdout, '');
    const resumed = JSON.parse(resume.stdout);
    assert.equal(resumed.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.equal(resumed.hookSpecificOutput.additionalContext.includes(SECURITY_TEXT), true);
    assert.equal(resumed.hookSpecificOutput.additionalContext.includes('does not authorize a new effect.'), true);
    assert.equal(resumed.hookSpecificOutput.additionalContext.includes('?'), false);
    assert.equal(resumed.hookSpecificOutput.additionalContext.includes('\u001b'), false);

    const prompt = await handleCheckpointHook({
      ...facts,
      stdin: fixture('user-prompt-submit.json'),
    });
    assert.equal(prompt.exitCode, 0);
    assert.equal(prompt.providerCalls, 0);
    assert.equal(prompt.toolPermission, false);
    const submitted = JSON.parse(prompt.stdout);
    assert.equal(submitted.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.equal(Object.hasOwn(submitted, 'prompt'), false);
    assert.equal(Object.hasOwn(submitted, 'updatedPrompt'), false);
    assert.equal(Object.hasOwn(submitted.hookSpecificOutput, 'prompt'), false);
    assert.equal(JSON.stringify(submitted).includes('"prompt"'), false);
    assert.equal(JSON.stringify(submitted).includes('continue'), false);
    assert.equal(JSON.stringify(submitted).includes('updatedSummary'), false);
    assert.equal(JSON.stringify(submitted).includes('replacementContext'), false);
    assert.equal(submitted.hookSpecificOutput.additionalContext.includes(SECURITY_TEXT), true);
    assert.equal(submitted.hookSpecificOutput.additionalContext.includes('does not authorize a new effect.'), true);

    for (const name of ['session-start-clear.json', 'session-start-startup.json', 'session-start-fork.json']) {
      const skipped = await handleCheckpointHook({
        ...facts,
        stdin: fixture(name),
      });
      assert.equal(skipped.exitCode, 0);
      assert.equal(skipped.stdout, '');
      assert.equal(skipped.providerCalls, 0);
      assert.equal(skipped.toolPermission, false);
    }
    assert.equal(JSON.parse(readFileSync(destination, 'utf8')).restoreQueued, true);

    const pre = await handleCheckpointHook({
      ...facts,
      stdin: fixture('pre-compact.json'),
    });
    assert.equal(pre.stdout, '');
    assert.equal(pre.toolPermission, false);
    const postAgain = await handleCheckpointHook({
      ...facts,
      stdin: fixture('post-compact.json'),
    });
    assert.equal(postAgain.stdout, '');
    assert.equal(postAgain.toolPermission, false);

    const otherTask = await handleCheckpointHook({
      ...facts,
      taskId: 'taskB',
      stdin: fixture('session-start-compact.json'),
    });
    assert.equal(otherTask.exitCode, 0);
    assert.equal(otherTask.stdout, '');
    assert.equal(otherTask.toolPermission, false);
    assert.equal(otherTask.providerCalls, 0);
    const untouched = JSON.parse(readFileSync(destination, 'utf8'));
    assert.equal(untouched.taskId, 'taskA');
    assert.equal(untouched.toolPermission, false);
    assert.equal(untouched.userConstraints[1].text, SECURITY_TEXT);

    const expiredFacts = {
      ...caller,
      ...baseFacts(),
      destination: expiredDest,
      approvals: [{ id: 'appr1', scope: 'read', expiresAtMs: 500, authorizesEffect: true }],
      nowMs: 1000,
      scope: 'read',
    };
    await persistMandatoryFacts(expiredFacts);
    await handleCheckpointHook({ ...expiredFacts, stdin: fixture('post-compact.json') });
    const expiredResume = await handleCheckpointHook({
      ...expiredFacts,
      stdin: fixture('session-start-resume.json'),
    });
    const expiredContext = JSON.parse(expiredResume.stdout).hookSpecificOutput.additionalContext;
    assert.equal(expiredContext.includes(expiredLine), true);
    assert.equal(expiredContext.includes('?'), false);
    const expiredFile = JSON.parse(readFileSync(expiredDest, 'utf8'));
    assert.equal(expiredFile.approvals.length, 1);
    assert.equal(expiredFile.approvals[0].id, 'appr1');
    assert.equal(expiredFile.approvals[0].scope, 'read');
    assert.equal(expiredFile.approvals[0].expiresAtMs, 500);
    assert.equal(expiredFile.approvals[0].authorizesEffect, false);
    assert.equal(expiredFile.userConstraints[1].text, SECURITY_TEXT);

    const mismatchFacts = {
      ...caller,
      ...baseFacts(),
      destination: mismatchDest,
      nowMs: 1000,
      scope: 'write',
    };
    await persistMandatoryFacts(mismatchFacts);
    await handleCheckpointHook({ ...mismatchFacts, stdin: fixture('post-compact.json') });
    const mismatchResume = await handleCheckpointHook({
      ...mismatchFacts,
      stdin: fixture('session-start-resume.json'),
    });
    const mismatchContext = JSON.parse(mismatchResume.stdout).hookSpecificOutput.additionalContext;
    assert.equal(mismatchContext.includes(mismatchLine), true);
    assert.equal(mismatchContext.includes(SECURITY_TEXT), true);
    const mismatchFile = JSON.parse(readFileSync(mismatchDest, 'utf8'));
    assert.equal(mismatchFile.approvals[0].id, 'appr1');
    assert.equal(mismatchFile.approvals[0].scope, 'read');
    assert.equal(mismatchFile.approvals[0].authorizesEffect, false);

    const hugeFacts = {
      ...caller,
      ...baseFacts(),
      destination: hugeDest,
      userConstraints: [
        { id: 'compat1', kind: 'compatibility', text: COMPAT_TEXT },
        { id: 'sec1', kind: 'security', text: hugeText },
      ],
    };
    await persistMandatoryFacts(hugeFacts);
    await handleCheckpointHook({ ...hugeFacts, stdin: fixture('post-compact.json') });
    const beforeHuge = readFileSync(hugeDest);
    const hugeResume = await handleCheckpointHook({
      ...hugeFacts,
      stdin: fixture('session-start-resume.json'),
    });
    const hugeContext = JSON.parse(hugeResume.stdout).hookSpecificOutput.additionalContext;
    assert.equal(hugeContext.length <= 10000, true);
    assert.equal(hugeContext.includes('sec1'), true);
    assert.equal(hugeContext.startsWith('Constraint index: compat1 sec1'), true);
    assert.equal(hugeContext.includes(hugeText), false);
    assert.equal(hugeContext.includes('\u001b'), false);
    assert.deepEqual(readFileSync(hugeDest), beforeHuge);
    const hugeFile = JSON.parse(beforeHuge.toString('utf8'));
    assert.equal(hugeFile.userConstraints[1].id, 'sec1');
    assert.equal(hugeFile.userConstraints[1].text, hugeText);
    assert.equal(hugeFile.userConstraints.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkpoint ships no product hook that is not certified', async () => {
  const { assertProductHooksAbsentOrCertified } = await import(new URL('../../../apps/cli/test/product-hooks.mjs', import.meta.url));
  await assertProductHooksAbsentOrCertified();
});
