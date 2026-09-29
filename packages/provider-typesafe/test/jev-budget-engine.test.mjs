// Owner decision 2026-09-29: the sidecar engine's Jev decision budget reads its limits at every
// reservation. A capped workspace goes rules-only with a reason code naming the cap; others go on.
// Temp homes, a mock Jev fetch, no keychain, no billed call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');
const { createDeadline } = await import('@jevris/platform');
const { createMockFetch, CONFORMANCE_REQUEST, createSidecarEngine, sidecarOps, DEFAULT_DECISION_BUDGET_MICRO_USD } = provider;
const { decide, compileDecisionSpec } = core;

const KEY = 'test-key-not-a-secret';
const QUESTIONS = CONFORMANCE_REQUEST.questions;

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-budget-engine-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let asked = 0;

/** A decision request; each one's packet differs, so the decision cache never answers it. */
function request(workspaceId) {
  asked += 1;
  const compiled = compileDecisionSpec({ id: 'task-profile', version: 'v1', questions: QUESTIONS, evidenceRequirements: ['e1'], deadlineMs: 60_000, fallback: 'rules-only' });
  assert.equal(compiled.ok, true);
  return {
    spec: compiled.spec,
    questions: QUESTIONS,
    workspaceId,
    evidenceRevision: 'rev-1',
    taskId: 'task-1',
    packet: {
      objective: `Add an optional display label to an existing response (${asked})`,
      trustedPolicy: { compatibilityRequired: true },
      facts: { publicApiChanged: true },
      evidence: [{ id: 'e1', text: 'Existing consumers deserialize this response.', sourceKind: 'file', priority: 'mandatory' }],
      missingEvidence: [],
    },
  };
}

function ctx(op, e, workspaceId) {
  return {
    op, client: 'cli', scopes: ['status', 'advice'], workspace: { id: workspaceId, root: null }, body: {}, home: '/nonexistent',
    signal: new AbortController().signal, deadline: createDeadline(5000), store: undefined, killSwitchStopped: false, engine: e, trace() {},
  };
}

test('the default monthly Jev decision budget is 5 USD in integer micro-USD', async (t) => {
  assert.equal(DEFAULT_DECISION_BUDGET_MICRO_USD, 5_000_000);
  const e = await createSidecarEngine({ home: home(t), credential: KEY, fetch: createMockFetch(), env: {} });
  assert.equal(e.budget.limitMicroUsd, 5_000_000);
  const snap = await e.budget.snapshot();
  assert.equal(snap.limitMicroUsd, 5_000_000);
  assert.ok(Number.isSafeInteger(snap.availableMicroUsd));
});

test('a workspace cap stops that workspace only (BUDGET_WORKSPACE_CAP), and a settings change applies without a restart', async (t) => {
  const mock = createMockFetch();
  const caps = { 'w-capped': 0 };
  let machine = 5_000_000;
  const e = await createSidecarEngine({ home: home(t), credential: KEY, fetch: mock, env: {}, budgetLimit: () => machine, workspaceBudgetLimit: (id) => caps[id] ?? null });
  const capped = await decide(request('w-capped'), e);
  assert.deepEqual([capped.abstained, capped.reasonCode], [true, 'BUDGET']);
  const record = await e.lookup(capped.decisionId);
  assert.deepEqual(record.reasonCodes, ['BUDGET', 'BUDGET_WORKSPACE_CAP', 'BUDGET_ZERO', 'RULES_ONLY']);
  assert.equal(record.billingBasis, 'no-provider-call');
  assert.equal(mock.calls, 0, 'no Jev call for the capped workspace');
  // Another workspace keeps working.
  const free = await decide(request('w-free'), e);
  assert.equal(free.abstained, false, JSON.stringify(free));
  assert.equal(mock.calls, 1);
  // The person lifts the cap: the next decision in that workspace is admitted.
  delete caps['w-capped'];
  assert.equal((await decide(request('w-capped'), e)).abstained, false);
  // The machine-wide limit set to 0: every workspace is rules-only, and the record says why.
  machine = 0;
  const zero = await decide(request('w-free'), e);
  assert.equal(zero.reasonCode, 'BUDGET');
  assert.deepEqual((await e.lookup(zero.decisionId)).reasonCodes, ['BUDGET', 'BUDGET_MACHINE_LIMIT', 'BUDGET_ZERO', 'RULES_ONLY']);
  assert.equal(mock.calls, 2);
  // Raised again: the spend of the two earlier calls is still counted.
  machine = 5_000_000;
  const snap = await e.budget.snapshot();
  assert.ok(snap.committedMicroUsd > 0, 'the month\'s spend is kept across the change');
  assert.equal(snap.availableMicroUsd, 5_000_000 - snap.committedMicroUsd - snap.reservedMicroUsd - snap.heldMicroUsd);
});

test('cost.report shows the machine-wide limit, this workspace\'s cap and the reset date', async (t) => {
  const e = await createSidecarEngine({ home: home(t), credential: KEY, fetch: createMockFetch(), env: {}, budgetLimit: () => 2_000_000, workspaceBudgetLimit: (id) => (id === 'w-capped' ? 500_000 : null) });
  assert.equal((await decide(request('w-capped'), e)).abstained, false);
  const ops = Object.fromEntries(sidecarOps.map((def) => [def.op, def]));
  const capped = await ops['cost.report'].handle(ctx('cost.report', e, 'w-capped'));
  assert.equal(capped.ok, true);
  const b = capped.body.budget;
  assert.equal(b.limitMicroUsd, 2_000_000);
  assert.match(b.resetsAt, /^\d{4}-\d{2}-01T00:00:00\.000Z$/);
  assert.equal(b.workspace.limitMicroUsd, 500_000);
  assert.equal(b.workspace.committedMicroUsd, b.committedMicroUsd, 'all spend so far was this workspace\'s');
  assert.equal(b.workspace.availableMicroUsd, 500_000 - b.workspace.committedMicroUsd);
  const free = await ops['cost.report'].handle(ctx('cost.report', e, 'w-free'));
  assert.equal(free.body.budget.workspace, null);
});
