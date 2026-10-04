// Worker-readiness advice (owner decision 2026-10-01, Jev as an active decision aid). Before an owned worker is launched, Jev
// is asked ONE fixed Noul question from the task's content-free features: is this a bounded task a worker model can finish and
// pass its acceptance checks without escalating? The answer is advice, recorded as one advisory decision and shown by
// `jevris explain`. It never gates the launch. Rules answer first when they are sure (a protected path class, a task that names
// no file and no check). Scripted fetch, a real engine, temporary homes, no live call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackEngine } from './engine-settle.mjs';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');
const contracts = await import('@jevris/contracts');

const APPROVED = () => ({ provenance: 'administrator', sourceEgress: 'approved-scoped' });
const DENIED = () => ({ provenance: 'administrator', sourceEgress: 'deny-until-approved' });

function scriptedFetch(answer, { gate = null } = {}) {
  const requests = [];
  let finished = 0;
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (gate !== null) await gate;
    const answers = {};
    for (const id of Object.keys(body.questions)) {
      const p = answer(id, body);
      if (p !== null) answers[id] = { type: 'noul', noul: p };
    }
    finished += 1;
    return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 200, output_tokens: 6 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, requests, finishedCount: () => finished };
}

async function setup(t, answer, options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-ready-'));
  let tracker = null;
  t.after(async () => {
    try {
      await tracker?.settled();
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
  const script = scriptedFetch(answer, options);
  const engine = await provider.createSidecarEngine({ home, credential: 'test-key-not-a-secret', fetch: script.fetch, env: {}, sourceEgress: options.sourceEgress ?? APPROVED });
  tracker = trackEngine(engine);
  return { home, engine, requests: script.requests, script };
}

async function until(condition) {
  const stop = performance.now() + 30_000;
  while (!condition() && performance.now() < stop) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(condition(), true, 'the condition held before the generous bound');
}

const CTX = { workspaceId: 'w-ready', evidenceRevision: 'rev-1', taskId: 'task-1' };
const ASK = { assist: 'classify', deadlineMs: 30_000 };
const BOUNDED = { title: 'Fix the zebra crash in the date parser', paths: ['src/zebra/parse.ts', 'test/zebra/parse.test.ts'], checkIds: ['unit-tests-zebra', 'lint'] };

test('the question is a fixed Noul whose text describes the facts and what a bounded task looks like, with no text of the task; the spec is its calibration key', () => {
  const q = core.WORKER_READINESS_QUESTIONS.workerReady;
  assert.equal(q.type, 'noul');
  assert.deepEqual(Object.keys(core.WORKER_READINESS_QUESTIONS), ['workerReady']);
  assert.match(q.instructions, /counts and categories only/);
  assert.match(q.instructions, /acceptance checks/);
  // The anchors name the thresholds in the names of the facts they are judged on: the wording measured best live (worker-readiness-wordings-measured.test.mjs).
  assert.match(q.criteria.true, /between 1 and 8 files \(files is between 1 and 8\), none in a protected path class \(protectedClasses is none\), and it has at least one acceptance check \(checks is 1 or more\)/);
  assert.match(q.criteria.false, /names no files \(files is 0\) or more than 8, it has no acceptance check \(checks is 0\), or it touches a protected path class \(protectedClasses is not none\)/);
  for (const factName of ['files', 'checks', 'protectedClasses']) assert.ok(factName in core.workerReadinessFacts(core.sliceFeatures({ title: 'x', paths: ['a.ts'], checkIds: ['t'] })), `${factName} is a fact the request carries, so the anchors point at something in it`);
  assert.deepEqual(core.WORKER_READINESS_SPEC, { id: 'worker-readiness', version: 'v1' });
  assert.equal(core.workerCalibrationContext({ sliceId: 'bounded-edit', nowMs: 1 }).questionHash, contracts.questionHash(core.WORKER_READINESS_QUESTIONS), 'a signed release is bound to this text: a change to it refuses an older release (US34)');
  assert.equal(core.compileDecisionSpec({ id: 'worker-readiness', version: 'v1', questions: core.WORKER_READINESS_QUESTIONS, evidenceRequirements: [], deadlineMs: 700, fallback: 'rules-only' }).ok, true);
});

test('the request carries counts and codes only, with egress denied and approved alike: no title, path or check id leaves', async (t) => {
  for (const egress of [DENIED, APPROVED]) {
    const { engine, requests } = await setup(t, () => 0.8, { sourceEgress: egress });
    const advice = await core.adviseWorkerReadiness(engine, BOUNDED, CTX, ASK);
    assert.equal(requests.length, 1);
    const wire = JSON.stringify(requests);
    for (const leak of ['zebra', 'src/', 'test/', 'parse', 'unit-tests', 'Fix the']) assert.equal(wire.includes(leak), false, `${leak} must not leave`);
    assert.deepEqual([requests[0].state.untrustedEvidence, requests[0].state.withheldEvidence], [[], []], 'no evidence span at all');
    assert.deepEqual(requests[0].state.facts, { files: 2, checks: 2, protectedClasses: 'none', verb: 'fix', titleSize: 'short', roleSource: 1, roleTest: 1, roleDocs: 0, roleConfig: 0, roleCi: 0, checkKinds: 'test,lint' });
    assert.deepEqual(requests[0].questions, JSON.parse(JSON.stringify(core.WORKER_READINESS_QUESTIONS)), 'the fixed question');
    assert.deepEqual([advice.state, advice.source, advice.probability, advice.reasonCode, advice.asked], ['ready', 'jev', 0.8, 'WORKER_READINESS_JEV', true]);
  }
});

test('Jev says ready, not ready or unsure at its certainty; below 0.6 certainty no readiness is stated', async (t) => {
  let p = 0.85;
  const { engine } = await setup(t, () => p);
  const ask = (extra) => core.adviseWorkerReadiness(engine, { ...BOUNDED, paths: [`src/a${String(Math.random()).slice(2, 8)}.ts`, ...extra] }, CTX, ASK);
  const ready = await ask(['src/x.ts']);
  assert.deepEqual([ready.state, ready.probability], ['ready', 0.85]);
  p = 0.15;
  const notReady = await ask(['src/y.ts', 'src/z.ts']);
  assert.deepEqual([notReady.state, notReady.probability, notReady.source], ['not-ready', 0.15, 'jev']);
  p = 0.5;
  const unsure = await ask(['src/w.ts', 'src/v.ts', 'src/u.ts']);
  assert.deepEqual([unsure.state, unsure.source, unsure.reasonCode], ['unsure', 'jev', 'WORKER_READINESS_JEV_UNSURE']);
  p = 0.55;
  assert.equal((await ask(['src/t1.ts', 'src/t2.ts', 'src/t3.ts', 'src/t4.ts'])).state, 'unsure', '0.55 is under the 0.6 certainty floor either way');
});

test('the rules answer first when they are sure: a protected path class is not for an automatic worker, and a task naming no file and no check is open-ended; no request, still recorded', async (t) => {
  const { engine, requests } = await setup(t, () => 0.9);
  const protectedTask = await core.adviseWorkerReadiness(engine, { title: 'Rotate the key', paths: ['config/secrets.env', 'src/auth/token.ts'], checkIds: ['unit-tests'] }, CTX, ASK);
  assert.deepEqual([protectedTask.state, protectedTask.source, protectedTask.reasonCode, protectedTask.asked], ['not-ready', 'rules', 'WORKER_READINESS_RULES_PROTECTED', false]);
  const open = await core.adviseWorkerReadiness(engine, { title: 'Look at the thing', paths: [], checkIds: [] }, CTX, ASK);
  assert.deepEqual([open.state, open.source, open.reasonCode], ['not-ready', 'rules', 'WORKER_READINESS_RULES_OPEN_ENDED']);
  assert.equal(requests.length, 0, 'a deterministic fact needs no model');
  for (const advice of [protectedTask, open]) {
    const record = await engine.lookup(advice.decisionId);
    assert.deepEqual([record.specId, record.outcome], ['worker-readiness', 'advisory']);
    assert.ok(record.reasonCodes.includes('READY_SOURCE_RULES') && record.reasonCodes.includes('READY_STATE_NOT_READY'));
  }
});

test('every gate keeps no readiness with a reason and no request: kill switch, mode, jev.assist, no provider, no time', async (t) => {
  const { engine, requests } = await setup(t, () => 0.9);
  const cases = [
    ['kill switch', { killSwitchStopped: true }, engine, 'WORKER_READINESS_KILL_SWITCH'],
    ['mode off', { mode: 'off' }, engine, 'WORKER_READINESS_MODE_OFF'],
    ['jev.assist off', { assist: 'off' }, engine, 'WORKER_READINESS_ASSIST_OFF'],
    ['no engine', {}, null, 'WORKER_READINESS_NO_PROVIDER'],
    ['no provider configured', {}, { providerConfigured: false, lookup: async () => null }, 'WORKER_READINESS_NO_PROVIDER'],
    ['no time', { deadlineMs: 100 }, engine, 'WORKER_READINESS_NO_TIME'],
  ];
  for (const [label, extra, who, code] of cases) {
    const advice = await core.adviseWorkerReadiness(who, BOUNDED, CTX, { ...ASK, ...extra });
    assert.deepEqual([advice.state, advice.reasonCode, advice.asked, advice.decisionId], [null, code, false, null], label);
  }
  assert.equal(requests.length, 0);
});

test('a Jev error, an open circuit, an exhausted budget and a late answer state nothing, with the reason in the code', async () => {
  const stub = (reasonCode) => ({ providerConfigured: true, sourceEgress: () => 'approved', decide: async () => ({ abstained: true, reasonCode, decisionId: 'd-00000000-0000-4000-8000-000000000001', fallback: 'rules-only' }), lookup: async () => null });
  for (const [reason, expected, asked] of [['CIRCUIT_OPEN', 'WORKER_READINESS_JEV_CIRCUIT_OPEN', false], ['BUDGET', 'WORKER_READINESS_JEV_BUDGET', false], ['BUDGET_WORKSPACE_CAP', 'WORKER_READINESS_JEV_BUDGET_WORKSPACE_CAP', false], ['DEADLINE', 'WORKER_READINESS_JEV_DEADLINE', true]]) {
    const advice = await core.adviseWorkerReadiness(stub(reason), BOUNDED, CTX, ASK);
    assert.deepEqual([advice.state, advice.reasonCode, advice.asked], [null, expected, asked], reason);
  }
  const throwing = { providerConfigured: true, sourceEgress: () => 'approved', decide: async () => { throw new Error('boom'); }, lookup: async () => null };
  assert.deepEqual((({ state, reasonCode }) => [state, reasonCode])(await core.adviseWorkerReadiness(throwing, BOUNDED, CTX, ASK)), [null, 'WORKER_READINESS_ERROR']);
});

test('a slow Jev is abandoned at the deadline with no readiness stated; the late answer only warms the cache', async (t) => {
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  t.after(() => open());
  const { engine, requests, script } = await setup(t, () => 0.9, { gate });
  const late = await core.adviseWorkerReadiness(engine, BOUNDED, { ...CTX }, { ...ASK, deadlineMs: 150 });
  assert.deepEqual([late.state, late.reasonCode, late.asked], [null, 'WORKER_READINESS_DEADLINE', true], 'the caller did not wait for Jev');
  await until(() => requests.length === 1);
  assert.equal(script.finishedCount(), 0);
  open();
  await until(() => script.finishedCount() === 1);
  await until(() => engine.cache.stats().entries === 1);
  const warm = await core.adviseWorkerReadiness(engine, BOUNDED, CTX, ASK);
  assert.deepEqual([warm.state, warm.cacheHit], ['ready', true]);
  assert.equal(requests.length, 1, 'and cost no second call');
});

test('jevris explain renders the advisory decision: judged from structure alone, what was asked, the evidence names, and that the launch does not depend on it', async (t) => {
  const { engine } = await setup(t, () => 0.77);
  const advice = await core.adviseWorkerReadiness(engine, BOUNDED, CTX, ASK);
  const record = await engine.lookup(advice.decisionId);
  for (const code of ['READY_SOURCE_JEV', 'READY_STATE_READY', 'READY_P_77', 'READY_FILES_2', 'READY_CHECKS_2', 'READY_PROTECTED_0', 'READY_VERB_FIX', 'JEV_CACHE_MISS', 'WORKER_READINESS_JEV']) assert.ok(record.reasonCodes.includes(code), code);
  assert.deepEqual(record.proposedAction.evidenceIds, ['feature-files', 'feature-checks', 'feature-protected', 'feature-verb', 'feature-roles']);
  const text = core.explainDecision(record);
  assert.match(text, /Worker readiness: before this owned worker was launched, Jev judged the task from its structure alone: a worker model can finish it and pass its checks \(probability 77 percent that it is bounded\)\. The launch did not wait on it and does not depend on it\./);
  assert.match(text, /The task, as features: 2 files, 2 acceptance checks, no protected path class, kind of work fix\./);
  assert.match(text, /Asked Jev, \d+ ms\./);
  assert.match(text, /Reason: WORKER_READINESS_JEV\./);
  assert.match(text, /Evidence: feature-files, feature-checks, feature-protected, feature-verb, feature-roles \(counts and categories only; no path, check name or task text\)\./);
  assert.match(text, /never blocks it, starts it, picks a model or changes a reservation/);
  for (const leak of ['zebra', 'src/', 'unit-tests']) assert.equal(JSON.stringify(record).includes(leak) || text.includes(leak), false);
  // The engine's own record of the Jev call shares the spec id and is also advisory; it is explained as a provider call.
  assert.doesNotMatch(core.explainDecision(await engine.lookup(advice.jevDecisionId)), /Worker readiness:/);
  const again = await core.adviseWorkerReadiness(engine, BOUNDED, CTX, ASK);
  assert.match(core.explainDecision(await engine.lookup(again.decisionId)), /Answered from the cache/);
});
