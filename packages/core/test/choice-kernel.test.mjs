import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';


const spec = JSON.parse(
  readFileSync(new URL('../../../fixtures/choice/failure-family.json', import.meta.url), 'utf8'),
);

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
    bytes,
    async evaluate() {
      this.calls += 1;
      return { receivedAtMs, body: bytes };
    },
  };
}

function assertNoGrant(record) {
  assert.equal(record.appliedAction, null);
  assert.equal(record.authorityGranted, false);
  assert.equal(record.consentFabricated, false);
  assert.equal(record.verified, false);
  assert.equal(record.plannedAction.kind, 'abstain');
  const bannedValues = new Set(['grant-permission', 'workflow', 'permission', 'completion']);
  const walk = (value) => {
    if (typeof value === 'string') {
      assert.equal(bannedValues.has(value), false);
    }
    if (value === true) {
      assert.fail('record grants a workflow, a permission, or a completion');
    }
    if (value !== null && typeof value === 'object' && !(value instanceof Uint8Array)) {
      for (const child of Object.values(value)) walk(child);
    }
  };
  walk(record);
}

test('failureFamily fixture keeps the specification strings', () => {
  assert.equal(spec.id, 'failureFamily');
  assert.equal(spec.instructions, 'Which listed family best matches the observed failure?');
  assert.equal(spec.criteria.type_error, 'A compiler or static type checker rejected the code.');
  assert.equal(spec.criteria.assertion, 'A test ran and an assertion failed.');
  assert.equal(spec.criteria.environment, 'Required tooling or an external dependency failed.');
  assert.equal(spec.criteria.unknown, 'Evidence is insufficient or none of these fits.');
});

test('valid failureFamily type_error abstains without granting authority', async () => {
  const { evaluateChoice } = await import('../dist/kernel.js');
  const bytes = validAnswerBytes();
  const port = mockPort(bytes, 500);
  const signal = new AbortController().signal;
  assert.equal(signal.aborted, false);
  const record = await evaluateChoice(spec, { kind: 'ambiguous-failure' }, {
    port,
    deadlineAtMs: 1000,
    signal,
  });
  assert.equal(record.disposition, 'abstained');
  assert.equal(record.reasonCode, 'CHOICE_RECORDED');
  assert.equal(record.classification, 'type_error');
  assert.equal(record.plannedAction.kind, 'abstain');
  assert.equal(record.appliedAction, null);
  assert.equal(record.authorityGranted, false);
  assert.equal(record.consentFabricated, false);
  assert.equal(record.verified, false);
  assert.equal(record.persisted, false);
  assert.equal(record.providerCalls, 1);
  assert.equal(port.calls, 1);
  assert.deepEqual(record.retainedBody, bytes);
  assert.equal(record.resolvedModel, 'jev-1.13.0');
  assert.equal(record.providerConfidence, 0.4);
  assertNoGrant(record);
});

async function refusedSpec(candidate) {
  const { evaluateChoice } = await import('../dist/kernel.js');
  const port = mockPort(validAnswerBytes(), 500);
  const record = await evaluateChoice(candidate, { kind: 'ambiguous-failure' }, {
    port,
    deadlineAtMs: 1000,
    signal: new AbortController().signal,
  });
  assert.equal(record.disposition, 'refused');
  assert.equal(record.reasonCode, 'INVALID_REQUEST');
  assert.equal(record.providerCalls, 0);
  assert.equal(port.calls, 0);
  assert.equal(record.retainedBody, null);
  assert.equal(record.appliedAction, null);
  assert.equal(record.authorityGranted, false);
  assert.equal(record.consentFabricated, false);
  assert.equal(record.verified, false);
  assert.equal(record.plannedAction.kind, 'abstain');
  assert.equal(record.persisted, false);
  return record;
}

test('refuses a spec whose criteria omit unknown', async () => {
  const missing = structuredClone(spec);
  delete missing.criteria.unknown;
  await refusedSpec(missing);
});

test('refuses a questions map with two ids', async () => {
  const questions = {
    failureFamily: {
      type: 'choice',
      instructions: spec.instructions,
      criteria: spec.criteria,
    },
    otherFamily: {
      type: 'choice',
      instructions: spec.instructions,
      criteria: spec.criteria,
    },
  };
  await refusedSpec(questions);
});

test('refuses an empty option string', async () => {
  const empty = structuredClone(spec);
  empty.criteria = { ...spec.criteria, type_error: '' };
  await refusedSpec(empty);
});

async function evaluateInput(input) {
  const { evaluateChoice } = await import('../dist/kernel.js');
  const port = mockPort(validAnswerBytes(), 500);
  const record = await evaluateChoice(spec, input, {
    port,
    deadlineAtMs: 1000,
    signal: new AbortController().signal,
  });
  return { record, port };
}

function assertZeroCallLiterals(record, port) {
  assert.equal(record.appliedAction, null);
  assert.equal(record.authorityGranted, false);
  assert.equal(record.consentFabricated, false);
  assert.equal(record.verified, false);
  assert.equal(record.persisted, false);
  assert.equal(record.plannedAction.kind, 'abstain');
  assert.equal(record.providerCalls, 0);
  assert.equal(port.calls, 0);
  assert.equal(record.retainedBody, null);
  assert.equal(Object.hasOwn(record, 'resolvedModel'), false);
  assert.equal(Object.hasOwn(record, 'providerConfidence'), false);
  assert.equal(JSON.stringify(record).includes('probabilities'), false);
  assert.equal(JSON.stringify(record).includes('jev-1.13.0'), false);
  assertNoGrant(record);
}

function assertAskedNotCopied(record, asked) {
  const walk = (value) => {
    if (typeof value === 'string') assert.notEqual(value, asked);
    if (value !== null && typeof value === 'object' && !(value instanceof Uint8Array)) {
      for (const child of Object.values(value)) walk(child);
    }
  };
  walk(record);
}

for (const family of ['type_error', 'assertion', 'environment']) {
  test(`known-failure ${family} is answered by rules with zero provider calls`, async () => {
    const { record, port } = await evaluateInput({ kind: 'known-failure', family });
    assert.equal(record.disposition, 'rules');
    assert.equal(record.reasonCode, 'KNOWN_FAILURE');
    assert.equal(record.classification, family);
    assert.equal(record.count, null);
    assert.equal(record.plannedAction.reasonCode, 'KNOWN_FAILURE');
    assertZeroCallLiterals(record, port);
  });
}

test('count of a four-element list is an integer rules answer', async () => {
  const { record, port } = await evaluateInput({ kind: 'count', items: ['a', 'b', 'c', 'd'] });
  assert.equal(record.disposition, 'rules');
  assert.equal(record.reasonCode, 'INTEGER_COUNT');
  assert.equal(record.classification, null);
  assert.equal(record.count, 4);
  assert.equal(record.plannedAction.reasonCode, 'INTEGER_COUNT');
  assertZeroCallLiterals(record, port);
});

test('count with a non-array items value refuses without entering the port', async () => {
  const { record, port } = await evaluateInput({ kind: 'count', items: { length: 4 } });
  assert.equal(record.disposition, 'refused');
  assert.equal(record.reasonCode, 'INVALID_REQUEST');
  assert.equal(record.classification, null);
  assert.equal(record.count, null);
  assertZeroCallLiterals(record, port);
});

for (const asked of ['permission', 'consent', 'verified']) {
  test(`authority-request ${asked} is ineligible and grants nothing`, async () => {
    const { record, port } = await evaluateInput({ kind: 'authority-request', asked });
    assert.equal(record.disposition, 'refused');
    assert.equal(record.reasonCode, 'INELIGIBLE');
    assert.equal(record.classification, null);
    assert.equal(record.count, null);
    assert.equal(record.plannedAction.reasonCode, 'INELIGIBLE');
    assertZeroCallLiterals(record, port);
    assertAskedNotCopied(record, asked);
  });
}

test('rules and authority replay does not call fetch', async () => {
  const previous = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('RULES_PATH_FETCH');
  };
  try {
    for (const family of ['type_error', 'assertion', 'environment']) {
      const { record, port } = await evaluateInput({ kind: 'known-failure', family });
      assert.equal(record.disposition, 'rules');
      assert.equal(record.reasonCode, 'KNOWN_FAILURE');
      assert.equal(record.classification, family);
      assert.equal(fetchCalls, 0);
      assert.equal(port.calls, 0);
      assert.equal(record.providerCalls, 0);
    }
    const counted = await evaluateInput({ kind: 'count', items: ['a', 'b', 'c', 'd'] });
    assert.equal(counted.record.disposition, 'rules');
    assert.equal(counted.record.reasonCode, 'INTEGER_COUNT');
    assert.equal(counted.record.count, 4);
    assert.equal(counted.port.calls, 0);
    assert.equal(fetchCalls, 0);
    for (const asked of ['permission', 'consent', 'verified']) {
      const { record, port } = await evaluateInput({ kind: 'authority-request', asked });
      assert.equal(record.disposition, 'refused');
      assert.equal(record.reasonCode, 'INELIGIBLE');
      assert.equal(port.calls, 0);
      assert.equal(record.providerCalls, 0);
      assertAskedNotCopied(record, asked);
      assert.equal(fetchCalls, 0);
    }
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = previous;
  }
});

function encodeJson(value) {
  return new TextEncoder().encode(JSON.stringify(value));
}

function choiceEnvelope(answer, extra = {}) {
  return {
    model: 'jev-1.13.0',
    answers: { failureFamily: answer },
    usage: { input_tokens: 10, output_tokens: 2 },
    ...extra,
  };
}

function baseAnswer(overrides = {}) {
  return {
    type: 'choice',
    choice: 'type_error',
    confidence: 0.4,
    probabilities: {
      type_error: 0.7,
      assertion: 0.1,
      environment: 0.1,
      unknown: 0.1,
    },
    ...overrides,
  };
}

async function evaluateAmbiguous(bytes, receivedAtMs = 500) {
  const { evaluateChoice } = await import('../dist/kernel.js');
  const port = mockPort(bytes, receivedAtMs);
  const record = await evaluateChoice(spec, { kind: 'ambiguous-failure' }, {
    port,
    deadlineAtMs: 1000,
    signal: new AbortController().signal,
  });
  return { record, port };
}

function assertRefusedBody(record, port, reasonCode, bytes) {
  assert.equal(record.disposition, 'refused');
  assert.notEqual(record.disposition, 'abstained');
  assert.equal(record.reasonCode, reasonCode);
  assert.equal(record.classification, null);
  assert.equal(record.count, null);
  assert.equal(record.appliedAction, null);
  assert.equal(record.authorityGranted, false);
  assert.equal(record.consentFabricated, false);
  assert.equal(record.verified, false);
  assert.equal(record.persisted, false);
  assert.equal(record.plannedAction.kind, 'abstain');
  assert.equal(record.plannedAction.reasonCode, reasonCode);
  assert.equal(record.providerCalls, 1);
  assert.equal(port.calls, 1);
  assert.ok(record.retainedBody instanceof Uint8Array);
  assert.deepEqual(record.retainedBody, bytes);
  assert.equal(Object.hasOwn(record, 'resolvedModel'), false);
  assert.equal(Object.hasOwn(record, 'providerConfidence'), false);
  assertNoGrant(record);
}

function decodedBody(record) {
  return JSON.parse(new TextDecoder().decode(record.retainedBody));
}

test('jev-latest is a model mismatch and grants nothing', async () => {
  const bytes = encodeJson(choiceEnvelope(baseAnswer(), { model: 'jev-latest' }));
  const { record, port } = await evaluateAmbiguous(bytes);
  assertRefusedBody(record, port, 'MODEL_MISMATCH', bytes);
  assert.notEqual(record.classification, 'type_error');
  assert.equal(decodedBody(record).model, 'jev-latest');
});

test('a model other than jev-1.13.0 is a model mismatch', async () => {
  const bytes = encodeJson(choiceEnvelope(baseAnswer(), { model: 'jev-1.12.0' }));
  const { record, port } = await evaluateAmbiguous(bytes);
  assertRefusedBody(record, port, 'MODEL_MISMATCH', bytes);
});

test('a probabilities sum of 0.5 is refused and the original numbers are retained', async () => {
  const probabilities = {
    type_error: 0.2,
    assertion: 0.1,
    environment: 0.1,
    unknown: 0.1,
  };
  const bytes = encodeJson(choiceEnvelope(baseAnswer({ probabilities })));
  const { record, port } = await evaluateAmbiguous(bytes);
  assertRefusedBody(record, port, 'INVALID_RESPONSE', bytes);
  assert.deepEqual(decodedBody(record).answers.failureFamily.probabilities, probabilities);
  assert.equal(JSON.stringify(record).includes('0.4'), false);
});

test('an extra probability key is INVALID_RESPONSE', async () => {
  const bytes = encodeJson(choiceEnvelope(baseAnswer({
    probabilities: {
      type_error: 0.7,
      assertion: 0.1,
      environment: 0.1,
      unknown: 0.1,
      other: 0,
    },
  })));
  const { record, port } = await evaluateAmbiguous(bytes);
  assertRefusedBody(record, port, 'INVALID_RESPONSE', bytes);
  assert.equal(decodedBody(record).answers.failureFamily.probabilities.other, 0);
});

test('a non-finite confidence is INVALID_RESPONSE', async () => {
  const json = JSON.stringify(choiceEnvelope(baseAnswer())).replace('"confidence":0.4', '"confidence":1e999');
  const bytes = new TextEncoder().encode(json);
  const { record, port } = await evaluateAmbiguous(bytes);
  assertRefusedBody(record, port, 'INVALID_RESPONSE', bytes);
  assert.equal(Number.isFinite(decodedBody(record).answers.failureFamily.confidence), false);
});

test('a negative usage token is INVALID_RESPONSE', async () => {
  const body = choiceEnvelope(baseAnswer());
  body.usage.input_tokens = -1;
  const bytes = encodeJson(body);
  const { record, port } = await evaluateAmbiguous(bytes);
  assertRefusedBody(record, port, 'INVALID_RESPONSE', bytes);
  assert.equal(decodedBody(record).usage.input_tokens, -1);
});

test('a fractional usage token is INVALID_RESPONSE', async () => {
  const body = choiceEnvelope(baseAnswer());
  body.usage.output_tokens = 0.5;
  const bytes = encodeJson(body);
  const { record, port } = await evaluateAmbiguous(bytes);
  assertRefusedBody(record, port, 'INVALID_RESPONSE', bytes);
  assert.equal(decodedBody(record).usage.output_tokens, 0.5);
});

test('a selected option below the max is INVALID_RESPONSE and is not replaced by the max', async () => {
  const bytes = encodeJson(choiceEnvelope(baseAnswer({ choice: 'assertion' })));
  const { record, port } = await evaluateAmbiguous(bytes);
  assertRefusedBody(record, port, 'INVALID_RESPONSE', bytes);
  assert.notEqual(record.classification, 'assertion');
  assert.notEqual(record.classification, 'type_error');
});

test('a tie at the max is INVALID_RESPONSE and does not pick a winner', async () => {
  const probabilities = {
    type_error: 0.4,
    assertion: 0.4,
    environment: 0.1,
    unknown: 0.1,
  };
  const bytes = encodeJson(choiceEnvelope(baseAnswer({ choice: 'type_error', probabilities })));
  const { record, port } = await evaluateAmbiguous(bytes);
  assertRefusedBody(record, port, 'INVALID_RESPONSE', bytes);
  assert.notEqual(record.classification, 'type_error');
  assert.notEqual(record.classification, 'assertion');
  assert.deepEqual(decodedBody(record).answers.failureFamily.probabilities, probabilities);
});

test('two probabilities within 1e-6 of the max are INVALID_RESPONSE', async () => {
  const max = 0.5;
  const near = max - 5e-7;
  const rest = (1 - max - near) / 2;
  const probabilities = {
    type_error: max,
    assertion: near,
    environment: rest,
    unknown: rest,
  };
  assert.ok(Math.abs(max + near + rest + rest - 1) <= 1e-6);
  assert.ok(near + 1e-6 >= max);
  const bytes = encodeJson(choiceEnvelope(baseAnswer({ choice: 'type_error', probabilities })));
  const { record, port } = await evaluateAmbiguous(bytes);
  assertRefusedBody(record, port, 'INVALID_RESPONSE', bytes);
  assert.notEqual(record.classification, 'type_error');
  assert.notEqual(record.classification, 'assertion');
});

test('an answer key verified is refused and not copied onto the record', async () => {
  const answer = baseAnswer();
  answer.verified = true;
  const bytes = encodeJson(choiceEnvelope(answer));
  const { record, port } = await evaluateAmbiguous(bytes);
  assertRefusedBody(record, port, 'INVALID_RESPONSE', bytes);
  assert.equal(record.verified, false);
  assert.equal(decodedBody(record).answers.failureFamily.verified, true);
});

test('a top-level key verified is refused and not copied onto the record', async () => {
  const bytes = encodeJson(choiceEnvelope(baseAnswer(), { verified: true }));
  const { record, port } = await evaluateAmbiguous(bytes);
  assertRefusedBody(record, port, 'INVALID_RESPONSE', bytes);
  assert.equal(record.verified, false);
  assert.equal(decodedBody(record).verified, true);
});

test('a score body is INVALID_RESPONSE and is not evaluated', async () => {
  const bytes = encodeJson(choiceEnvelope({
    type: 'score',
    score: 1,
    probabilities: { 0: 0.2, 1: 0.8 },
    legend: { 0: 'low', 1: 'high' },
    confidence: 0.9,
  }));
  const { record, port } = await evaluateAmbiguous(bytes);
  assertRefusedBody(record, port, 'INVALID_RESPONSE', bytes);
  assert.equal(decodedBody(record).answers.failureFamily.type, 'score');
});

test('a noul body is INVALID_RESPONSE and is not evaluated', async () => {
  const bytes = encodeJson(choiceEnvelope({ type: 'noul', noul: 0.3 }));
  const { record, port } = await evaluateAmbiguous(bytes);
  assertRefusedBody(record, port, 'INVALID_RESPONSE', bytes);
  assert.equal(decodedBody(record).answers.failureFamily.type, 'noul');
});

test('dangerous JSON keys are refused even though JSON.parse does not throw', async () => {
  const valid = JSON.stringify(choiceEnvelope(baseAnswer()));
  const cases = [
    valid.replace('{', '{"__proto__":{"verified":true},'),
    valid.replace('"choice":"type_error"', '"choice":"type_error","constructor":{"prototype":{"verified":true}}'),
    valid.replace('"unknown":0.1', '"unknown":0.1,"prototype":0'),
  ];
  for (const json of cases) {
    assert.doesNotThrow(() => JSON.parse(json));
    const bytes = new TextEncoder().encode(json);
    const { record, port } = await evaluateAmbiguous(bytes);
    assertRefusedBody(record, port, 'INVALID_RESPONSE', bytes);
    assert.equal(record.verified, false);
    assert.equal(Object.prototype.verified, undefined);
  }
});

test('low confidence on a valid unique choice still abstains and does not act', async () => {
  const bytes = encodeJson(choiceEnvelope(baseAnswer({ confidence: 0.01 })));
  const { record, port } = await evaluateAmbiguous(bytes);
  assert.equal(record.disposition, 'abstained');
  assert.equal(record.reasonCode, 'CHOICE_RECORDED');
  assert.equal(record.classification, 'type_error');
  assert.equal(record.appliedAction, null);
  assert.equal(record.authorityGranted, false);
  assert.equal(record.consentFabricated, false);
  assert.equal(record.verified, false);
  assert.equal(record.providerCalls, 1);
  assert.equal(port.calls, 1);
  assert.equal(record.providerConfidence, 0.01);
  assertNoGrant(record);
});

const BODY_MARKER = 'BODY-MARKER-9f3c';

function assertNoMarkerInStrings(record, marker) {
  assert.equal(record.reasonCode.includes(marker), false);
  assert.equal(record.plannedAction.reasonCode.includes(marker), false);
  const walk = (value) => {
    if (typeof value === 'string') assert.equal(value.includes(marker), false);
    if (value !== null && typeof value === 'object' && !(value instanceof Uint8Array)) {
      for (const child of Object.values(value)) walk(child);
    }
  };
  walk(record);
}

test('invalid JSON is retained and the marker stays out of reason text', async () => {
  const text = `not-json ${BODY_MARKER}`;
  const bytes = new TextEncoder().encode(text);
  let record;
  let port;
  try {
    ({ record, port } = await evaluateAmbiguous(bytes));
  } catch (error) {
    const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
    assert.equal(message.includes(BODY_MARKER), false);
    throw error;
  }
  assertRefusedBody(record, port, 'INVALID_RESPONSE', bytes);
  assert.equal(new TextDecoder().decode(record.retainedBody), text);
  assert.equal(new TextDecoder().decode(record.retainedBody).includes(BODY_MARKER), true);
  assertNoMarkerInStrings(record, BODY_MARKER);
});

test('a body longer than 1048576 bytes is retained and not parsed', async () => {
  const bytes = new Uint8Array(1_048_577);
  bytes[0] = 0xff;
  bytes.set(new TextEncoder().encode(BODY_MARKER), 1);
  const originalParse = JSON.parse;
  const OriginalDecoder = globalThis.TextDecoder;
  let parses = 0;
  let decodes = 0;
  JSON.parse = (...args) => {
    parses += 1;
    return originalParse.apply(JSON, args);
  };
  globalThis.TextDecoder = class SpyDecoder extends OriginalDecoder {
    decode(...args) {
      decodes += 1;
      return super.decode(...args);
    }
  };
  try {
    const { record, port } = await evaluateAmbiguous(bytes);
    assert.equal(parses, 0);
    assert.equal(decodes, 0);
    assertRefusedBody(record, port, 'RESPONSE_TOO_LARGE', bytes);
    assertNoMarkerInStrings(record, BODY_MARKER);
  } finally {
    JSON.parse = originalParse;
    globalThis.TextDecoder = OriginalDecoder;
  }
});

test('a serialized request longer than 131072 bytes does not enter the port', async () => {
  const criteria = { unknown: 'u'.repeat(2048) };
  const encodedLength = () => new TextEncoder().encode(JSON.stringify({
    model: 'jev-1.13.0',
    questions: {
      failureFamily: {
        type: 'choice',
        instructions: spec.instructions,
        criteria,
      },
    },
  })).byteLength;
  let added = 0;
  while (encodedLength() <= 131072) {
    criteria[`k${added}`] = 'x'.repeat(2048);
    added += 1;
    if (added > 255) throw new Error('could not exceed the request byte cap');
  }
  assert.ok(encodedLength() > 131072);
  const candidate = {
    id: spec.id,
    instructions: spec.instructions,
    criteria,
  };
  const { evaluateChoice } = await import('../dist/kernel.js');
  const port = {
    calls: 0,
    async evaluate() {
      this.calls += 1;
      throw new Error('PORT_ENTERED');
    },
  };
  const record = await evaluateChoice(candidate, { kind: 'ambiguous-failure' }, {
    port,
    deadlineAtMs: 1000,
    signal: new AbortController().signal,
  });
  assert.equal(record.disposition, 'refused');
  assert.equal(record.reasonCode, 'REQUEST_TOO_LARGE');
  assert.equal(record.retainedBody, null);
  assert.equal(record.providerCalls, 0);
  assert.equal(port.calls, 0);
  assert.equal(record.classification, null);
  assert.equal(record.appliedAction, null);
  assert.equal(record.authorityGranted, false);
  assert.equal(record.consentFabricated, false);
  assert.equal(record.verified, false);
  assert.equal(record.persisted, false);
  assert.equal(record.plannedAction.kind, 'abstain');
  assertNoGrant(record);
});

test('invalid UTF-8 is retained and refused', async () => {
  const bytes = new Uint8Array([0xff, 0xfe, 0xfd]);
  const { record, port } = await evaluateAmbiguous(bytes);
  assertRefusedBody(record, port, 'INVALID_RESPONSE', bytes);
});

async function withClockAndParseGuard(fn) {
  const originalParse = JSON.parse;
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  let parses = 0;
  let timers = 0;
  JSON.parse = (...args) => {
    parses += 1;
    return originalParse.apply(JSON, args);
  };
  Date.now = () => 9_000_000;
  globalThis.setTimeout = (...args) => {
    timers += 1;
    return originalSetTimeout(...args);
  };
  try {
    const result = await fn();
    return { ...result, parses, timers };
  } finally {
    JSON.parse = originalParse;
    Date.now = originalNow;
    globalThis.setTimeout = originalSetTimeout;
  }
}

test('late valid type_error JSON is DEADLINE and is not parsed', async () => {
  const bytes = validAnswerBytes();
  const { record, port, parses, timers } = await withClockAndParseGuard(() => evaluateAmbiguous(bytes, 2000));
  assert.equal(parses, 0);
  assert.equal(timers, 0);
  assertRefusedBody(record, port, 'DEADLINE', bytes);
  assert.notEqual(record.classification, 'type_error');
  assert.notEqual(record.disposition, 'abstained');
});

test('equal receivedAtMs and deadlineAtMs is DEADLINE not abstained', async () => {
  const bytes = validAnswerBytes();
  const { record, port, parses } = await withClockAndParseGuard(() => evaluateAmbiguous(bytes, 1000));
  assert.equal(parses, 0);
  assertRefusedBody(record, port, 'DEADLINE', bytes);
  assert.notEqual(record.disposition, 'abstained');
  assert.notEqual(record.classification, 'type_error');
});

test('a late invalid body is DEADLINE rather than INVALID_RESPONSE', async () => {
  const bytes = new TextEncoder().encode(`not-json ${BODY_MARKER}`);
  const { record, port, parses } = await withClockAndParseGuard(() => evaluateAmbiguous(bytes, 2000));
  assert.equal(parses, 0);
  assertRefusedBody(record, port, 'DEADLINE', bytes);
  assert.notEqual(record.reasonCode, 'INVALID_RESPONSE');
  assertNoMarkerInStrings(record, BODY_MARKER);
});

test('on-time type_error tracer still abstains', async () => {
  const bytes = validAnswerBytes();
  const { record, port, parses, timers } = await withClockAndParseGuard(() => evaluateAmbiguous(bytes, 500));
  assert.equal(parses, 1);
  assert.equal(timers, 0);
  assert.equal(record.disposition, 'abstained');
  assert.equal(record.reasonCode, 'CHOICE_RECORDED');
  assert.equal(record.classification, 'type_error');
  assert.equal(record.appliedAction, null);
  assert.equal(record.authorityGranted, false);
  assert.equal(record.consentFabricated, false);
  assert.equal(record.verified, false);
  assert.equal(record.persisted, false);
  assert.equal(record.providerCalls, 1);
  assert.equal(port.calls, 1);
  assert.deepEqual(record.retainedBody, bytes);
  assertNoGrant(record);
});

test('abort before evaluateChoice does not enter the port', async () => {
  const { evaluateChoice } = await import('../dist/kernel.js');
  const controller = new AbortController();
  controller.abort();
  const port = {
    calls: 0,
    async evaluate() {
      this.calls += 1;
      throw new Error('PORT_ENTERED');
    },
  };
  const record = await evaluateChoice(spec, { kind: 'ambiguous-failure' }, {
    port,
    deadlineAtMs: 1000,
    signal: controller.signal,
  });
  assert.equal(record.disposition, 'refused');
  assert.equal(record.reasonCode, 'CANCELLED');
  assert.equal(record.classification, null);
  assert.equal(record.appliedAction, null);
  assert.equal(record.authorityGranted, false);
  assert.equal(record.consentFabricated, false);
  assert.equal(record.verified, false);
  assert.equal(record.persisted, false);
  assertZeroCallLiterals(record, port);
});

test('abort after enter retains the body and does not classify it', async () => {
  const { evaluateChoice } = await import('../dist/kernel.js');
  const bytes = validAnswerBytes();
  const controller = new AbortController();
  const port = {
    calls: 0,
    async evaluate(_requestBytes, signal) {
      this.calls += 1;
      assert.equal(signal, controller.signal);
      assert.equal(signal.aborted, false);
      controller.abort();
      assert.equal(signal.aborted, true);
      return { receivedAtMs: 500, body: bytes };
    },
  };
  const originalParse = JSON.parse;
  let parses = 0;
  JSON.parse = (...args) => {
    parses += 1;
    return originalParse.apply(JSON, args);
  };
  try {
    const record = await evaluateChoice(spec, { kind: 'ambiguous-failure' }, {
      port,
      deadlineAtMs: 1000,
      signal: controller.signal,
    });
    assert.equal(parses, 0);
    assert.equal(port.calls, 1);
    assert.equal(record.providerCalls, 1);
    assert.equal(record.disposition, 'refused');
    assert.equal(record.reasonCode, 'CANCELLED');
    assert.equal(record.classification, null);
    assert.notEqual(record.classification, 'type_error');
    assert.equal(record.appliedAction, null);
    assert.equal(record.authorityGranted, false);
    assert.equal(record.consentFabricated, false);
    assert.equal(record.verified, false);
    assert.equal(record.persisted, false);
    assert.equal(record.plannedAction.kind, 'abstain');
    assert.equal(record.plannedAction.reasonCode, 'CANCELLED');
    assert.ok(record.retainedBody instanceof Uint8Array);
    assert.deepEqual(record.retainedBody, bytes);
    assert.equal(Object.hasOwn(record, 'resolvedModel'), false);
    assert.equal(Object.hasOwn(record, 'providerConfidence'), false);
    assertNoGrant(record);
  } finally {
    JSON.parse = originalParse;
  }
});

function unknownAnswerBytes() {
  return encodeJson(choiceEnvelope(baseAnswer({
    choice: 'unknown',
    confidence: 0.2,
    probabilities: {
      type_error: 0.1,
      assertion: 0.1,
      environment: 0.1,
      unknown: 0.7,
    },
  })));
}

test('selected unknown abstains and does not grant authority', async () => {
  const bytes = unknownAnswerBytes();
  const { record, port } = await evaluateAmbiguous(bytes, 500);
  assert.equal(record.disposition, 'abstained');
  assert.notEqual(record.reasonCode, 'INVALID_RESPONSE');
  assert.equal(record.reasonCode, 'CHOICE_RECORDED');
  assert.equal(record.classification, 'unknown');
  assert.equal(record.plannedAction.kind, 'abstain');
  assert.equal(record.appliedAction, null);
  assert.equal(record.authorityGranted, false);
  assert.equal(record.consentFabricated, false);
  assert.equal(record.verified, false);
  assert.equal(record.persisted, false);
  assert.equal(record.providerCalls, 1);
  assert.equal(port.calls, 1);
  assert.deepEqual(record.retainedBody, bytes);
  assert.equal(Object.hasOwn(record, 'workflow'), false);
  assert.equal(Object.hasOwn(record, 'workflowId'), false);
  assert.equal(Object.hasOwn(record, 'permission'), false);
  assert.equal(Object.hasOwn(record, 'completion'), false);
  const encoded = JSON.stringify(record);
  for (const token of ['workflow', 'permission', 'completion', 'grant-permission']) {
    assert.equal(encoded.includes(token), false);
  }
  assertNoGrant(record);
});

function familyProbabilities(choice) {
  return {
    type_error: choice === 'type_error' ? 0.7 : 0.1,
    assertion: choice === 'assertion' ? 0.7 : 0.1,
    environment: choice === 'environment' ? 0.7 : 0.1,
    unknown: 0.1,
  };
}

function schemaValidFamilyBytes(choice, confidence = 0.4) {
  return encodeJson(choiceEnvelope(baseAnswer({
    choice,
    confidence,
    probabilities: familyProbabilities(choice),
  })));
}

function assertSchemaValidAbstains(record, port, bytes, choice, confidence) {
  assert.equal(record.disposition, 'abstained');
  assert.notEqual(record.disposition, 'rules');
  assert.equal(record.reasonCode, 'CHOICE_RECORDED');
  assert.equal(record.classification, choice);
  assert.equal(record.count, null);
  assert.equal(record.plannedAction.kind, 'abstain');
  assert.equal(record.plannedAction.reasonCode, 'CHOICE_RECORDED');
  assert.equal(record.appliedAction, null);
  assert.equal(record.authorityGranted, false);
  assert.equal(record.consentFabricated, false);
  assert.equal(record.verified, false);
  assert.equal(record.persisted, false);
  assert.equal(record.providerCalls, 1);
  assert.equal(port.calls, 1);
  assert.deepEqual(record.retainedBody, bytes);
  assert.equal(record.resolvedModel, 'jev-1.13.0');
  assert.equal(record.providerConfidence, confidence);
  assert.equal(Object.hasOwn(record, 'workflow'), false);
  assert.equal(Object.hasOwn(record, 'permission'), false);
  assert.equal(Object.hasOwn(record, 'completion'), false);
  assertNoGrant(record);
}

for (const choice of ['type_error', 'assertion', 'environment']) {
  test(`schema-valid ${choice} abstains and does not grant authority`, async () => {
    const bytes = schemaValidFamilyBytes(choice, 0.4);
    const { record, port } = await evaluateAmbiguous(bytes);
    assertSchemaValidAbstains(record, port, bytes, choice, 0.4);
  });
}

test('confidence 0.99 on a schema-valid choice still abstains', async () => {
  const bytes = schemaValidFamilyBytes('type_error', 0.99);
  const { record, port } = await evaluateAmbiguous(bytes);
  assertSchemaValidAbstains(record, port, bytes, 'type_error', 0.99);
  assert.equal(record.providerConfidence, 0.99);
  assert.notEqual(record.disposition, 'grant');
});

const GRANT_SHAPED = ['grant-permission', 'verified', 'safe'];

test('failureFamily fixture does not list grant-shaped options', () => {
  for (const token of GRANT_SHAPED) {
    assert.equal(Object.hasOwn(spec.criteria, token), false);
  }
});

for (const choice of GRANT_SHAPED) {
  test(`choice ${choice} is INVALID_RESPONSE and is not applied`, async () => {
    const bytes = encodeJson(choiceEnvelope(baseAnswer({ choice })));
    const { record, port } = await evaluateAmbiguous(bytes);
    assertRefusedBody(record, port, 'INVALID_RESPONSE', bytes);
    assert.equal(record.classification, null);
    assert.notEqual(record.plannedAction.kind, choice);
    assert.equal(record.plannedAction.kind, 'abstain');
    assert.equal(record.appliedAction, null);
    assert.equal(record.authorityGranted, false);
    assert.equal(record.consentFabricated, false);
    assert.equal(record.verified, false);
    assert.equal(record.persisted, false);
    assert.equal(decodedBody(record).answers.failureFamily.choice, choice);
  });
}

test('every planned action from schema-valid and grant-shaped answers abstains', async () => {
  const cases = [
    ...['type_error', 'assertion', 'environment'].map((choice) => schemaValidFamilyBytes(choice)),
    ...GRANT_SHAPED.map((choice) => encodeJson(choiceEnvelope(baseAnswer({ choice })))),
  ];
  for (const bytes of cases) {
    const { record } = await evaluateAmbiguous(bytes);
    assert.equal(record.plannedAction.kind, 'abstain');
    assert.equal(record.appliedAction, null);
    assert.equal(record.authorityGranted, false);
    assert.equal(record.consentFabricated, false);
    assert.equal(record.verified, false);
    assert.equal(record.persisted, false);
  }
});

test('root package bin is jevris and the engines floor holds', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.bin, { jevris: './bin/jevris.mjs' });
  assert.equal(JSON.stringify(pkg.bin).includes('npx'), false);
  assert.equal(pkg.engines.node, '^22.14.0 || >=23.6.0');
});
