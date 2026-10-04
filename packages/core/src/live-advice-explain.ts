/**
 * The plain-text lines `jevris explain` adds to the two live advisory decisions (owner decision
 * 2026-10-01, Jev as an active decision aid): repeated-failure advice and new-task advice. A leaf
 * module: the engine's `explainDecision` and the two advisers both read it, and it imports
 * nothing. The advisers write reason codes only (no text, no path, no tool output, no objective),
 * so this reads them back.
 *
 * repeated-failure codes: `FAIL_FAMILY_SHELL_NONZERO`, `FAIL_ATTEMPTS_3`, `FAIL_SOURCE_JEV`,
 * `FAIL_STEP_ARTIFACT` (or `ENVIRONMENT`, `CAPPED`, `NONE`), `FAIL_NEXT_STACK_TRACE`,
 * `FAIL_RULES_FAILING_TEST_OUTPUT`, `FAIL_ENV`, `FAIL_SAME_UNSURE`, `FAIL_SAME_JEV`, `FAIL_SUFFICIENT_JEV`,
 * `FAIL_ASKED_2`, `FAIL_USED_2`, `JEV_CACHE_HIT`, and the reason of the source (`REPEATED_FAILURE_*`).
 * new-task codes: `TASK_SOURCE_JEV`, `TASK_FAMILY_BUGFIX`, `TASK_OPEN_SCOPE`,
 * `TASK_ADVICE_QUESTION` (or `FAMILY`, `NONE`), `TASK_ASKED_2`, `TASK_USED_1`, `JEV_CACHE_MISS`, the
 * outcome of each core decision it ran (`TASK_C01_SELECTED`, `TASK_C02_NOT_MATERIAL`, `TASK_C04_SINGLE_MATCH`)
 * and the reason (`NEW_TASK_*`).
 * scope-change codes: `SCOPE_SOURCE_JEV` (or `RULES`), `SCOPE_EFFECTS_2`, `SCOPE_ASSESSED_1`,
 * `SCOPE_PAUSED_1`, `SCOPE_CLASS_PACKAGE_INSTALL`, `JEV_CACHE_MISS`, and the reason (`SCOPE_*`).
 * worker-readiness codes: `READY_SOURCE_JEV` (or `RULES`), `READY_STATE_READY` (or `NOT_READY`, `UNSURE`, `NONE`),
 * `READY_P_77`, `READY_FILES_2`, `READY_CHECKS_2`, `READY_PROTECTED_0`, `READY_VERB_FIX`, `JEV_CACHE_MISS`, and the
 * reason (`WORKER_READINESS_*`).
 */

/** The decision spec id a repeated-failure advisory record is recorded under. */
export const REPEATED_FAILURE_SPEC_ID = 'repeated-failure';
/** The decision spec id a new-task advisory record is recorded under. */
export const NEW_TASK_SPEC_ID = 'new-task';
/** The decision spec id a scope-change advisory record is recorded under. */
export const SCOPE_CHANGE_SPEC_ID = 'scope-change';
/** The decision spec id a worker-readiness advisory record is recorded under. */
export const WORKER_READINESS_EXPLAIN_SPEC_ID = 'worker-readiness';

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
  const enough = codes.includes('FAIL_SUFFICIENT_JEV') ? ' Jev said the evidence so far is enough to choose a fix, so no more is named.' : '';
  lines.push(
    `Questions: ${same}. Decision C05 (evidence sufficiency): is the evidence so far enough, and if not which one kind of evidence to get next, from a fixed list of seven kinds.${enough} ${asked === null || asked === 0 ? 'Jev was not asked' : `Jev was asked ${String(asked)} question${asked === 1 ? '' : 's'}${used === null ? '' : ` and ${String(used)} answer${used === 1 ? '' : 's'} cleared the confidence bar`}`} (${cacheText(codes, asked)}${ms}).`,
  );
  if (reason !== undefined) lines.push(`Reason: ${reason}.`);
  const evidence = record.proposedAction.evidenceIds ?? [];
  lines.push(`Evidence: ${evidence.length === 0 ? 'none' : evidence.slice(0, 16).join(', ')} (structured features only; no error text, paths, command text or tool output).`);
  lines.push('This is a suggestion. It changes no permission, runs nothing and marks nothing done; only a current receipt proves a check passed.');
  return lines;
}

const PART_TEXT: Readonly<Record<string, string>> = { C01: 'C01 task family', C02: 'C02 open point', C04: 'C04 template shortlist' };

function newTaskLines(record: LineRecord): string[] {
  const codes = record.reasonCodes;
  const family = codeAfter(codes, 'TASK_FAMILY_');
  const open = codeAfter(codes, 'TASK_OPEN_');
  const advice = codeAfter(codes, 'TASK_ADVICE_');
  const asked = countAfter(codes, 'TASK_ASKED_');
  const used = countAfter(codes, 'TASK_USED_');
  const ms = typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) ? `, ${Math.round(record.durationMs)} ms` : '';
  const reason = codes.find((code) => code.startsWith('NEW_TASK_'));
  const ran = ['C01', 'C02', 'C04'].flatMap((id) => {
    const found = codeAfter(codes, `TASK_${id}_`);
    return found === null ? [] : [`${PART_TEXT[id] ?? id} (${found})`];
  });
  const lines: string[] = [];
  lines.push(`New task: Jev read the request once, with source egress approved, after the hook had answered; any advice waits for the next event. The request itself was not changed.`);
  lines.push(
    `Family: ${family === null || family === 'NONE' ? 'no family fitted clearly' : `looks like a ${nameOf(family)} task`}. Open question: ${open === null || open === 'NONE' ? 'none that would change the implementation' : OPEN_TEXT[open] ?? nameOf(open)}.`,
  );
  lines.push(`Advice shown: ${advice === 'QUESTION' ? 'one question before implementing' : advice === 'FAMILY' ? 'the family, as a suggestion' : 'none'}.`);
  lines.push(
    `Decisions: ${ran.length === 0 ? 'none ran' : ran.join(', ')}. Which workflow family fits, and which one open point would most change the implementation, each from a fixed list. ${asked === null || asked === 0 ? 'Jev was not asked' : `Jev was asked ${String(asked)} decision${asked === 1 ? '' : 's'}${used === null ? '' : ` and ${String(used)} answer${used === 1 ? '' : 's'} cleared the confidence bar`}`} (${cacheText(codes, asked)}${ms}).`,
  );
  if (reason !== undefined) lines.push(`Reason: ${reason}.`);
  const evidence = record.proposedAction.evidenceIds ?? [];
  lines.push(`Evidence: ${evidence.length === 0 ? 'none' : evidence.slice(0, 16).join(', ')} (one screened span of the request; the question text and options are fixed and carry no user text).`);
  lines.push('This is a suggestion. It never blocks the request and changes no permission.');
  return lines;
}

const EFFECT_CLASS_NAME: Readonly<Record<string, string>> = {
  CREDENTIAL_ACCESS: 'reading or changing a credential location',
  NETWORK_EGRESS: 'contacting a host outside the workspace policy',
  DESTRUCTIVE: 'deleting or rewriting data that is hard to recover',
  PRIVILEGED: 'changing privileges or system configuration',
  PACKAGE_INSTALL: 'installing or running third-party code',
  CI_SECRETS: 'touching CI secrets',
};

function scopeChangeLines(record: LineRecord): string[] {
  const codes = record.reasonCodes;
  const effects = countAfter(codes, 'SCOPE_EFFECTS_');
  const assessed = countAfter(codes, 'SCOPE_ASSESSED_');
  const paused = countAfter(codes, 'SCOPE_PAUSED_');
  const classes = codes.filter((code) => code.startsWith('SCOPE_CLASS_')).map((code) => EFFECT_CLASS_NAME[code.slice('SCOPE_CLASS_'.length)] ?? nameOf(code.slice('SCOPE_CLASS_'.length)));
  const who = codeAfter(codes, 'SCOPE_SOURCE_') === 'JEV' ? 'Jev' : 'rules';
  const ms = typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) ? `, ${Math.round(record.durationMs)} ms` : '';
  const reason = codes.find((code) => code.startsWith('SCOPE_') && !/^SCOPE_(?:SOURCE|EFFECTS|ASSESSED|PAUSED|CLASS)_/.test(code));
  const lines: string[] = [];
  lines.push(`Scope change: at a diff boundary of a session working on a task with an approved scope, ${effects === null ? 'some' : String(effects)} requested effect${effects === 1 ? ' was' : 's were'} not part of what was approved${classes.length === 0 ? '' : ` (${classes.join('; ')})`}; the finding is from ${who} and pauses nothing.`);
  lines.push(`Questions: for each effect, a fixed question: does it go beyond the approved scope. ${assessed === null || assessed === 0 ? 'Jev did not judge any' : `Jev judged ${String(assessed)}`}${paused === null ? '' : `; ${String(paused)} ${paused === 1 ? 'was' : 'were'} found to go beyond it`} (${cacheText(codes, effects)}${ms}).`);
  if (reason !== undefined) lines.push(`Reason: ${reason}.`);
  const evidence = record.proposedAction.evidenceIds ?? [];
  lines.push(`Evidence: ${evidence.length === 0 ? 'none' : evidence.slice(0, 16).join(', ')} (effect classes as codes and counts of the approved scope; no command, path or text).`);
  lines.push('This is a suggestion. It pauses nothing, approves nothing and changes no permission; an approval counts only from a trusted channel, never from repository text.');
  return lines;
}

function workerReadinessLines(record: LineRecord): string[] {
  const codes = record.reasonCodes;
  const state = codeAfter(codes, 'READY_STATE_');
  const probability = countAfter(codes, 'READY_P_');
  const files = countAfter(codes, 'READY_FILES_');
  const checks = countAfter(codes, 'READY_CHECKS_');
  const protectedClasses = countAfter(codes, 'READY_PROTECTED_');
  const verb = codeAfter(codes, 'READY_VERB_');
  const who = codeAfter(codes, 'READY_SOURCE_') === 'JEV' ? 'Jev' : 'the rules';
  const ms = typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) ? `, ${Math.round(record.durationMs)} ms` : '';
  const reason = codes.find((code) => code.startsWith('WORKER_READINESS_'));
  const says = state === 'READY' ? 'a worker model can finish it and pass its checks' : state === 'NOT_READY' ? 'it is not a bounded task for a worker model' : state === 'UNSURE' ? 'Jev was not sure either way' : 'nothing was stated';
  const lines: string[] = [];
  lines.push(`Worker readiness: before this owned worker was launched, ${who} judged the task from its structure alone: ${says}${probability === null ? '' : ` (probability ${String(probability)} percent that it is bounded)`}. The launch did not wait on it and does not depend on it.`);
  lines.push(`The task, as features: ${files === null ? 'some' : String(files)} file${files === 1 ? '' : 's'}, ${checks === null ? 'some' : String(checks)} acceptance check${checks === 1 ? '' : 's'}, ${protectedClasses === null || protectedClasses === 0 ? 'no protected path class' : `${String(protectedClasses)} protected path class${protectedClasses === 1 ? '' : 'es'}`}, kind of work ${verb === null || verb === 'NONE' ? 'not clear' : nameOf(verb)}.`);
  lines.push(`Question: is it a bounded task a worker can finish and pass its acceptance checks without escalating, a fixed question over those facts only. ${codes.includes('JEV_CACHE_HIT') ? 'Answered from the cache' : codes.includes('JEV_CACHE_MISS') ? 'Asked Jev' : 'Jev was not asked'}${ms}.`);
  if (reason !== undefined) lines.push(`Reason: ${reason}.`);
  const evidence = record.proposedAction.evidenceIds ?? [];
  lines.push(`Evidence: ${evidence.length === 0 ? 'none' : evidence.slice(0, 16).join(', ')} (counts and categories only; no path, check name or task text).`);
  lines.push('This is advice. The launch is decided by the rules, the budget and the permissions; this never blocks it, starts it, picks a model or changes a reservation.');
  return lines;
}

/**
 * The explain lines for a recorded repeated-failure, new-task, scope-change or worker-readiness advisory
 * decision, or null when the record is none of them. The engine's own records under the same spec id (the Jev call itself, and a
 * cache hit, both of which also carry `DECISION_ADVISORY`) lack the adviser's marker code, a
 * `FAIL_FAMILY_` or `TASK_SOURCE_` code, and are left to the engine's generic lines.
 */
export function liveAdviceLines(record: LineRecord): string[] | null {
  const markers: Readonly<Record<string, string>> = { [REPEATED_FAILURE_SPEC_ID]: 'FAIL_FAMILY_', [NEW_TASK_SPEC_ID]: 'TASK_SOURCE_', [SCOPE_CHANGE_SPEC_ID]: 'SCOPE_EFFECTS_', [WORKER_READINESS_EXPLAIN_SPEC_ID]: 'READY_SOURCE_' };
  const marker = markers[record.specId];
  if (marker === undefined || !record.reasonCodes.includes('DECISION_ADVISORY')) return null;
  if (!record.reasonCodes.some((code) => code.startsWith(marker))) return null;
  switch (record.specId) {
    case REPEATED_FAILURE_SPEC_ID:
      return repeatedFailureLines(record);
    case NEW_TASK_SPEC_ID:
      return newTaskLines(record);
    case SCOPE_CHANGE_SPEC_ID:
      return scopeChangeLines(record);
    default:
      return workerReadinessLines(record);
  }
}
