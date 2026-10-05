/**
 * The plain-text lines `jevris explain` adds to a check-relevance decision (owner decision
 * 2026-10-01, Jev as an active decision aid). A leaf module: the engine's `explainDecision` and the
 * ranker both read it, and it imports nothing. The ranker writes reason codes only (no text, no
 * check name, no path), so this reads them back: `RANK_SOURCE_JEV`, `RANK_SHAPE_SOURCE`,
 * `RANK_FIRST_TEST`, `RANK_WHY_SHAPE`, `RANK_CHECKS_5`, `RANK_ASKED_3`, `RANK_USED_3`,
 * `RANK_CAPPED`, `JEV_CACHE_HIT` and the reason of the source (`CHECK_RELEVANCE_*`).
 */

/** The decision spec id a check-relevance ranking is recorded under. */
export const CHECK_RELEVANCE_SPEC_ID = 'check-relevance';

const SHAPE_TEXT: Readonly<Record<string, string>> = {
  NONE: 'no change is known',
  DOCS: 'documentation edits only',
  TEST: 'test-file edits only',
  CONFIG: 'config or CI edits only',
  SOURCE: 'source edits',
  MIXED: 'a mix of edits',
};

function codeAfter(codes: readonly string[], prefix: string): string | null {
  const found = codes.find((code) => code.startsWith(prefix));
  return found === undefined ? null : found.slice(prefix.length);
}

function countAfter(codes: readonly string[], prefix: string): number | null {
  const raw = codeAfter(codes, prefix);
  return raw !== null && /^[0-9]{1,4}$/.test(raw) ? Number(raw) : null;
}

/**
 * The explain lines for a recorded check ranking: what was ranked, which source ordered it and
 * why, whether Jev was asked and answered, the evidence, and that no check is dropped. Null when
 * the record is not one: the engine's own record of the Jev call (and of a cache hit) carries the
 * same spec id but not the ranker's `RANK_SOURCE_` code, and is explained as a provider call.
 */
export function checkRelevanceLines(record: { readonly specId: string; readonly reasonCodes: readonly string[]; readonly durationMs?: number | null; readonly proposedAction: { readonly kind: string; readonly evidenceIds?: readonly string[] } }): string[] | null {
  if (record.specId !== CHECK_RELEVANCE_SPEC_ID) return null;
  const codes = record.reasonCodes;
  if (!codes.some((code) => code.startsWith('RANK_SOURCE_'))) return null;
  const source = codeAfter(codes, 'RANK_SOURCE_');
  const shape = codeAfter(codes, 'RANK_SHAPE_');
  const first = codeAfter(codes, 'RANK_FIRST_');
  const why = codeAfter(codes, 'RANK_WHY_');
  const checks = countAfter(codes, 'RANK_CHECKS_');
  const asked = countAfter(codes, 'RANK_ASKED_');
  const used = countAfter(codes, 'RANK_USED_');
  const ms = typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) ? `, ${Math.round(record.durationMs)} ms` : '';
  const cache = codes.includes('JEV_CACHE_HIT') ? 'cache hit' : codes.includes('JEV_CACHE_MISS') ? 'asked Jev' : 'Jev not asked';
  const reason = codes.find((code) => code.startsWith('CHECK_RELEVANCE_'));
  const who = source === 'JEV' ? 'Jev' : 'rules';
  const lines: string[] = [];
  lines.push(`Check ranking: ${checks === null ? 'the approved checks' : `${String(checks)} approved checks`} ordered by how much this change needs them; the order is advice from ${who} and decides nothing.`);
  lines.push(`Change shape: ${shape === null ? 'unknown' : (SHAPE_TEXT[shape] ?? shape.toLowerCase())}. First check: ${first === null ? 'unknown' : `a ${first.toLowerCase()} check`}${why === 'FAILED' ? ' (its last run failed)' : why === 'JEV' ? ' (Jev rated it most relevant)' : why === 'SHAPE' ? ' (most relevant to this change shape)' : ''}.`);
  lines.push(
    `Question: how likely a change of this shape needs each check before it can be called done (0 to 4). ${asked === null || asked === 0 ? 'Jev was not asked' : `Jev was asked about ${String(asked)} checks${used === null ? '' : ` and ${String(used)} scores were used`}`} (${cache}${ms}).${codes.includes('RANK_CAPPED') ? ' More than 12 checks were open, so the rest kept the rules order.' : ''}`,
  );
  if (reason !== undefined) lines.push(`Reason: ${reason}.`);
  const evidence = record.proposedAction.evidenceIds ?? [];
  lines.push(`Evidence: ${evidence.length === 0 ? 'none' : evidence.slice(0, 16).join(', ')} (structured features only; no path names, diffs, check output or check names).`);
  lines.push('Every approved check still runs: the order never skips, waives or passes a check, and only receipts decide done.');
  return lines;
}
