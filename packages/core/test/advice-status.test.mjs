import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


const { adviseRoute, ignoreAdvice, renderStatus } = await import('../dist/index.js');

const BANNED = ['accuracy', 'providerConfidence', 'route-worker', 'SOURCE_CANARY_do_not_store'];

function adviceText(policy) {
  return [
    'Advice recorded.',
    `Policy: ${policy}`,
    'The pinned model was not overridden.',
    'Mandatory checks are unchanged.',
    'No action was applied.',
    '',
  ].join('\n');
}

function assertClean(label, text) {
  for (const word of BANNED) {
    assert.equal(text.includes(word), false, `${label} contains ${word}`);
  }
  assert.equal(text.includes('\u001b'), false, `${label} contains an escape`);
}

function throwingEvaluate(counter) {
  return () => {
    counter.count += 1;
    throw new Error('evaluate must not run');
  };
}

test('permitted pin advice is unapplied and status is the seven locked lines', async () => {
  const counter = { count: 0 };
  const dir = mkdtempSync(join(tmpdir(), 'jevris-advice-'));
  const destination = join(dir, 'advice.txt');
  try {
    const result = await adviseRoute({
      mode: 'advise',
      policyVersion: 'policyV1',
      evidenceRevision: 'rev1',
      pinnedModel: 'claude-sonnet-5',
      predictedModel: 'claude-haiku-5',
      allowlist: ['claude-sonnet-5'],
      priorRecords: [],
      destination,
      evaluate: throwingEvaluate(counter),
      providerConfidence: 0.4,
      choice: 'route-worker',
      source: 'SOURCE_CANARY_do_not_store',
      accuracy: 'accuracy',
    });

    assert.equal(result.applied, false);
    assert.equal(result.toolPermission, false);
    assert.equal(result.authorityGranted, false);
    assert.equal(result.consentFabricated, false);
    assert.equal(result.verified, false);
    assert.equal(result.providerCalls, 0);
    assert.equal(result.prompted, true);
    assert.equal(result.ignored, false);
    assert.equal(result.pinnedModel, 'claude-sonnet-5');
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].pinnedModel, 'claude-sonnet-5');
    assert.equal(result.records[0].predictedModel, 'claude-haiku-5');
    assert.equal(result.records[0].applied, false);
    assert.equal(result.text, adviceText('policyV1'));
    assert.equal(result.text.includes('claude-haiku-5'), false);
    assert.equal(counter.count, 0);
    assert.equal('confidence' in result, false);
    assert.equal('providerConfidence' in result, false);
    assert.equal('accuracy' in result, false);

    const written = readFileSync(destination, 'utf8');
    assert.equal(written, result.text);
    assert.equal(result.fileWritten, true);
    assertClean('advice', result.text);
    assertClean('file', written);

    const status = renderStatus({
      mode: 'advise',
      pinnedModel: 'claude-sonnet-5',
      freshDecision: 'not-scheduled',
      health: 'recorded',
      evaluate: throwingEvaluate(counter),
      providerConfidence: 0.4,
      source: 'SOURCE_CANARY_do_not_store',
    });
    assert.equal(
      status,
      [
        'mode: advise',
        'model pin: claude-sonnet-5',
        'routing pinned: yes',
        'active worker: none',
        'budget state: not-scheduled',
        'non-owned billing: unknown',
        'decision health: recorded',
        '',
      ].join('\n'),
    );
    assert.equal(counter.count, 0);
    assertClean('status', status);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an invalid policy id is printed as rejected and is not copied', async () => {
  const result = await adviseRoute({
    mode: 'advise',
    policyVersion: 'bad policy',
    evidenceRevision: 'rev1',
    pinnedModel: 'claude-sonnet-5',
    predictedModel: 'claude-haiku-5',
    allowlist: ['claude-sonnet-5'],
    priorRecords: [],
  });
  assert.equal(result.text, adviceText('rejected'));
  assert.equal(result.text.includes('bad policy'), false);
  assert.equal(result.fileWritten, false);
  assert.equal(result.applied, false);
  assert.equal(result.providerCalls, 0);
  assertClean('rejected advice', result.text);
});

test('ignoreAdvice keeps the record and does not apply it', async () => {
  const counter = { count: 0 };
  const recorded = await adviseRoute({
    mode: 'advise',
    policyVersion: 'policyV1',
    evidenceRevision: 'rev1',
    pinnedModel: 'claude-sonnet-5',
    predictedModel: 'claude-haiku-5',
    allowlist: ['claude-sonnet-5'],
    priorRecords: [],
  });
  const ignored = ignoreAdvice({
    ...recorded,
    evaluate: throwingEvaluate(counter),
    text: 'SOURCE_CANARY_do_not_store',
  });
  assert.equal(ignored.text, adviceText('policyV1'));
  assert.equal(ignored.text, recorded.text);
  assert.equal(ignored.ignored, true);
  assert.equal(ignored.prompted, false);
  assert.equal(ignored.applied, false);
  assert.equal(ignored.toolPermission, false);
  assert.equal(ignored.authorityGranted, false);
  assert.equal(ignored.consentFabricated, false);
  assert.equal(ignored.verified, false);
  assert.equal(ignored.providerCalls, 0);
  assert.equal(ignored.records.length, 1);
  assert.equal(ignored.pinnedModel, 'claude-sonnet-5');
  assert.equal(counter.count, 0);
  assert.equal(ignored.text.includes('SOURCE_CANARY_do_not_store'), false);

  const contracts = await import('@jevris/contracts');
  assert.equal(contracts.PINNED_MODEL, 'jev-1.13.0');
});

test('mode off and a late object do not actuate', async () => {
  const counter = { count: 0 };
  const dir = mkdtempSync(join(tmpdir(), 'jevris-advice-off-'));
  const destination = join(dir, 'advice.txt');
  const lateChoice = 'late-choice';
  const lateModel = 'late-model-id';
  const lateBody = 'SOURCE_CANARY_do_not_store';
  try {
    const stored = await adviseRoute({
      mode: 'advise',
      policyVersion: 'policyV1',
      evidenceRevision: 'rev1',
      pinnedModel: 'claude-sonnet-5',
      predictedModel: 'claude-haiku-5',
      allowlist: ['claude-sonnet-5'],
      priorRecords: [],
      destination,
      evaluate: throwingEvaluate(counter),
    });
    const before = readFileSync(destination, 'utf8');
    assert.equal(before.includes(lateBody), false);
    assert.equal(before.includes(lateChoice), false);

    const off = await adviseRoute({
      mode: 'off',
      policyVersion: 'policyV1',
      evidenceRevision: 'rev1',
      pinnedModel: 'claude-sonnet-5',
      predictedModel: 'claude-haiku-5',
      allowlist: ['claude-sonnet-5'],
      priorRecords: stored.records,
      destination,
      choice: lateChoice,
      modelId: lateModel,
      applied: true,
      evaluate: throwingEvaluate(counter),
      body: lateBody,
    });

    assert.equal(off.applied, false);
    assert.equal(off.providerCalls, 0);
    assert.equal(off.prompted, false);
    assert.equal(off.records.length, stored.records.length);
    assert.equal(off.pinnedModel, 'claude-sonnet-5');
    assert.equal(off.pinnedModel === lateChoice, false);
    assert.equal(off.pinnedModel === lateModel, false);
    assert.equal(off.text.includes(lateChoice), false);
    assert.equal(off.text.includes(lateModel), false);
    assert.equal(off.text.includes(lateBody), false);
    assert.equal(counter.count, 0);
    assert.equal(readFileSync(destination, 'utf8'), before);

    const offStatus = renderStatus({
      mode: 'off',
      freshDecision: 'not-scheduled',
      health: 'recorded',
      evaluate: throwingEvaluate(counter),
    });
    assert.match(offStatus, /mode: off\n/);
    assert.match(offStatus, /decision health: off\n/);
    assert.equal(offStatus.includes('error:'), false);
    assert.equal(offStatus.includes('\u001b'), false);
    assert.equal(counter.count, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the same advice key prompts once and a disallowed pin is not switched', async () => {
  const counter = { count: 0 };
  const dir = mkdtempSync(join(tmpdir(), 'jevris-advice-repeat-'));
  const firstPath = join(dir, 'first.txt');
  const repeatPath = join(dir, 'repeat.txt');
  try {
    const first = await adviseRoute({
      mode: 'advise',
      policyVersion: 'policyV1',
      evidenceRevision: 'rev1',
      pinnedModel: 'claude-sonnet-5',
      predictedModel: 'claude-haiku-5',
      allowlist: ['claude-sonnet-5'],
      priorRecords: [],
      destination: firstPath,
      evaluate: throwingEvaluate(counter),
    });
    assert.equal(first.prompted, true);
    assert.equal(first.records.length, 1);
    assert.equal(first.applied, false);
    assert.equal(first.text.includes('?'), false);

    const repeat = await adviseRoute({
      mode: 'advise',
      policyVersion: 'policyV1',
      evidenceRevision: 'rev1',
      pinnedModel: 'claude-sonnet-5',
      predictedModel: 'claude-haiku-5',
      allowlist: ['claude-sonnet-5'],
      priorRecords: [
        {
          ...first.records[0],
          text: 'please switch?\nSOURCE_CANARY_do_not_store',
        },
      ],
      destination: repeatPath,
      evaluate: throwingEvaluate(counter),
    });
    assert.equal(repeat.prompted, false);
    assert.equal(repeat.records.length, 1);
    assert.equal(repeat.text, adviceText('policyV1'));
    assert.equal(repeat.text.includes('?'), false);
    assert.equal(repeat.text.includes('SOURCE_CANARY_do_not_store'), false);
    assert.equal(repeat.fileWritten, false);
    assert.equal(existsSync(repeatPath), false);
    assert.equal(repeat.applied, false);
    assert.equal(repeat.providerCalls, 0);

    const changed = await adviseRoute({
      mode: 'advise',
      policyVersion: 'policyV1',
      evidenceRevision: 'rev2',
      pinnedModel: 'claude-sonnet-5',
      predictedModel: 'claude-haiku-5',
      allowlist: ['claude-sonnet-5'],
      priorRecords: first.records,
      evaluate: throwingEvaluate(counter),
    });
    assert.equal(changed.records.length, 2);
    assert.equal(changed.prompted, true);
    assert.equal(changed.applied, false);
    assert.equal(changed.records[0].applied, false);
    assert.equal(changed.records[1].applied, false);
    assert.equal(changed.records[1].prompted, true);
    assert.equal(changed.records[1].evidenceRevision, 'rev2');
    assert.equal(changed.text.includes('?'), false);
    assert.equal(changed.text, adviceText('policyV1'));

    const disallowed = await adviseRoute({
      mode: 'advise',
      policyVersion: 'policyV1',
      evidenceRevision: 'rev1',
      pinnedModel: 'claude-sonnet-5',
      predictedModel: 'claude-haiku-5',
      allowlist: ['claude-haiku-5'],
      priorRecords: [],
      evaluate: throwingEvaluate(counter),
    });
    assert.equal(disallowed.pinnedModel, 'claude-sonnet-5');
    assert.equal(disallowed.records[0].pinnedModel, 'claude-sonnet-5');
    assert.equal(disallowed.records[0].predictedModel, 'claude-haiku-5');
    assert.equal(disallowed.pinnedModel === 'claude-haiku-5', false);
    assert.equal(disallowed.applied, false);
    assert.equal(disallowed.text, adviceText('policyV1'));
    assert.equal(disallowed.text.includes('The pinned model was not overridden.'), true);
    assert.equal(disallowed.text.includes('?'), false);
    assert.equal(counter.count, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function statusBase(overrides) {
  return {
    mode: 'advise',
    pinnedModel: 'claude-sonnet-5',
    freshDecision: 'not-scheduled',
    health: 'recorded',
    ...overrides,
  };
}

test('status errors are words and templates omit confidence', async () => {
  const counter = { count: 0 };
  const refused = renderStatus(statusBase({ health: 'refused' }));
  assert.match(refused, /decision health: refused\n/);
  assert.match(refused, /error: REFUSED\n/);
  assert.equal(refused.includes('\u001b'), false);
  assert.equal(refused.includes('$'), false);

  const stale = renderStatus(statusBase({ health: 'stale', freshDecision: 'scheduled' }));
  assert.match(stale, /error: STALE\n/);
  assert.match(stale, /decision health: stale\n/);
  assert.match(stale, /budget state: scheduled\n/);

  const bound = renderStatus(
    statusBase({
      health: 'budget-bound',
      reasonCode: 'BUDGET',
      freshDecision: 'scheduled',
      reservationMicroUsd: '1500',
    }),
  );
  assert.match(bound, /budget state: bound\n/);
  assert.match(bound, /decision health: budget-bound\n/);
  assert.match(bound, /error: BUDGET\n/);
  assert.match(bound, /reservationMicroUsd: 1500\n/);
  assert.equal(bound.includes('$'), false);
  assert.equal(bound.includes('\u001b'), false);

  const badReservation = renderStatus(
    statusBase({
      health: 'recorded',
      reservationMicroUsd: '12.50',
    }),
  );
  assert.equal(badReservation.includes('12.50'), false);
  assert.equal(badReservation.includes('reservationMicroUsd'), false);
  assert.equal(badReservation.includes('$'), false);

  const off = renderStatus({
    mode: 'off',
    freshDecision: 'not-scheduled',
    health: 'refused',
    reasonCode: 'BUDGET',
  });
  assert.match(off, /mode: off\n/);
  assert.match(off, /decision health: off\n/);
  assert.equal(off.includes('error:'), false);

  const ready = renderStatus(statusBase({ mode: 'ready' }));
  assert.match(ready, /mode: unsupported\n/);
  assert.equal(ready.includes('ready'), false);

  const bounded = renderStatus(statusBase({ mode: 'bounded-auto' }));
  assert.match(bounded, /mode: unsupported\n/);
  assert.equal(bounded.includes('bounded-auto'), false);

  const observe = renderStatus(statusBase({ mode: 'observe' }));
  assert.match(observe, /mode: observe\n/);

  const omitted = renderStatus({
    mode: 'advise',
    freshDecision: 'not-scheduled',
    health: 'recorded',
  });
  assert.match(omitted, /model pin: rejected\n/);
  assert.match(omitted, /routing pinned: no\n/);

  const hostileStatus = renderStatus({
    mode: 'advise',
    pinnedModel: 'route-worker',
    freshDecision: 'not-scheduled',
    health: 'recorded',
    providerConfidence: 0.4,
    source: 'SOURCE_CANARY_do_not_store',
    choice: 'route-worker',
    accuracy: 'accuracy',
    evaluate: throwingEvaluate(counter),
  });
  assert.match(hostileStatus, /model pin: rejected\n/);
  assert.equal(hostileStatus.includes('route-worker'), false);
  assert.equal(hostileStatus.includes('accuracy'), false);
  assert.equal(hostileStatus.includes('0.4'), false);
  assert.equal(hostileStatus.includes('SOURCE_CANARY_do_not_store'), false);
  assert.equal(counter.count, 0);

  const dir = mkdtempSync(join(tmpdir(), 'jevris-advice-hostile-'));
  const destination = join(dir, 'advice.txt');
  try {
    const hostileAdvice = await adviseRoute({
      mode: 'advise',
      policyVersion: 'accuracy',
      evidenceRevision: 'rev1',
      pinnedModel: 'route-worker',
      predictedModel: 'claude-haiku-5',
      allowlist: ['route-worker', 'accuracy'],
      priorRecords: [],
      destination,
      providerConfidence: 0.4,
      source: 'SOURCE_CANARY_do_not_store',
      choice: 'route-worker',
      accuracy: 'accuracy',
      evaluate: throwingEvaluate(counter),
    });
    assert.equal(hostileAdvice.text, adviceText('rejected'));
    assert.equal(hostileAdvice.pinnedModel, 'rejected');
    assert.equal(hostileAdvice.text.includes('accuracy'), false);
    assert.equal(hostileAdvice.text.includes('route-worker'), false);
    assert.equal(hostileAdvice.text.includes('0.4'), false);
    assert.equal(hostileAdvice.text.includes('SOURCE_CANARY_do_not_store'), false);
    assert.equal(JSON.stringify(hostileAdvice).includes('accuracy'), false);
    assert.equal(JSON.stringify(hostileAdvice).includes('route-worker'), false);
    const written = readFileSync(destination, 'utf8');
    assert.equal(written.includes('accuracy'), false);
    assert.equal(written.includes('route-worker'), false);
    assert.equal(counter.count, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
