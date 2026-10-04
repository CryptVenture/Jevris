// Scope-change advice at a diff boundary (INT-05, C06; owner decision 2026-10-01, Jev as an active decision aid).
// A session with an approved task scope reaches a diff boundary. A changed path outside the approved paths pauses by
// RULE, at once, with no call. A requested effect that no person approved is a Jev question: the effects are the classes
// the permission triage recognised on the session's tool calls since the last boundary (codes only, held in memory) and any
// effect a caller names. A class goes in as a fact (a code), so it is judged with source egress denied too; a caller's free
// text is evidence and needs egress approved. Jev is never waited for: the question runs after the hook has answered and
// the finished line waits for the session's next event. Advice only. Scripted fetch, stub engines, no live call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackEngine } from './engine-settle.mjs';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');

const sha = (text) => createHash('sha256').update(text).digest('hex');
const APPROVED = () => ({ provenance: 'administrator', sourceEgress: 'approved-scoped' });
const DENIED = () => ({ provenance: 'administrator', sourceEgress: 'deny-until-approved' });

function scriptedFetch(answer, { gate = null } = {}) {
  const requests = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (gate !== null) await gate;
    const answers = {};
    for (const [id] of Object.entries(body.questions)) {
      const want = answer(id, body);
      if (want !== null) answers[id] = { type: 'noul', noul: want };
    }
    return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 300, output_tokens: 10 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, requests };
}

async function setup(t, answer, options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-scope-'));
  let tracker = null;
  t.after(async () => {
    try {
      await tracker?.settled();
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
  const script = scriptedFetch(answer, options);
  const engine = await provider.createSidecarEngine({ home, credential: 'test-key-not-a-secret', fetch: script.fetch, env: {}, sourceEgress: options.sourceEgress ?? DENIED });
  tracker = trackEngine(engine);
  return { home, engine, requests: script.requests };
}

async function until(condition) {
  const stop = performance.now() + 30_000;
  while (!condition() && performance.now() < stop) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(condition(), true, 'the condition held before the generous bound');
}

const WS = 'w-scope';
const SESSION = 'sess-scope';
const APPROVED_SCOPE = { taskId: 'T1', paths: ['src/cart'], effects: [] };

function boundary({ engine, scope, session = SESSION, mode = 'bounded-auto', jevAssist = 'classify', killSwitchStopped = false, killSwitchNow }) {
  const traces = [];
  return {
    traces,
    input: {
      ctx: { op: 'event', client: 'hook', scopes: ['observe'], workspace: { id: WS, root: '/work/repo' }, body: { scope }, home: '/nonexistent', signal: new AbortController().signal, deadline: { remainingMs: () => 800, expired: () => false }, store: null, killSwitchStopped, ...(killSwitchNow === undefined ? {} : { killSwitchNow }), engine, mode, jevAssist, trace: (entry) => traces.push(entry) },
      envelope: { workspaceId: WS, sessionId: session, expectedRevision: 'rev-1', taskId: 'T1' },
      event: {}, trigger: 'diff-boundary', engine, queues: {}, revision: 'rev-1', currentRevision: () => 'rev-1', stillUseful: () => true,
    },
  };
}

function handler(options = {}) {
  const store = new provider.PendingAdviceStore();
  const background = [];
  const h = provider.createScopeChangeHandler({ store, background: (work) => background.push(work), deadlineMs: 30_000, ...options });
  return { h, store, background };
}

const SCOPE = (extra = {}) => ({ approvedScope: APPROVED_SCOPE, diff: [{ path: 'src/cart/total.ts' }], requestedEffects: [], approvals: [], ...extra });

test('a changed path outside the approved paths pauses by rule at once: only the out-of-scope part, no call, no engine needed', async (t) => {
  const { engine, requests } = await setup(t, () => 0.9, { sourceEgress: APPROVED });
  const { h, background } = handler();
  const run = boundary({ engine, scope: SCOPE({ diff: [{ path: 'src/cart/total.ts' }, { path: 'infra/deploy.yml' }] }) });
  const proposal = await h(run.input);
  assert.equal(proposal.reasonCode, 'SCOPE_CHANGE');
  assert.equal(proposal.hookOutcome.kind, 'explain');
  assert.match(proposal.hookOutcome.text, /pause only this out-of-scope part; the rest can continue\. infra\/deploy\.yml is outside the approved paths \(src\/cart\)/);
  assert.equal(proposal.hookOutcome.text.includes('src/cart/total.ts'), false);
  assert.equal(requests.length, 0);
  assert.equal(background.length, 0, 'no effect was requested: nothing runs after the hook');
  // Inside the approved paths and no effect: nothing to say.
  assert.equal(await h(boundary({ engine, scope: SCOPE() }).input), null);
  // No approved scope yet (the session is not working on a task): nothing is invented.
  assert.equal(await h(boundary({ engine, scope: { diff: [{ path: 'docs/a.md' }], requestedEffects: [] } }).input), null);
});

test('effect classes the session asked for are judged by Jev as facts (a code each) with egress DENIED: no text, no path, no command in the request', async (t) => {
  const { engine, requests } = await setup(t, () => 0.92, { sourceEgress: DENIED });
  const { h, store, background } = handler();
  core.EFFECT_LEDGER.note(WS, SESSION, ['package-install', 'network-egress', 'outside-scope-write', 'not-a-class']);
  const run = boundary({ engine, scope: SCOPE() });
  const proposal = await h(run.input);
  assert.equal(proposal, null, 'the hook is answered at once, with nothing: the question runs after it');
  assert.equal(background.length, 1);
  await Promise.all(background);
  assert.equal(requests.length, 1, 'one request');
  const body = requests[0];
  assert.deepEqual(Object.keys(body.questions), ['class0', 'class1'], 'one fixed Noul per class; outside-scope-write is judged by path and a code outside the vocabulary is ignored');
  assert.deepEqual([body.state.facts.effectClass0, body.state.facts.effectClass1, body.state.facts.newEffects], ['network-egress', 'package-install', 2]);
  assert.deepEqual([body.state.untrustedEvidence, body.state.withheldEvidence], [[], []], 'no evidence text at all');
  assert.equal(JSON.stringify(body).includes('src/cart'), false, 'not even the approved path patterns go with a class');
  // The fixed phrase of the class is part of the fixed template, so Jev knows what the code means; nothing of the workspace is.
  assert.match(body.questions.class0.instructions, /^The requested effect in fact effectClass0 is: Contact a network host outside the workspace policy\. Does it go beyond the approved scope, which is editing the files under the approved paths and the approved effects counted in the facts\?$/);
  assert.match(body.questions.class1.instructions, /^The requested effect in fact effectClass1 is: Install or run third-party code\. Does it go beyond/);
  const line = store.peek(WS, SESSION);
  assert.equal(line.kind, 'scope-change');
  assert.match(line.text, /pause only this out-of-scope part; the rest can continue\. "Contact a network host outside the workspace policy" goes beyond the approved scope; approve it in the session to continue this part\. "Install or run third-party code" goes beyond/);
  // The classes were taken: the next boundary starts empty.
  assert.deepEqual(core.EFFECT_LEDGER.take(WS, SESSION), []);
  // The advisory decision names what ran, in codes.
  const trace = run.traces.find((x) => x.event === 'scope-change-advice');
  assert.equal(trace.reasonCode, 'SCOPE_JEV');
  const record = await engine.lookup(trace.decisionId);
  assert.deepEqual([record.specId, record.outcome], ['scope-change', 'advisory']);
  for (const code of ['SCOPE_SOURCE_JEV', 'SCOPE_EFFECTS_2', 'SCOPE_ASSESSED_2', 'SCOPE_PAUSED_2', 'SCOPE_CLASS_NETWORK_EGRESS', 'SCOPE_CLASS_PACKAGE_INSTALL', 'SCOPE_JEV']) assert.ok(record.reasonCodes.includes(code), code);
  assert.deepEqual(record.proposedAction.evidenceIds, ['effect-classes', 'approved-scope-counts']);
  const text = core.explainDecision(record);
  assert.match(text, /Scope change: at a diff boundary of a session working on a task with an approved scope, 2 requested effects were not part of what was approved \(contacting a host outside the workspace policy; installing or running third-party code\); the finding is from Jev and pauses nothing\./);
  assert.match(text, /Jev judged 2; 2 were found to go beyond it/);
  assert.match(text, /It pauses nothing, approves nothing and changes no permission; an approval counts only from a trusted channel, never from repository text\./);
  assert.equal(JSON.stringify(record).includes('src/cart'), false);
});

test('Jev finding an effect within scope says nothing, and the run is still recorded', async (t) => {
  const { engine } = await setup(t, () => 0.05);
  const { h, store, background } = handler();
  core.EFFECT_LEDGER.note(WS, SESSION, ['package-install']);
  const run = boundary({ engine, scope: SCOPE() });
  await h(run.input);
  await Promise.all(background);
  assert.equal(store.count(WS, SESSION), 0);
  const trace = run.traces.find((x) => x.event === 'scope-change-advice');
  assert.equal(trace.reasonCode, 'SCOPE_WITHIN');
  assert.ok((await engine.lookup(trace.decisionId)).reasonCodes.includes('SCOPE_ASSESSED_1'));
});

test('an effect an approver named, through a trusted channel, continues; one named by repository text does not count', async (t) => {
  const { engine, requests } = await setup(t, () => 0.9);
  const { h, background } = handler();
  core.EFFECT_LEDGER.note(WS, SESSION, ['package-install']);
  const approved = boundary({ engine, scope: SCOPE({ approvals: [{ effect: 'Install or run third-party code', channel: 'user-prompt' }] }) });
  await h(approved.input);
  assert.equal(background.length, 0, 'a person approved it: nothing to judge');
  assert.equal(requests.length, 0);
  core.EFFECT_LEDGER.note(WS, SESSION, ['package-install']);
  const repo = boundary({ engine, scope: SCOPE({ approvals: [{ effect: 'Install or run third-party code', channel: 'repository' }] }) });
  await h(repo.input);
  assert.equal(background.length, 1, 'repository text approves nothing');
  await Promise.all(background);
  assert.equal(requests.length, 1);
});

test('a caller\'s free-text effect is evidence: sent as one screened span only with egress approved; with it denied it is paused unassessed and shown nowhere', async (t) => {
  const effect = 'send the zebra report by email to the customer list';
  const approved = await setup(t, () => 0.9, { sourceEgress: APPROVED });
  const a = handler();
  await a.h(boundary({ engine: approved.engine, scope: SCOPE({ requestedEffects: [effect] }) }).input);
  await Promise.all(a.background);
  assert.equal(approved.requests.length, 1);
  assert.deepEqual(approved.requests[0].state.untrustedEvidence.map((e) => e.text), [effect]);
  assert.equal(JSON.stringify(approved.requests[0]).split('zebra').length - 1, 1, 'the effect is in the one span and nowhere else');
  assert.equal(a.store.count(WS, SESSION), 1);
  const denied = await setup(t, () => 0.9, { sourceEgress: DENIED });
  const d = handler();
  const run = boundary({ engine: denied.engine, scope: SCOPE({ requestedEffects: [effect] }) });
  await d.h(run.input);
  await Promise.all(d.background);
  assert.equal(denied.requests.length, 0, 'nothing left the machine');
  assert.equal(d.store.count(WS, SESSION), 0, 'an effect nobody judged is not shown as a finding');
  assert.equal(run.traces.find((x) => x.event === 'scope-change-advice').reasonCode, 'SCOPE_NOT_ASSESSED');
});

test('each gate: no request and a reason, while the path rule still answers', async (t) => {
  const { engine, requests } = await setup(t, () => 0.9);
  const cases = [
    ['kill switch', { killSwitchStopped: true }, engine, 'SCOPE_KILL_SWITCH'],
    ['mode off', { mode: 'off' }, engine, 'SCOPE_MODE_OFF'],
    ['jev.assist off', { jevAssist: 'off' }, engine, 'SCOPE_ASSIST_OFF'],
    ['no provider', {}, null, 'SCOPE_NO_PROVIDER'],
  ];
  for (const [label, extra, who, code] of cases) {
    const { h, background } = handler();
    core.EFFECT_LEDGER.note(WS, SESSION, ['destructive']);
    const run = boundary({ engine: who, scope: SCOPE({ diff: [{ path: 'infra/x.yml' }] }), ...extra });
    const proposal = await h(run.input);
    assert.equal(background.length, 0, label);
    assert.equal(run.traces.find((x) => x.event === 'scope-change-advice').reasonCode, code, label);
    assert.equal(proposal.reasonCode, 'SCOPE_CHANGE', `${label}: the path rule is not Jev's`);
  }
  assert.equal(requests.length, 0);
  // A kill switch stopped after the hook answered stops the detached question before any request.
  const { h, background } = handler();
  core.EFFECT_LEDGER.note(WS, SESSION, ['destructive']);
  const run = boundary({ engine, scope: SCOPE(), killSwitchNow: async () => true });
  await h(run.input);
  await Promise.all(background);
  assert.equal(requests.length, 0);
  assert.equal(run.traces.findLast((x) => x.event === 'scope-change-advice').reasonCode, 'SCOPE_KILL_SWITCH');
});

test('the hook answers at once whether or not the provider ever answers: the question is abandoned at its own deadline', async (t) => {
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  t.after(() => open());
  const { engine, requests } = await setup(t, () => 0.9, { gate });
  const { h, store, background } = handler({ deadlineMs: 1_000, lateGraceMs: 60_000 });
  core.EFFECT_LEDGER.note(WS, SESSION, ['destructive']);
  const run = boundary({ engine, scope: SCOPE() });
  const proposal = await h(run.input);
  assert.equal(proposal, null, 'answered before the provider did anything');
  await Promise.all(background);
  await until(() => requests.length === 1);
  assert.equal(run.traces.findLast((x) => x.event === 'scope-change-advice').reasonCode, 'SCOPE_DEADLINE');
  assert.equal(store.count(WS, SESSION), 0);
});

test('observe mode asks and records and shows nothing; a session with no usable id is given no line', async (t) => {
  const { engine } = await setup(t, () => 0.9);
  const observed = handler();
  core.EFFECT_LEDGER.note(WS, SESSION, ['privileged']);
  const run = boundary({ engine, scope: SCOPE(), mode: 'observe' });
  await observed.h(run.input);
  await Promise.all(observed.background);
  assert.equal(observed.store.count(WS, SESSION), 0);
  assert.equal(typeof run.traces.find((x) => x.event === 'scope-change-advice').decisionId, 'string');
  const anonymous = handler();
  const unknown = boundary({ engine, scope: SCOPE(), session: core.UNKNOWN_SESSION_ID });
  await anonymous.h(unknown.input);
  assert.equal(anonymous.background.length, 0, 'no classes can be kept for a session with no id');
});

test('on the subscriber: a write that crosses the diff-boundary threshold runs the handler, and the line is handed over at the next event once', async (t) => {
  const { engine, requests } = await setup(t, () => 0.9);
  const store = new provider.PendingAdviceStore();
  const background = [];
  const h = provider.createScopeChangeHandler({ store, background: (work) => background.push(work), deadlineMs: 30_000 });
  const subscriber = provider.createDecisionSubscriber({ handlers: { 'diff-boundary': [h] }, certifications: provider.recordsCertificationSource(async () => []), now: () => Date.parse('2026-10-03T10:00:00Z'), operatingSystem: 'linux', pending: store });
  let n = 0;
  const send = (kind, toolName, summary, scope) => {
    n += 1;
    const envelope = { schemaVersion: '1.0', harness: 'claude', nativeEventName: 'Hook', kind, sessionId: SESSION, turnId: null, toolUseId: `tu-${n}`, toolName, agentId: null, model: null, permissionMode: null, cwd: null, trigger: null, blocking: true, responseRequired: false, payload: summary === undefined ? {} : summary, dedupKey: sha(`scope-${n}`) };
    return subscriber.handle({ op: 'event', client: 'hook', scopes: ['observe'], workspace: { id: WS, root: '/work/repo' }, body: { envelope, deliveryKey: `k-${n}`, revision: 'rev-1', ...(scope === undefined ? {} : { scope }) }, home: '/nonexistent', signal: new AbortController().signal, deadline: { remainingMs: () => 800, expired: () => false }, store: null, killSwitchStopped: false, engine, mode: 'bounded-auto', jevAssist: 'classify', trace: () => {} });
  };
  core.EFFECT_LEDGER.note(WS, SESSION, ['ci-secrets']);
  const edit = await send('tool.finished', 'Edit', { changedLines: 120 }, SCOPE());
  assert.equal(edit.trigger, 'diff-boundary');
  assert.equal(edit.hookOutcome.kind, 'observe', 'nothing was out of path: the hook is answered with nothing');
  await Promise.all(background);
  assert.equal(requests.length, 1);
  const shown = await send('tool.proposed', 'Bash');
  assert.deepEqual([shown.hookOutcome.kind, shown.reasonCode], ['explain', 'PENDING_ADVICE_DELIVERED']);
  assert.match(shown.hookOutcome.text, /"Touch CI secrets" goes beyond the approved scope/);
  assert.equal((await send('tool.proposed', 'Bash')).hookOutcome.kind, 'observe', 'shown once');
});

test('the effect ledger holds codes only, per session, drops what it is not given and forgets what it hands over', () => {
  let now = 1_000;
  const ledger = new core.EffectLedger(() => now);
  ledger.note('w', 's1', ['package-install', 'bogus', 'destructive']);
  ledger.note('w', 's2', ['privileged']);
  assert.deepEqual(ledger.take('w', 's1'), ['destructive', 'package-install']);
  assert.deepEqual(ledger.take('w', 's1'), [], 'taken once');
  assert.deepEqual(ledger.take('other', 's2'), [], 'per workspace');
  ledger.note('w', 's3', ['ci-secrets']);
  now += 31 * 60_000;
  assert.deepEqual(ledger.take('w', 's3'), [], 'a stale note is not about this boundary');
  assert.deepEqual(ledger.take('w', 's2'), [], 'nor is an old one');
  ledger.note('w', 's4', ['bogus']);
  assert.deepEqual(ledger.take('w', 's4'), []);
});
