import test from 'node:test';
import assert from 'node:assert/strict';

const core = await import('../dist/index.js');
const { validateJevResponse, validateJevRequest, validationPolicy, DEFAULT_VALIDATION_POLICY } = core;

const QUESTIONS = {
  family: {
    type: 'choice',
    instructions: 'Which listed family best matches the observed failure?',
    criteria: { type_error: 'A type checker rejected the code.', assertion: 'An assertion failed.', unknown: 'None fits.' },
  },
  reach: { type: 'score', instructions: 'How far does the change reach?', criteria: ['Docs only.', 'Local change.', 'Public interface.'] },
  missing: { type: 'noul', instructions: 'Is required evidence missing?' },
};

function body(overrides = {}) {
  const base = {
    model: 'jev-1.13.0',
    answers: {
      family: { type: 'choice', choice: 'type_error', probabilities: { type_error: 0.7, assertion: 0.2, unknown: 0.1 }, confidence: 0.7 },
      reach: { type: 'score', score: 0.2 * 1 + 0.1 * 2, probabilities: { 0: 0.7, 1: 0.2, 2: 0.1 }, legend: { 0: 'Docs only.', 1: 'Local change.', 2: 'Public interface.' }, confidence: 0.7 },
      missing: { type: 'noul', noul: 0.83 },
    },
    usage: { input_tokens: 412, output_tokens: 39 },
  };
  return { ...base, ...overrides };
}
const enc = (value) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));

test('PRV-01: Choice, Score and Noul validate together with usage and the resolved model', () => {
  const result = validateJevResponse(enc(body()), QUESTIONS);
  assert.equal(result.ok, true);
  assert.equal(result.model, 'jev-1.13.0');
  assert.deepEqual(result.usage, { inputTokens: 412, outputTokens: 39 });
  assert.equal(result.answers.family.choice, 'type_error');
  assert.equal(result.answers.family.providerConfidence, 0.7);
  assert.equal(result.answers.reach.type, 'score');
  assert.deepEqual(result.answers.reach.legend, { 0: 'Docs only.', 1: 'Local change.', 2: 'Public interface.' });
  assert.deepEqual(result.answers.missing, { type: 'noul', noul: 0.83 });
  assert.equal(Object.hasOwn(result.answers.missing, 'providerConfidence'), false);
});

test('PRV-01: up to 12 questions are accepted and a 13th is refused before sending', () => {
  const twelve = {};
  for (let i = 0; i < 12; i += 1) twelve[`q${i}`] = { type: 'noul', instructions: `Is item ${i} present?` };
  assert.equal(validateJevRequest({ model: 'jev-1.13.0', state: 'fixture', questions: twelve }).ok, true);
  const thirteen = { ...twelve, q12: { type: 'noul', instructions: 'Is item 12 present?' } };
  assert.equal(validateJevRequest({ model: 'jev-1.13.0', state: 'fixture', questions: thirteen }).ok, false);
  const longCriterion = { c: { type: 'choice', instructions: 'Pick one.', criteria: { a: 'x'.repeat(2049), unknown: 'none' } } };
  assert.equal(validateJevRequest({ model: 'jev-1.13.0', state: 'fixture', questions: longCriterion }).ok, false);
});

test('PRV-02: a deviation inside the tolerance is normalized and the original values are kept', () => {
  const tiny = body();
  tiny.answers.family.probabilities = { type_error: 0.7000004, assertion: 0.2, unknown: 0.1 };
  const result = validateJevResponse(enc(tiny), QUESTIONS);
  assert.equal(result.ok, true);
  assert.equal(result.answers.family.normalized, true);
  assert.equal(result.answers.family.original.type_error, 0.7000004);
  const sum = Object.values(result.answers.family.probabilities).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12);
  const wide = body();
  wide.answers.family.probabilities = { type_error: 0.75, assertion: 0.2, unknown: 0.1 };
  const refused = validateJevResponse(enc(wide), QUESTIONS);
  assert.equal(refused.ok, false);
  assert.equal(refused.failure, 'non-normalized-distribution');
  assert.equal(refused.questionId, 'family');
});

test('PRV-02: the provider reports probabilities at 0.01; rounding stays inside the documented tolerance', () => {
  // Live shape, 2026-09-25: rounded probabilities, a score from unrounded probabilities, confidence rounded separately.
  const live = body();
  live.answers.family = { type: 'choice', choice: 'type_error', probabilities: { type_error: 0.33, assertion: 0.33, unknown: 0.33 }, confidence: 0.33 };
  live.answers.reach = { type: 'score', score: 1.99, probabilities: { 0: 0.01, 1: 0, 2: 0.99 }, legend: { 0: 'Docs only.', 1: 'Local change.', 2: 'Public interface.' }, confidence: 0.99 };
  const result = validateJevResponse(enc(live), QUESTIONS);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.answers.family.normalized, true);
  assert.equal(result.answers.family.tie, true);
  assert.equal(result.answers.reach.score, 1.99);
  const strict = validateJevResponse(enc(live), QUESTIONS, validationPolicy({ reportedPrecision: 0 }));
  assert.equal(strict.ok, false);
});

test('PRV-02: additive metadata is refused unless allowlisted, and then listed as ignored', () => {
  const extra = body({ request_id: 'abc' });
  const refused = validateJevResponse(enc(extra), QUESTIONS);
  assert.equal(refused.ok, false);
  assert.equal(refused.failure, 'unexpected-field');
  const allowed = validateJevResponse(enc(extra), QUESTIONS, validationPolicy({ allowedMetadata: ['request_id'] }));
  assert.equal(allowed.ok, true);
  assert.deepEqual(allowed.ignoredMetadata, ['request_id']);
  assert.throws(() => validationPolicy({ allowedMetadata: ['answers'] }), /VALIDATION_POLICY_METADATA/);
});

test('PRV-02: ties follow the declared policy', () => {
  const tied = body();
  tied.answers.family = { type: 'choice', choice: 'assertion', probabilities: { type_error: 0.45, assertion: 0.45, unknown: 0.1 }, confidence: 0.45 };
  const flagged = validateJevResponse(enc(tied), QUESTIONS);
  assert.equal(flagged.ok, true);
  assert.equal(flagged.answers.family.tie, true);
  const rejected = validateJevResponse(enc(tied), QUESTIONS, validationPolicy({ tiePolicy: 'reject' }));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.failure, 'tie');
});

test('PRV-02: the model pin is configurable, defaults to jev-1.13.0 and never accepts an alias', () => {
  assert.equal(DEFAULT_VALIDATION_POLICY.pinnedModel, 'jev-1.13.0');
  const newer = body({ model: 'jev-1.14.0' });
  assert.equal(validateJevResponse(enc(newer), QUESTIONS).failure, 'model-mismatch');
  assert.equal(validateJevResponse(enc(newer), QUESTIONS, validationPolicy({ pinnedModel: 'jev-1.14.0' })).ok, true);
  assert.throws(() => validationPolicy({ pinnedModel: 'jev-latest' }), /VALIDATION_POLICY_PIN/);
  const mismatch = validateJevResponse(enc(newer), QUESTIONS);
  assert.equal(mismatch.model, 'jev-1.14.0');
  assert.deepEqual(mismatch.usage, { inputTokens: 412, outputTokens: 39 });
});

test('PRV-02: a Noul answer carrying a confidence field is refused', () => {
  const noul = body();
  noul.answers.missing = { type: 'noul', noul: 0.4, confidence: 0.9 };
  const result = validateJevResponse(enc(noul), QUESTIONS);
  assert.equal(result.ok, false);
  assert.equal(result.failure, 'noul-confidence');
  assert.equal(result.questionId, 'missing');
});

test('PRV-02: score range, consistency and legend are checked', () => {
  const inconsistent = body();
  inconsistent.answers.reach.score = 1.5;
  assert.equal(validateJevResponse(enc(inconsistent), QUESTIONS).failure, 'score-inconsistent');
  const range = body();
  range.answers.reach.score = 3;
  assert.equal(validateJevResponse(enc(range), QUESTIONS).failure, 'score-range');
  const legend = body();
  legend.answers.reach.legend = { 0: 'Docs only.', 1: 'Something else.', 2: 'Public interface.' };
  assert.equal(validateJevResponse(enc(legend), QUESTIONS).failure, 'legend-mismatch');
});

test('PRV-02: question set, primitive and candidate membership are exact', () => {
  const missing = body();
  delete missing.answers.missing;
  assert.equal(validateJevResponse(enc(missing), QUESTIONS).failure, 'question-set-mismatch');
  const wrong = body();
  wrong.answers.missing = { type: 'choice', choice: 'a', probabilities: { a: 1 }, confidence: 1 };
  assert.equal(validateJevResponse(enc(wrong), QUESTIONS).failure, 'wrong-primitive');
  const stranger = body();
  stranger.answers.family.probabilities = { type_error: 0.6, assertion: 0.2, unknown: 0.1, other: 0.1 };
  assert.equal(validateJevResponse(enc(stranger), QUESTIONS).failure, 'unknown-candidate');
  const loser = body();
  loser.answers.family.choice = 'unknown';
  assert.equal(validateJevResponse(enc(loser), QUESTIONS).failure, 'choice-not-maximum');
});

const CANARY = 'CANARY-7f3e-body-text-must-not-leak';

test('QA-04: hostile bodies are refused with a redacted failure and never throw', () => {
  const cases = [
    ['malformed UTF-8', new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]), 'not-utf8'],
    ['truncated JSON', enc(JSON.stringify(body()).slice(0, 40)), 'not-json'],
    ['NaN literal', enc(`{"model":"jev-1.13.0","answers":{"missing":{"type":"noul","noul":NaN}},"usage":{"input_tokens":1,"output_tokens":0},"x":"${CANARY}"}`), 'not-json'],
    ['__proto__ key', enc(`{"__proto__":{"polluted":true},"model":"jev-1.13.0","note":"${CANARY}"}`), 'forbidden-key'],
    ['constructor key', enc(`{"model":"jev-1.13.0","answers":{"constructor":{"type":"noul","noul":0.1}},"usage":{"input_tokens":1,"output_tokens":0}}`), 'forbidden-key'],
    ['oversize', enc(`{"pad":"${'x'.repeat(DEFAULT_VALIDATION_POLICY.maxResponseBytes)}"}`), 'too-large'],
    ['negative probability', enc({ ...body(), answers: { ...body().answers, missing: { type: 'noul', noul: -0.1 } } }), 'probability-range'],
    ['lone surrogate model', enc(`{"model":"jev-1.13.0\\ud800","answers":{},"usage":{"input_tokens":1,"output_tokens":0}}`), 'model-mismatch'],
    ['not an object', enc(`["${CANARY}"]`), 'not-object'],
    ['usage negative', enc({ ...body(), usage: { input_tokens: -1, output_tokens: 0 } }), 'usage-invalid'],
    ['usage fractional', enc({ ...body(), usage: { input_tokens: 1.5, output_tokens: 0 } }), 'usage-invalid'],
  ];
  for (const [name, bytes, expected] of cases) {
    const result = validateJevResponse(bytes, QUESTIONS);
    assert.equal(result.ok, false, name);
    assert.equal(result.failure, expected, name);
    assert.equal(JSON.stringify(result).includes(CANARY), false, `${name} leaks body text`);
  }
  assert.equal(Object.prototype.polluted, undefined);
});

test('QA-04: random byte mutations of a valid body never throw and never validate a broken distribution', () => {
  const valid = enc(body());
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 400; i += 1) {
    const copy = new Uint8Array(valid);
    const flips = 1 + Math.floor(rand() * 4);
    for (let f = 0; f < flips; f += 1) copy[Math.floor(rand() * copy.length)] = Math.floor(rand() * 256);
    let result;
    assert.doesNotThrow(() => {
      result = validateJevResponse(copy, QUESTIONS);
    });
    if (result.ok) {
      const sum = Object.values(result.answers.family.original).reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(sum - 1) <= 0.016);
    }
  }
});
