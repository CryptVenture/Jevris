/**
 * The task-slice classifier (owner decision 2026-10-01, Jev as an active decision aid).
 *
 * A route request that names no slice cannot be priced: the router keys its signed calibration
 * by slice. This asks Jev ONE bounded request (a Choice over the existing slice vocabulary and a
 * Score for risk) from structured features, and falls back to deterministic rules.
 *
 * - Evidence is features only: an extension histogram over a fixed vocabulary, counts per path
 *   role, protected-class codes, check kinds, a verb class from a fixed vocabulary and size
 *   buckets. Path names, file contents and the task title never leave as text. The title is sent
 *   as one screened evidence span only when the administrator approved source egress.
 * - Rules answer first when they are sure (all paths docs, all paths tests, a command with no
 *   files): a deterministic fact needs no model. Jev is asked when the rules are weak or silent.
 * - Jev's answer is used only when it is not `unknown`, its confidence is at least 0.6 with a
 *   margin of 0.15 over the next choice, and its risk score and the rules' hint are not high.
 *   Jev can only raise the risk, never lower it. Otherwise the slice stays unknown and the
 *   route keeps the baseline.
 * - The answer is advice. A classified slice is labelled (`jev`, `rules`), never a learned arm,
 *   never a signed prior and never an actuation.
 * - Any failure (no engine, no budget, deadline, circuit, schema) is the rules answer.
 */
import type { JevQuestions } from '@jevris/contracts';
import type { DecisionEngine } from './decision-engine.js';
import { askBoundedDecision, type IntentContext } from './intent-decisions.js';
import { protectedClasses } from './protected-paths.js';
import { SHARED_SLICE_IDS } from './route-learning.js';
import { SLICE_CLASSIFY_SPEC_ID, sliceCodeOf } from './slice-explain.js';

export { SLICE_CLASSIFY_SPEC_ID } from './slice-explain.js';

export const SLICE_ASSIST_LEVELS = ['off', 'classify'] as const;
export type SliceAssist = (typeof SLICE_ASSIST_LEVELS)[number];

/** What a caller may know about a task, all optional. Nothing here is sent as text unless said. */
export interface SliceTaskHints {
  /** Free text. Reduced to a verb class locally; sent only as a screened evidence span with egress approved. */
  readonly title?: string | null;
  /** Workspace-relative paths (write scopes or touched files). Reduced to counts and categories; names are never sent. */
  readonly paths?: readonly string[] | null;
  /** Acceptance check ids. Reduced to kinds and a count. */
  readonly checkIds?: readonly string[] | null;
}

export const SLICE_VERBS = ['fix', 'add', 'refactor', 'docs', 'review', 'research', 'debug', 'migrate', 'run'] as const;
export type SliceVerb = (typeof SLICE_VERBS)[number];

export const CHECK_KINDS = ['test', 'lint', 'typecheck', 'build', 'other'] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

/** The content-free features of a task. */
export interface SliceFeatures {
  readonly files: number;
  /** `ts:3,md:1`: the top extensions over a fixed vocabulary (anything else is `other`), or `none`. */
  readonly extensions: string;
  readonly roleSource: number;
  readonly roleTest: number;
  readonly roleDocs: number;
  readonly roleConfig: number;
  readonly roleCi: number;
  readonly roleOther: number;
  /** Protected path classes (`PROTECTED_CI` ...), sorted; empty when none. */
  readonly protectedClasses: readonly string[];
  readonly checks: number;
  readonly checkKinds: readonly CheckKind[];
  readonly verb: SliceVerb | null;
  readonly titleSize: 'none' | 'short' | 'medium' | 'long';
}

const CODE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java', 'kt', 'swift', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php', 'sh', 'ps1', 'sql', 'html', 'css', 'scss', 'vue', 'svelte']);
const DOC_EXTENSIONS = new Set(['md', 'mdx', 'txt', 'rst', 'adoc']);
const CONFIG_EXTENSIONS = new Set(['json', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'xml', 'conf']);
const MAX_PATHS = 64;
const MAX_CHECKS = 64;
const MAX_PATH_CHARS = 512;
/** Locked: the most files a low-risk task covers (mirrors the owned-worker risk class). */
const LOW_RISK_FILES = 5;

const VERB_WORDS: readonly (readonly [SliceVerb, readonly string[]])[] = [
  ['fix', ['fix', 'fixes', 'fixing', 'bug', 'bugfix', 'repair', 'patch', 'resolve', 'crash', 'regression', 'broken']],
  ['add', ['add', 'implement', 'create', 'build', 'introduce', 'support', 'new', 'feature', 'enable']],
  ['refactor', ['refactor', 'rename', 'restructure', 'cleanup', 'clean', 'simplify', 'extract', 'reorganize', 'dedupe', 'tidy']],
  ['docs', ['document', 'docs', 'doc', 'readme', 'changelog', 'comment', 'comments', 'typo']],
  ['review', ['review', 'audit', 'inspect', 'assess']],
  ['research', ['research', 'investigate', 'explore', 'compare', 'evaluate', 'survey', 'study']],
  ['debug', ['debug', 'diagnose', 'trace', 'reproduce', 'troubleshoot', 'profile']],
  ['migrate', ['migrate', 'upgrade', 'port', 'bump', 'convert']],
  ['run', ['run', 'execute', 'install', 'deploy', 'start', 'restart', 'commit', 'push', 'merge', 'script']],
];

/** The verb class of a title: the earliest word that belongs to the fixed vocabulary, else null. */
export function verbOfTitle(title: string | null | undefined): SliceVerb | null {
  if (typeof title !== 'string') return null;
  const words = title.slice(0, 300).toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 0);
  for (const word of words) {
    for (const [verb, list] of VERB_WORDS) if (list.includes(word)) return verb;
  }
  return null;
}

function checkKindOf(id: string): CheckKind {
  const lower = id.toLowerCase();
  if (/(^|[^a-z])(test|tests|spec|unit|e2e|integration|jest|vitest|pytest|mocha)([^a-z]|$)/.test(lower)) return 'test';
  if (/(^|[^a-z])(lint|eslint|biome|prettier|format|fmt|style)([^a-z]|$)/.test(lower)) return 'lint';
  if (/(^|[^a-z])(type|types|typecheck|tsc|mypy|check-types)([^a-z]|$)/.test(lower)) return 'typecheck';
  if (/(^|[^a-z])(build|compile|bundle|package)([^a-z]|$)/.test(lower)) return 'build';
  return 'other';
}

export type PathRole = 'source' | 'test' | 'docs' | 'config' | 'ci' | 'other';
type Role = PathRole;

/** The extension of a path over the fixed vocabulary (`other` for anything else, `none` for no extension). */
export function extensionOf(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return 'none';
  const ext = base.slice(dot + 1).toLowerCase();
  return CODE_EXTENSIONS.has(ext) || DOC_EXTENSIONS.has(ext) || CONFIG_EXTENSIONS.has(ext) ? ext : 'other';
}

/** The role of a workspace-relative path (source, test, docs, config, ci, other); `protectedOf` is its protected classes. */
export function roleOf(path: string, protectedOf: readonly string[]): PathRole {
  const normal = path.replace(/\\/g, '/');
  const segments = normal.split('/').map((s) => s.toLowerCase());
  const base = segments[segments.length - 1] ?? '';
  const ext = extensionOf(normal);
  if (segments.some((s) => /^(tests?|__tests__|spec|specs|e2e)$/.test(s)) || /\.(test|spec)\.[a-z0-9]+$/.test(base) || /_test\.[a-z0-9]+$/.test(base)) return 'test';
  if (protectedOf.includes('PROTECTED_CI')) return 'ci';
  if (DOC_EXTENSIONS.has(ext) || segments.some((s) => s === 'docs' || s === 'doc')) return 'docs';
  if (CONFIG_EXTENSIONS.has(ext)) return 'config';
  if (CODE_EXTENSIONS.has(ext)) return 'source';
  return 'other';
}

/** The content-free features of a task's hints. Pure. */
export function sliceFeatures(hints: SliceTaskHints): SliceFeatures {
  const paths = (hints.paths ?? [])
    .filter((p): p is string => typeof p === 'string' && p.length > 0 && p.length <= MAX_PATH_CHARS && !p.includes('\0'))
    .slice(0, MAX_PATHS);
  const roles: Record<Role, number> = { source: 0, test: 0, docs: 0, config: 0, ci: 0, other: 0 };
  const exts = new Map<string, number>();
  const protectedSet = new Set<string>();
  for (const path of paths) {
    const classes = protectedClasses(path);
    for (const c of classes) protectedSet.add(c);
    roles[roleOf(path, classes)] += 1;
    const ext = extensionOf(path);
    exts.set(ext, (exts.get(ext) ?? 0) + 1);
  }
  const histogram = [...exts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 6).map(([e, n]) => `${e}:${n}`).join(',');
  const checks = (hints.checkIds ?? []).filter((c): c is string => typeof c === 'string' && c.length > 0).slice(0, MAX_CHECKS);
  const kinds = new Set<CheckKind>(checks.map(checkKindOf));
  const title = typeof hints.title === 'string' ? hints.title.trim() : '';
  return {
    files: paths.length,
    extensions: histogram === '' ? 'none' : histogram,
    roleSource: roles.source,
    roleTest: roles.test,
    roleDocs: roles.docs,
    roleConfig: roles.config,
    roleCi: roles.ci,
    roleOther: roles.other,
    protectedClasses: [...protectedSet].sort(),
    checks: checks.length,
    checkKinds: CHECK_KINDS.filter((k) => kinds.has(k)),
    verb: verbOfTitle(title),
    titleSize: title.length === 0 ? 'none' : title.length <= 60 ? 'short' : title.length <= 200 ? 'medium' : 'long',
  };
}

/** Whether the features say anything at all: with none, there is nothing to classify. */
export function hasSliceEvidence(features: SliceFeatures): boolean {
  return features.files > 0 || features.checks > 0 || features.verb !== null || features.titleSize !== 'none';
}

export type SliceRisk = 'low' | 'medium' | 'high' | 'unknown';
const RISK_RANK: Readonly<Record<SliceRisk, number>> = { unknown: 0, low: 1, medium: 2, high: 3 };

function higherRisk(a: SliceRisk, b: SliceRisk): SliceRisk {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

/** The rules' risk hint. Protected paths are high; many files or no check is medium; nothing known is unknown. */
export function rulesRisk(features: SliceFeatures): SliceRisk {
  if (features.protectedClasses.length > 0) return 'high';
  if (features.files === 0) return 'unknown';
  if (features.files > LOW_RISK_FILES || features.checks === 0) return 'medium';
  return 'low';
}

export interface RulesSlice {
  readonly sliceId: string | null;
  /** True when the features alone settle it, so Jev is not asked. */
  readonly sure: boolean;
}

/** The deterministic classification. No model, no network. */
export function rulesSlice(features: SliceFeatures): RulesSlice {
  const f = features;
  if (f.files > 0 && f.roleDocs === f.files) return { sliceId: 'docs', sure: true };
  if (f.files > 0 && f.roleTest === f.files) return { sliceId: 'test-fix', sure: true };
  if (f.files === 0 && f.verb === 'run') return { sliceId: 'terminal', sure: true };
  switch (f.verb) {
    case 'fix':
      return { sliceId: f.roleTest > 0 && f.roleTest >= f.roleSource ? 'test-fix' : 'issue-fix', sure: false };
    case 'refactor':
      return { sliceId: 'refactor', sure: false };
    case 'add':
      return { sliceId: 'feature', sure: false };
    case 'docs':
      return { sliceId: 'docs', sure: false };
    case 'review':
      return { sliceId: 'review', sure: false };
    case 'research':
      return { sliceId: 'research', sure: false };
    case 'debug':
      return { sliceId: 'debug', sure: false };
    case 'migrate':
      return { sliceId: 'migration', sure: false };
    case 'run':
      return { sliceId: 'terminal', sure: false };
    default:
      break;
  }
  if (f.files > 0 && f.files <= LOW_RISK_FILES && f.checks > 0 && f.roleSource > 0) return { sliceId: 'bounded-edit', sure: false };
  return { sliceId: null, sure: false };
}

/**
 * Whether classifying these features would ask Jev: there is something to go on, the rules are not sure,
 * and a Jev answer could change the outcome. A protected path class is a high risk by the locked rules
 * and a high risk gives no slice whatever Jev says, so Jev is not asked: measured live, every request of
 * that shape (a migration, a CI file, a secrets path) spent a call, about 42 micro-USD and about 280 ms
 * to end in `SLICE_HIGH_RISK` regardless of the answer.
 */
export function sliceNeedsJev(features: SliceFeatures): boolean {
  if (!hasSliceEvidence(features)) return false;
  if (rulesRisk(features) === 'high') return false;
  const rules = rulesSlice(features);
  return !(rules.sure && rules.sliceId !== null);
}

/**
 * The option definitions of the slice question: fixed text, no user text. Each one says what separates it
 * from its neighbours, using the names of the features it is judged on (`verb`, the file roles and the
 * check kinds). Measured live (jev-1.13.0, 2026-10-03): with the short definitions a defect fix that
 * also edits a test was read as `test-fix` (0.83), a one-file label change as `test-fix` (0.45, because a
 * test check exists) and a clear feature at confidence 0.30 to 0.39, below the 0.6 floor.
 */
const SLICE_DEFINITIONS: Readonly<Record<string, string>> = {
  'bounded-edit': 'A small change to one or a few existing source files with no new capability, such as a label, a constant or a small logic change, checked by an acceptance check; the verb names no other kind of task.',
  'issue-fix': 'A fix for a defect in product code (verb fix). Test files may change alongside the fix as its regression test, and an acceptance check of kind test does not make it test-fix.',
  'test-fix': 'Changing only test files, or getting a failing test run to pass without changing product code: most or all of the changed files are test files.',
  refactor: 'Restructuring code while keeping what it does the same (verb refactor).',
  feature: 'Adding new behaviour or a new capability to the product (verb add), usually across several source files.',
  docs: 'Writing or updating documentation or comments only: all of the changed files are documentation.',
  review: 'Reading and judging existing changes without editing them (verb review).',
  research: 'Investigating or comparing options before any change is made (verb research).',
  debug: 'Finding the cause of a failure by running and tracing the program (verb debug).',
  migration: 'Moving code or data to a new version, format or tool (verb migrate).',
  terminal: 'Running commands or scripts with little or no file editing (verb run, few or no files).',
};

export const SLICE_RISK_ANCHORS = [
  'Routine: a few ordinary files, checks present, nothing sensitive touched.',
  'Low: ordinary files with one small gap, such as a single missing check.',
  'Moderate: many files, no acceptance check, or an unfamiliar area of the code.',
  'High: touches CI, deployment, migrations or lock files.',
  'Severe: touches authentication, secrets, permissions or git internals.',
] as const;

/** The one request: a Choice over the shared slices (plus `unknown`) and a Score for risk. Fixed text. */
export function sliceQuestions(): JevQuestions {
  const criteria: Record<string, string> = {};
  for (const id of SHARED_SLICE_IDS) criteria[id] = SLICE_DEFINITIONS[id] ?? `A ${id} task.`;
  criteria['unknown'] = 'The listed features are not enough to tell which kind of task this is.';
  return {
    slice: { type: 'choice', instructions: 'Which listed kind of coding task fits the structured features of this task?', criteria },
    risk: { type: 'score', instructions: 'How risky is this coding task for an agent working without supervision, judging only from the structured features?', criteria: [...SLICE_RISK_ANCHORS] },
  } as unknown as JevQuestions;
}

/** The facts of the request: the features as bounded strings, numbers and codes. */
function featureFacts(f: SliceFeatures): Record<string, string | number> {
  return {
    files: f.files,
    extensions: f.extensions,
    roleSource: f.roleSource,
    roleTest: f.roleTest,
    roleDocs: f.roleDocs,
    roleConfig: f.roleConfig,
    roleCi: f.roleCi,
    roleOther: f.roleOther,
    protectedClasses: f.protectedClasses.length === 0 ? 'none' : f.protectedClasses.join(','),
    checks: f.checks,
    checkKinds: f.checkKinds.length === 0 ? 'none' : f.checkKinds.join(','),
    verb: f.verb ?? 'none',
    titleSize: f.titleSize,
  };
}

/** The evidence ids a classification names (the feature groups the request carried). */
function evidenceIdsOf(f: SliceFeatures, withTitle: boolean): string[] {
  const ids: string[] = [];
  if (f.files > 0) ids.push('feature-files', 'feature-extensions', 'feature-roles');
  if (f.protectedClasses.length > 0) ids.push('feature-protected');
  if (f.checks > 0) ids.push('feature-checks');
  if (f.verb !== null) ids.push('feature-verb');
  if (f.titleSize !== 'none') ids.push(withTitle ? 'task-title' : 'feature-title-size');
  return ids;
}

export type SliceSource = 'rules' | 'jev' | 'none';

export interface SliceClassification {
  /** The slice to route under, or null: the route keeps the approved baseline. */
  readonly sliceId: string | null;
  readonly source: SliceSource;
  /** The higher of the rules' hint and Jev's score; Jev can only raise it. */
  readonly risk: SliceRisk;
  /** Jev's confidence in its slice choice, 0 to 1; null when Jev did not answer. */
  readonly confidence: number | null;
  /** Why: `SLICE_*` code, content-free. */
  readonly reasonCode: string;
  /** The decision record of this classification (explain shows it); null when none was recorded. */
  readonly decisionId: string | null;
  /** The Jev call's own decision id, when Jev was asked. */
  readonly jevDecisionId: string | null;
  readonly asked: boolean;
  /** Whether the decision cache answered; null when Jev was not asked. */
  readonly cacheHit: boolean | null;
  readonly latencyMs: number | null;
  /** What Jev answered even when it was not used (`unknown` included); null when it did not answer. */
  readonly jevSlice: string | null;
  /** The rules' slice, when they had one. */
  readonly rulesAlternative: string | null;
  /** The feature groups the request carried. */
  readonly evidenceIds: readonly string[];
}

export interface ClassifyOptions {
  readonly assist: SliceAssist;
  /** Record the classification as an advisory decision (default true). */
  readonly record?: boolean;
  /** The clock; tests inject one. */
  readonly now?: () => number;
  /**
   * Do not ask Jev: the answer is the rules' and carries this reason code (a plan that used up its
   * Jev calls, or ran out of time). A code that is not `[A-Z][A-Z0-9_]{0,63}` reads as assist off.
   */
  readonly skipAsk?: string;
}

/** Jev's confidence floor and margin over the next choice, and the highest risk score still used. */
export const SLICE_MIN_CONFIDENCE = 0.6;
export const SLICE_MIN_MARGIN = 0.15;
export const SLICE_MAX_RISK_SCORE = 2;

interface ChoiceAnswer {
  readonly choice: string;
  readonly confidence: number;
  readonly margin: number;
}

function choiceOf(answers: Readonly<Record<string, { readonly type: string; readonly [key: string]: unknown }>>, id: string): ChoiceAnswer | null {
  const a = answers[id];
  if (a === undefined || a.type !== 'choice') return null;
  const probabilities = a['probabilities'];
  if (probabilities === null || typeof probabilities !== 'object') return null;
  const sorted = Object.values(probabilities as Record<string, number>).filter((p) => typeof p === 'number').sort((x, y) => y - x);
  const confidence = typeof a['confidence'] === 'number' ? a['confidence'] : (sorted[0] ?? 0);
  return { choice: String(a['choice']), confidence, margin: (sorted[0] ?? 0) - (sorted[1] ?? 0) };
}

function scoreOf(answers: Readonly<Record<string, { readonly type: string; readonly [key: string]: unknown }>>, id: string): number | null {
  const a = answers[id];
  return a !== undefined && a.type === 'score' && typeof a['score'] === 'number' ? a['score'] : null;
}

function riskOfScore(score: number): SliceRisk {
  return score <= 1 ? 'low' : score <= 2 ? 'medium' : 'high';
}

function result(base: Partial<SliceClassification> & Pick<SliceClassification, 'sliceId' | 'source' | 'risk' | 'reasonCode'>): SliceClassification {
  return { confidence: null, decisionId: null, jevDecisionId: null, asked: false, cacheHit: null, latencyMs: null, jevSlice: null, rulesAlternative: null, evidenceIds: [], ...base };
}

/** The rules' answer when Jev's does not stand: the rules' slice (or none) with the reason. The evidence ids never carry the title. */
function weakResult(features: SliceFeatures, reasonCode: string, extra: Partial<SliceClassification> = {}): SliceClassification {
  const rulesId = rulesSlice(features).sliceId;
  const rulesHint = rulesRisk(features);
  if (rulesId === null) return result({ sliceId: null, source: 'none', risk: rulesHint, reasonCode, ...extra, evidenceIds: evidenceIdsOf(features, false) });
  return result({ sliceId: rulesId, source: 'rules', risk: rulesHint, reasonCode, rulesAlternative: rulesId, ...extra, evidenceIds: evidenceIdsOf(features, false) });
}

/** What Jev said about one task, in the shape both ways of asking produce. */
interface JevSliceAnswer {
  readonly choice: ChoiceAnswer | null;
  readonly score: number | null;
}

/**
 * Applies the floors to Jev's answer for one task (the one place they are applied, for a request of one task and a
 * request of several): a slice that is not in the vocabulary, a confidence under 0.6 or a margin under 0.15 is the rules
 * answer; a high risk gives no slice; Jev can only raise the risk. `base` carries what is known of the ask.
 */
function judgeSliceAnswer(features: SliceFeatures, answer: JevSliceAnswer, base: Partial<SliceClassification>): { readonly weak: string; readonly extra: Partial<SliceClassification> } | { readonly final: SliceClassification } {
  const rulesId = rulesSlice(features).sliceId;
  const rulesHint = rulesRisk(features);
  const { choice, score } = answer;
  if (choice === null) return { weak: 'SLICE_JEV_NO_ANSWER', extra: base };
  const jevRisk = score === null ? 'unknown' : riskOfScore(score);
  const risk = higherRisk(rulesHint, jevRisk);
  const known = (SHARED_SLICE_IDS as readonly string[]).includes(choice.choice);
  const common = { ...base, confidence: Math.round(choice.confidence * 100) / 100, jevSlice: choice.choice === 'unknown' || known ? choice.choice : null, risk };
  if (!known) return { weak: choice.choice === 'unknown' ? 'SLICE_JEV_UNKNOWN' : 'SLICE_JEV_UNKNOWN_OPTION', extra: { ...common, risk } };
  if (choice.confidence < SLICE_MIN_CONFIDENCE || choice.margin < SLICE_MIN_MARGIN) return { weak: 'SLICE_JEV_LOW_CONFIDENCE', extra: common };
  if (risk === 'high' || (score !== null && score > SLICE_MAX_RISK_SCORE)) {
    // A high-risk answer falls to the baseline: no slice is used, whatever the rules guessed.
    return { final: result({ ...common, sliceId: null, source: 'none', risk: 'high', reasonCode: 'SLICE_HIGH_RISK' }) };
  }
  const disagree = rulesId !== null && rulesId !== choice.choice;
  return { final: result({ ...common, sliceId: choice.choice, source: 'jev', reasonCode: disagree ? 'SLICE_JEV_OVER_RULES' : 'SLICE_JEV' }) };
}

/**
 * Classifies a task into a known slice and a risk. Never throws and never blocks past its
 * deadline: any failure is the rules answer.
 */
export async function classifyTaskSlice(engine: DecisionEngine | null, hints: SliceTaskHints, ctx: IntentContext, options: ClassifyOptions): Promise<SliceClassification> {
  const now = options.now ?? (() => performance.now());
  const started = now();
  const features = sliceFeatures(hints);
  if (!hasSliceEvidence(features)) return result({ sliceId: null, source: 'none', risk: 'unknown', reasonCode: 'SLICE_NO_FEATURES' });
  const rules = rulesSlice(features);
  const rulesHint = rulesRisk(features);
  const rulesId = rules.sliceId;
  const finish = (r: SliceClassification): Promise<SliceClassification> => recordClassification(engine, r, ctx, options.record !== false, now() - started, []);

  // A protected path class is a high risk by the locked rules, and a high risk gives no slice whatever Jev
  // says (the answer below could only raise it): there is nothing for Jev to change, so it is not asked.
  if (rulesHint === 'high') return finish(result({ sliceId: null, source: 'none', risk: 'high', reasonCode: 'SLICE_HIGH_RISK', rulesAlternative: rulesId, evidenceIds: evidenceIdsOf(features, false) }));
  // A deterministic fact needs no model.
  if (rules.sure && rulesId !== null) {
    return finish(result({ sliceId: rulesId, source: 'rules', risk: rulesHint, reasonCode: 'SLICE_RULES_SURE', rulesAlternative: rulesId, evidenceIds: evidenceIdsOf(features, false) }));
  }
  const weak = (reasonCode: string, extra: Partial<SliceClassification> = {}): Promise<SliceClassification> => finish(weakResult(features, reasonCode, extra));
  if (options.skipAsk !== undefined) return weak(REASON_CODE.test(options.skipAsk) ? options.skipAsk : 'SLICE_ASSIST_OFF');
  if (options.assist === 'off') return weak('SLICE_ASSIST_OFF');
  if (engine === null) return weak('PROVIDER_NOT_CONFIGURED');

  // Jev is asked from features. The title text goes as one screened span, only with egress approved.
  const egressApproved = (engine.sourceEgress?.() ?? 'denied') === 'approved';
  const title = typeof hints.title === 'string' ? hints.title.trim().slice(0, 300) : '';
  const withTitle = egressApproved && title.length > 0;
  const packet = {
    objective: 'Classify the kind and the risk of a coding task from its structured features (advice only).',
    trustedPolicy: { slices: [...SHARED_SLICE_IDS], grantsAuthority: false },
    facts: featureFacts(features),
    evidence: withTitle ? [{ id: 'task-title', text: title, sourceKind: 'user' as const, priority: 'high' as const }] : [],
  };
  const evidenceIds = evidenceIdsOf(features, withTitle);
  const asked = await askBoundedDecision(engine, SLICE_CLASSIFY_SPEC_ID, sliceQuestions(), packet, ctx, false);
  if (!asked.ok) return weak(`SLICE_JEV_${asked.reasonCode}`.slice(0, 64), { asked: true, jevDecisionId: asked.decisionId, latencyMs: Math.round(now() - started) });
  const flags = await recordFlagsOf(engine, asked.decisionId);
  const base = { asked: true, jevDecisionId: asked.decisionId, cacheHit: flags.cacheHit, latencyMs: Math.round(now() - started), rulesAlternative: rulesId, evidenceIds };
  const answer: JevSliceAnswer = { choice: choiceOf(asked.answers, 'slice'), score: scoreOf(asked.answers, 'risk') };
  // A task asked alone is remembered for a plan too (JEV-0058): the plan's batch asks only about shapes nobody has asked. A
  // cache hit is not remembered anew: its age is not known, and the memory must not outlive the cache it follows.
  if (answer.choice !== null && flags.memoizable && flags.cacheHit !== true) rememberSliceAnswer(engine, sliceMemoKey(ctx.workspaceId, features, withTitle ? title : ''), answer);
  const judged = judgeSliceAnswer(features, answer, base);
  return 'weak' in judged ? weak(judged.weak, judged.extra) : finish(judged.final);
}

// --------------------------------------------------------------------------------- several tasks in one request

/**
 * The most tasks one request carries: each is two questions (its slice and its risk), and a request holds at most 12.
 * Measured live (jev-1.13.0, 2026-10-04) for a plan of 6 tasks that all need Jev: six requests at once took 429 ms
 * (median; the slowest of six, each about 330 ms) and cost 282 micro-USD; one request of the 12 questions took 227 ms
 * and cost 198 micro-USD, and both labelled all 24 of 24 tasks as expected, every one above the confidence floor.
 */
export const SLICE_BATCH_TASKS = 6;

/** The batch's questions for `count` tasks: the single-task questions' texts, once per task, each naming its task's facts. Fixed text. */
export function sliceBatchQuestions(count: number): JevQuestions {
  const one = sliceQuestions() as unknown as { readonly slice: { readonly criteria: Record<string, string> }; readonly risk: { readonly criteria: readonly string[] } };
  const questions: Record<string, unknown> = {};
  for (let i = 0; i < count; i += 1) {
    questions[`slice${String(i)}`] = { type: 'choice', instructions: `Which listed kind of coding task fits the structured features of task ${String(i)}? They are the facts that start with t${String(i)}_.`, criteria: one.slice.criteria };
    questions[`risk${String(i)}`] = { type: 'score', instructions: `How risky is coding task ${String(i)} for an agent working without supervision, judging only from its structured features, the facts that start with t${String(i)}_?`, criteria: [...one.risk.criteria] };
  }
  return questions as unknown as JevQuestions;
}

/**
 * One answer per task, remembered by the task's features, so a plan that shares tasks with an earlier one asks only about
 * the new ones. It follows the engine's own decision cache: the same lifetime (one engine, so a restart or a changed policy
 * or model starts it empty), the same ten minutes, no sharing across workspaces, and only answers the engine would have cached.
 */
const SLICE_MEMO = new WeakMap<object, Map<string, { readonly answer: JevSliceAnswer; readonly atMs: number }>>();
const SLICE_MEMO_MAX = 512;
const SLICE_MEMO_TTL_MS = 10 * 60 * 1000;

function memoOf(engine: DecisionEngine): Map<string, { readonly answer: JevSliceAnswer; readonly atMs: number }> {
  let memo = SLICE_MEMO.get(engine);
  if (memo === undefined) {
    memo = new Map();
    SLICE_MEMO.set(engine, memo);
  }
  return memo;
}

/** The engine's wall clock (its own, so one clock decides every cache); the real one when it has none. */
function engineNow(engine: DecisionEngine): number {
  try {
    return engine.now?.() ?? Date.now();
  } catch {
    return Date.now();
  }
}

/** The memory's key for one task shape: the workspace, the features and (egress approved) the screened title. */
function sliceMemoKey(workspaceId: string, features: SliceFeatures, title: string): string {
  return JSON.stringify([workspaceId, features, title]);
}

/** Remembers one fresh answer under the engine's clock, oldest out first; both ways of asking (one task, several) call it. */
function rememberSliceAnswer(engine: DecisionEngine, memoKey: string, answer: JevSliceAnswer): void {
  const memo = memoOf(engine);
  memo.delete(memoKey);
  memo.set(memoKey, { answer, atMs: engineNow(engine) });
  if (memo.size > SLICE_MEMO_MAX) {
    const oldest = memo.keys().next();
    if (oldest.done !== true) memo.delete(oldest.value);
  }
}

export interface SliceBatchItem {
  /** The caller's own key for this task's features (a plan's group key); results come back under it. */
  readonly key: string;
  readonly hints: SliceTaskHints;
}

export interface SliceBatchOptions {
  readonly assist: SliceAssist;
  /** Do not ask Jev: every answer is the rules' with this reason code (see `ClassifyOptions.skipAsk`). */
  readonly skipAsk?: string;
  readonly now?: () => number;
  /** Told each result as soon as it is known (a chunk that is out at the caller's deadline is simply never told). */
  readonly onResult: (key: string, result: SliceClassification) => void;
}

/**
 * Classifies several tasks, asking Jev for all that need it in as few requests as the 12-question cap allows (6 tasks to a
 * request) instead of one request per task. Each task still gets its own answer and the same floors as a task asked alone
 * (`judgeSliceAnswer`); a task the rules settle, or that a gate stops, is answered without a request, exactly as
 * `classifyTaskSlice` would; a task whose features were answered before (by this engine, in this workspace) is answered
 * from that, as a cache hit; a chunk of one task goes the single way and so shares the single-task decision cache. A
 * request that fails gives every task in it the rules answer with the reason. Results are not recorded here (the plan does).
 * Never throws.
 */
export async function classifyTaskSliceBatch(engine: DecisionEngine | null, items: readonly SliceBatchItem[], ctx: IntentContext, options: SliceBatchOptions): Promise<void> {
  const now = options.now ?? (() => performance.now());
  const single = (item: SliceBatchItem, skipAsk?: string): Promise<void> =>
    classifyTaskSlice(engine, item.hints, ctx, { assist: options.assist, record: false, now, ...(skipAsk === undefined ? {} : { skipAsk }) }).then(
      (r) => options.onResult(item.key, r),
      () => undefined,
    );
  const asking: { readonly item: SliceBatchItem; readonly features: SliceFeatures; readonly title: string; readonly memoKey: string }[] = [];
  const direct: Promise<void>[] = [];
  const egressApproved = engine !== null && (engine.sourceEgress?.() ?? 'denied') === 'approved';
  for (const item of items) {
    const features = sliceFeatures(item.hints);
    if (engine === null || options.assist !== 'classify' || options.skipAsk !== undefined || !sliceNeedsJev(features)) {
      direct.push(single(item, options.skipAsk));
      continue;
    }
    const title = egressApproved && typeof item.hints.title === 'string' ? item.hints.title.trim().slice(0, 300) : '';
    asking.push({ item, features, title, memoKey: sliceMemoKey(ctx.workspaceId, features, title) });
  }
  const memo = engine === null ? null : memoOf(engine);
  const nowMs = engine === null ? 0 : engineNow(engine);
  const fresh: typeof asking = [];
  for (const entry of asking) {
    const hit = memo?.get(entry.memoKey);
    const known = hit !== undefined && nowMs - hit.atMs <= SLICE_MEMO_TTL_MS ? hit.answer : undefined;
    if (known === undefined) {
      fresh.push(entry);
      continue;
    }
    // The same features were answered before: the answer stands, as a cache hit, with no request.
    const base = { asked: true, cacheHit: true, latencyMs: 0, rulesAlternative: rulesSlice(entry.features).sliceId, evidenceIds: evidenceIdsOf(entry.features, entry.title.length > 0) };
    const judged = judgeSliceAnswer(entry.features, known, base);
    options.onResult(entry.item.key, 'weak' in judged ? weakResult(entry.features, judged.weak, judged.extra) : judged.final);
  }
  const chunks: (typeof asking)[] = [];
  for (let at = 0; at < fresh.length; at += SLICE_BATCH_TASKS) chunks.push(fresh.slice(at, at + SLICE_BATCH_TASKS));
  const asks = chunks.map(async (chunk) => {
    const only = chunk[0];
    if (chunk.length === 1 && only !== undefined) return single(only.item);
    try {
      await askChunk(engine as DecisionEngine, chunk, ctx, now, options.onResult);
    } catch {
      // Left without a result: the caller's rules answer.
    }
    return undefined;
  });
  await Promise.all([...direct, ...asks]);
}

async function askChunk(
  engine: DecisionEngine,
  chunk: readonly { readonly item: SliceBatchItem; readonly features: SliceFeatures; readonly title: string; readonly memoKey: string }[],
  ctx: IntentContext,
  now: () => number,
  onResult: (key: string, result: SliceClassification) => void,
): Promise<void> {
  const started = now();
  const facts: Record<string, string | number> = {};
  chunk.forEach((entry, i) => {
    for (const [name, value] of Object.entries(featureFacts(entry.features))) facts[`t${String(i)}_${name}`] = value;
  });
  // A title travels as one screened span per task, only with egress approved, led by the task it belongs to.
  const evidence = chunk.flatMap((entry, i) => (entry.title.length === 0 ? [] : [{ id: `task-title-${String(i)}`, text: `Task ${String(i)} title: ${entry.title}`, sourceKind: 'user' as const, priority: 'high' as const }]));
  const packet = {
    objective: 'Classify the kind and the risk of several coding tasks from their structured features (advice only).',
    trustedPolicy: { slices: [...SHARED_SLICE_IDS], grantsAuthority: false },
    facts,
    evidence,
  };
  const asked = await askBoundedDecision(engine, SLICE_CLASSIFY_SPEC_ID, sliceBatchQuestions(chunk.length), packet, ctx, false);
  const latencyMs = Math.round(now() - started);
  if (!asked.ok) {
    for (const entry of chunk) onResult(entry.item.key, weakResult(entry.features, `SLICE_JEV_${asked.reasonCode}`.slice(0, 64), { asked: true, jevDecisionId: asked.decisionId, latencyMs }));
    return;
  }
  const flags = await recordFlagsOf(engine, asked.decisionId);
  chunk.forEach((entry, i) => {
    const answer: JevSliceAnswer = { choice: choiceOf(asked.answers, `slice${String(i)}`), score: scoreOf(asked.answers, `risk${String(i)}`) };
    // Only an answer the engine itself would have cached is remembered: not one from an observe-only route or a repacked request.
    if (answer.choice !== null && flags.memoizable) rememberSliceAnswer(engine, entry.memoKey, answer);
    const base = { asked: true, jevDecisionId: asked.decisionId, cacheHit: flags.cacheHit, latencyMs, rulesAlternative: rulesSlice(entry.features).sliceId, evidenceIds: evidenceIdsOf(entry.features, entry.title.length > 0) };
    const judged = judgeSliceAnswer(entry.features, answer, base);
    onResult(entry.item.key, 'weak' in judged ? weakResult(entry.features, judged.weak, judged.extra) : judged.final);
  });
}

/** From the engine's record of a call: whether the cache answered, and whether the answer is one the engine caches. */
async function recordFlagsOf(engine: DecisionEngine, decisionId: string): Promise<{ readonly cacheHit: boolean | null; readonly memoizable: boolean }> {
  try {
    const record = await engine.lookup(decisionId);
    if (record === null) return { cacheHit: null, memoizable: false };
    return { cacheHit: record.reasonCodes.includes('CACHE_HIT'), memoizable: !record.reasonCodes.includes('OBSERVE_ONLY_ROUTE') && !record.reasonCodes.includes('PACKET_REPACKED') };
  } catch {
    return { cacheHit: null, memoizable: false };
  }
}

const REASON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** The reason codes of the recorded decision: every one reads back through `sliceAssistLines`. */
export function sliceReasonCodes(r: SliceClassification, extra: readonly string[] = []): string[] {
  const codes = [
    `SLICE_SOURCE_${r.source.toUpperCase()}`,
    ...(r.sliceId === null ? [] : [`SLICE_ID_${sliceCodeOf(r.sliceId)}`]),
    `RISK_${r.risk.toUpperCase()}`,
    ...(r.jevSlice === null ? [] : [`JEV_SLICE_${sliceCodeOf(r.jevSlice)}`]),
    ...(r.rulesAlternative === null ? [] : [`RULES_ALT_${sliceCodeOf(r.rulesAlternative)}`]),
    ...(r.asked ? [r.cacheHit === true ? 'JEV_CACHE_HIT' : 'JEV_CACHE_MISS'] : []),
    ...(r.confidence === null ? [] : [`CONF_${Math.round(r.confidence * 100)}`]),
    r.reasonCode,
    ...extra,
  ];
  return codes.filter((c) => REASON_CODE.test(c));
}

/**
 * Records a classification as an advisory `slice-classify` decision (what `classifyTaskSlice` does
 * for a route request), for a caller that classified with `record: false`: a plan records one per
 * task, with that task's id. `extraCodes` join the reason codes (a plan task's own). Returns the
 * classification with its decision id, or as it was when nothing could be recorded.
 */
export function recordSliceClassification(engine: DecisionEngine | null, r: SliceClassification, ctx: IntentContext, elapsedMs: number, extraCodes: readonly string[] = []): Promise<SliceClassification> {
  return recordClassification(engine, r, ctx, true, elapsedMs, extraCodes);
}

async function recordClassification(engine: DecisionEngine | null, r: SliceClassification, ctx: IntentContext, record: boolean, elapsedMs: number, extraCodes: readonly string[]): Promise<SliceClassification> {
  const withLatency = r.latencyMs === null && r.asked ? { ...r, latencyMs: Math.round(elapsedMs) } : r;
  if (!record || engine === null || engine.recordAdvice === undefined) return withLatency;
  try {
    const recorded = await engine.recordAdvice({
      specId: SLICE_CLASSIFY_SPEC_ID,
      workspaceId: ctx.workspaceId,
      evidenceRevision: ctx.evidenceRevision,
      ...(ctx.taskId === undefined ? {} : { taskId: ctx.taskId }),
      ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }),
      action: { kind: 'advise', templateId: SLICE_CLASSIFY_SPEC_ID, evidenceIds: [...r.evidenceIds].slice(0, 64) },
      reasonCodes: sliceReasonCodes(r, extraCodes),
      durationMs: Math.max(0, Math.round(elapsedMs)),
    });
    return recorded.ok ? { ...withLatency, decisionId: recorded.decisionId } : withLatency;
  } catch {
    return withLatency;
  }
}
