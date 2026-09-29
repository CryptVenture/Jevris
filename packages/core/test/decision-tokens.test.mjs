import test from 'node:test';
import assert from 'node:assert/strict';

const core = await import('../dist/index.js');
const { estimateTextTokens, estimateRequest, gateRequest, backoffDelayMs, failureDisposition, retryPolicyFor, REQUEST_TOKEN_LIMIT } = core;

const Q = { yes: { type: 'noul', instructions: 'Is the packet empty?' } };

test('PRV-03: the estimator is a piecewise upper bound (words, digits, punctuation, non-ASCII bytes)', () => {
  assert.equal(estimateTextTokens(''), 0);
  assert.equal(estimateTextTokens('abc'), 1);
  assert.equal(estimateTextTokens('abcd'), 2);
  assert.equal(estimateTextTokens('12345'), 5);
  assert.equal(estimateTextTokens('a, b'), 4);
  assert.equal(estimateTextTokens('é'), 2);
  assert.equal(estimateTextTokens('日本'), 6);
  const english = 'The compiler rejected the code because the argument type does not match the declared parameter.';
  assert.ok(estimateTextTokens(english) >= english.length / 4, 'at least a chars/4 tokenizer');
});

test('PRV-03: the gate compares estimated tokens with the 64k and 32k limits, not bytes', () => {
  // Under the byte cap but over the token limit: digits and spaces cost one token each.
  const dense = { model: 'jev-1.13.0', state: Array.from({ length: 60_000 }, () => '7').join(' '), questions: Q };
  const denseGate = gateRequest(dense);
  assert.ok(denseGate.estimate.requestBytes < 131_072);
  assert.equal(denseGate.ok, false);
  assert.equal(denseGate.limit, 'tokens');
  // Over 64,000 bytes (the old byte-as-token bound) yet well inside the token limits.
  const prose = { model: 'jev-1.13.0', state: 'abcdefghi '.repeat(7_000), questions: Q };
  const proseGate = gateRequest(prose);
  assert.ok(proseGate.estimate.requestBytes > 64_000);
  assert.ok(proseGate.estimate.totalTokens < REQUEST_TOKEN_LIMIT);
  assert.equal(proseGate.ok, true);
  // State plus the largest question over 32k while the whole request is under 64k.
  const pair = { model: 'jev-1.13.0', state: 'abcdefghi '.repeat(8_200), questions: Q };
  const pairGate = gateRequest(pair, { maxRequestBytes: 1_000_000, maxQuestions: 12, requestTokenLimit: 64_000, statePlusQuestionTokenLimit: 32_000 });
  assert.equal(pairGate.ok, false);
  assert.equal(pairGate.limit, 'state-plus-question');
  assert.ok(pairGate.stateTokensOver > 0);
});

test('PRV-03: bytes and question count are separate caps', () => {
  const bytes = gateRequest({ model: 'jev-1.13.0', state: 'é'.repeat(70_000), questions: Q }, { maxRequestBytes: 131_072, maxQuestions: 12, requestTokenLimit: 10_000_000, statePlusQuestionTokenLimit: 10_000_000 });
  assert.equal(bytes.ok, false);
  assert.equal(bytes.limit, 'bytes');
  const many = {};
  for (let i = 0; i < 13; i += 1) many[`q${i}`] = { type: 'noul', instructions: 'Is it?' };
  const count = gateRequest({ model: 'jev-1.13.0', state: 'x', questions: many });
  assert.equal(count.ok, false);
  assert.equal(count.reasonCode, 'TOO_MANY_QUESTIONS');
  const estimate = estimateRequest({ model: 'jev-1.13.0', state: 'x', questions: Q });
  assert.equal(estimate.encoderId, 'jevris-conservative-v1');
  assert.equal(estimate.questionCount, 1);
});

test('PRV-07: failure dispositions never retry 401 or 422 unchanged', () => {
  assert.equal(failureDisposition('auth', 401), 'disable');
  assert.equal(failureDisposition('invalid-request', 422), 'repack');
  assert.equal(failureDisposition('invalid-request', 400), 'stop');
  // R77, SPEC §17.3 "401 / account restriction": a 403 and a billing refusal disable, like a 401.
  assert.equal(failureDisposition('forbidden', 403), 'disable');
  assert.equal(failureDisposition('billing', 402), 'disable');
  for (const kind of ['rate-limited', 'overloaded', 'server', 'timeout', 'connection']) assert.equal(failureDisposition(kind, null), 'retry');
  for (const kind of ['cancelled', 'deadline', 'invalid-response', 'response-too-large', 'configuration']) assert.equal(failureDisposition(kind, null), 'stop');
  assert.equal(retryPolicyFor('interactive').maxAttempts, 1);
  assert.ok(retryPolicyFor('background').maxAttempts > 1);
});

test('PRV-07: backoff is exponential, capped and jittered, and Retry-After is honoured up to a cap', () => {
  const policy = { maxAttempts: 6, baseDelayMs: 100, maxDelayMs: 1000, jitter: 0.25, maxRetryAfterMs: 5000 };
  assert.equal(backoffDelayMs(1, policy, null, () => 0), 100);
  assert.equal(backoffDelayMs(2, policy, null, () => 0), 200);
  assert.equal(backoffDelayMs(3, policy, null, () => 0), 400);
  assert.equal(backoffDelayMs(9, policy, null, () => 0), 1000);
  assert.equal(backoffDelayMs(2, policy, null, () => 1), 150);
  for (let i = 0; i < 50; i += 1) {
    const d = backoffDelayMs(3, policy, null, Math.random);
    assert.ok(d >= 300 && d <= 400);
  }
  assert.equal(backoffDelayMs(1, policy, 2000, () => 0), 2000);
  assert.equal(backoffDelayMs(1, policy, 60_000, () => 0), 5000);
  assert.equal(backoffDelayMs(3, policy, 10, () => 0), 400);
});
