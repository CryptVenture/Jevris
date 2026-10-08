/**
 * The plain-text lines `jevris explain` adds to a subagent-risk decision (owner decision 2026-10-08,
 * Jev as an active decision aid for one subagent launch). A leaf module: the engine's
 * `explainDecision` and the judge both read it, and it imports nothing. The judge writes reason codes
 * only (no text), so this reads them back: `SUBAGENT_RISK_SOURCE_JEV`, `SUBAGENT_RISK_CLASS_READ_ONLY`,
 * `SUBAGENT_RISK_SIZE_SMALL`, `SUBAGENT_RISK_LEVEL_LOW`, `SUBAGENT_RISK_RULES_MEDIUM`,
 * `SUBAGENT_RISK_JEV_HIGH`, `CONF_86`, `JEV_CACHE_HIT` and the outcome's own `SUBAGENT_RISK_*` code.
 */

/** The decision spec id a subagent-risk judgement is recorded under. */
export const SUBAGENT_RISK_SPEC_ID = 'subagent-risk';

function codeAfter(codes: readonly string[], prefix: string): string | null {
  const found = codes.find((code) => code.startsWith(prefix));
  return found === undefined ? null : found.slice(prefix.length);
}

const CLASS_TEXT: Readonly<Record<string, string>> = {
  READ_ONLY: 'a read-only built-in type (it reads and searches, and edits nothing)',
  GENERAL_PURPOSE: 'the general-purpose type',
  CUSTOM: 'a custom or unlisted type',
};

/**
 * The explain lines for a recorded subagent-risk judgement: the launch's content-free features, the
 * level the rules gave, whether Jev was asked and what it answered, and the level used. Null when the
 * record is not one: the engine's own record of the Jev call (and of a cache hit) carries the same spec
 * id but not the judge's `SUBAGENT_RISK_SOURCE_` code, and is explained as a provider call.
 */
export function subagentRiskLines(record: { readonly specId: string; readonly reasonCodes: readonly string[]; readonly durationMs?: number | null; readonly proposedAction: { readonly kind: string; readonly evidenceIds?: readonly string[] } }): string[] | null {
  if (record.specId !== SUBAGENT_RISK_SPEC_ID) return null;
  const codes = record.reasonCodes;
  if (!codes.some((code) => code.startsWith('SUBAGENT_RISK_SOURCE_'))) return null;
  const source = codeAfter(codes, 'SUBAGENT_RISK_SOURCE_');
  const klass = codeAfter(codes, 'SUBAGENT_RISK_CLASS_');
  const size = codeAfter(codes, 'SUBAGENT_RISK_SIZE_');
  const level = codeAfter(codes, 'SUBAGENT_RISK_LEVEL_');
  const rules = codeAfter(codes, 'SUBAGENT_RISK_RULES_');
  const jev = codeAfter(codes, 'SUBAGENT_RISK_JEV_');
  const confidence = codeAfter(codes, 'CONF_');
  const cache = codes.includes('JEV_CACHE_HIT') ? 'cache hit' : codes.includes('JEV_CACHE_MISS') ? 'asked Jev' : 'Jev not asked';
  const ms = typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) ? `, ${Math.round(record.durationMs)} ms` : '';
  const lines: string[] = [];
  lines.push(`Subagent launch risk: ${level === null ? 'unknown' : level.toLowerCase()} (${source === 'JEV' ? 'lowered by Jev from the rules\' level' : 'by rules'}, advice only). It decides only whether this one Agent call may run on a cheaper model; the session's model is never changed.`);
  lines.push(`Launch features: ${klass === null ? 'unknown type' : (CLASS_TEXT[klass] ?? klass.toLowerCase())}; tool input ${size === null ? 'of unknown size' : size.toLowerCase()}. The prompt and the description are never read or sent.`);
  lines.push(`Rules: ${rules === null ? 'no answer' : rules.toLowerCase()} risk. Question: how risky is it to run this launch on a cheaper model (low, medium, high or unknown). Jev ${jev === null ? 'was not asked or gave no usable answer' : `answered ${jev.toLowerCase()}`}${confidence === null ? '' : ` with confidence ${confidence} percent`} (${cache}${ms}). For a write-capable type the rules say high (no change of model); only a Jev answer at the confidence floors lowers it, and any miss leaves high standing.`);
  const reason = codes.find((code) => code.startsWith('SUBAGENT_RISK_') && !/^SUBAGENT_RISK_(SOURCE|CLASS|SIZE|LEVEL|RULES|JEV)_/.test(code));
  if (reason !== undefined) lines.push(`Reason: ${reason}.`);
  const evidence = record.proposedAction.evidenceIds ?? [];
  lines.push(`Evidence: ${evidence.length === 0 ? 'none' : evidence.slice(0, 16).join(', ')} (structured features only).`);
  return lines;
}
