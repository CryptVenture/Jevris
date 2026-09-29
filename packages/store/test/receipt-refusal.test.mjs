import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir, removeTempDir } from './temp-dirs.mjs';


const SOURCE_CANARY = 'SOURCE_CANARY_do_not_store';
const BYTE_CAP = 131_072;

const {
  openStore,
  closeStore,
  acceptRunnerReceipt,
  runDeclaredCheck,
  invalidateForRevision,
  insertInvalidationEdge,
  listCurrent,
  listRetained,
} = await import('../dist/index.js');

function repoRoot() {
  return fileURLToPath(new URL('../../..', import.meta.url));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function tempDir() {
  return makeTempDir('jevris-receipt-gate-');
}

function openTest(path) {
  return openStore({
    path,
    role: 'in-process-test',
    workspaceId: 'wsA',
    hostScope: 'host-a',
  });
}

function rowById(result, id) {
  assert.equal(result.ok, true);
  if (!result.ok) return undefined;
  return result.rows.find((row) => row.id === id);
}

function manifest(dir, name, overrides = {}) {
  const marker = join(dir, name);
  const command = process.execPath;
  return {
    marker,
    value: {
      runnerId: 'runnerA',
      command,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
      commandHash: sha256(command),
      workspaceId: 'wsA',
      receiptId: 'rcptBound',
      sourceRevision: 'rev-a',
      evidenceId: 'evBound',
      currentRevision: 'rev-a',
      ...overrides,
    },
  };
}

test('an unbound receipt is refused and is not stored as current', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'unbound.sqlite');
  try {
    const opened = openTest(dbPath);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const missingRunner = acceptRunnerReceipt(
      opened,
      {
        workspaceId: 'wsA',
        receiptId: 'rcptLoose',
        sourceRevision: 'rev-a',
        evidenceId: 'evLoose',
        commandHash: sha256('missing'),
      },
      'rev-a',
    );
    assert.equal(missingRunner.ok, false);
    const missingHash = acceptRunnerReceipt(
      opened,
      {
        workspaceId: 'wsA',
        receiptId: 'rcptNoHash',
        sourceRevision: 'rev-a',
        evidenceId: 'evNoHash',
        runnerId: 'runnerA',
      },
      'rev-a',
    );
    assert.equal(missingHash.ok, false);
    const current = listCurrent(opened, { workspaceId: 'wsA' });
    assert.equal(rowById(current, 'rcptLoose'), undefined);
    assert.equal(rowById(current, 'rcptNoHash'), undefined);
    const retained = listRetained(opened, { workspaceId: 'wsA' });
    assert.equal(rowById(retained, 'rcptLoose'), undefined);
    assert.equal(rowById(retained, 'rcptNoHash'), undefined);
    closeStore(opened);
  } finally {
    removeTempDir(dir);
  }
});

test('a forged, passed, extra, prototype, or wrong-revision receipt is refused', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'forged.sqlite');
  try {
    const opened = openTest(dbPath);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const forged = acceptRunnerReceipt(
      opened,
      {
        workspaceId: 'wsA',
        receiptId: 'rcptForge',
        sourceRevision: 'rev-a',
        evidenceId: 'evForge',
        runnerId: 'runnerA',
        commandHash: sha256('forged'),
        producedBy: 'runDeclaredCheck',
      },
      'rev-a',
    );
    assert.equal(forged.ok, false);
    const passed = acceptRunnerReceipt(
      opened,
      JSON.stringify({
        workspaceId: 'wsA',
        receiptId: 'rcptPass',
        sourceRevision: 'rev-a',
        evidenceId: 'evPass',
        runnerId: 'runnerA',
        commandHash: sha256('passed-claim'),
        passed: true,
      }),
      'rev-a',
    );
    assert.equal(passed.ok, false);
    const extra = acceptRunnerReceipt(
      opened,
      {
        workspaceId: 'wsA',
        receiptId: 'rcptExtra',
        sourceRevision: 'rev-a',
        evidenceId: 'evExtra',
        runnerId: 'runnerA',
        commandHash: sha256('extra'),
        source: SOURCE_CANARY,
      },
      'rev-a',
    );
    assert.equal(extra.ok, false);
    const prototype = acceptRunnerReceipt(
      opened,
      '{"workspaceId":"wsA","receiptId":"rcptProto","sourceRevision":"rev-a","evidenceId":"evProto","runnerId":"runnerA","commandHash":"aa","__proto__":{"admin":true}}',
      'rev-a',
    );
    assert.equal(prototype.ok, false);
    const mismatch = acceptRunnerReceipt(
      opened,
      {
        workspaceId: 'wsA',
        receiptId: 'rcptOld',
        sourceRevision: 'rev-a',
        evidenceId: 'evOld',
        runnerId: 'runnerA',
        commandHash: sha256('old'),
      },
      'rev-b',
    );
    assert.equal(mismatch.ok, false);
    const oversize = `{"receiptId":"rcptHuge"}${'x'.repeat(BYTE_CAP)}`;
    assert.equal(Buffer.byteLength(oversize) > BYTE_CAP, true);
    const huge = acceptRunnerReceipt(opened, oversize, 'rev-a');
    assert.equal(huge.ok, false);
    const current = listCurrent(opened, { workspaceId: 'wsA' });
    for (const id of ['rcptForge', 'rcptPass', 'rcptExtra', 'rcptProto', 'rcptOld', 'rcptHuge']) {
      assert.equal(rowById(current, id), undefined);
    }
    const retained = listRetained(opened, { workspaceId: 'wsA' });
    assert.equal(JSON.stringify(retained).includes(SOURCE_CANARY), false);
    assert.equal(JSON.stringify(retained).includes('passed'), false);
    closeStore(opened);
  } finally {
    removeTempDir(dir);
  }
});

test('only the declared manifest command can store a current receipt', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'declared.sqlite');
  const trap = join(dir, 'frame-ran');
  try {
    const opened = openTest(dbPath);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const declared = manifest(dir, 'manifest-ran');
    const frame = {
      command: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(trap)}, 'ran')`],
      modelSentence: 'all checks passed',
      source: SOURCE_CANARY,
    };
    const ran = runDeclaredCheck(opened, declared.value, frame);
    assert.equal(ran.ok, true);
    assert.equal(existsSync(declared.marker), true);
    assert.equal(existsSync(trap), false);
    const current = listCurrent(opened, { workspaceId: 'wsA' });
    const row = rowById(current, 'rcptBound');
    assert.ok(row);
    assert.equal(row.validity, 'current');
    assert.equal(row.sourceRevision, 'rev-a');
    assert.equal(JSON.stringify(current).includes(SOURCE_CANARY), false);

    const failedDir = join(dir, 'failed-marker');
    const failed = runDeclaredCheck(opened, {
      ...declared.value,
      receiptId: 'rcptFail',
      evidenceId: 'evFail',
      args: ['-e', 'process.exit(2)'],
      command: process.execPath,
      commandHash: sha256(process.execPath),
    });
    assert.equal(failed.ok, false);
    assert.equal(existsSync(failedDir), false);
    assert.equal(rowById(listCurrent(opened, { workspaceId: 'wsA' }), 'rcptFail'), undefined);
    assert.equal(rowById(listRetained(opened, { workspaceId: 'wsA' }), 'rcptFail'), undefined);

    const wrong = manifest(dir, 'mismatch-ran', {
      receiptId: 'rcptWrong',
      evidenceId: 'evWrong',
      sourceRevision: 'rev-a',
      currentRevision: 'rev-b',
    });
    const mismatched = runDeclaredCheck(opened, wrong.value, frame);
    assert.equal(mismatched.ok, false);
    assert.equal(existsSync(wrong.marker), false);
    assert.equal(existsSync(trap), false);
    assert.equal(rowById(listCurrent(opened, { workspaceId: 'wsA' }), 'rcptWrong'), undefined);
    closeStore(opened);
  } finally {
    removeTempDir(dir);
  }
});

test('a declared command stopped by its time bound is refused; a caller may allow longer', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'bound.sqlite');
  try {
    const opened = openTest(dbPath);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const slow = manifest(dir, 'slow-ran', { receiptId: 'rcptSlow', evidenceId: 'evSlow' });
    const stopped = runDeclaredCheck(opened, { ...slow.value, args: ['-e', 'setTimeout(() => {}, 30000)'] }, undefined, { timeoutMs: 300 });
    assert.equal(stopped.ok, false, 'a command still running at its bound is never accepted');
    assert.equal(rowById(listCurrent(opened, { workspaceId: 'wsA' }), 'rcptSlow'), undefined);
    const quick = manifest(dir, 'quick-ran', { receiptId: 'rcptQuick', evidenceId: 'evQuick' });
    assert.equal(runDeclaredCheck(opened, quick.value, undefined, { timeoutMs: 60_000 }).ok, true);
    assert.equal(existsSync(quick.marker), true);
    closeStore(opened);
  } finally {
    removeTempDir(dir);
  }
});

test('revision B does not inherit revision A receipts', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'revise.sqlite');
  try {
    const opened = openTest(dbPath);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const declared = manifest(dir, 'revise-ran');
    assert.equal(runDeclaredCheck(opened, declared.value).ok, true);
    assert.equal(
      insertInvalidationEdge(opened, {
        workspaceId: 'wsA',
        fromKind: 'source-revision',
        fromKey: 'rev-a',
        toKind: 'receipt',
        toId: 'rcptBound',
        resolved: 1,
      }).ok,
      true,
    );
    const revised = invalidateForRevision(opened, 'rev-a', 'rev-b');
    assert.equal(revised.ok, true);
    assert.equal(rowById(listCurrent(opened, { workspaceId: 'wsA' }), 'rcptBound'), undefined);
    const retained = rowById(listRetained(opened, { workspaceId: 'wsA' }), 'rcptBound');
    assert.ok(retained);
    assert.equal(retained.validity, 'invalidated');
    assert.notEqual(retained.validity, 'stale');
    assert.notEqual(retained.validity, 'passed');
    const rebound = manifest(dir, 'revise-b-ran', {
      receiptId: 'rcptNext',
      evidenceId: 'evNext',
      sourceRevision: 'rev-b',
      currentRevision: 'rev-b',
    });
    assert.equal(runDeclaredCheck(opened, rebound.value).ok, true);
    const next = rowById(listCurrent(opened, { workspaceId: 'wsA' }), 'rcptNext');
    assert.ok(next);
    assert.equal(next.validity, 'current');
    assert.equal(next.sourceRevision, 'rev-b');
    assert.equal(rowById(listCurrent(opened, { workspaceId: 'wsA' }), 'rcptBound'), undefined);
    closeStore(opened);
  } finally {
    removeTempDir(dir);
  }
});
