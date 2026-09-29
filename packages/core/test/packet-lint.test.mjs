import test from 'node:test';
import assert from 'node:assert/strict';

const { buildPacket, spanId, assembleSpans, lintQuestions, compileDecisionSpec, estimateJsonTokens } = await import('../dist/index.js');
const contracts = await import('@jevris/contracts');

const APPROVED = { sourceEgress: 'approved' };
const L = { maxStateTokens: 24_000, maxSpanChars: 4000, maxEvidenceItems: 128 };

function packetInput(overrides = {}) {
  return {
    objective: 'Add an optional display label to an existing response',
    phase: 'implement',
    trustedPolicy: { compatibilityRequired: true, allowedActions: ['advise'] },
    facts: { publicApiChanged: true, migrationPresent: false, requiredCheckIds: ['contract-response', 'unit-response'] },
    evidence: [
      { id: 'e1', text: 'Existing consumers deserialize this response.', sourceKind: 'file', priority: 'mandatory' },
      { id: 'e2', text: 'The response type is exported from the public module.', sourceKind: 'tool', priority: 'high' },
      { id: 'e3', text: 'A changelog entry mentions labels in passing.', sourceKind: 'file', priority: 'optional', category: 'changelog' },
    ],
    missingEvidence: ['consumer compatibility test result'],
    ...overrides,
  };
}

test('DEC-02: trusted policy and untrusted evidence live in separate sections; the state is always present', () => {
  const packet = buildPacket(packetInput(), L, APPROVED);
  assert.equal(packet.ok, true);
  const { state } = packet;
  assert.deepEqual(Object.keys(state).sort(), ['candidates', 'facts', 'missingEvidence', 'objective', 'omittedCategories', 'phase', 'truncated', 'trustedPolicy', 'untrustedEvidence', 'withheldEvidence']);
  assert.deepEqual(state.trustedPolicy, { compatibilityRequired: true, allowedActions: ['advise'] });
  assert.equal(state.untrustedEvidence.length, 3);
  assert.equal(JSON.stringify(state.trustedPolicy).includes('consumers'), false, 'no untrusted text in the policy section');
  assert.equal(state.truncated, false);
  assert.deepEqual(state.missingEvidence, ['consumer compatibility test result']);
  assert.match(packet.packetHash, /^sha256:/);
});

test('DEC-02: span ids are stable and software assembles the exact text Jev selected', () => {
  const a = buildPacket(packetInput(), L, APPROVED);
  const b = buildPacket(packetInput(), L, APPROVED);
  assert.deepEqual(a.spans, b.spans);
  assert.equal(a.packetHash, b.packetHash);
  assert.equal(a.spans.e1, spanId('e1', 'Existing consumers deserialize this response.'));
  const changed = buildPacket(packetInput({ evidence: [{ id: 'e1', text: 'Different text.', sourceKind: 'file', priority: 'mandatory' }] }), L, APPROVED);
  assert.notEqual(changed.spans.e1, a.spans.e1, 'a changed quotation gets a new span id');
  const spans = assembleSpans(a.state, [a.spans.e2, 'sUNKNOWN', a.spans.e1]);
  assert.deepEqual(spans.map((s) => s.text), ['The response type is exported from the public module.', 'Existing consumers deserialize this response.']);
});

test('DEC-02: over budget, optional evidence goes first, the packet says truncated and lists the omitted categories', () => {
  const big = 'word '.repeat(400);
  const input = packetInput({
    evidence: [
      { id: 'm1', text: 'Mandatory fact that must stay.', sourceKind: 'policy', priority: 'mandatory' },
      { id: 'h1', text: `High ${big}`, sourceKind: 'tool', priority: 'high', category: 'test-output' },
      { id: 'o1', text: `Optional ${big}`, sourceKind: 'file', priority: 'optional', category: 'changelog' },
    ],
  });
  const full = buildPacket(input, L, APPROVED);
  const budget = estimateJsonTokens(full.state) - 200;
  const packet = buildPacket(input, { maxStateTokens: budget, maxSpanChars: 4000, maxEvidenceItems: 128 }, APPROVED);
  assert.equal(packet.ok, true);
  assert.equal(packet.truncated, true);
  assert.deepEqual(packet.includedIds, ['m1', 'h1']);
  assert.deepEqual(packet.omittedIds, ['o1']);
  assert.deepEqual(packet.state.omittedCategories, ['changelog']);
  assert.ok(packet.stateTokens <= budget);
  const tight = buildPacket(input, { maxStateTokens: estimateJsonTokens(buildPacket({ ...input, evidence: [input.evidence[0]] }, L, APPROVED).state) + 60, maxSpanChars: 4000, maxEvidenceItems: 128 }, APPROVED);
  assert.equal(tight.ok, true);
  assert.deepEqual(tight.includedIds, ['m1'], 'mandatory facts are never dropped');
  assert.deepEqual(tight.state.omittedCategories, ['changelog', 'test-output']);
});

test('DEC-02: mandatory facts that do not fit refuse the packet instead of a misleading miniature', () => {
  const input = packetInput({ evidence: [{ id: 'm1', text: 'x '.repeat(1500), sourceKind: 'file', priority: 'mandatory' }] });
  const packet = buildPacket(input, { maxStateTokens: 300, maxSpanChars: 4000, maxEvidenceItems: 128 }, APPROVED);
  assert.equal(packet.ok, false);
  assert.equal(packet.reasonCode, 'MANDATORY_DOES_NOT_FIT');
});

test('DEC-02: a credential anywhere in the input blocks the packet before it is built', () => {
  const secretKey = ['sk', 'ant', 'api03', 'A'.repeat(40)].join('-');
  for (const input of [
    packetInput({ objective: `Use ${secretKey}` }),
    packetInput({ facts: { token: `ghp_${'a'.repeat(36)}` } }),
    packetInput({ evidence: [{ id: 'e1', text: `AKIA${'A'.repeat(16)}`, sourceKind: 'file', priority: 'optional' }] }),
  ]) {
    if (!contracts.containsSecret(JSON.stringify(input))) continue;
    const packet = buildPacket(input, L, APPROVED);
    assert.equal(packet.ok, false);
    assert.equal(packet.reasonCode, 'SECRET_BLOCKED');
    assert.equal(JSON.stringify(packet).includes('AAAA'), false, 'the refusal never echoes the secret');
  }
});

test('DEC-02: malformed input is refused with the field', () => {
  assert.equal(buildPacket(packetInput({ objective: ' ' })).field, '/objective');
  assert.equal(buildPacket(packetInput({ evidence: [{ id: 'a', text: 'x', sourceKind: 'web', priority: 'high' }] })).field, '/evidence/0/sourceKind');
  const dup = buildPacket(packetInput({ evidence: [{ id: 'a', text: 'x', sourceKind: 'file', priority: 'high' }, { id: 'a', text: 'y', sourceKind: 'file', priority: 'high' }] }));
  assert.equal(dup.field, '/evidence/1/id');
});

const GOOD = {
  taskFamily: {
    type: 'choice',
    instructions: 'Which listed task family best describes this request?',
    criteria: {
      documentation: 'Only documentation text changes.',
      compatible_api_change: 'An existing API changes while compatibility is required.',
      data_migration: 'Stored data must be transformed.',
      unknown: 'The evidence is insufficient or another family fits.',
    },
  },
  changeRisk: {
    type: 'score',
    instructions: 'How consequential is this change?',
    criteria: [
      'A documentation-only change with no executable behavior.',
      'A local reversible implementation change.',
      'A change crossing public interfaces or persistence.',
      'A change involving authorization, destructive migration or critical availability.',
    ],
  },
  compatibilityEvidenceMissing: { type: 'noul', instructions: 'Is required compatibility evidence missing from the supplied packet?' },
};

test('DEC-03: the §23.2 question set lints clean and its hash is stable and order-sensitive', () => {
  const report = lintQuestions(GOOD);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.deepEqual(report.warnings, []);
  assert.equal(report.questionHash, contracts.questionHash(GOOD));
  const reordered = { ...GOOD, taskFamily: { ...GOOD.taskFamily, criteria: Object.fromEntries(Object.entries(GOOD.taskFamily.criteria).reverse()) } };
  assert.equal(lintQuestions(GOOD).orderHash, report.orderHash, 'stable');
  assert.notEqual(lintQuestions(reordered).orderHash, report.orderHash, 'criteria order is part of the cache key');
});

test('DEC-03: each error class is rejected', () => {
  const cases = [
    [{ q: { type: 'choice', instructions: ' ', criteria: { a: 'Option a text.', b: 'Option b text.' } } }, 'MISSING_INSTRUCTIONS'],
    [{ q: { type: 'rank', instructions: 'Rank these.' } }, 'UNSUPPORTED_TYPE'],
    [{ q: { type: 'choice', instructions: 'Pick one.', criteria: { a: 'Only one option.' } } }, 'EMPTY_OPTIONS'],
    [{ q: { type: 'choice', instructions: 'Pick one.', criteria: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`o${i}`, `Option number ${i}.`])) } }, 'EXCESS_OPTIONS'],
    [{ q: { type: 'choice', instructions: 'Pick one.', criteria: { a: 'Same text here.', b: 'Same text here.' } } }, 'DUPLICATE_CRITERIA'],
    [{ q: { type: 'choice', instructions: 'Pick one.', criteria: { a: 'Same, text here', b: 'same text here.' } } }, 'AMBIGUOUS_CRITERIA'],
    [{ q: { type: 'score', instructions: 'Rate it.', criteria: ['Only one level described here.'] } }, 'RUBRIC_LENGTH'],
    [{ q: { type: 'score', instructions: 'Rate it.', criteria: ['low', 'medium', 'high'] } }, 'RUBRIC_ANCHOR'],
    [{ q: { type: 'noul', instructions: 'Does ${sourceText} mention a migration?' } }, 'SENSITIVE_RAW_FIELD'],
    [{ q: { type: 'noul', instructions: 'Is it done?', criteria: { yes: 'Yes it is done.', no: 'No it is not.' } } }, 'INVALID_NOUL_CRITERIA'],
  ];
  for (const [questions, code] of cases) {
    const report = lintQuestions(questions);
    assert.equal(report.ok, false, code);
    assert.ok(report.errors.some((error) => error.code === code), `${code}: ${JSON.stringify(report.errors)}`);
  }
  const undeclared = lintQuestions(GOOD, { declaredEvidence: ['e1'], usedEvidence: ['e1', 'e9'] });
  assert.deepEqual(undeclared.errors, [{ questionId: null, code: 'UNDECLARED_EVIDENCE', criterion: 'e9' }]);
  const tooMany = lintQuestions(Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`q${i}`, { type: 'noul', instructions: `Is item ${i} present in the packet?` }])));
  assert.ok(tooMany.errors.some((error) => error.code === 'TOO_MANY_QUESTIONS'));
});

test('DEC-03: negation, several judgments, arithmetic and sibling dependence are warnings, not errors', () => {
  const report = lintQuestions({
    notTested: { type: 'noul', instructions: 'Is the change not covered by any test?' },
    both: { type: 'noul', instructions: 'Is the API public and also whether it is versioned?' },
    count: { type: 'noul', instructions: 'Are there more than 3 failing tests? Count them.' },
    sibling: { type: 'noul', instructions: 'Given the answer to notTested, is a migration needed?' },
    noUnknown: { type: 'choice', instructions: 'Which family fits?', criteria: { docs: 'Documentation only.', code: 'Code behavior changes.' } },
  });
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  const codes = (id) => report.warnings.filter((w) => w.questionId === id).map((w) => w.code);
  assert.ok(codes('notTested').includes('NEGATION'));
  assert.ok(codes('both').includes('MULTI_JUDGMENT'));
  assert.ok(codes('count').includes('ARITHMETIC'));
  assert.ok(codes('sibling').includes('SIBLING_DEPENDENCE'));
  assert.ok(codes('noUnknown').includes('NO_UNKNOWN_OPTION'));
});

test('DEC-03: compileDecisionSpec produces a valid DecisionSpec or refuses', () => {
  const compiled = compileDecisionSpec({ id: 'route-task-profile', version: 'v1', questions: GOOD, evidenceRequirements: ['e1'], deadlineMs: 900, fallback: 'rules-only' });
  assert.equal(compiled.ok, true);
  assert.equal(contracts.DecisionSpecContract.validate(compiled.spec).ok, true);
  assert.equal(contracts.decisionSpecMatches(compiled.spec, GOOD), true);
  const refused = compileDecisionSpec({ id: 'x', version: 'v1', questions: { q: { type: 'noul', instructions: '' } }, deadlineMs: 900, fallback: 'abstain' });
  assert.equal(refused.ok, false);
});

const SECRET = ['sk', 'ant', 'api03', 'Q'.repeat(40)].join('-');
const failure = () => packetInput({ evidence: [
  { id: 'f1', text: `npm test failed: ${SECRET} in src/config.ts line 4`, sourceKind: 'tool', priority: 'mandatory', category: 'test-output' },
  { id: 'u1', text: 'The user said the build broke after the rename.', sourceKind: 'user', priority: 'high' },
  { id: 'c1', text: 'const key = process.env.KEY;', sourceKind: 'file', priority: 'optional', category: 'Not A Category!' },
] });

test('GOV-01/US02: without approved egress no evidence text is sent, only structured features', () => {
  for (const options of [undefined, { sourceEgress: 'denied' }, { sourceEgress: 'denied', salt: 'engine-salt' }]) {
    const packet = buildPacket(failure(), L, options);
    assert.equal(packet.ok, true, JSON.stringify(packet));
    const text = JSON.stringify(packet.state);
    assert.equal(text.includes('QQQQ'), false, 'the secret never enters the state');
    assert.equal(text.includes('npm test failed'), false);
    assert.equal(text.includes('process.env'), false);
    assert.equal(text.includes('the build broke'), false, 'user-sourced evidence text is withheld too');
    assert.deepEqual(packet.state.untrustedEvidence, []);
    assert.deepEqual(packet.state.withheldEvidence.map((w) => [w.source, w.category]), [['tool', 'test-output'], ['user', 'user'], ['file', 'file']]);
    assert.equal(packet.state.withheldEvidence[0].characters, failure().evidence[0].text.length);
    for (const w of packet.state.withheldEvidence) assert.equal(w.digest === null, options?.salt === undefined);
    assert.deepEqual(packet.includedIds, ['f1', 'u1', 'c1'], 'mandatory evidence still counts as present');
  }
  const salted = (salt) => buildPacket(failure(), L, { sourceEgress: 'denied', salt }).state.withheldEvidence[0].digest;
  assert.equal(salted('a'), salted('a'));
  assert.notEqual(salted('a'), salted('b'), 'the digest depends on the per-engine salt');
});

test('GOV-01/US02 (paired): with approved egress the text goes, screened for secrets first', () => {
  const blocked = buildPacket(failure(), L, APPROVED);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reasonCode, 'SECRET_BLOCKED');
  const clean = packetInput({ evidence: [{ id: 'f1', text: 'npm test failed in src/config.ts line 4', sourceKind: 'tool', priority: 'mandatory' }] });
  const sent = buildPacket(clean, L, APPROVED);
  assert.equal(sent.ok, true);
  assert.deepEqual(sent.state.untrustedEvidence.map((s) => s.text), ['npm test failed in src/config.ts line 4']);
  assert.deepEqual(sent.state.withheldEvidence, []);
  // GOV-08 screening: what containsSecret misses (an AWS secret key) and sensitive paths block too.
  for (const text of ['aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'copied from ~/.ssh/id_rsa']) {
    const flagged = buildPacket(packetInput({ evidence: [{ id: 'f1', text, sourceKind: 'tool', priority: 'mandatory' }] }), L, APPROVED);
    assert.deepEqual([flagged.ok, flagged.reasonCode, flagged.field], [false, 'SECRET_BLOCKED', '/evidence/0/text'], text);
    // Denied: the same text is withheld, never screened into a refusal, never sent.
    const denied = buildPacket(packetInput({ evidence: [{ id: 'f1', text, sourceKind: 'tool', priority: 'mandatory' }] }), L, { sourceEgress: 'denied' });
    assert.equal(denied.ok, true);
    assert.equal(JSON.stringify(denied.state).includes(text), false);
  }
  // A secret in the objective blocks in every mode: the objective is always sent.
  assert.equal(buildPacket(packetInput({ objective: `Use ${SECRET}` }), L, { sourceEgress: 'denied' }).reasonCode, 'SECRET_BLOCKED');
});

test('GOV-08/W06: every sent field is screened, the refusal locates each finding by pointer, rule and offsets, and never echoes text or a caller key', () => {
  const objective = 'Upload ~/.aws/credentials now';
  const blocked = buildPacket(packetInput({ objective }), L, { sourceEgress: 'denied' });
  assert.deepEqual([blocked.ok, blocked.reasonCode, blocked.field], [false, 'SECRET_BLOCKED', '/objective']);
  const [finding] = blocked.findings;
  assert.equal(finding.ruleId, 'path-cloud-credentials');
  assert.equal(objective.slice(finding.start, finding.start + finding.length).includes('aws'), true, 'the offsets point at the match');
  // A secret-shaped key in the facts: the pointer names the field, never the key itself.
  const key = `AKIA${'B'.repeat(16)}`;
  const keyed = buildPacket(packetInput({ facts: { [key]: 1 } }), L, { sourceEgress: 'denied' });
  assert.equal(keyed.reasonCode, 'SECRET_BLOCKED');
  assert.equal(keyed.field, '/facts/*');
  assert.equal(JSON.stringify(keyed).includes('BBBB'), false);
  // Candidates and missing-evidence labels are sent, so they are screened too.
  assert.equal(buildPacket(packetInput({ candidates: [{ id: 'c1', description: 'read the .npmrc file' }] }), L, { sourceEgress: 'denied' }).field, '/candidates/0/description');
  assert.equal(buildPacket(packetInput({ missingEvidence: ['the id_rsa key'] }), L, { sourceEgress: 'denied' }).field, '/missingEvidence/0');
});
