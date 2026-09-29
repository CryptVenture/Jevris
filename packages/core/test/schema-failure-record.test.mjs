import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';


const { recordSchemaFailure } = await import('../dist/schema-failure-record.js');
const { validateChoiceBody } = await import('../dist/validate-choice.js');
const barrel = await import('../dist/index.js');

const spec = JSON.parse(
  readFileSync(new URL('../../../fixtures/choice/failure-family.json', import.meta.url), 'utf8'),
);

const CANARY = 'CANARY_CHOICE_not_in_spec';

function choiceBytes(choice, probabilities) {
  return new TextEncoder().encode(
    JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        failureFamily: {
          type: 'choice',
          choice,
          probabilities,
          confidence: 0.4,
        },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  );
}

const normalized = {
  type_error: 0.7,
  assertion: 0.1,
  environment: 0.1,
  unknown: 0.1,
};

const skewed = {
  type_error: 0.22,
  assertion: 0.33,
  environment: 0.34,
  unknown: 0.05,
};

function assertRedacted(record, failure) {
  assert.equal(record.failure, failure);
  assert.equal(record.applied, false);
  assert.deepEqual(Object.keys(record).sort(), ['applied', 'failure']);
  const json = JSON.stringify(record);
  assert.equal(json.includes('body'), false);
  assert.equal(json.includes('retainedBody'), false);
  assert.equal(json.includes(CANARY), false);
  assert.equal(json.includes('0.22'), false);
  assert.equal(json.includes('0.33'), false);
  assert.equal(json.includes('0.34'), false);
  assert.equal(json.includes('0.05'), false);
  assert.equal(Object.hasOwn(record, 'body'), false);
  assert.equal(Object.hasOwn(record, 'retainedBody'), false);
}

test('recordSchemaFailure is exported and does not accept a pre-labeled kind', () => {
  assert.equal(typeof recordSchemaFailure, 'function');
  assert.equal(barrel.recordSchemaFailure, recordSchemaFailure);
  for (const kind of ['unknown-candidate', 'non-normalized-distribution']) {
    let returned = false;
    assert.throws(() => {
      const record = recordSchemaFailure(kind, spec);
      if (record !== undefined && record !== null) returned = true;
    });
    assert.equal(returned, false, kind);
  }
});

test('an unknown choice is classified on the record path and stores no body', () => {
  const bytes = choiceBytes(CANARY, normalized);
  const validated = validateChoiceBody(bytes, spec);
  assert.equal(validated.ok, false);
  assert.equal(validated.reasonCode, 'INVALID_RESPONSE');
  assert.deepEqual(Object.keys(validated).sort(), ['ok', 'reasonCode']);
  assertRedacted(recordSchemaFailure(bytes, spec), 'unknown-candidate');
});

test('probabilities that do not sum to 1 are a non-normalized distribution and store no body', () => {
  const bytes = choiceBytes('type_error', skewed);
  const validated = validateChoiceBody(bytes, spec);
  assert.equal(validated.ok, false);
  assert.equal(validated.reasonCode, 'INVALID_RESPONSE');
  assert.deepEqual(Object.keys(validated).sort(), ['ok', 'reasonCode']);
  assertRedacted(recordSchemaFailure(bytes, spec), 'non-normalized-distribution');
});
