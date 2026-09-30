import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';

// Learning records in the running sidecar (owner 2026-09-27; learning-coverage audit P5, P8):
// the hook launcher's pending latency file, the sidecar's own daily counters, the
// `latency.counters` op, session model changes from events, and the learning purge by the
// sidecar or, with none running, by the CLI.

const { startDaemon, sidecarRequest } = await import('../dist/index.js');
const client = await import('../dist/client.js');
const { hostScopeId } = await import('../dist/state.js');
const { jevrisPaths } = await import('@jevris/platform');
const store = await import('@jevris/store');
const { purgeStoreLearning } = await import('../../cli/dist/runtime-commands.js');

function tempHome(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function openHost(home) {
  const opened = store.openStore({ path: join(jevrisPaths({ home }).data, 'jevris.db'), role: 'sidecar', workspaceId: 'host', hostScope: hostScopeId(home) });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  return opened;
}

test('the hook launcher appends one text-free latency line, owner-only, and never past 64 KiB or for an invalid entry (P8)', () => {
  const home = tempHome('b-hook-lat-');
  try {
    const env = { JEVRIS_HOME: home };
    const file = client.hookLatencyFile({ env });
    assert.equal(file, join(jevrisPaths({ home }).state, client.HOOK_LATENCY_FILE));
    client.appendHookLatency({ env, harness: 'claude', reasonCode: 'HOOK_DEADLINE', elapsedMs: 912.4, atMs: 1_000 });
    client.appendHookLatency({ env, harness: 'Claude Code', reasonCode: 'HOOK_DEADLINE', elapsedMs: 1, atMs: 1 });
    client.appendHookLatency({ env, harness: 'codex', reasonCode: 'free text', elapsedMs: 1, atMs: 1 });
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.deepEqual(client.parseHookLatencyLine(lines[0]), { harness: 'claude', reasonCode: 'HOOK_DEADLINE', elapsedMs: 912, atMs: 1_000 });
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
    writeFileSync(file, 'x'.repeat(client.HOOK_LATENCY_FILE_MAX_BYTES + 1));
    client.appendHookLatency({ env, harness: 'claude', reasonCode: 'DEADLINE', elapsedMs: 1, atMs: 2 });
    assert.equal(statSync(file).size, client.HOOK_LATENCY_FILE_MAX_BYTES + 1, 'a full file is left alone');
    // A path it cannot write never throws.
    assert.doesNotThrow(() => client.appendHookLatency({ env: { JEVRIS_HOME: join(home, 'missing', '\0bad') }, harness: 'claude', reasonCode: 'DEADLINE', elapsedMs: 1, atMs: 2 }));
    for (const bad of ['', '{', '{"v":2,"harness":"claude","reasonCode":"DEADLINE","elapsedMs":1,"atMs":1}', '{"v":1,"harness":"claude","reasonCode":"DEADLINE","elapsedMs":-1,"atMs":1}']) {
      assert.equal(client.parseHookLatencyLine(bad), undefined, bad);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the sidecar persists its op answers and the hook misses as daily counters, served by latency.counters (P8)', { skip: managedHostSkip() }, async () => {
  const home = tempHome('b-lat-');
  try {
    const state = jevrisPaths({ home }).state;
    mkdirSync(state, { recursive: true });
    const now = Date.now();
    writeFileSync(join(state, client.HOOK_LATENCY_FILE), [
      client.hookLatencyLine({ harness: 'claude', reasonCode: 'HOOK_DEADLINE', elapsedMs: 950, atMs: now }),
      client.hookLatencyLine({ harness: 'claude', reasonCode: 'HOOK_DEADLINE', elapsedMs: 1200, atMs: now }),
      client.hookLatencyLine({ harness: 'codex', reasonCode: 'SIDECAR_UNAVAILABLE', elapsedMs: 40, atMs: now }),
      'not a line\n',
    ].join(''));
    const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined, limits: { budgetMs: { hot: 60_000, background: 60_000 } } });
    assert.equal(started.ok, true, started.ok ? '' : started.message);
    try {
      for (let i = 0; i < 3; i += 1) assert.equal((await sidecarRequest({ home, op: 'ping', scope: 'cli' })).ok, true);
      const res = await sidecarRequest({ home, op: 'latency.counters', scope: 'mcp', body: { days: 7 } });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.result.days, 7);
      assert.equal(res.result.targetMs, 900);
      const find = (scope, name, metric) => res.result.counters.find((c) => c.scope === scope && c.name === name && c.metric === metric);
      const hook = find('hook', 'claude', 'HOOK_DEADLINE');
      assert.deepEqual([hook.count, hook.totalMs, hook.maxMs], [2, 2150, 1200]);
      assert.equal(find('hook', 'codex', 'SIDECAR_UNAVAILABLE').count, 1);
      assert.ok(find('sidecar-op', 'ping', 'answered').count >= 3);
      assert.equal(existsSync(join(state, client.HOOK_LATENCY_FILE)), false, 'the pending file was folded in and removed');
      for (const c of res.result.counters) {
        assert.match(c.metric, /^(?:answered|[A-Z][A-Z0-9_]*)$/);
        assert.match(c.name, /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
      }
    } finally {
      await started.daemon.stop('test');
    }
    // The counts survive the restart.
    const opened = openHost(home);
    try {
      assert.ok(store.latencyCounters(opened, { sinceMs: now, scope: 'sidecar-op' }).some((c) => c.name === 'latency.counters' || c.name === 'ping'));
    } finally {
      store.closeStore(opened);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a session event that changes the model is recorded, and the learning purge removes the records through the sidecar or the CLI (P5, retention)', { skip: managedHostSkip() }, async () => {
  const home = tempHome('b-learn-');
  const repo = join(home, 'repo');
  mkdirSync(repo);
  try {
    const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined, limits: { budgetMs: { hot: 60_000, background: 60_000 } } });
    assert.equal(started.ok, true, started.ok ? '' : started.message);
    let ws;
    try {
      const envelope = (kind, model, key, payload = {}) => ({ schemaVersion: '1.0', harness: 'claude', nativeEventName: kind, kind, sessionId: 's1', model, payload, dedupKey: key, flags: {} });
      for (const [kind, model, key, payload] of [
        ['session.started', 'claude-opus-5-5', 'k1', {}],
        ['model.changed', 'claude-opus-5-5', 'k2', { toModel: 'claude-sonnet-5' }],
      ]) {
        const res = await sidecarRequest({ home, op: 'event', workspace: repo, scope: 'hook', timeoutMs: 60_000, body: { envelope: envelope(kind, model, key, payload), deliveryKey: key } });
        assert.equal(res.ok, true, JSON.stringify(res));
      }
      ws = (await sidecarRequest({ home, op: 'workspace.register', workspace: repo, scope: 'cli' })).result.id;
      const purged = await purgeStoreLearning(home, { workspaceId: ws });
      assert.equal(purged.ok, true, JSON.stringify(purged));
      assert.equal(purged.via, 'sidecar');
      assert.equal(purged.removed.session_model_change, 1, 'the one change was recorded, then removed');
    } finally {
      await started.daemon.stop('test');
    }
    // With no sidecar running the CLI opens the store itself; the audit row waits for the next start.
    const opened = openHost(home);
    try {
      store.addLatencyCounts(opened, [{ atMs: Date.now(), scope: 'hook', name: 'claude', metric: 'DEADLINE', count: 1, totalMs: 1, maxMs: 1 }]);
    } finally {
      store.closeStore(opened);
    }
    const direct = await purgeStoreLearning(home);
    assert.equal(direct.ok, true, JSON.stringify(direct));
    assert.equal(direct.via, 'store');
    assert.ok(direct.removed.latency_counter >= 1);
    assert.equal((await purgeStoreLearning(home, { workspaceId: 'not an id' })).ok, false);
    const reopened = openHost(home);
    try {
      const audit = store.readAudit(reopened).filter((row) => row.kind === 'data.delete' && row.detail.scope === 'learning');
      assert.equal(audit.length, 1, 'the sidecar audited its purge');
    } finally {
      store.closeStore(reopened);
    }
    assert.match(readFileSync(join(jevrisPaths({ home }).state, 'audit-pending.jsonl'), 'utf8'), /"scope":"learning"/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the in-memory counters merge per day and key, keep their counts when the store refuses, and fold an overflow into one counter (P8)', () => {
  return import('../dist/latency-counters.js').then(({ createLatencyCounters: create, LATENCY_KEYS_MAX: max }) => {
    const home = tempHome('b-lat-unit-');
    try {
      let refuse = true;
      const written = [];
      const api = { addLatencyCounts: (_store, counts) => (refuse ? { ok: false, reason: 'store-full' } : (written.push(...counts), { ok: true, added: counts.length, dropped: 0 })) };
      const counters = create({ stateDir: join(home, 'state'), store: () => ({ store: {}, api }), now: () => 5 * 86_400_000 + 10 });
      counters.count('sidecar-op', 'event', 'answered', 10);
      counters.count('sidecar-op', 'event', 'answered', 30);
      counters.count('sidecar-op', 'event', 'LATE_ANSWER', 950);
      counters.count('subscriber', 'bad name!', 'SUBSCRIBER_QUEUED', 5);
      assert.equal(counters.flush().written, 0);
      assert.equal(counters.pending(), 3, 'kept after a refusal');
      refuse = false;
      assert.equal(counters.flush().written, 3);
      assert.equal(counters.pending(), 0);
      const answered = written.find((c) => c.metric === 'answered');
      assert.deepEqual([answered.count, answered.totalMs, answered.maxMs, answered.atMs], [2, 40, 30, 5 * 86_400_000]);
      assert.ok(written.some((c) => c.scope === 'subscriber' && c.name === 'other'));
      for (let i = 0; i < max + 5; i += 1) counters.count('sidecar-op', `op${String(i)}`, 'answered', 1);
      counters.flush();
      const overflow = written.find((c) => c.metric === 'COUNTER_OVERFLOW');
      assert.equal(overflow.count, 5);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

test("C's advice handlers get an advice-adherence port on the op context, bound to the request's workspace (P5)", { skip: managedHostSkip() }, async () => {
  const home = tempHome('b-adherence-');
  const repo = join(home, 'repo');
  mkdirSync(repo);
  try {
    const seen = [];
    const probe = {
      op: 'test.adherence',
      scope: 'advice',
      budget: 'hot',
      handle: (ctx) => {
        const port = ctx.adviceAdherence;
        seen.push(port !== undefined);
        if (port === undefined) return { ok: true, body: { port: false } };
        const advice = { sessionId: 's1', adviceKind: 'main-route', slice: 'edit-small', advisedModel: 'claude-haiku-5' };
        const opened = [port.open({ ...advice, decisionId: 'a1', currentModel: 'claude-opus-5-5', atMs: 10 }), port.open({ ...advice, decisionId: 'a2', currentModel: 'claude-opus-5-5', atMs: 20 }), port.open({ ...advice, decisionId: 'bad id!', atMs: 30 })];
        return { ok: true, body: { port: true, opened, overrides: port.overrides(advice) } };
      },
    };
    const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined, liveCertification: false, ops: [probe], limits: { budgetMs: { hot: 60_000, background: 60_000 } } });
    assert.equal(started.ok, true, started.ok ? '' : started.message);
    try {
      const res = await sidecarRequest({ home, op: 'test.adherence', scope: 'hook', timeoutMs: 60_000, workspace: repo, body: {} });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.deepEqual(res.result, { port: true, opened: [true, true, false], overrides: 1 }, 'the second advice closed the first as no-change');
    } finally {
      await started.daemon.stop('test');
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
