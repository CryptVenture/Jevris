import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';
import { scanRead } from '../../../test/live-files.mjs';

// OBS-01: JSONL traces follow each request from receipt to outcome with stable ids; workspace,
// task, session and delivery ids are keyed HMACs; reason codes are bounded; a grep finds no
// source or secret. OBS-02: counters and a time-limited diagnostic mode. OBS-03: a status-line
// cache written from local state and read without a sidecar round trip.

const { startDaemon, sidecarRequest, openTelemetry, readStatusLine, statusLineText } = await import('../dist/index.js');
const { DIAGNOSTIC_FILE, DIAGNOSTIC_MAX_MS, TRACE_DIR, TRACE_KEY_FILE, TRACE_FILE_MAX_BYTES } = await import('../dist/telemetry.js');
const { jevrisPaths } = await import('@jevris/platform');
const store = await import('@jevris/store');
const { hostScopeId } = await import('../dist/state.js');

const POSIX = process.platform !== 'win32';
const CANARY = ['obs', 'canary', process.pid].join('_');
const SECRET = ['sk', 'live', 'Zx9Qw8Er7Ty6Ui5Op4As3Df2'].join('-');

function traceLines(stateDir) {
  const dir = join(stateDir, TRACE_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean))
    .map((line) => JSON.parse(line));
}

/** Every file under the state directory, as text: the grep test. */
function allText(dir) {
  let text = '';
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = lstatSync(path);
    if (st.isDirectory()) text += allText(path);
    else if (st.isFile() && !name.endsWith('.db') && !name.endsWith('-wal') && !name.endsWith('-shm')) text += scanRead(path, 'utf8');
  }
  return text;
}

test('trace lines keep only bounded codes; ids are keyed HMACs, stable across restarts; files are owner-only (OBS-01)', () => {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'b-trace-')));
  try {
    const first = openTelemetry({ stateDir });
    first.trace({ event: 'unit.step', ws: `/home/me/${CANARY}`, op: 'event', client: 'hook', rid: 'r'.repeat(22), taskId: `task-${CANARY}`, sessionId: CANARY, deliveryKey: CANARY, decisionId: 'dec_123', reasonCode: `lower ${CANARY}`, detail: CANARY, path: `/src/${CANARY}.ts`, prompt: SECRET, ok: true, ms: 12, bytes: 99 });
    first.trace({ event: `Bad Event ${CANARY}`, ws: 'x' });
    const wsId = first.opaqueId('ws', `/home/me/${CANARY}`);
    first.close();
    const second = openTelemetry({ stateDir });
    assert.equal(second.opaqueId('ws', `/home/me/${CANARY}`), wsId, 'the key persists: ids are stable across restarts');
    second.close();

    const lines = traceLines(stateDir);
    assert.equal(lines.length, 1, 'a line with an unbounded event name is not written');
    const [line] = lines;
    assert.equal(line.v, 1);
    assert.equal(line.event, 'unit.step');
    assert.equal(line.ws, wsId);
    assert.match(line.task, /^t_[A-Za-z0-9_-]{16}$/);
    assert.match(line.session, /^s_[A-Za-z0-9_-]{16}$/);
    assert.match(line.delivery, /^k_[A-Za-z0-9_-]{16}$/);
    assert.equal(line.decisionId, 'dec_123', 'Jevris decision ids stay as they are, so jevris explain finds them');
    assert.equal(line.reasonCode, 'OTHER', 'a reason code outside the bounded set');
    assert.equal(Object.hasOwn(line, 'detail'), false);
    assert.equal(Object.hasOwn(line, 'path'), false);
    assert.equal(Object.hasOwn(line, 'prompt'), false);
    assert.equal(Object.hasOwn(line, 'bytes'), false, 'sizes only in diagnostic mode');
    const text = allText(stateDir);
    assert.equal(text.includes(CANARY), false);
    assert.equal(text.includes(SECRET), false);
    if (POSIX) {
      assert.equal(lstatSync(join(stateDir, TRACE_KEY_FILE)).mode & 0o777, 0o600);
      assert.equal(lstatSync(join(stateDir, TRACE_DIR)).mode & 0o777, 0o700);
      for (const name of readdirSync(join(stateDir, TRACE_DIR))) assert.equal(lstatSync(join(stateDir, TRACE_DIR, name)).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('trace files are capped per day and kept seven days (OBS-01)', () => {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'b-trace-cap-')));
  try {
    const dir = join(stateDir, TRACE_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const nowMs = Date.parse('2026-09-20T12:00:00Z');
    writeFileSync(join(dir, 'trace-2026-09-10.jsonl'), '{}\n', { mode: 0o600 });
    writeFileSync(join(dir, 'trace-2026-09-14.jsonl'), '{}\n', { mode: 0o600 });
    writeFileSync(join(dir, 'trace-2026-09-20.jsonl'), Buffer.alloc(TRACE_FILE_MAX_BYTES), { mode: 0o600 });
    const t = openTelemetry({ stateDir, now: () => nowMs });
    t.trace({ event: 'unit.full' });
    assert.equal(t.dropped(), 1, 'the full day drops the line and counts it');
    t.close();
    assert.deepEqual(readdirSync(dir).sort(), ['trace-2026-09-14.jsonl', 'trace-2026-09-20.jsonl'], 'files older than seven days are removed');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('diagnostic mode is explicit, capped at an hour, expires by itself and adds no content (OBS-02)', () => {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'b-diag-')));
  try {
    let nowMs = Date.parse('2026-09-20T12:00:00Z');
    const t = openTelemetry({ stateDir, now: () => nowMs });
    assert.equal(t.diagnostic().active, false);
    const on = t.setDiagnostic(24 * 3_600_000);
    assert.equal(on.active, true);
    assert.equal(on.untilMs, nowMs + DIAGNOSTIC_MAX_MS, 'a day is capped to an hour');
    t.trace({ event: 'unit.diag', bytes: 1234, deadlineMs: 5000, detail: CANARY });
    nowMs += DIAGNOSTIC_MAX_MS + 1;
    assert.equal(t.diagnostic().active, false, 'it turned itself off');
    t.trace({ event: 'unit.after', bytes: 1234 });
    // A hand-edited file claiming more than the cap is not honoured.
    writeFileSync(join(stateDir, DIAGNOSTIC_FILE), JSON.stringify({ schemaVersion: 'jevris-diagnostic-1', setAtMs: nowMs, untilMs: nowMs + 10 * DIAGNOSTIC_MAX_MS }));
    nowMs += 5000;
    assert.equal(t.diagnostic().active, false);
    t.setDiagnostic(10 * 60_000);
    assert.equal(t.setDiagnostic(null).active, false);
    assert.equal(existsSync(join(stateDir, DIAGNOSTIC_FILE)), false);
    t.close();
    const [during, after] = traceLines(stateDir);
    assert.deepEqual([during.diag, during.bytes, during.deadlineMs], [true, 1234, 5000]);
    assert.equal(Object.hasOwn(after, 'bytes'), false);
    assert.equal(allText(stateDir).includes(CANARY), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a request is traced from receipt to outcome; counters, diagnostic mode and the status line work end to end with no source or secret (OBS-01..03)', { skip: managedHostSkip() }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-obs-')));
  const root = join(home, `repo-${CANARY}`);
  mkdirSync(root);
  const stateDir = jevrisPaths({ home }).state;
  const subscribers = [
    {
      name: 'probe',
      handle: (ctx) => {
        ctx.trace({ event: 'probe.decided', taskId: `T-${CANARY}`, decisionId: 'dec_probe_1', reasonCode: 'CONFIDENT', source: `const key = "${SECRET}"` });
        return { ok: true };
      },
    },
  ];
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, engine: null, subscribers, log: () => undefined, limits: { budgetMs: { hot: 60_000, background: 60_000 } }, subscriberSliceMs: 60_000 });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  let statusRunning;
  try {
    await started.daemon.state.startupMaintenance();
    statusRunning = statusLineText(readStatusLine(stateDir), Date.now());
    const envelope = { schemaVersion: '1.0', kind: 'PostToolUse', harness: 'claude-code', sessionId: `sess-${CANARY}`, payload: { source: `function ${CANARY}() { return "${SECRET}"; }` } };
    const sent = await sidecarRequest({ home, op: 'event', scope: 'hook', timeoutMs: 60_000, workspace: root, body: { deliveryKey: `dk-${CANARY}`, envelope } });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const metrics = await sidecarRequest({ home, op: 'metrics', scope: 'cli', body: { sinceHours: 1 } });
    assert.equal(metrics.ok, true, JSON.stringify(metrics));
    assert.equal(metrics.result.decisions.decisions, 0);
    assert.ok(metrics.result.requests.byOp.event.count >= 1);
    assert.equal(typeof metrics.result.requests.byOp.event.p95Ms, 'number');
    // Diagnostic mode is an admin op: a hook cannot turn it on; the CLI can, and it is audited.
    assert.equal((await sidecarRequest({ home, op: 'diagnostic.set', scope: 'hook', timeoutMs: 60_000, body: { minutes: 5 } })).reasonCode, 'SCOPE_DENIED');
    const on = await sidecarRequest({ home, op: 'diagnostic.set', scope: 'cli', body: { minutes: 5, actor: 'tester' } });
    assert.equal(on.ok, true, JSON.stringify(on));
    assert.equal(on.result.active, true);
    assert.equal((await sidecarRequest({ home, op: 'diagnostic.set', scope: 'cli', body: { minutes: 61 } })).reasonCode, 'INVALID_DURATION');
    await sidecarRequest({ home, op: 'status', scope: 'hook', timeoutMs: 60_000, workspace: root, body: {} });
    assert.equal((await sidecarRequest({ home, op: 'diagnostic.set', scope: 'cli', body: { minutes: 0 } })).result.active, false);
  } finally {
    await started.daemon.stop('test');
  }
  try {
    const lines = traceLines(stateDir);
    const outcome = lines.find((l) => l.event === 'request.outcome' && l.op === 'event');
    assert.ok(outcome, JSON.stringify(lines.map((l) => l.event)));
    const rid = outcome.rid;
    const steps = lines.filter((l) => l.rid === rid).map((l) => l.event);
    assert.deepEqual(steps, ['request.received', 'event-recorded', 'probe.decided', 'request.outcome'], 'one request, receipt to outcome');
    const recorded = lines.find((l) => l.rid === rid && l.event === 'event-recorded');
    assert.equal(recorded.hookEvent, 'PostToolUse');
    assert.match(recorded.ws, /^w_/);
    assert.match(recorded.session, /^s_/);
    const decided = lines.find((l) => l.event === 'probe.decided');
    assert.equal(decided.decisionId, 'dec_probe_1');
    assert.match(decided.task, /^t_/);
    assert.equal(outcome.ok, true);
    assert.equal(typeof outcome.ms, 'number');
    assert.ok(lines.some((l) => l.event === 'request.rejected' || l.event === 'request.outcome' && l.reasonCode === 'SCOPE_DENIED'), 'refusals are traced');
    assert.ok(lines.some((l) => l.op === 'status' && l.diag === true), 'diagnostic mode marked the lines while on');

    // The grep test: nothing under the state directory carries the source, the secret or the path.
    const text = allText(stateDir);
    assert.equal(text.includes(CANARY), false, 'no source text, path or raw id');
    assert.equal(text.includes(SECRET), false, 'no secret');

    // OBS-03: the cache was written while running and says stopped now; no sidecar call reads it.
    assert.match(statusRunning, /^jevris: rules-only · 0 decisions today/);
    assert.equal(readStatusLine(stateDir).sidecar, 'stopped');
    assert.equal(statusLineText(readStatusLine(stateDir), Date.now()), 'jevris: sidecar not running (rules-only)');

    const opened = store.openStore({ path: join(jevrisPaths({ home }).data, 'jevris.db'), role: 'sidecar', workspaceId: 'host', hostScope: hostScopeId(home) });
    assert.equal(opened.ok, true);
    try {
      const rows = store.readAudit(opened).filter((row) => row.kind === 'diagnostic.change');
      assert.deepEqual(rows.map((row) => [row.actor, row.detail.state, row.detail.minutes]), [['tester', 'on', 5], ['cli', 'off', 0]]);
    } finally {
      store.closeStore(opened);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the status-line text reads the cache only: a stale file from a dead sidecar reads as not running (OBS-03)', () => {
  const body = { schemaVersion: 'jevris-statusline-1', writtenAtMs: 1_000, pid: 999_999_999, sidecar: 'running', killSwitch: 'clear', decisions: 'jev', store: 'ok', diagnostic: false, today: { decisions: 12, abstentions: 2, fallbacks: 1, costMicroUsd: 46_000 } };
  assert.equal(statusLineText(body, 2_000, () => true), 'jevris: Jev · 12 decisions today · 2 abstained · 1 fell back · $0.05');
  assert.equal(statusLineText(body, 1_000_000, () => false), 'jevris: sidecar not running (rules-only)');
  assert.equal(statusLineText({ ...body, killSwitch: 'stopped' }, 2_000, () => true), 'jevris: stopped (kill switch)');
  assert.equal(statusLineText(undefined, 2_000), 'jevris: sidecar not running (rules-only)');
});
