// Live new-task advice (owner decision 2026-10-01, Jev as an active decision aid; C01 and C02 on the
// hook path). When a prompt starts a task, Jev reads the request once and says, in one short line at
// the next event, which kind of work it looks like and the one question whose answer would most
// change the implementation. The request itself is never rewritten and nothing is blocked.
//
// This reads the person's own words, so it runs only with source egress approved: with egress denied
// (the default) it abstains with EGRESS_NOT_APPROVED, makes no request, records nothing and the hook is
// exactly what it was. With egress approved the request goes as ONE screened evidence span, and the
// question text, options and instructions are fixed templates with no user text. Detached after the
// hook answers. Scripted fetch and stub engines, temporary homes, no live call, no real harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');
const contracts = await import('@jevris/contracts');
const { createDeadline } = await import('@jevris/platform');

const ops = Object.fromEntries(provider.sidecarOps.map((def) => [def.op, def]));
const sha = (text) => createHash('sha256').update(text).digest('hex');

const APPROVED = () => ({ provenance: 'administrator', sourceEgress: 'approved-scoped' });
const DENIED = () => ({ provenance: 'administrator', sourceEgress: 'deny-until-approved' });

/**
 * A scripted Jev endpoint: `answer(id, question, body)` gives `{ choice, confidence }` (or explicit
 * `probabilities`), or null for no answer. Every request body is recorded. `gate` holds every answer
 * until opened; `hang` never answers.
 */
function scriptedFetch(answer, { gate = null, hang = false } = {}) {
  const requests = [];
  let finished = 0;
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (hang) return new Promise(() => {});
    if (gate !== null) await gate;
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      const want = answer(id, q, body);
      if (want === null) continue;
      const keys = Object.keys(q.criteria);
      const given = want.probabilities ?? { [want.choice ?? keys[0]]: want.confidence ?? 0.9 };
      const rest = keys.filter((k) => !(k in given));
      const left = 1 - Object.values(given).reduce((a, b) => a + b, 0);
      const probabilities = Object.fromEntries(keys.map((k) => [k, k in given ? given[k] : Math.round((left / rest.length) * 10000) / 10000]));
      const choice = want.choice ?? keys.reduce((a, b) => (probabilities[b] > probabilities[a] ? b : a));
      answers[id] = { type: 'choice', choice, probabilities, confidence: probabilities[choice] };
    }
    finished += 1;
    return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 300, output_tokens: 10 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, requests, finishedCount: () => finished };
}

async function setup(t, answer, options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-newtask-'));
  // A late answer may still be writing its record when the test ends: retry the removal.
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  const script = scriptedFetch(answer, options);
  const engine = await provider.createSidecarEngine({ home, credential: 'test-key-not-a-secret', fetch: script.fetch, env: {}, sourceEgress: options.sourceEgress ?? APPROVED });
  return { home, engine, script, requests: script.requests };
}

async function until(condition) {
  const stop = performance.now() + 30_000;
  while (!condition() && performance.now() < stop) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(condition(), true, 'the condition held before the generous bound');
}

const IDS = { workspaceId: 'w-task', sessionId: 's-1', taskId: 'task-1' };
const ASK = { assist: 'classify', deadlineMs: 30_000, ids: IDS, evidenceRevision: 'rev-1' };
const REQUEST = 'Fix the crash in the zebra cart when the cart is empty';
const ANSWER = (family, open, confidence = 0.9) => (id) => (id === 'family' ? { choice: family, confidence } : { choice: open, confidence });
const FAMILIES = ['bugfix', 'feature', 'refactor', 'tests', 'docs', 'investigation', 'config', 'dependency'];
const OPENS = ['scope', 'acceptance', 'target', 'edge-cases', 'compatibility'];

// ------------------------------------------------------------------ the fixed questions

test('the questions are fixed templates over two fixed lists: no user text, two questions, one request', () => {
  const questions = provider.newTaskQuestions();
  assert.deepEqual(Object.keys(questions), ['family', 'open']);
  assert.ok(Object.keys(questions).length <= contracts.MAX_QUESTIONS);
  assert.deepEqual(Object.keys(questions.family.criteria), [...FAMILIES, 'none', 'unknown']);
  assert.deepEqual(Object.keys(questions.open.criteria), [...OPENS, 'none', 'unknown']);
  assert.deepEqual([...provider.TASK_FAMILIES], FAMILIES);
  assert.deepEqual([...provider.OPEN_KINDS], OPENS);
  for (const q of Object.values(questions)) {
    assert.equal(q.type, 'choice');
    assert.match(q.instructions, /evidence item request/, 'the question points at the evidence, it does not quote it');
  }
  for (const id of FAMILIES) assert.equal(questions.family.criteria[id], provider.TASK_FAMILY_TEXT[id]);
  assert.deepEqual(JSON.parse(JSON.stringify(provider.newTaskQuestions())), JSON.parse(JSON.stringify(questions)), 'the same every time');
  // The compiled spec passes the question lint (fixed text, bounded options).
  assert.equal(core.compileDecisionSpec({ id: 'new-task', version: 'v1', questions, evidenceRequirements: ['request'], deadlineMs: 1500, fallback: 'rules-only' }).ok, true);
});

test('the advice line is one question, with the family named as a suggestion; never a block', () => {
  assert.equal(provider.newTaskAdviceText('bugfix', 'acceptance'), 'Jevris: one question before implementing: how will the result be shown to be correct? (This looks like a bugfix task.)');
  assert.equal(provider.newTaskAdviceText(null, 'scope'), 'Jevris: one question before implementing: what is in scope, and what must stay as it is?');
  assert.equal(provider.newTaskAdviceText('docs', null), 'Jevris: This looks like a docs task.');
  assert.equal(provider.newTaskAdviceText(null, null), null);
  for (const family of FAMILIES) for (const open of [...OPENS, null]) {
    const line = provider.newTaskAdviceText(family, open);
    assert.ok(line.startsWith('Jevris: '), line);
    assert.equal(/block|deny|must not|refuse|stop/i.test(line.replace('must stay', '').replace('must existing', '')), false, `advice, not a gate: ${line}`);
    assert.ok(line.length < 200, 'one short line');
  }
  for (const open of OPENS) assert.equal(provider.OPEN_QUESTION_TEXT[open].endsWith('?'), true, `${open} is a question`);
});

test('every gate is a reason and no request: kill switch, mode, jev.assist, no provider, egress, a short prompt, no time', () => {
  const engine = { providerConfigured: true, sourceEgress: () => 'approved' };
  const base = { assist: 'classify', engine, deadlineMs: 30_000, objective: REQUEST };
  const gate = (extra) => provider.newTaskAskGate({ ...base, ...extra });
  assert.equal(gate({}), null);
  assert.equal(gate({ killSwitchStopped: true }), 'NEW_TASK_KILL_SWITCH');
  assert.equal(gate({ mode: 'off' }), 'NEW_TASK_MODE_OFF');
  assert.equal(gate({ assist: 'off' }), 'NEW_TASK_ASSIST_OFF');
  assert.equal(gate({ engine: null }), 'NEW_TASK_NO_PROVIDER');
  assert.equal(gate({ engine: { providerConfigured: false, sourceEgress: () => 'approved' } }), 'NEW_TASK_NO_PROVIDER');
  assert.equal(gate({ engine: { providerConfigured: true, sourceEgress: () => 'denied' } }), 'EGRESS_NOT_APPROVED');
  assert.equal(gate({ engine: { providerConfigured: true } }), 'EGRESS_NOT_APPROVED', 'an engine that cannot say reads as denied');
  assert.equal(gate({ objective: 'fix it' }), 'NEW_TASK_TOO_SHORT');
  assert.equal(gate({ objective: null }), 'NEW_TASK_TOO_SHORT');
  assert.equal(gate({ deadlineMs: 100 }), 'NEW_TASK_NO_TIME');
  // The order: a stopped kill switch beats everything; egress comes before the length of the request.
  assert.equal(gate({ killSwitchStopped: true, engine: null, assist: 'off' }), 'NEW_TASK_KILL_SWITCH');
  assert.equal(gate({ engine: { providerConfigured: true, sourceEgress: () => 'denied' }, objective: 'fix it' }), 'EGRESS_NOT_APPROVED');
});

// ------------------------------------------------------------------ egress

test('egress denied: it abstains with EGRESS_NOT_APPROVED, makes no request, records nothing', async (t) => {
  const { engine, requests } = await setup(t, ANSWER('bugfix', 'scope'), { sourceEgress: DENIED });
  assert.equal(engine.sourceEgress(), 'denied');
  const advice = await provider.adviseNewTask(engine, REQUEST, ASK);
  assert.deepEqual([advice.reasonCode, advice.text, advice.asked, advice.askedCount, advice.decisionId, advice.family, advice.open], ['EGRESS_NOT_APPROVED', null, false, 0, null, null, null]);
  assert.equal(requests.length, 0, 'nothing left the machine');
  // The same with no setting at all: an engine built without a source-egress reader is denied.
  const home = mkdtempSync(join(tmpdir(), 'jevris-newtask-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bare = scriptedFetch(ANSWER('bugfix', 'scope'));
  const unset = await provider.createSidecarEngine({ home, credential: 'test-key-not-a-secret', fetch: bare.fetch, env: {} });
  assert.equal((await provider.adviseNewTask(unset, REQUEST, ASK)).reasonCode, 'EGRESS_NOT_APPROVED');
  assert.equal(bare.requests.length, 0);
});

test('egress approved: one request with ONE evidence span holding the request; every other part of it is fixed text', async (t) => {
  const { engine, requests } = await setup(t, ANSWER('bugfix', 'acceptance'));
  const advice = await provider.adviseNewTask(engine, REQUEST, ASK);
  assert.equal(requests.length, 1, 'one request');
  const body = requests[0];
  assert.deepEqual(Object.keys(body.questions), ['family', 'open'], 'two questions, under the cap of 12');
  assert.equal(body.state.untrustedEvidence.length, 1, 'ONE evidence span');
  assert.deepEqual([body.state.untrustedEvidence[0].text, body.state.untrustedEvidence[0].source], [REQUEST, 'user']);
  assert.deepEqual([body.state.withheldEvidence, body.state.missingEvidence], [[], []]);
  assert.equal(JSON.stringify(body).split('zebra').length - 1, 1, 'the request is in the span and nowhere else: not in the objective, the facts, the policy, a question or an option');
  assert.equal(body.state.objective.includes('zebra'), false);
  assert.deepEqual(Object.keys(body.state.facts).sort(), ['characters', 'words']);
  assert.deepEqual(body.questions, JSON.parse(JSON.stringify(provider.newTaskQuestions())), 'the questions are the fixed templates');
  assert.deepEqual([advice.reasonCode, advice.asked, advice.askedCount, advice.usedCount, advice.cacheHit, advice.family, advice.open], ['NEW_TASK_JEV', true, 2, 2, false, 'bugfix', 'acceptance']);
  assert.equal(advice.text, 'Jevris: one question before implementing: how will the result be shown to be correct? (This looks like a bugfix task.)');
  assert.equal(advice.text.includes('zebra'), false, 'the line is a fixed template');
  const record = await engine.lookup(advice.decisionId);
  assert.deepEqual([record.specId, record.outcome, record.taskId, record.sessionId], ['new-task', 'advisory', 'task-1', 's-1']);
  for (const code of ['TASK_SOURCE_JEV', 'TASK_FAMILY_BUGFIX', 'TASK_OPEN_ACCEPTANCE', 'TASK_ADVICE_QUESTION', 'TASK_ASKED_2', 'TASK_USED_2', 'JEV_CACHE_MISS', 'NEW_TASK_JEV']) assert.ok(record.reasonCodes.includes(code), code);
  assert.deepEqual(record.proposedAction.evidenceIds, ['request', 'fixed-templates']);
  assert.equal(typeof record.durationMs, 'number', 'the latency is recorded');
  assert.equal(JSON.stringify(record).includes('zebra'), false, 'the record holds reason codes, not the request');
  // The request is never rewritten: the advice carries no part of it and nothing returned changes it.
  assert.equal(Object.hasOwn(advice, 'objective'), false);
});

test('a secret in the request refuses the packet before any request, as for every other evidence span', async (t) => {
  const { engine, requests } = await setup(t, ANSWER('bugfix', 'scope'));
  const SECRET = ['sk', 'ant', 'api03', 'Z'.repeat(40)].join('-');
  const advice = await provider.adviseNewTask(engine, `Fix the login crash, the key is ${SECRET} in the config`, ASK);
  assert.deepEqual([advice.text, advice.reasonCode, advice.asked, advice.askedCount], [null, 'NEW_TASK_JEV_SECRET_BLOCKED', false, 0], 'refused here: the record says Jev was not asked');
  assert.deepEqual(requests, [], 'nothing was sent');
});

test('the request is clipped to one bounded span', async (t) => {
  const { engine, requests } = await setup(t, ANSWER('feature', 'scope'));
  const long = `Add a feature ${'word '.repeat(2000)}`;
  await provider.adviseNewTask(engine, long, ASK);
  assert.equal(requests[0].state.untrustedEvidence[0].text.length, 2000);
  assert.equal(requests[0].state.untrustedEvidence.length, 1);
});

// ------------------------------------------------------------------ what Jev says

test('the family is named as a suggestion and one open question is asked; a confident none says nothing for that part', async (t) => {
  let script = ANSWER('bugfix', 'none');
  const { engine } = await setup(t, (id, q, body) => script(id, q, body));
  const ask = (text) => provider.adviseNewTask(engine, text, ASK);
  const familyOnly = await ask('Fix the crash when the cart is empty please');
  assert.deepEqual([familyOnly.text, familyOnly.family, familyOnly.open, familyOnly.reasonCode, familyOnly.usedCount], ['Jevris: This looks like a bugfix task.', 'bugfix', null, 'NEW_TASK_JEV', 2]);
  script = ANSWER('none', 'scope');
  const questionOnly = await ask('Make the exports faster for large accounts');
  assert.deepEqual([questionOnly.text, questionOnly.family, questionOnly.open], ['Jevris: one question before implementing: what is in scope, and what must stay as it is?', null, 'scope']);
  script = ANSWER('unknown', 'none');
  const nothing = await ask('Do the thing we talked about yesterday afternoon');
  assert.deepEqual([nothing.text, nothing.asked, nothing.usedCount, nothing.reasonCode], [null, true, 2, 'NEW_TASK_JEV']);
  assert.equal(typeof nothing.decisionId, 'string', 'the run is recorded even when there is nothing to say');
  assert.deepEqual(core.explainDecision(await engine.lookup(nothing.decisionId)).includes('Advice shown: none.'), true);
});

test('below 0.6 confidence is not used; a partly sure answer is partial; an answer with nothing usable is no answer', async (t) => {
  let script = ANSWER('bugfix', 'scope', 0.5);
  const { engine } = await setup(t, (id, q, body) => script(id, q, body));
  const low = await provider.adviseNewTask(engine, 'Change the way invoices are rounded for a customer', ASK);
  assert.deepEqual([low.text, low.reasonCode, low.usedCount, low.asked], [null, 'NEW_TASK_JEV_LOW_CONFIDENCE', 0, true]);
  script = (id) => (id === 'family' ? { choice: 'refactor', confidence: 0.85 } : { choice: 'target', confidence: 0.4 });
  const partial = await provider.adviseNewTask(engine, 'Split the large billing module into smaller modules', ASK);
  assert.deepEqual([partial.text, partial.reasonCode, partial.usedCount, partial.family, partial.open], ['Jevris: This looks like a refactor task.', 'NEW_TASK_JEV_PARTIAL', 1, 'refactor', null]);
  const empty = { providerConfigured: true, sourceEgress: () => 'approved', decide: async () => ({ abstained: false, decisionId: 'd-00000000-0000-4000-8000-000000000002', result: { answers: {} }, automation: true, rulesOnly: false }), lookup: async () => null };
  const none = await provider.adviseNewTask(empty, REQUEST, ASK);
  assert.deepEqual([none.text, none.reasonCode, none.decisionId], [null, 'NEW_TASK_JEV_NO_ANSWER', null], 'an engine that cannot record still advises');
});

test('the same request is answered from the decision cache with no second call; another request is another question', async (t) => {
  const { engine, requests } = await setup(t, ANSWER('docs', 'scope'));
  const first = await provider.adviseNewTask(engine, 'Correct the typos in the installation guide', ASK);
  assert.equal(first.cacheHit, false);
  const again = await provider.adviseNewTask(engine, 'Correct the typos in the installation guide', { ...ASK, evidenceRevision: 'rev-2' });
  assert.deepEqual([again.cacheHit, again.text], [true, first.text]);
  assert.equal(requests.length, 1, 'a cache hit makes no second call');
  assert.notEqual(again.decisionId, first.decisionId, 'each run is its own record');
  assert.ok((await engine.lookup(again.decisionId)).reasonCodes.includes('JEV_CACHE_HIT'));
  const other = await provider.adviseNewTask(engine, 'Correct the typos in the upgrade guide', ASK);
  assert.equal(other.cacheHit, false);
  assert.equal(requests.length, 2);
});

// ------------------------------------------------------------------ every miss

test('each gate keeps nothing to say with its reason: no request and no record', async (t) => {
  const { engine, requests } = await setup(t, ANSWER('bugfix', 'scope'));
  const cases = [
    ['kill switch', { killSwitchStopped: true }, engine, REQUEST, 'NEW_TASK_KILL_SWITCH'],
    ['mode off', { mode: 'off' }, engine, REQUEST, 'NEW_TASK_MODE_OFF'],
    ['jev.assist off', { assist: 'off' }, engine, REQUEST, 'NEW_TASK_ASSIST_OFF'],
    ['no engine', {}, null, REQUEST, 'NEW_TASK_NO_PROVIDER'],
    ['no provider configured', {}, { providerConfigured: false, sourceEgress: () => 'approved' }, REQUEST, 'NEW_TASK_NO_PROVIDER'],
    ['a short prompt', {}, engine, 'fix it', 'NEW_TASK_TOO_SHORT'],
    ['no time', { deadlineMs: 100 }, engine, REQUEST, 'NEW_TASK_NO_TIME'],
  ];
  for (const [label, extra, who, text, code] of cases) {
    const advice = await provider.adviseNewTask(who, text, { ...ASK, ...extra });
    assert.deepEqual([advice.text, advice.reasonCode, advice.asked, advice.decisionId], [null, code, false, null], label);
  }
  assert.equal(requests.length, 0);
});

test('a Jev error, an open circuit, an exhausted budget and a late answer say nothing, with the reason in the code', async () => {
  const stub = (reasonCode) => ({ providerConfigured: true, sourceEgress: () => 'approved', decide: async () => ({ abstained: true, reasonCode, decisionId: 'd-00000000-0000-4000-8000-000000000001', fallback: 'rules-only' }), lookup: async () => null });
  // An open circuit and an exhausted budget are refused on this machine before anything is sent, so Jev was not asked;
  // a deadline or an error is a request that went out.
  for (const [reason, expected, asked] of [['CIRCUIT_OPEN', 'NEW_TASK_JEV_CIRCUIT_OPEN', false], ['BUDGET', 'NEW_TASK_JEV_BUDGET', false], ['BUDGET_WORKSPACE_CAP', 'NEW_TASK_JEV_BUDGET_WORKSPACE_CAP', false], ['DEADLINE', 'NEW_TASK_JEV_DEADLINE', true]]) {
    const advice = await provider.adviseNewTask(stub(reason), REQUEST, ASK);
    assert.deepEqual([advice.text, advice.reasonCode, advice.asked], [null, expected, asked], reason);
  }
  const throwing = { providerConfigured: true, sourceEgress: () => 'approved', decide: async () => { throw new Error('boom'); }, lookup: async () => null };
  assert.equal((await provider.adviseNewTask(throwing, REQUEST, ASK)).reasonCode, 'NEW_TASK_ERROR');
});

test('a slow Jev is abandoned at the deadline with nothing to say; the late answer only warms the cache', async (t) => {
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  const { engine, requests, script } = await setup(t, ANSWER('bugfix', 'scope'), { gate });
  const late = await provider.adviseNewTask(engine, REQUEST, { ...ASK, deadlineMs: 150, lateGraceMs: 60_000 });
  assert.deepEqual([late.text, late.reasonCode, late.asked], [null, 'NEW_TASK_DEADLINE', true], 'the caller did not wait for Jev');
  assert.equal(requests.length, 1);
  assert.equal(script.finishedCount(), 0);
  open();
  await until(() => script.finishedCount() === 1);
  // The engine puts the late answer in the decision cache just after the response: wait for the entry, not for a fixed time.
  await until(() => engine.cache.stats().entries === 1);
  const warm = await provider.adviseNewTask(engine, REQUEST, ASK);
  assert.deepEqual([warm.cacheHit, warm.family], [true, 'bugfix']);
  assert.equal(requests.length, 1, 'and cost no second call');
});

// ------------------------------------------------------------------ explain

test('jevris explain renders the advisory decision: the request was read once with egress approved, what was asked, the evidence, and that it never blocks', async (t) => {
  const { home, engine } = await setup(t, ANSWER('bugfix', 'edge-cases'));
  const advice = await provider.adviseNewTask(engine, REQUEST, ASK);
  const text = core.explainDecision(await engine.lookup(advice.decisionId));
  assert.match(text, /New task: Jev read the request once, with source egress approved, after the hook had answered; any advice waits for the next event\. The request itself was not changed\./);
  assert.match(text, /Family: looks like a bugfix task\. Open question: what should happen in the cases the request does not mention\./);
  assert.match(text, /Advice shown: one question before implementing\./);
  assert.match(text, /Jev was asked 2 questions and 2 answers cleared the confidence bar \(asked Jev, \d+ ms\)\./);
  assert.match(text, /Reason: NEW_TASK_JEV\./);
  assert.match(text, /Evidence: request, fixed-templates \(one screened span of the request; the question text and options are fixed and carry no user text\)\./);
  assert.match(text, /It never blocks the request and changes no permission\./);
  assert.equal(text.includes('zebra'), false, 'the request text is not in the explanation');
  // The engine's own record of the Jev call shares the spec id and is also advisory; it is explained as a provider call.
  assert.equal(typeof advice.jevDecisionId, 'string');
  assert.doesNotMatch(core.explainDecision(await engine.lookup(advice.jevDecisionId)), /New task: Jev read the request once|Advice shown:/);
  const request = { op: 'explain', client: 'cli', scopes: ['status', 'advice'], workspace: { id: IDS.workspaceId, root: null }, body: { decisionId: advice.decisionId }, home, signal: new AbortController().signal, deadline: createDeadline(2000), store: undefined, killSwitchStopped: false, engine, trace() {}, mode: 'advise' };
  const out = await ops.explain.handle(request);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(contracts.surfacePayloadContract('explain').validate(out.body).ok, true, JSON.stringify(out.body));
  assert.match(JSON.stringify(out.body), /New task: Jev read the request once/);
});

// ------------------------------------------------------------------ the hook path

let n = 0;
function harnessEvent(kind, { toolName = null, session = 'sess-1' } = {}) {
  n += 1;
  return { schemaVersion: '1.0', harness: 'claude', nativeEventName: 'Hook', kind, sessionId: session, turnId: null, toolUseId: `tu-${n}`, toolName, agentId: null, model: null, permissionMode: null, cwd: null, trigger: null, blocking: true, responseRequired: false, payload: {}, dedupKey: sha(`task-event-${n}`) };
}

function promptCtx({ objective = REQUEST, task, engine, mode = 'bounded-auto', jevAssist = 'classify', killSwitchStopped = false, session, kind = 'task.requested', showsExplain, revision = 'rev-1' } = {}) {
  const body = { envelope: harnessEvent(kind, { session }), deliveryKey: `k-${n}`, revision, taskId: 'task-1' };
  if (kind === 'task.requested') body.task = task === undefined ? { objective } : task;
  if (showsExplain !== undefined) body.showsExplain = showsExplain;
  return { op: 'event', client: 'hook', scopes: ['observe'], workspace: { id: 'w-hook', root: '/nowhere' }, body, home: '/nonexistent-home', signal: new AbortController().signal, deadline: { remainingMs: () => 500, expired: () => false }, store: null, killSwitchStopped, engine, mode, jevAssist, trace: () => {} };
}

function liveSubscriber({ deadlineMs = 30_000, lateGraceMs, handlers } = {}) {
  const store = new provider.PendingAdviceStore();
  const background = [];
  const traces = [];
  const handler = provider.createNewTaskHandler({ store, background: (work) => background.push(work), deadlineMs, ...(lateGraceMs === undefined ? {} : { lateGraceMs }) });
  const subscriber = provider.createDecisionSubscriber({ handlers: handlers ?? { 'new-task': [handler] }, certifications: provider.recordsCertificationSource(async () => []), now: () => Date.parse('2026-10-03T10:00:00Z'), operatingSystem: 'linux', pending: store });
  const send = (ctx) => subscriber.handle({ ...ctx, trace: (entry) => traces.push(entry) });
  return { send, store, background, traces };
}

test('egress denied on the hook path: no request, no detached run, nothing queued, and the answer is exactly what it was without this adviser', async (t) => {
  const { engine, requests } = await setup(t, ANSWER('bugfix', 'scope'), { sourceEgress: DENIED });
  const live = liveSubscriber();
  const before = liveSubscriber({ handlers: { 'new-task': [provider.newTaskIntent] } });
  const answer = await live.send(promptCtx({ engine }));
  const as = await before.send(promptCtx({ engine }));
  assert.deepEqual({ ...answer, decisionIds: [] }, { ...as, decisionIds: [] }, 'the same result as with only the older handler');
  assert.deepEqual([answer.hookOutcome, answer.reasonCode], [{ kind: 'observe' }, 'NO_PROPOSAL']);
  assert.equal(live.background.length, 0, 'nothing runs after the hook');
  assert.equal(live.store.count('w-hook', 'sess-1'), 0, 'and nothing waits');
  assert.equal(requests.length, 0);
  assert.equal(live.traces.find((x) => x.event === 'new-task-advice').reasonCode, 'EGRESS_NOT_APPROVED', 'the reason is traced');
  // The next event of the session has nothing to deliver.
  assert.equal((await live.send(promptCtx({ engine, kind: 'tool.proposed' }))).hookOutcome.kind, 'observe');
});

test('egress approved on the hook path: the hook answers at once, the question runs after it, and the line reaches the next event once', async (t) => {
  const { engine, requests } = await setup(t, ANSWER('bugfix', 'target'));
  const live = liveSubscriber();
  const task = { objective: REQUEST };
  const answer = await live.send(promptCtx({ engine, task }));
  assert.deepEqual([answer.hookOutcome, answer.reasonCode], [{ kind: 'observe' }, 'NO_PROPOSAL'], 'the prompt itself is answered as before: nothing is blocked and nothing rewritten');
  assert.equal(live.background.length, 1, 'the adviser runs detached');
  assert.deepEqual(task, { objective: REQUEST }, 'the request is untouched');
  await Promise.all(live.background);
  assert.equal(requests.length, 1);
  assert.equal(live.store.count('w-hook', 'sess-1'), 1);
  const shown = await live.send(promptCtx({ engine, kind: 'tool.proposed' }));
  assert.deepEqual([shown.hookOutcome.kind, shown.reasonCode], ['explain', 'PENDING_ADVICE_DELIVERED']);
  assert.equal(shown.hookOutcome.text, 'Jevris: one question before implementing: which file, component or interface should change? (This looks like a bugfix task.)');
  assert.equal(shown.decisionIds.length, 1, 'the advisory decision is named in the answer');
  assert.equal((await engine.lookup(shown.decisionIds[0])).specId, 'new-task');
  assert.equal(live.store.count('w-hook', 'sess-1'), 0);
  assert.equal((await live.send(promptCtx({ engine, kind: 'tool.finished' }))).hookOutcome.kind, 'observe', 'shown once');
  // Advice fires once per task and workspace revision, as the trigger filter always coalesced a task's prompts.
  const same = await live.send(promptCtx({ engine, objective: 'Add a CSV export to the invoices page for admins' }));
  assert.deepEqual([same.reasonCode, live.background.length], ['COALESCED', 1], 'the same task at the same revision is coalesced: no second run');
  // A newer prompt at a newer revision replaces an older line that was never shown.
  await live.send(promptCtx({ engine, objective: 'Add a CSV export to the invoices page for admins', revision: 'rev-2' }));
  await Promise.all(live.background);
  await live.send(promptCtx({ engine, objective: 'Rename the billing module and update every import of it', revision: 'rev-3' }));
  await Promise.all(live.background);
  assert.equal(live.background.length, 3);
  assert.equal(live.store.count('w-hook', 'sess-1'), 1, 'one line per kind per session');
});

test('the hook answers at once whether or not the provider ever answers: the question is abandoned at its own deadline with nothing queued', async (t) => {
  const { engine, requests } = await setup(t, () => null, { hang: true });
  const live = liveSubscriber({ deadlineMs: 1_000, lateGraceMs: 50 });
  const answer = await live.send(promptCtx({ engine }));
  assert.equal(answer.hookOutcome.kind, 'observe', 'the hook was answered before the provider did anything');
  assert.equal(live.background.length, 1);
  assert.equal(live.store.count('w-hook', 'sess-1'), 0);
  await Promise.all(live.background);
  assert.equal(requests.length, 1, 'one request, never answered');
  assert.equal(live.traces.findLast((x) => x.event === 'new-task-advice').reasonCode, 'NEW_TASK_DEADLINE');
  assert.equal(live.store.count('w-hook', 'sess-1'), 0, 'nothing to show');
});

test('each gate on the hook path: no detached run and no request', async (t) => {
  const { engine, requests } = await setup(t, ANSWER('bugfix', 'scope'));
  const cases = [
    ['jev.assist off', { jevAssist: 'off' }, 'NEW_TASK_ASSIST_OFF'],
    ['no provider', { engine: undefined }, 'NEW_TASK_NO_PROVIDER'],
    ['a short prompt', { objective: 'fix it' }, 'NEW_TASK_TOO_SHORT'],
  ];
  for (const [label, extra, code] of cases) {
    const live = liveSubscriber();
    await live.send(promptCtx({ engine, ...extra }));
    assert.equal(live.background.length, 0, label);
    assert.equal(live.traces.find((x) => x.event === 'new-task-advice').reasonCode, code, label);
  }
  // No prompt text, a blank one and a non-string one give nothing to read.
  for (const task of [undefined, {}, { objective: '   ' }, { objective: 7 }, null]) {
    const live = liveSubscriber();
    await live.send(promptCtx({ engine, task: task === undefined ? {} : task }));
    assert.equal(live.background.length, 0, JSON.stringify(task));
    assert.equal(live.traces.some((x) => x.event === 'new-task-advice'), false, 'no objective: the handler is silent');
  }
  // A stopped kill switch and mode off never reach the handler.
  const stopped = await liveSubscriber().send(promptCtx({ engine, killSwitchStopped: true }));
  assert.deepEqual([stopped.hookOutcome.kind, stopped.reasonCode], ['observe', 'KILL_SWITCH']);
  const off = await liveSubscriber().send(promptCtx({ engine, mode: 'off' }));
  assert.deepEqual([off.hookOutcome.kind, off.reasonCode], ['observe', 'MODE_OFF']);
  assert.equal(requests.length, 0);
});

test('a kill switch stopped after the hook answered stops the detached question before any request', async (t) => {
  const { engine, requests } = await setup(t, ANSWER('bugfix', 'scope'));
  const live = liveSubscriber();
  const answer = await live.send({ ...promptCtx({ engine }), killSwitchNow: async () => true });
  assert.equal(answer.hookOutcome.kind, 'observe');
  await Promise.all(live.background);
  assert.equal(requests.length, 0);
  assert.equal(live.store.count('w-hook', 'sess-1'), 0);
  assert.equal(live.traces.findLast((x) => x.event === 'new-task-advice').reasonCode, 'NEW_TASK_KILL_SWITCH');
});

test('observe mode asks and records the counterfactual and shows nothing', async (t) => {
  const { engine, requests } = await setup(t, ANSWER('bugfix', 'scope'));
  const live = liveSubscriber();
  const answer = await live.send(promptCtx({ engine, mode: 'observe' }));
  assert.equal(answer.hookOutcome.kind, 'observe');
  await Promise.all(live.background);
  assert.equal(requests.length, 1, 'the question was asked and recorded');
  assert.equal(live.store.count('w-hook', 'sess-1'), 0, 'but nothing is queued to be shown');
  assert.equal(typeof live.traces.findLast((x) => x.event === 'new-task-advice').decisionId, 'string');
});

test('the default trigger handlers carry both advisers, the live one first, and the older new-task handler stays', () => {
  assert.deepEqual(provider.DEFAULT_TRIGGER_HANDLERS['new-task'], [provider.newTaskAdvice, provider.newTaskIntent]);
  assert.deepEqual(provider.DEFAULT_TRIGGER_HANDLERS['repeated-failure'].slice(0, 1), [provider.repeatedFailureAdvice]);
  assert.ok(provider.DEFAULT_TRIGGER_HANDLERS['repeated-failure'].includes(provider.evidenceAdvice));
});

test('a caller that brings its own questions (explicit unknowns or workflow templates) is served by the older handler alone: the live adviser makes no request of its own', async (t) => {
  const { engine, requests } = await setup(t, ANSWER('bugfix', 'scope'));
  const unknowns = [{ id: 'u1', topic: 'Should totals round per line or per order', options: ['per line', 'per order'], consequence: 'the stored invoice amounts' }];
  const templates = [{ id: 'bugfix-basic', family: 'bugfix', summary: 'Steps for bugfix work', trusted: true, source: 'installed', tags: ['bug'] }];
  for (const task of [{ objective: REQUEST, unknowns }, { objective: REQUEST, templates }]) {
    const live = liveSubscriber();
    const answer = await live.send(promptCtx({ engine, task }));
    assert.deepEqual([answer.hookOutcome, answer.reasonCode], [{ kind: 'observe' }, 'NO_PROPOSAL'], JSON.stringify(Object.keys(task)));
    assert.equal(live.background.length, 0, 'no detached run');
    assert.equal(live.traces.length, 0, 'not even a gate to trace: the older handler owns this body');
  }
  assert.equal(requests.length, 0);
  // Empty lists are no question set: the prompt alone is read.
  const live = liveSubscriber();
  await live.send(promptCtx({ engine, task: { objective: REQUEST, unknowns: [], templates: [] } }));
  assert.equal(live.background.length, 1, 'an empty list leaves the prompt to the live adviser');
  await Promise.all(live.background);
});

// ------------------------------------------------------------------ C01 on the older path

test('C01 triage: the request goes only as one evidence span, never in the objective; with egress denied it abstains', async (t) => {
  const TEMPLATES = [
    { id: 'bugfix-basic', family: 'bugfix', summary: 'Steps for bugfix work', trusted: true, source: 'installed', tags: ['bug'] },
    { id: 'docs-page', family: 'docs', summary: 'Steps for docs work', trusted: true, source: 'installed', tags: ['docs'] },
  ];
  const CTX = { workspaceId: 'w-c01', evidenceRevision: 'rev-1', taskId: 'task-1', deadlineMs: 30_000 };
  const approved = await setup(t, (id) => (id === 'taskFamily' ? { choice: 'f0', confidence: 0.8 } : null), { sourceEgress: APPROVED });
  const selected = await core.triageTaskFamily(approved.engine, { objective: REQUEST, templates: TEMPLATES }, CTX);
  assert.deepEqual([selected.outcome, selected.family, selected.originalRequest], ['selected', 'bugfix', REQUEST]);
  const body = approved.requests[0];
  assert.equal(body.state.objective.includes('zebra'), false, 'the packet objective is fixed text');
  assert.deepEqual(body.state.untrustedEvidence.map((e) => [e.text, e.source]), [[REQUEST, 'user']]);
  assert.equal(JSON.stringify(body).split('zebra').length - 1, 1, 'the request appears once, as the span');
  const denied = await setup(t, () => null, { sourceEgress: DENIED });
  const out = await core.triageTaskFamily(denied.engine, { objective: REQUEST, templates: TEMPLATES }, CTX);
  assert.deepEqual([out.outcome, out.reasonCode, out.family, out.originalRequest], ['abstain', 'EGRESS_NOT_APPROVED', null, REQUEST]);
  assert.equal(denied.requests.length, 0, 'the request never leaves with egress denied');
});
