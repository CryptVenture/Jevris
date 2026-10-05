/**
 * Whether an adviser's summary record says Jev was asked, read back from its reason codes. A leaf
 * module: the engine's `explainDecision` reads it to write a Provider line that does not contradict
 * the adviser's own lines, and it imports nothing.
 *
 * Six advisers record ONE summary decision per run (`recordAdvice`): the task slice, the check
 * ranking, repeated-failure advice, new-task advice, the scope check and worker readiness. That record
 * holds the run's reason codes only; it makes no provider call of its own, so its usage is null and its
 * billing basis is `no-provider-call`. The Jev question the run asked is a separate decision record
 * (the engine's own, under the same spec id, with the model and the usage), and a question answered
 * from the decision cache is the engine's own cache-hit record. Every summary carries its adviser's
 * source code (`SLICE_SOURCE_`, `RANK_SOURCE_`, `FAIL_FAMILY_`, `TASK_SOURCE_`, `SCOPE_EFFECTS_` or
 * `READY_SOURCE_`), which the engine's own records never do.
 */

/** What a summary says about Jev in that run. */
export type AdviceJevUse = 'asked' | 'cache-hit' | 'not-asked';

function countAfter(codes: readonly string[], prefix: string): number {
  const found = codes.find((code) => code.startsWith(prefix));
  const raw = found === undefined ? '' : found.slice(prefix.length);
  return /^[0-9]{1,4}$/.test(raw) ? Number(raw) : 0;
}

const cacheCodes = (codes: readonly string[]): boolean => codes.includes('JEV_CACHE_HIT') || codes.includes('JEV_CACHE_MISS');

/** Per spec id: the code only the adviser writes, and how its codes say Jev was asked. */
const SUMMARIES: ReadonlyMap<string, { readonly marker: string; readonly asked: (codes: readonly string[]) => boolean }> = new Map([
  ['slice-classify', { marker: 'SLICE_SOURCE_', asked: cacheCodes }],
  ['check-relevance', { marker: 'RANK_SOURCE_', asked: (codes: readonly string[]) => countAfter(codes, 'RANK_ASKED_') > 0 }],
  ['repeated-failure', { marker: 'FAIL_FAMILY_', asked: (codes: readonly string[]) => countAfter(codes, 'FAIL_ASKED_') > 0 }],
  ['new-task', { marker: 'TASK_SOURCE_', asked: (codes: readonly string[]) => countAfter(codes, 'TASK_ASKED_') > 0 }],
  // A scope-change summary is written only after the effects were put to Jev (rules-only runs and gates record nothing).
  ['scope-change', { marker: 'SCOPE_EFFECTS_', asked: () => true }],
  ['worker-readiness', { marker: 'READY_SOURCE_', asked: cacheCodes }],
]);

/** True when the record is one adviser's summary of a run (not the engine's own record of a call or a cache hit). */
export function isAdviceSummary(record: { readonly specId: string; readonly reasonCodes: readonly string[] }): boolean {
  const summary = SUMMARIES.get(record.specId);
  return summary !== undefined && record.reasonCodes.some((code) => code.startsWith(summary.marker));
}

/** What an adviser's summary record says about Jev, or null for any other record. */
export function adviceJevUse(record: { readonly specId: string; readonly reasonCodes: readonly string[] }): AdviceJevUse | null {
  const summary = SUMMARIES.get(record.specId);
  if (summary === undefined || !isAdviceSummary(record)) return null;
  if (!summary.asked(record.reasonCodes)) return 'not-asked';
  return record.reasonCodes.includes('JEV_CACHE_HIT') ? 'cache-hit' : 'asked';
}
