// R77 (access-limits design section 10; SPEC §17.3 rows "401 / account restriction" and
// "429 / 529 / transient error"): the Jev circuit's open time follows the server's Retry-After
// (capped at 15 minutes), a 402 disables it until the credential changes, and a 403 disables it as
// an account restriction. The old circuit file still loads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');
const { createDeadline } = await import('@jevris/platform');
const { createSdkTransport, createMockFetch, CONFORMANCE_REQUEST, statusFailure, retryAfterFrom } = provider;
const { JevClient, CircuitBreaker, CIRCUIT_MAX_OPEN_MS } = core;

const KEY = 'test-key-not-a-secret';
const K = 'typesafe:primary';

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

const status = (code, headers = {}) => async () => new Response(JSON.stringify({ error: { type: 'error', message: 'refused' } }), { status: code, headers: { 'content-type': 'application/json', ...headers } });

test('R77: a 429 with retry-after 120 opens the circuit at once for 120 s; retry-after 3600 opens it for 15 minutes', async () => {
  const c = clock();
  const breaker = await CircuitBreaker.load(null, { now: c.now });
  breaker.recordFailure(K, 'rate-limited', null, 120_000);
  assert.equal(breaker.snapshot(K).state, 'open', 'one 429 with a long Retry-After is enough');
  c.advance(119_999);
  assert.equal(breaker.snapshot(K).state, 'open');
  c.advance(1);
  assert.equal(breaker.snapshot(K).state, 'half-open');

  const c2 = clock();
  const b2 = await CircuitBreaker.load(null, { now: c2.now });
  b2.recordFailure(K, 'rate-limited', null, 3_600_000);
  c2.advance(CIRCUIT_MAX_OPEN_MS - 1);
  assert.equal(b2.snapshot(K).state, 'open');
  c2.advance(1);
  assert.equal(b2.snapshot(K).state, 'half-open', 'capped at 15 minutes');

  // A short Retry-After keeps the rule of five in a row, and the open time is never under the cooldown.
  const c3 = clock();
  const b3 = await CircuitBreaker.load(null, { now: c3.now });
  for (let i = 0; i < 4; i++) b3.recordFailure(K, 'rate-limited', null, 1_000);
  assert.equal(b3.snapshot(K).state, 'closed');
  b3.recordFailure(K, 'overloaded', null, 1_000);
  assert.equal(b3.snapshot(K).state, 'open');
  c3.advance(29_999);
  assert.equal(b3.snapshot(K).state, 'open');
  c3.advance(1);
  assert.equal(b3.snapshot(K).state, 'half-open');
});

test('R77: the transport reads the reset headers through core, and a 402 is billing', async () => {
  assert.equal(statusFailure(402), 'billing');
  assert.equal(statusFailure(401), 'auth');
  assert.equal(statusFailure(403), 'forbidden');
  const now = Date.parse('2026-09-28T12:00:00Z'); // pinned-clock: a pure header parse at a fixed time
  assert.equal(retryAfterFrom(new Headers({ 'retry-after': '120' }), now), 120_000);
  assert.equal(retryAfterFrom(new Headers({ 'retry-after-ms': '250' }), now), 250);
  assert.equal(retryAfterFrom(new Headers({ 'x-ratelimit-reset-requests': '6m0s' }), now), 360_000);
  assert.equal(retryAfterFrom(new Headers({ 'content-type': 'text/plain' }), now), null);

  const fetch = createMockFetch({ scenario: 'http-429', retryAfterSeconds: 120 });
  const c = clock();
  const breaker = await CircuitBreaker.load(null, { now: c.now });
  const client = new JevClient({ transport: createSdkTransport({ apiKey: KEY, fetch }), breaker, sleep: async () => {} });
  const result = await client.ask({ request: CONFORMANCE_REQUEST, lane: 'interactive', deadline: createDeadline(5000) });
  assert.equal(result.failure, 'rate-limited');
  assert.equal(breaker.snapshot(K).state, 'open', 'the server asked for 120 s: open now');
  assert.equal(breaker.entry(K).openForMs, 120_000);
});

test('R77: a 402 disables Jev until the credential fingerprint changes (PROVIDER_BILLING), and is never retried', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-circuit-'));
  try {
    const path = join(dir, 'circuit.json');
    const breaker = await CircuitBreaker.load(path);
    let calls = 0;
    const fetch402 = async (...args) => { calls += 1; return status(402)(...args); };
    const client = new JevClient({ transport: createSdkTransport({ apiKey: KEY, fetch: fetch402 }), breaker, credentialFingerprint: 'fp-a', sleep: async () => {} });
    const first = await client.ask({ request: CONFORMANCE_REQUEST, lane: 'background', deadline: createDeadline(5000) });
    assert.equal(first.failure, 'billing');
    assert.equal(first.reasonCode, 'PROVIDER_BILLING');
    assert.equal(calls, 1, 'a 402 is never retried');
    const restarted = await CircuitBreaker.load(path);
    const snap = restarted.snapshot(K, 'fp-a');
    assert.deepEqual([snap.state, snap.disabledReason, snap.reasonCode], ['disabled', 'BILLING', 'PROVIDER_BILLING']);
    const valid = createMockFetch();
    const sameKey = await new JevClient({ transport: createSdkTransport({ apiKey: KEY, fetch: valid }), breaker: restarted, credentialFingerprint: 'fp-a' }).ask({ request: CONFORMANCE_REQUEST, lane: 'interactive', deadline: createDeadline(5000) });
    assert.equal(sameKey.reasonCode, 'PROVIDER_BILLING');
    assert.equal(valid.calls, 0);
    const newKey = await new JevClient({ transport: createSdkTransport({ apiKey: KEY, fetch: valid }), breaker: restarted, credentialFingerprint: 'fp-b' }).ask({ request: CONFORMANCE_REQUEST, lane: 'interactive', deadline: createDeadline(5000) });
    assert.equal(newKey.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R77: a 403 disables Jev as an account restriction until the credential changes; a transient failure never re-enables it', async () => {
  const breaker = await CircuitBreaker.load(null);
  const fetch = createMockFetch({ scenario: 'http-403' });
  const client = new JevClient({ transport: createSdkTransport({ apiKey: KEY, fetch }), breaker, credentialFingerprint: 'fp-a', sleep: async () => {} });
  const result = await client.ask({ request: CONFORMANCE_REQUEST, lane: 'background', deadline: createDeadline(5000) });
  assert.equal(result.failure, 'forbidden');
  assert.equal(fetch.calls, 1);
  const snap = breaker.snapshot(K, 'fp-a');
  assert.deepEqual([snap.state, snap.disabledReason, snap.reasonCode], ['disabled', 'ACCOUNT', 'PROVIDER_DISABLED']);
  for (let i = 0; i < 6; i++) breaker.recordFailure(K, 'server', 'fp-a');
  assert.equal(breaker.snapshot(K, 'fp-a').state, 'disabled');
  assert.equal(breaker.snapshot(K, 'fp-b').state, 'closed', 'a new credential re-enables it');
});

test('R77: a circuit file written before R77 still loads (no openForMs), and its open time is the cooldown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-circuit-'));
  try {
    const path = join(dir, 'circuit.json');
    const c = clock(5_000_000);
    const old = { state: 'open', consecutiveFailures: 5, consecutiveSuccesses: 0, openedAtMs: 5_000_000, disabledReason: null, configFingerprint: null, lastModel: 'jev-1.13.0', modelChanged: false, updatedAtMs: 5_000_000 };
    const auth = { ...old, state: 'disabled', openedAtMs: null, disabledReason: 'AUTH', configFingerprint: 'fp-a' };
    writeFileSync(path, JSON.stringify({ schemaVersion: 'jevris-circuit-1', entries: { [K]: old, 'typesafe:other': auth } }));
    const breaker = await CircuitBreaker.load(path, { now: c.now });
    assert.equal(breaker.snapshot(K).state, 'open');
    c.advance(30_000);
    assert.equal(breaker.snapshot(K).state, 'half-open');
    assert.deepEqual([breaker.snapshot('typesafe:other', 'fp-a').state, breaker.snapshot('typesafe:other', 'fp-a').disabledReason], ['disabled', 'AUTH']);
    // A stored open time never holds past 15 minutes after the open (a tampered or skewed file).
    writeFileSync(path, JSON.stringify({ schemaVersion: 'jevris-circuit-1', entries: { [K]: { ...old, openForMs: 365 * 86_400_000 } } }));
    const c2 = clock(5_000_000);
    const skewed = await CircuitBreaker.load(path, { now: c2.now });
    c2.advance(CIRCUIT_MAX_OPEN_MS);
    assert.equal(skewed.snapshot(K).state, 'half-open');
    // An open time in the future is clamped to the load time, so it cannot stretch the cap either.
    writeFileSync(path, JSON.stringify({ schemaVersion: 'jevris-circuit-1', entries: { [K]: { ...old, openedAtMs: 5_000_000 + 365 * 86_400_000, openForMs: 86_400_000 } } }));
    const c3 = clock(5_000_000);
    const future = await CircuitBreaker.load(path, { now: c3.now });
    assert.equal(future.snapshot(K).state, 'open');
    c3.advance(CIRCUIT_MAX_OPEN_MS);
    assert.equal(future.snapshot(K).state, 'half-open');
    // An open duration that is negative, not a number, or the earlier absolute `openUntilMs` reads as
    // absent: the cooldown, never an immediate half-open and never a throw (B's review).
    for (const shape of [{ openForMs: -120_000 }, { openForMs: 'soon' }, { openForMs: null }, { openUntilMs: 5_000_000 + 600_000 }, {}]) {
      writeFileSync(path, JSON.stringify({ schemaVersion: 'jevris-circuit-1', entries: { [K]: { ...old, ...shape } } }));
      const cs = clock(5_000_000);
      const loaded = await CircuitBreaker.load(path, { now: cs.now });
      assert.equal(loaded.snapshot(K).state, 'open', JSON.stringify(shape));
      cs.advance(29_999);
      assert.equal(loaded.snapshot(K).state, 'open', JSON.stringify(shape));
      cs.advance(1);
      assert.equal(loaded.snapshot(K).state, 'half-open', JSON.stringify(shape));
      assert.equal('openUntilMs' in loaded.entry(K), false);
    }
    // A bad duration on a disabled entry keeps it disabled.
    writeFileSync(path, JSON.stringify({ schemaVersion: 'jevris-circuit-1', entries: { [K]: { ...auth, openForMs: -1 } } }));
    assert.deepEqual([(await CircuitBreaker.load(path)).snapshot(K, 'fp-a').state], ['disabled']);
    // An unknown disabled reason is dropped, and the entry starts closed.
    writeFileSync(path, JSON.stringify({ schemaVersion: 'jevris-circuit-1', entries: { [K]: { ...auth, disabledReason: 'SOMETHING' } } }));
    assert.equal((await CircuitBreaker.load(path)).snapshot(K, 'fp-a').state, 'closed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R77 follow-up: a person clears a billing or account disable without a new key; a key refusal stays; nothing is called', async () => {
  const { circuitDisabledText, CIRCUIT_REENABLE_COMMAND } = core;
  const c = clock(Date.parse('2026-09-28T12:00:00Z'));
  const breaker = await CircuitBreaker.load(null, { now: c.now });
  assert.deepEqual(breaker.clearDisabled(K), { ok: false, reasonCode: 'NOT_DISABLED' });
  assert.equal(circuitDisabledText(breaker.snapshot(K, 'fp-a')), null);
  for (const [failure, reason, code] of [['billing', 'BILLING', 'PROVIDER_BILLING'], ['forbidden', 'ACCOUNT', 'PROVIDER_DISABLED']]) {
    breaker.recordFailure(K, failure, 'fp-a');
    const snap = breaker.snapshot(K, 'fp-a');
    assert.deepEqual([snap.state, snap.disabledReason, snap.reasonCode, snap.disabledSinceMs], ['disabled', reason, code, c.now()]);
    const text = circuitDisabledText(snap);
    assert.match(text, new RegExp(`^Jev is disabled \\(${code}: [a-z ]+\\) since 2026-09-28T12:00Z; decisions run rules-only\\. After fixing [a-z ]+, run \`${CIRCUIT_REENABLE_COMMAND}\`\\.$`));
    assert.deepEqual(breaker.clearDisabled(K), { ok: true, cleared: reason });
    // Observation first, as after a probe; the same key is admitted again.
    const after = breaker.snapshot(K, 'fp-a');
    assert.deepEqual([after.state, after.automation, after.observation, after.disabledReason], ['observe-only', false, true, null]);
    for (let i = 0; i < 6; i++) breaker.recordSuccess(K, 'jev-1.13.0');
    assert.equal(breaker.snapshot(K, 'fp-a').state, 'closed');
  }
  // A key refusal (401) is never cleared this way.
  breaker.recordFailure(K, 'auth', 'fp-a');
  assert.deepEqual(breaker.clearDisabled(K), { ok: false, reasonCode: 'AUTH_NEEDS_NEW_KEY' });
  assert.match(circuitDisabledText(breaker.snapshot(K, 'fp-a')), /PROVIDER_DISABLED: key refused.*jevris credential set/);
  assert.equal(breaker.snapshot(K, 'fp-a').state, 'disabled');
  assert.deepEqual(breaker.keys(), [K]);
});

test('reenable (ea2af91a): the disable time is recorded and loads safely; a fresh 402 re-disables; AUTH stays across fingerprints', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-circuit-'));
  try {
    const path = join(dir, 'circuit.json');
    const c = clock(Date.parse('2026-09-28T12:00:00Z'));
    const breaker = await CircuitBreaker.load(path, { now: c.now });
    breaker.recordFailure(K, 'billing', 'fp-a');
    const at = c.now();
    c.advance(60_000);
    breaker.recordFailure(K, 'billing', 'fp-a');
    assert.equal(breaker.snapshot(K, 'fp-a').disabledSinceMs, at, 'a repeat keeps the first disable time');
    await breaker.persist();
    assert.equal((await CircuitBreaker.load(path, { now: c.now })).snapshot(K, 'fp-a').disabledSinceMs, at);
    // After a clear, a fresh 402 disables again at once, with no retry and no open state first.
    assert.equal(breaker.clearDisabled(K).ok, true);
    assert.equal(breaker.snapshot(K, 'fp-a').disabledSinceMs, null);
    breaker.recordFailure(K, 'billing', 'fp-a');
    assert.deepEqual([breaker.snapshot(K, 'fp-a').state, breaker.snapshot(K, 'fp-a').disabledSinceMs], ['disabled', c.now()]);
    // An old file (no disabledAtMs), a bad value and a future value load: unknown, unknown, now.
    const base = { state: 'disabled', consecutiveFailures: 0, consecutiveSuccesses: 0, openedAtMs: null, disabledReason: 'BILLING', configFingerprint: 'fp-a', lastModel: null, modelChanged: false, updatedAtMs: at };
    for (const [shape, expected] of [[{}, null], [{ disabledAtMs: 'x' }, null], [{ disabledAtMs: -5 }, null], [{ disabledAtMs: c.now() + 86_400_000 }, c.now()]]) {
      writeFileSync(path, JSON.stringify({ schemaVersion: 'jevris-circuit-1', entries: { [K]: { ...base, ...shape } } }));
      const loaded = await CircuitBreaker.load(path, { now: c.now });
      assert.deepEqual([loaded.snapshot(K, 'fp-a').state, loaded.snapshot(K, 'fp-a').disabledSinceMs], ['disabled', expected], JSON.stringify(shape));
    }
    // AUTH is never lifted, even when the stored fingerprint differs from the key the caller holds.
    writeFileSync(path, JSON.stringify({ schemaVersion: 'jevris-circuit-1', entries: { [K]: { ...base, disabledReason: 'AUTH', configFingerprint: 'fp-old' } } }));
    const auth = await CircuitBreaker.load(path, { now: c.now });
    assert.deepEqual(auth.clearDisabled(K), { ok: false, reasonCode: 'AUTH_NEEDS_NEW_KEY' });
    assert.equal(auth.entry(K).state, 'disabled');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reenable (ea2af91a): the engine exposes its own circuit; the clear persists and calls nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-circuit-'));
  try {
    const { createDecisionEngine } = core;
    const path = join(dir, 'circuit.json');
    const breaker = await CircuitBreaker.load(path);
    let calls = 0;
    const fetch = async (...args) => { calls += 1; return status(402)(...args); };
    const engine = createDecisionEngine({ transport: createSdkTransport({ apiKey: KEY, fetch }), journalDir: join(dir, 'decisions'), budget: null, breaker, credentialFingerprint: 'fp-a' });
    assert.equal(engine.circuit.snapshot().state, 'closed');
    assert.deepEqual(await engine.circuit.clearDisabled(), { ok: false, reasonCode: 'NOT_DISABLED', persisted: true });
    const key = K;
    breaker.recordFailure(key, 'billing', 'fp-a');
    assert.equal(engine.circuit.snapshot().state, 'disabled');
    const before = calls;
    assert.deepEqual(await engine.circuit.clearDisabled(), { ok: true, cleared: 'BILLING', persisted: true });
    assert.equal(calls, before, 'a clear never calls Jev');
    assert.equal((await CircuitBreaker.load(path)).snapshot(key, 'fp-a').state, 'observe-only', 'the clear is persisted');
    // No provider: no circuit handle.
    assert.equal(createDecisionEngine({ transport: null, journalDir: join(dir, 'd2'), budget: null }).circuit, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
