import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';

// Access limits R76 (design 9.3): the sidecar's resume tick hands each workspace with an
// access-blocked task that may resume to D's resumeAccessBlocked, with a full operation context.
// The host ledger is read first: a workspace with no such row is never opened, and nothing is
// created when orchestration never ran. D's own tests cover when a task resumes; these cover the
// wiring. A temporary home; the timer is off (accessResumeMs 0) and the tick is called directly.

const { startDaemon, sidecarRequest, workspaceIdentity } = await import('../dist/index.js');
const { ACCESS_BLOCKED_COLLECTION, DEFAULT_CONFIG, openLedger } = await import('@jevris/orchestrator');
const { jevrisPaths } = await import('@jevris/platform');
const core = await import('@jevris/core');

async function fixture(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-resume-tick-')));
  const roots = { a: join(home, 'ws-a'), b: join(home, 'ws-b') };
  for (const root of Object.values(roots)) mkdirSync(root);
  const logs = [];
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, accessResumeMs: 0, log: (entry) => logs.push(entry) });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  t.after(async () => {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  });
  // Both workspaces become known to the sidecar, as any request does.
  for (const root of Object.values(roots)) {
    const status = await sidecarRequest({ home, op: 'status', scope: 'cli', workspace: root, body: {} });
    assert.equal(status.ok, true, JSON.stringify(status));
  }
  const paths = jevrisPaths({ home });
  const ids = { a: workspaceIdentity(roots.a).id, b: workspaceIdentity(roots.b).id };
  const seedRow = async (workspaceId, extra = {}) => {
    const row = { workspaceId, taskId: 'T1', scopeKey: 'abcdef0123456789', class: 'usage-window', untilMs: Date.now() - 1000, blockedAtMs: Date.now() - 3_600_000, resumed: false, autoResume: true, ...extra };
    await openLedger(join(paths.data, 'orchestration', 'host')).transact((tx) => tx.put(ACCESS_BLOCKED_COLLECTION, `${workspaceId}/T1`, row));
  };
  const resumeTraces = () => logs.filter((l) => typeof l.event === 'string' && l.event.startsWith('trace:access-resume')).map((l) => [l.event, l.ws, l.reasonCode]);
  const workers = (mode) => {
    mkdirSync(paths.config, { recursive: true });
    writeFileSync(join(paths.config, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, managedWorkers: mode }, orchestration: { ...DEFAULT_CONFIG.orchestration, enabled: true } }));
  };
  return { home, paths, ids, state: started.daemon.state, seedRow, resumeTraces, workers };
}

test('the resume tick opens nothing and creates nothing when no task is access-blocked (R76)', { skip: managedHostSkip() }, async (t) => {
  const box = await fixture(t);
  const host = join(box.paths.data, 'orchestration', 'host');
  const before = existsSync(host);
  await box.state.resumeAccessBlocked();
  assert.equal(existsSync(host), before, 'the tick creates no host ledger');
  assert.deepEqual(box.resumeTraces(), []);
  // A row that already resumed, or that waits for a person, is not pending either.
  await box.seedRow(box.ids.a, { resumed: true });
  await box.seedRow(box.ids.b, { autoResume: false });
  await box.state.resumeAccessBlocked();
  assert.deepEqual(box.resumeTraces(), []);
});

test('the resume tick hands only the workspace with a pending row to D, and traces its code (R76)', { skip: managedHostSkip() }, async (t) => {
  const box = await fixture(t);
  await box.seedRow(box.ids.a);
  // Managed workers only advise here: D declines, with a code.
  box.workers('advise');
  await box.state.resumeAccessBlocked();
  assert.deepEqual(box.resumeTraces(), [['trace:access-resume', box.ids.a, 'NOT_BOUNDED_AUTO']], 'workspace b has no row and is not asked');
});

test('the resume tick passes D an unreadable access record as a code, and resumes nothing (R76, MEDIUM 40)', { skip: managedHostSkip() }, async (t) => {
  const box = await fixture(t);
  box.workers('bounded-auto');
  await box.seedRow(box.ids.a);
  mkdirSync(join(box.paths.data, 'route-learning'), { recursive: true });
  writeFileSync(core.accessLimitsPath(box.home), '{not json', { mode: 0o600 });
  await box.state.resumeAccessBlocked();
  const traces = box.resumeTraces();
  assert.equal(traces.some(([, ws, code]) => ws === box.ids.a && code === 'ACCESS_LIMITS_UNREADABLE'), true, JSON.stringify(traces));
  const row = openLedger(join(box.paths.data, 'orchestration', 'host')).get(ACCESS_BLOCKED_COLLECTION, `${box.ids.a}/T1`);
  assert.equal(row.resumed, false, 'the row waits for the next tick');
});

test('a tick in progress makes the next call wait for it, not start another (R76)', { skip: managedHostSkip() }, async (t) => {
  const box = await fixture(t);
  await box.seedRow(box.ids.a);
  box.workers('advise');
  const first = box.state.resumeAccessBlocked();
  const second = box.state.resumeAccessBlocked();
  await Promise.all([first, second]);
  assert.equal(box.resumeTraces().length, 1, 'one tick ran');
});

test('the resume tick reads the kill switch itself: a stopped or unreadable switch resumes nothing (R76)', { skip: managedHostSkip() }, async (t) => {
  const box = await fixture(t);
  box.workers('bounded-auto');
  await box.seedRow(box.ids.a);
  // A kill-switch file that cannot be read reads as stopped (GOV-02).
  writeFileSync(join(box.paths.config, 'kill-switch.json'), 'not json', { mode: 0o600 });
  await box.state.resumeAccessBlocked();
  assert.deepEqual(box.resumeTraces(), [['trace:access-resume', box.ids.a, 'KILL_SWITCH']]);
  const row = openLedger(join(box.paths.data, 'orchestration', 'host')).get(ACCESS_BLOCKED_COLLECTION, `${box.ids.a}/T1`);
  assert.equal(row.resumed, false);
});
