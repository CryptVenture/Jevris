#!/usr/bin/env node
/**
 * Days to adapt for a typical developer, simulated through the real route-learning code
 * (recordRouteOutcome, reconcileSlice, explorationChoice). No harness, no network.
 *
 *   node packages/core/scripts/route-learning-sim.mjs [--runs 200] [--days 90] [--explore 0.05] [--deactivate 0.4] [--activate 0.1] [--scenarios ABCDEFGHIJKLMNOP] [--min-arm N] [--newcombe] [--advise-explore R] [--prior-weight W] [--guard N] [--advise-rate R] [--machine-shrink] [--risk-mix L,M,H]
 *
 * Guards under study (simulation only; the product's thresholds are locked): `--min-arm N` lets
 * a slice activate only with N local labelled outcomes on both arms; `--newcombe` also needs the
 * one-sided 95% Newcombe lower bound of candidate minus default above minus the margin.
 *
 * A to F: a model candidate (Sonnet 5) against the baseline model (Opus 5.5 at its default
 * effort). G to J: an effort arm of the baseline model (Opus 5.5 at low or high effort) against
 * Opus 5.5 at medium, with only that effort arm explored. Local costs are assumptions (the
 * cheaper arm costs less), so the resource check passes locally; the question is quality.
 *
 * Each simulated day has `routes` managed-worker routes on one low-risk slice. A route runs the
 * active candidate when the slice is active, else the baseline model; exploration may pick the
 * other model at the locked rate. Its verified outcome is drawn from the model's true rate in
 * this workspace. The slice is reconciled after every outcome, as learnFromOutcome does.
 */
import { BUNDLED_MODEL_REGISTRY, MACHINE_PRIOR_WEIGHT, armKey, emptyLearningState, explorationChoice, harmProbability, newcombeDifference, recordRouteOutcome, reconcileSlice, slicePolicy } from '../dist/index.js';

const args = process.argv.slice(2);
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? d : Number(args[i + 1]);
};
const RUNS = opt('runs', 200);
const DAYS = opt('days', 90);
const MIN_ARM = opt('min-arm', 0);
const NEWCOMBE = args.includes('--newcombe');
const ADVISE_EXPLORE = args.includes('--advise-explore') ? opt('advise-explore', 0.1) : null;
// `--prior-weight W` caps a signed baseline's prior only; the machine prior's cap is the locked
// MACHINE_PRIOR_WEIGHT (12, DOMAINS 43990b1), which no setting changes.
const PRIOR_WEIGHT = args.includes('--prior-weight') ? { priorWeight: opt('prior-weight', 30) } : {};
// `--guard N` sets the product's local-evidence minimum directly (0: none, as before DOMAINS 223a21f);
// `--advise-rate R` the product's advise-only exploration (0.05: as before); `--machine-shrink` scales
// the machine prior's weight, min(MACHINE_PRIOR_WEIGHT, n), by max(0, 1 − local outcomes on the arm / 30). Study only: the product's are locked.
const GUARD = args.includes('--guard') ? opt('guard', 12) : null;
const ADVISE_RATE = args.includes('--advise-rate') ? opt('advise-rate', 0.1) : null;
const SHRINK = args.includes('--machine-shrink');
// `--risk-mix L,M,H`: the share of routes D's rules class low, medium and high (P1, DOMAINS 7922ee3).
// Only a low route explores or follows an active slice; a medium or high route runs the baseline,
// and its outcome is recorded without a propensity (it counts in the posterior, not the guard).
const RISK_MIX = (() => {
  const i = args.indexOf('--risk-mix');
  if (i < 0) return null;
  const parts = String(args[i + 1]).split(',').map(Number);
  const total = parts.reduce((a, x) => a + x, 0);
  if (parts.length !== 3 || parts.some((x) => !(x >= 0)) || !(total > 0)) throw new Error('--risk-mix takes three shares L,M,H');
  return parts.map((x) => x / total);
})();
const drawRisk = (random) => {
  if (RISK_MIX === null) return 'low';
  const u = random();
  return u < RISK_MIX[0] ? 'low' : u < RISK_MIX[0] + RISK_MIX[1] ? 'medium' : 'high';
};
const SETTINGS = { ...PRIOR_WEIGHT, explorationRate: opt('explore', 0.05), deactivateAbove: opt('deactivate', 0.4), activateBelow: opt('activate', 0.1) };
const ONLY = (() => {
  const i = args.indexOf('--scenarios');
  return i < 0 ? 'ABCDEFGHIJKLMNOP' : String(args[i + 1]);
})();
// Real registry ids so the list-price check runs: Sonnet 5 is cheaper than Opus 5.5.
const BASE = 'claude-opus-5-5';
const CAND = 'claude-sonnet-5';
const SLICE = 'bounded-edit';

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One workspace: returns the first day the slice's mode differs from its day-1 mode (or null),
 * and whether it changed back later. Costs: the candidate is cheaper at list price, so an
 * outcome's cost makes the resource check pass locally too.
 */
function run({ routes, prior, truth, seed, arm = { modelId: CAND, effort: null } }) {
  const random = mulberry(seed);
  const start = Date.parse('2026-10-01T00:00:00Z');
  const effortArms = arm.effort === null ? [] : [arm.effort];
  let state = emptyLearningState({ workspaceId: 'ws-sim', now: new Date(start).toISOString(), settings: { ...SETTINGS, effortArms } });
  const candArm = armKey(arm.modelId, arm.effort);
  // A machine with history: other workspaces' outcomes per arm (the machine-wide prior, §18.5 as amended).
  if (prior.machine !== undefined) {
    const sums = (n, rate, cost) => {
      const successes = Math.round(n * rate);
      return { successes, failures: n - successes, staleOrCancelled: 0, usageLimited: 0, routes: n, costSumMicroUsd: n * cost, costCount: n, tokensSum: 0, tokensCount: 0, latencySumMs: n * 60_000, latencyCount: n, equivalentSumMicroUsd: n * cost, equivalentCount: n };
    };
    const m = prior.machine;
    state = { ...state, machinePrior: { generation: 'gen-0000000000000000', contributors: m.contributors ?? 3, limits: {}, arms: { [SLICE]: { [BASE]: sums(m.n, m.base, 2_000_000), [candArm]: sums(m.n, m.cand, arm.effort === 'high' ? 3_000_000 : 1_000_000) } } } };
  }
  if (GUARD !== null || ADVISE_RATE !== null) state = { ...state, settings: { ...state.settings, ...(GUARD === null ? {} : { minLocalPerArm: GUARD }), ...(ADVISE_RATE === null ? {} : { adviseExplorationRate: ADVISE_RATE }) } };
  const machineFull = state.machinePrior;
  // The machine prior's weight shrinking as the workspace's own outcomes on the arm grow.
  const shrink = () => {
    if (!SHRINK || machineFull === undefined) return;
    const arms = {};
    for (const [armId, a] of Object.entries(machineFull.arms[SLICE])) {
      const n = a.successes + a.failures;
      const localN = (state.arms[SLICE]?.[armId]?.successes ?? 0) + (state.arms[SLICE]?.[armId]?.failures ?? 0);
      const w = Math.min(MACHINE_PRIOR_WEIGHT, n) * Math.max(0, 1 - localN / 30);
      const k = n === 0 ? 0 : w / n;
      arms[armId] = { ...a, successes: a.successes * k, failures: a.failures * k };
    }
    state = { ...state, machinePrior: { ...machineFull, arms: { [SLICE]: arms } } };
  };
  const eligible = [...new Set([BASE, arm.modelId])];
  // A null baseline rate: no signed baseline at all (release 1.2 ships none): every arm is Beta(½, ½).
  const priors = { releaseId: 'baseline-sim', priors: prior.base === null ? [] : [
    { sliceId: SLICE, modelId: BASE, rate: prior.base, pseudoCount: prior.n, sampleSize: prior.n, sourceId: 'baseline-sim' },
    // A null candidate rate: no prior for the arm (Beta(½, ½)); the owner's seed has not measured it.
    ...(prior.cand === null ? [] : [{ sliceId: SLICE, modelId: arm.modelId, ...(arm.effort === null ? {} : { effort: arm.effort }), rate: prior.cand, pseudoCount: prior.candN ?? prior.n, sampleSize: prior.candN ?? prior.n, sourceId: 'baseline-sim' }]),
  ] };
  // The cheaper arm costs less; a higher effort costs more.
  const cost = (onCand) => (onCand ? (arm.effort === 'high' ? 3_000_000 : 1_000_000) : 2_000_000);
  const reconcile = (now) => {
    shrink();
    // A guard holds a slice that is not active until both arms have enough local outcomes.
    if (slicePolicy(state, SLICE).mode !== 'auto' && (MIN_ARM > 0 || NEWCOMBE)) {
      const a = (id) => state.arms[SLICE]?.[id] ?? { successes: 0, failures: 0 };
      const c = a(candArm);
      const b = a(BASE);
      const nc = c.successes + c.failures;
      const nb = b.successes + b.failures;
      if (Math.min(nc, nb) < MIN_ARM) return;
      if (NEWCOMBE) {
        const d = newcombeDifference(c.successes, nc, b.successes, nb);
        if (d === null || d.lower <= -0.075) return;
      }
    }
    state = reconcileSlice({ state, sliceId: SLICE, baselineModelId: BASE, eligibleModelIds: eligible, now, authMode: 'api-key', priors, automaticAllowed: true, registry: BUNDLED_MODEL_REGISTRY }).state;
  };
  reconcile(new Date(start).toISOString());
  const day1 = slicePolicy(state, SLICE).mode;
  let firstChange = null;
  let changes = 0;
  let last = day1;
  let seq = 0;
  let onCandidate = 0;
  let onCandidateSwitched = 0;
  let lowRoutes = 0;
  for (let day = 0; day < DAYS; day += 1) {
    for (let r = 0; r < routes; r += 1) {
      seq += 1;
      const at = new Date(start + day * 86_400_000 + (r + 1) * Math.floor(86_400_000 / (routes + 1))).toISOString();
      const policy = slicePolicy(state, SLICE);
      const risk = drawRisk(random);
      if (risk === 'low') lowRoutes += 1;
      // Only a low route follows an active slice (route-worker.ts); the others keep the baseline.
      const active = risk === 'low' && policy.mode === 'auto' && policy.modelId !== null;
      // `--advise-explore R`: exploration at R while the slice is advise-only, the set rate once active.
      const exploring = ADVISE_EXPLORE === null || active ? state : { ...state, settings: { ...state.settings, explorationRate: ADVISE_EXPLORE } };
      const choice = explorationChoice({ state: exploring, sliceId: SLICE, mode: 'bounded-auto', risk, defaultModelId: active ? policy.modelId : BASE, defaultEffort: active ? (policy.effort ?? null) : null, baselineModelId: BASE, eligibleModelIds: eligible, random, priors: priors.priors, nowMs: Date.parse(at), registry: BUNDLED_MODEL_REGISTRY });
      const onCand = armKey(choice.modelId, choice.effort) === candArm;
      if (onCand) onCandidate += 1;
      if (onCand && !choice.explored) onCandidateSwitched += 1;
      const pass = random() < (onCand ? truth.cand : truth.base);
      const e = {
        eventId: `e${seq}`, routeId: `r${seq}`, sliceId: SLICE, modelId: choice.modelId, ...(choice.effort === null ? {} : { effort: choice.effort }), rulesModelId: BASE, policyVersion: 0,
        kind: pass ? 'verified-pass' : 'verified-fail', labelSource: 'verification-receipt', receiptId: `rc${seq}`,
        explored: choice.explored, propensity: risk === 'low' ? (choice.propensity ?? 1) : null, risk,
        costMicroUsd: cost(onCand), latencyMs: 60_000, at,
      };
      const rec = recordRouteOutcome(state, e);
      if (!rec.ok) throw new Error(rec.reasonCode);
      state = rec.state;
      reconcile(at);
      const mode = slicePolicy(state, SLICE).mode;
      if (mode !== last) {
        changes += 1;
        if (firstChange === null) firstChange = day + (r + 1) / routes;
        last = mode;
      }
    }
  }
  return { day1, firstChange, changes, final: last, candidateShare: onCandidate / (DAYS * routes), switchedShare: onCandidateSwitched / (DAYS * routes), lowShare: lowRoutes / (DAYS * routes) };
}

function quantile(xs, q) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

const SCENARIOS = [
  { name: 'A. baseline wrong: day-1 active, candidate truly 15 points worse', prior: { base: 0.68, cand: 0.8, n: 30 }, truth: { base: 0.68, cand: 0.53 } },
  { name: 'B. baseline right: day-1 active, candidate truly equal', prior: { base: 0.68, cand: 0.8, n: 30 }, truth: { base: 0.68, cand: 0.68 } },
  { name: 'C. baseline pessimistic (like Fable vs Opus 5.5): day-1 advise, candidate truly equal', prior: { base: 0.684, cand: 0.643, n: 30 }, truth: { base: 0.68, cand: 0.68 } },
  { name: 'D. baseline pessimistic: day-1 advise, candidate truly 5 points better', prior: { base: 0.684, cand: 0.643, n: 30 }, truth: { base: 0.68, cand: 0.73 } },
  { name: 'E. easy slice, weak seed prior (n 12): day-1 advise, candidate truly equal at 90%', prior: { base: 0.9, cand: 0.85, n: 12 }, truth: { base: 0.9, cand: 0.9 } },
  { name: 'F. safety: day-1 advise, candidate truly 10 points worse (a wrong activation is the change counted)', prior: { base: 0.684, cand: 0.643, n: 30 }, truth: { base: 0.68, cand: 0.58 } },
  // Effort arms of Opus 5.5 (baseline: Opus 5.5 at medium). The medium prior is the seed's 12 tasks.
  { name: 'G. Opus 5.5 low, no effort data in the seed: day-1 advise, low truly equal', arm: { modelId: BASE, effort: 'low' }, prior: { base: 0.67, cand: null, n: 12 }, truth: { base: 0.67, cand: 0.67 } },
  { name: 'H. Opus 5.5 low measured in the seed (12 tasks, 8 of 12 at both): day-1 advise, low truly equal', arm: { modelId: BASE, effort: 'low' }, prior: { base: 0.667, cand: 0.667, n: 12 }, truth: { base: 0.67, cand: 0.67 } },
  { name: 'I. safety: Opus 5.5 low, no seed data, low truly 10 points worse (a wrong activation is the change counted)', arm: { modelId: BASE, effort: 'low' }, prior: { base: 0.67, cand: null, n: 12 }, truth: { base: 0.67, cand: 0.57 } },
  { name: 'J. hard slice: Opus 5.5 high, no seed data, high truly 10 points better (an upgrade)', arm: { modelId: BASE, effort: 'high' }, prior: { base: 0.5, cand: null, n: 12 }, truth: { base: 0.5, cand: 0.6 } },
  // Release 1.2 ships no baseline (owner 827fc87): every arm, the default included, starts at Beta(½, ½).
  { name: 'K. no baseline (1.2): Opus 5.5 low, truly equal', arm: { modelId: BASE, effort: 'low' }, prior: { base: null, cand: null, n: 0 }, truth: { base: 0.67, cand: 0.67 } },
  { name: 'L. no baseline (1.2): Sonnet 5, truly equal', prior: { base: null, cand: null, n: 0 }, truth: { base: 0.68, cand: 0.68 } },
  { name: 'M. safety, no baseline (1.2): Opus 5.5 low truly 10 points worse (a wrong activation is the change counted)', arm: { modelId: BASE, effort: 'low' }, prior: { base: null, cand: null, n: 0 }, truth: { base: 0.67, cand: 0.57 } },
  // A new project on a machine with history in other workspaces (the machine prior, capped at MACHINE_PRIOR_WEIGHT, 12).
  { name: 'N. new project, machine history of 30 routes per arm, no baseline: Opus 5.5 low truly equal', arm: { modelId: BASE, effort: 'low' }, prior: { base: null, cand: null, n: 0, machine: { n: 30, base: 0.67, cand: 0.67 } }, truth: { base: 0.67, cand: 0.67 } },
  { name: 'O. new project, machine history of 100 routes per arm, no baseline: Opus 5.5 low truly equal', arm: { modelId: BASE, effort: 'low' }, prior: { base: null, cand: null, n: 0, machine: { n: 100, base: 0.67, cand: 0.67 } }, truth: { base: 0.67, cand: 0.67 } },
  { name: 'P. safety: machine history says low is equal (100 per arm), but in this project low is truly 10 points worse', arm: { modelId: BASE, effort: 'low' }, prior: { base: null, cand: null, n: 0, machine: { n: 100, base: 0.67, cand: 0.67 } }, truth: { base: 0.67, cand: 0.57 } },
];

const P = (r, n) => ({ alpha: 0.5 + r * n, beta: 0.5 + (1 - r) * n });
process.stdout.write(`exploration ${SETTINGS.explorationRate}, demotion above ${SETTINGS.deactivateAbove}, activation below ${SETTINGS.activateBelow}, margin 0.075, ${RUNS} runs of ${DAYS} days, min per arm ${MIN_ARM}${NEWCOMBE ? ', Newcombe bound' : ''}${ADVISE_EXPLORE === null ? '' : `, exploration ${ADVISE_EXPLORE} while advise-only`}${RISK_MIX === null ? ', every route low risk' : `, risk mix low ${RISK_MIX[0].toFixed(2)} / medium ${RISK_MIX[1].toFixed(2)} / high ${RISK_MIX[2].toFixed(2)}`}\n`);
for (const s of SCENARIOS.filter((x) => ONLY.includes(x.name[0]))) {
  const basePrior = s.prior.base === null ? { alpha: 0.5, beta: 0.5 } : P(s.prior.base, s.prior.n);
  const harm = harmProbability(s.prior.cand === null ? { alpha: 0.5, beta: 0.5 } : P(s.prior.cand, s.prior.candN ?? s.prior.n), basePrior, 0.075);
  process.stdout.write(`\n${s.name}\n  day-1 P(candidate worse by > 7.5 points) = ${(harm * 100).toFixed(1)}%\n`);
  for (const routes of [10, 30]) {
    const results = Array.from({ length: RUNS }, (_, i) => run({ routes, prior: s.prior, truth: s.truth, seed: 1000 + i, ...(s.arm === undefined ? {} : { arm: s.arm }) }));
    const changed = results.filter((r) => r.firstChange !== null).map((r) => r.firstChange);
    const flaps = results.filter((r) => r.changes > 1).length;
    const med = changed.length === 0 ? 'n/a' : quantile(changed, 0.5).toFixed(1);
    const p90 = changed.length < RUNS * 0.9 ? `> ${DAYS}` : quantile(changed, 0.9).toFixed(1);
    const share = results.reduce((a, r) => a + r.candidateShare, 0) / RUNS;
    const switched = results.reduce((a, r) => a + r.switchedShare, 0) / RUNS;
    process.stdout.write(`  ${String(routes).padStart(2)} routes/day: day-1 ${results[0].day1}; changed within ${DAYS} days in ${changed.length}/${RUNS}; median day ${med}, 90th percentile ${p90}; changed more than once in ${flaps}/${RUNS}; ${(share * 100).toFixed(1)}% of routes ran the candidate, ${(switched * 100).toFixed(1)}% outside exploration\n`);
  }
}
