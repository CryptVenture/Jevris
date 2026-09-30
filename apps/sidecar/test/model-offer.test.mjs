import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';

// The harness model-offer refresh (owner decision DOMAINS 3f090fa): B schedules it while the
// sidecar is idle, one harness at a time and never concurrently with itself; F lists, C records.

const { createModelOfferRefresher, defaultModelOfferPorts, offeredEntries, offerAuthMode, MODEL_OFFER_REFRESH_MS, MODEL_OFFER_LISTING_TIMEOUT_MS, IDLE_QUIET_MS } = await import('../dist/model-offer.js');
const { startDaemon, sidecarRequest } = await import('../dist/index.js');

const DAY = 86_400_000;

function fakePorts(overrides = {}) {
  const calls = [];
  const recorded = [];
  let offer = overrides.offer ?? {};
  const ports = {
    installed: () => overrides.installed ?? ['codex', 'opencode'],
    recordedVersion: (harness) => (overrides.versions ?? {})[harness] ?? null,
    read: () => offer,
    async list({ harness, timeoutMs, signal }) {
      calls.push({ harness, timeoutMs, aborted: signal.aborted });
      if (overrides.list !== undefined) return overrides.list(harness, signal);
      return { ok: true, version: '1.0.0', models: [`${harness}-model-a`, `${harness}-model-b`] };
    },
    record(harness, listing, nowMs) {
      recorded.push({ harness, listing, nowMs });
      offer = { ...offer, [harness]: { version: listing.ok ? listing.version : null, refreshedAtMs: nowMs } };
    },
  };
  return { ports, calls, recorded };
}

test('the refresh is locked to a daily interval and a 10 s listing bound, and waits for 5 s of quiet', () => {
  assert.equal(MODEL_OFFER_REFRESH_MS, DAY);
  assert.equal(MODEL_OFFER_LISTING_TIMEOUT_MS, 10_000);
  assert.equal(IDLE_QUIET_MS, 5_000);
});

test('a harness is due when it has no offer, a stale one, or one listed under another version; others are left alone', async () => {
  const now = 100 * DAY;
  const { ports, calls, recorded } = fakePorts({
    installed: ['codex', 'opencode', 'kilocode', 'claude', 'Bad Name'],
    offer: {
      opencode: { version: '1.0.0', refreshedAtMs: now - 2 * DAY },
      kilocode: { version: '2.0.0', refreshedAtMs: now - 1000 },
      claude: { version: '9.9.9', refreshedAtMs: now - 1000 },
    },
    versions: { kilocode: '2.1.0', claude: '9.9.9' },
  });
  const r = createModelOfferRefresher({ ports, isIdle: () => true, now: () => now });
  const ran = await r.tick();
  assert.deepEqual(ran.map((o) => [o.harness, o.reason, o.models, o.reasonCode]), [
    ['codex', 'missing', 2, null],
    ['opencode', 'stale', 2, null],
    ['kilocode', 'version-changed', 2, null],
  ]);
  assert.deepEqual(calls.map((c) => c.timeoutMs), [10_000, 10_000, 10_000]);
  assert.equal(recorded.length, 3);
  assert.deepEqual(await r.tick(), [], 'nothing is due right after a refresh');
});

test('it runs only while idle, never twice at once, and a busy moment is retried later', async () => {
  let idle = false;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { ports, calls } = fakePorts({ installed: ['codex'], list: async () => (await gate, { ok: true, version: null, models: ['m'] }) });
  const r = createModelOfferRefresher({ ports, isIdle: () => idle, busyRetryMs: 10 });
  assert.deepEqual(await r.tick(), [], 'busy: nothing runs');
  assert.equal(calls.length, 0);
  idle = true;
  const first = r.tick();
  const second = r.tick();
  assert.equal(r.running(), true);
  release();
  assert.equal((await first).length, 1);
  assert.deepEqual(await second, [], 'the second call joins the running one');
  assert.equal(calls.length, 1, 'one listing, not two');
  await r.close();
});

test('a listing that hangs is cut at its bound and recorded as LISTING_TIMEOUT; a bad reason code is replaced; a failure keeps going', async () => {
  const { ports, recorded } = fakePorts({
    installed: ['codex', 'opencode', 'kilocode'],
    list: (harness, signal) => {
      if (harness === 'codex') return new Promise(() => undefined);
      if (harness === 'opencode') return Promise.resolve({ ok: false, reasonCode: 'free text here' });
      return Promise.reject(new Error('boom'));
    },
  });
  const r = createModelOfferRefresher({ ports, isIdle: () => true, listingTimeoutMs: 20 });
  const ran = await r.tick();
  assert.deepEqual(ran.map((o) => [o.harness, o.reasonCode]), [
    ['codex', 'LISTING_TIMEOUT'],
    ['opencode', 'LISTING_FAILED'],
    ['kilocode', 'LISTING_FAILED'],
  ]);
  assert.deepEqual(recorded.map((x) => x.listing), [
    { ok: false, reasonCode: 'LISTING_TIMEOUT' },
    { ok: false, reasonCode: 'LISTING_FAILED' },
    { ok: false, reasonCode: 'LISTING_FAILED' },
  ]);
});

test('close() ends a listing that never settles at once and records nothing for it', async () => {
  let listed;
  const started = new Promise((resolve) => { listed = resolve; });
  const { ports, recorded } = fakePorts({
    installed: ['codex'],
    list: () => {
      listed();
      return new Promise(() => undefined);
    },
  });
  const r = createModelOfferRefresher({ ports, isIdle: () => true, listingTimeoutMs: 60_000 });
  const ran = r.tick();
  await started;
  const t0 = Date.now();
  await r.close();
  assert.deepEqual(await ran, [], 'the cut listing is not an outcome');
  assert.ok(Date.now() - t0 < 10_000, 'close does not wait for the 60 s listing bound');
  assert.deepEqual(recorded, []);
});

test('a session under a new harness version asks for that harness only', async () => {
  const now = 50 * DAY;
  const { ports, calls } = fakePorts({ installed: ['codex', 'opencode'], offer: { codex: { version: '1.0.0', refreshedAtMs: now }, opencode: { version: '3.0.0', refreshedAtMs: now } } });
  const r = createModelOfferRefresher({ ports, isIdle: () => true, now: () => now });
  r.noteHarnessVersion('opencode', '3.0.0');
  r.noteHarnessVersion('codex', '1.1.0');
  for (let i = 0; i < 6_000 && calls.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  await r.tick();
  assert.deepEqual(calls.map((c) => c.harness), ['codex']);
});

test('the sidecar refreshes the offer at its first idle moment after start, and a session with a new harness version refreshes it again', { skip: managedHostSkip() }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-offer-')));
  const repo = join(home, 'repo');
  try {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(repo);
    const { ports, calls } = fakePorts({ installed: ['codex'] });
    const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined, liveCertification: false, modelOffer: ports, modelOfferIdleMs: 0 });
    assert.equal(started.ok, true, started.ok ? '' : started.message);
    try {
      await started.daemon.state.startupMaintenance();
      for (let i = 0; i < 3_000 && calls.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(calls.map((c) => c.harness), ['codex']);
      const envelope = { schemaVersion: '1.0', harness: 'codex', nativeEventName: 'SessionStart', kind: 'session.started', sessionId: 's1', model: null, payload: {}, dedupKey: 'k1' };
      const res = await sidecarRequest({ home, op: 'event', scope: 'hook', workspace: repo, body: { envelope, deliveryKey: 'k1', harnessVersion: '2.0.0' } });
      assert.equal(res.ok, true, JSON.stringify(res));
      for (let i = 0; i < 3_000 && calls.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(calls.map((c) => c.harness), ['codex', 'codex'], 'the new version was listed');
    } finally {
      await started.daemon.stop('test');
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the product ports read C's offer file per harness, newest attempt across sign-ins, and map the detected sign-in", async () => {
  assert.deepEqual(offeredEntries(null), {});
  assert.deepEqual(
    offeredEntries({
      listings: [
        { harness: 'codex', authMode: 'api-key', attemptedAt: '2026-09-20T00:00:00.000Z', harnessVersion: '0.9.0' },
        { harness: 'codex', authMode: 'subscription', attemptedAt: '2026-09-26T00:00:00.000Z', harnessVersion: '1.0.0' },
        { harness: 'opencode', authMode: 'unknown', attemptedAt: 'not a time', harnessVersion: null },
        { harness: 'Bad Name', authMode: 'unknown', attemptedAt: '2026-09-26T00:00:00.000Z', harnessVersion: null },
      ],
    }),
    { codex: { version: '1.0.0', refreshedAtMs: Date.parse('2026-09-26T00:00:00.000Z') } },
  );
  assert.deepEqual(['api-key', 'subscription', 'not-probed', 'none', undefined].map(offerAuthMode), ['api-key', 'subscription', 'unknown', 'unknown', 'unknown']);
  // In a temporary home with no install receipts nothing is installed, and the offer is empty.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-offer-ports-')));
  try {
    const ports = defaultModelOfferPorts(home, { JEVRIS_TEST: '1', JEVRIS_HOME: home });
    assert.deepEqual([...(await ports.installed())], []);
    assert.deepEqual(await ports.read(), {});
    // routing.modelListing off: nothing is installed for the refresh, so nothing is listed.
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { jevrisPaths } = await import('@jevris/platform');
    const { DEFAULT_CONFIG, CONFIG_FILE } = await import('@jevris/orchestrator');
    const config = jevrisPaths({ home }).config;
    mkdirSync(config, { recursive: true });
    const file = join(config, CONFIG_FILE);
    const withListing = (value) => JSON.stringify({ ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, modelListing: value } });
    const offer = await import('@jevris/cli/model-offer');
    const before = await offer.modelListingSetting(home, { JEVRIS_TEST: '1', JEVRIS_HOME: home });
    assert.equal(before, 'on', 'on by default');
    writeFileSync(file, withListing('off'));
    assert.equal(await offer.modelListingSetting(home, { JEVRIS_TEST: '1', JEVRIS_HOME: home }), 'off');
    assert.deepEqual([...(await ports.installed())], [], 'off: no harness is listed');
    writeFileSync(file, withListing('on'));
    // A listing in a test run is refused before any binary starts, and is recorded as such.
    const listed = await ports.list({ harness: 'codex', timeoutMs: 1000, signal: new AbortController().signal });
    assert.equal(listed.ok, false);
    await ports.record('codex', listed, Date.parse('2026-09-27T00:00:00.000Z'));
    const entries = await ports.read();
    assert.equal(entries.codex.refreshedAtMs, Date.parse('2026-09-27T00:00:00.000Z'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
