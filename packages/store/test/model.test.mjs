import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from './temp-dirs.mjs';

const INDEX = new URL('../dist/index.js', import.meta.url);
const s = await import(INDEX.href);
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const dirs = [];
function tempDir() {
  const dir = makeTempDir('jevris-store-model-');
  dirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of dirs) removeTempDir(dir);
});

function openHost(path = join(tempDir(), 'jevris.db')) {
  const opened = s.openStore({ path, role: 'sidecar', workspaceId: 'host', hostScope: 'hostA', fsKind: () => ({ kind: 'local', label: 't' }) });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  return opened;
}

const HASH = 'a'.repeat(64);
const HASH2 = 'b'.repeat(64);

// ---------------------------------------------------------------- DATA-02

test('workspaces register by root identity; the same identity at a new path keeps its id (DATA-02, IPC-09)', () => {
  const store = openHost();
  const first = s.registerWorkspace(store, { workspaceId: 'wAbc', rootIdentity: 'dev1-ino2', rootPath: '/r/one', nowMs: 1 });
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  const moved = s.registerWorkspace(store, { workspaceId: 'wAbc', rootIdentity: 'dev1-ino2', rootPath: '/r/moved', nowMs: 2 });
  assert.equal(moved.created, false);
  assert.equal(s.getWorkspace(store, 'wAbc').rootPath, '/r/moved');
  assert.deepEqual(s.registerWorkspace(store, { workspaceId: 'wOther', rootIdentity: 'dev1-ino2', rootPath: '/r/x', nowMs: 3 }), { ok: false, reason: 'conflict' });
  assert.equal(s.listWorkspaces(store).length, 1);
  assert.equal(s.getWorkspace(store, 'wAbc').trust, 'untrusted');
  assert.equal(s.getWorkspace(store, 'wAbc').egressPolicy, 'deny');
  s.closeStore(store);
});

test('sessions keep an unknown actual model unknown and never overwrite a known one with unknown (DATA-02)', () => {
  const store = openHost();
  const ws = s.workspaceView(store, 'wAbc');
  assert.deepEqual(s.recordSession(ws, { sessionId: 'sess-1', harness: 'claude-code', requestedModel: 'opus', state: 'active', atMs: 5 }), { ok: true });
  assert.equal(s.getSession(ws, 'sess-1').actualModel, null);
  s.recordSession(ws, { sessionId: 'sess-1', harness: 'claude-code', actualModel: 'claude-opus-5', state: 'active', atMs: 6 });
  s.recordSession(ws, { sessionId: 'sess-1', harness: 'claude-code', actualModel: null, state: 'ended', atMs: 9 });
  const row = s.getSession(ws, 'sess-1');
  assert.equal(row.actualModel, 'claude-opus-5');
  assert.equal(row.state, 'ended');
  assert.equal(row.endedAtMs, 9);
  assert.equal(s.getSession(store, 'sess-1'), undefined, 'the host view does not see a workspace session');
  s.closeStore(store);
});

test('with a dedup window a repeated delivery key is a duplicate only inside the window; a later one is a new event (DATA-02, HKR-02)', () => {
  const path = join(tempDir(), 'jevris.db');
  const store = openHost(path);
  const ws = s.workspaceView(store, 'wAbc');
  const base = { nativeKind: 'PreCompact', payloadHash: HASH, payloadBytes: 50 };
  const opts = { dedupWindowMs: 1000 };
  assert.deepEqual(s.appendEvent(ws, { ...base, deliveryKey: 'k1', receivedAtMs: 10_000 }, opts), { ok: true, seq: 1, duplicate: false });
  assert.deepEqual(s.appendEvent(ws, { ...base, deliveryKey: 'k1', receivedAtMs: 10_999 }, opts), { ok: true, seq: 1, duplicate: true });
  // After the window the same key is a new event, stored under a suffixed key.
  assert.deepEqual(s.appendEvent(ws, { ...base, deliveryKey: 'k1', receivedAtMs: 11_000 }, opts), { ok: true, seq: 2, duplicate: false });
  // The window now runs from the newest row for the key.
  assert.deepEqual(s.appendEvent(ws, { ...base, deliveryKey: 'k1', receivedAtMs: 11_500 }, opts), { ok: true, seq: 2, duplicate: true });
  assert.deepEqual(s.appendEvent(ws, { ...base, deliveryKey: 'k1', receivedAtMs: 20_000 }, opts), { ok: true, seq: 3, duplicate: false });
  // A key that only shares a prefix is its own key.
  assert.deepEqual(s.appendEvent(ws, { ...base, deliveryKey: 'k1a', receivedAtMs: 20_001 }, opts), { ok: true, seq: 4, duplicate: false });
  // Without the option a key dedups for as long as its row is kept.
  assert.deepEqual(s.appendEvent(ws, { ...base, deliveryKey: 'k1a', receivedAtMs: 999_999 }), { ok: true, seq: 4, duplicate: true });
  assert.deepEqual(s.appendEvent(ws, { ...base, deliveryKey: 'k2', receivedAtMs: 1 }, { dedupWindowMs: 0 }), { ok: false, reason: 'invalid-input' });
  assert.equal(s.countEvents(ws), 4);
  s.closeStore(store);
  const db = new Database(path, { readonly: true });
  assert.deepEqual(db.prepare('SELECT delivery_key AS k FROM event ORDER BY seq').all().map((r) => r.k), ['k1', 'k1#2', 'k1#3', 'k1a']);
  db.close();
});

test('events are append-only, unique per delivery key and capped in size (DATA-02)', () => {
  const path = join(tempDir(), 'jevris.db');
  const store = openHost(path);
  const ws = s.workspaceView(store, 'wAbc');
  const base = { nativeKind: 'PreToolUse', payloadHash: HASH, payloadBytes: 120, receivedAtMs: 10 };
  assert.deepEqual(s.appendEvent(ws, { ...base, deliveryKey: 'k1' }), { ok: true, seq: 1, duplicate: false });
  assert.deepEqual(s.appendEvent(ws, { ...base, deliveryKey: 'k2' }), { ok: true, seq: 2, duplicate: false });
  assert.deepEqual(s.appendEvent(ws, { ...base, deliveryKey: 'k1', payloadHash: HASH2 }), { ok: true, seq: 1, duplicate: true });
  assert.deepEqual(s.appendEvent(ws, { ...base, deliveryKey: 'k3', payloadBytes: s.EVENT_PAYLOAD_CAP + 1 }), { ok: false, reason: 'oversize' });
  assert.deepEqual(s.appendEvent(ws, { ...base, deliveryKey: 'k4', payloadHash: 'not-a-hash' }), { ok: false, reason: 'invalid-input' });
  assert.equal(s.countEvents(ws), 2);
  s.closeStore(store);
  const db = new Database(path);
  assert.throws(() => db.prepare("UPDATE event SET native_kind = 'x'").run(), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM event').run(), /append-only/);
  db.close();
});

test('the capsule index makes a new version on changed content and keeps the pinned class (DATA-02)', () => {
  const store = openHost();
  const ws = s.workspaceView(store, 'wAbc');
  const v1 = s.putCapsule(ws, { capsuleId: 'cap1', encoderVersion: 'enc-1', contentHash: HASH, nowMs: 1 });
  assert.equal(v1.capsule.version, 1);
  assert.equal(s.putCapsule(ws, { capsuleId: 'cap1', encoderVersion: 'enc-1', contentHash: HASH, nowMs: 2 }).created, false);
  const v2 = s.putCapsule(ws, { capsuleId: 'cap1', encoderVersion: 'enc-1', contentHash: HASH2, nowMs: 3 });
  assert.equal(v2.capsule.version, 2);
  assert.equal(s.currentCapsule(ws, 'cap1').contentHash, HASH2);
  assert.deepEqual(s.setCapsuleRetention(ws, 'cap1', 'pinned'), { ok: true });
  assert.equal(s.currentCapsule(ws, 'cap1').retentionClass, 'pinned');
  assert.deepEqual(s.invalidateCapsule(ws, 'cap1'), { ok: true });
  assert.equal(s.currentCapsule(ws, 'cap1'), undefined);
  s.closeStore(store);
});

test('outbox retries are bounded with backoff and end in needs-reconciliation, never a blind repeat (DATA-02)', () => {
  const store = openHost();
  const ws = s.workspaceView(store, 'wAbc');
  assert.deepEqual(s.commitOwned(ws, { decisionId: 'dec1', operationId: 'op1', reservationMicroUsd: 1n, acknowledgment: 'absent' }), { ok: true });
  const nowMs = 1_000_000;
  const results = [];
  for (let i = 0; i < 5; i += 1) results.push(s.recordOutboxAttempt(ws, { decisionId: 'dec1', succeeded: false, errorCode: 'TRANSIENT', nowMs: nowMs + i }));
  assert.deepEqual(results.slice(0, 4).map((r) => r.state), ['retry', 'retry', 'retry', 'retry']);
  assert.deepEqual(results.slice(0, 4).map((r, i) => r.nextAttemptAtMs - (nowMs + i)), [1000, 2000, 4000, 8000]);
  assert.deepEqual(results[4], { ok: true, state: 'exhausted', retryCount: 5 });
  assert.equal(s.effectDisposition(ws, 'op1').effectStatus, 'needs-reconciliation');
  assert.deepEqual(s.dueOutbox(ws, nowMs + 10_000_000), []);
  assert.equal(s.backoffMs(40), 300_000);
  s.closeStore(store);
});

// ---------------------------------------------------------------- DATA-03

function task(store, taskId, extra = {}) {
  return s.createTask(store, { taskId, ownerId: 'owner1', rootBudgetId: 'budget1', requirementIds: ['REQ-1'], nowMs: 1, ...extra });
}

function move(store, taskId, to, actor = 'scheduler', extra = {}) {
  return s.transitionTask(store, { taskId, to, actor, reasonCode: 'TEST', nowMs: 2, ...extra });
}

test('the task transition API refuses illegal transitions and stale revisions (DATA-03)', () => {
  const store = openHost();
  const ws = s.workspaceView(store, 'wAbc');
  const created = task(ws, 't1');
  assert.equal(created.task.state, 'proposed');
  assert.equal(created.task.revision, 1);
  assert.equal(move(ws, 't1', 'running').reasonCode, 'ILLEGAL_TRANSITION');
  assert.equal(move(ws, 't1', 'ready').reasonCode, 'ILLEGAL_TRANSITION', 'proposed must be validated first');
  assert.equal(move(ws, 't1', 'validated', 'planner').task.state, 'validated');
  assert.equal(move(ws, 't1', 'ready', 'scheduler', { expectedRevision: 1 }).reasonCode, 'STALE_REVISION');
  const ready = move(ws, 't1', 'ready', 'scheduler', { expectedRevision: 2 });
  assert.equal(ready.task.state, 'ready');
  assert.equal(ready.task.revision, 3);
  for (const state of s.STORE_TASK_STATES) assert.ok(Array.isArray(s.TASK_TRANSITIONS[state]));
  assert.deepEqual(s.TASK_TRANSITIONS.cancelled, []);
  assert.equal(move(ws, 'missing', 'ready').reasonCode, 'UNKNOWN_TASK');
  assert.deepEqual(s.taskHistory(ws, 't1').map((h) => h.to), ['proposed', 'validated', 'ready']);
  s.closeStore(store);
});

test('"agent finished" reaches at most verifying; no transition sets verified (DATA-03)', () => {
  const store = openHost();
  const ws = s.workspaceView(store, 'wAbc');
  task(ws, 't1');
  move(ws, 't1', 'validated', 'planner');
  move(ws, 't1', 'ready');
  assert.equal(move(ws, 't1', 'leased', 'agent').reasonCode, 'ACTOR_NOT_ALLOWED');
  move(ws, 't1', 'leased');
  assert.equal(move(ws, 't1', 'running', 'agent').task.state, 'running');
  assert.equal(move(ws, 't1', 'verifying', 'agent').task.state, 'verifying');
  for (const actor of s.TASK_ACTORS) assert.equal(move(ws, 't1', 'verified', actor).reasonCode, 'VERIFY_REQUIRES_PROOF');
  assert.equal(move(ws, 't1', 'failed', 'agent').reasonCode, 'ACTOR_NOT_ALLOWED');
  assert.equal(s.getTask(ws, 't1').state, 'verifying');
  s.closeStore(store);
});

test('an unknown dependency blocks; a pending one refuses ready; cycles are refused (DATA-03)', () => {
  const store = openHost();
  const ws = s.workspaceView(store, 'wAbc');
  task(ws, 'a', { dependsOn: ['ghost'] });
  const blocked = move(ws, 'a', 'validated', 'planner');
  assert.equal(blocked.ok, true);
  assert.equal(blocked.task.state, 'blocked');
  assert.equal(blocked.task.stateReason, 'UNKNOWN_DEPENDENCY');
  assert.deepEqual(blocked.blockedBy, ['ghost']);
  task(ws, 'b');
  task(ws, 'c', { dependsOn: ['b'] });
  move(ws, 'c', 'validated', 'planner');
  assert.equal(move(ws, 'c', 'ready').reasonCode, 'DEPENDENCY_NOT_VERIFIED');
  assert.equal(s.addDependency(ws, { taskId: 'b', dependsOn: 'c', nowMs: 3 }).reasonCode, 'CYCLE');
  assert.equal(task(ws, 'ghost', { dependsOn: ['a'] }).reasonCode, 'CYCLE', 'a already depends on ghost');
  assert.equal(task(ws, 'self', { dependsOn: ['self'] }).reasonCode, 'CYCLE');
  assert.equal(task(ws, 'b').reasonCode, 'DUPLICATE_TASK');
  s.closeStore(store);
});

function receipt(extra = {}) {
  return {
    receiptId: 'r1',
    taskId: 't1',
    checkId: 'unit',
    issuer: 'local-runner',
    inputRevision: 'rev-1',
    scopeRevision: 'scope-1',
    runnerId: 'runner-a',
    environmentHash: HASH,
    outcome: 'passed',
    rawHash: HASH2,
    body: { exitCode: 0, argv: ['npm', 'test'] },
    recordedAtMs: 5,
    ...extra,
  };
}

function toVerifying(ws, id) {
  task(ws, id);
  move(ws, id, 'validated', 'planner');
  move(ws, id, 'ready');
  move(ws, id, 'leased');
  move(ws, id, 'running', 'agent');
  move(ws, id, 'verifying', 'agent');
}

test('verified comes only from current passed receipts in the store; invalidation demotes it (DATA-03, VER)', () => {
  const store = openHost();
  const ws = s.workspaceView(store, 'wAbc');
  toVerifying(ws, 't1');
  assert.equal(s.verifyTask(ws, { taskId: 't1', receiptIds: ['r1'], nowMs: 6 }).reasonCode, 'NO_PASSING_RECEIPT');
  assert.deepEqual(s.recordVerificationReceipt(ws, receipt({ receiptId: 'rFail', outcome: 'failed' })), { ok: true, duplicate: false });
  assert.equal(s.verifyTask(ws, { taskId: 't1', receiptIds: ['rFail'], nowMs: 6 }).reasonCode, 'NO_PASSING_RECEIPT');
  assert.deepEqual(s.recordVerificationReceipt(ws, receipt()), { ok: true, duplicate: false });
  assert.deepEqual(s.recordVerificationReceipt(ws, receipt()), { ok: true, duplicate: true });
  assert.deepEqual(s.recordVerificationReceipt(ws, receipt({ outcome: 'failed' })), { ok: false, reason: 'conflict' });
  assert.deepEqual(s.recordVerificationReceipt(ws, receipt({ receiptId: 'rSrc', body: { sourceText: 'x' } })), { ok: false, reason: 'source-body-refused' });
  const verified = s.verifyTask(ws, { taskId: 't1', receiptIds: ['r1'], nowMs: 7 });
  assert.equal(verified.task.state, 'verified');
  assert.equal(verified.task.verifiedBy, 'checks');
  const rows = s.readVerificationReceipts(ws, { taskId: 't1', currentOnly: true });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => s.isStoreReceipt(r) && Object.isFrozen(r)));
  assert.equal(s.isStoreReceipt(JSON.parse(JSON.stringify(rows[0]))), false, 'a JSON copy loses the brand');
  const inval = s.invalidateVerificationReceipts(ws, { currentScopeRevision: 'scope-2', nowMs: 8 });
  assert.deepEqual([...inval.invalidated].sort(), ['r1', 'rFail']);
  assert.deepEqual(inval.demotedTasks, ['t1']);
  assert.equal(s.getTask(ws, 't1').state, 'awaiting-evidence');
  assert.equal(s.getTask(ws, 't1').verifiedBy, null);
  s.closeStore(store);
});

test('invalidating the receipts of one task, by id or by task, never touches another task (DATA-03, VER-03)', () => {
  const store = openHost();
  const ws = s.workspaceView(store, 'wAbc');
  toVerifying(ws, 't1');
  toVerifying(ws, 't2');
  s.recordVerificationReceipt(ws, receipt({ receiptId: 'r1', taskId: 't1' }));
  s.recordVerificationReceipt(ws, receipt({ receiptId: 'r2', taskId: 't2' }));
  assert.equal(s.verifyTask(ws, { taskId: 't1', receiptIds: ['r1'], nowMs: 7 }).task.state, 'verified');
  assert.equal(s.verifyTask(ws, { taskId: 't2', receiptIds: ['r2'], nowMs: 7 }).task.state, 'verified');
  const byId = s.invalidateVerificationReceipts(ws, { receiptIds: ['r2'], nowMs: 8 });
  assert.deepEqual([byId.invalidated, byId.demotedTasks], [['r2'], ['t2']]);
  assert.equal(s.getTask(ws, 't1').state, 'verified', 'invalidating t2 left t1 verified');
  s.recordVerificationReceipt(ws, receipt({ receiptId: 'r2b', taskId: 't2' }));
  const byTask = s.invalidateVerificationReceipts(ws, { taskId: 't2', currentScopeRevision: 'scope-2', nowMs: 9 });
  assert.deepEqual(byTask.invalidated, ['r2b'], 'a revision sweep scoped to t2 skips t1 even though its scope revision also differs');
  assert.equal(s.getTask(ws, 't1').state, 'verified');
  assert.equal(s.readVerificationReceipts(ws, { taskId: 't1', currentOnly: true }).length, 1);
  s.closeStore(store);
});

test('a human exception needs a terminal authorization and stays distinct from a pass (DATA-03, GOV-09)', () => {
  const path = join(tempDir(), 'jevris.db');
  const store = openHost(path);
  const ws = s.workspaceView(store, 'wAbc');
  toVerifying(ws, 't1');
  const scope = 'wAbc:t1';
  assert.deepEqual(s.mintAuthorization(store, { principal: 'alice', actionClass: 'task.exception', scope, ttlMs: 60_000, channel: 'mcp', nowMs: 10 }), { ok: false, reason: 'production-writer-closed' });
  assert.deepEqual(s.mintAuthorization(store, { principal: 'alice', actionClass: 'task.exception', scope, ttlMs: 16 * 60_000, channel: 'terminal', nowMs: 10 }), { ok: false, reason: 'invalid-input' });
  // Source egress is approved by `jevris egress approve` (a terminal and a typed phrase), not by a receipt nothing consumes.
  assert.deepEqual(s.mintAuthorization(store, { principal: 'alice', actionClass: 'egress.enable', scope: 'host', ttlMs: 60_000, channel: 'terminal', nowMs: 10 }), { ok: false, reason: 'invalid-input' });
  assert.equal(s.AUTHORIZATION_ACTIONS.includes('egress.enable'), false);
  const minted = s.mintAuthorization(store, { principal: 'alice', actionClass: 'task.exception', scope, ttlMs: 60_000, channel: 'terminal', nowMs: 10 });
  assert.equal(minted.ok, true);
  if (process.platform !== 'win32') assert.equal(statSync(`${path}.authz-key`).mode & 0o777, 0o600);
  const base = { taskId: 't1', exceptionId: 'ex1', principal: 'alice', reason: 'flaky upstream fixture, reviewed', nowMs: 11 };
  assert.equal(s.acceptException(ws, { ...base, principal: 'mallory', authorizationId: minted.authorizationId }).reasonCode, 'AUTHORIZATION_REFUSED');
  assert.equal(s.acceptException(ws, { ...base, authorizationId: minted.authorizationId, nowMs: 10 + 60_000 }).reasonCode, 'AUTHORIZATION_REFUSED', 'expired');
  const accepted = s.acceptException(ws, { ...base, authorizationId: minted.authorizationId });
  assert.equal(accepted.task.state, 'verified');
  assert.equal(accepted.task.verifiedBy, 'exception');
  assert.equal(s.taskExceptions(ws, 't1')[0].principal, 'alice');
  toVerifying(ws, 't2');
  assert.equal(s.acceptException(ws, { ...base, taskId: 't2', exceptionId: 'ex2', authorizationId: minted.authorizationId }).reasonCode, 'AUTHORIZATION_REFUSED', 'single use');
  s.closeStore(store);
  const db = new Database(path);
  db.prepare("UPDATE authorization_receipt SET consumed_at_ms = NULL, scope = 'wAbc:t2'").run();
  db.close();
  const again = openHost(path);
  assert.equal(s.acceptException(s.workspaceView(again, 'wAbc'), { ...base, taskId: 't2', exceptionId: 'ex3', authorizationId: minted.authorizationId }).reasonCode, 'AUTHORIZATION_REFUSED', 'an edited row fails its MAC');
  s.closeStore(again);
});

// ---------------------------------------------------------------- GOV-10

test('the audit log is hash-chained, append-only and content-free (GOV-10)', () => {
  const path = join(tempDir(), 'jevris.db');
  const store = openHost(path);
  assert.equal(s.appendAudit(store, { kind: 'kill-switch.activate', actor: 'alice', channel: 'terminal', detail: { reconciled: 2, ids: ['op1', 'op2'] }, atMs: 1 }).seq, 1);
  assert.equal(s.appendAudit(store, { kind: 'egress.decision', actor: 'sidecar', channel: 'sidecar', detail: { allowed: false, reasonCode: 'NO_CONSENT' }, atMs: 2 }).seq, 2);
  assert.deepEqual(s.appendAudit(store, { kind: 'egress.decision', actor: 'sidecar', channel: 'sidecar', detail: { text: 'line one\nline two' }, atMs: 3 }), { ok: false, reason: 'invalid-input' });
  assert.deepEqual(s.appendAudit(store, { kind: 'made.up', actor: 'x', channel: 'sidecar', atMs: 3 }), { ok: false, reason: 'invalid-input' });
  // `jevris egress approve|revoke` records its change as a CLI row.
  assert.equal(s.appendAudit(store, { kind: 'egress.enable', actor: 'alice', channel: 'cli', detail: { egress: 'approved-scoped', created: true, source: 'host.json' }, atMs: 4 }).seq, 3);
  assert.equal(s.appendAudit(store, { kind: 'egress.revoke', actor: 'alice', channel: 'cli', detail: { egress: 'deny-until-approved' }, atMs: 5 }).seq, 4);
  const chain = s.verifyAuditChain(store);
  assert.equal(chain.ok, true);
  assert.equal(chain.count, 4);
  const jsonl = s.exportAuditJsonl(store).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(jsonl.length, 4);
  assert.equal(jsonl[1].prevHash, jsonl[0].hash);
  s.closeStore(store);
  const db = new Database(path);
  assert.throws(() => db.prepare("UPDATE audit_log SET actor = 'mallory'").run(), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM audit_log WHERE seq = 1').run(), /append-only/);
  db.exec('DROP TRIGGER audit_log_no_update');
  db.prepare("UPDATE audit_log SET actor = 'mallory' WHERE seq = 1").run();
  db.close();
  const reopened = openHost(path);
  assert.deepEqual(s.verifyAuditChain(reopened), { ok: false, brokenAt: 1 });
  s.closeStore(reopened);
});

// ---------------------------------------------------------------- DATA-05

function journalEntry(id, extra = {}) {
  return {
    decisionId: id,
    state: 'refused',
    history: [
      { state: 'received', atMs: 100 },
      { state: 'refused', atMs: 140 },
    ],
    draft: { specVersion: 'spec-2', packetHash: HASH, workspaceId: 'wAbc', taskId: null },
    record: {
      schemaVersion: '1.0',
      decisionId: id,
      specId: 'route',
      specVersion: 'spec-2',
      modelResolved: 'jev-1.13.0',
      mode: 'advisory',
      evidenceRevision: 'rev1',
      outcome: 'refused',
      reasonCodes: ['BUDGET'],
      usage: { inputTokens: 1200, outputTokens: 30 },
      billingBasis: 'provider-usage',
      calibration: { id: 'cal', version: 'cal-3' },
      policyVersion: 'policy-7',
      durationMs: 38,
      providerCalls: 1,
      cost: { reservedMicroUsd: 90, actualMicroUsd: 51 },
      workspaceId: 'wAbc',
      ...extra,
    },
  };
}

function fakeJournal(entries) {
  return { list: async () => entries.map((e) => e.decisionId), read: async (id) => entries.find((e) => e.decisionId === id) ?? null };
}

test('terminal journal decisions archive into immutable rows with versions, latency and usage (DATA-05)', async () => {
  const path = join(tempDir(), 'jevris.db');
  const store = openHost(path);
  const entries = [journalEntry('d1'), journalEntry('d2', { usage: null, cost: { reservedMicroUsd: 90, actualMicroUsd: null } }), { ...journalEntry('d3'), state: 'evaluating', record: null }];
  const first = await s.archiveJournal(store, fakeJournal(entries));
  assert.deepEqual(first, { ok: true, inserted: 2, duplicate: 0, usageFilled: 0, skipped: 1, expired: 0 });
  const rows = s.readDecisionRows(store);
  const d1 = rows.find((r) => r.decisionId === 'd1');
  assert.equal(d1.workspaceId, 'wAbc');
  assert.equal(d1.kind, 'route');
  assert.equal(d1.specVersion, 'spec-2');
  assert.equal(d1.model, 'jev-1.13.0');
  assert.equal(d1.encoderVersion, 'packet-1');
  assert.equal(d1.calibrationVersion, 'cal-3');
  assert.equal(d1.policyVersion, 'policy-7');
  assert.equal(d1.latencyMs, 38);
  assert.deepEqual(d1.usage, { inputTokens: 1200, outputTokens: 30 });
  assert.equal(d1.costMicroUsd, 51);
  assert.equal(rows.find((r) => r.decisionId === 'd2').usage, null);
  // Reconciliation later adds d2's usage; a re-archive fills it in once.
  entries[1] = journalEntry('d2', { state: 'reconciled' });
  const second = await s.archiveJournal(store, fakeJournal(entries));
  assert.deepEqual(second, { ok: true, inserted: 0, duplicate: 1, usageFilled: 1, skipped: 1, expired: 0 });
  s.closeStore(store);
  const db = new Database(path);
  assert.throws(() => db.prepare("UPDATE decision_record SET outcome = 'applied'").run(), /immutable/);
  assert.throws(() => db.prepare('UPDATE decision_record SET cost_micro_usd = 1').run(), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM decision_record').run(), /immutable/);
  db.close();
});

test('the legacy JSON decision ledger migrates into the store and is retired (DATA-05)', () => {
  const dir = tempDir();
  const store = openHost(join(dir, 'jevris.db'));
  const ledger = join(dir, 'decisions.json');
  writeFileSync(ledger, JSON.stringify({
    schemaVersion: '1.0',
    records: [
      { schemaVersion: '1.0', decisionId: 'old1', policyVersion: 'p1', evidenceRevision: 'r', resolvedModel: 'jev-1.13.0', outcome: 'advisory', reasonCode: 'CHOICE_RECORDED', usage: { inputTokens: 5, outputTokens: 1 }, applied: false, reservationMicroUsd: '12' },
      { schemaVersion: '1.0', decisionId: 'old2', policyVersion: 'p1', evidenceRevision: 'r', resolvedModel: null, outcome: 'refused', reasonCode: 'DEADLINE', usage: null, applied: false },
    ],
  }));
  const imported = s.importLegacyLedger(store, ledger, { workspaceId: 'wAbc', nowMs: 50 });
  assert.deepEqual(imported, { ok: true, imported: 2, retiredTo: `${ledger}.migrated` });
  assert.equal(existsSync(ledger), false);
  const rows = s.readDecisionRows(store);
  assert.deepEqual(rows.map((r) => [r.decisionId, r.source, r.reasonCodes[0]]), [['old1', 'legacy-ledger', 'CHOICE_RECORDED'], ['old2', 'legacy-ledger', 'DEADLINE']]);
  assert.equal(rows[0].reservedMicroUsd, 12);
  assert.deepEqual(s.importLegacyLedger(store, ledger, { workspaceId: 'wAbc', nowMs: 51 }), { ok: true, imported: 0, retiredTo: null });
  s.closeStore(store);
});

test('journal writes from separate CLI, sidecar and hook processes all reach the store once (DATA-05)', async () => {
  const dir = tempDir();
  const journalDir = join(dir, 'decisions');
  mkdirSync(journalDir);
  // Each process writes its decisions the way the decision journal does: one file per id.
  const writer = (role, count) => `
    const { writeFileSync, renameSync } = await import('node:fs');
    const { join } = await import('node:path');
    for (let i = 0; i < ${count}; i += 1) {
      const id = '${role}' + i;
      const entry = { decisionId: id, state: 'refused', history: [{ state: 'received', atMs: i }, { state: 'refused', atMs: i + 3 }], draft: { specVersion: 's1', packetHash: null, workspaceId: 'wAbc', taskId: null },
        record: { decisionId: id, specId: 'plan', specVersion: 's1', modelResolved: null, outcome: 'refused', reasonCodes: ['STALE'], usage: null, billingBasis: 'unknown', policyVersion: 'p', cost: { reservedMicroUsd: 0, actualMicroUsd: null }, workspaceId: 'wAbc' } };
      const tmp = join(${JSON.stringify(journalDir)}, id + '.tmp');
      writeFileSync(tmp, JSON.stringify(entry));
      renameSync(tmp, join(${JSON.stringify(journalDir)}, id + '.json'));
    }`;
  const run = (role, count) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', writer(role, count)], { stdio: 'ignore' });
      child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${role} exited ${code}`))));
    });
  const store = openHost(join(dir, 'jevris.db'));
  const { readdir, readFile } = await import('node:fs/promises');
  const journal = {
    list: async () => (await readdir(journalDir)).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)),
    read: async (id) => JSON.parse(await readFile(join(journalDir, `${id}.json`), 'utf8')),
  };
  // The sidecar archives while the three writers are still running.
  const writers = Promise.all([run('cli', 150), run('sidecar', 150), run('hook', 150)]);
  let archived = 0;
  while (archived < 450) {
    const result = await s.archiveJournal(store, journal);
    assert.equal(result.ok, true);
    archived += result.inserted;
    if (archived < 450) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await writers;
  const final = await s.archiveJournal(store, journal);
  assert.equal(final.inserted, 0);
  assert.equal(s.countDecisionRows(store), 450);
  assert.equal(new Set(s.readDecisionRows(store, { limit: 10_000 }).map((r) => r.decisionId)).size, 450);
  s.closeStore(store);
  void readFileSync;
});
