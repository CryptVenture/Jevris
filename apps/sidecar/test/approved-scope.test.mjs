import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';

// INT-05: the event op gives subscribers the approved scope from the plan (D's approvedScopeFor:
// the active task's write scopes, no effects), replacing whatever the harness claimed; with no
// active task the claim is removed. The approved scope never comes from a hook.

const { startDaemon, sidecarRequest } = await import('../dist/index.js');
const store = await import('@jevris/store');

// A failed request says why (its reason code), not "undefined.recorded" (windows 24, 669d2cf: DEADLINE).
const answered = (response) => {
  assert.equal(response.ok, true, JSON.stringify(response));
  return response;
};

test('subscribers see the plan-approved scope, never the harness claim (INT-05)', { skip: managedHostSkip() }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-scope-')));
  const planned = join(home, 'planned');
  const unplanned = join(home, 'unplanned');
  mkdirSync(planned);
  mkdirSync(unplanned);
  const seen = [];
  const subscribers = [{ name: 'scope', handle: (ctx) => (seen.push(ctx.body.scope), { ok: true }) }];
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, subscribers, log: () => undefined, limits: { budgetMs: { hot: 60_000, background: 60_000 } }, subscriberSliceMs: 60_000 });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    const registered = answered(await sidecarRequest({ home, op: 'workspace.register', scope: 'hook', timeoutMs: 60_000, workspace: planned }));
    const view = started.daemon.state.storeFor({ id: registered.result.id, root: registered.result.root });
    assert.equal(store.createTask(view, { taskId: 'T1', ownerId: 'planner', rootBudgetId: 'budget1', requirementIds: ['REQ-1'], record: { writeScopes: ['src/mod'] }, nowMs: 1 }).ok, true);
    for (const [to, actor] of [['validated', 'planner'], ['ready', 'scheduler'], ['leased', 'scheduler']]) {
      assert.equal(store.transitionTask(view, { taskId: 'T1', to, actor, reasonCode: 'TEST', nowMs: 2 }).ok, true, to);
    }
    const claim = { approvedScope: { paths: ['**'], effects: ['deploy'] }, diff: [{ path: 'infra/prod.tf' }], requestedEffects: ['deploy'] };
    const send = async (root, key, envelope = { kind: 'PostToolUse' }) => answered(await sidecarRequest({ home, op: 'event', scope: 'hook', timeoutMs: 60_000, workspace: root, body: { deliveryKey: key, envelope, scope: claim } }));
    assert.equal((await send(planned, 'scope-1')).result.recorded, true);
    assert.equal((await send(unplanned, 'scope-2')).result.recorded, true);
    assert.deepEqual(
      seen[0].approvedScope,
      { paths: ['src/mod'], effects: [], taskId: 'T1', turnActuation: 'advise', turnReasonCode: 'HARNESS_ADVICE_ONLY' },
      'the plan replaced the harness claim, names its task, and an event with no Kilo or OpenCode session is advice only (OD-8)',
    );
    assert.deepEqual(seen[0].diff, claim.diff, 'the rest of the scope part is kept');
    assert.equal(Object.hasOwn(seen[1], 'approvedScope'), false, 'no active task: the claim is removed, nothing is invented');
    // OD-8 (D 45692ae): a Kilo turn reaches the certification step of D's gate; with no
    // session.route certification in this home it stays advice only, and the claim cannot change that.
    const kilo = { schemaVersion: '1.0', kind: 'task.requested', sessionId: 'kilo-s1', harness: 'kilocode' };
    assert.equal((await send(planned, 'scope-3', kilo)).result.recorded, true);
    assert.equal(seen[2].approvedScope.turnActuation, 'advise');
    assert.equal(seen[2].approvedScope.turnReasonCode, 'TURN_ROUTE_UNCERTIFIED');
    // A child session's event is never a main-session turn (B's routing review).
    const child = { ...kilo, parentSessionId: 'kilo-s1', sessionId: 'kilo-s1', agentId: 'child-1' };
    assert.equal((await send(planned, 'scope-4', child)).result.recorded, true);
    assert.equal(seen[3].approvedScope.turnActuation, 'advise');
    assert.equal(seen[3].approvedScope.turnReasonCode, 'CHILD_SESSION');
  } finally {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  }
});

// OD-8 (C ec42279): route.turn takes the approved scope and the main-session mode from the sidecar
// only. The session must be one the sidecar recorded from the same harness's own events; a child
// session, another harness's session or an unknown one is advice only (B's routing review).
test('route.turn: the sidecar supplies the scope from its own session record, never the plugin', { skip: managedHostSkip() }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-turn-')));
  const root = join(home, 'ws');
  mkdirSync(root);
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined, limits: { budgetMs: { hot: 60_000, background: 60_000 } } });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    const registered = answered(await sidecarRequest({ home, op: 'workspace.register', scope: 'hook', timeoutMs: 60_000, workspace: root }));
    const workspace = { id: registered.result.id, root: registered.result.root };
    const view = started.daemon.state.storeFor(workspace);
    assert.equal(store.createTask(view, { taskId: 'T1', ownerId: 'planner', rootBudgetId: 'budget1', requirementIds: ['REQ-1'], record: { writeScopes: ['src'], risk: 'low', sliceId: 'small-edit' }, nowMs: 1 }).ok, true);
    for (const [to, actor] of [['validated', 'planner'], ['ready', 'scheduler'], ['leased', 'scheduler']]) {
      assert.equal(store.transitionTask(view, { taskId: 'T1', to, actor, reasonCode: 'TEST', nowMs: 2 }).ok, true, to);
    }
    const ctx = { home, workspace, store: view, killSwitchStopped: false };
    const context = (sessionId, harness = 'kilocode') => started.daemon.state.turnContext(ctx, sessionId, harness);

    assert.deepEqual(await context('kilo-s1'), { scope: { turnActuation: 'advise', turnReasonCode: 'UNKNOWN_SESSION' }, mainSession: 'plugin-bounded-auto', hostRouteCertified: false }, 'a session the sidecar never saw');

    const send = async (key, envelope) => answered(await sidecarRequest({ home, op: 'event', scope: 'hook', timeoutMs: 60_000, workspace: root, body: { deliveryKey: key, envelope, harnessVersion: '1.2.3' } }));
    assert.equal((await send('t-1', { schemaVersion: '1.0', kind: 'session.started', sessionId: 'kilo-s1', harness: 'kilocode' })).result.recorded, true);
    assert.equal((await send('t-2', { schemaVersion: '1.0', kind: 'task.requested', sessionId: 'kilo-s1', parentSessionId: 'kilo-s1', agentId: 'child-1', harness: 'kilocode' })).result.recorded, true);

    assert.deepEqual(
      await context('kilo-s1'),
      { scope: { taskId: 'T1', risk: 'low', turnActuation: 'advise', turnReasonCode: 'TURN_ROUTE_UNCERTIFIED', sliceId: 'small-edit' }, mainSession: 'plugin-bounded-auto', hostRouteCertified: false },
      'a recorded main session gets D\'s gate and the task\'s slice; with no session.route certification it is advice only',
    );
    assert.equal((await context('kilo-s1', 'opencode')).scope.turnReasonCode, 'UNKNOWN_SESSION', 'another harness cannot borrow the session');
    assert.equal((await context('child-1')).scope.turnReasonCode, 'UNKNOWN_SESSION', 'a child session id is never a recorded main session');
    assert.equal((await started.daemon.state.turnContext({ ...ctx, killSwitchStopped: true }, 'kilo-s1', 'kilocode')).scope.turnReasonCode, 'KILL_SWITCH');

    // The op: a client-sent scope or mode is refused; a real request never actuates here.
    const current = { providerID: 'anthropic', modelID: 'claude-opus-5-5' };
    const claimed = await sidecarRequest({ home, op: 'route.turn', scope: 'hook', timeoutMs: 60_000, workspace: root, body: { harness: 'kilocode', sessionId: 'kilo-s1', current, scope: { turnActuation: 'bounded-auto', turnReasonCode: null } } });
    assert.equal(claimed.ok, false);
    assert.equal(claimed.reasonCode, 'INVALID_REQUEST');
    const asked = await sidecarRequest({ home, op: 'route.turn', scope: 'hook', timeoutMs: 60_000, workspace: root, body: { harness: 'kilocode', sessionId: 'kilo-s1', current } });
    assert.equal(asked.ok, true, JSON.stringify(asked));
    assert.equal(asked.result.actuate, false);
    assert.equal(asked.result.mainSession.switched, false);
  } finally {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  }
});

// Serving hosts R50 (C's request): the sidecar answers whether the harness version passes F's
// route.host certify case, for route.turn (turnContext) and for a subagent route (the event body).
// The answer is the sidecar's own; a plugin's claim is replaced, and any failure reads as false.
test('route.host: the sidecar supplies hostRouteCertified from its own answer, never the plugin (R50)', { skip: managedHostSkip() }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-host-')));
  const root = join(home, 'ws');
  mkdirSync(root);
  const asked = [];
  let broken = false;
  const hostRouteCertified = async (q) => {
    asked.push({ harness: q.harness, harnessVersion: q.harnessVersion, home: q.home === home });
    if (broken) throw new Error('certification records unreadable');
    return q.harness === 'kilocode' && q.harnessVersion === '1.2.3';
  };
  const seen = [];
  const subscribers = [{ name: 'host', handle: (ctx) => (seen.push(ctx.body.hostRouteCertified), { ok: true }) }];
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, subscribers, hostRouteCertified, log: () => undefined, limits: { budgetMs: { hot: 60_000, background: 60_000 } }, subscriberSliceMs: 60_000 });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    const registered = answered(await sidecarRequest({ home, op: 'workspace.register', scope: 'hook', timeoutMs: 60_000, workspace: root }));
    const workspace = { id: registered.result.id, root: registered.result.root };
    const view = started.daemon.state.storeFor(workspace);
    const ctx = { home, workspace, store: view, killSwitchStopped: false };
    const context = (sessionId, harness = 'kilocode') => started.daemon.state.turnContext(ctx, sessionId, harness);
    const send = async (key, envelope, version, extra = {}) => answered(await sidecarRequest({ home, op: 'event', scope: 'hook', timeoutMs: 60_000, workspace: root, body: { deliveryKey: key, envelope, ...(version === undefined ? {} : { harnessVersion: version }), ...extra } }));

    assert.equal((await context('kilo-s1')).hostRouteCertified, false, 'a session the sidecar never saw');
    assert.equal((await send('h-1', { schemaVersion: '1.0', kind: 'session.started', sessionId: 'kilo-s1', harness: 'kilocode' }, '1.2.3')).result.recorded, true);
    assert.equal((await context('kilo-s1')).hostRouteCertified, true, 'the recorded session\'s version passes route.host');
    assert.equal((await context('kilo-s1', 'opencode')).hostRouteCertified, false, 'another harness cannot borrow the session');
    assert.ok(asked.every((q) => q.home), 'the check reads this home');

    // A worker event waits for the answer; a plugin's claim never survives.
    const tool = (sessionId, harness) => ({ schemaVersion: '1.0', kind: 'tool.proposed', sessionId, harness, payload: { toolName: 'task' } });
    assert.equal((await send('h-2', tool('kilo-s1', 'kilocode'), '1.2.3', { hostRouteCertified: false })).result.recorded, true);
    assert.equal(seen.at(-1), true, 'a certified Kilo version: the sidecar says so, whatever the plugin sent');
    assert.equal((await send('h-3', tool('kilo-s1', 'kilocode'), '9.9.9', { hostRouteCertified: true })).result.recorded, true);
    assert.equal(seen.at(-1), false, 'an uncertified version: the claim is replaced');
    assert.equal((await send('h-4', tool('claude-s1', 'claude'), '1.2.3', { hostRouteCertified: true })).result.recorded, true);
    assert.equal(seen.at(-1), false, 'route.host is a Kilo and OpenCode feature only');
    assert.equal(asked.some((q) => q.harness === 'claude'), false, 'no check is made for another harness');
    assert.equal((await send('h-5', { kind: 'PostToolUse' }, undefined, { hostRouteCertified: true })).result.recorded, true);
    assert.equal(seen.at(-1), false, 'an event with no session');

    // A failing check reads as false once the cached answer expires.
    broken = true;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal((await context('kilo-s1')).hostRouteCertified, false, 'a throwing check is not certified');
    assert.equal((await send('h-6', tool('kilo-s1', 'kilocode'), '1.2.3', { hostRouteCertified: true })).result.recorded, true);
    assert.equal(seen.at(-1), false);
  } finally {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  }
});

test('route.host: with no certification record the default answer is false (R50)', { skip: managedHostSkip() }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-host0-')));
  const root = join(home, 'ws');
  mkdirSync(root);
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined, limits: { budgetMs: { hot: 60_000, background: 60_000 } } });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    const registered = answered(await sidecarRequest({ home, op: 'workspace.register', scope: 'hook', timeoutMs: 60_000, workspace: root }));
    const workspace = { id: registered.result.id, root: registered.result.root };
    const ctx = { home, workspace, store: started.daemon.state.storeFor(workspace), killSwitchStopped: false };
    const envelope = { schemaVersion: '1.0', kind: 'session.started', sessionId: 'oc-s1', harness: 'opencode' };
    assert.equal((await sidecarRequest({ home, op: 'event', scope: 'hook', timeoutMs: 60_000, workspace: root, body: { deliveryKey: 'd-1', envelope, harnessVersion: '1.0.0' } })).result.recorded, true);
    assert.equal((await started.daemon.state.turnContext(ctx, 'oc-s1', 'opencode')).hostRouteCertified, false);
  } finally {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  }
});
