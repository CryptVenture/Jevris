import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');
const contracts = await import('@jevris/contracts');
const store = await import('@jevris/store');
const { createDeadline } = await import('@jevris/platform');
const { createSdkTransport, createMockFetch, CONFORMANCE_REQUEST, sidecarOps, workerModelOf } = provider;
const { createDecisionEngine, decide, compileDecisionSpec, DecisionBudget, observeModel } = core;

// Folders go after every test of the file and its own after-hooks (the store closes): node:test
// runs a test's after-hooks in the order they were added, and Windows refuses to remove a folder
// that holds an open database.
const temps = [];
after(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-worker-model-'));
  temps.push(dir);
  return dir;
}

function engine(dir) {
  const port = createSdkTransport({ apiKey: 'test-key-not-a-secret', fetch: createMockFetch({ scenario: 'valid' }) });
  return createDecisionEngine({ transport: port, journalDir: join(dir, 'decisions'), budget: DecisionBudget.open(join(dir, 'budget.json'), { limitMicroUsd: 1_000_000 }) });
}

function request(sessionId) {
  const compiled = compileDecisionSpec({ id: 'task-profile', version: 'v1', questions: CONFORMANCE_REQUEST.questions, evidenceRequirements: ['e1'], deadlineMs: 2000, fallback: 'rules-only' });
  return {
    spec: compiled.spec, questions: CONFORMANCE_REQUEST.questions, workspaceId: 'wModel', evidenceRevision: 'rev-1', taskId: 'task-1', ...(sessionId === undefined ? {} : { sessionId }),
    packet: { objective: 'Rename a helper', trustedPolicy: {}, facts: {}, evidence: [{ id: 'e1', text: 'A helper exists.', sourceKind: 'file', priority: 'mandatory' }], missingEvidence: [] },
  };
}

function ctx(op, body, e, opened) {
  return {
    op, client: 'cli', scopes: ['status'], workspace: { id: 'wModel', root: null }, body, home: '/nonexistent',
    signal: new AbortController().signal, deadline: createDeadline(900), store: opened, killSwitchStopped: false, engine: e, trace() {},
  };
}

function openHost(dir) {
  const opened = store.openStore({ path: join(dir, 'jevris.db'), role: 'sidecar', workspaceId: 'host', hostScope: 'hostA', fsKind: () => ({ kind: 'local', label: 't' }) });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  return opened;
}

const ops = Object.fromEntries(sidecarOps.map((def) => [def.op, def]));

test('US12: explain separates the requested and observed model of the decision session (store session row)', async (t) => {
  const dir = temp();
  const e = engine(dir);
  const host = openHost(dir);
  t.after(() => store.closeStore(host));
  const ws = store.workspaceView(host, 'wModel');
  assert.deepEqual(store.recordSession(ws, { sessionId: 'sess-sub', harness: 'claude-code', requestedModel: 'claude-opus-5', state: 'active', atMs: 1 }), { ok: true });
  store.recordSession(ws, { sessionId: 'sess-sub', harness: 'claude-code', actualModel: 'claude-sonnet-5', state: 'active', atMs: 2 });
  const outcome = await decide(request('sess-sub'), e);
  assert.equal(outcome.abstained, false, JSON.stringify(outcome));
  const record = (await e.entry(outcome.decisionId)).record;
  assert.equal(record.sessionId, 'sess-sub');
  assert.equal(contracts.DecisionRecordContract.validate(record).ok, true);

  const explained = await ops.explain.handle(ctx('explain', { decisionId: outcome.decisionId }, e, ws));
  assert.equal(explained.ok, true, JSON.stringify(explained));
  assert.equal(contracts.surfacePayloadContract('explain').validate(explained.body).ok, true);
  assert.deepEqual(explained.body.trace.models, { requested: 'claude-opus-5', observed: 'claude-sonnet-5', source: 'session', substituted: true, costPrecision: 'unknown' });
  assert.match(explained.body.trace.rendered, /requested claude-opus-5; observed claude-sonnet-5 \(substituted\), from the session\. Cost precision: unknown\./);
  // The Jev decision model is a different thing and stays where it was.
  assert.equal(explained.body.trace.resolvedModel, 'jev-1.13.0');

  const got = await ops['decision.get'].handle(ctx('decision.get', { decisionId: outcome.decisionId }, e, ws));
  assert.deepEqual(got.body.models, explained.body.trace.models);
});

test('US12: a missing observation is unknown and claims no cost precision', async (t) => {
  const dir = temp();
  const e = engine(dir);
  const host = openHost(dir);
  t.after(() => store.closeStore(host));
  const ws = store.workspaceView(host, 'wModel');
  store.recordSession(ws, { sessionId: 'sess-quiet', harness: 'claude-code', requestedModel: 'claude-opus-5', state: 'active', atMs: 1 });
  const unobserved = await decide(request('sess-quiet'), e);
  const quiet = await ops.explain.handle(ctx('explain', { decisionId: unobserved.decisionId }, e, ws));
  assert.deepEqual(quiet.body.trace.models, { requested: 'claude-opus-5', observed: null, source: 'unknown', substituted: null, costPrecision: 'unknown' });
  assert.match(quiet.body.trace.rendered, /observed unknown \(nothing reported it\)\. Cost precision: unknown\./);
  // No session at all, and no store at all: still unknown, never guessed.
  const bare = await decide(request(), e);
  for (const opened of [ws, undefined]) {
    const out = await ops.explain.handle(ctx('explain', { decisionId: bare.decisionId }, e, opened));
    assert.deepEqual(out.body.trace.models, { requested: null, observed: null, source: 'unknown', substituted: null, costPrecision: 'unknown' });
    assert.equal(contracts.surfacePayloadContract('explain').validate(out.body).ok, true);
  }
});

test('US12: a record that observed its worker wins over the session; untrusted labels are not echoed as models', () => {
  const observation = observeModel({ requestedModelId: 'claude-opus-5', sdkModelId: 'claude-sonnet-5', usageReported: true });
  const workerModel = { requested: observation.requestedModelId, observed: observation.observedModelId, source: observation.observedFrom, substituted: observation.substituted, costPrecision: observation.costPrecision };
  const record = { workerModel };
  assert.deepEqual(workerModelOf(record, { requested: 'x', actual: 'y' }), { requested: 'claude-opus-5', observed: 'claude-sonnet-5', source: 'sdk', substituted: true, costPrecision: 'provider-reported' });
  assert.deepEqual(workerModelOf(null, { requested: 'claude-opus-5', actual: 'Claude Opus 5 (1M context)' }), { requested: 'claude-opus-5', observed: null, source: 'unknown', substituted: null, costPrecision: 'unknown' });
  assert.deepEqual(workerModelOf(null, { requested: 'claude-opus-5', actual: 'claude-opus-5' }).substituted, false);
});
