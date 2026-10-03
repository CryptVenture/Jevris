/**
 * The plain-text lines `jevris explain` adds to the two live advisory decisions (owner decision
 * 2026-10-01, Jev as an active decision aid): repeated-failure advice and new-task advice. A leaf
 * module: the engine's `explainDecision` and the two advisers both read it, and it imports
 * nothing. The advisers write reason codes only (no text, no path, no tool output, no objective),
 * so this reads them back.
 *
 * repeated-failure codes: `FAIL_FAMILY_SHELL_NONZERO`, `FAIL_ATTEMPTS_3`, `FAIL_SOURCE_JEV`,
 * `FAIL_STEP_ARTIFACT` (or `ENVIRONMENT`, `CAPPED`, `NONE`), `FAIL_NEXT_STACK_TRACE`,
 * `FAIL_RULES_FAILING_TEST_OUTPUT`, `FAIL_ENV`, `FAIL_SAME_UNSURE`, `FAIL_SAME_JEV`,
 * `FAIL_ASKED_2`, `FAIL_USED_2`, `JEV_CACHE_HIT`, and the reason of the source (`REPEATED_FAILURE_*`).
 * new-task codes: `TASK_SOURCE_JEV`, `TASK_FAMILY_BUGFIX`, `TASK_OPEN_SCOPE`,
 * `TASK_ADVICE_QUESTION` (or `FAMILY`, `NONE`), `TASK_ASKED_2`, `TASK_USED_1`, `JEV_CACHE_MISS`, and
 * the reason (`NEW_TASK_*`).
 */

/** The decision spec id a repeated-failure advisory record is recorded under. */
export const REPEATED_FAILURE_SPEC_ID = 'repeated-failure';
/** The decision spec id a new-task advisory record is recorded under. */
export const NEW_TASK_SPEC_ID = 'new-task';

const FAMILY_TEXT: Readonly<Record<string, string>> = {
  SHELL: 'a shell command',
  EDIT: 'a file edit',
  READ: 'a file read or search',
  WEB: 'a web request',
  AGENT: 'a subagent call',
  MCP: 'an MCP tool call',
  SKILL: 'a skill call',
  OTHER: 'a tool call',
};

const EXIT_TEXT: Readonly<Record<string, string>> = {
  NONZERO: 'a non-zero exit',
  SIGNAL: 'a signal or negative exit',
  TIMEOUT: 'a timeout or interruption',
  ERROR: 'an error with no exit status',
};

const STEP_TEXT: Readonly<Record<string, string>> = {
  ARTIFACT: 'name the one kind of evidence to obtain next',
  ENVIRONMENT: 'say the failure looks environmental and ask for the environment information first',
  CAPPED: 'say the repair attempts are used up, so stop and report what was tried',
  NONE: 'say nothing (the rules could not tell whether this repeats, or nothing more is missing)',
};

const OPEN_TEXT: Readonly<Record<string, string>> = {
  SCOPE: 'what is in scope and what must stay as it is',
  ACCEPTANCE: 'how the task will be shown to be done',
  TARGET: 'which file, component or interface to change',
  EDGE_CASES: 'what should happen in the cases the request does not mention',
  COMPATIBILITY: 'whether existing behaviour or an interface must stay compatible',
};

function codeAfter(codes: readonly string[], prefix: string): string | null {
  const found = codes.find((code) => code.startsWith(prefix));
  return found === undefined ? null : found.slice(prefix.length);
}

function countAfter(codes: readonly string[], prefix: string): number | null {
  const raw = codeAfter(codes, prefix);
  return raw !== null && /^[0-9]{1,4}$/.test(raw) ? Number(raw) : null;
}

function nameOf(code: string | null): string {
  return code === null ? 'unknown' : code.toLowerCase().replace(/_/g, ' ');
}

type LineRecord = { readonly specId: string; readonly reasonCodes: readonly string[]; readonly durationMs?: number | null; readonly proposedAction: { readonly kind: string; readonly evidenceIds?: readonly string[] } };

function cacheText(codes: readonly string[], asked: number | null): string {
  if (asked === null || asked === 0) return 'Jev not asked';
  return codes.includes('JEV_CACHE_HIT') ? 'cache hit' : 'asked Jev';
}

function repeatedFailureLines(record: LineRecord): string[] {
  const codes = record.reasonCodes;
  const family = codeAfter(codes, 'FAIL_FAMILY_');
  const split = family === null ? -1 : family.indexOf('_');
  const tool = family === null ? null : split < 0 ? family : family.slice(0, split);
  const exit = family === null || split < 0 ? null : family.slice(split + 1);
  const attempts = countAfter(codes, 'FAIL_ATTEMPTS_');
  const asked = countAfter(codes, 'FAIL_ASKED_');
  const used = countAfter(codes, 'FAIL_USED_');
  const step = codeAfter(codes, 'FAIL_STEP_');
  const next = codeAfter(codes, 'FAIL_NEXT_');
  const rules = codeAfter(codes, 'FAIL_RULES_');
  const who = codeAfter(codes, 'FAIL_SOURCE_') === 'JEV' ? 'Jev' : 'rules';
  const ms = typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) ? `, ${Math.round(record.durationMs)} ms` : '';
  const reason = codes.find((code) => code.startsWith('REPEATED_FAILURE_'));
  const lines: string[] = [];
  lines.push(`Repeated failure: ${tool === null ? 'a tool call' : (FAMILY_TEXT[tool] ?? 'a tool call')} failed${exit === null ? '' : ` with ${EXIT_TEXT[exit] ?? nameOf(exit)}`}${attempts === null ? '' : ` ${String(attempts)} times in this session`}${codes.includes('FAIL_ENV') ? ' and looks environmental' : ''}; the advice is from ${who} and decides nothing.`);
  lines.push(`Advice: ${step === null ? 'unknown' : (STEP_TEXT[step] ?? nameOf(step))}${next === null ? '' : `: ${nameOf(next)}`}${rules !== null && rules !== next ? ` (the rules would have said ${nameOf(rules)})` : ''}.`);
  const same = codes.includes('FAIL_SAME_JEV') ? 'Jev read it as the same failure as before' : codes.includes('FAIL_SAME_UNSURE') ? 'the rules could not tell whether it is the same failure as before' : 'the same error signature as before';
  lines.push(
    `Questions: ${same}. Which one kind of evidence would help most, from a fixed list of seven kinds. ${asked === null || asked === 0 ? 'Jev was not asked' : `Jev was asked ${String(asked)} question${asked === 1 ? '' : 's'}${used === null ? '' : ` and ${String(used)} answer${used === 1 ? '' : 's'} cleared the confidence bar`}`} (${cacheText(codes, asked)}${ms}).`,
  );
  if (reason !== undefined) lines.push(`Reason: ${reason}.`);
  const evidence = record.proposedAction.evidenceIds ?? [];
  lines.push(`Evidence: ${evidence.length === 0 ? 'none' : evidence.slice(0, 16).join(', ')} (structured features only; no error text, paths, command text or tool output).`);
  lines.push('This is a suggestion. It changes no permission, runs nothing and marks nothing done; only a current receipt proves a check passed.');
  return lines;
}

function newTaskLines(record: LineRecord): string[] {
  const codes = record.reasonCodes;
  const family = codeAfter(codes, 'TASK_FAMILY_');
  const open = codeAfter(codes, 'TASK_OPEN_');
  const advice = codeAfter(codes, 'TASK_ADVICE_');
  const asked = countAfter(codes, 'TASK_ASKED_');
  const used = countAfter(codes, 'TASK_USED_');
  const ms = typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) ? `, ${Math.round(record.durationMs)} ms` : '';
  const reason = codes.find((code) => code.startsWith('NEW_TASK_'));
  const lines: string[] = [];
  lines.push(`New task: Jev read the request once, with source egress approved, after the hook had answered; any advice waits for the next event. The request itself was not changed.`);
  lines.push(
    `Family: ${family === null || family === 'NONE' ? 'no family fitted clearly' : `looks like a ${nameOf(family)} task`}. Open question: ${open === null || open === 'NONE' ? 'none that would change the implementation' : OPEN_TEXT[open] ?? nameOf(open)}.`,
  );
  lines.push(`Advice shown: ${advice === 'QUESTION' ? 'one question before implementing' : advice === 'FAMILY' ? 'the family, as a suggestion' : 'none'}.`);
  lines.push(`Questions: which workflow family fits, and which one open question would most change the implementation, each from a fixed list. ${asked === null || asked === 0 ? 'Jev was not asked' : `Jev was asked ${String(asked)} questions${used === null ? '' : ` and ${String(used)} answer${used === 1 ? '' : 's'} cleared the confidence bar`}`} (${cacheText(codes, asked)}${ms}).`);
  if (reason !== undefined) lines.push(`Reason: ${reason}.`);
  const evidence = record.proposedAction.evidenceIds ?? [];
  lines.push(`Evidence: ${evidence.length === 0 ? 'none' : evidence.slice(0, 16).join(', ')} (one screened span of the request; the question text and options are fixed and carry no user text).`);
  lines.push('This is a suggestion. It never blocks the request and changes no permission.');
  return lines;
}

/**
 * The explain lines for a recorded repeated-failure or new-task advisory decision, or null when the
 * record is neither. The engine's own records under the same spec id (the Jev call itself, and a
 * cache hit, both of which also carry `DECISION_ADVISORY`) lack the adviser's marker code, a
 * `FAIL_FAMILY_` or `TASK_SOURCE_` code, and are left to the engine's generic lines.
 */
export function liveAdviceLines(record: LineRecord): string[] | null {
  if (record.specId !== REPEATED_FAILURE_SPEC_ID && record.specId !== NEW_TASK_SPEC_ID) return null;
  if (!record.reasonCodes.includes('DECISION_ADVISORY')) return null;
  const marker = record.specId === REPEATED_FAILURE_SPEC_ID ? 'FAIL_FAMILY_' : 'TASK_SOURCE_';
  if (!record.reasonCodes.some((code) => code.startsWith(marker))) return null;
  return record.specId === REPEATED_FAILURE_SPEC_ID ? repeatedFailureLines(record) : newTaskLines(record);
}
