import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';

// session.link and session.unlink (owner decision 29423b6; coordinator c065d52; B's security
// conditions): CLI key only, a link needs the terminal channel and a clear kill switch, the
// session comes from the sidecar's own records, and the answer always names it.

const { startDaemon, sidecarRequest } = await import('../dist/index.js');
const { sessionLinkOps } = await import('../dist/session-link.js');
const store = await import('@jevris/store');

test('session.link refuses a stopped kill switch and a non-terminal channel before it reads anything', () => {
  const ops = new Map(sessionLinkOps({ api: () => store, taskState: () => 'active' }).map((d) => [d.op, d]));
  for (const op of ['session.link', 'session.unlink']) assert.equal(ops.get(op).scope, 'admin', op);
  const ctx = (body, extra = {}) => ({ body, store: undefined, killSwitchStopped: false, workspace: { id: 'w', root: '/x' }, ...extra });
  assert.equal(ops.get('session.link').handle(ctx({ taskId: 'T1', harness: 'kilocode' })).reasonCode, 'CHANNEL_REFUSED');
  assert.equal(ops.get('session.link').handle(ctx({ taskId: 'T1', harness: 'kilocode', channel: 'cli' })).reasonCode, 'CHANNEL_REFUSED');
  assert.equal(ops.get('session.link').handle(ctx({ taskId: 'T1', harness: 'kilocode', channel: 'terminal' }, { killSwitchStopped: true })).reasonCode, 'KILL_SWITCH_ACTIVE');
  assert.equal(ops.get('session.link').handle(ctx({ taskId: 'T1', harness: 'kilocode', channel: 'terminal', scope: { turnActuation: 'bounded-auto' } })).reasonCode, 'INVALID_REQUEST', 'unknown keys are refused');
  assert.equal(ops.get('session.link').handle(ctx({ taskId: 'T1', harness: 'kilocode', channel: 'terminal' })).reasonCode, 'STORE_UNAVAILABLE');
  assert.equal(ops.get('session.unlink').handle(ctx({ harness: 'kilocode' }, { killSwitchStopped: true })).reasonCode, 'STORE_UNAVAILABLE', 'unlink is not stopped by the kill switch');
});

test('session.link end to end: records only, exact hints, one recent candidate or an ambiguous list, task checks, replace, unlink', { skip: managedHostSkip() }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-link-')));
  const root = join(home, 'ws');
  mkdirSync(root);
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined, limits: { budgetMs: { hot: 60_000, background: 60_000 } } });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    const registered = await sidecarRequest({ home, op: 'workspace.register', scope: 'hook', timeoutMs: 60_000, workspace: root });
    const workspace = { id: registered.result.id, root: registered.result.root };
    const view = started.daemon.state.storeFor(workspace);
    const task = (taskId, states) => {
      assert.equal(store.createTask(view, { taskId, ownerId: 'planner', rootBudgetId: 'budget1', requirementIds: ['REQ-1'], record: { writeScopes: ['src'], risk: 'low' }, nowMs: 1 }).ok, true);
      for (const [to, actor] of states) assert.equal(store.transitionTask(view, { taskId, to, actor, reasonCode: 'TEST', nowMs: 2 }).ok, true, to);
    };
    task('T1', [['validated', 'planner'], ['ready', 'scheduler'], ['leased', 'scheduler']]);
    task('T2', [['validated', 'planner'], ['ready', 'scheduler'], ['leased', 'scheduler']]);
    task('T3', [['validated', 'planner']]);
    const cli = (op, body) => sidecarRequest({ home, op, scope: 'cli', workspace: root, body });
    const link = (body) => cli('session.link', { channel: 'terminal', ...body });
    const started_ = (key, sessionId, harness) => sidecarRequest({ home, op: 'event', scope: 'hook', timeoutMs: 60_000, workspace: root, body: { deliveryKey: key, envelope: { schemaVersion: '1.0', kind: 'session.started', sessionId, harness } } });

    for (const scope of ['hook', 'mcp']) {
      const refused = await sidecarRequest({ home, op: 'session.link', scope, workspace: root, body: { taskId: 'T1', harness: 'kilocode', channel: 'terminal' } });
      assert.equal(refused.ok, false, scope);
    }
    assert.equal((await link({ taskId: 'T1', harness: 'kilocode' })).reasonCode, 'UNKNOWN_SESSION', 'no session recorded');

    assert.equal((await started_('e1', 'kilo-a', 'kilocode')).ok, true);
    assert.equal((await link({ taskId: 'T9', harness: 'kilocode' })).reasonCode, 'TASK_UNKNOWN');
    assert.equal((await link({ taskId: 'T3', harness: 'kilocode' })).reasonCode, 'TASK_NOT_ACTIVE');
    const first = await link({ taskId: 'T1', harness: 'kilocode' });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.result.result, 'linked');
    assert.equal(first.result.sessionId, 'kilo-a', 'the answer names the session it linked');
    assert.equal(first.result.via, 'route');
    assert.deepEqual(store.sessionLinkFor(view, 'kilo-a'), { sessionId: 'kilo-a', harness: 'kilocode', taskId: 'T1', linkedAtMs: store.sessionLinkFor(view, 'kilo-a').linkedAtMs, via: 'route' });

    // A second turn-harness session makes a guess ambiguous: the candidates are listed, nothing is linked.
    assert.equal((await started_('e2', 'open-b', 'opencode')).ok, true);
    const ambiguous = await link({ taskId: 'T2', harness: 'kilocode' });
    assert.equal(ambiguous.ok, true, JSON.stringify(ambiguous));
    assert.equal(ambiguous.result.result, 'ambiguous');
    assert.deepEqual(ambiguous.result.candidates.map((c) => c.sessionId).sort(), ['kilo-a', 'open-b']);
    // Exact hints only, of the right harness.
    assert.equal((await link({ taskId: 'T2', harness: 'kilocode', session: 'open-b' })).reasonCode, 'UNKNOWN_SESSION');
    assert.equal((await link({ taskId: 'T2', harness: 'kilocode', session: 'kilo' })).reasonCode, 'UNKNOWN_SESSION', 'no prefix match');
    assert.equal((await link({ taskId: 'T2', harness: 'kilocode', session: 'kilo-a' })).reasonCode, 'SESSION_ALREADY_LINKED');
    assert.equal((await link({ taskId: 'T1', harness: 'kilocode', session: 'kilo-a' })).result.result, 'already-linked');
    assert.equal((await link({ taskId: 'T2', harness: 'kilocode', session: 'kilo-a', replace: true })).result.result, 'linked');
    assert.equal(store.sessionLinkFor(view, 'kilo-a').taskId, 'T2');

    // With no harness, every recent turn-harness session could be meant: ambiguous here.
    const any = await link({ taskId: 'T1' });
    assert.equal(any.result.result, 'ambiguous');
    const named = await link({ taskId: 'T1', session: 'open-b' });
    assert.equal(named.result.result, 'linked');
    assert.equal(named.result.harness, 'opencode', 'the harness comes from the session record');
    assert.equal((await cli('session.unlink', { session: 'open-b' })).result.result, 'unlinked');
    const handoff = await link({ taskId: 'T1', session: 'open-b', via: 'handoff' });
    assert.equal(handoff.result.via, 'handoff', 'the label follows what the person did');
    assert.equal((await cli('session.link', { taskId: 'T1', session: 'open-b', via: 'handoff', channel: 'cli' })).reasonCode, 'CHANNEL_REFUSED', 'the same terminal gate');
    assert.equal((await cli('session.unlink', { session: 'open-b' })).result.result, 'unlinked');

    // A terminal link may say it came from a handoff import; `plan` never comes from a client.
    assert.equal((await link({ taskId: 'T2', harness: 'kilocode', session: 'kilo-a', via: 'plan' })).reasonCode, 'INVALID_REQUEST');
    assert.equal((await link({ taskId: 'T2', harness: 'kilocode', session: 'kilo-a', via: 'mcp' })).reasonCode, 'INVALID_REQUEST');

    // Status lists the live links of this workspace.
    const status = await sidecarRequest({ home, op: 'status', scope: 'cli', workspace: root, body: {} });
    assert.equal(status.ok, true, JSON.stringify(status));
    assert.deepEqual(status.result.sessionLinks.map((l) => [l.harness, l.sessionId, l.taskId, l.via]), [['kilocode', 'kilo-a', 'T2', 'route']]);

    // Unlink needs no terminal.
    const unlinked = await cli('session.unlink', { harness: 'kilocode', session: 'kilo-a' });
    assert.deepEqual(unlinked.result, { result: 'unlinked', harness: 'kilocode', sessionId: 'kilo-a' });
    assert.deepEqual((await cli('session.unlink', { harness: 'kilocode', session: 'kilo-a' })).result, { result: 'not-linked', harness: 'kilocode', sessionId: 'kilo-a' });
    const audit = store.readAudit(started.daemon.state.store, { kinds: ['session.link', 'session.unlink'] });
    assert.deepEqual(audit.map((row) => [row.kind, row.channel]), [['session.link', 'terminal'], ['session.link', 'terminal'], ['session.link', 'terminal'], ['session.unlink', 'cli'], ['session.link', 'terminal'], ['session.unlink', 'cli'], ['session.unlink', 'cli']]);
  } finally {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  }
});

test('status lists the links of in-use owned-worker worktrees after its own, marked worker, only for that worktree\'s task and a turn harness, 16 at most (D 0594fcb; E ade68c6d)', { skip: managedHostSkip() }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-wlink-')));
  const root = join(home, 'ws');
  mkdirSync(root);
  // Two worker worktrees (each its own workspace to the sidecar) and one whose view throws.
  let workers = [
    { taskId: 'T1', workspaceId: 'wWorkerOne' },
    { taskId: 'T2', workspaceId: 'wWorkerTwo' },
  ];
  const ownedWorktrees = () => {
    if (workers === 'throw') throw new Error('unreadable');
    return workers;
  };
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined, ownedWorktrees, limits: { budgetMs: { hot: 60_000, background: 60_000 } } });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    const registered = await sidecarRequest({ home, op: 'workspace.register', scope: 'hook', timeoutMs: 60_000, workspace: root });
    const own = started.daemon.state.storeFor({ id: registered.result.id, root: registered.result.root });
    const one = started.daemon.state.storeFor({ id: 'wWorkerOne', root: null });
    const two = started.daemon.state.storeFor({ id: 'wWorkerTwo', root: null });
    const who = { actor: 'cli', channel: 'terminal', atMs: Date.now() };
    const linked = (view, sessionId, harness, taskId, via) => {
      assert.equal(store.recordSession(view, { sessionId, harness, state: 'active', atMs: Date.now() }).ok, true);
      assert.equal(store.linkSession(view, { sessionId, harness, taskId, via, ...who }).ok, true, sessionId);
    };
    linked(own, 'own-1', 'kilocode', 'P1', 'route');
    linked(one, 'wk-1', 'opencode', 'T1', 'plan');
    linked(one, 'wk-other-task', 'opencode', 'T9', 'plan'); // not this worktree's task: never shown
    linked(one, 'wk-claude', 'claude', 'T1', 'plan'); // not a turn harness: never shown
    linked(two, 'wk-2', 'kilocode', 'T2', 'plan');
    const status = async () => {
      const answer = await sidecarRequest({ home, op: 'status', scope: 'cli', workspace: root, body: {} });
      assert.equal(answer.ok, true, JSON.stringify(answer));
      return answer.result.sessionLinks;
    };
    const links = await status();
    assert.deepEqual(links.map((l) => [l.sessionId, l.taskId, l.via, l.worker === true]), [
      ['own-1', 'P1', 'route', false],
      ['wk-1', 'T1', 'plan', true],
      ['wk-2', 'T2', 'plan', true],
    ]);
    assert.equal(Object.hasOwn(links[0], 'worker'), false, 'own links carry no worker mark');
    // The own workspace is never read again as a worker, and a failing enumeration keeps own links.
    workers = [{ taskId: 'P1', workspaceId: registered.result.id }];
    assert.deepEqual((await status()).map((l) => l.sessionId), ['own-1']);
    workers = 'throw';
    assert.deepEqual((await status()).map((l) => l.sessionId), ['own-1']);
    // 16 at most, own first.
    workers = Array.from({ length: 20 }, (_, i) => ({ taskId: `T${i}`, workspaceId: `wMany${i}` }));
    for (let i = 0; i < 20; i += 1) linked(started.daemon.state.storeFor({ id: `wMany${i}`, root: null }), `many-${i}`, 'opencode', `T${i}`, 'plan');
    const capped = await status();
    assert.equal(capped.length, 16);
    assert.equal(capped[0].sessionId, 'own-1');
  } finally {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  }
});
