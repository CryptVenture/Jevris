import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


const { readDecisionFile, recordDecision } = await import('../dist/ledger.js');

const spec = JSON.parse(
  readFileSync(new URL('../../../fixtures/choice/failure-family.json', import.meta.url), 'utf8'),
);
const advisoryFixture = JSON.parse(
  readFileSync(new URL('../../../fixtures/ledger/advisory-record.json', import.meta.url), 'utf8'),
);

const SOURCE_CANARY = 'SOURCE_CANARY_do_not_store';
const FILE_KEYS = ['schemaVersion', 'records'];
const RECORD_KEYS = [
  'schemaVersion',
  'decisionId',
  'policyVersion',
  'evidenceRevision',
  'resolvedModel',
  'outcome',
  'reasonCode',
  'usage',
  'applied',
  'explanation',
  'nonOwnedBilling',
  'freshDecision',
  'reservationMicroUsd',
];
const RESULT_KEYS = ['applied', 'outcome', 'reasonCode', 'freshDecision', 'fileWritten'];

function validAnswerBytes() {
  const body = {
    model: 'jev-1.13.0',
    answers: {
      failureFamily: {
        type: 'choice',
        choice: 'type_error',
        confidence: 0.4,
        probabilities: {
          type_error: 0.7,
          assertion: 0.1,
          environment: 0.1,
          unknown: 0.1,
        },
      },
    },
    usage: { input_tokens: 10, output_tokens: 2 },
  };
  return new TextEncoder().encode(JSON.stringify(body));
}

function mockPort(bytes, receivedAtMs = 500) {
  return {
    calls: 0,
    async evaluate() {
      this.calls += 1;
      return { receivedAtMs, body: bytes };
    },
  };
}

function tempDestination() {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-ledger-'));
  return { dir, destination: join(dir, 'ledger.json') };
}

function advisoryArgs(destination, port, extras = {}) {
  return {
    destination,
    decisionId: 'decisionAdvisory',
    policyVersion: 'policyV1',
    evidenceRevision: 'revisionA',
    revision: {
      expected: 'revisionA',
      read() {
        return 'revisionA';
      },
    },
    clock: {
      read() {
        return 400;
      },
    },
    deadlineAtMs: 1000,
    remainingMicroUsd: '2000000',
    reservationMicroUsd: '1000000',
    attempts: 1,
    questions: 1,
    stillUseful: true,
    spec,
    input: { kind: 'ambiguous-failure' },
    port,
    signal: new AbortController().signal,
    sourceText: SOURCE_CANARY,
    usage: { inputTokens: 11, outputTokens: 3 },
    ...extras,
  };
}

test('a leftover temp from a killed write does not block the next ledger write (BLD-01)', async () => {
  const { dir, destination } = tempDestination();
  // The pre-v1.2 writer used this fixed name with O_EXCL, so a crash blocked every later write.
  writeFileSync(`${destination}.decisionAdvisory.tmp`, 'partial');
  const port = mockPort(validAnswerBytes(), 500);
  try {
    const result = await recordDecision(advisoryArgs(destination, port));
    assert.equal(result.fileWritten, true);
    assert.equal(JSON.parse(readFileSync(destination, 'utf8')).schemaVersion !== undefined, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('advisory record round-trips and stores no source', async () => {
  const { dir, destination } = tempDestination();
  const port = mockPort(validAnswerBytes(), 500);
  try {
    const result = await recordDecision(advisoryArgs(destination, port));
    assert.deepEqual(Object.keys(result), RESULT_KEYS);
    assert.equal(Object.hasOwn(result, 'message'), false);
    assert.equal(result.applied, false);
    assert.equal(result.outcome, 'advisory');
    assert.equal(result.reasonCode, 'CHOICE_RECORDED');
    assert.equal(result.freshDecision, 'not-scheduled');
    assert.equal(result.fileWritten, true);
    assert.equal(port.calls, 1);

    const bytes = readFileSync(destination);
    const text = new TextDecoder().decode(bytes);
    assert.equal(text.includes(SOURCE_CANARY), false);
    for (const banned of ['providerConfidence', 'retainedBody', 'consentFabricated', 'authorityGranted']) {
      assert.equal(text.includes(banned), false);
    }
    const parsed = JSON.parse(text);
    assert.deepEqual(parsed, advisoryFixture);
    assert.deepEqual(Object.keys(parsed), FILE_KEYS);
    assert.equal(parsed.records.length, 1);
    assert.deepEqual(Object.keys(parsed.records[0]), RECORD_KEYS);
    assert.equal(parsed.records[0].applied, false);
    assert.equal(parsed.records[0].nonOwnedBilling, 'unknown');
    assert.deepEqual(parsed.records[0].usage, { known: true, inputTokens: 11, outputTokens: 3 });
    assert.notDeepEqual(parsed.records[0].usage, { known: true, inputTokens: 10, outputTokens: 2 });

    const read = await readDecisionFile(destination);
    assert.equal(read.ok, true);
    assert.deepEqual(read.file, advisoryFixture);

    const replay = await recordDecision(advisoryArgs(destination, port));
    assert.equal(replay.applied, false);
    assert.equal(port.calls, 1);
    const again = JSON.parse(readFileSync(destination, 'utf8'));
    assert.equal(again.records.length, 1);
    assert.deepEqual(again, advisoryFixture);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fixture path is the versioned advisory document', () => {
  assert.equal(existsSync(new URL('../../../fixtures/ledger/advisory-record.json', import.meta.url)), true);
  assert.equal(advisoryFixture.schemaVersion, '1.0');
  assert.equal(advisoryFixture.records[0].decisionId, 'decisionAdvisory');
  assert.equal(advisoryFixture.records[0].resolvedModel, 'jev-1.13.0');
  assert.equal(advisoryFixture.records[0].outcome, 'advisory');
});

const SCHEMA_BODY_CANARY = 'SCHEMA_BODY_CANARY_do_not_store';
const SCHEMA_EXPLANATION = 'Decision stored and not applied: schema failure.';

test('schema-invalid body is named, redacted, and not applied', async () => {
  const { dir, destination } = tempDestination();
  const bytes = new TextEncoder().encode(`not-json ${SCHEMA_BODY_CANARY}`);
  const port = mockPort(bytes, 500);
  try {
    const result = await recordDecision(advisoryArgs(destination, port, { decisionId: 'decisionSchema' }));
    assert.equal(result.reasonCode, 'INVALID_RESPONSE');
    assert.equal(result.outcome, 'refused');
    assert.equal(result.applied, false);
    assert.equal(result.fileWritten, true);
    assert.equal(port.calls, 1);
    const text = readFileSync(destination, 'utf8');
    assert.equal(text.includes(SCHEMA_BODY_CANARY), false);
    const parsed = JSON.parse(text);
    assert.equal(parsed.records.length, 1);
    assert.equal(parsed.records[0].reasonCode, 'INVALID_RESPONSE');
    assert.equal(parsed.records[0].outcome, 'refused');
    assert.equal(parsed.records[0].explanation, SCHEMA_EXPLANATION);
    assert.equal(parsed.records[0].applied, false);
    assert.equal(parsed.records[0].nonOwnedBilling, 'unknown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt destination is not a ledger and is not replaced', async () => {
  const { dir, destination } = tempDestination();
  const corrupt = `not-a-ledger ${SCHEMA_BODY_CANARY}`;
  writeFileSync(destination, corrupt);
  const port = mockPort(validAnswerBytes(), 500);
  try {
    const read = await readDecisionFile(destination);
    assert.equal(read.ok, false);
    assert.equal(read.reasonCode, 'SCHEMA_FAILURE');
    assert.deepEqual(Object.keys(read), ['ok', 'reasonCode']);
    assert.equal(Object.hasOwn(read, 'message'), false);
    assert.equal(Object.hasOwn(read, 'file'), false);
    for (const value of Object.values(read)) {
      assert.equal(String(value).includes(SCHEMA_BODY_CANARY), false);
      assert.equal(String(value).includes(corrupt), false);
    }
    const result = await recordDecision(advisoryArgs(destination, port));
    assert.equal(result.fileWritten, false);
    assert.equal(result.applied, false);
    assert.equal(port.calls, 0);
    assert.equal(readFileSync(destination, 'utf8'), corrupt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unsafe decisionId does not create a temp path and does not enter the port', async () => {
  const { dir, destination } = tempDestination();
  const unsafe = '../not-a-safe-id';
  const port = mockPort(validAnswerBytes(), 500);
  try {
    const result = await recordDecision(advisoryArgs(destination, port, { decisionId: unsafe }));
    assert.equal(result.fileWritten, false);
    assert.equal(result.applied, false);
    assert.equal(result.outcome, 'refused');
    assert.equal(result.reasonCode, 'INVALID_REQUEST');
    assert.equal(port.calls, 0);
    assert.equal(existsSync(`${destination}.${unsafe}.tmp`), false);
    assert.equal(existsSync(destination), false);
    for (const name of readdirSync(dir)) {
      assert.equal(name.includes('not-a-safe-id'), false);
      assert.equal(name.includes('..'), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a dangerous decisionId is not used as a temp name', async () => {
  const { dir, destination } = tempDestination();
  const port = mockPort(validAnswerBytes(), 500);
  try {
    const result = await recordDecision(advisoryArgs(destination, port, { decisionId: 'constructor' }));
    assert.equal(result.fileWritten, false);
    assert.equal(result.applied, false);
    assert.equal(port.calls, 0);
    assert.equal(existsSync(`${destination}.constructor.tmp`), false);
    assert.equal(readdirSync(dir).some((name) => name.includes('constructor')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readDecisionFile rejects a ledger that is not the closed shape', async () => {
  const { dir, destination } = tempDestination();
  const base = structuredClone(advisoryFixture);
  const cases = [
    [],
    { schemaVersion: '1.0', records: [], extra: true },
    { schemaVersion: '9.0', records: [] },
    { schemaVersion: '1.0', records: [{ ...base.records[0], applied: true }] },
    { schemaVersion: '1.0', records: [{ ...base.records[0], nonOwnedBilling: 'saved' }] },
    { schemaVersion: '1.0', records: [{ ...base.records[0], usage: { known: false, inputTokens: 0 } }] },
    { schemaVersion: '1.0', records: [{ ...base.records[0], usage: { known: true, inputTokens: 1 } }] },
    JSON.parse('{"schemaVersion":"1.0","records":[],"__proto__":{"applied":true}}'),
  ];
  try {
    for (const candidate of cases) {
      writeFileSync(destination, JSON.stringify(candidate));
      const read = await readDecisionFile(destination);
      assert.equal(read.ok, false);
      assert.equal(read.reasonCode, 'SCHEMA_FAILURE');
      assert.deepEqual(Object.keys(read), ['ok', 'reasonCode']);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('overlapping writes on one destination both remain', async () => {
  const { dir, destination } = tempDestination();
  const portA = mockPort(validAnswerBytes(), 500);
  const portB = mockPort(validAnswerBytes(), 500);
  try {
    const [first, second] = await Promise.all([
      recordDecision(advisoryArgs(destination, portA, { decisionId: 'decisionAlpha' })),
      recordDecision(advisoryArgs(destination, portB, { decisionId: 'decisionBeta' })),
    ]);
    assert.equal(first.fileWritten, true);
    assert.equal(second.fileWritten, true);
    assert.equal(first.applied, false);
    assert.equal(second.applied, false);
    assert.equal(portA.calls, 1);
    assert.equal(portB.calls, 1);
    const parsed = JSON.parse(readFileSync(destination, 'utf8'));
    const ids = parsed.records.map((record) => record.decisionId).sort();
    assert.deepEqual(ids, ['decisionAlpha', 'decisionBeta']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ADVISORY_EXPLANATION = 'Decision recorded. No action was applied.';
const SAVINGS_CANARY = 'SAVINGS_CANARY_12.50';
const REASONING_CANARY = 'CLAIMED_REASONING_do_not_store';

test('advisory explanation is the template and billing is unknown', async () => {
  const { dir, destination } = tempDestination();
  const port = mockPort(validAnswerBytes(), 500);
  try {
    await recordDecision(advisoryArgs(destination, port, { savings: SAVINGS_CANARY }));
    const text = readFileSync(destination, 'utf8');
    assert.equal(text.includes('0.4'), false);
    assert.equal(text.includes('providerConfidence'), false);
    assert.equal(text.includes(SAVINGS_CANARY), false);
    assert.equal(text.includes('12.50'), false);
    assert.equal(text.includes(SOURCE_CANARY), false);
    assert.equal(text.includes('consent'), false);
    const parsed = JSON.parse(text);
    const record = parsed.records[0];
    assert.equal(record.explanation, ADVISORY_EXPLANATION);
    assert.equal(record.nonOwnedBilling, 'unknown');
    assert.equal(record.applied, false);
    for (const value of Object.values(record)) {
      if (typeof value === 'string') {
        assert.equal(value.includes('$'), false);
        assert.equal(value.includes('12.50'), false);
      }
      assert.equal(typeof value === 'number', false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('known-failure is advisory with a null model and does not enter the port', async () => {
  const { dir, destination } = tempDestination();
  const port = mockPort(validAnswerBytes(), 500);
  try {
    const result = await recordDecision(advisoryArgs(destination, port, {
      decisionId: 'decisionRules',
      input: { kind: 'known-failure', family: 'type_error' },
      [REASONING_CANARY]: 'model reasoned this',
      modelReasoning: REASONING_CANARY,
    }));
    assert.equal(port.calls, 0);
    assert.equal(result.outcome, 'advisory');
    assert.equal(result.reasonCode, 'KNOWN_FAILURE');
    assert.equal(result.applied, false);
    const text = readFileSync(destination, 'utf8');
    assert.equal(text.includes(REASONING_CANARY), false);
    assert.equal(text.includes('model reasoned'), false);
    assert.equal(text.includes('consent'), false);
    const record = JSON.parse(text).records[0];
    assert.equal(record.resolvedModel, null);
    assert.equal(record.outcome, 'advisory');
    assert.equal(record.reasonCode, 'KNOWN_FAILURE');
    assert.equal(record.explanation, ADVISORY_EXPLANATION);
    assert.equal(record.nonOwnedBilling, 'unknown');
    assert.deepEqual(record.usage, { known: true, inputTokens: 11, outputTokens: 3 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('omitted usage is unknown and does not invent zero tokens', async () => {
  const { dir, destination } = tempDestination();
  const port = mockPort(validAnswerBytes(), 500);
  const args = advisoryArgs(destination, port, { decisionId: 'decisionNoUsage' });
  delete args.usage;
  try {
    const result = await recordDecision(args);
    assert.equal(result.outcome, 'advisory');
    assert.equal(result.fileWritten, true);
    assert.equal(port.calls, 1);
    const text = readFileSync(destination, 'utf8');
    assert.equal(text.includes('"inputTokens":0'), false);
    assert.equal(text.includes('"inputTokens": 0'), false);
    assert.equal(text.includes('outputTokens'), false);
    const record = JSON.parse(text).records[0];
    assert.deepEqual(record.usage, { known: false });
    assert.equal(Object.hasOwn(record.usage, 'inputTokens'), false);
    assert.equal(record.nonOwnedBilling, 'unknown');
    assert.equal(record.explanation, ADVISORY_EXPLANATION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid usage does not enter the port and stores unknown usage', async () => {
  const { dir, destination } = tempDestination();
  const port = mockPort(validAnswerBytes(), 500);
  try {
    const result = await recordDecision(advisoryArgs(destination, port, {
      decisionId: 'decisionBadUsage',
      usage: { inputTokens: -1, outputTokens: 3 },
    }));
    assert.equal(port.calls, 0);
    assert.equal(result.outcome, 'refused');
    assert.equal(result.reasonCode, 'BUDGET');
    assert.equal(result.applied, false);
    assert.equal(result.fileWritten, true);
    const record = JSON.parse(readFileSync(destination, 'utf8')).records[0];
    assert.deepEqual(record.usage, { known: false });
    assert.equal(record.reservationMicroUsd, '0');
    assert.equal(record.explanation, 'Decision stored and not applied: budget bound.');
    assert.equal(record.nonOwnedBilling, 'unknown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const STALE_EXPLANATION = 'Decision stored and not applied: repository revision changed.';
const DEADLINE_EXPLANATION = 'Decision stored and not applied: deadline passed. Rules-only fallback.';
const BUDGET_EXPLANATION = 'Decision stored and not applied: budget bound.';

function countedSequence(values) {
  const state = { calls: 0 };
  const read = () => {
    const value = state.calls < values.length ? values[state.calls] : values[values.length - 1];
    state.calls += 1;
    return value;
  };
  return { state, read };
}

test('in-flight revision change is stored and cannot actuate', async () => {
  const { dir, destination } = tempDestination();
  const port = mockPort(validAnswerBytes(), 500);
  const revision = countedSequence(['revisionA', 'revisionB']);
  const clock = countedSequence([400, 400]);
  try {
    const result = await recordDecision(advisoryArgs(destination, port, {
      decisionId: 'decisionStaleFlight',
      revision: { expected: 'revisionA', read: revision.read },
      clock: { read: clock.read },
    }));
    assert.equal(port.calls, 1);
    assert.equal(revision.state.calls, 2);
    assert.equal(clock.state.calls, 2);
    assert.equal(result.applied, false);
    assert.equal(result.outcome, 'stale');
    assert.equal(result.reasonCode, 'STALE');
    assert.equal(result.fileWritten, true);
    const text = readFileSync(destination, 'utf8');
    assert.equal(text.includes(SOURCE_CANARY), false);
    assert.equal(text.includes('retainedBody'), false);
    const record = JSON.parse(text).records[0];
    assert.equal(record.outcome, 'stale');
    assert.equal(record.reasonCode, 'STALE');
    assert.equal(record.applied, false);
    assert.equal(record.resolvedModel, 'jev-1.13.0');
    assert.equal(record.explanation, STALE_EXPLANATION);
    assert.equal(record.reservationMicroUsd, '1000000');
    assert.equal(record.nonOwnedBilling, 'unknown');
    const replay = await recordDecision(advisoryArgs(destination, port, {
      decisionId: 'decisionStaleFlight',
      revision: { expected: 'revisionA', read: revision.read },
      clock: { read: clock.read },
    }));
    assert.equal(replay.applied, false);
    assert.equal(replay.outcome, 'stale');
    assert.equal(port.calls, 1);
    assert.equal(JSON.parse(readFileSync(destination, 'utf8')).records.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a revision that is already stale does not enter the port', async () => {
  const { dir, destination } = tempDestination();
  const port = mockPort(validAnswerBytes(), 500);
  const revision = countedSequence(['revisionB']);
  try {
    const result = await recordDecision(advisoryArgs(destination, port, {
      decisionId: 'decisionStaleBefore',
      revision: { expected: 'revisionA', read: revision.read },
    }));
    assert.equal(port.calls, 0);
    assert.equal(revision.state.calls, 1);
    assert.equal(result.outcome, 'stale');
    assert.equal(result.applied, false);
    assert.equal(result.fileWritten, true);
    const record = JSON.parse(readFileSync(destination, 'utf8')).records[0];
    assert.equal(record.outcome, 'stale');
    assert.equal(record.reasonCode, 'STALE');
    assert.equal(record.applied, false);
    assert.equal(record.resolvedModel, null);
    assert.equal(record.explanation, STALE_EXPLANATION);
    assert.equal(record.reservationMicroUsd, '0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an in-flight mismatch that is not still useful is not scheduled', async () => {
  const { dir, destination } = tempDestination();
  const port = mockPort(validAnswerBytes(), 500);
  try {
    const result = await recordDecision(advisoryArgs(destination, port, {
      decisionId: 'decisionStaleUnused',
      stillUseful: false,
      revision: {
        expected: 'revisionA',
        read: countedSequence(['revisionA', 'revisionB']).read,
      },
    }));
    assert.equal(port.calls, 1);
    assert.equal(result.freshDecision, 'not-scheduled');
    assert.equal(result.outcome, 'stale');
    assert.equal(result.applied, false);
    const record = JSON.parse(readFileSync(destination, 'utf8')).records[0];
    assert.equal(record.freshDecision, 'not-scheduled');
    assert.equal(record.resolvedModel, 'jev-1.13.0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a useful affordable in-flight mismatch is scheduled without a second port call', async () => {
  const { dir, destination } = tempDestination();
  const port = mockPort(validAnswerBytes(), 500);
  try {
    const result = await recordDecision(advisoryArgs(destination, port, {
      decisionId: 'decisionStaleScheduled',
      stillUseful: true,
      remainingMicroUsd: '2000000',
      reservationMicroUsd: '1000000',
      revision: {
        expected: 'revisionA',
        read: countedSequence(['revisionA', 'revisionB']).read,
      },
    }));
    assert.equal(port.calls, 1);
    assert.equal(result.freshDecision, 'scheduled');
    assert.equal(result.outcome, 'stale');
    assert.equal(result.applied, false);
    assert.equal(result.reasonCode, 'STALE');
    const record = JSON.parse(readFileSync(destination, 'utf8')).records[0];
    assert.equal(record.freshDecision, 'scheduled');
    assert.equal(record.applied, false);
    assert.equal(record.resolvedModel, 'jev-1.13.0');
    assert.equal(record.reservationMicroUsd, '1000000');
    const replay = await recordDecision(advisoryArgs(destination, port, {
      decisionId: 'decisionStaleScheduled',
    }));
    assert.equal(replay.freshDecision, 'scheduled');
    assert.equal(port.calls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an in-flight mismatch that consumes the remaining reservation is not scheduled', async () => {
  const { dir, destination } = tempDestination();
  const port = mockPort(validAnswerBytes(), 500);
  try {
    const result = await recordDecision(advisoryArgs(destination, port, {
      decisionId: 'decisionStaleTight',
      stillUseful: true,
      remainingMicroUsd: '1000000',
      reservationMicroUsd: '1000000',
      revision: {
        expected: 'revisionA',
        read: countedSequence(['revisionA', 'revisionB']).read,
      },
    }));
    assert.equal(port.calls, 1);
    assert.equal(result.freshDecision, 'not-scheduled');
    assert.equal(result.outcome, 'stale');
    assert.equal(result.applied, false);
    const record = JSON.parse(readFileSync(destination, 'utf8')).records[0];
    assert.equal(record.freshDecision, 'not-scheduled');
    assert.equal(record.reservationMicroUsd, '1000000');
    assert.equal(record.resolvedModel, 'jev-1.13.0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a pre-call stale refusal consumes zero and can schedule without entering the port', async () => {
  const { dir, destination } = tempDestination();
  const port = mockPort(validAnswerBytes(), 500);
  try {
    const result = await recordDecision(advisoryArgs(destination, port, {
      decisionId: 'decisionStalePreSchedule',
      stillUseful: true,
      remainingMicroUsd: '1000000',
      reservationMicroUsd: '1000000',
      revision: {
        expected: 'revisionA',
        read() {
          return 'revisionB';
        },
      },
    }));
    assert.equal(port.calls, 0);
    assert.equal(result.freshDecision, 'scheduled');
    assert.equal(result.outcome, 'stale');
    assert.equal(result.applied, false);
    const record = JSON.parse(readFileSync(destination, 'utf8')).records[0];
    assert.equal(record.freshDecision, 'scheduled');
    assert.equal(record.resolvedModel, null);
    assert.equal(record.reservationMicroUsd, '0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stored reservations are subtracted before a fresh decision is scheduled', async () => {
  const blockedDir = tempDestination();
  const fitDir = tempDestination();
  const heldBlocked = mockPort(validAnswerBytes(), 500);
  const heldFit = mockPort(validAnswerBytes(), 500);
  const blockedPort = mockPort(validAnswerBytes(), 500);
  const fitPort = mockPort(validAnswerBytes(), 500);
  try {
    await recordDecision(advisoryArgs(blockedDir.destination, heldBlocked, {
      decisionId: 'decisionHeld',
      reservationMicroUsd: '500000',
    }));
    await recordDecision(advisoryArgs(fitDir.destination, heldFit, {
      decisionId: 'decisionHeld',
      reservationMicroUsd: '500000',
    }));
    const blocked = await recordDecision(advisoryArgs(blockedDir.destination, blockedPort, {
      decisionId: 'decisionStaleBlockedSum',
      stillUseful: true,
      remainingMicroUsd: '2000000',
      reservationMicroUsd: '1000000',
      revision: {
        expected: 'revisionA',
        read: countedSequence(['revisionA', 'revisionB']).read,
      },
    }));
    assert.equal(blockedPort.calls, 1);
    assert.equal(blocked.freshDecision, 'not-scheduled');
    assert.equal(blocked.outcome, 'stale');
    const scheduled = await recordDecision(advisoryArgs(fitDir.destination, fitPort, {
      decisionId: 'decisionStaleSumFits',
      stillUseful: true,
      remainingMicroUsd: '2500000',
      reservationMicroUsd: '1000000',
      revision: {
        expected: 'revisionA',
        read: countedSequence(['revisionA', 'revisionB']).read,
      },
    }));
    assert.equal(fitPort.calls, 1);
    assert.equal(scheduled.freshDecision, 'scheduled');
    assert.equal(scheduled.applied, false);
  } finally {
    rmSync(blockedDir.dir, { recursive: true, force: true });
    rmSync(fitDir.dir, { recursive: true, force: true });
  }
});

test('unknown stored usage is a conservative hold: it counts, but a later decision that fits is admitted (DATA-07)', async () => {
  const { dir, destination } = tempDestination();
  const first = mockPort(validAnswerBytes(), 500);
  const second = mockPort(validAnswerBytes(), 500);
  const third = mockPort(validAnswerBytes(), 500);
  const firstArgs = advisoryArgs(destination, first, { decisionId: 'decisionUnknownUsage' });
  delete firstArgs.usage;
  try {
    await recordDecision(firstArgs);
    assert.equal(first.calls, 1);
    const held = JSON.parse(readFileSync(destination, 'utf8')).records[0];
    assert.deepEqual(held.usage, { known: false });
    assert.equal(Object.hasOwn(held.usage, 'inputTokens'), false);
    assert.equal(Object.hasOwn(held.usage, 'outputTokens'), false);
    assert.equal(held.reservationMicroUsd, '1000000');
    // 5,000,000 remaining minus the 1,000,000 hold still covers 1,000,000: admitted.
    const admitted = await recordDecision(advisoryArgs(destination, second, {
      decisionId: 'decisionAfterUnknown',
      remainingMicroUsd: '5000000',
      reservationMicroUsd: '1000000',
    }));
    assert.equal(second.calls, 1);
    assert.equal(admitted.outcome, 'advisory');
    // The hold still counts: 2,500,000 remaining minus 2,000,000 held does not cover 1,000,000.
    const refused = await recordDecision(advisoryArgs(destination, third, {
      decisionId: 'decisionPastHold',
      remainingMicroUsd: '2500000',
      reservationMicroUsd: '1000000',
    }));
    assert.equal(third.calls, 0);
    assert.equal(refused.outcome, 'refused');
    assert.equal(refused.reasonCode, 'BUDGET');
    assert.equal(refused.freshDecision, 'not-scheduled');
    const text = readFileSync(destination, 'utf8');
    assert.equal(text.includes('"inputTokens":0'), false);
    assert.equal(text.includes('"outputTokens":0'), false);
    const records = JSON.parse(text).records;
    assert.equal(records.length, 3);
    assert.deepEqual(records[0].usage, { known: false });
    assert.equal(records[2].reasonCode, 'BUDGET');
    assert.equal(records[2].reservationMicroUsd, '0');
    assert.equal(records[2].explanation, BUDGET_EXPLANATION);
    const replay = await recordDecision(firstArgs);
    assert.equal(replay.outcome, 'advisory');
    assert.equal(first.calls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const LATE_BODY_CANARY = 'LATE_BODY_CANARY_do_not_store';
const REGION_CANARY = 'REGION_CANARY_do_not_store';

test('a clock at the deadline is stored and not applied', async () => {
  const { dir, destination } = tempDestination();
  const port = mockPort(validAnswerBytes(), 500);
  try {
    const result = await recordDecision(advisoryArgs(destination, port, {
      decisionId: 'decisionDeadlineEqual',
      clock: {
        read() {
          return 1000;
        },
      },
      deadlineAtMs: 1000,
    }));
    assert.equal(port.calls, 0);
    assert.equal(result.outcome, 'refused');
    assert.equal(result.reasonCode, 'DEADLINE');
    assert.equal(result.applied, false);
    assert.equal(result.freshDecision, 'not-scheduled');
    assert.equal(result.fileWritten, true);
    const record = JSON.parse(readFileSync(destination, 'utf8')).records[0];
    assert.equal(record.outcome, 'refused');
    assert.equal(record.reasonCode, 'DEADLINE');
    assert.equal(record.explanation, DEADLINE_EXPLANATION);
    assert.equal(record.applied, false);
    assert.equal(record.freshDecision, 'not-scheduled');
    assert.equal(record.resolvedModel, null);
    assert.equal(record.reservationMicroUsd, '0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a non-finite clock is a deadline and does not enter the port', async () => {
  for (const now of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const { dir, destination } = tempDestination();
    const port = mockPort(validAnswerBytes(), 500);
    try {
      const result = await recordDecision(advisoryArgs(destination, port, {
        decisionId: 'decisionDeadlineNonFinite',
        clock: {
          read() {
            return now;
          },
        },
      }));
      assert.equal(port.calls, 0);
      assert.equal(result.outcome, 'refused');
      assert.equal(result.reasonCode, 'DEADLINE');
      assert.equal(result.applied, false);
      assert.equal(result.freshDecision, 'not-scheduled');
      const record = JSON.parse(readFileSync(destination, 'utf8')).records[0];
      assert.equal(record.explanation, DEADLINE_EXPLANATION);
      assert.equal(record.resolvedModel, null);
      assert.equal(record.reservationMicroUsd, '0');
      assert.equal(record.applied, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a non-finite clock after the port is a deadline and is not scheduled', async () => {
  const { dir, destination } = tempDestination();
  const port = mockPort(validAnswerBytes(), 500);
  try {
    const result = await recordDecision(advisoryArgs(destination, port, {
      decisionId: 'decisionDeadlineLateNaN',
      stillUseful: true,
      remainingMicroUsd: '2000000',
      clock: { read: countedSequence([400, Number.NaN]).read },
    }));
    assert.equal(port.calls, 1);
    assert.equal(result.reasonCode, 'DEADLINE');
    assert.equal(result.applied, false);
    assert.equal(result.freshDecision, 'not-scheduled');
    const record = JSON.parse(readFileSync(destination, 'utf8')).records[0];
    assert.equal(record.resolvedModel, 'jev-1.13.0');
    assert.equal(record.explanation, DEADLINE_EXPLANATION);
    assert.equal(record.freshDecision, 'not-scheduled');
    assert.equal(record.reservationMicroUsd, '1000000');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an in-flight deadline stores the model and is not scheduled', async () => {
  const { dir, destination } = tempDestination();
  const port = mockPort(validAnswerBytes(), 500);
  const clock = countedSequence([400, 1000]);
  const revision = countedSequence(['revisionA', 'revisionA']);
  try {
    const result = await recordDecision(advisoryArgs(destination, port, {
      decisionId: 'decisionDeadlineFlight',
      stillUseful: true,
      remainingMicroUsd: '2000000',
      reservationMicroUsd: '1000000',
      clock: { read: clock.read },
      revision: { expected: 'revisionA', read: revision.read },
    }));
    assert.equal(port.calls, 1);
    assert.equal(clock.state.calls, 2);
    assert.equal(revision.state.calls, 2);
    assert.equal(result.reasonCode, 'DEADLINE');
    assert.equal(result.outcome, 'refused');
    assert.equal(result.applied, false);
    assert.equal(result.freshDecision, 'not-scheduled');
    const record = JSON.parse(readFileSync(destination, 'utf8')).records[0];
    assert.equal(record.reasonCode, 'DEADLINE');
    assert.equal(record.applied, false);
    assert.equal(record.resolvedModel, 'jev-1.13.0');
    assert.equal(record.freshDecision, 'not-scheduled');
    assert.equal(record.explanation, DEADLINE_EXPLANATION);
    assert.equal(record.reservationMicroUsd, '1000000');
    const replay = await recordDecision(advisoryArgs(destination, port, {
      decisionId: 'decisionDeadlineFlight',
    }));
    assert.equal(replay.freshDecision, 'not-scheduled');
    assert.equal(port.calls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a late body canary is not stored and the port is not called again', async () => {
  const { dir, destination } = tempDestination();
  const bytes = new TextEncoder().encode(`late ${LATE_BODY_CANARY}`);
  const port = mockPort(bytes, 500);
  try {
    const result = await recordDecision(advisoryArgs(destination, port, {
      decisionId: 'decisionLateBody',
      stillUseful: true,
      remainingMicroUsd: '2000000',
      clock: { read: countedSequence([400, 1000]).read },
    }));
    assert.equal(port.calls, 1);
    assert.equal(result.reasonCode, 'DEADLINE');
    assert.equal(result.applied, false);
    assert.equal(result.freshDecision, 'not-scheduled');
    const text = readFileSync(destination, 'utf8');
    assert.equal(text.includes(LATE_BODY_CANARY), false);
    assert.equal(text.includes('retainedBody'), false);
    const replay = await recordDecision(advisoryArgs(destination, port, {
      decisionId: 'decisionLateBody',
    }));
    assert.equal(replay.applied, false);
    assert.equal(port.calls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a deadline record does not copy a region property', async () => {
  const { dir, destination } = tempDestination();
  const port = mockPort(validAnswerBytes(), 500);
  try {
    const result = await recordDecision(advisoryArgs(destination, port, {
      decisionId: 'decisionDeadlineRegion',
      region: REGION_CANARY,
      clock: {
        read() {
          return 1000;
        },
      },
      deadlineAtMs: 1000,
    }));
    assert.equal(port.calls, 0);
    assert.equal(result.reasonCode, 'DEADLINE');
    assert.equal(result.applied, false);
    assert.equal(result.freshDecision, 'not-scheduled');
    const text = readFileSync(destination, 'utf8');
    assert.equal(text.includes(REGION_CANARY), false);
    assert.equal(text.includes('region'), false);
    assert.equal(text.includes('eu-west'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a reservation that does not fit is stored as budget and does not enter the port', async () => {
  const { dir, destination } = tempDestination();
  const port = mockPort(validAnswerBytes(), 500);
  try {
    const result = await recordDecision(advisoryArgs(destination, port, {
      decisionId: 'decisionOverBudget',
      remainingMicroUsd: '500',
      reservationMicroUsd: '1000',
    }));
    assert.equal(port.calls, 0);
    assert.equal(result.outcome, 'refused');
    assert.equal(result.reasonCode, 'BUDGET');
    assert.equal(result.applied, false);
    assert.equal(result.freshDecision, 'not-scheduled');
    assert.equal(result.fileWritten, true);
    const record = JSON.parse(readFileSync(destination, 'utf8')).records[0];
    assert.equal(record.outcome, 'refused');
    assert.equal(record.reasonCode, 'BUDGET');
    assert.equal(record.explanation, BUDGET_EXPLANATION);
    assert.equal(record.applied, false);
    assert.equal(record.freshDecision, 'not-scheduled');
    assert.equal(record.reservationMicroUsd, '0');
    assert.equal(typeof record.reservationMicroUsd, 'string');
    assert.equal(record.nonOwnedBilling, 'unknown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a second attempt or an extra question is budget and is not fanned out', async () => {
  const cases = [
    { decisionId: 'decisionAttempts', attempts: 2, questions: 1 },
    { decisionId: 'decisionQuestions', attempts: 1, questions: 2 },
    { decisionId: 'decisionQuestionCeiling', attempts: 1, questions: 12 },
  ];
  for (const extra of cases) {
    const { dir, destination } = tempDestination();
    const port = mockPort(validAnswerBytes(), 500);
    try {
      const result = await recordDecision(advisoryArgs(destination, port, extra));
      assert.equal(port.calls, 0);
      assert.equal(result.outcome, 'refused');
      assert.equal(result.reasonCode, 'BUDGET');
      assert.equal(result.applied, false);
      assert.equal(result.freshDecision, 'not-scheduled');
      const record = JSON.parse(readFileSync(destination, 'utf8')).records[0];
      assert.equal(record.reasonCode, 'BUDGET');
      assert.equal(record.applied, false);
      assert.equal(record.reservationMicroUsd, '0');
      assert.equal(record.explanation, BUDGET_EXPLANATION);
      const replay = await recordDecision(advisoryArgs(destination, port, extra));
      assert.equal(replay.reasonCode, 'BUDGET');
      assert.equal(port.calls, 0);
      assert.equal(JSON.parse(readFileSync(destination, 'utf8')).records.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a decimal money string is budget and is not stored', async () => {
  const { dir, destination } = tempDestination();
  const port = mockPort(validAnswerBytes(), 500);
  try {
    const result = await recordDecision(advisoryArgs(destination, port, {
      decisionId: 'decisionDecimalMoney',
      reservationMicroUsd: '10.5',
    }));
    assert.equal(port.calls, 0);
    assert.equal(result.outcome, 'refused');
    assert.equal(result.reasonCode, 'BUDGET');
    assert.equal(result.applied, false);
    assert.equal(result.freshDecision, 'not-scheduled');
    const text = readFileSync(destination, 'utf8');
    assert.equal(text.includes('10.5'), false);
    const record = JSON.parse(text).records[0];
    assert.equal(record.reasonCode, 'BUDGET');
    assert.equal(record.reservationMicroUsd, '0');
    assert.equal(typeof record.reservationMicroUsd, 'string');
    assert.equal(record.applied, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stored reservation blocks a later decision that no longer fits', async () => {
  const { dir, destination } = tempDestination();
  const held = mockPort(validAnswerBytes(), 500);
  const later = mockPort(validAnswerBytes(), 500);
  try {
    const admitted = await recordDecision(advisoryArgs(destination, held, {
      decisionId: 'decisionHeldBudget',
      remainingMicroUsd: '1000000',
      reservationMicroUsd: '1000000',
    }));
    assert.equal(held.calls, 1);
    assert.equal(admitted.outcome, 'advisory');
    const blocked = await recordDecision(advisoryArgs(destination, later, {
      decisionId: 'decisionOverSum',
      remainingMicroUsd: '1000000',
      reservationMicroUsd: '1000000',
    }));
    assert.equal(later.calls, 0);
    assert.equal(blocked.outcome, 'refused');
    assert.equal(blocked.reasonCode, 'BUDGET');
    assert.equal(blocked.applied, false);
    assert.equal(blocked.freshDecision, 'not-scheduled');
    const records = JSON.parse(readFileSync(destination, 'utf8')).records;
    assert.equal(records.length, 2);
    assert.equal(records[0].reservationMicroUsd, '1000000');
    assert.equal(records[1].reasonCode, 'BUDGET');
    assert.equal(records[1].applied, false);
    assert.equal(records[1].reservationMicroUsd, '0');
    assert.equal(records[1].explanation, BUDGET_EXPLANATION);
    const replay = await recordDecision(advisoryArgs(destination, held, {
      decisionId: 'decisionHeldBudget',
      remainingMicroUsd: '1000000',
      reservationMicroUsd: '1000000',
    }));
    assert.equal(replay.outcome, 'advisory');
    assert.equal(held.calls, 1);
    assert.equal(later.calls, 0);
    const again = JSON.parse(readFileSync(destination, 'utf8')).records;
    assert.equal(again.length, 2);
    assert.equal(again[0].reservationMicroUsd, '1000000');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const THROWN_SECRET = 'SECRET_IN_ERROR_do_not_store';
const KNOWN_FAILURE_EXPLANATION = 'Decision stored and not applied.';

test('a deadline does not call the primary port or a hidden provider', async () => {
  const { dir, destination } = tempDestination();
  const port = mockPort(validAnswerBytes(), 500);
  let hidden = 0;
  try {
    const result = await recordDecision(advisoryArgs(destination, port, {
      decisionId: 'decisionDeadlineHidden',
      clock: {
        read() {
          return 1000;
        },
      },
      deadlineAtMs: 1000,
      region: REGION_CANARY,
      alternatePort() {
        hidden += 1;
      },
    }));
    assert.equal(port.calls, 0);
    assert.equal(hidden, 0);
    assert.equal(result.outcome, 'refused');
    assert.equal(result.reasonCode, 'DEADLINE');
    assert.equal(result.applied, false);
    assert.equal(result.freshDecision, 'not-scheduled');
    const text = readFileSync(destination, 'utf8');
    assert.equal(text.includes(REGION_CANARY), false);
    const record = JSON.parse(text).records[0];
    assert.equal(record.explanation, DEADLINE_EXPLANATION);
    assert.equal(record.applied, false);
    assert.equal(record.freshDecision, 'not-scheduled');
    assert.equal(record.resolvedModel, null);
    assert.equal(record.nonOwnedBilling, 'unknown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a thrown provider error is stored once and does not call a hidden provider', async () => {
  const { dir, destination } = tempDestination();
  const port = {
    calls: 0,
    async evaluate() {
      this.calls += 1;
      throw new Error(THROWN_SECRET);
    },
  };
  let hidden = 0;
  try {
    const result = await recordDecision(advisoryArgs(destination, port, {
      decisionId: 'decisionThrown',
      alternatePort() {
        hidden += 1;
      },
      region: REGION_CANARY,
    }));
    assert.equal(port.calls, 1);
    assert.equal(hidden, 0);
    assert.equal(result.outcome, 'refused');
    assert.equal(result.reasonCode, 'KNOWN_FAILURE');
    assert.equal(result.applied, false);
    assert.equal(result.freshDecision, 'not-scheduled');
    const text = readFileSync(destination, 'utf8');
    assert.equal(text.includes(THROWN_SECRET), false);
    assert.equal(text.includes(REGION_CANARY), false);
    const record = JSON.parse(text).records[0];
    assert.equal(record.outcome, 'refused');
    assert.equal(record.reasonCode, 'KNOWN_FAILURE');
    assert.equal(record.explanation, KNOWN_FAILURE_EXPLANATION);
    assert.equal(record.applied, false);
    assert.equal(record.freshDecision, 'not-scheduled');
    assert.equal(record.nonOwnedBilling, 'unknown');
    const replay = await recordDecision(advisoryArgs(destination, port, {
      decisionId: 'decisionThrown',
      alternatePort() {
        hidden += 1;
      },
    }));
    assert.equal(replay.applied, false);
    assert.equal(replay.reasonCode, 'KNOWN_FAILURE');
    assert.equal(port.calls, 1);
    assert.equal(hidden, 0);
    assert.equal(JSON.parse(readFileSync(destination, 'utf8')).records.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a region property does not change the advisory record', async () => {
  const plain = tempDestination();
  const marked = tempDestination();
  const plainPort = mockPort(validAnswerBytes(), 500);
  const markedPort = mockPort(validAnswerBytes(), 500);
  try {
    await recordDecision(advisoryArgs(plain.destination, plainPort, {
      decisionId: 'decisionRegionCompare',
    }));
    await recordDecision(advisoryArgs(marked.destination, markedPort, {
      decisionId: 'decisionRegionCompare',
      region: REGION_CANARY,
    }));
    const markedText = readFileSync(marked.destination, 'utf8');
    assert.equal(markedText.includes(REGION_CANARY), false);
    assert.equal(markedText.includes('region'), false);
    assert.deepEqual(
      JSON.parse(markedText).records[0],
      JSON.parse(readFileSync(plain.destination, 'utf8')).records[0],
    );
    assert.equal(plainPort.calls, 1);
    assert.equal(markedPort.calls, 1);
  } finally {
    rmSync(plain.dir, { recursive: true, force: true });
    rmSync(marked.dir, { recursive: true, force: true });
  }
});

test('the ledger ships no stop hook that is not certified', async () => {
  const { assertProductHooksAbsentOrCertified } = await import(new URL('../../../apps/cli/test/product-hooks.mjs', import.meta.url));
  await assertProductHooksAbsentOrCertified();
});

