// OD-8, for explain: a main-session turn that named a model is recorded once per (session,
// message) as advice with no provider call; the reason codes carry the harness, the mode, the
// session's link and whether the turn was switched (agreed with E). Explain shows the session's
// mode and link for such a record (null link when the session was not linked), and neither for
// any other decision.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');
const contracts = await import('@jevris/contracts');
const store = await import('@jevris/store');
const { createDeadline } = await import('@jevris/platform');
const { BUNDLED_MODEL_REGISTRY: R, DecisionBudget, createDecisionEngine, emptyLearningState, learningSliceKey, saveLearningState } = core;

const WS = 'wTurn';
const SLICE = 'bounded-edit';
const OPEN = { taskId: 'task-1', risk: 'low', sliceId: SLICE, turnActuation: 'bounded-auto', turnReasonCode: null };
const CURRENT = { providerID: 'anthropic', modelID: 'claude-opus-5-5' };
const ops = Object.fromEntries(provider.sidecarOps.map((def) => [def.op, def]));

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-turn-record-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A home whose workspace learning has the slice promoted to claude-sonnet-5 over the session's model. */
async function promotedHome(dir) {
  const home = join(dir, 'home');
  const at = new Date().toISOString();
  const state = emptyLearningState({ workspaceId: WS, now: at });
  const key = learningSliceKey(SLICE, 'claude-opus-5-5', R);
  const last = state.versions[state.versions.length - 1];
  const version = { version: last.version + 1, parentVersion: last.version, createdAt: at, reason: 'promotion', reasonCode: 'PROMOTED', sliceId: key, slices: { ...last.slices, [key]: { mode: 'auto', modelId: 'claude-sonnet-5', baselineModelId: 'claude-opus-5-5', baselineRate: 0.9 } }, evidence: null };
  assert.deepEqual(await saveLearningState(home, { ...state, versions: [...state.versions, version] }), { ok: true });
  return home;
}

function engine(dir) {
  return createDecisionEngine({ transport: null, journalDir: join(dir, 'decisions'), budget: DecisionBudget.open(join(dir, 'budget.json'), { limitMicroUsd: 1_000_000 }) });
}

function openWorkspace(t, dir) {
  const opened = store.openStore({ path: join(dir, 'jevris.db'), role: 'sidecar', workspaceId: 'host', hostScope: 'hostA', fsKind: () => ({ kind: 'local', label: 't' }) });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  t.after(() => store.closeStore(opened));
  return store.workspaceView(opened, WS);
}

function ctx(op, home, body, e, ws, traces = []) {
  return {
    op, client: op === 'route.turn' ? 'hook' : 'cli', scopes: ['status', 'advice', 'checkpoint'], workspace: { id: WS, root: null }, body, home,
    signal: new AbortController().signal, deadline: createDeadline(900), store: ws, killSwitchStopped: false, engine: e, trace: (event) => traces.push(event),
  };
}

/** The decisions the engine journaled for route-turn, oldest first. */
async function turnRecords(e, ids) {
  const out = [];
  for (const id of ids) out.push((await e.entry(id)).record);
  return out;
}

function recordedIds(traces) {
  return traces.filter((event) => event.event === 'route.turn.recorded').map((event) => event.reasonCode);
}

test('OD-8: a switched turn is recorded once per message, with its harness, mode, link and switch as reason codes', async (t) => {
  const dir = temp(t);
  const home = await promotedHome(dir);
  const e = engine(dir);
  const ws = openWorkspace(t, dir);
  store.recordSession(ws, { sessionId: 'ses_linked', harness: 'opencode', state: 'active', atMs: 1_000 });
  const linked = store.linkSession(ws, { sessionId: 'ses_linked', harness: 'opencode', taskId: 'task-1', via: 'route', actor: 'cli', channel: 'terminal', atMs: 2_000 });
  assert.equal(linked.ok, true, JSON.stringify(linked));
  const seen = [];
  const recordAdvice = e.recordAdvice.bind(e);
  e.recordAdvice = async (input) => {
    const recorded = await recordAdvice(input);
    if (recorded.ok) seen.push(recorded.decisionId);
    return recorded;
  };
  const op = provider.createRouteTurnOp(() => ({ scope: OPEN, mainSession: 'plugin-bounded-auto' }));
  const traces = [];
  const body = { harness: 'opencode', sessionId: 'ses_linked', messageId: 'msg_1', current: CURRENT };
  const first = await op.handle(ctx('route.turn', home, body, e, ws, traces));
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual([first.body.outcome, first.body.actuate, first.body.reasonCode], ['switch', true, 'PROMOTED_SAVING']);
  // The same message asked again records nothing more; the next message records again.
  await op.handle(ctx('route.turn', home, body, e, ws, traces));
  await op.handle(ctx('route.turn', home, { ...body, messageId: 'msg_2' }, e, ws, traces));
  assert.deepEqual(recordedIds(traces), ['RECORDED', 'RECORDED']);
  assert.equal(seen.length, 2);
  const [record] = await turnRecords(e, seen);
  assert.equal(contracts.DecisionRecordContract.validate(record).ok, true, JSON.stringify(record));
  assert.deepEqual([record.specId, record.outcome, record.sessionId, record.taskId, record.providerCalls], ['route-turn', 'advisory', 'ses_linked', 'task-1', 0]);
  assert.deepEqual(record.proposedAction, { kind: 'advise', templateId: 'route-turn', evidenceIds: [] });
  assert.deepEqual(record.reasonCodes, ['PROMOTED_SAVING', 'TURN_HARNESS_OPENCODE', 'TURN_MODE_PLUGIN_BOUNDED_AUTO', 'TURN_LINK_ROUTE', 'TURN_SWITCHED', 'DECISION_ADVISORY']);
  assert.deepEqual(provider.turnMainSessionOf(record), { harness: 'opencode', mode: 'plugin-bounded-auto', switched: true, reasonCode: null });

  // Explain shows the link the turn was decided under.
  const explained = await ops.explain.handle(ctx('explain', home, { decisionId: seen[0] }, e, ws));
  assert.equal(explained.ok, true, JSON.stringify(explained));
  assert.equal(contracts.surfacePayloadContract('explain').validate(explained.body).ok, true);
  assert.deepEqual(explained.body.trace.sessionLink, { harness: 'opencode', sessionId: 'ses_linked', taskId: 'task-1', linkedAtMs: 2_000, via: 'route' });
  assert.deepEqual(explained.body.trace.mainSession, { harness: 'opencode', mode: 'plugin-bounded-auto', switched: true, reasonCode: null });
  // Serving hosts R55: the hosts as the turn saw them (a same-maker route through the maker, kept).
  assert.deepEqual(explained.body.trace.serving, {
    spelling: 'anthropic/claude-opus-5-5', provider: 'anthropic', modelId: 'claude-opus-5-5', servingHost: 'anthropic', via: 'maker',
    targetSpelling: 'anthropic/claude-sonnet-5', targetProvider: 'anthropic', targetModelId: 'claude-sonnet-5', targetServingHost: 'anthropic', targetVia: 'maker',
    hostDecision: 'kept', hostReasonCode: null, seenHosts: [], tariffBasis: 'host', tariffSource: null, consent: { host: null, maker: 'signed-in-default' },
  });

  // Once the session ends its link is gone from the store, so explain claims nothing either way.
  store.recordSession(ws, { sessionId: 'ses_linked', harness: 'opencode', state: 'ended', atMs: 3_000 });
  const later = await ops.explain.handle(ctx('explain', home, { decisionId: seen[0] }, e, ws));
  assert.equal(Object.hasOwn(later.body.trace, 'sessionLink'), false);
});

test('OD-8: a promoted model given as advice is recorded as advice; an unlinked session reads null; an abstention records nothing', async (t) => {
  const dir = temp(t);
  const home = await promotedHome(dir);
  const e = engine(dir);
  const ws = openWorkspace(t, dir);
  store.recordSession(ws, { sessionId: 'ses_free', harness: 'kilocode', state: 'active', atMs: 1_000 });
  const ids = [];
  const recordAdvice = e.recordAdvice.bind(e);
  e.recordAdvice = async (input) => {
    const recorded = await recordAdvice(input);
    if (recorded.ok) ids.push(recorded.decisionId);
    return recorded;
  };
  const advice = provider.createRouteTurnOp(() => ({ scope: { ...OPEN, turnActuation: 'advise', turnReasonCode: 'SESSION_NOT_LINKED' }, mainSession: 'plugin-bounded-auto' }));
  const answer = await advice.handle(ctx('route.turn', home, { harness: 'kilocode', sessionId: 'ses_free', messageId: 'msg_1', current: CURRENT }, e, ws));
  assert.deepEqual([answer.body.outcome, answer.body.actuate, answer.body.reasonCode], ['switch', false, 'SESSION_NOT_LINKED']);
  assert.equal(ids.length, 1);
  const [record] = await turnRecords(e, ids);
  assert.deepEqual(record.reasonCodes, ['SESSION_NOT_LINKED', 'TURN_HARNESS_KILOCODE', 'TURN_MODE_PLUGIN_BOUNDED_AUTO', 'TURN_UNLINKED', 'TURN_ADVICE', 'DECISION_ADVISORY']);
  assert.deepEqual(provider.turnMainSessionOf(record), { harness: 'kilocode', mode: 'plugin-bounded-auto', switched: false, reasonCode: 'SESSION_NOT_LINKED' });
  const explained = await ops.explain.handle(ctx('explain', home, { decisionId: ids[0] }, e, ws));
  assert.equal(contracts.surfacePayloadContract('explain').validate(explained.body).ok, true);
  assert.equal(explained.body.trace.sessionLink, null);
  assert.deepEqual(explained.body.trace.mainSession, { harness: 'kilocode', mode: 'plugin-bounded-auto', switched: false, reasonCode: 'SESSION_NOT_LINKED' });

  // Under advice-only the mode code says so.
  const adviceOnly = provider.createRouteTurnOp(() => ({ scope: OPEN, mainSession: 'advice-only' }));
  await adviceOnly.handle(ctx('route.turn', home, { harness: 'kilocode', sessionId: 'ses_free', messageId: 'msg_2', current: CURRENT }, e, ws));
  const [, second] = await turnRecords(e, ids);
  assert.ok(second.reasonCodes.includes('TURN_MODE_ADVICE_ONLY') && second.reasonCodes.includes('TURN_ADVICE'));
  assert.equal(provider.turnMainSessionOf(second).reasonCode, 'MAIN_SESSION_ADVICE_ONLY');

  // No promotion for this model: the turn abstains and nothing is recorded.
  await advice.handle(ctx('route.turn', home, { harness: 'kilocode', sessionId: 'ses_free', messageId: 'msg_3', current: { providerID: 'anthropic', modelID: 'claude-sonnet-5' } }, e, ws));
  assert.equal(ids.length, 2);
});

test('OD-8: with no store the record claims no link, and explain leaves sessionLink absent; other decisions have no turn trace', async (t) => {
  const dir = temp(t);
  const home = await promotedHome(dir);
  const e = engine(dir);
  const ids = [];
  const recordAdvice = e.recordAdvice.bind(e);
  e.recordAdvice = async (input) => {
    const recorded = await recordAdvice(input);
    if (recorded.ok) ids.push(recorded.decisionId);
    return recorded;
  };
  const op = provider.createRouteTurnOp(() => ({ scope: OPEN, mainSession: 'plugin-bounded-auto' }));
  // No message id: the switch target stands in, so a repeat for the same target records once.
  const body = { harness: 'opencode', sessionId: 'ses_nostore', current: CURRENT };
  await op.handle(ctx('route.turn', home, body, e, undefined));
  await op.handle(ctx('route.turn', home, body, e, undefined));
  assert.equal(ids.length, 1);
  const [record] = await turnRecords(e, ids);
  assert.deepEqual(record.reasonCodes, ['PROMOTED_SAVING', 'TURN_HARNESS_OPENCODE', 'TURN_MODE_PLUGIN_BOUNDED_AUTO', 'TURN_SWITCHED', 'DECISION_ADVISORY']);
  const explained = await ops.explain.handle(ctx('explain', home, { decisionId: ids[0] }, e, undefined));
  assert.equal(Object.hasOwn(explained.body.trace, 'sessionLink'), false);
  assert.deepEqual(explained.body.trace.mainSession, { harness: 'opencode', mode: 'plugin-bounded-auto', switched: true, reasonCode: null });

  // A decision that is not a turn has neither.
  const other = await e.recordAdvice({ specId: 'main-route', workspaceId: WS, evidenceRevision: 'rev-1', action: { kind: 'advise', templateId: 'main-route', evidenceIds: [] }, reasonCodes: ['TURN_SWITCHED'] });
  const otherRecord = (await e.entry(other.decisionId)).record;
  assert.equal(provider.turnMainSessionOf(otherRecord), null);
  assert.equal(await provider.turnSessionLinkOf(undefined, otherRecord), undefined);
  const plain = await ops.explain.handle(ctx('explain', home, { decisionId: other.decisionId }, e, undefined));
  assert.equal(contracts.surfacePayloadContract('explain').validate(plain.body).ok, true);
  assert.deepEqual([Object.hasOwn(plain.body.trace, 'mainSession'), Object.hasOwn(plain.body.trace, 'sessionLink')], [false, false]);
});
