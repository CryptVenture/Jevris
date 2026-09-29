/**
 * P7 end to end: an ordinary decision records its input-token estimate beside the reported usage,
 * and cost.report shows the estimator's calibration. No extra provider call is made.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');
const contracts = await import('@jevris/contracts');
const { createDeadline } = await import('@jevris/platform');
const { createSdkTransport, createMockFetch, CONFORMANCE_REQUEST, sidecarOps } = provider;

const QUESTIONS = CONFORMANCE_REQUEST.questions;

test('P7: a decision records the estimate of the request it sent with its encoder; cost.report compares it with the reported usage', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-estimator-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const port = createSdkTransport({ apiKey: 'test-key-not-a-secret', fetch: createMockFetch({ scenario: 'valid' }) });
  const budget = core.DecisionBudget.open(join(dir, 'budget.json'), { limitMicroUsd: 1_000_000 });
  const engine = core.createDecisionEngine({ transport: port, journalDir: join(dir, 'decisions'), budget });
  const compiled = core.compileDecisionSpec({ id: 'task-profile', version: 'v1', questions: QUESTIONS, evidenceRequirements: ['e1'], deadlineMs: 60_000, fallback: 'rules-only' });
  assert.equal(compiled.ok, true);
  const outcome = await core.decide({
    spec: compiled.spec, questions: QUESTIONS, workspaceId: 'w-test', evidenceRevision: 'rev-1', taskId: 'task-1',
    packet: { objective: 'Add an optional display label', trustedPolicy: {}, facts: {}, evidence: [{ id: 'e1', text: 'Consumers deserialize this response.', sourceKind: 'file', priority: 'mandatory' }], missingEvidence: [] },
  }, engine);
  assert.equal(outcome.abstained, false, JSON.stringify(outcome));
  const record = (await engine.entry(outcome.decisionId)).record;
  assert.equal(contracts.DecisionRecordContract.validate(record).ok, true);
  assert.equal(record.estimate.encoderId, core.ENCODER_ID);
  assert.ok(Number.isSafeInteger(record.estimate.inputTokens) && record.estimate.inputTokens > 0, JSON.stringify(record.estimate));
  assert.equal(port.calls, 1, 'no extra call');
  const ops = Object.fromEntries(sidecarOps.map((def) => [def.op, def]));
  const ctx = { op: 'cost.report', client: 'cli', scopes: ['status'], workspace: { id: 'w-test', root: null }, body: {}, home: dir, signal: new AbortController().signal, deadline: createDeadline(2000), store: undefined, killSwitchStopped: false, engine, trace() {} };
  const cost = await ops['cost.report'].handle(ctx);
  assert.equal(cost.ok, true);
  const estimator = cost.body.estimator;
  assert.deepEqual([estimator.schemaVersion, estimator.encoderId, estimator.samples], ['jevris-estimator-calibration-1', core.ENCODER_ID, 1]);
  const ratio = record.estimate.inputTokens / record.usage.inputTokens;
  assert.equal(estimator.ratio.p50, Math.round(ratio * 1000) / 1000);
  assert.equal(estimator.status, ratio < 1 ? 'under-estimate' : 'ok');
  assert.match(estimator.lines[0], /^Token estimator jevris-conservative-v1: estimate \/ reported input tokens over 1 decision\(s\)/);
});

test('P7: after a 422 repack the answer carries the estimate of the smaller request it sent, not the refused one', async () => {
  const fetch422 = createMockFetch({ scenario: ['http-422', 'valid'] });
  const client = new core.JevClient({ transport: createSdkTransport({ apiKey: 'test-key-not-a-secret', fetch: fetch422 }) });
  const smaller = { ...CONFORMANCE_REQUEST, state: 'smaller packet' };
  const answer = await client.ask({ request: CONFORMANCE_REQUEST, lane: 'background', deadline: createDeadline(5000), repack: () => smaller });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.repacked, true);
  assert.deepEqual(answer.estimate, core.estimateRequest(smaller));
  assert.notDeepEqual(answer.estimate, core.estimateRequest(CONFORMANCE_REQUEST));
});
