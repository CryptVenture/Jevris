import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as F from './fixtures.mjs';

const c = await import('../dist/index.js');

const CTR01 = [
  'Mode',
  'Authority',
  'Risk',
  'Json',
  'EvidenceRef',
  'EventEnvelope',
  'Action',
  'ActionIntent',
  'Capability',
  'SessionSnapshot',
  'DecisionSpec',
  'DecisionResult',
  'ModelRegistryEntry',
  'TaskNode',
  'AgentLease',
  'BudgetReservation',
  'VerificationReceipt',
  'MemoryCapsule',
  'AuthorizationReceipt',
  'ActionReceipt',
];

const codes = (result) => (result.ok ? [] : result.issues.map((issue) => issue.code));
const paths = (result) => (result.ok ? [] : result.issues.map((issue) => issue.path));

test('every CTR-01 chapter 6 type is a catalogued contract with a validator and a schema (CTR-01)', () => {
  for (const name of CTR01) {
    const contract = c.CONTRACTS.get(name);
    assert.ok(contract, name);
    assert.equal(contract.name, name);
    assert.equal(contract.version, '1.0');
    assert.equal(typeof contract.validate, 'function');
    assert.equal(typeof contract.assert, 'function');
    assert.equal(typeof contract.parse, 'function');
    assert.equal(typeof c.jsonSchemaOf(contract.schema), 'object');
  }
  assert.equal(typeof c.guardHarnessAdapter, 'function');
});

test('each valid fixture validates and comes back as an equal deep-frozen copy', () => {
  for (const [name, make] of Object.entries(F.VALID)) {
    const input = make();
    const result = c.CONTRACTS.get(name).validate(input);
    assert.equal(result.ok, true, `${name}: ${JSON.stringify(result.issues)}`);
    assert.deepEqual(result.value, input, name);
    if (input !== null && typeof input === 'object') {
      assert.notEqual(result.value, input, name);
      assert.equal(Object.isFrozen(result.value), true, name);
    }
  }
});

test('objects are closed, required fields are required and literals are exact', () => {
  for (const [name, make] of Object.entries(F.VALID)) {
    const value = make();
    if (value === null || typeof value !== 'object' || Array.isArray(value) || name === 'Json') continue;
    const contract = c.CONTRACTS.get(name);
    const extra = { ...value, hostileExtra: 'x' };
    assert.equal(contract.validate(extra).ok, false, `${name} extra`);
    for (const key of Object.keys(value)) {
      const optional = ['span', 'agentId', 'taskId', 'causationId', 'provenance', 'reservationId'].includes(key);
      if (optional) continue;
      const missing = { ...value };
      delete missing[key];
      const result = contract.validate(missing);
      assert.equal(result.ok, false, `${name} missing ${key}`);
      assert.deepEqual(codes(result), ['required'], `${name} missing ${key}`);
      assert.deepEqual(paths(result), [`/${key}`], `${name} missing ${key}`);
    }
  }
  assert.equal(c.ModeContract.validate('auto').ok, false);
  assert.equal(c.EventEnvelopeContract.validate({ ...F.eventEnvelope(), schemaVersion: '1.1' }).ok, false);
  assert.equal(c.TaskNodeContract.validate({ ...F.taskNode(), schemaVersion: 1 }).ok, false);
});

test('absent and null are distinct; an undefined-valued property is refused (CTR-03)', () => {
  const snapshot = F.sessionSnapshot();
  // A nullable field is required: absent is not the same as null.
  delete snapshot.requestedModelId;
  assert.deepEqual(codes(c.SessionSnapshotContract.validate(snapshot)), ['required']);
  // An optional field may be absent, but it is not nullable.
  const envelope = F.eventEnvelope();
  delete envelope.taskId;
  assert.equal(c.EventEnvelopeContract.validate(envelope).ok, true);
  assert.equal(c.EventEnvelopeContract.validate({ ...envelope, taskId: null }).ok, false);
  // undefined is not JSON and is never read as absent.
  const withUndefined = { ...F.eventEnvelope(), taskId: undefined };
  assert.deepEqual(codes(c.EventEnvelopeContract.validate(withUndefined)), ['JSON_UNDEFINED']);
  assert.deepEqual(codes(c.SessionSnapshotContract.validate({ ...F.sessionSnapshot(), requestedModelId: undefined })), [
    'JSON_UNDEFINED',
  ]);
  // Non-JSON values are refused before schema validation.
  assert.deepEqual(codes(c.JsonContract.validate({ a: Number.NaN })), ['JSON_NUMBER']);
  assert.deepEqual(codes(c.JsonContract.validate({ a: () => 1 })), ['JSON_TYPE']);
  assert.deepEqual(codes(c.JsonContract.validate(new Date(0))), ['JSON_TYPE']);
  assert.deepEqual(codes(c.JsonContract.validate([1, , 3])), ['JSON_UNDEFINED']);
  assert.deepEqual(codes(c.JsonContract.validate(JSON.parse('{"__proto__":{"polluted":true}}'))), ['JSON_FORBIDDEN_KEY']);
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  assert.deepEqual(codes(c.JsonContract.validate(cyclic)), ['JSON_CYCLE']);
  let deep = 0;
  for (let i = 0; i < 70; i += 1) deep = [deep];
  assert.deepEqual(codes(c.JsonContract.validate(deep)), ['JSON_DEPTH']);
});

test('SessionSnapshot keeps unknown as null and never as zero (CTR-03)', () => {
  const snapshot = c.snapshotFromObservation({
    sessionId: 'sess-1',
    workspaceId: 'ws-1',
    revision: 'rev-1',
    mode: 'observe',
    observedAt: F.T0,
  });
  assert.equal(snapshot.contextTokensEstimate, null);
  assert.equal(snapshot.requestedModelId, null);
  assert.equal(snapshot.actualModelId, null);
  assert.deepEqual(snapshot.activeTaskIds, []);
  // A known zero stays a known zero, distinct from unknown.
  const known = c.snapshotFromObservation({ ...snapshot, contextTokensEstimate: 0 });
  assert.equal(known.contextTokensEstimate, 0);
  assert.notEqual(c.canonicalJson(known), c.canonicalJson(snapshot));
  // Round trip through JSON keeps null as null.
  const parsed = c.SessionSnapshotContract.parse(JSON.stringify(snapshot));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.contextTokensEstimate, null);
  assert.equal(c.SessionSnapshotContract.validate({ ...F.sessionSnapshot(), contextTokensEstimate: -1 }).ok, false);
  assert.equal(c.SessionSnapshotContract.validate({ ...F.sessionSnapshot(), contextTokensEstimate: 1.5 }).ok, false);
  assert.equal(c.SessionSnapshotContract.validate({ ...F.sessionSnapshot(), actualModelId: '' }).ok, false);
});

test('timestamps are RFC 3339 with an offset and a real calendar date', () => {
  for (const good of ['2026-09-25T10:00:00Z', '2024-02-29T23:59:59.123456789+05:30', '2026-01-01T00:00:00-08:00']) {
    assert.equal(c.isTimestamp(good), true, good);
  }
  for (const bad of ['2026-09-25', '2026-09-25T10:00:00', '2026-02-29T00:00:00Z', '2026-13-01T00:00:00Z', '2026-09-25T24:00:00Z', 'soon']) {
    assert.equal(c.isTimestamp(bad), false, bad);
    assert.equal(c.EvidenceRefContract.validate({ ...F.evidenceRef(), observedAt: bad }).ok, false, bad);
  }
});

test('EvidenceRef and EventEnvelope enforce hashes, spans and workspace scope', () => {
  assert.equal(c.EvidenceRefContract.validate({ ...F.evidenceRef(), contentHash: 'md5:abc' }).ok, false);
  assert.equal(c.EvidenceRefContract.validate({ ...F.evidenceRef(), contentHash: `sha256:${'A'.repeat(64)}` }).ok, false);
  assert.deepEqual(codes(c.EvidenceRefContract.validate({ ...F.evidenceRef(), span: { start: 9, end: 3 } })), ['SPAN_ORDER']);
  const foreign = F.eventEnvelope();
  foreign.evidence[0].workspaceId = 'ws-2';
  assert.deepEqual(codes(c.EventEnvelopeContract.validate(foreign)), ['WORKSPACE_SCOPE']);
  assert.equal(c.EventEnvelopeContract.validate({ ...F.eventEnvelope(), kind: 'PostToolUse' }).ok, false);
  assert.equal(c.EventEnvelopeContract.validate({ ...F.eventEnvelope(), sequence: -1 }).ok, false);
  for (const kind of c.DOMAIN_EVENT_KINDS) {
    assert.equal(c.EventEnvelopeContract.validate({ ...F.eventEnvelope(), kind }).ok, true, kind);
  }
  const late = { ...F.eventEnvelope(), deadlineAt: '2026-09-25T09:00:00Z' };
  assert.deepEqual(codes(c.EventEnvelopeContract.validate(late)), ['DEADLINE_BEFORE_OCCURRED']);
  const provenance = F.eventEnvelope();
  provenance.provenance.harness = 'gemini';
  assert.equal(c.EventEnvelopeContract.validate(provenance).ok, false);
});

test('Capability: no actuate without a certified implementation (§6.2)', () => {
  assert.equal(c.CapabilityContract.validate({ ...F.capability(), status: 'experimental' }).ok, false);
  assert.equal(c.CapabilityContract.validate({ ...F.capability(), status: 'unsupported' }).ok, false);
  assert.equal(c.CapabilityContract.validate({ ...F.capability(), authority: 'advise', status: 'experimental' }).ok, true);
  assert.equal(c.CapabilityContract.validate({ ...F.capability(), actionKind: 'run-shell' }).ok, false);
  assert.equal(c.CapabilityContract.validate({ ...F.capability(), adapterVersion: 'latest' }).ok, false);
});

test('DecisionSpec: a changed criterion changes the question hash and so the version', () => {
  const questions = {
    family: { type: 'choice', instructions: 'Which family?', criteria: { test: 'A test failed.', unknown: 'Unknown.' } },
    scope: { type: 'score', instructions: 'How much evidence?', criteria: ['None', 'Partial', 'Complete'] },
    repeated: { type: 'noul', instructions: 'Is there repeated failure?' },
  };
  const hash = c.questionHash(questions);
  assert.match(hash, /^sha256:[0-9a-f]{64}$/);
  const spec = { ...F.decisionSpec(), questionHash: hash };
  assert.equal(c.DecisionSpecContract.validate(spec).ok, true);
  assert.equal(c.decisionSpecMatches(spec, questions), true);
  const reordered = { repeated: questions.repeated, scope: questions.scope, family: questions.family };
  assert.equal(c.decisionSpecMatches(spec, reordered), true, 'object key order is not a change');
  const changed = structuredClone(questions);
  changed.family.criteria.test = 'An assertion failed.';
  assert.equal(c.decisionSpecMatches(spec, changed), false);
  const levels = structuredClone(questions);
  levels.scope.criteria = ['Partial', 'None', 'Complete'];
  assert.equal(c.decisionSpecMatches(spec, levels), false, 'Score level order is meaningful');
  assert.equal(c.DecisionSpecContract.validate({ ...spec, deadlineMs: 0 }).ok, false);
  assert.equal(c.DecisionSpecContract.validate({ ...spec, fallback: 'actuate' }).ok, false);
});

test('DecisionResult: typed answers only, distributions sum to one, no embedded action (§6.2)', () => {
  const embedded = F.decisionResult();
  embedded.answers.family.action = { kind: 'route-worker' };
  assert.equal(c.DecisionResultContract.validate(embedded).ok, false);
  const actionAnswer = F.decisionResult();
  actionAnswer.answers.next = { type: 'action', kind: 'advise' };
  assert.equal(c.DecisionResultContract.validate(actionAnswer).ok, false);
  const sum = F.decisionResult();
  sum.answers.family.probabilities.test = 0.5;
  assert.deepEqual(codes(c.DecisionResultContract.validate(sum)), ['PROBABILITY_SUM']);
  const notMax = F.decisionResult();
  notMax.answers.family.choice = 'unknown';
  assert.deepEqual(codes(c.DecisionResultContract.validate(notMax)), ['CHOICE_NOT_MAXIMUM']);
  const missing = F.decisionResult();
  missing.answers.family.choice = 'other';
  assert.deepEqual(codes(c.DecisionResultContract.validate(missing)), ['CHOICE_NOT_IN_DISTRIBUTION']);
  const legend = F.decisionResult();
  delete legend.answers.scope.legend['2'];
  assert.deepEqual(codes(c.DecisionResultContract.validate(legend)), ['LEGEND_MISMATCH']);
  const noul = F.decisionResult();
  noul.answers.repeated.noul = 1.01;
  assert.equal(c.DecisionResultContract.validate(noul).ok, false);
  const errored = { ...F.decisionResult(), error: { reasonCode: 'DEADLINE' } };
  assert.deepEqual(codes(c.DecisionResultContract.validate(errored)), ['ANSWERS_WITH_ERROR']);
  assert.equal(c.DecisionResultContract.validate({ ...errored, answers: {} }).ok, true);
  assert.equal(c.DecisionResultContract.validate({ ...F.decisionResult(), inputTokens: 0.5 }).ok, false);
});

test('ModelRegistryEntry versions price and quality independently', () => {
  const entry = F.modelRegistryEntry();
  assert.equal(c.ModelRegistryEntryContract.validate(entry).ok, true);
  assert.notEqual(entry.tariff.version, entry.evaluationVersion);
  assert.equal(c.ModelRegistryEntryContract.validate({ ...entry, tariff: { ...entry.tariff, currency: 'EUR' } }).ok, false);
  assert.equal(c.ModelRegistryEntryContract.validate({ ...entry, tariff: { ...entry.tariff, inputPerMillion: -1 } }).ok, false);
});

test('TaskNode graphs: a cyclic graph cannot be scheduled (§6.2)', () => {
  const ok = c.validateTaskGraph([F.taskNode('c', ['a', 'b']), F.taskNode('b', ['a']), F.taskNode('a')]);
  assert.deepEqual(ok, { ok: true, order: ['a', 'b', 'c'] });
  const cycle = c.validateTaskGraph([F.taskNode('a', ['c']), F.taskNode('b', ['a']), F.taskNode('c', ['b']), F.taskNode('d')]);
  assert.equal(cycle.ok, false);
  assert.deepEqual(cycle.issues, [
    { taskId: 'a', code: 'CYCLE' },
    { taskId: 'b', code: 'CYCLE' },
    { taskId: 'c', code: 'CYCLE' },
  ]);
  assert.deepEqual(c.validateTaskGraph([F.taskNode('a', ['zz'])]).issues, [{ taskId: 'a', code: 'UNKNOWN_DEPENDENCY' }]);
  assert.deepEqual(c.validateTaskGraph([F.taskNode('a'), F.taskNode('a')]).issues, [{ taskId: 'a', code: 'DUPLICATE_TASK' }]);
  assert.deepEqual(codes(c.TaskNodeContract.validate(F.taskNode('a', ['a']))), ['SELF_DEPENDENCY']);
  const other = { ...F.taskNode('b'), workspaceId: 'ws-2' };
  assert.deepEqual(c.validateTaskGraph([F.taskNode('a'), other]).issues, [{ taskId: 'b', code: 'WORKSPACE_SCOPE' }]);
  for (const scope of ['/etc/passwd', '../outside', 'a/../../b', 'C:/Windows', '\\\\server\\share', 'src/$(rm -rf)']) {
    assert.equal(c.TaskNodeContract.validate({ ...F.taskNode(), writeScopes: [scope] }).ok, false, scope);
  }
});

test('TaskNode graphs: a task that depends on itself is named SELF_DEPENDENCY, not INVALID_TASK (JEV-0016)', () => {
  const self = c.validateTaskGraph([F.taskNode('a', ['a'])]);
  assert.equal(self.ok, false);
  assert.deepEqual(self.issues, [{ taskId: 'a', code: 'SELF_DEPENDENCY' }]);
  // Its dependants are not reported as depending on an unknown task.
  assert.deepEqual(c.validateTaskGraph([F.taskNode('a', ['a']), F.taskNode('b', ['a'])]).issues, [{ taskId: 'a', code: 'SELF_DEPENDENCY' }]);
  // A malformed node stays INVALID_TASK, and a self-dependent malformed node too (the schema fails first).
  assert.deepEqual(c.validateTaskGraph([{ ...F.taskNode('a'), state: 'nope' }]).issues, [{ taskId: '#0', code: 'INVALID_TASK' }]);
  assert.deepEqual(c.validateTaskGraph([{ ...F.taskNode('a', ['a']), state: 'nope' }]).issues, [{ taskId: '#0', code: 'INVALID_TASK' }]);
});

test('projectTaskNode keeps the ten node keys and leaves the strict contract alone (JEV-0004)', () => {
  const node = F.taskNode('a');
  const extra = { ...node, title: 'A title', models: ['claude-haiku-4-5'], expectedOutputs: ['out'] };
  assert.equal(c.TaskNodeContract.validate(extra).ok, false, 'the node contract stays strict');
  assert.deepEqual(c.projectTaskNode(extra), node);
  assert.deepEqual(Object.keys(c.projectTaskNode(extra)).sort(), [...c.TASK_NODE_KEYS].sort());
  assert.equal(c.validateTaskGraph([c.projectTaskNode(extra)]).ok, true);
  // Not an object: returned as it is, so it still fails.
  for (const value of [null, 'a', 7, [node]]) assert.equal(c.projectTaskNode(value), value);
  assert.deepEqual(c.validateTaskGraph([c.projectTaskNode(null)]).issues, [{ taskId: '#0', code: 'INVALID_TASK' }]);
});

test('AgentLease and BudgetReservation invariants (§6.2)', () => {
  assert.deepEqual(codes(c.AgentLeaseContract.validate({ ...F.agentLease(), expiresAt: F.T0 })), ['EXPIRY_NOT_AFTER_HEARTBEAT']);
  assert.equal(c.AgentLeaseContract.validate({ ...F.agentLease(), fencingToken: 0 }).ok, false);
  assert.equal(c.AgentLeaseContract.validate({ ...F.agentLease(), fencingToken: 2 ** 53 }).ok, false);
  assert.deepEqual(codes(c.BudgetReservationContract.validate(F.budgetReservation({ state: 'committed' }))), [
    'COMMITTED_WITHOUT_ACTUAL',
  ]);
  assert.deepEqual(codes(c.BudgetReservationContract.validate(F.budgetReservation({ actualMicroUsd: 5 }))), ['ACTUAL_BEFORE_COMMIT']);
  assert.equal(c.BudgetReservationContract.validate(F.budgetReservation({ reservedMicroUsd: 0.5 })).ok, false);
  const a = F.budgetReservation({ id: 'a', reservedMicroUsd: 600 });
  const b = F.budgetReservation({ id: 'b', reservedMicroUsd: 500, state: 'uncertain' });
  const done = F.budgetReservation({ id: 'd', reservedMicroUsd: 900, actualMicroUsd: 100, state: 'committed' });
  const released = F.budgetReservation({ id: 'r', reservedMicroUsd: 9000, state: 'released' });
  assert.deepEqual(c.reservationsWithinBudget('budget-1', 1200, [a, b, done, released]), { ok: true, heldMicroUsd: 1200 });
  assert.deepEqual(c.reservationsWithinBudget('budget-1', 1199, [a, b, done, released]), {
    ok: false,
    reasonCode: 'OVER_BUDGET',
    heldMicroUsd: 1200,
  });
  assert.equal(c.reservationsWithinBudget('budget-2', 10_000, [a]).reasonCode, 'WRONG_BUDGET');
  const huge = F.budgetReservation({ reservedMicroUsd: Number.MAX_SAFE_INTEGER });
  assert.equal(c.reservationsWithinBudget('budget-1', Number.MAX_SAFE_INTEGER, [huge, huge]).reasonCode, 'UNSAFE_INTEGER');
});

test('VerificationReceipt: unknown and not-run are not passed (§6.2)', () => {
  assert.equal(c.receiptPassed(c.VerificationReceiptContract.assert(F.verificationReceipt('passed'))), true);
  for (const outcome of ['failed', 'unknown', 'not-run']) {
    assert.equal(c.receiptPassed(c.VerificationReceiptContract.assert(F.verificationReceipt(outcome))), false, outcome);
  }
  assert.equal(c.VerificationReceiptContract.validate(F.verificationReceipt('skipped')).ok, false);
});

test('MemoryCapsule: facts have provenance in the workspace; hypotheses are labelled text', () => {
  const foreign = F.memoryCapsule();
  foreign.pinnedEvidence[0].workspaceId = 'ws-9';
  assert.deepEqual(codes(c.MemoryCapsuleContract.validate(foreign)), ['WORKSPACE_SCOPE']);
  const duplicate = F.memoryCapsule();
  duplicate.optionalEvidence = [F.evidenceRef()];
  assert.deepEqual(codes(c.MemoryCapsuleContract.validate(duplicate)), ['DUPLICATE_EVIDENCE']);
  const secret = F.memoryCapsule();
  secret.hypotheses = ['the key is sk-ant-api03-abcdefghijklmnop'];
  assert.equal(c.MemoryCapsuleContract.validate(secret).ok, false);
  const bareFact = F.memoryCapsule();
  bareFact.pinnedEvidence = ['Consumers ignore unknown fields.'];
  assert.equal(c.MemoryCapsuleContract.validate(bareFact).ok, false);
});

test('AuthorizationReceipt: only trusted host or managed policy may issue it (§6.2)', () => {
  for (const issuer of ['host-policy', 'managed-policy', 'host-policy.org_default']) {
    assert.equal(c.AuthorizationReceiptContract.validate({ ...F.authorizationReceipt(), issuedBy: issuer }).ok, true, issuer);
  }
  for (const issuer of ['jev', 'model', 'user-consent', 'claude', 'host-policy-evil', 'host-policy.a/b']) {
    assert.equal(c.AuthorizationReceiptContract.validate({ ...F.authorizationReceipt(), issuedBy: issuer }).ok, false, issuer);
  }
  assert.deepEqual(codes(c.AuthorizationReceiptContract.validate({ ...F.authorizationReceipt(), expiresAt: F.T0 })), [
    'EXPIRY_NOT_AFTER_ISSUE',
  ]);
  assert.equal(c.AuthorizationReceiptContract.validate({ ...F.authorizationReceipt(), actionKinds: [] }).ok, false);
  assert.equal(c.AuthorizationReceiptContract.validate({ ...F.authorizationReceipt(), actionKinds: ['grant-permission'] }).ok, false);
});

test('ActionReceipt: planning is not evidence that an action happened', () => {
  assert.equal(c.actionApplied(c.ActionReceiptContract.assert(F.actionReceipt())), false);
  assert.equal(c.actionApplied(c.ActionReceiptContract.assert({ ...F.actionReceipt(), status: 'applied' })), true);
  assert.equal(c.ActionReceiptContract.validate({ ...F.actionReceipt(), status: 'planned' }).ok, false);
});

test('guardHarnessAdapter validates everything crossing the port', async () => {
  let seen = 0;
  const good = {
    async capabilities() {
      return [F.capability()];
    },
    async snapshot(sessionId) {
      return { ...F.sessionSnapshot(), sessionId };
    },
    async apply(intent) {
      seen += 1;
      return { ...F.actionReceipt(), intentId: intent.id };
    },
  };
  const guarded = c.guardHarnessAdapter(good);
  assert.equal((await guarded.capabilities()).length, 1);
  assert.equal((await guarded.snapshot('sess-2')).sessionId, 'sess-2');
  assert.equal((await guarded.apply(F.actionIntent(), new AbortController().signal)).intentId, 'intent-1');
  assert.equal(seen, 1);
  const hostile = { ...F.actionIntent(), action: { kind: 'advise', templateId: 'x', evidenceIds: [], command: 'rm -rf /' } };
  await assert.rejects(guarded.apply(hostile, new AbortController().signal), c.ContractError);
  assert.equal(seen, 1, 'the adapter never sees an invalid intent');
  const bad = c.guardHarnessAdapter({
    async capabilities() {
      return [{ ...F.capability(), status: 'experimental' }];
    },
    async snapshot() {
      return { ...F.sessionSnapshot(), contextTokensEstimate: undefined };
    },
    async apply() {
      return { ...F.actionReceipt(), intentId: 'someone-else' };
    },
  });
  await assert.rejects(bad.capabilities(), c.ContractError);
  await assert.rejects(bad.snapshot('sess-1'), c.ContractError);
  await assert.rejects(bad.apply(F.actionIntent(), new AbortController().signal), /INTENT_MISMATCH/);
  const wrongSession = c.guardHarnessAdapter({ ...good, snapshot: async () => F.sessionSnapshot() });
  await assert.rejects(wrongSession.snapshot('sess-other'), /SESSION_MISMATCH/);
});

test('the inferred TypeScript types equal the SSOT chapter 6 shapes (tsc over typecheck/)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const require = createRequire(join(here, '..', 'package.json'));
  const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
  const result = spawnSync(process.execPath, [tsc, '-p', join(here, '..', 'typecheck')], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test('errors carry paths and codes only, never input values', () => {
  const canary = 'CANARY_value_do_not_echo';
  const result = c.EvidenceRefContract.validate({ ...F.evidenceRef(), id: `${canary} x`, [canary]: 1 });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(canary), false);
  assert.throws(
    () => c.EvidenceRefContract.assert({ ...F.evidenceRef(), revision: `${canary} y` }),
    (error) => error instanceof c.ContractError && !error.message.includes(canary),
  );
  assert.deepEqual(codes(c.EvidenceRefContract.parse(new Uint8Array([0xff, 0xfe]))), ['INVALID_UTF8']);
  assert.deepEqual(codes(c.EvidenceRefContract.parse('{"id":')), ['INVALID_JSON']);
  assert.deepEqual(codes(c.EvidenceRefContract.parse(JSON.stringify(F.evidenceRef()), 16)), ['TOO_LARGE']);
  assert.deepEqual(codes(c.EvidenceRefContract.parse(`\uFEFF${JSON.stringify(F.evidenceRef())}`)), ['BOM']);
  assert.equal(c.EvidenceRefContract.parse(JSON.stringify(F.evidenceRef())).ok, true);
});

test('HookOutcome on the wire: a route names only a model id and a variant, never a rewritten tool input (owner decision 2026-09-27; C R20)', () => {
  const ok = (value) => c.HookOutcomeContract.validate(value).ok;
  for (const value of [
    { kind: 'observe' },
    { kind: 'context', text: 'Resume at step 3.' },
    { kind: 'explain', text: 'Outside the calibrated range.' },
    { kind: 'route', model: 'claude-haiku-4-5' },
    { kind: 'route', model: 'us.anthropic.claude-sonnet-4-v1:0' },
    { kind: 'route', model: 'm'.repeat(c.ROUTE_MODEL_MAX_LENGTH) },
    // R20: a Kilo or OpenCode subagent route takes the harness's provider/model spelling and a variant.
    { kind: 'route', model: 'openai/gpt-6-sol' },
    { kind: 'route', model: 'zai-coding-plan/glm-5.3', variant: 'high' },
    { kind: 'route', model: 'gpt-6-sol', variant: 'xhigh' },
    { kind: 'route', model: 'claude-haiku-4-5', variant: null },
  ]) {
    assert.equal(ok(value), true, JSON.stringify(value).slice(0, 80));
  }
  assert.equal(c.ROUTE_MODEL_MAX_LENGTH, 128);
  const key = ['sk', 'ant', 'api03', 'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lz'].join('-');
  for (const value of [
    { kind: 'route', updatedInput: { prompt: 'find x', model: 'haiku' } },
    { kind: 'route', model: 'haiku', updatedInput: { model: 'haiku' } },
    { kind: 'route' },
    { kind: 'route', model: '' },
    { kind: 'route', model: 'm'.repeat(c.ROUTE_MODEL_MAX_LENGTH + 1) },
    { kind: 'route', model: 'https://evil.example/m' },
    { kind: 'route', model: 'a/b/c/haiku' },
    { kind: 'route', model: 'OpenAI/gpt-6-sol' },
    { kind: 'route', model: 'openai/gpt-6-sol', variant: '' },
    { kind: 'route', model: 'openai/gpt-6-sol', variant: 'High' },
    { kind: 'route', model: 'openai/gpt-6-sol', variant: 'high; rm -rf /' },
    { kind: 'route', model: 'openai/gpt-6-sol', variant: 'v'.repeat(33) },
    { kind: 'route', model: 'openai/gpt-6-sol', variant: 3 },
    { kind: 'context', text: 'x', variant: 'high' },
    { kind: 'route', model: 'haiku; rm -rf /' },
    { kind: 'route', model: key },
    { kind: 'route', model: 7 },
    { kind: 'context', text: '' },
    { kind: 'explain' },
    { kind: 'allow' },
    { kind: 'observe', permissionDecision: 'allow' },
  ]) {
    assert.equal(ok(value), false, JSON.stringify(value).slice(0, 80));
  }
  assert.equal(JSON.stringify(c.HookOutcomeContract.validate({ kind: 'route', model: key })).includes(key), false, 'a refusal never echoes the value');
});

test('routing.modelListing is optional, on or off, and defaults to on; models.list is a certification feature (DOMAINS 3f090fa)', () => {
  const config = (listing) => {
    const value = F.VALID.JevrisConfig();
    if (listing !== undefined) value.routing.modelListing = listing;
    return c.JevrisConfigContract.validate(value).ok;
  };
  assert.deepEqual(c.MODEL_LISTING_VALUES, ['on', 'off']);
  assert.equal(c.MODEL_LISTING_DEFAULT, 'on');
  assert.equal(config(undefined), true, 'absent means the default');
  assert.equal(config('on'), true);
  assert.equal(config('off'), true);
  for (const bad of ['maybe', true, null, 'OFF']) assert.equal(config(bad), false, String(bad));
  assert.ok(c.CERTIFICATION_FEATURES.includes('models.list'));
  // A's R33 portability gate reads these two from a signed certification record.
  for (const feature of ['worker.actual-model', 'session.route', 'models.list-hosts', 'route.host']) assert.ok(c.CERTIFICATION_FEATURES.includes(feature), feature);
  // K21 (DOMAINS 3298853d): the Codex usage read, certified under OS network isolation; unsupported
  // where that isolation is not available.
  assert.ok(c.CERTIFICATION_FEATURES.includes('access.usage-read'));
  assert.equal(c.ACCESS_USAGE_ISOLATION_UNAVAILABLE, 'ACCESS_USAGE_ISOLATION_UNAVAILABLE');
  assert.match(c.ACCESS_USAGE_ISOLATION_UNAVAILABLE, /^[A-Z][A-Z0-9_]*$/);
});
