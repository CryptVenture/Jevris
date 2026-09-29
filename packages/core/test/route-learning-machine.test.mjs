// The machine-wide route-learning layer (C16, SSOT §18.5 as amended 5c29643): general learning
// shared by the workspaces on one machine. Each workspace writes only its own text-free
// contribution and reads everyone else's, capped at the locked prior weight; pins, learning off
// and demotion stay per workspace. Deterministic: no network, no billing, a temporary HOME.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUNDLED_MODEL_REGISTRY,
  MACHINE_PRIOR_WEIGHT,
  MIN_LOCAL_PER_ARM,
  slicePolicy,
  SHARED_SLICE_IDS,
  armPosterior,
  emptyLearningState,
  explainSliceLearning,
  learnFromOutcome,
  loadLearningState,
  loadMachinePrior,
  machineLearningDir,
  pinSlice,
  reconcileLearning,
  resetLearning,
  resetMachineLearning,
  recordModelUnavailable,
  loadModelAvailability,
  modelAvailabilityFile,
  modelOfferFile,
  accessLimitsPath,
  classifyAccessSignal,
  recordAccessLimit,
  accessScopeOf,
  recordModelRun,
  saveLearningState,
  sharedSliceOf,
  usageLimitStatus,
  withdrawMachineContribution,
} from '../dist/index.js';

const SLICE = 'bounded-edit';
const BASE = 'claude-opus-5-5';
const CAND = 'claude-sonnet-5';
const ELIGIBLE = [BASE, CAND];
const NOW = '2026-09-26T12:00:00Z';

let seq = 0;
function event(overrides = {}) {
  seq += 1;
  const kind = overrides.kind ?? 'verified-pass';
  const verified = kind.startsWith('verified');
  return {
    eventId: `ev-${seq}`,
    routeId: `route-${seq}`,
    sliceId: SLICE,
    modelId: BASE,
    rulesModelId: BASE,
    policyVersion: 0,
    kind,
    labelSource: verified ? 'verification-receipt' : kind === 'usage-limited' ? 'harness-limit' : kind,
    receiptId: verified ? `rcpt-${seq}` : null,
    explored: false,
    propensity: 0.95,
    risk: 'low',
    costMicroUsd: 2_000_000,
    latencyMs: 60_000,
    at: new Date(Date.parse('2026-09-26T00:00:00Z') + seq * 1000).toISOString().replace('.000Z', 'Z'),
    authMode: 'api-key',
    ...overrides,
  };
}

async function learn(home, workspaceId, e, settings) {
  const r = await learnFromOutcome({ home, workspaceId, event: e, baselineModelId: BASE, eligibleModelIds: ELIGIBLE, now: NOW, registry: BUNDLED_MODEL_REGISTRY, ...(settings === undefined ? {} : { settings }) });
  assert.equal(r.recorded, true, JSON.stringify(r));
  return r;
}

/** One workspace's history on the slice: the default 20 of 30 at $2, Sonnet 5 27 of 30 at $1. */
async function history(home, workspaceId, settings) {
  for (let i = 0; i < 30; i += 1) await learn(home, workspaceId, event({ kind: i < 20 ? 'verified-pass' : 'verified-fail' }), settings);
  for (let i = 0; i < 30; i += 1) await learn(home, workspaceId, event({ modelId: CAND, costMicroUsd: 1_000_000, explored: true, propensity: 0.05, kind: i < 27 ? 'verified-pass' : 'verified-fail' }), settings);
}

async function tempHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'jevris-machine-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

async function contributionFiles(home) {
  const dir = machineLearningDir(home);
  const names = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json'));
  return Promise.all(names.map(async (n) => ({ name: n, text: await readFile(join(dir, n), 'utf8') })));
}

/** A workspace's own randomized outcomes on both arms at equal quality (9 in 12 verified): the local-evidence guard's minimum. */
async function localOutcomes(home, workspaceId) {
  for (const modelId of [BASE, CAND]) {
    for (let i = 0; i < MIN_LOCAL_PER_ARM; i += 1) await learn(home, workspaceId, event({ modelId, costMicroUsd: modelId === BASE ? 2_000_000 : 1_000_000, kind: i < 9 ? 'verified-pass' : 'verified-fail' }));
  }
}

const route = (home, workspaceId) => reconcileLearning({ home, workspaceId, sliceId: SLICE, baselineModelId: BASE, eligibleModelIds: ELIGIBLE, now: NOW, priors: null, authMode: 'api-key', registry: BUNDLED_MODEL_REGISTRY });

// The machine prior shapes the posterior but never switches a workspace alone (DOMAINS 223a21f).
test('C16 machine: two workspaces learn faster together than apart: a new workspace starts from the others\' outcomes, capped at the prior weight', async (t) => {
  const together = await tempHome(t);
  await history(together, 'ws-a');
  // The machine prior alone never switches a workspace: ws-b has none of its own outcomes yet.
  const first = await route(together, 'ws-b');
  assert.deepEqual([first.result.outcome, first.result.reasonCode], ['no-change', 'LOCAL_EVIDENCE_SHORT']);
  const posterior = first.result.evidence.candidatePosterior;
  assert.deepEqual(posterior.machine, { successes: 27, failures: 3, rate: 0.9, pseudoCount: MACHINE_PRIOR_WEIGHT, contributors: 1 });
  assert.deepEqual([posterior.alpha, posterior.beta, posterior.local], [11.3, 1.7, { successes: 0, failures: 0 }]);
  assert.ok(first.result.evidence.harmProbability < 0.1, 'the posterior already supports it; only the guard holds it');
  // Together: with its own minimum of outcomes on each arm, at equal quality, ws-b switches.
  await localOutcomes(together, 'ws-b');
  await route(together, 'ws-b');
  assert.deepEqual([slicePolicy(await loadLearningState({ home: together, workspaceId: 'ws-b' }), SLICE).mode, slicePolicy(await loadLearningState({ home: together, workspaceId: 'ws-b' }), SLICE).modelId], ['auto', CAND]);
  // Apart: the same outcomes in a workspace on a machine with no history leave it on the default.
  const apart = await tempHome(t);
  await localOutcomes(apart, 'ws-b');
  const alone = await route(apart, 'ws-b');
  assert.deepEqual([alone.result.outcome, alone.result.state.machinePrior?.contributors ?? 0], ['no-change', 0]);
  assert.equal(slicePolicy(alone.state, SLICE).mode, 'advise');
  // The machine prior counts for at most its locked weight (12) however much history there is.
  await history(together, 'ws-c');
  const capped = armPosterior(await loadLearningState({ home: together, workspaceId: 'ws-b' }), SLICE, CAND);
  assert.deepEqual([capped.machine.successes + capped.machine.failures, capped.machine.pseudoCount, capped.machine.contributors], [60, MACHINE_PRIOR_WEIGHT, 2]);
  // Explain says what the machine prior contributed.
  const lines = explainSliceLearning(await loadLearningState({ home: together, workspaceId: 'ws-b' }), SLICE).lines;
  assert.ok(lines.includes(`Machine prior ${CAND}: 90.0% from 60 outcomes in 2 other workspaces on this machine, counted as 12.`), lines.join('\n'));
});

/** Text-free machine sums for one arm: `n` outcomes at `rate`. */
function machineSums(n, rate) {
  const successes = Math.round(n * rate);
  return { successes, failures: n - successes, staleOrCancelled: 0, usageLimited: 0, routes: n, costSumMicroUsd: n * 1_000_000, costCount: n, tokensSum: 0, tokensCount: 0, latencySumMs: n * 60_000, latencyCount: n, equivalentSumMicroUsd: n * 1_000_000, equivalentCount: n };
}

// Owner decision 2026-09-27 (DOMAINS 43990b1): the machine prior has its own locked cap, equal to
// the local minimum; a signed baseline keeps the prior weight of 30.
test('C16 machine: 100 outcomes in other workspaces count as 12 per arm (the locked machine prior weight), fewer count as they are, no setting raises it, and a signed baseline of 100 still counts as 30', () => {
  assert.equal(MACHINE_PRIOR_WEIGHT, 12);
  const base = emptyLearningState({ workspaceId: 'ws-cap', now: NOW, settings: { priorWeight: 100 } });
  const state = {
    ...base,
    baseline: { [SLICE]: { releaseId: 'rel-cap', priors: [{ sliceId: SLICE, modelId: BASE, rate: 0.7, pseudoCount: 100, sampleSize: 100, sourceId: 'rel-cap' }] } },
    machinePrior: { generation: 'gen-0000000000000000', contributors: 3, limits: {}, arms: { [SLICE]: { [CAND]: machineSums(100, 0.8), [`${BASE}@low`]: machineSums(5, 0.8) } } },
  };
  // 100 outcomes elsewhere: counted as 12, even with the baseline's prior weight set to 100.
  const many = armPosterior(state, SLICE, CAND);
  assert.deepEqual(many.machine, { successes: 80, failures: 20, rate: 0.8, pseudoCount: 12, contributors: 3 });
  assert.deepEqual([many.alpha, many.beta, many.prior.pseudoCount], [10.1, 2.9, 0]);
  // The pair: 5 outcomes elsewhere count as 5, their real size.
  const few = armPosterior(state, SLICE, `${BASE}@low`);
  assert.deepEqual([few.machine.pseudoCount, few.alpha, few.beta], [5, 4.5, 1.5]);
  // The signed baseline keeps its own cap: at the default prior weight, 100 outcomes count as 30.
  const defaults = { ...state, settings: emptyLearningState({ workspaceId: 'ws-cap', now: NOW }).settings };
  assert.equal(defaults.settings.priorWeight, 30);
  const baseline = armPosterior(defaults, SLICE, BASE);
  assert.deepEqual([baseline.prior.pseudoCount, baseline.alpha, baseline.beta, baseline.machine], [30, 21.5, 9.5, undefined]);
  assert.equal(armPosterior(defaults, SLICE, CAND).machine.pseudoCount, 12);
  // Explain says so.
  const lines = explainSliceLearning(defaults, SLICE).lines;
  assert.ok(lines.includes(`Machine prior ${CAND}: 80.0% from 100 outcomes in 3 other workspaces on this machine, counted as 12.`), lines.join('\n'));
  assert.ok(lines.includes('Baseline claude-opus-5-5: 70.0% from 100 outcomes, counted as 30, signed release rel-cap.'), lines.join('\n'));
});

test('C16 machine: a workspace never reads its own contribution file', async (t) => {
  const home = await tempHome(t);
  await history(home, 'ws-a');
  const a = await loadLearningState({ home, workspaceId: 'ws-a' });
  assert.equal(a.machinePrior.contributors, 0, 'only its own file exists, and it is not read');
  const p = armPosterior(a, SLICE, CAND);
  assert.equal(p.machine, undefined);
  assert.deepEqual([p.alpha, p.beta], [27.5, 3.5], 'its own outcomes are counted once, locally');
  assert.equal((await loadMachinePrior(home, a.machine.token)).contributors, 0);
  assert.equal((await loadMachinePrior(home, null)).contributors, 1);
  // Another workspace's outcome is seen.
  await learn(home, 'ws-b', event());
  assert.equal((await loadLearningState({ home, workspaceId: 'ws-a' })).machinePrior.contributors, 1);
});

test('C16 machine: reset --machine starts a new generation; a contribution from an older one starts again from zero; a plain reset leaves the layer', async (t) => {
  const home = await tempHome(t);
  await history(home, 'ws-a');
  // A plain reset (and a policy reset of the workspace) leaves the machine layer.
  const a = await loadLearningState({ home, workspaceId: 'ws-a' });
  await saveLearningState(home, resetLearning(a, NOW));
  assert.equal((await loadMachinePrior(home, null)).arms[SLICE][CAND].successes, 27);
  // The machine's found-gone record is machine-wide route learning too (B's retention pair).
  const gone = await recordModelUnavailable({ home, modelId: CAND, reasonCode: 'MODEL_GONE', port: 'claude-api', authMode: 'api-key', source: 'provider-call', nowMs: Date.parse(NOW), registry: BUNDLED_MODEL_REGISTRY });
  assert.equal(gone.ok, true);
  // So is the eligibility evidence (model-offer.json).
  assert.equal(await recordModelRun(home, { harness: 'claude', authMode: 'api-key', modelId: CAND, nowMs: Date.parse(NOW) }), true);
  // So is the access-limit record (access limits R62).
  const limit = classifyAccessSignal({ port: 'claude-api', channel: 'structured', certified: false, status: 402 }, 'api-key', Date.parse(NOW));
  assert.equal((await recordAccessLimit({ home, scope: accessScopeOf(BUNDLED_MODEL_REGISTRY, 'claude', CAND, 'api-key'), classification: limit, source: 'owned-run', nowMs: Date.parse(NOW) })).ok, true);
  await stat(accessLimitsPath(home));
  const reset = await resetMachineLearning(home);
  assert.deepEqual(reset, { ok: true, removed: 1 });
  await assert.rejects(stat(accessLimitsPath(home)), { code: 'ENOENT' }, 'reset --machine removes access-limits.json');
  assert.equal(await loadMachinePrior(home, null).then((p) => p.contributors), 0);
  await assert.rejects(stat(modelAvailabilityFile(home)), { code: 'ENOENT' }, 'reset --machine removes model-availability.json');
  await assert.rejects(stat(modelOfferFile(home)), { code: 'ENOENT' }, 'reset --machine removes model-offer.json');
  assert.deepEqual(await loadModelAvailability(home, BUNDLED_MODEL_REGISTRY), []);
  // Paired: with no record at all, reset --machine still succeeds.
  assert.equal((await resetMachineLearning(home)).ok, true);
  // The workspace keeps its local history but contributes only what happens from now on.
  await learn(home, 'ws-a', event({ modelId: CAND, costMicroUsd: 1_000_000 }));
  const prior = await loadMachinePrior(home, null);
  assert.equal(prior.contributors, 1);
  assert.deepEqual(prior.arms[SLICE], { [CAND]: { ...prior.arms[SLICE][CAND], successes: 1, failures: 0, routes: 1 } });
  assert.equal((await loadLearningState({ home, workspaceId: 'ws-a' })).arms[SLICE][CAND].successes, 28);
  // --clear-evidence withdraws the workspace's contribution from the layer.
  const cleared = await withdrawMachineContribution(home, resetLearning(await loadLearningState({ home, workspaceId: 'ws-a' }), NOW, { clearEvidence: true }));
  await saveLearningState(home, cleared);
  assert.equal((await loadMachinePrior(home, null)).contributors, 0);
  assert.deepEqual(cleared.machine.arms, {});
});

test('C16 machine: no slice outside the shared vocabulary or priorSlices, no workspace id and no text reaches the machine layer', async (t) => {
  const home = await tempHome(t);
  assert.ok(SHARED_SLICE_IDS.includes('bounded-edit'));
  assert.equal(sharedSliceOf({ priorSlices: {} }, 'acme-billing'), null);
  assert.equal(sharedSliceOf({ priorSlices: { 'acme-api': 'issue-fix' } }, 'acme-api'), 'issue-fix');
  assert.equal(sharedSliceOf({ priorSlices: { 'acme-api': 'acme-other' } }, 'acme-api'), null, 'a mapping to a project word is not shared');
  const settings = { priorSlices: { 'acme-api': 'issue-fix' } };
  await learn(home, 'ws-acme-repo', event({ sliceId: 'acme-billing' }), settings);
  await learn(home, 'ws-acme-repo', event({ sliceId: 'acme-api' }), settings);
  await learn(home, 'ws-acme-repo', event({ sliceId: 'acme-billing', modelId: CAND, kind: 'usage-limited', receiptId: null, limitResetAt: '2026-09-26T18:00:00Z' }), settings);
  const files = await contributionFiles(home);
  assert.equal(files.length, 1);
  const body = JSON.parse(files[0].text);
  assert.deepEqual(Object.keys(body.arms), ['issue-fix']);
  for (const slice of Object.keys(body.arms)) assert.ok(SHARED_SLICE_IDS.includes(slice));
  assert.deepEqual(Object.keys(body).sort(), ['arms', 'generation', 'limits', 'schemaVersion']);
  for (const word of ['acme', 'ws-', home, 'rcpt-', '"ev-']) assert.equal(files[0].text.includes(word), false, word);
  assert.doesNotMatch(files[0].text, /route-\d/, 'no route id');
  assert.match(files[0].name, /^mc-[0-9a-f]{16}\.json$/);
  // Owner-only files in an owner-only folder.
  if (process.platform !== 'win32') {
    assert.equal((await stat(machineLearningDir(home))).mode & 0o777, 0o700);
    assert.equal((await stat(join(machineLearningDir(home), files[0].name))).mode & 0o777, 0o600);
    assert.equal((await stat(join(machineLearningDir(home), 'generation'))).mode & 0o777, 0o600);
  }
});

test('C16 machine: learning off neither contributes nor reads; a pin still wins; demotion stays per workspace', async (t) => {
  const home = await tempHome(t);
  await history(home, 'ws-a');
  await learn(home, 'ws-off', event(), { enabled: false });
  assert.equal((await contributionFiles(home)).length, 1, 'the workspace with learning off wrote no contribution');
  const off = await loadLearningState({ home, workspaceId: 'ws-off' });
  assert.equal(off.machine, undefined);
  assert.equal(armPosterior(off, SLICE, CAND).machine, undefined, 'and reads none');
  // A pin wins over the machine prior.
  const pinned = pinSlice(emptyLearningState({ workspaceId: 'ws-pin', now: NOW }), SLICE, BASE, NOW);
  await saveLearningState(home, pinned);
  const r = await route(home, 'ws-pin');
  assert.deepEqual([r.result.outcome, r.result.reasonCode], ['no-change', 'SLICE_PINNED']);
  // Demotion: a workspace where the candidate fails is demoted on its own outcomes, whatever the machine says.
  const aBefore = (await loadLearningState({ home, workspaceId: 'ws-a' })).versions;
  await localOutcomes(home, 'ws-b');
  await route(home, 'ws-b');
  assert.equal(slicePolicy(await loadLearningState({ home, workspaceId: 'ws-b' }), SLICE).mode, 'auto');
  let last = null;
  for (let i = 0; i < 30 && last?.regression !== 'demoted'; i += 1) last = await learn(home, 'ws-b', event({ modelId: CAND, costMicroUsd: 1_000_000, kind: 'verified-fail' }));
  assert.equal(last.regression, 'demoted');
  // ws-a's policy is its own: ws-b's demotion leaves its versions as they were.
  assert.deepEqual((await loadLearningState({ home, workspaceId: 'ws-a' })).versions, aBefore);
});

test('C16 machine: concurrent outcomes from several workspaces are never lost, and a usage limit is shared by model', async (t) => {
  const home = await tempHome(t);
  const workspaces = ['ws-1', 'ws-2', 'ws-3', 'ws-4'];
  await Promise.all(workspaces.flatMap((ws) => Array.from({ length: 10 }, () => learn(home, ws, event()))));
  const all = await loadMachinePrior(home, null);
  assert.deepEqual([all.contributors, all.arms[SLICE][BASE].routes, all.arms[SLICE][BASE].successes], [4, 40, 40]);
  // A usage limit hit in one workspace keeps every other workspace on this machine out of it.
  await learn(home, 'ws-1', event({ modelId: CAND, kind: 'usage-limited', receiptId: null, at: '2026-09-26T11:00:00Z', limitResetAt: '2026-09-26T16:00:00Z' }));
  const other = await loadLearningState({ home, workspaceId: 'ws-2' });
  assert.deepEqual(usageLimitStatus(other, CAND, Date.parse(NOW)), { limited: true, near: true, resetAt: '2026-09-26T16:00:00.000Z', recentHits: 1 });
  assert.equal(usageLimitStatus(other, CAND, Date.parse('2026-09-28T12:00:00Z')).limited, false);
});
