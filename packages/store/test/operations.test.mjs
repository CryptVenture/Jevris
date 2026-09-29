import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from './temp-dirs.mjs';

const s = await import(new URL('../dist/index.js', import.meta.url).href);
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const dirs = [];
function tempDir() {
  const dir = makeTempDir('jevris-store-ops-');
  dirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of dirs) removeTempDir(dir);
});

function openHost(path, hostScope = 'hostA') {
  const opened = s.openStore({ path, role: 'sidecar', workspaceId: 'host', hostScope, fsKind: () => ({ kind: 'local', label: 't' }) });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  return opened;
}

const HASH = 'c'.repeat(64);
const DAY = 86_400_000;

// ---------------------------------------------------------------- DATA-04

test('restart reconciliation blocks expired leases and orphaned jobs, marks open reservations uncertain and holds unknown usage (DATA-04)', () => {
  const path = join(tempDir(), 'jevris.db');
  const store = openHost(path);
  const ws = s.workspaceView(store, 'wAbc');
  const now = Date.parse('2026-09-25T12:00:00Z');
  for (const id of ['tLease', 'tOrphan', 'tLive']) {
    s.createTask(ws, { taskId: id, ownerId: 'o', rootBudgetId: 'b', nowMs: 1 });
    for (const [to, actor] of [['validated', 'planner'], ['ready', 'scheduler'], ['leased', 'scheduler'], ['running', 'agent']]) {
      assert.equal(s.transitionTask(ws, { taskId: id, to, actor, reasonCode: 'T', nowMs: 2 }).ok, true);
    }
  }
  const lease = (leaseId, taskId, expiresAt, resourceKey) =>
    s.issueLease(ws, { leaseId, taskId, ownerId: 'worker', resourceKey, directory: `/wt/${leaseId}`, heartbeatAt: '2026-09-25T11:00:00Z', expiresAt });
  assert.equal(lease('lExpired', 'tLease', '2026-09-25T11:30:00Z', 'res-a').ok, true);
  assert.equal(lease('lLive', 'tLive', '2026-09-25T13:00:00Z', 'res-b').ok, true);
  const db = new Database(path);
  db.prepare("INSERT INTO job_reservation VALUES ('wAbc', 'job1', 'o', 50, 'reserved', 'rev1')").run();
  db.close();
  s.commitOwned(ws, { decisionId: 'dUnknown', operationId: 'opU', reservationMicroUsd: 3n });

  const result = s.reconcileRestart(store, { nowMs: now });
  assert.equal(result.ok, true);
  assert.equal(result.expiredLeases, 1);
  assert.deepEqual([...result.blockedTasks].sort(), ['wAbc:tLease', 'wAbc:tOrphan']);
  assert.equal(result.uncertainReservations, 1);
  assert.ok(result.unknownUsageHolds >= 1);
  assert.equal(s.getTask(ws, 'tLease').state, 'blocked');
  assert.equal(s.getTask(ws, 'tLease').stateReason, 'LEASE_EXPIRED');
  assert.equal(s.getTask(ws, 'tOrphan').stateReason, 'PROCESS_LOST');
  assert.equal(s.getTask(ws, 'tLive').state, 'running');
  assert.equal(s.taskHistory(ws, 'tOrphan').at(-1).actor, 'reconciler');
  // A second run finds nothing new.
  const again = s.reconcileRestart(store, { nowMs: now });
  assert.equal(again.expiredLeases, 0);
  assert.deepEqual(again.blockedTasks, []);
  s.closeStore(store);
});

test('deadlines translate to the monotonic clock without ever growing (DATA-04)', () => {
  assert.deepEqual(s.translateDeadline({ deadlineAtMs: 10_900, recordedAtMs: 10_000, nowMs: 10_300, monotonicNowMs: 5 }), { monotonicDeadlineMs: 605, remainingMs: 600 });
  assert.equal(s.translateDeadline({ deadlineAtMs: 10_900, recordedAtMs: 10_000, nowMs: 11_000, monotonicNowMs: 5 }), 'expired');
  assert.equal(s.translateDeadline({ deadlineAtMs: 10_900, recordedAtMs: 10_000, nowMs: 9_000, monotonicNowMs: 5 }), 'expired', 'a clock that jumped back cannot extend it');
  assert.equal(s.translateDeadline({ deadlineAtMs: Number.NaN, recordedAtMs: 1, nowMs: 1, monotonicNowMs: 1 }), 'expired');
});

// ---------------------------------------------------------------- DATA-11

test('retention removes old redacted rows and raw files, keeps pinned memory, uses secure_delete and vacuums (DATA-11)', () => {
  const dir = tempDir();
  const path = join(dir, 'jevris.db');
  const raw = join(dir, 'evidence');
  mkdirSync(raw);
  const store = openHost(path);
  const ws = s.workspaceView(store, 'wAbc');
  const now = Date.now();
  const old = now - 40 * DAY;
  const recent = now - 2 * DAY;
  for (let i = 0; i < 30; i += 1) s.appendEvent(ws, { deliveryKey: `old${i}`, nativeKind: 'PreToolUse', payloadHash: HASH, payloadBytes: 10, receivedAtMs: old });
  s.appendEvent(ws, { deliveryKey: 'new1', nativeKind: 'PreToolUse', payloadHash: HASH, payloadBytes: 10, receivedAtMs: recent });
  s.putCapsule(ws, { capsuleId: 'keep', encoderVersion: 'e1', contentHash: HASH, retentionClass: 'pinned', nowMs: old });
  s.putCapsule(ws, { capsuleId: 'drop', encoderVersion: 'e1', contentHash: 'd'.repeat(64), nowMs: old });
  writeFileSync(join(raw, `${'e'.repeat(64)}.raw`), 'old tool output');
  writeFileSync(join(raw, `${HASH}.raw`), 'pinned output');
  writeFileSync(join(raw, `${'f'.repeat(64)}.raw`), 'new output');
  const oldSeconds = (Date.now() - 10 * DAY) / 1000;
  utimesSync(join(raw, `${'e'.repeat(64)}.raw`), oldSeconds, oldSeconds);
  utimesSync(join(raw, `${HASH}.raw`), oldSeconds, oldSeconds);

  const policy = s.effectiveRetention(undefined);
  assert.deepEqual(policy, { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 });
  const dry = s.sweepRetention(store, { policy, nowMs: now, rawDir: raw, dryRun: true });
  assert.equal(dry.removed.event, 30);
  assert.equal(dry.rawFiles, 1);
  assert.equal(s.countEvents(ws), 31, 'a dry run changes nothing');

  const swept = s.sweepRetention(store, { policy, nowMs: now, rawDir: raw });
  assert.equal(swept.removed.event, 30);
  assert.equal(swept.removed.capsule_index, 1);
  assert.equal(swept.keptPinned, 1);
  assert.equal(swept.rawFiles, 1);
  assert.equal(swept.vacuumed, true);
  assert.equal(s.countEvents(ws), 1);
  assert.ok(s.currentCapsule(ws, 'keep'));
  assert.equal(s.currentCapsule(ws, 'drop'), undefined);
  assert.equal(existsSync(join(raw, `${'e'.repeat(64)}.raw`)), false);
  assert.equal(existsSync(join(raw, `${HASH}.raw`)), true, 'a pinned capsule keeps its artifact');
  assert.equal(existsSync(join(raw, `${'f'.repeat(64)}.raw`)), true);
  const audit = s.readAudit(store, { kinds: ['retention.sweep'] });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].detail.decisionRetentionDays, 30);
  s.closeStore(store);
  // Deleted content is not left in the file after secure_delete and VACUUM.
  assert.equal(readFileSync(path).includes(Buffer.from('old29')), false);
  const db = new Database(path);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM maintenance_flag').get().n, 0);
  assert.throws(() => db.prepare('DELETE FROM event').run(), /append-only/, 'the flag is cleared after the sweep');
  db.close();
});

test('the route-learning aggregate is its own retention class: the sweep never touches it, even with 0-day windows (DATA-11, owner 2026-09-26)', () => {
  assert.deepEqual(
    { ...s.ROUTE_LEARNING_RETENTION, removedBy: [...s.ROUTE_LEARNING_RETENTION.removedBy], subdirectories: [...s.ROUTE_LEARNING_RETENTION.subdirectories], files: [...s.ROUTE_LEARNING_RETENTION.files] },
    { retentionClass: 'route-learning', directory: 'route-learning', subdirectories: ['machine', 'calibration-cases'], files: ['model-availability.json', 'model-offer.json', 'access-limits.json', 'usage-readings.json'], swept: false, removedBy: ['jevris route learning reset --clear-evidence', 'jevris route learning reset --machine', 'jevris data delete'] },
  );
  const data = tempDir();
  const raw = join(data, 'evidence');
  const learning = join(data, s.ROUTE_LEARNING_RETENTION.directory);
  mkdirSync(raw);
  mkdirSync(learning);
  const store = openHost(join(data, 'jevris.db'));
  const now = Date.now();
  const aggregate = JSON.stringify({ schemaVersion: 'jevris-route-learning-2', workspaceId: 'wAbc', versions: [], slices: {} });
  const file = join(learning, 'wAbc.json');
  writeFileSync(file, aggregate, { mode: 0o600 });
  // A file named like a raw artifact, in the learning folder, is still not a raw artifact.
  const lookalike = join(learning, `${'e'.repeat(64)}.raw`);
  writeFileSync(lookalike, 'x');
  writeFileSync(join(raw, `${'e'.repeat(64)}.raw`), 'old tool output');
  // C's machine-wide prior (owner 2026-09-26) is in the same class.
  mkdirSync(join(learning, 'machine'));
  const prior = join(learning, 'machine', 'prior.json');
  writeFileSync(prior, '{}', { mode: 0o600 });
  // C's models-found-gone record (f5b19ab) too: C's registry-snapshot rule clears it, not age.
  const availability = join(learning, 'model-availability.json');
  writeFileSync(availability, '{}', { mode: 0o600 });
  const yearAgo = (now - 400 * DAY) / 1000;
  for (const path of [file, lookalike, prior, availability, join(raw, `${'e'.repeat(64)}.raw`)]) utimesSync(path, yearAgo, yearAgo);

  const policy = s.effectiveRetention({ rawArtifactRetentionDays: 0, decisionRetentionDays: 0 });
  assert.deepEqual(policy, { rawArtifactRetentionDays: 0, decisionRetentionDays: 0 });
  const swept = s.sweepRetention(store, { policy, nowMs: now, rawDir: raw });
  assert.equal(swept.ok, true);
  assert.equal(swept.rawFiles, 1, 'the raw artifact went');
  assert.equal(readFileSync(file, 'utf8'), aggregate, 'the route-learning aggregate is untouched');
  assert.equal(existsSync(lookalike), true);
  assert.equal(existsSync(prior), true, 'the machine-wide prior is untouched');
  assert.equal(existsSync(availability), true, 'model-availability.json is untouched by the age sweep');
  s.closeStore(store);
});

test('retention settings are capped by the organization and host policy maximums and the contract bounds (DATA-11)', () => {
  const user = { rawArtifactRetentionDays: 90, decisionRetentionDays: 400 };
  assert.deepEqual(s.effectiveRetention(user), { rawArtifactRetentionDays: 90, decisionRetentionDays: 400 });
  assert.deepEqual(s.effectiveRetention(user, { rawArtifactRetentionDays: 14, decisionRetentionDays: 90 }), { rawArtifactRetentionDays: 14, decisionRetentionDays: 90 });
  // Two caps: the smaller wins; a cap never lengthens retention.
  assert.deepEqual(s.effectiveRetention({ rawArtifactRetentionDays: 3 }, { rawArtifactRetentionDays: 14 }, { decisionRetentionDays: 10 }), { rawArtifactRetentionDays: 3, decisionRetentionDays: 10 });
  assert.deepEqual(s.effectiveRetention({ rawArtifactRetentionDays: 9999, decisionRetentionDays: -5 }), { rawArtifactRetentionDays: 365, decisionRetentionDays: 0 });
});

// ---------------------------------------------------------------- DATA-13

test('backup uses the backup API, is owner-only and integrity-checked; restore checks integrity, host and schema (DATA-13)', async () => {
  const dir = tempDir();
  const path = join(dir, 'jevris.db');
  const store = openHost(path);
  s.commitOwned(s.workspaceView(store, 'wAbc'), { decisionId: 'dKeep', operationId: 'opK', reservationMicroUsd: 9n });
  const backup = join(dir, 'backup.db');
  const made = await s.backupStore(store, backup, { nowMs: 5 });
  assert.deepEqual(made, { ok: true, path: backup });
  if (process.platform !== 'win32') assert.equal(statSync(backup).mode & 0o777, 0o600);
  assert.deepEqual(await s.backupStore(store, backup, { nowMs: 6 }), { ok: false, reason: 'destination-exists' });
  s.commitOwned(s.workspaceView(store, 'wAbc'), { decisionId: 'dLater', operationId: 'opL', reservationMicroUsd: 1n });

  const exported = join(dir, 'export.jsonl');
  const ex = s.exportStoreJsonl(store, exported);
  assert.equal(ex.ok, true);
  const lines = readFileSync(exported, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.table === 'decision_row' && l.row.decision_id === 'dKeep' && l.row.reservation_micro_usd === '9'));
  assert.equal(lines.some((l) => l.table === 'authorization_receipt'), false);
  if (process.platform !== 'win32') assert.equal(statSync(exported).mode & 0o777, 0o600);

  assert.equal(s.readAudit(store, { kinds: ['store.backup'] }).length, 1);
  // The live store holds the writer role: restore refuses.
  assert.equal(s.restoreStore({ backupPath: backup, dbPath: path, hostScope: 'hostA', nowMs: 7 }).reason, 'writer-busy');
  s.closeStore(store);

  assert.equal(s.restoreStore({ backupPath: backup, dbPath: path, hostScope: 'hostB', nowMs: 7 }).reason, 'backup-foreign-host');
  const corrupt = join(dir, 'corrupt.db');
  writeFileSync(corrupt, Buffer.alloc(4096, 0x42));
  assert.equal(s.restoreStore({ backupPath: corrupt, dbPath: path, hostScope: 'hostA', nowMs: 7 }).reason, 'backup-corrupt');
  const restored = s.restoreStore({ backupPath: backup, dbPath: path, hostScope: 'hostA', nowMs: 7 });
  assert.equal(restored.ok, true);
  assert.equal(restored.previousMovedTo, `${path}.pre-restore-7`);
  assert.ok(existsSync(restored.previousMovedTo));
  const reopened = openHost(path);
  const ws = s.workspaceView(reopened, 'wAbc');
  assert.ok(s.readCommitted(ws, 'dKeep'));
  assert.equal(s.readCommitted(ws, 'dLater'), undefined, 'the restore is the backup, not the later state');
  s.closeStore(reopened);
});

test('a backup made by a newer schema is refused (DATA-13)', () => {
  const dir = tempDir();
  const path = join(dir, 'jevris.db');
  s.closeStore(openHost(path));
  const newer = join(dir, 'newer.db');
  const db = new Database(path);
  db.prepare('VACUUM INTO ?').run(newer);
  db.close();
  const edit = new Database(newer);
  edit.prepare('UPDATE schema_meta SET schema_version = 999').run();
  edit.close();
  assert.equal(s.checkBackup(newer, 'hostA').reason, 'schema-newer');
});

// ---------------------------------------------------------------- GOV-03

test('kill-switch activation holds every pending owned effect for reconciliation and audits the held ids (GOV-03)', () => {
  const path = join(tempDir(), 'jevris.db');
  const store = openHost(path);
  const ws = s.workspaceView(store, 'wAbc');
  assert.equal(s.commitOwned(ws, { decisionId: 'dPend', operationId: 'opPend', reservationMicroUsd: 1n }).ok, true);
  // An effect the outbox is still delivering (pending, not acknowledged).
  const raw = new Database(path);
  raw.prepare("UPDATE outbox_entry SET effect_status = 'pending' WHERE operation_id = 'opPend'").run();
  raw.close();
  const held = s.holdPendingEffects(store, { nowMs: Date.now(), actor: 'tester', channel: 'terminal', reason: 'incident <script>' });
  assert.equal(held.ok, true, JSON.stringify(held));
  assert.deepEqual(held.held, ['opPend']);
  const disposition = s.effectDisposition(ws, 'opPend');
  assert.equal(disposition.effectStatus, 'needs-reconciliation');
  assert.equal(disposition.repeatable, false);
  const audit = s.readAudit(store, { kinds: ['kill-switch.activate'] });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].detail.held, 1);
  assert.equal(audit[0].channel, 'terminal');
  assert.equal(String(audit[0].detail.reason).includes('<'), false);
  // A second activation holds nothing new and is audited again.
  assert.deepEqual(s.holdPendingEffects(store, { nowMs: Date.now(), actor: 'tester', channel: 'cli' }).held, []);
  assert.equal(s.verifyAuditChain(store).ok, true);
  s.closeStore(store);
});

test('owned worker effects: begin writes a pending effect, the kill switch holds it, settle never releases a held effect, and a person reconciles it once, audited (GOV-03, DATA-04)', () => {
  const path = join(tempDir(), 'jevris.db');
  const store = openHost(path);
  const ws = s.workspaceView(store, 'wAbc');
  const other = s.workspaceView(store, 'wOther');
  const now = Date.parse('2026-09-25T12:00:00Z');
  const begun = s.beginOwnedEffect(ws, { operationId: 'op-lease1', decisionId: 'dTask1', kind: 'owned-worker', reservationMicroUsd: 2500n, nowMs: now });
  assert.deepEqual(begun, { ok: true, state: 'pending', existing: false });
  assert.deepEqual(s.beginOwnedEffect(ws, { operationId: 'op-lease1', kind: 'owned-worker', reservationMicroUsd: 2500n, nowMs: now }), { ok: true, state: 'pending', existing: true });
  assert.equal(s.beginOwnedEffect(ws, { operationId: 'op-lease2', kind: 'owned-worker', reservationMicroUsd: 10n, nowMs: now }).ok, true);
  assert.equal(s.beginOwnedEffect(ws, { operationId: 'op/bad', kind: 'owned-worker', reservationMicroUsd: 1n, nowMs: now }).ok, false);
  assert.equal(s.effectDisposition(ws, 'op-lease1').repeatable, false);

  // A run that finishes before any stop settles normally.
  assert.deepEqual(s.settleOwnedEffect(ws, { operationId: 'op-lease2', outcome: 'applied', actualMicroUsd: 8n, nowMs: now + 1 }), { ok: true, state: 'acknowledged' });

  // The kill switch holds the one still pending, across workspaces (host store).
  const held = s.holdPendingEffects(store, { nowMs: now + 2, actor: 'tester', channel: 'cli' });
  assert.deepEqual(held.held, ['op-lease1']);
  assert.deepEqual(s.heldEffects(ws), [{ operationId: 'op-lease1', decisionId: 'dTask1', reservationMicroUsd: 2500 }]);
  assert.deepEqual(s.heldEffects(other), []);

  // The worker reports afterwards: held, not settled, and the reservation stays held.
  assert.deepEqual(s.settleOwnedEffect(ws, { operationId: 'op-lease1', outcome: 'applied', actualMicroUsd: 100n, nowMs: now + 3 }), { ok: true, state: 'held' });
  assert.equal(s.heldEffects(ws).length, 1);
  assert.deepEqual(s.settleOwnedEffect(ws, { operationId: 'op-none', outcome: 'failed', actualMicroUsd: null, nowMs: now }), { ok: false, reason: 'not-found' });
  assert.deepEqual(s.reconcileEffect(ws, { operationId: 'op-lease2', resolution: 'applied', actor: 'tester', channel: 'terminal', nowMs: now }), { ok: true, state: 'acknowledged', auditSeq: null });

  // A person decides, once, from a terminal; the decision is audited and never repeated.
  const reconciled = s.reconcileEffect(ws, { operationId: 'op-lease1', resolution: 'abandoned', actor: 'tester', channel: 'terminal', nowMs: now + 4 });
  assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
  assert.equal(reconciled.state, 'abandoned');
  assert.deepEqual(s.heldEffects(ws), []);
  assert.deepEqual(s.reconcileEffect(ws, { operationId: 'op-lease1', resolution: 'abandoned', actor: 'tester', channel: 'terminal', nowMs: now + 5 }), { ok: true, state: 'abandoned', auditSeq: null });
  assert.deepEqual(s.reconcileEffect(ws, { operationId: 'op-lease1', resolution: 'applied', actor: 'tester', channel: 'terminal', nowMs: now + 5 }), { ok: false, reason: 'not-held' });
  assert.deepEqual(s.settleOwnedEffect(ws, { operationId: 'op-lease1', outcome: 'applied', actualMicroUsd: 1n, nowMs: now + 6 }), { ok: true, state: 'abandoned' });
  assert.equal(s.effectDisposition(ws, 'op-lease1').repeatable, false);
  const audit = s.readAudit(store, { kinds: ['owned-effect.reconcile'] });
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].actor, audit[0].channel, audit[0].detail.operationId, audit[0].detail.resolution], ['tester', 'terminal', 'op-lease1', 'abandoned']);
  assert.equal(s.verifyAuditChain(store).ok, true);
  s.closeStore(store);
});
