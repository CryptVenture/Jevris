/**
 * The plain-text line `jevris explain` adds to a slice-classification decision (owner decision
 * 2026-10-01, Jev as an active decision aid). A leaf module: the engine's `explainDecision` and the
 * classifier both read it, and it imports nothing. The classifier writes reason codes only (no
 * text), so this reads them back: `SLICE_SOURCE_JEV`, `SLICE_ID_BOUNDED_EDIT`, `RISK_LOW`,
 * `JEV_SLICE_ISSUE_FIX`, `RULES_ALT_DOCS`, `JEV_CACHE_HIT`, `CONF_86` and the outcome's own code.
 */

/** The decision spec id a slice classification is recorded under. */
export const SLICE_CLASSIFY_SPEC_ID = 'slice-classify';

/** A slice id as a reason-code suffix: `bounded-edit` is `BOUNDED_EDIT`. */
export function sliceCodeOf(sliceId: string): string {
  return sliceId.toUpperCase().replace(/[^A-Z0-9]+/g, '_').slice(0, 40);
}

function sliceOfCode(code: string): string {
  return code.toLowerCase().replace(/_/g, '-');
}

function codeAfter(codes: readonly string[], prefix: string): string | null {
  const found = codes.find((code) => code.startsWith(prefix));
  return found === undefined ? null : found.slice(prefix.length);
}

/**
 * The explain lines for a recorded slice classification: what was asked, what answered, the
 * confidence, whether the cache answered, how long it took, and the rules alternative. Null when
 * the record is not one.
 */
export function sliceAssistLines(record: { readonly specId: string; readonly reasonCodes: readonly string[]; readonly durationMs?: number | null; readonly proposedAction: { readonly kind: string; readonly evidenceIds?: readonly string[] } }): string[] | null {
  if (record.specId !== SLICE_CLASSIFY_SPEC_ID) return null;
  const codes = record.reasonCodes;
  const source = codeAfter(codes, 'SLICE_SOURCE_');
  const used = codeAfter(codes, 'SLICE_ID_');
  const risk = codeAfter(codes, 'RISK_');
  const jev = codeAfter(codes, 'JEV_SLICE_');
  const rules = codeAfter(codes, 'RULES_ALT_');
  const confidence = codeAfter(codes, 'CONF_');
  const cache = codes.includes('JEV_CACHE_HIT') ? 'cache hit' : codes.includes('JEV_CACHE_MISS') ? 'asked Jev' : 'Jev not asked';
  const ms = typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) ? `, ${Math.round(record.durationMs)} ms` : '';
  const label = source === 'JEV' ? 'classified by Jev' : source === 'RULES' ? 'classified by rules' : 'no slice';
  const lines: string[] = [];
  lines.push(`Slice classification: ${used === null ? 'no slice was used, so the route keeps the approved baseline' : `slice ${sliceOfCode(used)} (${label}, advice only)`}; risk ${risk === null ? 'unknown' : risk.toLowerCase()}.`);
  lines.push(
    `Question: which listed task slice fits the structured features, and how risky is the task (0 to 4). Jev ${jev === null ? 'gave no usable answer' : `answered ${jev === 'UNKNOWN' ? 'unknown' : sliceOfCode(jev)}`}${confidence === null ? '' : ` with confidence ${confidence} percent`} (${cache}${ms}).`,
  );
  lines.push(`Rules alternative: ${rules === null ? 'none' : sliceOfCode(rules)}.`);
  const evidence = record.proposedAction.evidenceIds ?? [];
  lines.push(`Evidence: ${evidence.length === 0 ? 'none' : evidence.slice(0, 16).join(', ')} (structured features only; no file content or path names).`);
  lines.push('A Jev or rules slice is never a learned arm or a signed prior, and it never switches a model.');
  return lines;
}
