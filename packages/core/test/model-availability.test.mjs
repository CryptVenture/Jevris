// Found gone (DOMAINS 9d1e7eb, design sections B to G): the machine's record of models a harness or
// provider said are gone, the per-port signal table D and F classify with, and the router's scope.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const core = await import('../dist/index.js');
const contracts = await import('@jevris/contracts');
const {
  MODEL_UNAVAILABLE_SIGNALS, MODEL_SIGNAL_PORTS, classifyModelUnavailable, recordModelUnavailable, loadModelAvailability, clearModelAvailability,
  unavailableModels, modelAvailabilityFile, modelAvailabilityLines, BUNDLED_MODEL_REGISTRY,
} = core;

// pinned-clock: every record here is stamped at this fixed time; the store keeps what it is given.
const T = Date.parse('2026-09-27T12:00:00Z');
const REG = { snapshotId: 'anthropic-2026-09-26' };

async function tempHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'jevris-availability-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

const gone = (home, extra = {}) => recordModelUnavailable({ home, modelId: 'claude-sonnet-5', reasonCode: 'MODEL_GONE', port: 'claude-api', authMode: 'api-key', source: 'provider-call', nowMs: T, registry: REG, ...extra });

test('found gone: one table lists each port\'s signals; a structured signal is enough, a text-matched one needs a certified binary, unreliable ones never count', () => {
  for (const port of contracts.HARNESS_IDS) assert.ok(MODEL_SIGNAL_PORTS.includes(port), `${port} is a signal port`);
  for (const row of MODEL_UNAVAILABLE_SIGNALS) {
    assert.ok(MODEL_SIGNAL_PORTS.includes(row.port));
    assert.equal(row.structured && row.needsCertifiedBinary, false, `${row.port}/${row.signal}: a structured signal needs no certified binary`);
  }
  assert.equal(classifyModelUnavailable({ port: 'claude-api', signal: 'http-404-not-found-error' }), 'MODEL_GONE');
  // A harness's "not found" can come from its own provider config or plan: scoped to it (audit a38e889).
  assert.equal(classifyModelUnavailable({ port: 'opencode', signal: 'provider-model-not-found' }), 'MODEL_NOT_ACCESSIBLE');
  assert.equal(classifyModelUnavailable({ port: 'kilocode', signal: 'provider-model-not-found' }), 'MODEL_NOT_ACCESSIBLE');
  // Claude Code's message cannot tell gone from not accessible: scoped, and only from a certified binary.
  assert.equal(classifyModelUnavailable({ port: 'claude', signal: 'selected-model-issue' }), null);
  assert.equal(classifyModelUnavailable({ port: 'claude', signal: 'selected-model-issue', certified: true }), 'MODEL_NOT_ACCESSIBLE');
  assert.equal(classifyModelUnavailable({ port: 'codex', signal: 'model-not-found', certified: true }), 'MODEL_NOT_ACCESSIBLE');
  // G12: Antigravity's unknown model counts after a capture, scoped like Claude Code's and Codex's.
  assert.equal(classifyModelUnavailable({ port: 'antigravity', signal: 'unknown-model' }), null);
  assert.equal(classifyModelUnavailable({ port: 'antigravity', signal: 'unknown-model', certified: true }), 'MODEL_NOT_ACCESSIBLE');
  // Only the vendor API's structured 404 says gone on every harness.
  assert.deepEqual(MODEL_UNAVAILABLE_SIGNALS.filter((r) => r.reasonCode === 'MODEL_GONE').map((r) => r.port), ['claude-api']);
  assert.equal(classifyModelUnavailable({ port: 'typesafe', signal: 'http-400-bad-request' }), null);
  assert.equal(classifyModelUnavailable({ port: 'claude-api', signal: 'http-500' }), null);
});

test('found gone: record, repeat, load, prune on a new registry snapshot, clear one or all; a malformed file is empty', async (t) => {
  const home = await tempHome(t);
  assert.deepEqual(await loadModelAvailability(home, REG), [], 'no file: nothing is gone');
  const first = await gone(home);
  assert.equal(first.ok, true);
  assert.deepEqual(first.entry, { modelId: 'claude-sonnet-5', reasonCode: 'MODEL_GONE', port: 'claude-api', authMode: 'api-key', source: 'provider-call', firstSeenAt: '2026-09-27T12:00:00.000Z', lastSeenAt: '2026-09-27T12:00:00.000Z', count: 1, registrySnapshotId: REG.snapshotId });
  const again = await gone(home, { nowMs: T + 60_000, source: 'launch' });
  assert.deepEqual([again.entry.count, again.entry.firstSeenAt, again.entry.lastSeenAt, again.entry.source], [2, '2026-09-27T12:00:00.000Z', '2026-09-27T12:01:00.000Z', 'launch']);
  assert.equal((await loadModelAvailability(home, REG)).length, 1);
  if (process.platform !== 'win32') assert.equal((await stat(modelAvailabilityFile(home))).mode & 0o777, 0o600);
  // A refreshed registry leaves the old entries out, and the next write prunes them.
  const next = { snapshotId: 'anthropic-2026-10-30' };
  assert.deepEqual(await loadModelAvailability(home, next), []);
  await gone(home, { modelId: 'claude-opus-5', registry: next });
  const onDisk = JSON.parse(await readFile(modelAvailabilityFile(home), 'utf8'));
  assert.deepEqual(onDisk.entries.map((e) => [e.modelId, e.registrySnapshotId]), [['claude-opus-5', next.snapshotId]]);
  // Clear.
  await gone(home, { registry: next });
  assert.deepEqual(await clearModelAvailability(home, 'claude-haiku-4-5-20251001'), { ok: true, removed: 0 });
  assert.deepEqual(await clearModelAvailability(home, 'claude-opus-5'), { ok: true, removed: 1 });
  assert.deepEqual((await loadModelAvailability(home, next)).map((e) => e.modelId), ['claude-sonnet-5']);
  assert.deepEqual(await clearModelAvailability(home, 'all'), { ok: true, removed: 1 });
  assert.deepEqual(await loadModelAvailability(home, next), []);
  // Invalid input is refused and writes nothing.
  for (const bad of [{ modelId: '../x' }, { reasonCode: 'MODEL_RETIRED' }, { port: 'chatgpt' }, { authMode: 'oauth' }, { source: 'guess' }, { nowMs: Number.NaN }, { registry: { snapshotId: '' } }]) {
    assert.deepEqual(await gone(home, bad), { ok: false, reasonCode: 'INVALID_INPUT' }, JSON.stringify(bad));
  }
  // A malformed, foreign or oversized file reads as empty (never as "everything is gone").
  for (const text of ['{', JSON.stringify({ schemaVersion: 'other', entries: [] }), JSON.stringify({ schemaVersion: 'jevris-model-availability-1', entries: [{ modelId: 'claude-sonnet-5' }] }), 'x'.repeat(70_000)]) {
    await writeFile(modelAvailabilityFile(home), text);
    assert.deepEqual(await loadModelAvailability(home, REG), []);
  }
});

test('found gone: MODEL_GONE applies on every harness; MODEL_NOT_ACCESSIBLE only on its own harness and sign-in, never to an unscoped route', async (t) => {
  const home = await tempHome(t);
  await gone(home);
  await gone(home, { modelId: 'claude-opus-5', reasonCode: 'MODEL_NOT_ACCESSIBLE', port: 'codex', authMode: 'subscription', source: 'launch' });
  const entries = await loadModelAvailability(home, REG);
  assert.deepEqual(unavailableModels(entries), { 'claude-sonnet-5': 'MODEL_GONE' });
  assert.deepEqual(unavailableModels(entries, { harness: 'codex', authMode: 'subscription' }), { 'claude-sonnet-5': 'MODEL_GONE', 'claude-opus-5': 'MODEL_NOT_ACCESSIBLE' });
  assert.deepEqual(unavailableModels(entries, { harness: 'codex', authMode: 'api-key' }), { 'claude-sonnet-5': 'MODEL_GONE' });
  assert.deepEqual(unavailableModels(entries, { harness: 'claude', authMode: 'subscription' }), { 'claude-sonnet-5': 'MODEL_GONE' });
  assert.deepEqual(unavailableModels(entries, { harness: 'codex' }), { 'claude-sonnet-5': 'MODEL_GONE' }, 'an unknown sign-in is not narrowed');
  const lines = modelAvailabilityLines(entries);
  assert.equal(lines.length, 2);
  assert.ok(lines.some((l) => l.startsWith('claude-opus-5 is not recommended on codex with subscription sign-in: not accessible there (MODEL_NOT_ACCESSIBLE')));
  for (const line of lines) assert.match(line, /jevris route learning gone clear restores it\.$/);
});

test('found gone: the router eliminates a gone model at the lifecycle gate, replaces a gone baseline, and lists what it left out', () => {
  const ACCOUNT = 'acct-1';
  const reg = { ...BUNDLED_MODEL_REGISTRY, baselineModelId: 'claude-opus-5', entries: BUNDLED_MODEL_REGISTRY.entries.map((e) => ({ ...e, accountEligibility: [{ accountId: ACCOUNT, eligible: true, checkedAt: '2026-09-22T00:00:00Z' }] })) };
  const policy = (unavailable) => ({ managedAllowlist: null, allowedRegions: ['global'], requiredContextTokens: 50_000, requiredCapabilities: ['tools'], pins: { modelPin: null, effortPin: null }, riskFloorFamilies: null, accountId: ACCOUNT, nowMs: T, ...(unavailable === undefined ? {} : { unavailableModels: unavailable }) });
  const filtered = core.filterCandidates(reg, policy({ 'claude-sonnet-5': 'MODEL_GONE' }));
  assert.deepEqual(filtered.eliminated.find((e) => e.modelId === 'claude-sonnet-5'), { modelId: 'claude-sonnet-5', gate: 'lifecycle' });
  const q = (modelId, lower, point, upper) => ({ modelId, sliceId: 'bounded-edit', lower, point, upper, sourceId: 'holdout-synthetic-1' });
  const route = (unavailable) => core.routeTask({ registry: reg, policy: policy(unavailable), sliceId: 'bounded-edit', volume: { inputTokens: 2_000_000, outputTokens: 200_000 }, assumptions: { verificationMicroUsd: 200_000, reworkMicroUsd: 3_000_000, routingOverheadMicroUsd: 21_000 }, qualityFloor: 0.8, qualities: [q('claude-opus-5', 0.9, 0.94, 0.97), q('claude-sonnet-5', 0.86, 0.9, 0.94)] });
  // Paired: nothing gone, Sonnet 5 is selected and nothing is listed.
  const plain = route(undefined);
  assert.deepEqual([plain.outcome, plain.modelId, plain.unavailable], ['select', 'claude-sonnet-5', undefined]);
  const sonnetGone = route({ 'claude-sonnet-5': 'MODEL_GONE' });
  assert.notEqual(sonnetGone.modelId, 'claude-sonnet-5');
  assert.deepEqual(sonnetGone.unavailable, [{ modelId: 'claude-sonnet-5', reasonCode: 'MODEL_GONE' }]);
  // A gone baseline is replaced the way a retired one is, not kept for a saving argument.
  const baselineGone = route({ 'claude-opus-5': 'MODEL_GONE' });
  assert.deepEqual([baselineGone.outcome, baselineGone.modelId, baselineGone.reasonCode], ['select', 'claude-sonnet-5', 'BASELINE_UNAVAILABLE']);
});

test('found gone: a stale lock (a crashed writer) is taken over; a live one is waited on, then refused without writing', async (t) => {
  const home = await tempHome(t);
  const lock = `${modelAvailabilityFile(home)}.lock`;
  await mkdir(lock, { recursive: true });
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  assert.equal((await gone(home)).ok, true, 'a lock older than 10 s is stale');
  await mkdir(lock);
  assert.deepEqual(await gone(home, { modelId: 'claude-opus-5' }), { ok: false, reasonCode: 'LOCK_BUSY' });
  assert.deepEqual((await loadModelAvailability(home, REG)).map((e) => e.modelId), ['claude-sonnet-5']);
});
