// P8 (B a51d524): status shows the persisted latency and deadline counters against the 900 ms
// target. The summary reads B's latency.counters rows and carries counts and names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { latencySummary, latencyLines, STATUS_LATENCY_DAYS } = await import('../dist/public/latency.js');
const { runPublicCommand } = await import('../dist/public-commands.js');
const c = await import('@jevris/contracts');

const row = (scope, name, metric, count, maxMs = 0) => ({ dayStartMs: 0, scope, name, metric, count, totalMs: maxMs * count, maxMs });

test('latencySummary totals hook misses, late answers, slow subscribers and breaker opens from B\'s rows', () => {
  const answer = {
    days: 7,
    sinceMs: 0,
    targetMs: 900,
    counters: [
      row('hook', 'claude', 'DEADLINE', 2),
      row('hook', 'codex', 'HOOK_DEADLINE', 1),
      row('hook', 'claude', 'HOOK_WATCHDOG', 1),
      row('hook', 'claude', 'SIDECAR_TIMEOUT', 3),
      row('hook', 'claude', 'SIDECAR_AUTOSTART_OFF', 9),
      row('sidecar-op', 'event', 'answered', 50, 120),
      row('sidecar-op', 'event', 'LATE_ANSWER', 2, 1300),
      row('subscriber', 'restore', 'SUBSCRIBER_QUEUED', 3, 1400),
      row('subscriber', 'restore', 'SUBSCRIBER_QUEUED', 1, 950),
      row('subscriber', 'security', 'SUBSCRIBER_QUEUED', 1, 910),
      row('subscriber', 'bad name!', 'SUBSCRIBER_QUEUED', 5, 9),
      row('breaker', 'provider', 'CIRCUIT_OPEN', 1),
      { scope: 'hook', name: 'claude', metric: 'DEADLINE', count: -1 },
      null,
    ],
  };
  const summary = latencySummary(answer);
  assert.deepEqual(summary, {
    days: 7,
    targetMs: 900,
    hookDeadlineMisses: 4,
    hookSidecarMisses: 3,
    hookSidecarStarting: 0,
    lateSidecarAnswers: 2,
    slowSubscribers: [
      { name: 'restore', count: 4, maxMs: 1400 },
      { name: 'security', count: 1, maxMs: 910 },
    ],
    breakerOpens: 1,
  });
  assert.equal(c.StatusLatencySchema !== undefined, true);
  assert.equal(c.surfacePayloadContract('status').validate(statusWith(summary)).ok, true);
  assert.deepEqual(latencyLines(summary), [
    'latency (last 7 days, target 900 ms): 4 hook deadline misses, 3 hooks the sidecar did not answer, 2 late sidecar answers',
    'slow subscribers: restore 4 misses (max 1400 ms), security 1 miss (max 910 ms)',
    'circuit breaker opened: 1 time',
  ]);
});

test('no misses reads as one line; an answer of another shape is no summary and no line', () => {
  const quiet = latencySummary({ days: 1, sinceMs: 0, targetMs: 900, counters: [row('sidecar-op', 'status', 'answered', 4, 30)] });
  assert.deepEqual(latencyLines(quiet), ['latency (last 1 day, target 900 ms): no deadline misses']);
  for (const bad of [null, [], { days: 0, targetMs: 900, counters: [] }, { days: 7, targetMs: 900 }, { days: 7, targetMs: -1, counters: [] }]) {
    assert.equal(latencySummary(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(latencyLines(null), []);
  assert.deepEqual(latencyLines(undefined), []);
  assert.equal(STATUS_LATENCY_DAYS, 7);
});

function statusWith(latency) {
  return {
    jevrisMode: 'observe',
    killSwitch: 'clear',
    decisionHealth: 'unknown',
    degradedReason: null,
    routing: { modelPin: null, pinned: false },
    activeWorkers: [],
    budget: { state: 'unknown', reservedMicroUsd: null, limitMicroUsd: null },
    recentDecisions: [],
    unknownSlices: [],
    store: { state: 'ok', diagnostic: null },
    latency,
  };
}

test('jevris status reads latency.counters from a running sidecar and shows the line; without a sidecar there is no line (CLI and MCP share the op)', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-latency-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const workspace = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(workspace, '.git'), { recursive: true });
  const env = { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '1' };
  const run = async (answers, argv = []) => {
    const requests = [];
    const ports = {
      sidecar: {
        ensure: async () => ({ ok: true, endpoint: 'fake', started: false }),
        request: async (input) => {
          requests.push(input);
          const answer = answers[input.op];
          return answer === undefined ? { ok: false, reason: 'unavailable', reasonCode: 'NOT_RUNNING', message: 'not running' } : { ok: true, result: answer };
        },
      },
      engine: {},
      config: {},
    };
    let text = '';
    const code = await runPublicCommand('status', argv, (chunk) => (text += chunk), { ports, env, cwd: workspace });
    return { code, text, requests };
  };
  const reduced = JSON.parse((await run({}, ['--json'])).text).result;
  assert.equal(reduced.latency, undefined, 'no sidecar, no counters');
  const counters = { days: 7, sinceMs: 0, targetMs: 900, counters: [row('hook', 'claude', 'HOOK_WATCHDOG', 2)] };
  const full = await run({ status: reduced, 'latency.counters': counters }, ['--json']);
  const asked = full.requests.find((r) => r.op === 'latency.counters');
  assert.deepEqual([asked.body, asked.scope], [{ days: STATUS_LATENCY_DAYS }, 'cli']);
  assert.deepEqual(JSON.parse(full.text).result.latency, latencySummary(counters));
  const human = await run({ status: reduced, 'latency.counters': counters });
  assert.match(human.text, /^latency \(last 7 days, target 900 ms\): 2 hook deadline misses, 0 hooks the sidecar did not answer, 0 late sidecar answers$/m);
  // A sidecar that answers status but not the counters (older sidecar, store closed): no line, no error.
  const older = await run({ status: reduced });
  assert.equal(older.code, 0);
  assert.doesNotMatch(older.text, /^latency/m);
});

test('status shows the Stop reminders and what followed them when the sidecar reports them (P6, D 4368eb4)', async () => {
  const { renderHuman } = await import('../dist/public/render.js');
  const reminders = { fired: 5, ledToCheck: 3, ledToVerification: 2, endedUnverified: 1 };
  const payload = { ...statusWith(null), reminders };
  assert.equal(c.surfacePayloadContract('status').validate(payload).ok, true);
  assert.equal(c.surfacePayloadContract('status').validate({ ...payload, reminders: { ...reminders, fired: -1 } }).ok, false);
  const result = { schemaVersion: '1.0', command: 'status', mode: 'full', sidecar: { state: 'running', reasonCode: null, message: null }, workspace: { id: 'w1', root: null }, summary: 'Status.', result: payload };
  assert.match(renderHuman(result), /^reminders \(Stop\): 5 fired, 3 led to a check, 2 led to verification, 1 ended unverified$/m);
  assert.doesNotMatch(renderHuman({ ...result, result: statusWith(null) }), /^reminders/m);
});

test('status shows the sidecar queues when the sidecar reports them (P4 concurrency, B; owner ededdba)', async () => {
  const { renderHuman } = await import('../dist/public/render.js');
  const queue = { hotInFlight: 3, backgroundInFlight: 0, overrun: 0, running: 2, held: 1, queued: 5, spooled: 0 };
  const payload = { ...statusWith(null), queue };
  assert.equal(c.surfacePayloadContract('status').validate(payload).ok, true);
  assert.equal(c.surfacePayloadContract('status').validate({ ...payload, queue: { ...queue, spooled: -1 } }).ok, false);
  assert.equal(c.surfacePayloadContract('status').validate({ ...payload, queue: { ...queue, extra: 1 } }).ok, false);
  const result = { schemaVersion: '1.0', command: 'status', mode: 'full', sidecar: { state: 'running', reasonCode: null, message: null }, workspace: { id: 'w1', root: null }, summary: 'Status.', result: payload };
  assert.match(renderHuman(result), /^queues: 3 hook request\(s\), 0 background; background work: 2 running, 1 held, 5 waiting \(0 spooled\)$/m);
  assert.match(renderHuman({ ...result, result: { ...payload, queue: { ...queue, overrun: 2 } } }), /^queues: 3 hook request\(s\), 0 background \(2 past their deadline, still running\);/m);
  // An older sidecar leaves it out: no line, no error.
  assert.doesNotMatch(renderHuman({ ...result, result: statusWith(null) }), /^queues/m);
  assert.doesNotMatch(renderHuman({ ...result, result: { ...payload, queue: null } }), /^queues/m);
});

test('status shows which model registry routing reads, and a refused override (B, owner 9d6a66d, fail-closed)', async () => {
  const { renderHuman } = await import('../dist/public/render.js');
  const base = statusWith(null);
  const result = (modelRegistry) => ({ schemaVersion: '1.0', command: 'status', mode: 'full', sidecar: { state: 'running', reasonCode: null, message: null }, workspace: { id: 'w1', root: null }, summary: 'Status.', result: { ...base, modelRegistry } });
  const valid = (modelRegistry) => c.surfacePayloadContract('status').validate({ ...base, modelRegistry }).ok;
  assert.equal(valid({ source: 'bundled', snapshotId: 'multi-2026-09-27', reasonCode: null }), true);
  assert.equal(valid({ source: 'refused', snapshotId: null, reasonCode: 'MODEL_REGISTRY_INVALID' }), true);
  assert.equal(valid({ source: 'refused', snapshotId: null, reasonCode: 'BROKEN' }), false);
  assert.equal(valid({ source: 'bundled', snapshotId: 'x', reasonCode: null, path: '/etc' }), false);
  assert.match(renderHuman(result({ source: 'bundled', snapshotId: 'multi-2026-09-27', reasonCode: null })), /^model registry: bundled snapshot multi-2026-09-27$/m);
  assert.match(renderHuman(result({ source: 'override', snapshotId: 'admin-1', reasonCode: null })), /^model registry: administrator override admin-1$/m);
  assert.match(renderHuman(result({ source: 'refused', snapshotId: null, reasonCode: 'MODEL_REGISTRY_NOT_JSON' })), /^model registry: override refused \(MODEL_REGISTRY_NOT_JSON\), routing unavailable;/m);
  // An older sidecar leaves it out: no line, no error.
  assert.doesNotMatch(renderHuman(result(null)), /^model registry/m);
});

test('client-side timeouts count as deadline misses and connection failures as sidecar misses', () => {
  const summary = latencySummary({
    days: 7,
    sinceMs: 0,
    targetMs: 900,
    counters: [
      row('hook', 'claude', 'TIMEOUT', 1, 1502),
      row('hook', 'claude', 'HANDSHAKE_TIMEOUT', 2),
      row('hook', 'claude', 'CONNECT_TIMEOUT', 3),
      row('hook', 'claude', 'BUSY', 4),
      row('hook', 'claude', 'ECONNREFUSED', 5),
      row('hook', 'claude', 'CLOSED', 6),
      row('hook', 'claude', 'CONNECT_FAILED', 7),
      row('hook', 'claude', 'ENOENT', 100),
      row('hook', 'claude', 'STOP_CONTINUATION', 100),
    ],
  });
  assert.equal(summary?.hookDeadlineMisses, 6);
  assert.equal(summary?.hookSidecarMisses, 22);
  assert.equal(summary?.hookSidecarStarting, 0);
});

test('status tells the misses of a sidecar that was starting from the ones it was not', () => {
  // The owner's real week: 27 hooks found no sidecar running and started one.
  const only = latencySummary({ days: 7, sinceMs: 0, targetMs: 900, counters: [row('hook', 'claude', 'SIDECAR_STARTING', 27, 13), row('sidecar-op', 'event', 'LATE_ANSWER', 1, 4757)] });
  assert.equal(only?.hookSidecarMisses, 27);
  assert.equal(only?.hookSidecarStarting, 27);
  assert.deepEqual(latencyLines(only), [
    'latency (last 7 days, target 900 ms): 0 hook deadline misses, 27 hooks the sidecar did not answer (all while it was starting, which is expected after an idle exit or a reinstall), 1 late sidecar answer',
  ]);
  const mixed = latencySummary({ days: 7, sinceMs: 0, targetMs: 900, counters: [row('hook', 'claude', 'SIDECAR_STARTING', 24), row('hook', 'claude', 'SIDECAR_TIMEOUT', 3), row('hook', 'claude', 'SIDECAR_AUTOSTART_OFF', 8)] });
  assert.equal(mixed?.hookSidecarMisses, 27);
  assert.equal(mixed?.hookSidecarStarting, 24);
  assert.deepEqual(latencyLines(mixed), [
    'latency (last 7 days, target 900 ms): 0 hook deadline misses, 27 hooks the sidecar did not answer (24 while it was starting, which is expected after an idle exit or a reinstall; 3 for other reasons), 0 late sidecar answers',
  ]);
  assert.equal(c.surfacePayloadContract('status').validate(statusWith(mixed)).ok, true);
});
