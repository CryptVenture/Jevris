/**
 * Provisional quality priors from independent coding-agent boards (SPEC §8.3, amended 2026-09-27
 * with owner approval; owner decision OD-14 in DOMAINS 38be7b5).
 *
 * A model with no calibration for a slice may take a provisional prior from a board result:
 * Terminal-Bench 4.0, the success-rate components of the Artificial Analysis Coding Agent Index,
 * or SWE-rebench. The rule, fixed before any local outcome is seen:
 *
 * - Only a board operator's result with its trial count counts; a vendor-reported one never does.
 * - The prior is Beta(rate·w, (1−rate)·w) with w = min(trials, PUBLIC_PRIOR_WEIGHT), halved when
 *   the board's harness differs from the route's and halved again when its effort differs.
 * - Local verified outcomes replace it one for one: the weight left is max(0, w − n_local).
 * - It qualifies a candidate only when its Wilson 95% lower bound is at least the baseline's
 *   prior point less the non-inferiority margin. The bound is the board's own evidence: it is
 *   taken over the board's trials times the same mismatch factors, not over the capped weight
 *   (at 12 pseudo-outcomes no candidate short of a far better one could ever qualify).
 * - It stops counting after PUBLIC_PRIOR_MAX_AGE_DAYS, or once a later version of its board is in
 *   the table; a signed calibration release for the slice overrides it.
 *
 * What it may do (OD-14): let a qualified model be explored under bounded-auto on a low-risk task,
 * and inform advice and shadow scoring. It never promotes a route: a lasting switch still needs
 * MIN_LOCAL_PER_ARM local randomized outcomes per arm. Pure: no I/O and no clock read.
 */
import type { HarnessId, ModelRegistry } from '@jevris/contracts';
import { registryModel } from './model-registry.js';
import { armKey, baseSliceOf, BUNDLED_PUBLIC_PRIORS, wilsonInterval, type BaselinePrior, type LearningState, type PublicPrior } from './route-learning.js';

/** The most pseudo-outcomes a board result counts for (pre-registered). */
export const PUBLIC_PRIOR_WEIGHT = 12;
/** A board result older than this, by its publication date, no longer counts. */
export const PUBLIC_PRIOR_MAX_AGE_DAYS = 120;
/** The factor on the weight for each of a harness and an effort mismatch. */
export const PUBLIC_PRIOR_MISMATCH_FACTOR = 0.5;

/** The independent boards, by source id. A row from any other source never counts. */
export const PUBLIC_PRIOR_BOARDS: Readonly<Record<string, string>> = Object.freeze({
  'TB4-LB': 'Terminal-Bench leaderboard (tbench.ai)',
  'AA-CAI': 'Artificial Analysis Coding Agent Index, success-rate components',
  'SWE-REBENCH': 'SWE-rebench leaderboard',
});

/** A board's agent harness name, as the board publishes it, to the harness id it matches. */
const BOARD_HARNESS: Readonly<Record<string, HarnessId>> = Object.freeze({
  'claude-code': 'claude',
  codex: 'codex',
  'codex-cli': 'codex',
  opencode: 'opencode',
  kilo: 'kilocode',
  kilocode: 'kilocode',
  'kilo-code': 'kilocode',
  antigravity: 'antigravity',
});

const DAY_MS = 86_400_000;

export type PublicPriorRefusal = 'NOT_INDEPENDENT' | 'NO_TRIALS' | 'TOO_OLD' | 'BOARD_SUPERSEDED' | 'NO_WEIGHT_LEFT';

/** One board result weighed for one arm on one route. */
export interface WeighedPublicPrior {
  readonly prior: PublicPrior;
  readonly rate: number;
  /** Pseudo-outcomes after the mismatch factors and the local outcomes it gives way to. */
  readonly weight: number;
  readonly harnessMatches: boolean;
  readonly effortMatches: boolean;
  /** The board trials the bound is taken over: trials times the mismatch factors. */
  readonly boundTrials: number;
  /** Wilson 95% bounds of the board rate over `boundTrials`. */
  readonly lower: number;
  readonly upper: number;
}

/** The board and its version from a benchmark label (`terminal-bench@4.0 (AA index component)`). */
export function boardVersion(benchmark: string): { readonly board: string; readonly version: string } | null {
  const m = /^([a-z0-9][a-z0-9._-]*)@([0-9]+(?:\.[0-9]+)*)/.exec(benchmark.trim().toLowerCase());
  return m === null ? null : { board: m[1] as string, version: m[2] as string };
}

function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Why a board row does not count at `nowMs`, or null when it does (before weighing). */
export function publicPriorRefusal(prior: PublicPrior, table: readonly PublicPrior[], nowMs: number): PublicPriorRefusal | null {
  if (PUBLIC_PRIOR_BOARDS[prior.sourceId] === undefined || prior.independent !== true) return 'NOT_INDEPENDENT';
  if (!(prior.trials > 0)) return 'NO_TRIALS';
  const published = Date.parse(prior.publishedOn);
  if (!Number.isFinite(published) || nowMs - published > PUBLIC_PRIOR_MAX_AGE_DAYS * DAY_MS) return 'TOO_OLD';
  const own = boardVersion(prior.benchmark);
  if (own === null) return 'BOARD_SUPERSEDED';
  for (const other of table) {
    const v = boardVersion(other.benchmark);
    if (v !== null && v.board === own.board && compareVersions(v.version, own.version) > 0) return 'BOARD_SUPERSEDED';
  }
  return null;
}

/** The harness id a board's agent harness name matches, or null for a board's own agent. */
export function boardHarness(name: string): HarnessId | null {
  return BOARD_HARNESS[name.trim().toLowerCase()] ?? null;
}

/**
 * Weigh one board row for an arm: the model at `effort` (null: its default) on `harness` (null:
 * not known, which counts as a mismatch), with `localOutcomes` labelled outcomes already local.
 */
export function weighPublicPrior(input: {
  readonly prior: PublicPrior;
  readonly effort: string | null;
  readonly harness: HarnessId | null;
  readonly localOutcomes: number;
  readonly registry?: ModelRegistry;
}): WeighedPublicPrior {
  const { prior } = input;
  const model = input.registry === undefined ? null : registryModel(input.registry, prior.modelId);
  const armEffort = input.effort ?? model?.defaultEffort ?? null;
  const effortMatches = armEffort !== null && armEffort === prior.effort;
  const harnessMatches = input.harness !== null && boardHarness(prior.harness) === input.harness;
  const factor = (harnessMatches ? 1 : PUBLIC_PRIOR_MISMATCH_FACTOR) * (effortMatches ? 1 : PUBLIC_PRIOR_MISMATCH_FACTOR);
  const weight = Math.max(0, Math.min(prior.trials, PUBLIC_PRIOR_WEIGHT) * factor - Math.max(0, input.localOutcomes));
  const boundTrials = prior.trials * factor;
  const ci = wilsonInterval(prior.successRate * boundTrials, boundTrials) ?? { lower: 0, upper: 1 };
  return { prior, rate: prior.successRate, weight, harnessMatches, effortMatches, boundTrials, lower: ci.lower, upper: ci.upper };
}

/** The prior slice a local slice reads board results from: the settings' mapping, else itself. */
export function publicPriorSliceOf(state: LearningState, sliceId: string): string {
  // A learning key (R17) takes its slice's board slice.
  const base = baseSliceOf(sliceId);
  return state.settings.priorSlices[base] ?? base;
}

export type PublicPriorVerdict =
  | { readonly qualified: true; readonly weighed: WeighedPublicPrior; readonly floor: number; readonly baselineSourceId: string }
  | { readonly qualified: false; readonly reasonCode: PublicPriorRefusal | 'NO_PUBLIC_PRIOR' | 'NO_BASELINE_PRIOR' | 'BELOW_FLOOR' | 'RELEASE_OVERRIDES'; readonly weighed: WeighedPublicPrior | null };

function localOutcomes(state: LearningState, sliceId: string, armId: string): number {
  const a = state.arms[sliceId]?.[armId];
  return a === undefined ? 0 : a.successes + a.failures;
}

/** The heaviest counting board row for an arm, or the reason none counts. */
function bestRow(input: {
  readonly state: LearningState;
  readonly sliceId: string;
  readonly modelId: string;
  readonly effort: string | null;
  readonly harness: HarnessId | null;
  readonly nowMs: number;
  readonly registry?: ModelRegistry;
  readonly table: readonly PublicPrior[];
  /** Weigh as if no local outcome had arrived (the baseline's floor point). */
  readonly ignoreLocal?: boolean;
}): WeighedPublicPrior | PublicPriorRefusal | 'NO_PUBLIC_PRIOR' {
  const priorSlice = publicPriorSliceOf(input.state, input.sliceId);
  const rows = input.table.filter((p) => p.priorSliceId === priorSlice && p.modelId === input.modelId);
  if (rows.length === 0) return 'NO_PUBLIC_PRIOR';
  const armId = armKey(input.modelId, input.effort, input.registry);
  const local = input.ignoreLocal === true ? 0 : localOutcomes(input.state, input.sliceId, armId);
  let best: WeighedPublicPrior | null = null;
  let refusal: PublicPriorRefusal | null = null;
  for (const row of rows) {
    const why = publicPriorRefusal(row, input.table, input.nowMs);
    if (why !== null) {
      refusal ??= why;
      continue;
    }
    const weighed = weighPublicPrior({ prior: row, effort: input.effort, harness: input.harness, localOutcomes: local, ...(input.registry === undefined ? {} : { registry: input.registry }) });
    if (best === null || weighed.weight > best.weight || (weighed.weight === best.weight && row.trials > best.prior.trials)) best = weighed;
  }
  if (best === null) return refusal ?? 'NO_PUBLIC_PRIOR';
  return best.weight > 0 ? best : 'NO_WEIGHT_LEFT';
}

/**
 * Whether a board prior qualifies `modelId` at `effort` for exploration on this slice. The floor
 * is the baseline's prior point less the margin: the release prior when the slice has one (then
 * the release also overrides any board prior of the candidate), else the baseline's board result.
 */
export function publicPriorVerdict(input: {
  readonly state: LearningState;
  readonly sliceId: string;
  readonly modelId: string;
  readonly effort: string | null;
  readonly harness: HarnessId | null;
  readonly baselineModelId: string;
  readonly baselineHarness?: HarnessId | null;
  readonly nowMs: number;
  readonly registry?: ModelRegistry;
  /** The signed release priors for the slice (the state's baseline snapshot by default). */
  readonly releasePriors?: readonly BaselinePrior[];
  readonly table?: readonly PublicPrior[];
}): PublicPriorVerdict {
  const table = input.table ?? BUNDLED_PUBLIC_PRIORS;
  const release = input.releasePriors ?? input.state.baseline[input.sliceId]?.priors ?? [];
  const armId = armKey(input.modelId, input.effort, input.registry);
  const own = (p: BaselinePrior): string => (p.effort === undefined || p.effort === null ? p.modelId : armKey(p.modelId, p.effort, input.registry));
  if (release.some((p) => p.sliceId === input.sliceId && own(p) === armId)) return { qualified: false, reasonCode: 'RELEASE_OVERRIDES', weighed: null };
  const candidate = bestRow({ ...input, table });
  if (typeof candidate === 'string') return { qualified: false, reasonCode: candidate, weighed: null };
  const releaseBaseline = release.find((p) => p.sliceId === input.sliceId && own(p) === input.baselineModelId);
  let floorPoint: number;
  let baselineSourceId: string;
  if (releaseBaseline !== undefined) {
    floorPoint = releaseBaseline.rate;
    baselineSourceId = releaseBaseline.sourceId;
  } else {
    // The baseline's point is its board rate: its own local outcomes do not move the floor.
    const base = bestRow({ ...input, modelId: input.baselineModelId, effort: null, harness: input.baselineHarness ?? input.harness, table, ignoreLocal: true });
    if (typeof base === 'string') return { qualified: false, reasonCode: 'NO_BASELINE_PRIOR', weighed: candidate };
    floorPoint = base.rate;
    baselineSourceId = base.prior.sourceId;
  }
  const floor = floorPoint - input.state.settings.nonInferiorityMargin;
  if (candidate.lower < floor) return { qualified: false, reasonCode: 'BELOW_FLOOR', weighed: candidate };
  return { qualified: true, weighed: candidate, floor, baselineSourceId };
}

/**
 * The board priors that qualify, as baseline priors the posterior reads (source `public:<id>`),
 * one per model at its default effort, for models the release gives no prior on this slice. The
 * baseline's own board prior comes too (when the release has none), so the comparison is like
 * for like. These go to exploration only: promotion reads the release priors and local outcomes.
 */
export function qualifiedPublicPriors(input: {
  readonly state: LearningState;
  readonly sliceId: string;
  readonly modelIds: readonly string[];
  readonly baselineModelId: string;
  readonly harnessOf: (modelId: string) => HarnessId | null;
  readonly nowMs: number;
  readonly registry?: ModelRegistry;
  readonly table?: readonly PublicPrior[];
}): readonly BaselinePrior[] {
  const out: BaselinePrior[] = [];
  const release = input.state.baseline[input.sliceId]?.priors ?? [];
  if (!release.some((p) => p.sliceId === input.sliceId && p.modelId === input.baselineModelId && (p.effort ?? null) === null)) {
    const base = bestRow({ state: input.state, sliceId: input.sliceId, modelId: input.baselineModelId, effort: null, harness: input.harnessOf(input.baselineModelId), nowMs: input.nowMs, table: input.table ?? BUNDLED_PUBLIC_PRIORS, ...(input.registry === undefined ? {} : { registry: input.registry }) });
    if (typeof base !== 'string') out.push({ sliceId: input.sliceId, modelId: input.baselineModelId, rate: base.rate, pseudoCount: base.weight, sampleSize: base.prior.trials, sourceId: `public:${base.prior.sourceId}` });
  }
  for (const modelId of [...new Set(input.modelIds)].sort()) {
    if (modelId === input.baselineModelId) continue;
    const verdict = publicPriorVerdict({
      state: input.state,
      sliceId: input.sliceId,
      modelId,
      effort: null,
      harness: input.harnessOf(modelId),
      baselineModelId: input.baselineModelId,
      baselineHarness: input.harnessOf(input.baselineModelId),
      nowMs: input.nowMs,
      ...(input.registry === undefined ? {} : { registry: input.registry }),
      ...(input.table === undefined ? {} : { table: input.table }),
    });
    if (!verdict.qualified) continue;
    out.push({ sliceId: input.sliceId, modelId, rate: verdict.weighed.rate, pseudoCount: verdict.weighed.weight, sampleSize: verdict.weighed.prior.trials, sourceId: `public:${verdict.weighed.prior.sourceId}` });
  }
  return out;
}

/** The harness that runs a provider's models natively in the registry's harness map, or null. */
export function nativeHarnessOf(registry: ModelRegistry, modelId: string): HarnessId | null {
  const model = registryModel(registry, modelId);
  if (model === null) return null;
  const row = (registry.harnessAccess ?? []).find((r) => r.provider === model.provider && r.access === 'native');
  return row === undefined ? null : row.harness;
}
