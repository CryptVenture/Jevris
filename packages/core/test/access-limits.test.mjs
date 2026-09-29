// Access limits (coordinator decision 1e88b2b, open points bdfb6e3a; design access-limits.md R60):
// the classifier and its table, the timing rules, the machine record and the one pause check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const core = await import('../dist/index.js');
const contracts = await import('@jevris/contracts');
const {
  ACCESS_SIGNALS, ACCESS_TIMING, ACCESS_LIMITS_CAPS, classifyAccessSignal, accessUntilMs, resetFromHeaders, credentialFingerprint,
  accessScopeOf, recordAccessLimit, readAccessLimits, accessPauseFor, accessLimitNear, pausedModels, clearAccessLimits, recordAccessSuccess,
  clearAccessLimitsForCredential, removeAccessLimits, accessLimitsPath, accessLimitLines, accessBlockedReason, BUNDLED_MODEL_REGISTRY,
} = core;

// pinned-clock: every record here is stamped at this fixed time; the store keeps what it is given.
const T = Date.parse('2026-09-28T12:00:00Z');
const H = 3_600_000;
const D = 24 * H;

async function tempHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'jevris-access-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

const sig = (port, fields = {}) => ({ port, channel: 'structured', certified: false, ...fields });
const txt = (port, text, certified = false, extra = {}) => ({ port, channel: 'error-text', certified, text: contracts.matchAccessText(text, port, T), ...extra });
const cls = (s, mode = 'subscription') => classifyAccessSignal(s, mode, T)?.class ?? null;

test('the signal table: every row id is unique, fits the finding id shape, and names a known port and class', () => {
  const ids = new Set();
  for (const row of ACCESS_SIGNALS) {
    assert.ok(!ids.has(row.signal), `${row.signal} is unique`);
    ids.add(row.signal);
    assert.match(row.signal, /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9_-]*){1,4}$/);
    assert.ok(row.signal.length <= 96);
    assert.ok(contracts.ACCESS_SIGNAL_PORTS.includes(row.port));
    assert.ok(row.class === null || contracts.ACCESS_LIMIT_CLASSES.includes(row.class));
    assert.ok(row.signal.startsWith(`${row.port}.`));
  }
  assert.ok(Object.isFrozen(ACCESS_SIGNALS));
});

test('class truth table: structured signals per port (design 5.2)', () => {
  const rle = (t) => sig('claude', { errorType: 'rate_limit_event', rateLimitType: t, resetAtMs: T + 2 * H });
  assert.equal(cls(rle('five_hour')), 'usage-window');
  assert.equal(classifyAccessSignal(rle('seven_day'), 'subscription', T).weekly, true);
  const opus = classifyAccessSignal(sig('claude', { errorType: 'rate_limit_event', rateLimitType: 'seven_day_opus' }), 'subscription', T);
  assert.deepEqual([opus.class, opus.weekly, opus.family, opus.untilMs], ['usage-window', true, 'opus', T + 7 * D]);
  assert.equal(cls(rle('overage')), 'usage-window');
  assert.equal(cls(sig('claude', { errorType: 'billing_error' })), 'credit-exhausted');
  for (const e of ['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold']) assert.equal(cls(sig('claude', { errorType: e })), 'account-blocked');
  // An assistant rate_limit is a 5-hour window only on a subscription (design 2.2).
  assert.equal(cls(sig('claude', { errorType: 'rate_limit' }), 'subscription'), 'usage-window');
  assert.equal(cls(sig('claude', { errorType: 'rate_limit' }), 'api-key'), 'rate-limit');
  assert.equal(cls(sig('claude', { errorType: 'rate_limit' }), 'unknown'), 'rate-limit');
  assert.equal(cls(sig('claude', { errorType: 'overloaded' })), 'overloaded');
  assert.equal(cls(sig('claude', { errorType: 'server_error' })), 'overloaded');
  for (const e of ['model_not_found', 'cloud_credential_error', 'invalid_request', 'max_output_tokens', 'unknown']) assert.equal(cls(sig('claude', { errorType: e })), null, e);
  // The Agent SDK's APIError (claude-api).
  assert.equal(cls(sig('claude-api', { status: 402, errorType: 'billing_error' })), 'credit-exhausted');
  assert.equal(cls(sig('claude-api', { status: 429, errorType: 'rate_limit_error', errorCode: 'enforced_spend_limit_reached' })), 'credit-exhausted');
  assert.equal(cls(sig('claude-api', { status: 429, errorType: 'rate_limit_error', headers: { 'retry-after': '30' } })), 'rate-limit');
  assert.equal(cls(sig('claude-api', { status: 400, text: contracts.matchAccessText('Your credit balance is too low to access the API', 'claude-api', T) })), 'credit-exhausted');
  assert.equal(cls(sig('claude-api', { status: 400 })), null);
  assert.equal(cls(sig('claude-api', { status: 401 })), 'account-blocked');
  assert.equal(cls(sig('claude-api', { status: 529 })), 'overloaded');
  assert.equal(cls(sig('claude-api', { status: 500 })), 'overloaded');
  assert.equal(cls(sig('claude-api', { status: 403, errorType: 'permission_error' })), null, 'a 403 permission_error is per resource');
  // OpenCode and Kilo: name, statusCode and body codes.
  for (const port of ['opencode', 'kilocode']) {
    assert.equal(cls(sig(port, { errorType: 'ProviderAuthError' })), 'account-blocked');
    assert.equal(cls(sig(port, { errorType: 'APIError', status: 402 })), 'credit-exhausted');
    assert.equal(cls(sig(port, { errorType: 'APIError', status: 401 })), 'account-blocked');
    assert.equal(cls(sig(port, { errorType: 'APIError', status: 429, errorCode: '1113' })), 'credit-exhausted', 'Z.ai 1113 on 429 is credit');
    assert.equal(cls(sig(port, { errorType: 'APIError', status: 429, errorCode: 'insufficient_quota' })), 'credit-exhausted');
    assert.equal(cls(sig(port, { errorType: 'APIError', status: 429, errorCode: 'credit_balance_exhausted' })), 'credit-exhausted');
    assert.equal(cls(sig(port, { errorType: 'APIError', status: 429, errorCode: 'slow_down' })), 'rate-limit', 'OpenAI slow_down is a rate limit');
    assert.equal(cls(sig(port, { errorType: 'APIError', status: 429, errorCode: '1308' })), 'usage-window');
    assert.equal(classifyAccessSignal(sig(port, { errorType: 'APIError', status: 429, errorCode: '1310' }), 'api-key', T).weekly, true);
    assert.equal(cls(sig(port, { errorType: 'APIError', status: 429 })), 'rate-limit');
    assert.equal(cls(sig(port, { errorType: 'APIError', status: 503 })), 'overloaded');
    assert.equal(cls(sig(port, { errorType: 'APIError', status: 400 })), null);
    assert.equal(cls(sig(port, { errorType: 'ProviderModelNotFoundError' })), null);
  }
  // A signal of an unknown port, or a malformed field, classifies nothing.
  assert.equal(cls(sig('gemini-cli', { status: 402 })), null);
  assert.equal(cls(sig('opencode', { errorType: 'APIError', status: 4020 })), null);
});

test('text rows: pinned patterns on error channels, structured first, and OP-4 holds an uncertified credit or blocked text as a timed usage-window', () => {
  const x1 = classifyAccessSignal(txt('codex', "You've hit your usage limit. Upgrade to Pro or try again at Feb 23rd, 2026 9:01 PM."), 'subscription', T);
  assert.deepEqual([x1.class, x1.resetBasis, x1.untilMs], ['usage-window', 'rule', T + 5 * H], 'a zoneless date is not trusted before a certify capture');
  const credit = classifyAccessSignal(txt('codex', 'You exceeded your current quota, please check your plan and billing details.'), 'api-key', T);
  assert.deepEqual([credit.class, credit.heldAsTimed, credit.resetBasis, credit.untilMs], ['usage-window', true, 'rule', T + 5 * H]);
  const certified = classifyAccessSignal(txt('codex', 'You exceeded your current quota, please check your plan and billing details.', true), 'api-key', T);
  assert.deepEqual([certified.class, certified.untilMs, certified.heldAsTimed], ['credit-exhausted', null, false]);
  // Codex's Plus and Pro usage-limit text offers credits: it is a usage window, not a credit exhaustion.
  assert.equal(cls(txt('codex', "You've hit your usage limit. To get more access now, purchase more credits or try again in 3 hours.", true)), 'usage-window');
  assert.equal(classifyAccessSignal(txt('codex', "You've hit your usage limit. Try again in 3 hours."), 'subscription', T).untilMs, T + 3 * H);
  const blocked = classifyAccessSignal(txt('claude', 'Invalid authentication credentials'), 'subscription', T);
  assert.deepEqual([blocked.class, blocked.heldAsTimed], ['usage-window', true]);
  const weekly = classifyAccessSignal(txt('claude', "You've hit your weekly limit"), 'subscription', T);
  assert.deepEqual([weekly.class, weekly.weekly, weekly.untilMs], ['usage-window', true, T + 7 * D]);
  const sonnet = classifyAccessSignal(txt('claude', "You've hit your Sonnet limit"), 'subscription', T);
  assert.deepEqual([sonnet.family, sonnet.weekly], ['sonnet', true]);
  const epoch = Math.floor((T + 2 * H) / 1000);
  const legacy = classifyAccessSignal(txt('claude', `Claude AI usage limit reached|${epoch}`), 'subscription', T);
  assert.deepEqual([legacy.class, legacy.untilMs, legacy.resetBasis], ['usage-window', epoch * 1000, 'reported']);
  assert.equal(cls(txt('claude', 'API Error: Repeated 529 Overloaded errors')), 'overloaded');
  // Antigravity's channel is unproven: its own reset is not trusted until certified.
  const g = classifyAccessSignal(txt('antigravity', 'Quota exceeded. Resets in 2h 30m.'), 'subscription', T);
  assert.deepEqual([g.class, g.resetBasis, g.untilMs], ['usage-window', 'rule', T + 5 * H]);
  const gc = classifyAccessSignal(txt('antigravity', 'Quota exceeded. Resets in 2h 30m.', true), 'subscription', T);
  assert.equal(gc.untilMs, T + 2.5 * H);
  // Negatives: never a pause.
  assert.equal(cls(txt('codex', 'disk quota exceeded')), null);
  assert.equal(cls(txt('antigravity', 'disk quota exceeded')), null);
  assert.equal(cls(txt('codex', 'rate limit in a tool log line')), null);
  // Structured before text: a matched structured row decides, and model_not_found stays model-availability's.
  assert.equal(cls({ ...sig('claude', { errorType: 'billing_error' }), text: contracts.matchAccessText("You've hit your session limit", 'claude', T) }), 'credit-exhausted');
  assert.equal(cls({ ...sig('claude', { errorType: 'model_not_found' }), text: contracts.matchAccessText("You've hit your session limit", 'claude', T) }), null);
  // A text match on a port whose row does not exist classifies nothing.
  assert.equal(cls({ port: 'claude', channel: 'error-text', certified: false, text: { pattern: 'X1', weekly: false, family: null, resetAtMs: null, resetForm: null } }), null);
});

test('timing: OP-1 rate limits, the 5-168 h doubling (OP-11 base), weekly = 7 days, and a past or 9-day reset gives the rule', () => {
  const steps = [0, 1, 2, 3, 4, 5, 6, 9].map((step) => (accessUntilMs({ class: 'usage-window', nowMs: T, step, weekly: false, reportedResetMs: null }) - T) / H);
  assert.deepEqual(steps, [5, 10, 20, 40, 80, 160, 168, 168]);
  assert.equal(accessUntilMs({ class: 'usage-window', nowMs: T, step: 0, weekly: false, reportedResetMs: null, baseHours: 2 }), T + 2 * H);
  assert.equal(accessUntilMs({ class: 'usage-window', nowMs: T, step: 0, weekly: false, reportedResetMs: null, baseHours: 0.01 }), T + 0.25 * H, 'the base is clamped as learningSettings clamps it');
  assert.equal(accessUntilMs({ class: 'usage-window', nowMs: T, step: 3, weekly: true, reportedResetMs: null }), T + 7 * D);
  const rate = [0, 1, 2, 5, 6].map((step) => (accessUntilMs({ class: 'rate-limit', nowMs: T, step, weekly: false, reportedResetMs: null }) - T) / 1000);
  assert.deepEqual(rate, [60, 120, 240, 1920, 3600]);
  assert.equal(accessUntilMs({ class: 'credit-exhausted', nowMs: T, step: 0, weekly: false, reportedResetMs: null }), null);
  const rl = (resetAtMs) => classifyAccessSignal(sig('claude-api', { status: 429, resetAtMs }), 'api-key', T);
  assert.deepEqual([rl(T + 30_000).class, rl(T + 30_000).untilMs, rl(T + 30_000).resetBasis], ['rate-limit', T + 30_000, 'reported']);
  assert.deepEqual([rl(T + 2 * H).class, rl(T + 2 * H).untilMs], ['usage-window', T + 2 * H], 'OP-1: a reset more than 1 h away is a usage window');
  assert.deepEqual([rl(T - 1000).untilMs, rl(T - 1000).resetBasis], [T + 60_000, 'rule'], 'a past reset gives the rule');
  const far = classifyAccessSignal(sig('claude', { errorType: 'rate_limit_event', rateLimitType: 'five_hour', resetAtMs: T + 9 * D }), 'subscription', T);
  assert.deepEqual([far.untilMs, far.resetBasis], [T + 5 * H, 'rule'], 'a reset 9 days away gives the rule');
});

test('resetFromHeaders: retry-after-ms, retry-after, RFC 3339, Go-style durations and epochs, in that order', () => {
  assert.equal(resetFromHeaders({ 'Retry-After-Ms': '1500', 'retry-after': '99' }, T), T + 1500);
  assert.equal(resetFromHeaders({ 'retry-after': '120' }, T), T + 120_000);
  assert.equal(resetFromHeaders({ 'retry-after': 'Mon, 28 Sep 2026 13:00:00 GMT' }, T), T + H);
  assert.equal(resetFromHeaders({ 'anthropic-ratelimit-requests-reset': '2026-09-28T12:10:00Z', 'anthropic-ratelimit-tokens-reset': '2026-09-28T12:20:00Z' }, T), T + 20 * 60_000);
  assert.equal(resetFromHeaders({ 'x-ratelimit-reset-requests': '1s', 'x-ratelimit-reset-tokens': '6m0s' }, T), T + 6 * 60_000);
  assert.equal(resetFromHeaders({ 'x-ratelimit-reset': String(Math.floor((T + H) / 1000)) }, T), T + H);
  assert.equal(resetFromHeaders({ 'x-ratelimit-reset': '30' }, T), T + 30_000);
  assert.equal(resetFromHeaders({ 'anthropic-ratelimit-unified-reset': String(Math.floor((T + 2 * H) / 1000)) }, T), T + 2 * H);
  assert.equal(resetFromHeaders({ 'retry-after': 'soon' }, T), null);
  assert.equal(resetFromHeaders({ 'retry-after': 'x'.repeat(500) }, T), null);
  assert.equal(resetFromHeaders(undefined, T), null);
  assert.equal(resetFromHeaders({ 'content-type': 'application/json' }, T), null);
});

test('credentialFingerprint is the Jev circuit\'s rule and never echoes the key', () => {
  const key = 'sk-test-not-a-real-key-0123456789';
  const fp = credentialFingerprint(key);
  assert.match(fp, /^[0-9a-f]{16}$/);
  assert.equal(fp, contracts.sha256Hex(`jevris-credential\n${key}`).slice(0, 16));
  assert.ok(!key.includes(fp));
  assert.equal(credentialFingerprint(''), null);
  assert.equal(credentialFingerprint(null), null);
});

test('scopes: fixed hosts for Claude Code, Codex and Antigravity; Kilo and OpenCode through the one resolver; an unnamed party has no scope', () => {
  const r = BUNDLED_MODEL_REGISTRY;
  assert.deepEqual(accessScopeOf(r, 'claude', 'claude-opus-5-5', 'subscription'), { harness: 'claude', authMode: 'subscription', servingHost: 'anthropic', modelId: 'claude-opus-5-5', family: 'opus' });
  assert.equal(accessScopeOf(r, 'codex', 'gpt-5.5', 'subscription')?.servingHost, 'openai');
  assert.equal(accessScopeOf(r, 'antigravity', 'gemini-3-pro', 'unknown')?.servingHost, 'google');
  assert.equal(accessScopeOf(r, 'opencode', 'claude-opus-5-5', 'api-key')?.servingHost, 'anthropic');
  assert.equal(accessScopeOf(r, 'opencode', 'somehost/unknown-model', 'api-key'), null, 'an unpinned host records nothing (OP-12)');
  assert.equal(accessScopeOf(r, 'gemini-cli', 'claude-opus-5-5', 'api-key'), null);
  assert.equal(accessScopeOf(r, 'claude', 'claude-opus-5-5', 'weird').authMode, 'unknown');
});

const scope = (over = {}) => ({ harness: 'codex', authMode: 'subscription', servingHost: 'openai', modelId: 'gpt-5.5', family: null, ...over });
const classify = (s, mode = 'subscription', nowMs = T) => classifyAccessSignal(s, mode, nowMs);
const window5h = () => classify(txt('codex', "You've hit your usage limit."));

test('the record: 0600 file, stable keys, a hit in force changes only lastSeen and count, a re-hit after expiry doubles, and success resets it', async (t) => {
  const home = await tempHome(t);
  const first = await recordAccessLimit({ home, scope: scope(), classification: window5h(), source: 'owned-run', nowMs: T });
  assert.equal(first.ok, true);
  assert.equal(first.outcome, 'new');
  assert.deepEqual(first.entry.scope, { harness: 'codex', authMode: 'subscription', servingHost: 'openai', modelId: null, family: null }, 'a window is scope-wide');
  assert.equal(first.entry.untilMs, T + 5 * H);
  if (process.platform !== 'win32') {
    assert.equal((await stat(accessLimitsPath(home))).mode & 0o777, 0o600);
    assert.equal((await stat(join(accessLimitsPath(home), '..'))).mode & 0o777, 0o700);
  }
  const seen = await recordAccessLimit({ home, scope: scope(), classification: window5h(), source: 'owned-run', nowMs: T + H });
  assert.deepEqual([seen.outcome, seen.entry.untilMs, seen.entry.count, seen.entry.key], ['seen', T + 5 * H, 2, first.entry.key]);
  const later = T + 6 * H;
  const rehit = await recordAccessLimit({ home, scope: scope(), classification: classify(txt('codex', "You've hit your usage limit."), 'subscription', later), source: 'owned-run', nowMs: later });
  assert.deepEqual([rehit.outcome, rehit.entry.step, rehit.entry.untilMs, rehit.entry.key], ['re-hit', 1, later + 10 * H, first.entry.key]);
  // A re-hit more than 7 days after the last expiry starts again at step 0.
  const muchLater = later + 10 * H + 8 * D;
  const fresh = await recordAccessLimit({ home, scope: scope(), classification: classify(txt('codex', "You've hit your usage limit."), 'subscription', muchLater), source: 'owned-run', nowMs: muchLater });
  assert.deepEqual([fresh.entry.step, fresh.entry.untilMs], [0, muchLater + 5 * H]);
  // A rate limit keeps the run's model; overloaded is never recorded.
  const rate = await recordAccessLimit({ home, scope: scope(), classification: classify(txt('codex', '429 Too Many Requests'), 'subscription', muchLater), source: 'owned-run', nowMs: muchLater });
  assert.equal(rate.entry.scope.modelId, 'gpt-5.5');
  const over = await recordAccessLimit({ home, scope: scope(), classification: classify(txt('codex', 'upstream 503'), 'subscription', muchLater), source: 'owned-run', nowMs: muchLater });
  assert.deepEqual(over, { ok: false, reasonCode: 'NOT_A_PAUSE' });
  // No text field is ever written.
  const disk = JSON.parse(await readFile(accessLimitsPath(home), 'utf8'));
  assert.equal(disk.schemaVersion, 'jevris-access-limits-1');
  for (const e of disk.entries) assert.deepEqual(Object.keys(e).sort(), ['class', 'count', 'fingerprint', 'firstSeenMs', 'lastSeenMs', 'resetBasis', 'scope', 'signal', 'source', 'step', 'untilMs', 'weekly']);
  assert.ok(!JSON.stringify(disk).includes('usage limit'));
  // Success on the scope clears every class (OP-2).
  const cleared = await recordAccessSuccess(home, scope(), muchLater + 1);
  assert.equal(cleared.cleared.length, 2);
  assert.equal((await readAccessLimits(home)).entries.length, 0);
});

test('matching: unknown sign-in only ever widens, models and families narrow, several pauses pick the latest or the untimed', async (t) => {
  const home = await tempHome(t);
  await recordAccessLimit({ home, scope: scope({ authMode: 'unknown' }), classification: window5h(), source: 'session', nowMs: T });
  let { entries } = await readAccessLimits(home);
  assert.ok(accessPauseFor(entries, scope({ authMode: 'api-key' }), T + 1), 'an unknown record matches an API key');
  assert.ok(accessPauseFor(entries, scope({ authMode: 'subscription' }), T + 1), 'and a subscription');
  assert.equal(accessPauseFor(entries, scope({ harness: 'opencode' }), T + 1), null, 'another harness is another scope');
  assert.equal(accessPauseFor(entries, scope({ servingHost: 'anthropic' }), T + 1), null);
  assert.equal(accessPauseFor(entries, scope(), T + 5 * H), null, 'expired at read time');
  assert.ok(accessPauseFor(entries, { ...scope(), harness: null }, T + 1), 'advice that names no harness is narrowed by any');

  const home2 = await tempHome(t);
  await recordAccessLimit({ home: home2, scope: scope({ authMode: 'api-key' }), classification: window5h(), source: 'owned-run', nowMs: T });
  ({ entries } = await readAccessLimits(home2));
  assert.equal(accessPauseFor(entries, scope({ authMode: 'subscription' }), T + 1), null, 'an API-key pause leaves the subscription');
  assert.ok(accessPauseFor(entries, scope({ authMode: 'unknown' }), T + 1), 'an unknown query matches any mode');

  const home3 = await tempHome(t);
  const claude = { harness: 'claude', authMode: 'subscription', servingHost: 'anthropic' };
  await recordAccessLimit({ home: home3, scope: { ...claude, modelId: 'claude-opus-5-5', family: 'opus' }, classification: classify(sig('claude', { errorType: 'rate_limit_event', rateLimitType: 'seven_day_opus' })), source: 'owned-run', nowMs: T });
  await recordAccessLimit({ home: home3, scope: { ...claude, modelId: 'claude-sonnet-5', family: 'sonnet' }, classification: classify(sig('claude', { errorType: 'rate_limit', }), 'api-key'), source: 'owned-run', nowMs: T });
  ({ entries } = await readAccessLimits(home3));
  assert.equal(accessPauseFor(entries, { ...claude, modelId: 'claude-opus-5', family: 'opus' }, T + D)?.class, 'usage-window', 'a family pause covers every model of it');
  assert.equal(accessPauseFor(entries, { ...claude, modelId: 'claude-haiku-4-5-20251001', family: 'haiku' }, T + 1), null);
  assert.equal(accessPauseFor(entries, { ...claude, modelId: 'claude-sonnet-5', family: 'sonnet' }, T + 1)?.class, 'rate-limit', 'a rate limit pauses its model');
  const paused = pausedModels(entries, ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'], (m) => accessScopeOf(BUNDLED_MODEL_REGISTRY, 'claude', m, 'subscription'), T + 1);
  assert.deepEqual(Object.keys(paused).sort(), ['claude-opus-5-5', 'claude-sonnet-5']);
  assert.equal(paused['claude-opus-5-5'].untilMs, T + 7 * D);
  // An untimed pause wins over a timed one.
  await recordAccessLimit({ home: home3, scope: { ...claude, modelId: null, family: null }, classification: classify(sig('claude', { errorType: 'billing_error' })), source: 'owned-run', nowMs: T });
  ({ entries } = await readAccessLimits(home3));
  const top = accessPauseFor(entries, { ...claude, modelId: 'claude-opus-5-5', family: 'opus' }, T + 1);
  assert.deepEqual([top.class, top.untilMs], ['credit-exhausted', null]);
  assert.equal(entries[0].untilMs, null, 'untimed entries sort first');
  assert.ok(accessLimitNear(entries, { ...claude, modelId: 'claude-haiku-4-5-20251001', family: 'haiku' }, T + 30 * D, 24 * H) === false);
  assert.ok(accessLimitNear(entries, { ...claude, modelId: 'claude-opus-5-5', family: 'opus' }, T + 20 * H, 24 * H));
  assert.equal(accessLimitLines(entries, T + 1)[0], 'claude subscription anthropic: credit-exhausted since 2026-09-28T12:00Z; clears with jevris route limits clear (owned-run)');
  assert.equal(accessBlockedReason(top), 'ACCESS_LIMITED: credit-exhausted on claude subscription anthropic since 2026-09-28; clears with jevris route limits clear; once cleared it is resumed if owned workers run automatically and its checks are still approved');
  assert.equal(accessBlockedReason(top, { autoResume: false }), 'ACCESS_LIMITED: credit-exhausted on claude subscription anthropic since 2026-09-28; clears with jevris route limits clear; it was already resumed once, so a person starts it again');
  // D's 5ddbd276, now in core: only the paths that exist for the entry are named.
  const { untimedClearText, untimedClearTextFor, accessNewKeyClears, ACCESS_UNTIMED_CLEAR_HELP } = core;
  const at = (harness, authMode, fingerprint = null) => ({ scope: { harness, authMode }, fingerprint });
  assert.equal(untimedClearText(at('claude', 'api-key', '0123456789abcdef')), 'clears when the API key Jevris passes changes, or with jevris route limits clear');
  assert.equal(untimedClearText(at('codex', 'api-key', '0123456789abcdef')), 'clears when the API key Jevris passes changes, or with jevris route limits clear');
  // G-9 (D's trace 3): the maker key Jevris passes to a direct Kilo or OpenCode run counts too, named by its serving host; Antigravity has none.
  assert.equal(untimedClearText({ scope: { harness: 'kilocode', authMode: 'api-key', servingHost: 'moonshot' }, fingerprint: '0123456789abcdef' }), 'clears when the moonshot API key Jevris passes changes, or with jevris route limits clear');
  assert.equal(untimedClearText({ scope: { harness: 'opencode', authMode: 'api-key', servingHost: 'zai' }, fingerprint: '0123456789abcdef' }), 'clears when the zai API key Jevris passes changes, or with jevris route limits clear');
  assert.equal(untimedClearText({ scope: { harness: 'kilocode', authMode: 'api-key', servingHost: 'moonshot' }, fingerprint: null }), 'clears with jevris route limits clear', 'no key Jevris passed');
  assert.equal(untimedClearText({ scope: { harness: 'antigravity', authMode: 'api-key', servingHost: 'google' }, fingerprint: '0123456789abcdef' }), 'clears with jevris route limits clear', 'Antigravity reads its own key');
  assert.equal(untimedClearText(at('claude', 'api-key')), 'clears with jevris route limits clear', 'a key Jevris does not pass');
  assert.equal(untimedClearText(at('claude', 'unknown')), 'clears when a session turn on it finishes, or with jevris route limits clear');
  assert.equal(untimedClearText(at('claude', 'subscription')), 'clears with jevris route limits clear');
  assert.deepEqual([accessNewKeyClears(at('codex', 'api-key', '0123456789abcdef')), accessNewKeyClears(at('codex', 'subscription', '0123456789abcdef'))], [true, false]);
  assert.equal(untimedClearTextFor({ authMode: 'api-key' }, true), untimedClearText(at('claude', 'api-key', '0123456789abcdef')));
  // An owned run through a pinned host records the host's own key (OPENROUTER_API_KEY), so a new one clears it and the text names the host.
  const onHost = (harness, servingHost, authMode, fingerprint = null) => ({ scope: { harness, authMode, servingHost }, fingerprint });
  assert.equal(untimedClearText(onHost('opencode', 'openrouter', 'api-key', '0123456789abcdef')), 'clears when the openrouter API key Jevris passes changes, or with jevris route limits clear');
  assert.equal(untimedClearText(onHost('kilocode', 'openrouter', 'api-key', '0123456789abcdef')), 'clears when the openrouter API key Jevris passes changes, or with jevris route limits clear');
  assert.equal(untimedClearText(onHost('opencode', 'openrouter', 'api-key')), 'clears with jevris route limits clear', 'a host key Jevris does not pass');
  assert.equal(untimedClearText(onHost('opencode', 'moonshot', 'api-key', '0123456789abcdef')), 'clears when the moonshot API key Jevris passes changes, or with jevris route limits clear', 'a direct run names its maker (G-9)');
  assert.equal(untimedClearText(onHost('opencode', 'openrouter', 'unknown')), 'clears when a session turn on it finishes, or with jevris route limits clear');
  assert.deepEqual([accessNewKeyClears(onHost('opencode', 'openrouter', 'api-key', '0123456789abcdef')), accessNewKeyClears(onHost('opencode', 'openrouter', 'subscription', '0123456789abcdef'))], [true, false]);
  assert.equal(untimedClearText(onHost('claude', 'anthropic', 'api-key', '0123456789abcdef')), untimedClearText(at('claude', 'api-key', '0123456789abcdef')), 'a maker host is not named');
  for (const text of [...accessLimitLines(entries, T + 1), accessBlockedReason(top), ACCESS_UNTIMED_CLEAR_HELP]) assert.doesNotMatch(text, /successful run|clears on a new key/);
  // A timed pause names its end and the one automatic resume (D's R76), which needs automatic owned workers.
  const timed = accessBlockedReason({ class: 'usage-window', untilMs: T + 7 * D, entry: entries.find((e) => e.untilMs !== null) });
  assert.match(timed, / paused until 2026-10-05T12:00Z \((reported|rule)\); resumed once then if owned workers run automatically and its checks are still approved, else start it again then$/);
  // OP-5: after the one automatic resume, a limit again promises none.
  assert.match(accessBlockedReason({ class: 'usage-window', untilMs: T + 7 * D, entry: entries.find((e) => e.untilMs !== null) }, { autoResume: false }), /\); it was already resumed once, so a person starts it again after that$/);
  assert.doesNotMatch(timed, /resumes automatically|will resume/, 'the resume is never promised without its condition');
});

test('fingerprints: a new key clears an untimed pause of its scope, and OP-3 carries a dead API key across harnesses', async (t) => {
  const home = await tempHome(t);
  const oldKey = credentialFingerprint('old-key-value-for-test');
  const newKey = credentialFingerprint('new-key-value-for-test');
  const kilo = { harness: 'kilocode', authMode: 'api-key', servingHost: 'anthropic', modelId: 'claude-sonnet-5', family: 'sonnet' };
  const credit = classify(sig('kilocode', { errorType: 'APIError', status: 402 }), 'api-key');
  const rec = await recordAccessLimit({ home, scope: kilo, classification: credit, source: 'owned-run', nowMs: T, fingerprint: oldKey });
  assert.equal(rec.entry.fingerprint, oldKey);
  let { entries } = await readAccessLimits(home);
  assert.ok(accessPauseFor(entries, kilo, T + D, { fingerprint: oldKey }));
  assert.equal(accessPauseFor(entries, kilo, T + D, { fingerprint: newKey }), null, 'a new key is not paused');
  // OP-3: the same key on another harness to the same host.
  const oc = { ...kilo, harness: 'opencode' };
  assert.ok(accessPauseFor(entries, oc, T + D, { fingerprint: oldKey }));
  assert.equal(accessPauseFor(entries, oc, T + D, { fingerprint: newKey }), null);
  assert.equal(accessPauseFor(entries, oc, T + D), null, 'without the key there is no cross-harness match');
  const cleared = await clearAccessLimitsForCredential(home, kilo, newKey, T + D);
  assert.equal(cleared.cleared.length, 1);
  ({ entries } = await readAccessLimits(home));
  assert.equal(entries.length, 0);
  // A subscription never keeps a fingerprint.
  const sub = await recordAccessLimit({ home, scope: { ...kilo, authMode: 'subscription' }, classification: credit, source: 'owned-run', nowMs: T, fingerprint: oldKey });
  assert.equal(sub.entry.fingerprint, null);
});

test('clear by key, remove, and the caps: malformed or oversized reads as empty; a full file of untimed pauses refuses', async (t) => {
  const home = await tempHome(t);
  const a = await recordAccessLimit({ home, scope: scope(), classification: window5h(), source: 'owned-run', nowMs: T });
  await recordAccessLimit({ home, scope: scope({ harness: 'opencode', servingHost: 'zai', authMode: 'api-key' }), classification: classify(sig('opencode', { errorType: 'APIError', status: 402 }), 'api-key'), source: 'session', nowMs: T });
  const stale = await clearAccessLimits(home, { entries: ['0000000000000000', 'not-a-key'], nowMs: T });
  assert.deepEqual(stale, { ok: true, cleared: [] }, 'an unknown key clears nothing');
  const one = await clearAccessLimits(home, { entries: [a.entry.key], nowMs: T });
  assert.deepEqual(one.cleared.map((c) => c.key), [a.entry.key]);
  assert.equal((await readAccessLimits(home)).entries.length, 1);
  assert.equal((await clearAccessLimits(home, { entries: 'all', nowMs: T })).cleared.length, 1);
  assert.deepEqual(await removeAccessLimits(home), { ok: true, removed: 0 });
  assert.deepEqual(await removeAccessLimits(home), { ok: true, removed: 0 }, 'a missing file is already removed');

  await mkdir(join(accessLimitsPath(home), '..'), { recursive: true });
  await writeFile(accessLimitsPath(home), '{not json');
  assert.deepEqual(await readAccessLimits(home), { entries: [], readable: false, unreadable: 'damaged', full: false });
  await writeFile(accessLimitsPath(home), 'x'.repeat(ACCESS_LIMITS_CAPS.maxBytes + 1));
  assert.equal((await readAccessLimits(home)).readable, false);
  // An entry with a text field (or any unknown field) is dropped on read.
  const good = { scope: { harness: 'codex', authMode: 'subscription', servingHost: 'openai', modelId: null, family: null }, class: 'usage-window', signal: 'codex.text.x1', source: 'owned-run', firstSeenMs: T, lastSeenMs: T, untilMs: T + H, step: 0, weekly: false, resetBasis: 'rule', count: 1, fingerprint: null };
  await writeFile(accessLimitsPath(home), JSON.stringify({ schemaVersion: 'jevris-access-limits-1', entries: [{ ...good, message: "You've hit your usage limit" }, { ...good, signal: 'free text here' }, { ...good, scope: { ...good.scope, servingHost: 'example.com' } }, good] }));
  const read = await readAccessLimits(home);
  assert.equal(read.entries.length, 1);
  assert.equal(read.readable, true);

  // Full: 128 untimed entries refuse a new one; a timed entry would be evicted first.
  const models = BUNDLED_MODEL_REGISTRY.entries.map((m) => m.modelId);
  const hosts = contracts.ACCESS_SERVING_HOSTS;
  const entries = [];
  for (let i = 0; entries.length < ACCESS_LIMITS_CAPS.maxEntries; i++) {
    const h = contracts.HARNESS_IDS[i % 5];
    const host = hosts[Math.floor(i / 5) % hosts.length];
    const mode = contracts.AUTH_MODES[Math.floor(i / (5 * hosts.length)) % 3];
    entries.push({ ...good, scope: { harness: h, authMode: mode, servingHost: host, modelId: null, family: null }, class: 'credit-exhausted', signal: 'opencode.api-error.402', untilMs: null, resetBasis: 'none' });
  }
  await writeFile(accessLimitsPath(home), JSON.stringify({ schemaVersion: 'jevris-access-limits-1', entries }));
  const full = await readAccessLimits(home);
  assert.equal(full.entries.length, 128);
  assert.equal(full.full, true);
  const refused = await recordAccessLimit({ home, scope: scope({ modelId: models[0], harness: 'claude', servingHost: 'anthropic', authMode: 'subscription' }), classification: classify(sig('claude', { errorType: 'rate_limit_event', rateLimitType: 'seven_day_sonnet' })), source: 'owned-run', nowMs: T });
  // The same scope and class may already be present among the generated entries; a new one must refuse.
  assert.ok(refused.ok === false ? refused.reasonCode === 'ACCESS_LIMITS_FULL' : refused.outcome !== 'new');
});

test('pruning: an entry expired more than 7 days ago is dropped on the next write', async (t) => {
  const home = await tempHome(t);
  await recordAccessLimit({ home, scope: scope(), classification: window5h(), source: 'owned-run', nowMs: T });
  const later = T + 5 * H + 8 * D;
  await recordAccessLimit({ home, scope: scope({ harness: 'opencode', servingHost: 'zai', authMode: 'api-key' }), classification: classify(sig('opencode', { errorType: 'APIError', status: 402 }), 'api-key', later), source: 'session', nowMs: later });
  const { entries } = await readAccessLimits(home);
  assert.deepEqual(entries.map((e) => e.scope.harness), ['opencode']);
});

test('invalid input is refused without a write', async (t) => {
  const home = await tempHome(t);
  assert.deepEqual(await recordAccessLimit({ home, scope: scope(), classification: window5h(), source: 'owned-run', nowMs: Number.NaN }), { ok: false, reasonCode: 'INVALID_INPUT' });
  assert.deepEqual(await recordAccessLimit({ home, scope: { ...scope(), harness: null }, classification: window5h(), source: 'owned-run', nowMs: T }), { ok: false, reasonCode: 'ACCESS_SCOPE_UNKNOWN' });
  assert.deepEqual(await recordAccessLimit({ home, scope: scope({ servingHost: 'example.com' }), classification: window5h(), source: 'owned-run', nowMs: T }), { ok: false, reasonCode: 'ACCESS_SCOPE_UNKNOWN' });
  assert.deepEqual(await recordAccessLimit({ home, scope: scope(), classification: { ...window5h(), signal: 'made.up' }, source: 'owned-run', nowMs: T }), { ok: false, reasonCode: 'INVALID_INPUT' });
  // A class the row cannot give is refused: no caller turns a text row into an untimed pause.
  assert.deepEqual(await recordAccessLimit({ home, scope: scope(), classification: { ...window5h(), class: 'credit-exhausted', untilMs: null, resetBasis: 'none' }, source: 'owned-run', nowMs: T }), { ok: false, reasonCode: 'INVALID_INPUT' });
  assert.deepEqual(await recordAccessLimit({ home, scope: scope(), classification: window5h(), source: 'hook', nowMs: T }), { ok: false, reasonCode: 'INVALID_INPUT' });
  // B's LOW 24: only a classification the classifier issued is recorded, frozen as issued. A
  // hand-built one (a text credit row, a copy with another reset) is refused.
  const handBuilt = { class: 'credit-exhausted', signal: 'codex.text.x2', structured: false, weekly: false, modelScoped: false, family: null, reportedResetMs: null, untilMs: null, resetBasis: 'none', heldAsTimed: false };
  assert.deepEqual(await recordAccessLimit({ home, scope: scope(), classification: handBuilt, source: 'owned-run', nowMs: T }), { ok: false, reasonCode: 'INVALID_INPUT' });
  assert.deepEqual(await recordAccessLimit({ home, scope: scope(), classification: { ...window5h(), reportedResetMs: T + 4 * D }, source: 'owned-run', nowMs: T }), { ok: false, reasonCode: 'INVALID_INPUT' });
  assert.ok(Object.isFrozen(window5h()));
  await assert.rejects(readFile(accessLimitsPath(home)));
  assert.ok(ACCESS_TIMING.maxStep === 6);
  // A malformed file clears only through `all`, which rewrites it empty.
  await mkdir(join(accessLimitsPath(home), '..'), { recursive: true });
  await writeFile(accessLimitsPath(home), '{not json');
  assert.equal((await clearAccessLimits(home, { entries: ['0000000000000000'], nowMs: T })).ok, false);
  assert.deepEqual(await clearAccessLimits(home, { entries: 'all', nowMs: T }), { ok: true, cleared: [] });
  assert.deepEqual(await readAccessLimits(home), { entries: [], readable: true, unreadable: null, full: false });
});

test('OP-4 on record: a certified text credit signal records an untimed pause; the same text uncertified records a timed usage-window', async (t) => {
  const home = await tempHome(t);
  const quota = 'You exceeded your current quota, please check your plan and billing details.';
  const held = await recordAccessLimit({ home, scope: scope({ authMode: 'api-key' }), classification: classifyAccessSignal(txt('codex', quota), 'api-key', T), source: 'owned-run', nowMs: T });
  assert.deepEqual([held.entry.class, held.entry.untilMs, held.entry.resetBasis], ['usage-window', T + 5 * H, 'rule']);
  const sure = await recordAccessLimit({ home, scope: scope({ authMode: 'api-key' }), classification: classifyAccessSignal(txt('codex', quota, true), 'api-key', T), source: 'owned-run', nowMs: T });
  assert.deepEqual([sure.entry.class, sure.entry.untilMs, sure.entry.resetBasis], ['credit-exhausted', null, 'none']);
});

test('a structured limit with no reset takes only the reset and the weekly marker its text match states (D\'s trace: Claude Code StopFailure)', () => {
  const stop = (text, mode = 'unknown') => classifyAccessSignal({ port: 'claude', channel: 'structured', certified: false, errorType: 'rate_limit', ...(text === null ? {} : { text: contracts.matchAccessText(text, 'claude', T) }) }, mode, T);
  // A 5-hour window whose text names its reset (Claude Code's "usage limit reached|<epoch>"): OP-1 makes it a usage window.
  const resetAt = T + 3 * H;
  const five = stop(`Claude AI usage limit reached|${Math.floor(resetAt / 1000)}`);
  assert.deepEqual([five.class, five.signal, five.structured, five.untilMs, five.resetBasis, five.weekly, five.modelScoped], ['usage-window', 'claude.stream.error.rate-limit', true, resetAt, 'reported', false, false]);
  // A weekly limit with no stated reset: a weekly usage window on the rule (7 days).
  const week = stop("You've hit your weekly limit");
  assert.deepEqual([week.class, week.weekly, week.untilMs, week.resetBasis], ['usage-window', true, T + 7 * D, 'rule']);
  // No reset and no weekly marker: still the 60 s rate limit, model-scoped.
  const none = stop(null);
  assert.deepEqual([none.class, none.untilMs, none.modelScoped], ['rate-limit', T + 60_000, true]);
  assert.equal(stop('Request rejected (429)').class, 'rate-limit');
  // A reset under an hour stays a rate limit, with the stated time.
  const soon = stop(`Claude AI usage limit reached|${Math.floor((T + 20 * 60_000) / 1000)}`);
  assert.deepEqual([soon.class, soon.untilMs, soon.resetBasis], ['rate-limit', T + 20 * 60_000, 'reported']);
  // A past, 9-day or uncertified zoneless reset is ignored: the text still names a usage window,
  // so it is the window on the rule (5 h base), not a 60 s rate limit (D's trace 2, G-6).
  for (const bad of [stop(`Claude AI usage limit reached|${Math.floor((T - H) / 1000)}`), stop(`Claude AI usage limit reached|${Math.floor((T + 9 * D) / 1000)}`)]) {
    assert.deepEqual([bad.class, bad.untilMs, bad.resetBasis, bad.signal], ['usage-window', T + 5 * H, 'rule', 'claude.stream.error.rate-limit']);
  }
  const zoneless = { pattern: 'C1', weekly: false, family: null, resetAtMs: T + 3 * H, resetForm: 'zoneless-date' };
  const unzoned = classifyAccessSignal({ port: 'claude', channel: 'structured', certified: false, errorType: 'rate_limit', text: zoneless }, 'unknown', T);
  assert.deepEqual([unzoned.class, unzoned.untilMs, unzoned.resetBasis], ['usage-window', T + 5 * H, 'rule']);
  const zonedCertified = classifyAccessSignal({ port: 'claude', channel: 'structured', certified: true, errorType: 'rate_limit', text: zoneless }, 'unknown', T);
  assert.deepEqual([zonedCertified.class, zonedCertified.untilMs], ['usage-window', T + 3 * H]);
  // Canary: a credit or blocked text never changes a structured rate limit's class, and nothing of the text is kept.
  const credit = stop("You've hit your monthly spend limit");
  assert.deepEqual([credit.class, credit.untilMs], ['rate-limit', T + 60_000]);
  assert.doesNotMatch(JSON.stringify(five), /usage limit|Claude AI/i);
  // A header reset still wins over the text.
  const headed = classifyAccessSignal({ port: 'claude-api', channel: 'structured', certified: false, status: 429, headers: { 'retry-after': '120' }, text: contracts.matchAccessText(`usage limit reached|${Math.floor(resetAt / 1000)}`, 'claude-api', T) }, 'api-key', T);
  assert.deepEqual([headed.class, headed.untilMs], ['rate-limit', T + 120_000]);
  // Also when the header's reset is the shorter one, and when it is longer.
  const longHeader = classifyAccessSignal({ port: 'claude-api', channel: 'structured', certified: false, status: 429, headers: { 'retry-after': String(5 * 3600) }, text: contracts.matchAccessText(`usage limit reached|${Math.floor((T + 20 * 60_000) / 1000)}`, 'claude-api', T) }, 'api-key', T);
  assert.deepEqual([longHeader.class, longHeader.untilMs], ['usage-window', T + 5 * H]);
});

test('a Claude session or usage limit with no reset is the subscription window on the rule, and a family weekly limit keeps its family (D\'s trace 2, G-6 and G-7)', async (t) => {
  const stop = (text, mode = 'unknown', options = {}) => classifyAccessSignal({ port: 'claude', channel: 'structured', certified: false, errorType: 'rate_limit', text: contracts.matchAccessText(text, 'claude', T) }, mode, T, options);
  // G-6: Claude Code's public "You've hit your session limit" (straight or typographic apostrophe)
  // and "usage limit reached" with no epoch: a usage window on OP-11's base, not model-scoped.
  for (const text of ["You've hit your session limit", 'You\u2019ve hit your session limit \u00b7 resets 3pm', 'Claude AI usage limit reached']) {
    const c = stop(text);
    assert.deepEqual([c.class, c.signal, c.untilMs, c.resetBasis, c.weekly, c.modelScoped, c.family, c.heldAsTimed], ['usage-window', 'claude.stream.error.rate-limit', T + 5 * H, 'rule', false, false, null, false], text);
  }
  assert.equal(stop("You've hit your session limit", 'unknown', { baseHours: 3 }).untilMs, T + 3 * H, 'the base is limitCooldownHours');
  assert.equal(stop("You've hit your session limit", 'subscription').untilMs, T + 5 * H);
  // An API-key rate_limit with a rate-limit text, or no text, keeps the 60 s rate limit.
  assert.deepEqual([stop('Request rejected (429)', 'api-key').class, stop('Request rejected (429)', 'api-key').untilMs], ['rate-limit', T + 60_000]);
  // Kilo or OpenCode: an APIError 429 with no reset whose message is C1's session wording.
  const kilo = classifyAccessSignal({ port: 'kilocode', channel: 'structured', certified: false, errorType: 'APIError', status: 429, text: contracts.matchAccessText("You've hit your session limit", 'kilocode', T) }, 'unknown', T);
  assert.deepEqual([kilo.class, kilo.signal, kilo.untilMs, kilo.modelScoped], ['usage-window', 'kilocode.api-error.429', T + 5 * H, false]);
  // G-7: a weekly limit that names its family keeps the family; one that names none stays broad.
  const opus = stop("You've hit your Opus limit");
  assert.deepEqual([opus.class, opus.weekly, opus.family, opus.untilMs, opus.resetBasis], ['usage-window', true, 'opus', T + 7 * D, 'rule']);
  const sonnet = stop(`You've hit your Sonnet limit \u00b7 usage limit reached|${Math.floor((T + 3 * D) / 1000)}`);
  assert.deepEqual([sonnet.family, sonnet.weekly], ['sonnet', true]);
  const weekly = stop("You've hit your weekly limit");
  assert.deepEqual([weekly.family, weekly.weekly], [null, true]);
  // The record: an Opus weekly entry pauses the Opus models of the scope and not Sonnet; a weekly
  // entry with no family pauses both.
  const home = await tempHome(t);
  const r = BUNDLED_MODEL_REGISTRY;
  const q = (model) => accessScopeOf(r, 'claude', model, 'subscription');
  const rec = await recordAccessLimit({ home, scope: q('claude-opus-5-5'), classification: opus, source: 'session', nowMs: T });
  assert.equal(rec.ok, true);
  assert.deepEqual([rec.entry.scope.family, rec.entry.scope.modelId, rec.entry.weekly], ['opus', null, true]);
  const entries = (await readAccessLimits(home)).entries;
  assert.ok(accessPauseFor(entries, q('claude-opus-5-5'), T + 1));
  assert.ok(accessPauseFor(entries, q('claude-opus-5'), T + 1));
  assert.equal(accessPauseFor(entries, q('claude-sonnet-5'), T + 1), null, 'another family is not paused');
  const broadHome = await tempHome(t);
  await recordAccessLimit({ home: broadHome, scope: q('claude-opus-5-5'), classification: weekly, source: 'session', nowMs: T });
  const broad = (await readAccessLimits(broadHome)).entries;
  assert.ok(accessPauseFor(broad, q('claude-sonnet-5'), T + 1));
  assert.ok(accessPauseFor(broad, q('claude-opus-5-5'), T + 1));
  // Canary: nothing of the text reaches the classification or the record file.
  const canary = stop("You've hit your session limit <canary-c2-g6>");
  assert.equal(canary.class, 'usage-window');
  await recordAccessLimit({ home, scope: q('claude-sonnet-5'), classification: canary, source: 'session', nowMs: T });
  const onDisk = await readFile(accessLimitsPath(home), 'utf8');
  assert.doesNotMatch(JSON.stringify([canary, opus, sonnet, weekly]) + onDisk, /canary|hit your|session limit|usage limit|Opus limit/i);
});

test('a text-timed limit is recorded with its pattern-free row and shown with its class and time only', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'jevris-access-text-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const resetAt = T + 3 * H;
  const c = classifyAccessSignal({ port: 'claude', channel: 'structured', certified: false, errorType: 'rate_limit', text: contracts.matchAccessText(`Claude AI usage limit reached|${Math.floor(resetAt / 1000)} CANARY-TEXT`, 'claude', T) }, 'unknown', T);
  const scope = accessScopeOf(BUNDLED_MODEL_REGISTRY, 'claude', 'claude-opus-5-5', 'unknown');
  assert.equal((await recordAccessLimit({ home, scope, classification: c, source: 'session', nowMs: T })).ok, true);
  const raw = await readFile(accessLimitsPath(home), 'utf8');
  assert.doesNotMatch(raw, /CANARY|usage limit|Claude AI/i);
  const [line] = accessLimitLines((await readAccessLimits(home)).entries, T);
  assert.equal(line, 'claude unknown anthropic: usage-window until 2026-09-28T15:00Z (reported) (session)');
});

test('Antigravity rows G4-G8 (Gemini API error sentences): credit and blocked held as timed, rate limit, overloaded never recorded; a quota with a reset stays G1', () => {
  const ag = (text, certified = false) => classifyAccessSignal({ port: 'antigravity', channel: 'error-text', certified, text: contracts.matchAccessText(text, 'antigravity', T) }, 'unknown', T);
  const credit = ag('402 Payment Required: Your Prepay credit balance is depleted. CANARY');
  assert.deepEqual([credit.class, credit.signal, credit.heldAsTimed, credit.untilMs], ['usage-window', 'antigravity.text.g4', true, T + 5 * H], 'OP-4: uncertified credit is held as a timed window');
  assert.deepEqual([ag('Your Prepay credit balance is depleted.', true).class, ag('Your Prepay credit balance is depleted.', true).untilMs], ['credit-exhausted', null]);
  const leaked = ag('Your API key was reported as leaked. Please use another API key.');
  assert.deepEqual([leaked.class, leaked.signal, leaked.heldAsTimed], ['usage-window', 'antigravity.text.g5', true]);
  assert.equal(ag('Your API key was reported as leaked. Please use another API key.', true).class, 'account-blocked');
  // G8 (E's 10c39931): the 401 sentence for a missing, invalid or expired key is a blocked account, held timed until certified.
  const expired = ag('401 Unauthorized: The API key is missing, invalid, or expired. CANARY');
  assert.deepEqual([expired.class, expired.signal, expired.heldAsTimed, expired.untilMs], ['usage-window', 'antigravity.text.g8', true, T + 5 * H]);
  assert.deepEqual([ag('The API key is missing, invalid or expired', true).class, ag('The API key is missing, invalid or expired', true).untilMs], ['account-blocked', null]);
  assert.equal(classifyAccessSignal({ port: 'codex', channel: 'error-text', certified: true, text: contracts.matchAccessText('The API key is missing, invalid, or expired.', 'codex', T) }, 'unknown', T), null, 'Antigravity only');
  const rate = ag('429: You have exceeded the per-minute or per-second request or token limit.');
  assert.deepEqual([rate.class, rate.signal, rate.untilMs, rate.modelScoped], ['rate-limit', 'antigravity.text.g6', T + 60_000, true]);
  const daily = ag('429: You have exceeded your daily quota.');
  assert.deepEqual([daily.class, daily.signal], ['usage-window', 'antigravity.text.g1']);
  const busy = ag('503: The service is temporarily overloaded or down.');
  assert.deepEqual([busy.class, busy.signal, busy.untilMs], ['overloaded', 'antigravity.text.g7', null]);
  // F's R67 fixture: a quota with a stated reset stays G1 (a usage window), never a short rate limit.
  const quota = 'RESOURCE_EXHAUSTED: quota exceeded for this account; resets in 3h 10m <canary>';
  const q = ag(quota);
  assert.deepEqual([q.class, q.signal, q.untilMs, q.resetBasis], ['usage-window', 'antigravity.text.g1', T + 5 * H, 'rule'], 'an uncertified Antigravity reset is not trusted');
  const qc = ag(quota, true);
  assert.deepEqual([qc.class, qc.untilMs, qc.resetBasis], ['usage-window', T + 3 * H + 10 * 60_000, 'reported']);
  // Near-misses match nothing.
  for (const miss of ['disk quota exceeded', '3 per minute', 'error on line 429', 'PERMISSION_DENIED: model not available', '503', 'RESOURCE_EXHAUSTED']) assert.equal(ag(miss), null, miss);
  assert.doesNotMatch(JSON.stringify([credit, leaked, rate, daily, busy, q]), /CANARY|canary|leaked|depleted/i);
});
