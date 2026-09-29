// OP-6 (owner decision 2026-09-28, DOMAINS 9deb30c8): a read-only Codex usage reading. Only a band,
// a weekly flag and a validated reset are kept; an exhausted window sets a timed pause; a certified
// reading with none exhausted lifts that sign-in's usage windows (B's stale-snapshot grace kept).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const core = await import('../dist/index.js');
const contracts = await import('@jevris/contracts');
const {
  accessUsageBand, reduceAccessUsage, recordAccessUsageReading, readAccessUsageReadings, accessUsageLines, accessUsagePath,
  removeAccessUsageReadings, resetMachineLearning, recordAccessLimit, readAccessLimits, accessPauseFor, accessScopeOf, classifyAccessSignal,
  issueUsageWindowClassification, liftUsageWindows, accessLimitLines, USAGE_LIFT_GRACE_MS, BUNDLED_MODEL_REGISTRY, ACCESS_SIGNALS,
} = core;

// pinned-clock: every reading and record here is stamped at this fixed time.
const T = Date.parse('2026-09-28T12:00:00Z');
const MIN = 60_000;
const H = 3_600_000;
const D = 24 * H;

async function tempHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'jevris-usage-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

const five = (usedPercent, resetsAtMs = null) => ({ usedPercent, windowMinutes: 300, resetsAtMs });
const week = (usedPercent, resetsAtMs = null) => ({ usedPercent, windowMinutes: 10_080, resetsAtMs });
const reading = (windows, extra = {}) => ({ harness: 'codex', authMode: 'subscription', windows, ordinaryUsageAllowed: true, certified: true, ...extra });
const codexScope = (authMode = 'subscription') => accessScopeOf(BUNDLED_MODEL_REGISTRY, 'codex', 'gpt-5.5', authMode);
const txt = (text, certified = false) => ({ port: 'codex', channel: 'error-text', certified, text: contracts.matchAccessText(text, 'codex', T) });

test('bands: only the band of a used percentage is kept, 100 % or more is exhausted', () => {
  assert.deepEqual(contracts.ACCESS_USAGE_BANDS, ['under-50', '50-80', '80-100', 'exhausted']);
  const cases = [[0, 'under-50'], [49.9, 'under-50'], [50, '50-80'], [79.99, '50-80'], [80, '80-100'], [99.99, '80-100'], [100, 'exhausted'], [140, 'exhausted']];
  for (const [p, band] of cases) assert.equal(accessUsageBand(p), band, String(p));
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '90', null]) assert.equal(accessUsageBand(bad), null);
});

test('reduce: weekly from the window length, a reset only in the future and at most 8 days ahead, a malformed reading is nothing', () => {
  const r = reduceAccessUsage(reading([five(81, T + 2 * H), week(12, T + 9 * D)]), T);
  assert.deepEqual(r, { harness: 'codex', authMode: 'subscription', readAtMs: T, allowed: true, windows: [{ weekly: false, band: '80-100', resetAtMs: T + 2 * H }, { weekly: true, band: 'under-50', resetAtMs: null }] });
  assert.equal(reduceAccessUsage(reading([{ usedPercent: 10, windowMinutes: null, resetsAtMs: T - H }]), T).windows[0].weekly, false);
  assert.equal(reduceAccessUsage(reading([{ usedPercent: 10, windowMinutes: 8640, resetsAtMs: T - H }]), T).windows[0].resetAtMs, null, 'a past reset is dropped');
  for (const bad of [
    reading([]),
    reading([five(1), five(2), five(3)]),
    reading([five(Number.NaN)]),
    reading([five(-5)]),
    reading([five(10)], { harness: 'claude' }),
    reading([five(10)], { authMode: 'root' }),
    reading([null]),
  ]) assert.equal(reduceAccessUsage(bad, T), null);
  assert.doesNotMatch(JSON.stringify(r), /usedPercent|windowMinutes|81|10080/);
});

test('an exhausted window pauses the Codex sign-in until its reported reset, by the rule without one, and the reading is kept for status', async (t) => {
  const home = await tempHome(t);
  const out = await recordAccessUsageReading({ home, reading: reading([five(100, T + 2 * H), week(40, T + 4 * D)], { certified: false }), nowMs: T });
  assert.equal(out.ok, true);
  assert.equal(out.kept, true);
  assert.deepEqual([out.recorded.class, out.recorded.signal, out.recorded.source, out.recorded.untilMs, out.recorded.resetBasis, out.recorded.weekly], ['usage-window', 'codex.usage-read.window', 'usage-read', T + 2 * H, 'reported', false]);
  assert.deepEqual(out.recorded.scope, { harness: 'codex', authMode: 'subscription', servingHost: 'openai', modelId: null, family: null });
  const entries = (await readAccessLimits(home)).entries;
  assert.equal(accessPauseFor(entries, codexScope(), T + H)?.class, 'usage-window');
  assert.equal(accessPauseFor(entries, codexScope('api-key'), T + H), null, 'another sign-in is another scope');
  assert.equal(accessPauseFor(entries, codexScope(), T + 2 * H), null, 'it lifts at the reset');
  assert.match(accessLimitLines(entries, T)[0], /^codex subscription openai: usage-window until 2026-09-28T14:00Z \(reported\) \(usage-read\)$/);
  const kept = await readAccessUsageReadings(home, T + MIN);
  assert.equal(kept.readable, true);
  assert.deepEqual(kept.readings, [{ harness: 'codex', authMode: 'subscription', readAtMs: T, allowed: true, windows: [{ weekly: false, band: 'exhausted', resetAtMs: T + 2 * H }, { weekly: true, band: 'under-50', resetAtMs: T + 4 * D }] }]);
  assert.deepEqual(accessUsageLines(kept.readings), ['codex subscription: short window used up (resets 2026-09-28T14:00Z); weekly window under 50% used (resets 2026-10-02T12:00Z) (read 2026-09-28T12:00Z)']);
  const raw = await readFile(accessUsagePath(home), 'utf8');
  assert.doesNotMatch(raw, /usedPercent|windowMinutes|certified/);
  // Mode bits are POSIX: Windows reports 0o666 for any writable file.
  if (process.platform !== 'win32') assert.equal((await stat(accessUsagePath(home))).mode & 0o777, 0o600);
});

test('both windows exhausted: the one that ends last is the pause; no reset uses the rule (OP-11 base, weekly 7 days)', async (t) => {
  const both = await recordAccessUsageReading({ home: await tempHome(t), reading: reading([five(100, T + 2 * H), week(100, T + 3 * D)]), nowMs: T });
  assert.deepEqual([both.recorded.signal, both.recorded.untilMs, both.recorded.weekly], ['codex.usage-read.weekly', T + 3 * D, true]);
  const rule = await recordAccessUsageReading({ home: await tempHome(t), reading: reading([five(100)]), nowMs: T });
  assert.deepEqual([rule.recorded.untilMs, rule.recorded.resetBasis], [T + 5 * H, 'rule']);
  const base = await recordAccessUsageReading({ home: await tempHome(t), reading: reading([five(100)]), nowMs: T, baseHours: 2 });
  assert.equal(base.recorded.untilMs, T + 2 * H);
  const weekly = await recordAccessUsageReading({ home: await tempHome(t), reading: reading([week(120, T + 9 * D)]), nowMs: T });
  assert.deepEqual([weekly.recorded.untilMs, weekly.recorded.resetBasis], [T + 7 * D, 'rule'], 'a 9-day reset is not trusted');
  const none = await recordAccessUsageReading({ home: await tempHome(t), reading: reading([five(99)], { certified: false }), nowMs: T });
  assert.deepEqual([none.ok, none.recorded, none.lifted], [true, null, []]);
});

test('lift: only a certified reading with none exhausted, only that exact sign-in, only usage-window rows, never within the grace', async (t) => {
  const home = await tempHome(t);
  await recordAccessUsageReading({ home, reading: reading([five(100, T + 2 * H)]), nowMs: T });
  const under = (nowMs, extra = {}) => recordAccessUsageReading({ home, reading: reading([five(10), week(20)], extra), nowMs });
  // B's stale-snapshot guard: a reading 30 s after the pause may predate the hit.
  assert.equal(USAGE_LIFT_GRACE_MS, 2 * MIN);
  assert.deepEqual((await under(T + 30_000)).lifted, []);
  assert.deepEqual((await under(T + 3 * MIN, { certified: false })).lifted, [], 'an uncertified reading never lifts');
  assert.deepEqual((await under(T + 3 * MIN, { authMode: 'unknown' })).lifted, [], 'an unknown sign-in never lifts');
  assert.deepEqual((await under(T + 3 * MIN, { authMode: 'api-key' })).lifted, [], 'another sign-in');
  assert.equal((await readAccessLimits(home)).entries.length, 1);
  const lifted = await under(T + 3 * MIN);
  assert.equal(lifted.lifted.length, 1);
  assert.equal(lifted.lifted[0].class, 'usage-window');
  assert.equal((await readAccessLimits(home)).entries.length, 0);
});

test('ordinaryUsageAllowed (F; Codex: null means unavailable, never infer recovery): false pauses, null never lifts', async (t) => {
  // False with no window exhausted: the window that resets last, else the rule.
  const refused = await recordAccessUsageReading({ home: await tempHome(t), reading: reading([five(60, T + 2 * H), week(70, T + 3 * D)], { ordinaryUsageAllowed: false, certified: false }), nowMs: T });
  assert.deepEqual([refused.recorded.signal, refused.recorded.untilMs, refused.recorded.resetBasis, refused.recorded.weekly], ['codex.usage-read.weekly', T + 3 * D, 'reported', true]);
  assert.match(accessUsageLines([refused.reading])[0], /^codex subscription: usage not allowed; short window 50-80% used/);
  const ruled = await recordAccessUsageReading({ home: await tempHome(t), reading: reading([five(60)], { ordinaryUsageAllowed: false }), nowMs: T });
  assert.deepEqual([ruled.recorded.signal, ruled.recorded.untilMs, ruled.recorded.resetBasis], ['codex.usage-read.window', T + 5 * H, 'rule']);
  // Null or absent: no lift, even certified and under 50 %; an exhausted window still pauses.
  const home = await tempHome(t);
  await recordAccessUsageReading({ home, reading: reading([five(100, T + 2 * H)], { ordinaryUsageAllowed: null }), nowMs: T });
  for (const extra of [{ ordinaryUsageAllowed: null }, { ordinaryUsageAllowed: undefined }]) {
    const out = await recordAccessUsageReading({ home, reading: reading([five(5)], extra), nowMs: T + 10 * MIN });
    assert.deepEqual([out.ok, out.recorded, out.lifted, out.reading.allowed], [true, null, [], null]);
  }
  assert.equal((await readAccessLimits(home)).entries.length, 1);
  assert.equal((await recordAccessUsageReading({ home, reading: reading([five(5)]), nowMs: T + 11 * MIN })).lifted.length, 1, 'true lifts');
});

test('lift keeps rate limits, OP-4 held texts and unknown sign-ins; it takes Codex\'s X1 usage window', async (t) => {
  const scope = codexScope();
  const rec = async (home, classification, s = scope) => assert.equal((await recordAccessLimit({ home, scope: s, classification, source: 'owned-run', nowMs: T })).ok, true);
  const kept = await tempHome(t);
  await rec(kept, classifyAccessSignal(txt('Rate limit reached for requests'), 'subscription', T));
  // X2 credit, uncertified: held as a timed usage window, on a credit row (OP-4).
  const held = classifyAccessSignal(txt('You exceeded your current quota'), 'subscription', T);
  assert.deepEqual([held.class, held.heldAsTimed], ['usage-window', true]);
  await rec(kept, held);
  await rec(kept, classifyAccessSignal(txt("You've hit your usage limit."), 'unknown', T), codexScope('unknown'));
  const out = await recordAccessUsageReading({ home: kept, reading: reading([five(5)]), nowMs: T + 10 * MIN });
  assert.deepEqual([out.ok, out.lifted], [true, []]);
  assert.deepEqual((await readAccessLimits(kept)).entries.map((e) => e.signal).sort(), ['codex.text.x1', 'codex.text.x2', 'codex.text.x4']);
  const x1 = await tempHome(t);
  await rec(x1, classifyAccessSignal(txt("You've hit your usage limit. Try again in 3 hours."), 'subscription', T));
  const lifted = await recordAccessUsageReading({ home: x1, reading: reading([five(5)]), nowMs: T + 10 * MIN });
  assert.equal(lifted.lifted.length, 1);
  assert.equal((await readAccessLimits(x1)).entries.length, 0);
  assert.deepEqual(await liftUsageWindows(x1, codexScope('unknown'), T + H), { ok: false, cleared: [], reasonCode: 'INVALID_INPUT' });
});

test('a pause in force is extended by a later trusted reset and never shortened; an untrusted or 9-day reset extends nothing (B)', async (t) => {
  const home = await tempHome(t);
  const scope = codexScope();
  // X1 with no stated time: the 5 h rule.
  const first = await recordAccessLimit({ home, scope, classification: classifyAccessSignal(txt("You've hit your usage limit."), 'subscription', T), source: 'owned-run', nowMs: T });
  assert.deepEqual([first.entry.untilMs, first.entry.resetBasis], [T + 5 * H, 'rule']);
  // An uncertified zoneless "try again at" is not trusted, so it extends nothing.
  const zoneless = await recordAccessLimit({ home, scope, classification: classifyAccessSignal(txt("You've hit your usage limit. Try again at Oct 1st, 2026 9:01 PM."), 'subscription', T + MIN), source: 'owned-run', nowMs: T + MIN });
  assert.deepEqual([zoneless.outcome, zoneless.entry.untilMs, zoneless.entry.resetBasis], ['seen', T + 5 * H, 'rule']);
  // A 9-day reset is not trusted either.
  const far = await recordUsage(home, [five(100, T + 9 * D)], T + 2 * MIN);
  assert.deepEqual([far.recorded.untilMs, far.recorded.resetBasis, far.recorded.source], [T + 5 * H, 'rule', 'owned-run']);
  // An earlier reported reset never shortens it.
  const sooner = await recordUsage(home, [five(100, T + H)], T + 3 * MIN);
  assert.deepEqual([sooner.recorded.untilMs, sooner.recorded.resetBasis], [T + 5 * H, 'rule']);
  // A later trusted reset extends it, and it is then reported.
  const later = await recordUsage(home, [five(100, T + 2 * D)], T + 4 * MIN);
  assert.deepEqual([later.recorded.untilMs, later.recorded.resetBasis, later.recorded.source, later.recorded.firstSeenMs], [T + 2 * D, 'reported', 'usage-read', T]);
});

test('B\'s LOW 37: an extension never moves an OP-4 held text onto a usage-read row, so a certified reading cannot lift it', async (t) => {
  const home = await tempHome(t);
  const held = classifyAccessSignal(txt('You exceeded your current quota'), 'subscription', T);
  assert.deepEqual([held.class, held.heldAsTimed, held.signal], ['usage-window', true, 'codex.text.x2']);
  const first = await recordAccessLimit({ home, scope: codexScope(), classification: held, source: 'owned-run', nowMs: T });
  assert.equal(first.entry.untilMs, T + 5 * H);
  const extended = await recordUsage(home, [five(100, T + 2 * D)], T + MIN);
  assert.deepEqual([extended.recorded.untilMs, extended.recorded.resetBasis, extended.recorded.signal, extended.recorded.source], [T + 2 * D, 'reported', 'codex.text.x2', 'owned-run']);
  const under = await recordAccessUsageReading({ home, reading: reading([five(10), week(20)]), nowMs: T + 10 * MIN });
  assert.deepEqual(under.lifted, []);
  const left = (await readAccessLimits(home)).entries;
  assert.deepEqual(left.map((e) => [e.signal, e.untilMs]), [['codex.text.x2', T + 2 * D]]);
});

async function recordUsage(home, windows, nowMs) {
  return recordAccessUsageReading({ home, reading: reading(windows, { certified: false }), nowMs });
}

test('a usage reading\'s rows and source go only together; an issued usage classification is timed', async (t) => {
  const home = await tempHome(t);
  const scope = codexScope();
  const issued = issueUsageWindowClassification({ harness: 'codex', weekly: false, resetAtMs: null, nowMs: T });
  assert.deepEqual([issued.class, issued.untilMs, issued.resetBasis, issued.modelScoped], ['usage-window', T + 5 * H, 'rule', false]);
  assert.deepEqual(await recordAccessLimit({ home, scope, classification: issued, source: 'owned-run', nowMs: T }), { ok: false, reasonCode: 'INVALID_INPUT' });
  const x1 = classifyAccessSignal(txt("You've hit your usage limit."), 'subscription', T);
  assert.deepEqual(await recordAccessLimit({ home, scope, classification: x1, source: 'usage-read', nowMs: T }), { ok: false, reasonCode: 'INVALID_INPUT' });
  assert.deepEqual(await recordAccessLimit({ home, scope, classification: { ...issued }, source: 'usage-read', nowMs: T }), { ok: false, reasonCode: 'INVALID_INPUT' }, 'a copy is not issued');
  for (const id of ['codex.usage-read.window', 'codex.usage-read.weekly']) {
    const row = ACCESS_SIGNALS.find((r) => r.signal === id);
    assert.deepEqual([row.port, row.class, row.structured, row.needsCertifiedBinary], ['codex', 'usage-window', true, false]);
  }
});

test('the kept readings: one per sign-in, capped, fail-open on a bad file, pruned after 7 days, removed by reset --machine', async (t) => {
  const home = await tempHome(t);
  for (const [i, authMode] of ['subscription', 'api-key', 'unknown', 'subscription'].entries()) {
    await recordAccessUsageReading({ home, reading: reading([five(10 * i)], { authMode, certified: false }), nowMs: T + i * MIN });
  }
  const kept = await readAccessUsageReadings(home, T + 5 * MIN);
  assert.deepEqual(kept.readings.map((r) => [r.authMode, r.readAtMs]), [['subscription', T + 3 * MIN], ['unknown', T + 2 * MIN], ['api-key', T + MIN]]);
  assert.deepEqual((await readAccessUsageReadings(home, T + 8 * D)).readings, [], 'older than 7 days');
  await writeFile(accessUsagePath(home), '{"schemaVersion":"jevris-access-usage-1","readings":[{"harness":"codex","authMode":"subscription","readAtMs":1,"windows":[{"weekly":false,"band":"exhausted","resetAtMs":null,"text":"x"}]}]}');
  assert.deepEqual(await readAccessUsageReadings(home, T), { readings: [], readable: true }, 'an unknown field drops the reading');
  // B: `allowed` is a boolean or null; a string or a number drops the reading.
  for (const bad of ['"false"', '0', '1', '"true"']) {
    await writeFile(accessUsagePath(home), `{"schemaVersion":"jevris-access-usage-1","readings":[{"harness":"codex","authMode":"subscription","readAtMs":${T},"allowed":${bad},"windows":[{"weekly":false,"band":"exhausted","resetAtMs":null}]}]}`);
    assert.deepEqual(await readAccessUsageReadings(home, T), { readings: [], readable: true }, `allowed ${bad}`);
  }
  await writeFile(accessUsagePath(home), `{"schemaVersion":"jevris-access-usage-1","readings":[{"harness":"codex","authMode":"subscription","readAtMs":${T},"allowed":false,"windows":[{"weekly":false,"band":"exhausted","resetAtMs":null}]}]}`);
  assert.equal((await readAccessUsageReadings(home, T)).readings[0].allowed, false);
  await writeFile(accessUsagePath(home), 'not json');
  assert.deepEqual(await readAccessUsageReadings(home, T), { readings: [], readable: false });
  await writeFile(accessUsagePath(home), `{"schemaVersion":"jevris-access-usage-1","readings":[],"pad":"${'x'.repeat(5000)}"}`);
  assert.equal((await readAccessUsageReadings(home, T)).readable, false, 'oversized');
  assert.deepEqual(await removeAccessUsageReadings(home), { ok: true });
  assert.deepEqual(await readAccessUsageReadings(home, T), { readings: [], readable: true });
  assert.deepEqual(await removeAccessUsageReadings(home), { ok: true }, 'a missing file is already removed');
  await recordAccessUsageReading({ home, reading: reading([five(100)]), nowMs: T });
  const reset = await resetMachineLearning(home);
  assert.equal(reset.ok, true);
  await assert.rejects(stat(accessUsagePath(home)), { code: 'ENOENT' });
});
