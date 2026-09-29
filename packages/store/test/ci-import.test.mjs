import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from './temp-dirs.mjs';


const { openStore, closeStore, importCiReceipt, listCurrent, listRetained } = await import(
  '../dist/index.js'
);

const CHECKS = ['check-a', 'check-b'];
const CURRENT = 'revCurrent';

function tempDir() {
  return makeTempDir('jevris-store-ci-');
}

function openTest(path) {
  return openStore({
    path,
    role: 'in-process-test',
    workspaceId: 'wsA',
    hostScope: 'host-a',
  });
}

function rowById(listed, id) {
  if (!listed.ok) return undefined;
  return listed.rows.find((row) => row.id === id);
}

function authorized(revision, extra) {
  return {
    issuer: 'host-ci',
    revision,
    ...extra,
  };
}

test('a missing host authorization refuses even when the body names an issuer', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'missing-auth.sqlite');
  try {
    const opened = openTest(dbPath);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const missing = importCiReceipt(
      opened,
      { receiptId: 'rcptBody', revision: CURRENT, issuer: 'from-body' },
      undefined,
      CURRENT,
      CHECKS,
    );
    assert.equal(missing.ok, false);
    assert.equal(missing.current, false);
    assert.deepEqual([...missing.mandatoryCheckIds], CHECKS);
    assert.equal(rowById(listCurrent(opened, { workspaceId: 'wsA' }), 'rcptBody'), undefined);

    const emptyIssuer = importCiReceipt(
      opened,
      { receiptId: 'rcptEmpty', revision: CURRENT },
      { issuer: '', revision: CURRENT },
      CURRENT,
      CHECKS,
    );
    assert.equal(emptyIssuer.ok, false);
    assert.equal(emptyIssuer.current, false);
    assert.deepEqual([...emptyIssuer.mandatoryCheckIds], CHECKS);
    assert.equal(rowById(listCurrent(opened, { workspaceId: 'wsA' }), 'rcptEmpty'), undefined);
    closeStore(opened);
  } finally {
    removeTempDir(dir);
  }
});

test('a body that claims passed is refused and check ids stay unchanged', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'passed.sqlite');
  try {
    const opened = openTest(dbPath);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const claimed = importCiReceipt(
      opened,
      { receiptId: 'rcptPassed', revision: CURRENT, passed: true },
      authorized(CURRENT),
      CURRENT,
      CHECKS,
    );
    assert.equal(claimed.ok, false);
    assert.equal(claimed.current, false);
    assert.deepEqual([...claimed.mandatoryCheckIds], CHECKS);
    assert.equal(claimed.mandatoryCheckIds.includes('check-a'), true);
    assert.equal(claimed.mandatoryCheckIds.includes('check-b'), true);
    assert.equal(rowById(listCurrent(opened, { workspaceId: 'wsA' }), 'rcptPassed'), undefined);

    const status = importCiReceipt(
      opened,
      { receiptId: 'rcptStatus', revision: CURRENT, status: 'passed' },
      authorized(CURRENT),
      CURRENT,
      CHECKS,
    );
    assert.equal(status.ok, false);
    assert.equal(rowById(listCurrent(opened, { workspaceId: 'wsA' }), 'rcptStatus'), undefined);
    closeStore(opened);
  } finally {
    removeTempDir(dir);
  }
});

test('a revision that is not current is not stored as current', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'stale.sqlite');
  try {
    const opened = openTest(dbPath);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const stale = importCiReceipt(
      opened,
      { receiptId: 'rcptStale', revision: 'revOld' },
      authorized('revOld'),
      CURRENT,
      CHECKS,
    );
    assert.equal(stale.current, false);
    assert.deepEqual([...stale.mandatoryCheckIds], CHECKS);
    assert.equal(rowById(listCurrent(opened, { workspaceId: 'wsA' }), 'rcptStale'), undefined);

    const historical = importCiReceipt(
      opened,
      { receiptId: 'rcptHist', revision: 'revOld' },
      authorized('revOld', { disposition: 'historical' }),
      CURRENT,
      CHECKS,
    );
    assert.equal(historical.current, false);
    assert.deepEqual([...historical.mandatoryCheckIds], CHECKS);
    assert.equal(rowById(listCurrent(opened, { workspaceId: 'wsA' }), 'rcptHist'), undefined);
    const retained = rowById(listRetained(opened, { workspaceId: 'wsA' }), 'rcptHist');
    assert.ok(retained);
    assert.equal(retained.validity, 'invalidated');
    assert.notEqual(retained.validity, 'current');
    closeStore(opened);
  } finally {
    removeTempDir(dir);
  }
});

test('a signature field does not authorize import, and a bound current body may be current', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'current.sqlite');
  try {
    const opened = openTest(dbPath);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const signed = importCiReceipt(
      opened,
      { receiptId: 'rcptSig', revision: CURRENT, signature: true },
      { signature: true, revision: CURRENT },
      CURRENT,
      CHECKS,
    );
    assert.equal(signed.ok, false);
    assert.equal(signed.current, false);
    assert.deepEqual([...signed.mandatoryCheckIds], CHECKS);
    assert.equal(rowById(listCurrent(opened, { workspaceId: 'wsA' }), 'rcptSig'), undefined);

    const poisoned = importCiReceipt(
      opened,
      `{"receiptId":"rcptPoison","revision":"${CURRENT}","note":"constructor"}`,
      authorized(CURRENT),
      CURRENT,
      CHECKS,
    );
    assert.equal(poisoned.ok, false);
    assert.equal(rowById(listCurrent(opened, { workspaceId: 'wsA' }), 'rcptPoison'), undefined);

    const oversized = importCiReceipt(opened, 'x'.repeat(131073), authorized(CURRENT), CURRENT, CHECKS);
    assert.equal(oversized.ok, false);
    assert.deepEqual([...oversized.mandatoryCheckIds], CHECKS);

    const current = importCiReceipt(
      opened,
      { receiptId: 'rcptOk', revision: CURRENT },
      authorized(CURRENT),
      CURRENT,
      CHECKS,
    );
    assert.equal(current.ok, true);
    assert.equal(current.current, true);
    assert.deepEqual([...current.mandatoryCheckIds], CHECKS);
    const row = rowById(listCurrent(opened, { workspaceId: 'wsA' }), 'rcptOk');
    assert.ok(row);
    assert.equal(row.validity, 'current');
    assert.equal(row.sourceRevision, CURRENT);
    closeStore(opened);
  } finally {
    removeTempDir(dir);
  }
});
