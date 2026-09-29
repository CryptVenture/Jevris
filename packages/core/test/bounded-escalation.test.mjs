import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


const SOURCE_CANARY = 'SOURCE_CANARY_do_not_copy';
const SENTENCE = 'the model says this is fixed and tests passed';

function loopInput(overrides = {}) {
  return {
    diagnostic: 'missing-service',
    sourceEvidence: 'absent',
    fingerprint: 'sameFingerprint',
    sameFingerprintCount: 3,
    commandHashRepeated: true,
    relevantDiff: 'none',
    rejectedApproaches: ['patch-a', 'patch-b'],
    proposedCause: 'service-down',
    maxRepairAttempts: 2,
    repairAttemptsUsed: 1,
    sentence: SENTENCE,
    source: SOURCE_CANARY,
    ...overrides,
  };
}

function assertNoLaunch(result) {
  assert.equal(result.launched, false);
  assert.equal(result.sessionStarted, false);
  assert.equal(result.leaseStarted, false);
  assert.equal(result.checkoutStarted, false);
  assert.equal(result.dagStarted, false);
  assert.equal(result.applied, false);
  assert.equal(result.authorityGranted, false);
  assert.equal(result.providerCalls, 0);
  assert.equal(JSON.stringify(result).includes(SOURCE_CANARY), false);
  assert.equal(JSON.stringify(result).includes(SENTENCE), false);
}

test('a repeated missing-service diagnostic requests environment evidence and does not escalate', async () => {
  const { adviseBoundedEscalation } = await import('../dist/index.js');
  assert.equal(typeof adviseBoundedEscalation, 'function');
  const result = adviseBoundedEscalation(loopInput());
  assert.equal(result.escalated, false);
  assert.equal(result.nextStep, 'request-environment-evidence');
  assert.equal(result.verified, false);
  assert.equal(['ask', 'pause'].includes(result.verb), true);
  assertNoLaunch(result);
  const exhausted = adviseBoundedEscalation(
    loopInput({ repairAttemptsUsed: 2, sentence: SENTENCE }),
  );
  assert.equal(exhausted.escalated, false);
  assert.equal(exhausted.nextStep, 'request-environment-evidence');
  assert.equal(exhausted.verified, false);
  assertNoLaunch(exhausted);
});

test('one qualified source-defect escalation retains rejected approaches and cannot claim success without a receipt', async () => {
  const { adviseBoundedEscalation } = await import('../dist/index.js');
  const input = loopInput({
    diagnostic: 'source-defect',
    sourceEvidence: 'present',
    repairAttemptsUsed: 2,
    workerQualified: true,
    proposedCause: 'null-check',
  });
  const result = adviseBoundedEscalation(input);
  assert.equal(['ask', 'pause'].includes(result.verb), true);
  assert.equal(result.escalated, true);
  assert.deepEqual(result.rejectedApproaches, ['patch-a', 'patch-b']);
  assert.equal(result.verified, false);
  assert.equal(result.blocked, false);
  assertNoLaunch(result);

  const sentenceOnly = adviseBoundedEscalation({ ...input, receipt: SENTENCE });
  assert.equal(sentenceOnly.verified, false);
  assert.equal(sentenceOnly.escalated, true);

  const unbound = adviseBoundedEscalation({
    ...input,
    currentRevision: 'rev-a',
    receipt: {
      workspaceId: 'wsA',
      receiptId: 'rcptLoose',
      sourceRevision: 'rev-a',
      evidenceId: 'evLoose',
      runnerId: 'runnerA',
      commandHash: 'a'.repeat(64),
      passed: true,
    },
  });
  assert.equal(unbound.verified, false);

  const again = adviseBoundedEscalation({ ...input, priorEscalation: true });
  assert.equal(again.blocked, true);
  assert.equal(again.escalated, false);
  assert.equal(again.verified, false);
  assert.equal(again.verb, 'pause');
  assert.equal(again.text.toLowerCase().includes('blocked'), true);
  assertNoLaunch(again);

  const unqualified = adviseBoundedEscalation({ ...input, workerQualified: false });
  assert.equal(unqualified.escalated, false);
  assert.equal(unqualified.launched, false);
  assert.equal(unqualified.verified, false);
});

test('core verifies a receipt only through the injected store port (BLD-14)', async () => {
  const { adviseBoundedEscalation } = await import('../dist/index.js');
  const store = { ok: true, resolvedPath: '/tmp/jevris-escalation.sqlite' };
  const receipt = { receiptId: 'rcptA' };
  const input = loopInput({
    diagnostic: 'source-defect',
    sourceEvidence: 'present',
    repairAttemptsUsed: 2,
    workerQualified: true,
    store,
    receipt,
    currentRevision: 'rev-a',
  });
  // No port: never verified, even with a store and a receipt.
  assert.equal(adviseBoundedEscalation(input).verified, false);
  const calls = [];
  const accepting = {
    acceptRunnerReceipt(s, r, rev) {
      calls.push([s, r, rev]);
      return { ok: true };
    },
  };
  const verified = adviseBoundedEscalation(input, accepting);
  assert.equal(verified.verified, true);
  assert.equal(verified.escalated, true);
  assertNoLaunch(verified);
  assert.deepEqual(calls, [[store, receipt, 'rev-a']]);
  assert.equal(adviseBoundedEscalation(input, { acceptRunnerReceipt: () => ({ ok: false }) }).verified, false);
  const throwing = {
    acceptRunnerReceipt() {
      throw new Error('store closed');
    },
  };
  assert.equal(adviseBoundedEscalation(input, throwing).verified, false);
  // A sentence is never handed to the port.
  calls.length = 0;
  assert.equal(adviseBoundedEscalation({ ...input, receipt: SENTENCE }, accepting).verified, false);
  assert.equal(calls.length, 0);
});

test('the real store port refuses an unbound receipt (BLD-14)', async () => {
  const { adviseBoundedEscalation } = await import('../dist/index.js');
  const { openStore, closeStore, acceptRunnerReceipt } = await import('../../store/dist/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'jevris-escalation-'));
  const store = openStore({ path: join(dir, 'e.sqlite'), role: 'in-process-test', workspaceId: 'wsA', hostScope: 'host-a' });
  assert.equal(store.ok, true);
  try {
    const loose = {
      workspaceId: 'wsA',
      receiptId: 'rcptLoose',
      sourceRevision: 'rev-a',
      evidenceId: 'evLoose',
      runnerId: 'runnerA',
      commandHash: 'a'.repeat(64),
      passed: true,
    };
    const input = loopInput({
      diagnostic: 'source-defect',
      sourceEvidence: 'present',
      repairAttemptsUsed: 2,
      workerQualified: true,
      store,
      currentRevision: 'rev-a',
      receipt: loose,
    });
    assert.equal(adviseBoundedEscalation(input, { acceptRunnerReceipt }).verified, false);
  } finally {
    closeStore(store);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('core imports and advises with better-sqlite3 unavailable (BLD-14)', () => {
  // A URL, not a path: --import reads a Windows path's drive letter as a URL scheme.
  const block = new URL('../../../scripts/test-block-native.mjs', import.meta.url).href;
  const core = new URL('../dist/index.js', import.meta.url).href;
  const script = [
    `const core = await import(${JSON.stringify(core)});`,
    `let blocked = false; try { await import('better-sqlite3'); } catch { blocked = true; }`,
    `const r = core.adviseBoundedEscalation({ diagnostic: 'missing-service', rejectedApproaches: [] });`,
    `process.stdout.write(JSON.stringify({ blocked, verb: r.verb }));`,
  ].join('\n');
  const ran = spawnSync(process.execPath, ['--import', block, '--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(JSON.parse(ran.stdout), { blocked: true, verb: 'ask' });
});
