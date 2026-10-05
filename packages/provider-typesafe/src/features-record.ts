/**
 * What the Jev feature suite's evidence record may hold (`jev-features-suite-1`).
 *
 * The record is documented as numbers and codes only: it is the one file a live run leaves behind, and it is kept and shared. A free-text field in a row
 * (a recommendation naming a module path, an error message, a sentence of Jev's) would carry workspace text the moment the suite is pointed at a real
 * workspace, so this module is the allow-list. A string is accepted only at a path that has a rule below, and only when it has the shape that rule names
 * (a reason code, an enum label, a decision id, a case id, a list of codes with no space and no path separator, a fixed title). A number, a boolean or a
 * null is accepted anywhere: none can carry text. Anything else is a violation, named by its path and never by its value.
 *
 * `recordViolations` is what the suite's own tests and the script run over the record before it is written, so a new field has to be listed here, with
 * its shape, to be written at all.
 */

export interface RecordCheckOptions {
  /** The fixed titles of the capability cases. With them a row's `title` must be one of them; without, it must have the shape of a title (no path separator). */
  readonly titles?: readonly string[];
}

/** One code, or a list of codes joined by `,`, `|` or `>` (an order, `p2>p1`): no space, no slash, no quote, so no sentence, path or command can be one. May be empty. */
const CODE_LIST = /^[A-Za-z0-9._:+,|>-]{0,200}$/;
/** An upper-case reason code. */
const REASON = /^[A-Z][A-Z0-9_]{0,63}$/;
/** A case id (`slice-docs-only`, `C70`, `C28-owned`). */
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const SPEC_ID = /^[a-z][a-z0-9-]{0,63}$/;
/** A question id in a request (`q`, `slice0`, `taskFamily`, `workerReady`): the suite's own fixed templates. */
const QUESTION_ID = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
/** What a capability case's summary calls its reason: a reason code, or the readiness label of the verify op (`not-verified`). */
const SUMMARY_REASON = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const DECISION_ID = /^d-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
/** The `verb` of an advice or of an op (`rank`, `pause`, `checkpoint`, `handoff.export`, `ask-focused-question`). */
const VERB = /^[a-z][a-z0-9.-]{0,40}$/;
/** A failure the driver names by code: `step <op>: <CODE>`, `<op>: <CODE>`, or `threw: <ErrorName>[:<CODE>]`. */
const FAILURE = /^(?:(?:step )?[a-z][a-z0-9.-]{0,40}: [A-Za-z][A-Za-z0-9_]{0,63}|threw: [A-Za-z]{1,40}(?::[A-Z0-9_]{1,40})?)$/;
/** A title of a case: a fixed phrase of the suite's own, with no path separator. */
const TITLE = /^[A-Za-z0-9][A-Za-z0-9 ,.:'()+-]{0,199}$/;

const oneOf = (...values: readonly string[]): ((text: string) => boolean) => (text) => values.includes(text);
const matches = (pattern: RegExp): ((text: string) => boolean) => (text) => pattern.test(text);

type Rule = (text: string) => boolean;

/** The groups of the engine part (`ENGINE_GROUPS` in features-suite.ts, kept as plain strings so this module has no import). */
const GROUPS = ['slice', 'plan-slices', 'check-ranking', 'repeated-failure', 'new-task', 'intent', 'security', 'worker-readiness', 'health-probe'] as const;

/** Exact paths (arrays are `[]`) and the shape a string there must have. */
const EXACT: ReadonlyMap<string, Rule> = new Map<string, Rule>([
  ['schemaVersion', oneOf('jev-features-suite-1')],
  ['kind', oneOf('jev-features-suite')],
  ['mode', oneOf('mock', 'live')],
  ['producedAt', matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/)],
  ['pinnedModel', matches(/^jev-\d+\.\d+\.\d+$/)],
  ['version', matches(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,40})?$/)],
  ['commit', matches(/^[0-9a-f]{40}$/)],
  ['failures[]', matches(REASON)],
  ['environment.os', matches(/^[a-z0-9_]{1,16}$/)],
  ['environment.arch', matches(/^[a-z0-9_]{1,16}$/)],
  ['environment.node', matches(/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,20})?$/)],
  // The engine groups.
  ['engine.schemaVersion', oneOf('jev-features-suite-1')],
  ['engine.pinnedModel', matches(/^jev-\d+\.\d+\.\d+$/)],
  ['engine.halted', matches(REASON)],
  ['engine.failures[]', matches(REASON)],
  ['engine.skipped[]', matches(CODE_LIST)],
  ['engine.groups[].group', oneOf(...GROUPS)],
  ['engine.rows[].group', oneOf(...GROUPS)],
  ['engine.rows[].id', matches(CASE_ID)],
  ['engine.rows[].spec', matches(SPEC_ID)],
  ['engine.rows[].phase', oneOf('cold', 'cached', 'gate')],
  ['engine.rows[].expected', matches(CODE_LIST)],
  ['engine.rows[].got', matches(CODE_LIST)],
  ['engine.rows[].rulesGot', matches(CODE_LIST)],
  ['engine.rows[].jevGot', matches(CODE_LIST)],
  ['engine.rows[].source', oneOf('jev', 'rules', 'none')],
  ['engine.rows[].reasonCode', matches(REASON)],
  ['engine.rows[].failureKind', matches(CODE_LIST)],
  ['engine.rows[].answers[].id', matches(QUESTION_ID)],
  ['engine.rows[].answers[].type', oneOf('choice', 'score', 'noul')],
  // The capability cases through a sidecar.
  ['capabilities.passes[].part', oneOf('a', 'b', 'c')],
  ['capabilities.passes[].egress', oneOf('denied', 'approved')],
  ['capabilities.passes[].knownDefects[]', matches(CASE_ID)],
  ['capabilities.passes[].knownLeaks[]', matches(CASE_ID)],
  ['capabilities.rows[].id', matches(CASE_ID)],
  ['capabilities.rows[].part', oneOf('a', 'b', 'c')],
  ['capabilities.rows[].egress', oneOf('denied', 'approved')],
  ['capabilities.rows[].source', oneOf('jev', 'rules', 'none')],
  ['capabilities.rows[].reasonCode', matches(SUMMARY_REASON)],
  ['capabilities.rows[].decisionId', matches(DECISION_ID)],
  ['capabilities.rows[].verb', matches(VERB)],
  ['capabilities.rows[].failure', matches(FAILURE)],
  ['capabilities.rows[].jevReasonCodes[]', matches(REASON)],
  ['capabilities.rows[].answerProbabilities[].id', matches(QUESTION_ID)],
  ['capabilities.rows[].answerProbabilities[].type', oneOf('choice', 'score', 'noul')],
]);

/** Paths with a free part: any key under the engine rows' `detail` holds a code or a list of codes. */
const PATTERNS: readonly (readonly [RegExp, Rule])[] = [
  [/^engine\.rows\[\]\.detail\.[A-Za-z0-9_]{1,40}$/, matches(CODE_LIST)],
  // The hot path: the op, the phase of the measurement, the decision's source, reason code and id, wherever the row sits.
  [/^hot\.(?:[A-Za-z0-9_]+(?:\[\])?\.)*op$/, oneOf('route', 'plan')],
  [/^hot\.(?:[A-Za-z0-9_]+(?:\[\])?\.)*phase$/, oneOf('first', 'cold', 'cached', 'burst')],
  [/^hot\.(?:[A-Za-z0-9_]+(?:\[\])?\.)*source$/, oneOf('jev', 'rules', 'none')],
  [/^hot\.(?:[A-Za-z0-9_]+(?:\[\])?\.)*reasonCode$/, matches(REASON)],
  [/^hot\.(?:[A-Za-z0-9_]+(?:\[\])?\.)*decisionId$/, matches(DECISION_ID)],
];

/** The path of a value in `a.b[].c` form: arrays are `[]`, so every element of a list is judged by the one rule. */
function walk(value: unknown, path: string, visit: (path: string, text: string) => void): void {
  if (typeof value === 'string') {
    visit(path, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, `${path}[]`, visit);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) walk(inner, path === '' ? key : `${path}.${key}`, visit);
  }
}

/**
 * Every string in the record that is not a number-free code or label at a listed path, as `<path>: <why>`; empty when the record holds numbers, booleans,
 * nulls and codes only. A value is never quoted back.
 */
export function recordViolations(record: unknown, options: RecordCheckOptions = {}): readonly string[] {
  const titles = options.titles === undefined ? null : new Set(options.titles);
  const out: string[] = [];
  walk(record, '', (path, text) => {
    if (out.length >= 64) return;
    if (path === 'capabilities.rows[].title') {
      if (titles === null ? !TITLE.test(text) : !titles.has(text)) out.push(`${path}: not a fixed title of a case`);
      return;
    }
    const exact = EXACT.get(path);
    if (exact !== undefined) {
      if (!exact(text)) out.push(`${path}: not the code or label this field holds (${String(text.length)} characters)`);
      return;
    }
    const pattern = PATTERNS.find(([re]) => re.test(path));
    if (pattern !== undefined) {
      if (!pattern[1](text)) out.push(`${path}: not the code or label this field holds (${String(text.length)} characters)`);
      return;
    }
    out.push(`${path}: a string where the record holds numbers and codes (${String(text.length)} characters); list the field in features-record.ts only if it is a code`);
  });
  return out;
}
