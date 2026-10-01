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

type Role = 'source' | 'test' | 'docs' | 'config' | 'ci' | 'other';

function extensionOf(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return 'none';
  const ext = base.slice(dot + 1).toLowerCase();
  return CODE_EXTENSIONS.has(ext) || DOC_EXTENSIONS.has(ext) || CONFIG_EXTENSIONS.has(ext) ? ext : 'other';
}

function roleOf(path: string, protectedOf: readonly string[]): Role {
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

const SLICE_DEFINITIONS: Readonly<Record<string, string>> = {
  'bounded-edit': 'A small edit to a few existing source files that has a clear acceptance check.',
  'issue-fix': 'A fix for a reported defect in product code.',
  'test-fix': 'Writing or repairing tests, or getting a failing test run to pass.',
  refactor: 'Restructuring code while keeping what it does the same.',
  feature: 'Adding new behaviour or a new capability to the product.',
  docs: 'Writing or updating documentation or comments only.',
  review: 'Reading and judging existing changes without editing them.',
  research: 'Investigating or comparing options before any change is made.',
  debug: 'Finding the cause of a failure by running and tracing the program.',
  migration: 'Moving code or data to a new version, format or tool.',
  terminal: 'Running commands or scripts with little or no file editing.',
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
  const finish = (r: SliceClassification): Promise<SliceClassification> => recordClassification(engine, r, features, ctx, options.record !== false, now() - started);

  // A deterministic fact needs no model.
  if (rules.sure && rulesId !== null) {
    if (rulesHint === 'high') return finish(result({ sliceId: null, source: 'none', risk: 'high', reasonCode: 'SLICE_HIGH_RISK', rulesAlternative: rulesId, evidenceIds: evidenceIdsOf(features, false) }));
    return finish(result({ sliceId: rulesId, source: 'rules', risk: rulesHint, reasonCode: 'SLICE_RULES_SURE', rulesAlternative: rulesId, evidenceIds: evidenceIdsOf(features, false) }));
  }
  const weak = (reasonCode: string, extra: Partial<SliceClassification> = {}): Promise<SliceClassification> => {
    if (rulesId === null) return finish(result({ sliceId: null, source: 'none', risk: rulesHint, reasonCode, ...extra, evidenceIds: evidenceIdsOf(features, false) }));
    if (rulesHint === 'high') return finish(result({ sliceId: null, source: 'none', risk: 'high', reasonCode: 'SLICE_HIGH_RISK', rulesAlternative: rulesId, ...extra, evidenceIds: evidenceIdsOf(features, false) }));
    return finish(result({ sliceId: rulesId, source: 'rules', risk: rulesHint, reasonCode, rulesAlternative: rulesId, ...extra, evidenceIds: evidenceIdsOf(features, false) }));
  };
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
  const choice = choiceOf(asked.answers, 'slice');
  const score = scoreOf(asked.answers, 'risk');
  const cacheHit = await cacheHitOf(engine, asked.decisionId);
  const base = { asked: true, jevDecisionId: asked.decisionId, cacheHit, latencyMs: Math.round(now() - started), rulesAlternative: rulesId, evidenceIds };
  if (choice === null) return weak('SLICE_JEV_NO_ANSWER', base);
  const jevRisk = score === null ? 'unknown' : riskOfScore(score);
  const risk = higherRisk(rulesHint, jevRisk);
  const known = (SHARED_SLICE_IDS as readonly string[]).includes(choice.choice);
  const common = { ...base, confidence: Math.round(choice.confidence * 100) / 100, jevSlice: choice.choice === 'unknown' || known ? choice.choice : null, risk };
  if (!known) return weak(choice.choice === 'unknown' ? 'SLICE_JEV_UNKNOWN' : 'SLICE_JEV_UNKNOWN_OPTION', { ...common, risk });
  if (choice.confidence < SLICE_MIN_CONFIDENCE || choice.margin < SLICE_MIN_MARGIN) return weak('SLICE_JEV_LOW_CONFIDENCE', common);
  if (risk === 'high' || (score !== null && score > SLICE_MAX_RISK_SCORE)) {
    // A high-risk answer falls to the baseline: no slice is used, whatever the rules guessed.
    return finish(result({ ...common, sliceId: null, source: 'none', risk: 'high', reasonCode: 'SLICE_HIGH_RISK' }));
  }
  const disagree = rulesId !== null && rulesId !== choice.choice;
  return finish(result({ ...common, sliceId: choice.choice, source: 'jev', reasonCode: disagree ? 'SLICE_JEV_OVER_RULES' : 'SLICE_JEV' }));
}

async function cacheHitOf(engine: DecisionEngine, decisionId: string): Promise<boolean | null> {
  try {
    const record = await engine.lookup(decisionId);
    return record === null ? null : record.reasonCodes.includes('CACHE_HIT');
  } catch {
    return null;
  }
}

const REASON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** The reason codes of the recorded decision: every one reads back through `sliceAssistLines`. */
export function sliceReasonCodes(r: SliceClassification): string[] {
  const codes = [
    `SLICE_SOURCE_${r.source.toUpperCase()}`,
    ...(r.sliceId === null ? [] : [`SLICE_ID_${sliceCodeOf(r.sliceId)}`]),
    `RISK_${r.risk.toUpperCase()}`,
    ...(r.jevSlice === null ? [] : [`JEV_SLICE_${sliceCodeOf(r.jevSlice)}`]),
    ...(r.rulesAlternative === null ? [] : [`RULES_ALT_${sliceCodeOf(r.rulesAlternative)}`]),
    ...(r.asked ? [r.cacheHit === true ? 'JEV_CACHE_HIT' : 'JEV_CACHE_MISS'] : []),
    ...(r.confidence === null ? [] : [`CONF_${Math.round(r.confidence * 100)}`]),
    r.reasonCode,
  ];
  return codes.filter((c) => REASON_CODE.test(c));
}

async function recordClassification(engine: DecisionEngine | null, r: SliceClassification, features: SliceFeatures, ctx: IntentContext, record: boolean, elapsedMs: number): Promise<SliceClassification> {
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
      reasonCodes: sliceReasonCodes(r),
      durationMs: Math.max(0, Math.round(elapsedMs)),
    });
    void features;
    return recorded.ok ? { ...withLatency, decisionId: recorded.decisionId } : withLatency;
  } catch {
    return withLatency;
  }
}
