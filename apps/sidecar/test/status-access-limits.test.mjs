import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';

// Access limits R79 (design section 11): status carries the machine's access pauses in force, from
// C2's record: a count, the readable and full flags, and at most 16 entries of ids, classes and
// times. No fingerprint, count or text is ever sent. E renders it.

const { startDaemon, sidecarRequest } = await import('../dist/index.js');
const { surfacePayloadContract, matchAccessText } = await import('@jevris/contracts');
const core = await import('@jevris/core');

async function seed(home, nowMs) {
  const signal = { port: 'codex', channel: 'error-text', certified: false, text: matchAccessText("You've hit your usage limit.", 'codex', nowMs) };
  // A usage window covers the whole sign-in on a host (core keeps no model id on it), so the two
  // pauses differ by harness.
  for (const harness of ['codex', 'opencode']) {
    const recorded = await core.recordAccessLimit({
      home,
      scope: { harness, authMode: 'api-key', servingHost: 'openai', modelId: 'gpt-5.5', family: null },
      classification: core.classifyAccessSignal(signal, 'api-key', nowMs),
      source: 'owned-run',
      nowMs,
      fingerprint: 'abcdef0123456789',
    });
    assert.equal(recorded.ok, true, JSON.stringify(recorded));
  }
}

test('status lists the access pauses in force, ids, classes and times only (R79)', { skip: managedHostSkip() }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-limits-status-')));
  const root = join(home, 'ws');
  mkdirSync(root);
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    const ask = async () => {
      const status = await sidecarRequest({ home, op: 'status', scope: 'cli', workspace: root, body: {} });
      assert.equal(status.ok, true, JSON.stringify(status));
      assert.equal(surfacePayloadContract('status').validate(status.result).ok, true);
      return status.result;
    };
    assert.deepEqual((await ask()).accessLimits, { readable: true, full: false, active: 0, entries: [] }, 'no record: nothing in force');

    const nowMs = Date.now();
    await seed(home, nowMs);
    const view = (await ask()).accessLimits;
    assert.equal(view.readable, true);
    assert.equal(view.active, 2);
    assert.equal(view.entries.length, 2);
    // The order is defined: untimed first, then the soonest to lift, then the key. These two lift
    // at the same instant, so the key orders them.
    assert.deepEqual(view.entries.map((e) => e.scope.harness).sort(), ['codex', 'opencode']);
    assert.equal(view.entries[0].until, view.entries[1].until);
    assert.equal(view.entries[0].key < view.entries[1].key, true, 'a tie is ordered by key');
    const first = view.entries.find((e) => e.scope.harness === 'codex');
    assert.deepEqual(Object.keys(first).sort(), ['class', 'key', 'newKeyClears', 'resetBasis', 'scope', 'since', 'source', 'until', 'weekly']);
    // A new key clears an API-key pause only where Jevris passes the key itself: Claude Code, Codex,
    // and (C2's G-9) the maker key of a direct OpenCode or Kilo run; never Antigravity.
    assert.equal(first.newKeyClears, true);
    assert.equal(view.entries.find((e) => e.scope.harness === 'opencode').newKeyClears, true);
    assert.match(first.key, /^[0-9a-f]{16}$/);
    assert.equal(first.source, 'owned-run');
    assert.equal(first.scope.harness, 'codex');
    assert.equal(first.scope.authMode, 'api-key');
    assert.equal(Date.parse(first.until) > nowMs, true, 'a timed pause says when it lifts');
    assert.equal(JSON.stringify(view).includes('abcdef0123456789'), false, 'the fingerprint is never sent');

    // An unreadable record pauses nothing, and says so.
    writeFileSync(core.accessLimitsPath(home), 'not json', { mode: 0o600 });
    assert.deepEqual((await ask()).accessLimits, { readable: false, full: false, active: 0, entries: [] });
  } finally {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  }
});

// OP-6 (E's contract e4bc1fdf, C2's core dc4808b5): status carries the last Codex usage reading per
// sign-in: each window's band, weekly flag and reset, and whether usage was allowed. Never the
// percentage, the payload or whether the read was certified.
test('status shows the kept usage readings, bands only, and an unreadable file as readable false (OP-6)', { skip: managedHostSkip() }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-usage-status-')));
  const root = join(home, 'ws');
  mkdirSync(root);
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    const ask = async () => {
      const status = await sidecarRequest({ home, op: 'status', scope: 'cli', workspace: root, body: {} });
      assert.equal(status.ok, true, JSON.stringify(status));
      assert.equal(surfacePayloadContract('status').validate(status.result).ok, true);
      return status.result;
    };
    assert.deepEqual((await ask()).accessUsage, { readable: true, readings: [] }, 'no file: no readings');

    const nowMs = Date.now();
    const resetsAtMs = nowMs + 2 * 60 * 60 * 1000;
    const recorded = await core.recordAccessUsageReading({
      home,
      reading: { harness: 'codex', authMode: 'subscription', windows: [{ usedPercent: 63, windowMinutes: 300, resetsAtMs }, { usedPercent: 17, windowMinutes: 10_080, resetsAtMs: null }], ordinaryUsageAllowed: true, certified: false },
      nowMs,
    });
    assert.equal(recorded.ok, true, JSON.stringify(recorded));
    const view = (await ask()).accessUsage;
    assert.equal(view.readable, true);
    assert.equal(view.readings.length, 1);
    const [reading] = view.readings;
    assert.deepEqual(Object.keys(reading).sort(), ['allowed', 'authMode', 'harness', 'readAt', 'windows']);
    assert.equal(reading.harness, 'codex');
    assert.equal(reading.authMode, 'subscription');
    assert.equal(reading.allowed, true);
    assert.deepEqual(reading.windows, [
      { weekly: false, band: '50-80', resetsAt: recorded.reading.windows[0].resetAtMs === null ? null : new Date(recorded.reading.windows[0].resetAtMs).toISOString() },
      { weekly: true, band: 'under-50', resetsAt: null },
    ]);
    // No number anywhere in the view (bands and ISO times only), and no raw or certified field.
    const numbers = [];
    const walk = (v) => (typeof v === 'number' ? numbers.push(v) : v !== null && typeof v === 'object' ? Object.values(v).forEach(walk) : undefined);
    walk(view);
    assert.deepEqual(numbers, [], 'never the percentage');
    assert.equal(/usedPercent|windowMinutes|certified/.test(JSON.stringify(view)), false);

    // An unreadable readings file shows as readable false with no readings.
    writeFileSync(core.accessUsagePath(home), 'not json', { mode: 0o600 });
    assert.deepEqual((await ask()).accessUsage, { readable: false, readings: [] });
  } finally {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  }
});
