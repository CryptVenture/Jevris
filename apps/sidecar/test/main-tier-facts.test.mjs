import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';

// Tiered routing, step 3 (the main-session model line): on a prompt (task.requested) or a failure, the event op gives subscribers
// the sidecar's own record of the session's model and of the task's content-free tier signals (counts, the risk class and codes,
// never a title or a path), and whether the plugin switches a Kilo or OpenCode turn (`tierTurn`). Whatever a hook claimed for those
// fields is dropped; other events carry none of them.

const { startDaemon, sidecarRequest } = await import('../dist/index.js');
const store = await import('@jevris/store');

const answered = (response) => {
  assert.equal(response.ok, true, JSON.stringify(response));
  return response;
};

const FAILURE = { toolClass: 'shell', exitClass: 'nonzero', family: 'shell:nonzero', signature: 'aaaaaaaaaaaaaaaa', commandDigest: 'cccccccccccccccc', environmental: false, elapsed: 'lt10s', present: [] };
const FORGED = { tierSignals: { risk: 'low', forged: true }, tierTurn: 'both', sessionModel: 'forged-model' };

test('a prompt or a failure event carries the sidecar\'s session model, task tier signals and turn gate, whatever the hook claimed; other events carry none', { skip: managedHostSkip() }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-tier-')));
  const root = join(home, 'ws');
  const bare = join(home, 'bare');
  mkdirSync(root);
  mkdirSync(bare);
  const seen = [];
  const subscribers = [{ name: 'capture', handle: (ctx) => (seen.push(ctx.body), { ok: true }) }];
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, subscribers, log: () => undefined, limits: { budgetMs: { hot: 60_000, background: 60_000 } }, subscriberSliceMs: 60_000 });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    const registered = answered(await sidecarRequest({ home, op: 'workspace.register', scope: 'hook', timeoutMs: 60_000, workspace: root }));
    const view = started.daemon.state.storeFor({ id: registered.result.id, root: registered.result.root });
    assert.equal(store.createTask(view, { taskId: 'T1', ownerId: 'planner', rootBudgetId: 'budget1', requirementIds: ['REQ-1'], record: { writeScopes: ['src/auth'], risk: 'high', sliceId: 'feature', riskReasons: ['PROTECTED_AUTH'] }, nowMs: 1 }).ok, true);
    for (const [to, actor] of [['validated', 'planner'], ['ready', 'scheduler'], ['leased', 'scheduler']]) {
      assert.equal(store.transitionTask(view, { taskId: 'T1', to, actor, reasonCode: 'TEST', nowMs: 2 }).ok, true, to);
    }
    let n = 0;
    const send = async (workspace, envelope, extra = {}) => {
      n += 1;
      const before = seen.length;
      answered(await sidecarRequest({ home, op: 'event', scope: 'hook', timeoutMs: 60_000, workspace, body: { deliveryKey: `k-${String(n)}`, envelope, harnessVersion: '2.1.0', ...extra } }));
      const stop = performance.now() + 30_000;
      while (seen.length === before && performance.now() < stop) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(seen.length > before, 'the subscriber ran');
      return seen[seen.length - 1];
    };
    const base = { schemaVersion: '1.0', harness: 'claude', sessionId: 'claude-s1' };
    await send(root, { ...base, kind: 'session.started', model: 'claude-sonnet-5-5' });
    const prompt = await send(root, { ...base, kind: 'task.requested' }, FORGED);
    assert.equal(prompt.sessionModel, 'claude-sonnet-5-5', 'the sidecar\'s record of the session, not the hook\'s claim');
    assert.equal(prompt.tierSignals.sliceId, 'feature');
    assert.equal(prompt.tierSignals.files, 1);
    assert.equal(prompt.tierSignals.forged, undefined);
    assert.deepEqual(prompt.tierSignals.protectedClasses, ['PROTECTED_AUTH']);
    assert.equal(Object.keys(prompt.tierSignals).some((k) => /path|title|name|text/i.test(k)), false, 'no path, title or text field');
    assert.equal(prompt.tierTurn, 'none', 'Claude Code turns are never switched');
    // A failure event gets them too; a plain tool event and a prompt in a workspace with no task get none, and a claim never survives.
    const failed = await send(root, { ...base, kind: 'tool.failed' }, { ...FORGED, failure: FAILURE });
    assert.equal(failed.sessionModel, 'claude-sonnet-5-5');
    assert.equal(failed.tierSignals.sliceId, 'feature');
    const tool = await send(root, { ...base, kind: 'tool.finished' }, FORGED);
    for (const field of ['tierSignals', 'tierTurn', 'sessionModel']) assert.equal(Object.hasOwn(tool, field), false, `a plain tool event carries no ${field}`);
    answered(await sidecarRequest({ home, op: 'workspace.register', scope: 'hook', timeoutMs: 60_000, workspace: bare }));
    const none = await send(bare, { ...base, sessionId: 'claude-s2', kind: 'task.requested' }, FORGED);
    for (const field of ['tierSignals', 'tierTurn', 'sessionModel']) assert.equal(Object.hasOwn(none, field), false, `no task, no session record: no ${field}, and the claim is gone`);
    // A subagent's event is not the main session's.
    const child = await send(root, { ...base, kind: 'task.requested', parentSessionId: 'claude-s1', agentId: 'child-1' }, FORGED);
    for (const field of ['tierSignals', 'tierTurn', 'sessionModel']) assert.equal(Object.hasOwn(child, field), false, `a subagent's event carries no ${field}`);
  } finally {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  }
});
