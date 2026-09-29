/**
 * Declarative question compiler and linter (DEC-03, §7.4, §2.4).
 *
 * Errors refuse the spec: absent instructions, duplicate or ambiguous criteria, unsupported
 * primitive types, empty or excess options, invalid rubric length, rubric levels without an
 * observable anchor, sensitive raw fields, and evidence used but not declared.
 *
 * Warnings are kept with the compiled spec: negation, several judgments in one question,
 * arithmetic or counting, and dependence on a sibling answer (questions in one request are
 * evaluated independently, §2.3).
 *
 * The question hash is the canonical content hash, so any change to a question, a criterion or
 * the criteria order creates a new decision version.
 */
import {
  DECISION_FALLBACKS,
  DecisionSpecContract,
  MAX_QUESTIONS,
  containsSecret,
  contentHash,
  questionHash,
  type DecisionSpec,
  type JevQuestions,
} from '@jevris/contracts';

export const LINT_ERRORS = [
  'NO_QUESTIONS',
  'TOO_MANY_QUESTIONS',
  'INVALID_QUESTION_ID',
  'UNSUPPORTED_TYPE',
  'MISSING_INSTRUCTIONS',
  'EMPTY_OPTIONS',
  'EXCESS_OPTIONS',
  'DUPLICATE_CRITERIA',
  'AMBIGUOUS_CRITERIA',
  'RUBRIC_LENGTH',
  'RUBRIC_ANCHOR',
  'SENSITIVE_RAW_FIELD',
  'UNDECLARED_EVIDENCE',
  'INVALID_NOUL_CRITERIA',
] as const;
export type LintError = (typeof LINT_ERRORS)[number];

export const LINT_WARNINGS = ['NEGATION', 'MULTI_JUDGMENT', 'ARITHMETIC', 'SIBLING_DEPENDENCE', 'NO_UNKNOWN_OPTION'] as const;
export type LintWarning = (typeof LINT_WARNINGS)[number];

export interface LintFinding<C extends string> {
  readonly questionId: string | null;
  readonly code: C;
  /** A criterion key or index, when the finding is about one criterion. */
  readonly criterion?: string;
}

export interface LintOptions {
  /** Evidence ids the pack declares (the spec's evidence requirements). */
  readonly declaredEvidence?: readonly string[];
  /** Evidence ids the pack's packet actually reads. Each must be declared. */
  readonly usedEvidence?: readonly string[];
  /** Choice options above this are refused (a bounded shortlist comes first, §7.3). */
  readonly maxChoiceOptions?: number;
  /** Raw field names that must never appear in question text (e.g. `sourceText`). */
  readonly sensitiveFields?: readonly string[];
}

export interface LintReport {
  readonly ok: boolean;
  readonly errors: readonly LintFinding<LintError>[];
  readonly warnings: readonly LintFinding<LintWarning>[];
  readonly questionHash: string | null;
  /**
   * Order-sensitive hash (question ids and Choice criteria in wire order). The contracts'
   * `questionHash` canonicalizes object key order, so this one is used where criteria order
   * matters (the decision cache key, §7.2).
   */
  readonly orderHash: string | null;
}

export const DEFAULT_SENSITIVE_FIELDS: readonly string[] = Object.freeze([
  'sourceText',
  'sourceBody',
  'fileText',
  'fileContent',
  'rawDiff',
  'transcript',
  'apiKey',
  'password',
  'token',
  'secret',
  'credential',
]);

/** Same as the contracts' question id pattern (§2.5 reference client). */
const QUESTION_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const PLACEHOLDER = /\$\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}|\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;
const NEGATION = /\b(?:not|never|no|none of|neither|nor|without|isn't|aren't|doesn't|don't|cannot|can't|won't)\b/i;
const ARITHMETIC = /\b(?:how many|count|sum|total|average|mean|percent(?:age)?|calculate|compute|multiply|divide|add up|subtract|difference between \d)\b|\d+\s*[-+*/x×÷]\s*\d+/i;
const SIBLING = /\b(?:previous|prior|above|earlier|preceding|other) (?:question|answer|result)s?\b|\banswer to\b/i;
const UNKNOWN_KEYS = /^(?:unknown|none|other|insufficient|unclear|not_applicable|n_a)(?:_.*)?$/i;
const MIN_ANCHOR_CHARS = 12;

function normalized(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tooVague(text: string): boolean {
  const plain = normalized(text);
  if (plain.length < MIN_ANCHOR_CHARS) return true;
  return /^(?:very )?(?:low|medium|high|none|some|many|bad|good|poor|fair|excellent|level \d+|\d+)$/.test(plain);
}

function multiJudgment(instructions: string): boolean {
  const marks = (instructions.match(/\?/g) ?? []).length;
  if (marks > 1) return true;
  return /\?\s*\S/.test(instructions.trim()) || /\b(?:and also|as well as whether|and whether)\b/i.test(instructions);
}

/** Hash over questions and Choice criteria in their wire order (object key order kept). */
export function questionOrderHash(questions: JevQuestions): string {
  const ordered = Object.entries(questions).map(([id, question]) => {
    const q = question as { type: string; instructions: string; criteria?: unknown };
    const criteria = q.criteria !== null && typeof q.criteria === 'object' && !Array.isArray(q.criteria) ? Object.entries(q.criteria as Record<string, unknown>) : (q.criteria ?? null);
    return [id, q.type, q.instructions, criteria];
  });
  return contentHash(ordered);
}

/** Lints one question set. It never sends anything. */
export function lintQuestions(questions: JevQuestions, options: LintOptions = {}): LintReport {
  const errors: LintFinding<LintError>[] = [];
  const warnings: LintFinding<LintWarning>[] = [];
  const maxChoice = options.maxChoiceOptions ?? 32;
  const sensitive = (options.sensitiveFields ?? DEFAULT_SENSITIVE_FIELDS).map((field) => field.toLowerCase());
  if (questions === null || typeof questions !== 'object' || Array.isArray(questions)) {
    return { ok: false, errors: [{ questionId: null, code: 'NO_QUESTIONS' }], warnings: [], questionHash: null, orderHash: null };
  }
  const ids = Object.keys(questions);
  if (ids.length === 0) errors.push({ questionId: null, code: 'NO_QUESTIONS' });
  if (ids.length > MAX_QUESTIONS) errors.push({ questionId: null, code: 'TOO_MANY_QUESTIONS' });

  const textFindings = (questionId: string, text: string, criterion?: string): void => {
    const at = criterion === undefined ? { questionId } : { questionId, criterion };
    if (containsSecret(text)) errors.push({ ...at, code: 'SENSITIVE_RAW_FIELD' });
    for (const match of text.matchAll(PLACEHOLDER)) {
      const name = (match[1] ?? match[2] ?? '').toLowerCase();
      const leaf = name.split('.').pop() ?? name;
      if (sensitive.some((field) => leaf === field || leaf.endsWith(field))) errors.push({ ...at, code: 'SENSITIVE_RAW_FIELD' });
    }
  };

  for (const id of ids) {
    const question = (questions as Record<string, unknown>)[id] as Record<string, unknown> | undefined;
    if (!QUESTION_ID.test(id)) errors.push({ questionId: id, code: 'INVALID_QUESTION_ID' });
    if (question === undefined || question === null || typeof question !== 'object') {
      errors.push({ questionId: id, code: 'UNSUPPORTED_TYPE' });
      continue;
    }
    const type = question['type'];
    if (type !== 'choice' && type !== 'score' && type !== 'noul') {
      errors.push({ questionId: id, code: 'UNSUPPORTED_TYPE' });
      continue;
    }
    const instructions = question['instructions'];
    if (typeof instructions !== 'string' || instructions.trim().length === 0) {
      errors.push({ questionId: id, code: 'MISSING_INSTRUCTIONS' });
    } else {
      textFindings(id, instructions);
      if (NEGATION.test(instructions)) warnings.push({ questionId: id, code: 'NEGATION' });
      if (multiJudgment(instructions)) warnings.push({ questionId: id, code: 'MULTI_JUDGMENT' });
      if (ARITHMETIC.test(instructions)) warnings.push({ questionId: id, code: 'ARITHMETIC' });
      const siblings = ids.filter((other) => other !== id && other.length >= 3 && instructions.includes(other));
      if (SIBLING.test(instructions) || siblings.length > 0) warnings.push({ questionId: id, code: 'SIBLING_DEPENDENCE' });
    }
    const criteria = question['criteria'];
    if (type === 'choice') {
      if (criteria === null || typeof criteria !== 'object' || Array.isArray(criteria)) {
        errors.push({ questionId: id, code: 'EMPTY_OPTIONS' });
        continue;
      }
      const entries = Object.entries(criteria as Record<string, unknown>);
      if (entries.length < 2) errors.push({ questionId: id, code: 'EMPTY_OPTIONS' });
      if (entries.length > maxChoice) errors.push({ questionId: id, code: 'EXCESS_OPTIONS' });
      const seen = new Map<string, string>();
      for (const [key, text] of entries) {
        if (typeof text !== 'string' || text.trim() === '') {
          errors.push({ questionId: id, code: 'EMPTY_OPTIONS', criterion: key });
          continue;
        }
        textFindings(id, text, key);
        const norm = normalized(text);
        const previous = seen.get(norm);
        if (previous !== undefined) errors.push({ questionId: id, code: text.trim() === (criteria as Record<string, string>)[previous]?.trim() ? 'DUPLICATE_CRITERIA' : 'AMBIGUOUS_CRITERIA', criterion: key });
        else seen.set(norm, key);
        if (normalized(key) === norm) errors.push({ questionId: id, code: 'AMBIGUOUS_CRITERIA', criterion: key });
      }
      if (!entries.some(([key]) => UNKNOWN_KEYS.test(key))) warnings.push({ questionId: id, code: 'NO_UNKNOWN_OPTION' });
    } else if (type === 'score') {
      if (!Array.isArray(criteria)) {
        errors.push({ questionId: id, code: 'RUBRIC_LENGTH' });
        continue;
      }
      if (criteria.length < 2 || criteria.length > 10) errors.push({ questionId: id, code: 'RUBRIC_LENGTH' });
      const seen = new Set<string>();
      criteria.forEach((text: unknown, index: number) => {
        const at = String(index);
        if (typeof text !== 'string' || text.trim() === '') {
          errors.push({ questionId: id, code: 'RUBRIC_ANCHOR', criterion: at });
          return;
        }
        textFindings(id, text, at);
        if (tooVague(text)) errors.push({ questionId: id, code: 'RUBRIC_ANCHOR', criterion: at });
        const norm = normalized(text);
        if (seen.has(norm)) errors.push({ questionId: id, code: 'DUPLICATE_CRITERIA', criterion: at });
        seen.add(norm);
      });
    } else if (criteria !== undefined) {
      const c = criteria as Record<string, unknown>;
      const keys = criteria !== null && typeof criteria === 'object' && !Array.isArray(criteria) ? Object.keys(c).sort() : [];
      if (keys.join(',') !== 'false,true' || typeof c['true'] !== 'string' || typeof c['false'] !== 'string') {
        errors.push({ questionId: id, code: 'INVALID_NOUL_CRITERIA' });
      } else {
        textFindings(id, c['true'], 'true');
        textFindings(id, c['false'], 'false');
        if (normalized(c['true']) === normalized(c['false'])) errors.push({ questionId: id, code: 'AMBIGUOUS_CRITERIA' });
      }
    }
  }

  if (options.usedEvidence !== undefined) {
    const declared = new Set(options.declaredEvidence ?? []);
    for (const used of options.usedEvidence) if (!declared.has(used)) errors.push({ questionId: null, code: 'UNDECLARED_EVIDENCE', criterion: used });
  }

  let hash: string | null = null;
  let order: string | null = null;
  try {
    hash = questionHash(questions);
    order = questionOrderHash(questions);
  } catch {
    hash = null;
  }
  return { ok: errors.length === 0, errors, warnings, questionHash: hash, orderHash: order };
}

export interface CompileSpecInput {
  readonly id: string;
  readonly version: string;
  readonly questions: JevQuestions;
  readonly evidenceRequirements?: readonly string[];
  readonly usedEvidence?: readonly string[];
  readonly deadlineMs: number;
  readonly fallback: (typeof DECISION_FALLBACKS)[number];
  readonly calibrationId?: string | null;
}

export type CompileSpecResult =
  | { readonly ok: true; readonly spec: DecisionSpec; readonly questions: JevQuestions; readonly warnings: readonly LintFinding<LintWarning>[] }
  | { readonly ok: false; readonly errors: readonly LintFinding<LintError>[]; readonly contractIssues: readonly string[] };

/** Compiles a pack's declarative questions into a versioned DecisionSpec, or refuses. */
export function compileDecisionSpec(input: CompileSpecInput): CompileSpecResult {
  const report = lintQuestions(input.questions, {
    declaredEvidence: input.evidenceRequirements ?? [],
    ...(input.usedEvidence === undefined ? {} : { usedEvidence: input.usedEvidence }),
  });
  if (!report.ok || report.questionHash === null) return { ok: false, errors: report.errors, contractIssues: [] };
  const checked = DecisionSpecContract.validate({
    id: input.id,
    version: input.version,
    questionHash: report.questionHash,
    evidenceRequirements: [...(input.evidenceRequirements ?? [])],
    deadlineMs: input.deadlineMs,
    fallback: input.fallback,
    calibrationId: input.calibrationId ?? null,
  });
  if (!checked.ok) return { ok: false, errors: [], contractIssues: checked.issues.map((issue) => `${issue.path}:${issue.code}`) };
  return { ok: true, spec: checked.value, questions: input.questions, warnings: report.warnings };
}
