/**
 * The plain-text lines `jevris explain` adds to a model-tier decision (owner decision 2026-10-08, tiered
 * routing). A leaf module: the engine's `explainDecision` and the judge both read it, and it imports
 * nothing. The judge writes reason codes and evidence ids only (no text), so this reads them back:
 * `TIER_SOURCE_RULE` or `TIER_SOURCE_JEV`, `TIER_LEVEL_STEP_UP`, `TIER_RULES_BASELINE`, the rule that
 * decided (`TIER_PROTECTED_PATH`, ...), `TIER_FEATURE_*`, `TIER_JEV_*`, `CONF_86`, `JEV_CACHE_HIT`, and the
 * evidence ids `baseline-<model>`, `target-<model>` and `candidate-<model>`.
 */

/** The decision spec id a model-tier judgement is recorded under. */
export const MODEL_TIER_SPEC_ID = 'model-tier';

/** What every tier result says it is, until it is learned or signed. Owner wording (2026-10-08). */
export const TIER_RULES_LABEL = 'Rules-based default - not a learned route, not a signed prior';
export const TIER_JEV_LABEL = "Jev's suggestion from structured features; not a learned route, not a signed prior";
export const TIER_JEV_TEXT_LABEL = "Jev's suggestion from structured features and a screened task-text span; not a learned route, not a signed prior";

function codeAfter(codes: readonly string[], prefix: string): string | null {
  const found = codes.find((code) => code.startsWith(prefix));
  return found === undefined ? null : found.slice(prefix.length);
}

function idsWith(ids: readonly string[], prefix: string): string[] {
  return ids.filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length));
}

const LEVEL_TEXT: Readonly<Record<string, string>> = { STEP_UP: 'step up', STEP_DOWN: 'step down', BASELINE: 'stay on the baseline' };

/** The rules' reasons, in words. */
const REASON_TEXT: Readonly<Record<string, string>> = {
  TIER_PROTECTED_PATH: 'a protected path class other than a lockfile (a lockfile alone is never a step up)',
  TIER_MIGRATION: 'a migration',
  TIER_WIDE_CHANGE: 'a refactor or feature over 8 files',
  TIER_REPEATED_FAILURE: 'the same failure repeated up to the repair limit and not environmental',
  TIER_BASELINE_FAILED: 'a run on the baseline model already failed',
  TIER_DEEP_PLAN: 'a plan whose critical path is 4 tasks deep or more',
  TIER_HANDOFF_BLOCKED: 'a blocked hand-off',
  TIER_READ_ONLY_WORK: 'read-only work (documentation, review or research)',
  TIER_LOW_RISK_BOUNDED: 'low risk with an acceptance check and at most 5 files',
  TIER_BASELINE_DEFAULT: 'nothing makes the task clearly easier or harder',
  TIER_NO_SIGNALS: 'nothing is known about the task',
};

const FEATURE_PREFIX = 'TIER_FEATURE_';

/**
 * The explain lines for a recorded model-tier judgement. Null when the record is not one: the engine's own record
 * of the Jev call (and of a cache hit) carries the same spec id but not the judge's `TIER_SOURCE_` code, and is
 * explained as a provider call.
 */
export function modelTierLines(record: { readonly specId: string; readonly reasonCodes: readonly string[]; readonly durationMs?: number | null; readonly proposedAction: { readonly kind: string; readonly evidenceIds?: readonly string[] } }): string[] | null {
  if (record.specId !== MODEL_TIER_SPEC_ID) return null;
  const codes = record.reasonCodes;
  if (!codes.some((code) => code.startsWith('TIER_SOURCE_'))) return null;
  const source = codeAfter(codes, 'TIER_SOURCE_');
  const level = codeAfter(codes, 'TIER_LEVEL_');
  const rules = codeAfter(codes, 'TIER_RULES_');
  const evidence = record.proposedAction.evidenceIds ?? [];
  const baseline = idsWith(evidence, 'baseline-')[0] ?? 'unknown';
  const target = idsWith(evidence, 'target-')[0] ?? baseline;
  const candidates = idsWith(evidence, 'candidate-');
  const confidence = codeAfter(codes, 'CONF_');
  const jevPick = codeAfter(codes, 'TIER_JEV_PICK_');
  const textSent = codes.includes('TIER_TEXT_SENT');
  const cache = codes.includes('JEV_CACHE_HIT') ? 'cache hit' : codes.includes('JEV_CACHE_MISS') ? 'asked Jev' : 'Jev not asked';
  const ms = typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) ? `, ${Math.round(record.durationMs)} ms` : '';
  const lines: string[] = [];
  const label = source === 'JEV' ? (textSent ? TIER_JEV_TEXT_LABEL : TIER_JEV_LABEL) : TIER_RULES_LABEL;
  lines.push(`Model tier: ${level === null ? 'unknown' : (LEVEL_TEXT[level] ?? level.toLowerCase())}${target === baseline ? ` on ${baseline}` : `, ${target} against the baseline ${baseline}`}. ${label}. Advice about difficulty; it changes no permission, check, budget or consent.`);
  const features = codes.filter((code) => code.startsWith(FEATURE_PREFIX)).map((code) => code.slice(FEATURE_PREFIX.length).toLowerCase().replace(/_/g, ' '));
  lines.push(`Task features: ${features.length === 0 ? 'none' : features.join(', ')}. Only counts, categories and codes; no path name or task text is read, and a task-text span is sent only when source egress is approved (${textSent ? 'it was sent, screened' : 'none was sent'}).`);
  const why = codes.filter((code) => Object.hasOwn(REASON_TEXT, code)).map((code) => REASON_TEXT[code] as string);
  lines.push(`Rules: ${rules === null ? 'no answer' : (LEVEL_TEXT[rules] ?? rules.toLowerCase())}${why.length === 0 ? '' : ` (${why.join('; ')})`}. Jev ${jevPick === null ? 'was not asked or gave no usable answer' : `chose candidate ${jevPick.replace(/_/g, ' ').toLowerCase()}`}${confidence === null ? '' : ` with confidence ${confidence} percent`} (${cache}${ms}). Jev may choose only among the models listed, never below the rules' floor and never above their ceiling, and only at the confidence floors; any miss is the rules' answer.`);
  lines.push(`Candidates offered (the baseline's own provider, active and eligible here, cheapest first): ${candidates.length === 0 ? 'none' : candidates.slice(0, 8).join(', ')}.`);
  const reason = codes.find((code) => code.startsWith('TIER_') && !/^TIER_(SOURCE|LEVEL|RULES|FEATURE|JEV_PICK|TEXT|CANDIDATES)_/.test(code) && !Object.hasOwn(REASON_TEXT, code));
  if (reason !== undefined) lines.push(`Reason: ${reason}.`);
  const groups = evidence.filter((id) => id.startsWith('feature-') || id === 'task-text');
  lines.push(`Evidence: ${groups.length === 0 ? 'none' : groups.slice(0, 16).join(', ')}.`);
  return lines;
}
