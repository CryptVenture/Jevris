import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


const SOURCE_CANARY = 'SOURCE_CANARY_do_not_store';
const RECORDED = 'Shadow comparison recorded. The agent was not changed.';
const SHADOW_COMPARISON_KEYS = [
  'schemaVersion',
  'mode',
  'policyVersion',
  'rulesRecommendation',
  'nativeRecommendation',
  'jevRecommendation',
  'actualModel',
  'actualWorker',
  'applied',
  'appliedAction',
  'actuationCount',
  'sent',
  'explanation',
];

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'jevris-shadow-'));
}

test('three-arm shadow comparison records policy version and does not change the agent', async () => {
  const { readShadowComparison, recordShadowComparison } = await import('../dist/index.js');
  const dir = tempDir();
  const destination = join(dir, 'comparison.json');
  let evaluateCalls = 0;
  const evaluate = () => {
    evaluateCalls += 1;
    throw new Error('evaluate must not run');
  };

  try {
    const result = await recordShadowComparison({
      policyVersion: 'policyV1',
      actualModel: 'claude-sonnet-5',
      rulesInput: { kind: 'known-failure', family: 'type_error', note: SOURCE_CANARY },
      jevLabel: 'jev-1.13.0',
      setting: { provenance: 'administrator', sourceEgress: 'approved-scoped' },
      untrustedClaims: [],
      destination,
      evaluate,
      explanation: SOURCE_CANARY,
    });

    assert.equal(evaluateCalls, 0);
    assert.equal(result.fileWritten, true);
    assert.equal(result.applied, false);
    assert.equal(result.sent, false);
    assert.equal(result.actuationCount, 0);
    assert.equal(JSON.stringify(result).includes(SOURCE_CANARY), false);

    const text = readFileSync(destination, 'utf8');
    assert.equal(text.includes(SOURCE_CANARY), false);
    assert.equal(existsSync(`${destination}.shadow.tmp`), false);
    assert.equal(existsSync(`${destination}.observe.tmp`), false);
    // 0600 is a POSIX mode; on Windows the file inherits its directory's ACL (BLD-09).
    if (process.platform !== 'win32') assert.equal(statSync(destination).mode & 0o777, 0o600);

    const parsed = JSON.parse(text);
    assert.deepEqual(Object.keys(parsed), SHADOW_COMPARISON_KEYS);
    assert.equal(parsed.schemaVersion, '1.0');
    assert.equal(parsed.mode, 'shadow');
    assert.equal(parsed.policyVersion, 'policyV1');
    assert.equal(parsed.rulesRecommendation, 'KNOWN_FAILURE');
    assert.equal(parsed.nativeRecommendation, 'claude-sonnet-5');
    assert.equal(parsed.jevRecommendation, 'jev-1.13.0');
    assert.equal(parsed.actualModel, 'claude-sonnet-5');
    assert.equal(parsed.actualWorker, null);
    assert.equal(parsed.applied, false);
    assert.equal(parsed.appliedAction, null);
    assert.equal(parsed.actuationCount, 0);
    assert.equal(parsed.sent, false);
    assert.equal(parsed.explanation, RECORDED);
    assert.equal(Object.hasOwn(parsed, 'source'), false);

    const read = await readShadowComparison(destination);
    assert.equal(read.ok, true);
    assert.deepEqual(read.file, parsed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function approvedSetting() {
  return { provenance: 'administrator', sourceEgress: 'approved-scoped' };
}

async function comparison(fields) {
  const { recordShadowComparison } = await import('../dist/index.js');
  return recordShadowComparison({
    policyVersion: 'policyV1',
    actualModel: 'claude-sonnet-5',
    rulesInput: { kind: 'known-failure', family: 'type_error' },
    setting: approvedSetting(),
    untrustedClaims: [],
    ...fields,
  });
}

test('a missing Jev label stays null and is not filled from the pin', async () => {
  const dir = tempDir();
  const destination = join(dir, 'comparison.json');
  try {
    const result = await comparison({ destination });
    assert.equal(result.fileWritten, true);
    assert.equal(result.sent, false);
    assert.equal(result.actuationCount, 0);
    const parsed = JSON.parse(readFileSync(destination, 'utf8'));
    assert.equal(parsed.jevRecommendation, null);
    assert.equal(parsed.actualModel, 'claude-sonnet-5');
    assert.equal(parsed.nativeRecommendation, 'claude-sonnet-5');
    assert.notEqual(parsed.jevRecommendation, parsed.actualModel);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('denied egress nulls the Jev arm and does not send', async () => {
  const dir = tempDir();
  const destination = join(dir, 'comparison.json');
  try {
    const { recordShadowComparison } = await import('../dist/index.js');
    const result = await recordShadowComparison({
      policyVersion: 'policyV1',
      actualModel: 'claude-sonnet-5',
      rulesInput: { kind: 'known-failure', family: 'type_error' },
      jevLabel: 'jev-1.13.0',
      untrustedClaims: [],
      destination,
    });
    assert.equal(result.fileWritten, true);
    assert.equal(result.sent, false);
    const parsed = JSON.parse(readFileSync(destination, 'utf8'));
    assert.equal(parsed.jevRecommendation, null);
    assert.equal(parsed.sent, false);
    assert.equal(Object.hasOwn(parsed, 'source'), false);
    assert.equal(parsed.actualModel, 'claude-sonnet-5');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ambiguous rules input stores a null rules arm and keeps the pin', async () => {
  const dir = tempDir();
  const destination = join(dir, 'comparison.json');
  try {
    const result = await comparison({
      rulesInput: { kind: 'ambiguous-failure' },
      jevLabel: 'jev-1.13.0',
      destination,
    });
    assert.equal(result.fileWritten, true);
    assert.equal(result.actuationCount, 0);
    const parsed = JSON.parse(readFileSync(destination, 'utf8'));
    assert.equal(parsed.rulesRecommendation, null);
    assert.equal(parsed.nativeRecommendation, 'claude-sonnet-5');
    assert.equal(parsed.actualModel, 'claude-sonnet-5');
    assert.equal(parsed.actuationCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('source text is not copied and an invalid label stays null', async () => {
  const dir = tempDir();
  const destination = join(dir, 'comparison.json');
  const omitted = join(dir, 'invalid-label.json');
  try {
    const rejected = await comparison({
      jevLabel: 'jev-1.13.0',
      destination,
      sourceText: SOURCE_CANARY,
      secretText: SOURCE_CANARY,
      body: SOURCE_CANARY,
    });
    assert.equal(rejected.fileWritten, false);
    assert.equal(existsSync(destination), false);
    assert.equal(JSON.stringify(rejected).includes(SOURCE_CANARY), false);

    const invalid = await comparison({
      jevLabel: 'not a label',
      destination: omitted,
    });
    assert.equal(invalid.fileWritten, true);
    assert.equal(invalid.sent, false);
    const parsed = JSON.parse(readFileSync(omitted, 'utf8'));
    assert.equal(parsed.jevRecommendation, null);
    assert.equal(parsed.sent, false);
    assert.equal(parsed.actualModel, 'claude-sonnet-5');
    assert.equal(readFileSync(omitted, 'utf8').includes(SOURCE_CANARY), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the contracts barrel re-exports the comparison type and keeps the pinned model', async () => {
  const contracts = await import('../../contracts/dist/index.js');
  const declarations = readFileSync(new URL('../../contracts/dist/index.d.ts', import.meta.url), 'utf8');
  assert.equal(contracts.PINNED_MODEL, 'jev-1.13.0');
  assert.deepEqual([...contracts.SHADOW_COMPARISON_KEYS], SHADOW_COMPARISON_KEYS);
  assert.equal(contracts.SHADOW_COMPARISON_SCHEMA_VERSION, '1.0');
  assert.equal(declarations.includes('ShadowComparisonFile'), true);
});

test('a dangerous key, an empty policy version, or an empty pin writes nothing', async () => {
  const { recordShadowComparison } = await import('../dist/index.js');
  const dir = tempDir();
  const cases = [
    {
      name: 'constructor',
      input: {
        policyVersion: 'policyV1',
        actualModel: 'claude-sonnet-5',
        rulesInput: { kind: 'known-failure', family: 'type_error' },
        constructor: 'nope',
      },
    },
    {
      name: 'empty-policy',
      input: {
        policyVersion: '',
        actualModel: 'claude-sonnet-5',
        rulesInput: { kind: 'known-failure', family: 'type_error' },
      },
    },
    {
      name: 'empty-pin',
      input: {
        policyVersion: 'policyV1',
        actualModel: '',
        rulesInput: { kind: 'known-failure', family: 'type_error' },
      },
    },
  ];
  try {
    for (const item of cases) {
      const destination = join(dir, `${item.name}.json`);
      const result = await recordShadowComparison({ ...item.input, destination });
      assert.equal(result.fileWritten, false, item.name);
      assert.equal(existsSync(destination), false, item.name);
      assert.equal(existsSync(`${destination}.shadow.tmp`), false, item.name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an oversize comparison file is not accepted and its body is not thrown', async () => {
  const { MAX_REQUEST_BYTES } = await import('../../contracts/dist/index.js');
  const { readShadowComparison } = await import('../dist/index.js');
  const dir = tempDir();
  const destination = join(dir, 'oversize.json');
  const body = `{"planted":"${'A'.repeat(MAX_REQUEST_BYTES)}"}`;
  try {
    writeFileSync(destination, body);
    assert.equal(Buffer.byteLength(body) > MAX_REQUEST_BYTES, true);
    const read = await readShadowComparison(destination);
    assert.equal(read.ok, false);
    assert.equal(JSON.stringify(read).includes('AAAA'), false);
    assert.equal(Object.hasOwn(read, 'body'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a tampered comparison is not accepted and an omitted path stays in memory', async () => {
  const { readShadowComparison, recordShadowComparison } = await import('../dist/index.js');
  const dir = tempDir();
  const destination = join(dir, 'tampered.json');
  const planted = `${SOURCE_CANARY}${'B'.repeat(32)}`;
  try {
    const omitted = await recordShadowComparison({
      policyVersion: 'policyV1',
      actualModel: 'claude-sonnet-5',
      rulesInput: { kind: 'known-failure', family: 'type_error' },
      jevLabel: 'jev-1.13.0',
      setting: approvedSetting(),
      untrustedClaims: [],
    });
    assert.equal(omitted.fileWritten, false);
    assert.equal(omitted.accepted, true);
    assert.equal(omitted.file.applied, false);
    assert.equal(omitted.file.actualWorker, null);
    assert.equal(omitted.file.actuationCount, 0);
    assert.equal(omitted.file.policyVersion, 'policyV1');

    writeFileSync(
      destination,
      JSON.stringify({
        schemaVersion: '1.0',
        mode: 'shadow',
        policyVersion: 'policyV1',
        rulesRecommendation: planted,
        nativeRecommendation: 'claude-sonnet-5',
        jevRecommendation: null,
        actualModel: 'claude-sonnet-5',
        actualWorker: null,
        applied: true,
        appliedAction: null,
        actuationCount: 0,
        sent: false,
        explanation: RECORDED,
        source: planted,
      }),
    );
    const read = await readShadowComparison(destination);
    assert.equal(read.ok, false);
    assert.equal(JSON.stringify(read).includes(SOURCE_CANARY), false);
    assert.equal(JSON.stringify(read).includes(planted), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shadow does not widen observe, the runtime module, or the hook adapter', async () => {
  const { OBSERVATION_KEYS } = await import('../../contracts/dist/index.js');
  assert.equal(OBSERVATION_KEYS.length, 12);
  assert.equal(OBSERVATION_KEYS.includes('rulesRecommendation'), false);
  assert.equal(OBSERVATION_KEYS.includes('jevRecommendation'), false);
});

const FEEDBACK_KEYS = [
  'schemaVersion',
  'kind',
  'policyVersion',
  'recommendationId',
  'decision',
  'reason',
  'published',
  'policyChanged',
];

const CLOSED_REASONS = ['preference', 'unavailable-context', 'error', 'unspecified'];

test('a rejected recommendation is stored as feedback with a closed reason', async () => {
  const { recordRecommendationFeedback } = await import('../dist/index.js');
  const dir = tempDir();
  const destination = join(dir, 'feedback.json');
  try {
    const result = await recordRecommendationFeedback({
      policyVersion: 'policyV1',
      recommendationId: 'rec1',
      reason: 'preference',
      destination,
      note: SOURCE_CANARY,
      published: true,
      policyChanged: true,
      decision: 'rejected',
    });

    assert.equal(result.accepted, true);
    assert.equal(result.fileWritten, true);
    assert.equal(result.applied, false);
    assert.equal(result.sent, false);
    assert.equal(result.actuationCount, 0);
    assert.equal(JSON.stringify(result).includes(SOURCE_CANARY), false);

    const text = readFileSync(destination, 'utf8');
    assert.equal(text.includes(SOURCE_CANARY), false);
    assert.equal(existsSync(`${destination}.feedback.tmp`), false);
    assert.equal(existsSync(`${destination}.observe.tmp`), false);
    assert.equal(existsSync(`${destination}.shadow.tmp`), false);
    // 0600 is a POSIX mode; on Windows the file inherits its directory's ACL (BLD-09).
    if (process.platform !== 'win32') assert.equal(statSync(destination).mode & 0o777, 0o600);

    const parsed = JSON.parse(text);
    assert.deepEqual(Object.keys(parsed), FEEDBACK_KEYS);
    assert.equal(parsed.schemaVersion, '1.0');
    assert.equal(parsed.kind, 'recommendation-feedback');
    assert.equal(parsed.policyVersion, 'policyV1');
    assert.equal(parsed.recommendationId, 'rec1');
    assert.equal(parsed.decision, 'rejected');
    assert.equal(parsed.reason, 'preference');
    assert.equal(parsed.published, false);
    assert.equal(parsed.policyChanged, false);
    assert.equal(Object.hasOwn(parsed, 'source'), false);
    assert.equal(Object.hasOwn(parsed, 'threshold'), false);
    assert.equal(Object.hasOwn(parsed, 'note'), false);

    for (const reason of ['unavailable-context', 'error', 'unspecified']) {
      const path = join(dir, `${reason}.json`);
      const stored = await recordRecommendationFeedback({
        policyVersion: 'policyV1',
        recommendationId: 'rec1',
        reason,
        destination: path,
      });
      assert.equal(stored.fileWritten, true, reason);
      assert.equal(stored.applied, false, reason);
      assert.equal(stored.actuationCount, 0, reason);
      const body = JSON.parse(readFileSync(path, 'utf8'));
      assert.deepEqual(Object.keys(body), FEEDBACK_KEYS, reason);
      assert.equal(body.decision, 'rejected', reason);
      assert.equal(body.reason, reason, reason);
      assert.equal(body.published, false, reason);
      assert.equal(body.policyChanged, false, reason);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an omitted reason is unspecified and a free-text reason writes nothing', async () => {
  const { recordRecommendationFeedback } = await import('../dist/index.js');
  const dir = tempDir();
  const omitted = join(dir, 'omitted.json');
  const memoryOnly = join(dir, 'not-created.json');
  try {
    const stored = await recordRecommendationFeedback({
      policyVersion: 'policyV1',
      recommendationId: 'rec1',
      destination: omitted,
    });
    assert.equal(stored.accepted, true);
    assert.equal(stored.fileWritten, true);
    assert.equal(stored.file.reason, 'unspecified');
    assert.equal(stored.file.decision, 'rejected');
    assert.equal(stored.file.published, false);
    assert.equal(stored.file.policyChanged, false);
    assert.equal(JSON.parse(readFileSync(omitted, 'utf8')).reason, 'unspecified');

    const inMemory = await recordRecommendationFeedback({
      policyVersion: 'policyV1',
      recommendationId: 'rec1',
      reason: 'preference',
    });
    assert.equal(inMemory.accepted, true);
    assert.equal(inMemory.fileWritten, false);
    assert.equal(inMemory.applied, false);
    assert.equal(inMemory.sent, false);
    assert.equal(inMemory.actuationCount, 0);
    assert.equal(inMemory.file.decision, 'rejected');
    assert.equal(existsSync(memoryOnly), false);

    const rejected = [
      { name: 'free-text', reason: `preference ${SOURCE_CANARY}` },
      { name: 'spaced-label', reason: 'unavailable context' },
      { name: 'fifth-label', reason: 'drift' },
      { name: 'empty-reason', reason: '' },
      { name: 'canary-reason', reason: SOURCE_CANARY },
    ];
    for (const item of rejected) {
      const destination = join(dir, `${item.name}.json`);
      const result = await recordRecommendationFeedback({
        policyVersion: 'policyV1',
        recommendationId: 'rec1',
        reason: item.reason,
        destination,
      });
      assert.equal(result.accepted, false, item.name);
      assert.equal(result.fileWritten, false, item.name);
      assert.equal(result.applied, false, item.name);
      assert.equal(result.actuationCount, 0, item.name);
      assert.equal(existsSync(destination), false, item.name);
      assert.equal(existsSync(`${destination}.feedback.tmp`), false, item.name);
      assert.equal(JSON.stringify(result).includes(SOURCE_CANARY), false, item.name);
    }

    const notRejected = await recordRecommendationFeedback({
      policyVersion: 'policyV1',
      recommendationId: 'rec1',
      reason: 'preference',
      decision: 'accepted',
      destination: join(dir, 'accepted.json'),
    });
    assert.equal(notRejected.fileWritten, false);
    assert.equal(existsSync(join(dir, 'accepted.json')), false);

    const badId = await recordRecommendationFeedback({
      policyVersion: 'policyV1',
      recommendationId: 'rec 1',
      reason: 'error',
      destination: join(dir, 'bad-id.json'),
    });
    assert.equal(badId.fileWritten, false);
    assert.equal(existsSync(join(dir, 'bad-id.json')), false);

    const sourced = await recordRecommendationFeedback({
      policyVersion: 'policyV1',
      recommendationId: 'rec1',
      reason: 'preference',
      destination: join(dir, 'sourced.json'),
      source: SOURCE_CANARY,
    });
    assert.equal(sourced.fileWritten, false);
    assert.equal(existsSync(join(dir, 'sourced.json')), false);
    assert.equal(JSON.stringify(sourced).includes(SOURCE_CANARY), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the contracts barrel re-exports the feedback type and does not widen the comparison', async () => {
  const contracts = await import('../../contracts/dist/index.js');
  const declarations = readFileSync(new URL('../../contracts/dist/index.d.ts', import.meta.url), 'utf8');
  assert.equal(declarations.includes('RecommendationFeedbackFile'), true);
  assert.deepEqual([...contracts.SHADOW_COMPARISON_KEYS], SHADOW_COMPARISON_KEYS);
  assert.equal(contracts.SHADOW_COMPARISON_KEYS.includes('decision'), false);
  assert.equal(contracts.SHADOW_COMPARISON_KEYS.includes('policyChanged'), false);
  assert.equal(contracts.SHADOW_COMPARISON_KEYS.includes('reason'), false);
  assert.deepEqual([...contracts.FEEDBACK_KEYS], FEEDBACK_KEYS);
});

const DRAFT_KEYS = [
  'schemaVersion',
  'kind',
  'policyVersion',
  'published',
  'loaded',
];

test('an unpublished calibration draft does not change policy or packs', async () => {
  const { applyRules } = await import('../dist/rules.js');
  const { recordRecommendationFeedback, recordShadowComparison } = await import('../dist/index.js');
  const dir = tempDir();
  const packs = join(dir, 'packs');
  mkdirSync(packs);
  writeFileSync(join(packs, 'kept.json'), '{"kept":true}\n');
  const before = readdirSync(packs);
  const destination = join(dir, 'feedback.json');
  const draftDestination = join(dir, 'draft.json');
  const comparison = join(dir, 'comparison.json');
  const jevrisPacks = join(dir, '.jevris', 'packs');
  mkdirSync(jevrisPacks, { recursive: true });
  writeFileSync(join(jevrisPacks, 'existing.json'), '{"existing":true}\n');
  const packsBefore = readdirSync(jevrisPacks);
  try {
    const result = await recordRecommendationFeedback({
      policyVersion: 'policyV1',
      recommendationId: 'rec1',
      reason: 'error',
      destination,
      draftDestination,
      threshold: 0.5,
      published: true,
      loaded: true,
    });
    assert.equal(result.accepted, true);
    assert.equal(result.fileWritten, true);
    assert.equal(result.draftWritten, true);
    assert.equal(result.applied, false);
    assert.equal(result.sent, false);
    assert.equal(result.actuationCount, 0);
    assert.equal(result.file.published, false);
    assert.equal(result.file.policyChanged, false);

    const text = readFileSync(draftDestination, 'utf8');
    assert.equal(text.includes('threshold'), false);
    assert.equal(text.includes(SOURCE_CANARY), false);
    assert.equal(existsSync(`${draftDestination}.draft.tmp`), false);
    assert.equal(existsSync(`${draftDestination}.shadow.tmp`), false);
    assert.equal(existsSync(`${draftDestination}.observe.tmp`), false);
    // 0600 is a POSIX mode; on Windows the file inherits its directory's ACL (BLD-09).
    if (process.platform !== 'win32') assert.equal(statSync(draftDestination).mode & 0o777, 0o600);
    const draft = JSON.parse(text);
    assert.deepEqual(Object.keys(draft), DRAFT_KEYS);
    assert.equal(draft.schemaVersion, '1.0');
    assert.equal(draft.kind, 'calibration-proposal');
    assert.equal(draft.policyVersion, 'policyV1');
    assert.equal(draft.published, false);
    assert.equal(draft.loaded, false);
    assert.equal(Object.hasOwn(draft, 'threshold'), false);

    const hit = applyRules({ kind: 'known-failure', family: 'type_error' });
    assert.equal(hit.reasonCode, 'KNOWN_FAILURE');
    assert.equal(applyRules.length, 1);
    assert.deepEqual(readdirSync(packs), before);
    assert.equal(destination.startsWith(packs), false);
    assert.equal(draftDestination.startsWith(packs), false);

    const blocked = join(jevrisPacks, 'feedback.json');
    const refused = await recordRecommendationFeedback({
      policyVersion: 'policyV1',
      recommendationId: 'rec1',
      reason: 'preference',
      destination: blocked,
      draftDestination: join(jevrisPacks, 'draft.json'),
    });
    assert.equal(refused.fileWritten, false);
    assert.equal(refused.draftWritten, false);
    assert.equal(existsSync(blocked), false);
    assert.equal(existsSync(join(jevrisPacks, 'draft.json')), false);
    assert.deepEqual(readdirSync(jevrisPacks), packsBefore);

    const omittedDraft = await recordRecommendationFeedback({
      policyVersion: 'policyV1',
      recommendationId: 'rec1',
      reason: 'unavailable-context',
      destination: join(dir, 'feedback-only.json'),
    });
    assert.equal(omittedDraft.draftWritten, false);
    assert.equal(existsSync(join(dir, 'draft-invented.json')), false);
    assert.equal(existsSync(`${join(dir, 'feedback-only.json')}.draft.tmp`), false);

    writeFileSync(destination, '{"policyVersion":"policyV2"}\n');
    const next = await recordShadowComparison({
      policyVersion: 'policyV1',
      actualModel: 'claude-sonnet-5',
      rulesInput: { kind: 'known-failure', family: 'type_error' },
      destination: comparison,
    });
    assert.equal(next.file.policyVersion, 'policyV1');
    assert.equal(next.applied, false);
    assert.equal(next.actuationCount, 0);
    assert.equal(next.sent, false);
    const compared = JSON.parse(readFileSync(comparison, 'utf8'));
    assert.equal(compared.policyVersion, 'policyV1');
    assert.notEqual(compared.policyVersion, 'policyV2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rules do not import shadow and the draft contract stays unpublished', async () => {
  const contracts = await import('../../contracts/dist/index.js');
  assert.deepEqual([...contracts.DRAFT_KEYS], DRAFT_KEYS);
  assert.equal(Object.hasOwn(contracts, 'loadCalibrationDraft'), false);
});
