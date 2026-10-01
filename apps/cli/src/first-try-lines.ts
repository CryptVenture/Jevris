/**
 * The plain-text lines for Sonnet-first routing in the places people look: one line in
 * `jevris status`, a block in `jevris explain --slice`, a section in `jevris cost-report`. They are
 * built from the views `@jevris/orchestrator` computes (`first-try-view.ts`), so the words and the
 * numbers cannot drift from the JSON. Money is integer micro-USD (dollars in brackets for reading),
 * a figure without data reads "unknown" or "not measured yet", and quality is never claimed: a
 * verified task is a passing check, not a quality score. The wording is stable; the docs name it.
 */
import type { FirstTryGroup, FirstTrySliceCounts, FirstTrySliceView, FirstTryStatus } from '@jevris/contracts';
import type { FirstTryCostView } from '@jevris/orchestrator';

const dollars = (micro: number): string => `$${(micro / 1_000_000).toFixed(4)}`;
const pct = (share: number): string => `${String(Math.round(share * 100))}%`;
const prob = (value: number): string => value.toFixed(3);

/** `5 micro-USD ($0.0000)`: the integer first, so a machine reader and a person see the same figure. */
function micro(value: number): string {
  return `${String(value)} micro-USD (${dollars(value)})`;
}

function counts(c: FirstTrySliceCounts): string {
  return `${String(c.firstTry)} on the first try, ${String(c.baselineFirst)} on the baseline, ${String(c.learning)} still learning`;
}

const none = (c: FirstTrySliceCounts): boolean => c.firstTry + c.baselineFirst + c.learning === 0;

function whyOff(reasonCode: string | null, strongerIsPreview: boolean, baselineModelId: string | null): string {
  const base =
    reasonCode === 'FIRST_TRY_OFF'
      ? 'routing.firstTry is baseline'
      : reasonCode === 'NO_CHEAPER_RUNG'
        ? `no cheaper active model than ${baselineModelId ?? 'the baseline'}`
        : reasonCode === 'BREAK_EVEN_TOO_HIGH'
          ? 'no cheaper model could pay back a hand-off'
          : reasonCode === 'BASELINE_NOT_ELIGIBLE'
            ? 'the baseline model is not usable'
            : (reasonCode ?? 'no first-try step');
  return strongerIsPreview ? `${base}, and its only stronger model is a preview, which is never started automatically` : base;
}

/** The one line of `jevris status`: the setting and, per harness, the first-try and baseline models and how many slices start on each. */
export function firstTryStatusLine(view: FirstTryStatus): string {
  if (view.unavailable !== null) return `first-try slices: unavailable (the model registry is refused: ${view.unavailable})`;
  if (view.setting === 'baseline') return 'first-try slices: off (routing.firstTry is baseline, so the baseline model runs first)';
  const parts = view.harnesses.map((h) => {
    if (h.state === 'off') return `${h.harness}: off (${whyOff(h.reasonCode, h.strongerIsPreview, h.baselineModelId)})`;
    return `${h.harness}: ${h.firstTryModelId ?? 'none'} first, ${h.baselineModelId ?? 'none'} baseline, ${none(h.slices) ? 'no slices yet' : counts(h.slices)}`;
  });
  if (!none(view.other)) parts.push(`other baselines: ${counts(view.other)}`);
  return `first-try slices: ${parts.length === 0 ? 'no harness has a default baseline in the model registry' : parts.join('; ')}`;
}

const VERDICT_WORDS = { 'first-try': 'first try', 'baseline-first': 'baseline first', learning: 'learning' } as const;

function groupLines(g: FirstTryGroup): string[] {
  const t = g.thresholds;
  const next = g.controlShare.nextTaskArm === 'control' ? 'the control (baseline first)' : 'the first try (exploration)';
  const observed = g.controlShare.observed;
  const total = g.started.firstTry + g.started.control;
  const attempt = (a: { readonly meanMicroUsd: number | null; readonly samples: number }): string => (a.meanMicroUsd === null ? 'not measured yet' : `${String(a.meanMicroUsd)} micro-USD over ${String(a.samples)}`);
  const basis = g.breakEven.basis === 'measured' ? 'from the measured attempt costs' : 'estimated from list prices when the first task started';
  const lines = [
    `- ${g.firstTryModelId} before ${g.baselineModelId}: ${VERDICT_WORDS[g.verdict]} (${g.reasonCode})`,
    ...(g.lastChange === null ? [] : [`    last change: to ${g.lastChange.mode === 'first-try' ? 'first try' : 'baseline first'} (${g.lastChange.reasonCode}) after ${String(g.lastChange.atFinished)} finished first-try task(s)`]),
    `    tasks: first try ${String(g.started.firstTry)} started, ${String(g.firstTry.finished)} finished, ${String(g.firstTry.verified)} verified; ${String(g.firstTry.firstAttemptPass)} passed the check on the first attempt, ${String(g.firstTry.firstAttemptFail)} failed it, ${String(g.firstTry.handedOff)} handed up; control (baseline first) ${String(g.started.control)} started, ${String(g.control.finished)} finished, ${String(g.control.verified)} verified; ${String(g.started.open)} still open`,
    `    control share: ${observed === null ? 'no task started yet' : `${String(g.started.control)} of ${String(total)} started tasks (${pct(observed)})`}; the next task goes to ${next} with probability ${pct(g.controlShare.nextTaskShare)}`,
    `    break-even p* = (cS + h) / (cO + h) = ${g.breakEven.value.toFixed(4)} (${basis}); h = ${String(g.breakEven.overheadMicroUsd)} micro-USD (one verification plus the cache cost of the model change), cS = ${attempt(g.breakEven.firstAttempt)}, cO = ${attempt(g.breakEven.stepUpAttempt)}`,
    g.pBelowBreakEven === null
      ? `    first-try success: no labelled first attempt yet, so no probability; the day-1 rule stands until ${String(t.antiFlapFloor)} are labelled`
      : `    first-try success: P(success rate below p*) = ${prob(g.pBelowBreakEven)}; demote above ${t.demoteAbove.toFixed(2)}, come back below ${t.reinstateBelow.toFixed(2)} with at least ${String(t.minFinishedToReinstate)} finished first-try tasks`,
    g.pWorseThanBaseline === null
      ? `    against the control: no comparison yet, it needs ${String(t.antiFlapFloor)} finished tasks in each arm`
      : `    against the control: P(task success worse by more than ${t.margin.toFixed(3)}) = ${prob(g.pWorseThanBaseline)}; demote above ${t.demoteAbove.toFixed(2)}`,
  ];
  const cost = g.costPerVerified;
  const label = cost.estimate ? ' (estimate at list prices)' : '';
  lines.push(
    cost.firstTryMicroUsd === null && cost.controlMicroUsd === null
      ? '    cost per verified task: not measured yet'
      : `    cost per verified task: first try ${cost.firstTryMicroUsd === null ? 'not measured yet' : micro(cost.firstTryMicroUsd)}, control ${cost.controlMicroUsd === null ? 'not measured yet' : micro(cost.controlMicroUsd)}${label}`,
  );
  return lines;
}

/** The block of `jevris explain --slice`: the verdict, its counts and numbers, and its reason code, per baseline and first-try model. */
export function firstTrySliceLines(view: FirstTrySliceView): string[] {
  const head = `first-try routing for slice ${view.sliceId} (routing.firstTry ${view.setting}):`;
  if (view.groups.length === 0) {
    return [view.setting === 'baseline' ? `${head} no first-try task has run for it in this workspace, and the setting keeps the baseline model first` : `${head} no first-try task has run for it in this workspace yet`];
  }
  return [head, ...view.groups.flatMap(groupLines), 'quality: unknown; a verified task is a passing check, not a quality score'];
}

/** The section of `jevris cost-report`: tasks started, handed up and completed on the first try, and the spend against the baseline estimate. */
export function firstTryCostLines(view: FirstTryCostView): string[] {
  const head = `First-try routing (Sonnet-first), routing.firstTry ${view.setting}:`;
  if (view.started === 0) return [`first-try routing: no first-try task has run in this workspace yet (routing.firstTry ${view.setting})`];
  const figure = (value: number | null): string => (value === null ? 'unknown' : micro(Math.abs(value)));
  const label = view.estimate ? ' (estimate at list prices)' : '';
  const verdict =
    view.savedMicroUsd === null
      ? 'saved or spent against the baseline estimate: unknown'
      : view.savedMicroUsd >= 0
        ? `saved against the baseline estimate: ${figure(view.savedMicroUsd)}${label}`
        : `spent more than the baseline estimate: ${figure(view.savedMicroUsd)}${label}`;
  const lines = [
    head,
    `started on the first try: ${String(view.started)} (${String(view.open)} still open)`,
    `handed up to a stronger model: ${String(view.handedUp)}`,
    `completed on the first try: ${String(view.completedOnFirstTry)}`,
    `finished: ${String(view.finished)}, verified: ${String(view.verified)}`,
    `spent on the finished first-try tasks: ${figure(view.spentMicroUsd)}${view.spentMicroUsd === null ? '' : label}`,
    `baseline estimate for the same verified tasks: ${figure(view.baselineEstimateMicroUsd)}${view.baselineEstimateMicroUsd === null ? ' (no control task has been verified with every cost known)' : ''}`,
    verdict,
    `compared for ${String(view.compared)} of ${String(view.slices)} slice(s) with finished first-try tasks; the money figures cover only those`,
  ];
  for (const g of view.groups) {
    const money = g.savedMicroUsd === null ? 'saved or spent: unknown' : g.savedMicroUsd >= 0 ? `saved ${String(g.savedMicroUsd)} micro-USD` : `spent ${String(-g.savedMicroUsd)} micro-USD more`;
    lines.push(`- ${g.sliceId}: ${g.firstTryModelId} before ${g.baselineModelId}, ${String(g.started)} started, ${String(g.handedUp)} handed up, ${String(g.completedOnFirstTry)} completed on the first try, ${String(g.finished)} finished, ${String(g.verified)} verified; ${money}`);
  }
  lines.push(
    `control share caveat: the baseline estimate is the cost per verified task of the control (${String(view.controlStarted)} started, ${String(view.controlVerified)} verified), the small random share of low-risk tasks, at most 10%, that the route runs on the baseline first so the two can be compared. A small sample makes it noisy.`,
    'quality: unknown; a verified task is a passing check, not a quality score',
  );
  return lines;
}
