/**
 * Where Sonnet-first routing shows up for a person and for an agent reading machine output: the
 * `firstTry` block of the `status` payload (per harness, the first-try and baseline models and how
 * many slices start on which), and the `firstTry` block of an `explain --slice` trace (the verdict
 * for one slice, with the counts and the numbers it used). Both are read from the local first-try
 * ledger and the registry; they carry ids, counts, probabilities and integer micro-USD only, never
 * task text, a path or a tool output. A view changes no decision, threshold or default.
 */
import { HarnessIdSchema, Id, ModelId, NonNegativeInteger, Probability, REASON_CODE_PATTERN, SECRET_PATTERNS } from './primitives.js';
import * as S from './schema.js';

/** What a slice does today: starts on the first-try model, starts on the baseline, or is still under the anti-flap floor. */
export const FIRST_TRY_PHASES = ['first-try', 'baseline-first', 'learning'] as const;
export type FirstTryPhaseName = (typeof FIRST_TRY_PHASES)[number];

const Code = S.string({ pattern: REASON_CODE_PATTERN, notPatterns: SECRET_PATTERNS });
const Count = NonNegativeInteger;

/** How many slices are in each phase. */
export const FirstTrySliceCountsSchema = S.object({ firstTry: Count, baselineFirst: Count, learning: Count });
export type FirstTrySliceCounts = S.Static<typeof FirstTrySliceCountsSchema>;

/**
 * The `status` view. `harnesses` lists each harness the registry gives a default baseline.
 * `state` is `off` when `routing.firstTry` is `baseline` (`reasonCode` `FIRST_TRY_OFF`) or when the
 * harness has no first-try step (`reasonCode` says why, for example `NO_CHEAPER_RUNG`);
 * `strongerIsPreview` is true when the only stronger model of that vendor is a preview, which is
 * never started automatically. `slices` counts this workspace's slices by baseline model; `other`
 * counts those whose baseline is no harness's default. `unavailable` is the reason code when the
 * model registry is refused, so no ladder can be derived (`harnesses` is then empty); null otherwise.
 */
export const FirstTryStatusSchema = S.object({
  setting: S.enumOf(['auto', 'baseline'] as const),
  unavailable: S.nullable(Code),
  harnesses: S.array(
    S.object({
      harness: HarnessIdSchema,
      state: S.enumOf(['on', 'off'] as const),
      reasonCode: S.nullable(Code),
      baselineModelId: S.nullable(ModelId),
      firstTryModelId: S.nullable(ModelId),
      strongerIsPreview: S.boolean(),
      slices: FirstTrySliceCountsSchema,
    }),
    { maxItems: 8 },
  ),
  other: FirstTrySliceCountsSchema,
});
export type FirstTryStatus = S.Static<typeof FirstTryStatusSchema>;

const Attempts = S.object({ meanMicroUsd: S.nullable(Count), samples: Count });

/**
 * One (slice, baseline, first-try model) group of the `explain --slice` view. `verdict` is what the
 * route would do now (`firstTryVerdict`, the owner-locked thresholds): `learning` while fewer than
 * `thresholds.antiFlapFloor` first attempts have a label. `breakEven.value` is
 * p* = (cS + h) / (cO + h), with `basis` `measured` when both attempt means have enough samples.
 */
export const FirstTryGroupSchema = S.object({
  baselineModelId: ModelId,
  firstTryModelId: ModelId,
  verdict: S.enumOf(FIRST_TRY_PHASES),
  reasonCode: Code,
  /** The last time the verdict moved the slice between first-try and baseline-first: where it went, why, and after how many finished first-try tasks; null while it has never moved. */
  lastChange: S.nullable(S.object({ mode: S.enumOf(['first-try', 'baseline'] as const), reasonCode: Code, atFinished: Count })),
  /** Tasks started in each arm, finished or not, and how many of either arm are still open. */
  started: S.object({ firstTry: Count, control: Count, open: Count }),
  firstTry: S.object({ finished: Count, verified: Count, firstAttemptPass: Count, firstAttemptFail: Count, handedOff: Count }),
  control: S.object({ finished: Count, verified: Count }),
  /**
   * The control share: `observed` is control tasks over all started tasks (null with none);
   * `nextTaskArm` is the arm the route gives the minority share and `nextTaskShare` that share.
   */
  controlShare: S.object({ observed: S.nullable(Probability), nextTaskArm: S.enumOf(['control', 'first-try'] as const), nextTaskShare: Probability }),
  breakEven: S.object({
    value: Probability,
    basis: S.enumOf(['measured', 'estimated'] as const),
    overheadMicroUsd: Count,
    firstAttempt: Attempts,
    stepUpAttempt: Attempts,
  }),
  pBelowBreakEven: S.nullable(Probability),
  pWorseThanBaseline: S.nullable(Probability),
  costPerVerified: S.object({ firstTryMicroUsd: S.nullable(Count), controlMicroUsd: S.nullable(Count), estimate: S.boolean() }),
  thresholds: S.object({ demoteAbove: Probability, reinstateBelow: Probability, minFinishedToReinstate: Count, antiFlapFloor: Count, margin: Probability }),
});
export type FirstTryGroup = S.Static<typeof FirstTryGroupSchema>;

/** The `explain --slice` view: the setting and one group per baseline and first-try model this slice has a ledger row for (none: no first-try task has run for it). */
export const FirstTrySliceViewSchema = S.object({
  sliceId: Id,
  setting: S.enumOf(['auto', 'baseline'] as const),
  groups: S.array(FirstTryGroupSchema, { maxItems: 8 }),
});
export type FirstTrySliceView = S.Static<typeof FirstTrySliceViewSchema>;
