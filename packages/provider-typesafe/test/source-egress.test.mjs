import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');
const { createSidecarEngine, createMockFetch, CONFORMANCE_REQUEST } = provider;

const SECRET = ['sk', 'ant', 'api03', 'Z'.repeat(40)].join('-');
const FAILURE = `TypeError at src/billing/charge.ts:41 while reading ${SECRET}`;

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-egress-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// These tests count guard and provider calls, not the hot-path deadline. With a 2 s decision
// deadline, a loaded CI cell ran out of time before one send (DEADLINE, no call: "6 !== 7"), so
// they allow 60 s.
const TEST_DEADLINE_MS = 60_000;

function request(failureText = FAILURE) {
  const compiled = core.compileDecisionSpec({ id: 'recover-loop', version: 'v1', questions: CONFORMANCE_REQUEST.questions, evidenceRequirements: ['failure'], deadlineMs: TEST_DEADLINE_MS, fallback: 'rules-only' });
  return {
    spec: compiled.spec, questions: CONFORMANCE_REQUEST.questions, workspaceId: 'w-egress', evidenceRevision: 'rev-1',
    packet: {
      objective: 'Classify the repeated failure.', trustedPolicy: { capability: 'recover' }, facts: { attempts: 3 },
      evidence: [
        { id: 'failure', text: failureText, sourceKind: 'tool', priority: 'mandatory', category: 'failure-output' },
        { id: 'diff', text: 'diff --git a/src/billing/charge.ts b/src/billing/charge.ts', sourceKind: 'file', priority: 'high' },
      ],
    },
  };
}

const MODES = {
  missing: undefined,
  'deny-until-approved': () => ({ provenance: 'administrator', sourceEgress: 'deny-until-approved' }),
  'approved-scoped': () => ({ provenance: 'administrator', sourceEgress: 'approved-scoped' }),
};

async function run(t, mode, failureText) {
  const bodies = [];
  const fetch = createMockFetch({ onRequest: (body) => bodies.push(JSON.stringify(body)) });
  const engine = await createSidecarEngine({ home: home(t), credential: 'test-key-not-a-secret', fetch, env: {}, ...(MODES[mode] === undefined ? {} : { sourceEgress: MODES[mode] }) });
  const outcome = await core.decide(request(failureText), engine);
  return { outcome, bodies };
}

for (const mode of ['missing', 'deny-until-approved']) {
  test(`GOV-01/US02: egress ${mode}: the decision runs on structured features; no failure text, diff or secret is sent`, async (t) => {
    const { outcome, bodies } = await run(t, mode);
    assert.equal(outcome.abstained, false, JSON.stringify(outcome));
    assert.equal(bodies.length, 1);
    const [body] = bodies;
    for (const leak of ['ZZZZ', 'TypeError', 'charge.ts', 'diff --git']) assert.equal(body.includes(leak), false, leak);
    const state = JSON.parse(body).state;
    assert.deepEqual(state.untrustedEvidence, []);
    assert.deepEqual(state.withheldEvidence.map((w) => [w.source, w.category, w.characters]), [['tool', 'failure-output', FAILURE.length], ['file', 'file', 58]]);
    assert.match(state.withheldEvidence[0].digest, /^h[0-9a-f]{16}$/);
    // Nothing in the fields B's transport guard refuses (state.untrustedEvidence[].text,
    // state.evidence[].text, state.task).
    assert.equal(state.evidence, undefined);
    assert.equal(state.task, undefined);
  });
}

test('GOV-01/US02 (paired): egress approved-scoped sends evidence text, and a secret in it refuses the decision before any request', async (t) => {
  const clean = await run(t, 'approved-scoped', 'TypeError at src/billing/charge.ts:41');
  assert.equal(clean.outcome.abstained, false, JSON.stringify(clean.outcome));
  assert.equal(clean.bodies.length, 1);
  assert.equal(clean.bodies[0].includes('TypeError at src/billing/charge.ts:41'), true);
  assert.deepEqual(JSON.parse(clean.bodies[0]).state.withheldEvidence, []);
  const secret = await run(t, 'approved-scoped');
  assert.equal(secret.outcome.abstained, true);
  assert.equal(secret.outcome.reasonCode, 'SECRET_BLOCKED');
  assert.deepEqual(secret.bodies, [], 'nothing was sent');
});

test('GOV-01/US02: a setting that is not the administrator\'s, or that throws, is not approval', async (t) => {
  for (const sourceEgress of [() => ({ provenance: 'repository', sourceEgress: 'approved-scoped' }), () => ({ sourceEgress: 'approved-scoped' }), () => { throw new Error('unreadable'); }]) {
    const bodies = [];
    const engine = await createSidecarEngine({ home: home(t), credential: 'test-key-not-a-secret', fetch: createMockFetch({ onRequest: (body) => bodies.push(JSON.stringify(body)) }), env: {}, sourceEgress });
    const outcome = await core.decide(request('TypeError at src/billing/charge.ts:41'), engine);
    assert.equal(outcome.abstained, false);
    assert.equal(bodies[0].includes('TypeError'), false);
  }
});

test('GOV-01/GOV-08: a refusal from the host egress guard is a local refusal: its own reason, no provider call, no breaker count, nothing billed', async (t) => {
  for (const [guardCode, reasonCode] of [['EGRESS_SECRET_BLOCKED', 'SECRET_BLOCKED'], ['EGRESS_NOT_APPROVED', 'EGRESS_NOT_APPROVED']]) {
    let calls = 0;
    const guard = async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { type: guardCode.toLowerCase(), reasonCode: guardCode } }), { status: 451, headers: { 'content-type': 'application/json', 'x-jevris-egress': 'refused' } });
    };
    const engine = await createSidecarEngine({ home: home(t), credential: 'test-key-not-a-secret', fetch: guard, env: {}, sourceEgress: MODES['approved-scoped'] });
    const outcome = await core.decide(request('TypeError at src/billing/charge.ts:41'), engine);
    assert.deepEqual([outcome.abstained, outcome.reasonCode], [true, reasonCode]);
    assert.equal(calls, 1, 'the guard answered once and was not retried');
    const record = (await engine.entry(outcome.decisionId)).record;
    assert.deepEqual([record.outcome, record.reasonCodes, record.billingBasis, record.providerCalls], ['refused', [reasonCode], 'no-provider-call', 0]);
    assert.match(core.explainDecision(record), /no provider call was made/);
    const budget = await engine.budget.snapshot();
    assert.equal(budget.reservedMicroUsd ?? 0, 0, 'the reservation was released');
    for (let i = 0; i < 6; i += 1) await core.decide(request(`TypeError at src/billing/charge.ts:${50 + i}`), engine);
    assert.equal(calls, 7, 'repeated local refusals never open the breaker');
  }
});
