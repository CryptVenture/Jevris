/**
 * Check relevance (owner decision 2026-10-01, Jev as an active decision aid): which approved
 * checks matter most for the change in front of the agent, so the Stop reminder names them first
 * and `jevris verify` runs them first.
 *
 * This is advice about ORDER, nothing else.
 * - Every approved check still runs and is still required. No score drops, skips, waives or marks
 *   a check passed. Only receipts decide done.
 * - Rules first. A failing last receipt is always first; a check that already passes is last.
 *   Between them the rules score each check kind against the shape of the change (docs-only,
 *   test-only, config or CI, source). The rules are sure when the change is all one role.
 * - Jev is asked only when the rules are not sure, `jev.assist` is `classify`, the mode allows a
 *   record, the kill switch is off and a call can finish in time: one request, one Score (0 to 4)
 *   per open check, at most 12 questions, from content-free features. The request carries no path
 *   name, no diff, no check output, no check name and no objective text: a check is named by its
 *   position (`c1`), its kind and its last result. The decision cache answers a repeat.
 * - A Jev score is used only at a confidence of 0.6 or more. A low confidence, an error, a
 *   deadline, a budget stop or an open circuit keeps the rules order, with a reason code. The
 *   caller never waits past `deadlineMs`; a late answer only warms the cache.
 * - Each ranking of two or more checks is recorded as an advisory `check-relevance` decision
 *   (reason codes and feature names only), so `jevris explain` can render it and the decision/task
 *   outcome join labels it like every other decision.
 */
import { MAX_QUESTIONS, modeAllows, type JevQuestions, type Mode } from '@jevris/contracts';
import { createHash } from 'node:crypto';
import type { DecisionEngine } from './decision-engine.js';
import { askBoundedDecision, type IntentContext } from './intent-decisions.js';
import { protectedClasses } from './protected-paths.js';
import { extensionOf, roleOf } from './slice-classifier.js';
import { CHECK_RELEVANCE_SPEC_ID } from './check-relevance-explain.js';

export { CHECK_RELEVANCE_SPEC_ID } from './check-relevance-explain.js';

/** What a check is for, derived locally from its id (and description) and never sent. */
export const RELEVANCE_KINDS = ['test', 'lint', 'typecheck', 'build', 'coverage', 'docs', 'generated', 'pack', 'other'] as const;
export type RelevanceKind = (typeof RELEVANCE_KINDS)[number];

/** The last receipt of a check, as the change in front of the agent sees it. */
export const CHECK_LAST_STATES = ['passing', 'failing', 'missing', 'stale'] as const;
export type CheckLastState = (typeof CHECK_LAST_STATES)[number];

export const CHANGE_SHAPES = ['none', 'docs', 'test', 'config', 'source', 'mixed'] as const;
export type ChangeShape = (typeof CHANGE_SHAPES)[number];

export interface RelevanceCheck {
  readonly id: string;
  readonly state: CheckLastState;
  /** The manifest's description, used locally to tell a check's kind when its id does not; never sent. */
  readonly description?: string | null;
}

const KIND_WORDS: readonly (readonly [RelevanceKind, readonly string[]])[] = [
  ['coverage', ['coverage', 'cov', 'c8', 'nyc', 'istanbul']],
  ['pack', ['pack', 'packaging', 'tarball', 'publish', 'release', 'dist']],
  ['generated', ['generated', 'codegen', 'gen', 'regen', 'regenerate', 'drift', 'uptodate']],
  ['docs', ['docs', 'doc', 'documentation', 'markdown', 'mdlint', 'readme', 'spell', 'spelling', 'links', 'linkcheck', 'vale']],
  ['typecheck', ['typecheck', 'tsc', 'mypy', 'pyright', 'types', 'type', 'typing']],
  ['lint', ['lint', 'eslint', 'biome', 'prettier', 'format', 'fmt', 'style', 'stylelint', 'flake8', 'ruff', 'clippy']],
  ['test', ['test', 'tests', 'spec', 'specs', 'unit', 'e2e', 'integration', 'jest', 'vitest', 'pytest', 'mocha', 'qa', 'acceptance']],
  ['build', ['build', 'compile', 'bundle', 'make']],
];

function kindOfText(text: string): RelevanceKind {
  const words = new Set(text.slice(0, 400).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 0));
  for (const [kind, list] of KIND_WORDS) if (list.some((w) => words.has(w))) return kind;
  return 'other';
}

/** A check's kind: from its id, else from its description. Pure and local. */
export function relevanceKindOf(id: string, description?: string | null): RelevanceKind {
  const fromId = kindOfText(id);
  if (fromId !== 'other' || typeof description !== 'string') return fromId;
  return kindOfText(description);
}

const MAX_PATHS = 2_000;
const MAX_PATH_CHARS = 512;

/** The content-free features of a change: counts, categories, codes and a size bucket. */
export interface ChangeFeatures {
  readonly files: number;
  readonly sizeBucket: 'none' | 'small' | 'medium' | 'large';
  /** `ts:3,md:1`: the top six extensions over a fixed vocabulary, or `none`. */
  readonly extensions: string;
  readonly roleSource: number;
  readonly roleTest: number;
  readonly roleDocs: number;
  readonly roleConfig: number;
  readonly roleCi: number;
  readonly roleOther: number;
  /** Protected path classes (`PROTECTED_CI` ...), sorted; empty when none. */
  readonly protectedClasses: readonly string[];
  readonly shape: ChangeShape;
  /** True when the change is all one role, so the rules settle the order and Jev is not asked. */
  readonly singleRole: boolean;
}

/** The features of the changed paths (workspace relative). Null or empty paths are `none`. Pure. */
export function changeFeatures(paths: readonly string[] | null | undefined): ChangeFeatures {
  const list = (paths ?? []).filter((p): p is string => typeof p === 'string' && p.length > 0 && p.length <= MAX_PATH_CHARS && !p.includes('\0')).slice(0, MAX_PATHS);
  const roles = { source: 0, test: 0, docs: 0, config: 0, ci: 0, other: 0 };
  const exts = new Map<string, number>();
  const protectedSet = new Set<string>();
  for (const path of list) {
    const classes = protectedClasses(path);
    for (const c of classes) protectedSet.add(c);
    roles[roleOf(path, classes)] += 1;
    const ext = extensionOf(path);
    exts.set(ext, (exts.get(ext) ?? 0) + 1);
  }
  const files = list.length;
  const histogram = [...exts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 6).map(([e, n]) => `${e}:${String(n)}`).join(',');
  const configLike = roles.config + roles.ci;
  let shape: ChangeShape = 'mixed';
  let singleRole = false;
  if (files === 0) shape = 'none';
  else if (roles.docs === files) [shape, singleRole] = ['docs', true];
  else if (roles.test === files) [shape, singleRole] = ['test', true];
  else if (configLike === files) [shape, singleRole] = ['config', true];
  else if (roles.source > 0) [shape, singleRole] = ['source', roles.source === files];
  return {
    files,
    sizeBucket: files === 0 ? 'none' : files <= 3 ? 'small' : files <= 15 ? 'medium' : 'large',
    extensions: histogram === '' ? 'none' : histogram,
    roleSource: roles.source,
    roleTest: roles.test,
    roleDocs: roles.docs,
    roleConfig: roles.config,
    roleCi: roles.ci,
    roleOther: roles.other,
    protectedClasses: [...protectedSet].sort(),
    shape,
    singleRole,
  };
}

/**
 * How much a change of each shape needs a check of each kind, 0 (not at all) to 4 (essential). With
 * no known change every kind scores the same, so the usual order stands.
 */
const RULE_SCORES: Readonly<Record<RelevanceKind, Readonly<Record<ChangeShape, number>>>> = {
  //            none docs test config source mixed
  test: { none: 2, docs: 0, test: 4, config: 2, source: 4, mixed: 3 },
  lint: { none: 2, docs: 1, test: 3, config: 4, source: 3, mixed: 3 },
  typecheck: { none: 2, docs: 0, test: 3, config: 3, source: 4, mixed: 3 },
  build: { none: 2, docs: 0, test: 1, config: 4, source: 3, mixed: 3 },
  coverage: { none: 2, docs: 0, test: 3, config: 1, source: 3, mixed: 2 },
  docs: { none: 2, docs: 4, test: 0, config: 1, source: 2, mixed: 2 },
  generated: { none: 2, docs: 3, test: 0, config: 2, source: 3, mixed: 2 },
  pack: { none: 2, docs: 1, test: 0, config: 3, source: 2, mixed: 2 },
  other: { none: 2, docs: 2, test: 2, config: 2, source: 2, mixed: 2 },
};

/** The rules' score of a check kind against a change shape (0 to 4). */
export function rulesRelevanceScore(kind: RelevanceKind, shape: ChangeShape): number {
  return RULE_SCORES[kind][shape];
}

/** A failing last receipt comes first, a check that already passes last, the open ones between. */
const STATE_TIER: Readonly<Record<CheckLastState, number>> = { failing: 0, missing: 1, stale: 1, passing: 2 };
/** Within a tier at equal score: missing before stale. */
const STATE_RANK: Readonly<Record<CheckLastState, number>> = { failing: 0, missing: 1, stale: 2, passing: 3 };

interface Row {
  readonly id: string;
  readonly state: CheckLastState;
  readonly kind: RelevanceKind;
  readonly index: number;
  readonly rules: number;
}

function sortRows(rows: readonly Row[], scoreOf: (row: Row) => number): Row[] {
  return [...rows].sort((a, b) => STATE_TIER[a.state] - STATE_TIER[b.state] || scoreOf(b) - scoreOf(a) || STATE_RANK[a.state] - STATE_RANK[b.state] || a.index - b.index);
}

export type RankSource = 'rules' | 'jev';
export type FirstWhy = 'failed' | 'jev' | 'shape' | 'unknown';

export interface CheckRanking {
  /** Every input check id exactly once: the order to run or name them in. A permutation, never a subset. */
  readonly order: readonly string[];
  readonly source: RankSource;
  /** Why this source: a `CHECK_RELEVANCE_*` code, content-free. */
  readonly reasonCode: string;
  readonly shape: ChangeShape;
  readonly firstId: string | null;
  readonly firstKind: RelevanceKind | null;
  /** Why the first check is first, as a code. */
  readonly firstWhy: FirstWhy | null;
  /** Why the first check is first, as a short clause (no check or path name). */
  readonly firstReason: string;
  /** The one plain-text line that says the order is advice, its source and why the first is first. */
  readonly text: string;
  /** Jev was asked (a call or the cache). */
  readonly asked: boolean;
  readonly askedCount: number;
  /** Scores accepted (confidence at or above the floor). */
  readonly usedCount: number;
  /** More open checks than the question cap: the rest kept the rules order. */
  readonly capped: boolean;
  readonly cacheHit: boolean | null;
  readonly latencyMs: number | null;
  /** The decision record of this ranking; null when none was recorded. */
  readonly decisionId: string | null;
  /** The Jev call's own decision id, when Jev was asked. */
  readonly jevDecisionId: string | null;
  readonly evidenceIds: readonly string[];
}

export interface RankOptions {
  readonly assist: 'off' | 'classify';
  /** The effective mode; absent reads as observe. Below observe nothing is asked or recorded. */
  readonly mode?: Mode;
  /** The kill switch was stopped when the request arrived: rules only, nothing recorded. */
  readonly killSwitchStopped?: boolean;
  /** How long the caller waits for Jev, in ms; past it the rules order is used. */
  readonly deadlineMs: number;
  /** Record the ranking as an advisory decision (default true). */
  readonly record?: boolean;
  /** The clock for latency; tests inject one. */
  readonly now?: () => number;
  /** How long past `deadlineMs` the engine lets the call run to warm the cache (default 1000 ms). */
  readonly lateGraceMs?: number;
}

/** Jev's confidence floor for a score to be used. */
export const RELEVANCE_MIN_CONFIDENCE = 0.6;
/** Below this many ms left, Jev is not asked: a call cannot finish. */
export const RELEVANCE_MIN_DEADLINE_MS = 150;
/** The most checks asked about in one request (the question cap). */
export const RELEVANCE_MAX_ASKED = MAX_QUESTIONS;
const RELEVANCE_MAX_CHECKS = 512;
const DEFAULT_LATE_GRACE_MS = 1_000;

const SHAPE_WORDS: Readonly<Record<ChangeShape, string>> = {
  none: 'no change is known',
  docs: 'documentation edits',
  test: 'test-file edits',
  config: 'config or CI edits',
  source: 'source edits',
  mixed: 'a mix of edits',
};

export const RELEVANCE_ANCHORS = [
  'Not needed: the change shape never touches what this kind of check covers.',
  'Unlikely to be needed: little of the change touches what this kind of check covers.',
  'Possibly needed: some of the change touches what this kind of check covers.',
  'Likely needed: much of the change touches what this kind of check covers.',
  'Essential: the change is mostly the kind of work this kind of check covers.',
] as const;

/** The questions: one Score per asked check, `c1` to `cN`. Fixed text, no user text. */
export function relevanceQuestions(count: number): JevQuestions {
  const n = Math.max(1, Math.min(RELEVANCE_MAX_ASKED, Math.floor(count)));
  const questions: Record<string, unknown> = {};
  for (let i = 1; i <= n; i += 1) {
    questions[`c${String(i)}`] = {
      type: 'score',
      instructions: `How likely does a change of the shape in the facts need check c${String(i)} (its kind and last result are in the facts as c${String(i)}) before the work can be called done?`,
      criteria: [...RELEVANCE_ANCHORS],
    };
  }
  return questions as unknown as JevQuestions;
}

/** The facts of the request: the change features and each asked check by position, kind and last result. */
function relevanceFacts(f: ChangeFeatures, asked: readonly Row[], totalChecks: number): Record<string, string | number> {
  const facts: Record<string, string | number> = {
    files: f.files,
    sizeBucket: f.sizeBucket,
    extensions: f.extensions,
    roleSource: f.roleSource,
    roleTest: f.roleTest,
    roleDocs: f.roleDocs,
    roleConfig: f.roleConfig,
    roleCi: f.roleCi,
    roleOther: f.roleOther,
    protectedClasses: f.protectedClasses.length === 0 ? 'none' : f.protectedClasses.join(','),
    shape: f.shape,
    approvedChecks: totalChecks,
  };
  asked.forEach((row, i) => {
    facts[`c${String(i + 1)}`] = `${row.kind}|${row.state}`;
  });
  return facts;
}

function evidenceIdsOf(f: ChangeFeatures, kindsKnown: boolean): string[] {
  const ids: string[] = [];
  if (f.files > 0) ids.push('feature-files', 'feature-size', 'feature-extensions', 'feature-roles');
  if (f.protectedClasses.length > 0) ids.push('feature-protected');
  if (kindsKnown) ids.push('check-kinds', 'check-states');
  return ids;
}

function revisionOf(f: ChangeFeatures, rows: readonly Row[]): string {
  const text = JSON.stringify([f, rows.map((r) => `${r.kind}|${r.state}`)]);
  return `rank-${createHash('sha256').update(text).digest('hex').slice(0, 24)}`;
}

interface Scored {
  readonly score: number;
  readonly confidence: number;
}

function scoresOf(answers: Readonly<Record<string, { readonly type: string; readonly [key: string]: unknown }>>, count: number): (Scored | null)[] {
  const out: (Scored | null)[] = [];
  for (let i = 1; i <= count; i += 1) {
    const a = answers[`c${String(i)}`];
    if (a === undefined || a.type !== 'score' || typeof a['score'] !== 'number' || !Number.isFinite(a['score'])) {
      out.push(null);
      continue;
    }
    const score = Math.round(a['score']);
    if (score < 0 || score > RELEVANCE_ANCHORS.length - 1) {
      out.push(null);
      continue;
    }
    const probabilities = a['probabilities'];
    const top = probabilities !== null && typeof probabilities === 'object' ? Math.max(0, ...Object.values(probabilities as Record<string, number>).filter((p) => typeof p === 'number')) : 0;
    const confidence = typeof a['confidence'] === 'number' && Number.isFinite(a['confidence']) ? a['confidence'] : top;
    out.push({ score, confidence });
  }
  return out;
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

/** The reason codes of the recorded decision: every one reads back through `checkRelevanceLines`. */
export function relevanceReasonCodes(r: CheckRanking, totalChecks: number): string[] {
  const codes = [
    `RANK_SOURCE_${r.source.toUpperCase()}`,
    `RANK_SHAPE_${r.shape.toUpperCase()}`,
    ...(r.firstKind === null ? [] : [`RANK_FIRST_${r.firstKind.toUpperCase()}`]),
    ...(r.firstWhy === null ? [] : [`RANK_WHY_${r.firstWhy.toUpperCase()}`]),
    `RANK_CHECKS_${String(Math.min(totalChecks, 9999))}`,
    ...(r.asked ? [`RANK_ASKED_${String(r.askedCount)}`, `RANK_USED_${String(r.usedCount)}`, r.cacheHit === true ? 'JEV_CACHE_HIT' : 'JEV_CACHE_MISS'] : []),
    ...(r.capped ? ['RANK_CAPPED'] : []),
    r.reasonCode,
  ];
  return codes.filter((c) => REASON_CODE.test(c));
}

function clauseOf(source: RankSource, shape: ChangeShape, firstId: string | null, firstState: CheckLastState | null, jevPlaced: boolean): { readonly firstWhy: FirstWhy | null; readonly firstReason: string; readonly text: string } {
  if (firstId === null) return { firstWhy: null, firstReason: '', text: '' };
  const [firstWhy, firstReason]: [FirstWhy, string] =
    firstState === 'failing'
      ? ['failed', 'its last run failed']
      : shape === 'none'
        ? ['unknown', 'no change is known, so the usual order stands']
        : jevPlaced
          ? ['jev', `Jev rated it most relevant to this change (${SHAPE_WORDS[shape]})`]
          : ['shape', `most relevant to this change: ${SHAPE_WORDS[shape]}`];
  const who = source === 'jev' ? 'Jev' : 'rules';
  return { firstWhy, firstReason, text: `Order is advice (${who}): ${firstId} first, ${firstReason}. No check is skipped or waived.` };
}

interface Prepared {
  readonly features: ChangeFeatures;
  readonly rows: readonly Row[];
  readonly rulesRows: readonly Row[];
}

/** Dedupes the checks (the first of an id wins), derives kinds, and scores them by the rules. Pure. */
function prepare(input: { readonly checks: readonly RelevanceCheck[]; readonly paths: readonly string[] | null }): Prepared {
  const seen = new Set<string>();
  const checks: RelevanceCheck[] = [];
  for (const c of input.checks) {
    if (typeof c.id !== 'string' || c.id.length === 0 || seen.has(c.id) || checks.length >= RELEVANCE_MAX_CHECKS) continue;
    seen.add(c.id);
    checks.push(c);
  }
  const features = changeFeatures(input.paths);
  const rows: Row[] = checks.map((c, index) => {
    const kind = relevanceKindOf(c.id, c.description ?? null);
    return { id: c.id, state: c.state, kind, index, rules: rulesRelevanceScore(kind, features.shape) };
  });
  return { features, rows, rulesRows: sortRows(rows, (r) => r.rules) };
}

/**
 * Orders the checks by how much the change needs them. Never throws and never waits past
 * `options.deadlineMs` for Jev: any failure is the rules order. The result's `order` always holds
 * every input check once.
 */
export async function rankChecks(
  engine: DecisionEngine | null,
  input: { readonly checks: readonly RelevanceCheck[]; readonly paths: readonly string[] | null },
  ctx: Pick<IntentContext, 'workspaceId' | 'taskId' | 'sessionId'>,
  options: RankOptions,
): Promise<CheckRanking> {
  const now = options.now ?? (() => performance.now());
  const started = now();
  const { features, rows, rulesRows } = prepare(input);
  const mode: Mode = options.mode ?? 'observe';
  const recordable = options.record !== false && options.killSwitchStopped !== true && modeAllows(mode, 'record') && engine !== null && engine.recordAdvice !== undefined;

  const build = (r: {
    readonly ordered: readonly Row[];
    readonly source: RankSource;
    readonly reasonCode: string;
    readonly asked?: boolean;
    readonly askedCount?: number;
    readonly usedCount?: number;
    readonly capped?: boolean;
    readonly cacheHit?: boolean | null;
    readonly jevDecisionId?: string | null;
    readonly jevPlaced?: boolean;
  }): CheckRanking => {
    const first = r.ordered[0];
    const clause = clauseOf(r.source, features.shape, first?.id ?? null, first?.state ?? null, r.jevPlaced === true);
    return {
      order: r.ordered.map((row) => row.id),
      source: r.source,
      reasonCode: r.reasonCode,
      shape: features.shape,
      firstId: first?.id ?? null,
      firstKind: first?.kind ?? null,
      firstWhy: clause.firstWhy,
      firstReason: clause.firstReason,
      text: clause.text,
      asked: r.asked === true,
      askedCount: r.askedCount ?? 0,
      usedCount: r.usedCount ?? 0,
      capped: r.capped === true,
      cacheHit: r.cacheHit ?? null,
      latencyMs: null,
      decisionId: null,
      jevDecisionId: r.jevDecisionId ?? null,
      evidenceIds: evidenceIdsOf(features, rows.length > 0),
    };
  };

  /** Records the ranking (when there are two or more checks and the gates allow) and stamps its latency. */
  const finish = async (ranking: CheckRanking): Promise<CheckRanking> => {
    const elapsed = Math.max(0, Math.round(now() - started));
    const timed: CheckRanking = { ...ranking, latencyMs: ranking.asked ? elapsed : null };
    if (!recordable || rows.length < 2 || engine === null || engine.recordAdvice === undefined) return timed;
    try {
      const recorded = await engine.recordAdvice({
        specId: CHECK_RELEVANCE_SPEC_ID,
        workspaceId: ctx.workspaceId,
        evidenceRevision: revisionOf(features, rows),
        ...(ctx.taskId === undefined || ctx.taskId === null ? {} : { taskId: ctx.taskId }),
        ...(ctx.sessionId === undefined || ctx.sessionId === null ? {} : { sessionId: ctx.sessionId }),
        action: { kind: 'advise', templateId: CHECK_RELEVANCE_SPEC_ID, evidenceIds: [...timed.evidenceIds].slice(0, 64) },
        reasonCodes: relevanceReasonCodes(timed, rows.length),
        durationMs: elapsed,
      });
      return recorded.ok ? { ...timed, decisionId: recorded.decisionId } : timed;
    } catch {
      return timed;
    }
  };

  const rulesOnly = (reasonCode: string, extra: Partial<Parameters<typeof build>[0]> = {}): Promise<CheckRanking> => finish(build({ ordered: rulesRows, source: 'rules', reasonCode, ...extra }));

  if (rows.length < 2) return rulesOnly('CHECK_RELEVANCE_TOO_FEW');
  if (options.killSwitchStopped === true) return rulesOnly('CHECK_RELEVANCE_KILL_SWITCH');
  if (!modeAllows(mode, 'record')) return rulesOnly('CHECK_RELEVANCE_MODE_OFF');
  if (options.assist === 'off') return rulesOnly('CHECK_RELEVANCE_ASSIST_OFF');
  if (engine === null) return rulesOnly('CHECK_RELEVANCE_NO_PROVIDER');
  if (features.shape === 'none') return rulesOnly('CHECK_RELEVANCE_NO_CHANGE');
  if (features.singleRole) return rulesOnly('CHECK_RELEVANCE_RULES_SURE');
  // Jev is asked about the open checks; a failing one is first and a passing one last whatever Jev says.
  const open = rulesRows.filter((r) => STATE_TIER[r.state] === 1);
  const candidates = open.slice(0, RELEVANCE_MAX_ASKED);
  const capped = open.length > RELEVANCE_MAX_ASKED;
  if (candidates.length < 2) return rulesOnly('CHECK_RELEVANCE_ONE_CANDIDATE');
  if (!Number.isFinite(options.deadlineMs) || options.deadlineMs < RELEVANCE_MIN_DEADLINE_MS) return rulesOnly('CHECK_RELEVANCE_NO_TIME');

  const grace = options.lateGraceMs ?? DEFAULT_LATE_GRACE_MS;
  const questions = relevanceQuestions(candidates.length);
  const packet = {
    objective: 'Rank approved checks by how much a change of the described shape needs each one (advice only).',
    trustedPolicy: { checks: candidates.length, grantsAuthority: false },
    facts: relevanceFacts(features, candidates, rows.length),
    evidence: [],
  };
  const run = askBoundedDecision(engine, CHECK_RELEVANCE_SPEC_ID, questions, packet, { workspaceId: ctx.workspaceId, evidenceRevision: revisionOf(features, rows), ...(ctx.taskId === undefined || ctx.taskId === null ? {} : { taskId: ctx.taskId }), ...(ctx.sessionId === undefined || ctx.sessionId === null ? {} : { sessionId: ctx.sessionId }), deadlineMs: Math.max(1, Math.floor(options.deadlineMs + grace)) }, false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), Math.max(1, Math.floor(options.deadlineMs)));
  });
  let asked: Awaited<typeof run> | 'late' | 'failed';
  try {
    asked = await Promise.race([run.catch(() => 'failed' as const), late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  // Abandoned at the deadline: the rules order stands and a late answer only warms the engine's cache.
  if (asked === 'late') {
    void run.catch(() => undefined);
    return rulesOnly('CHECK_RELEVANCE_DEADLINE', { asked: true, askedCount: candidates.length, capped });
  }
  if (asked === 'failed') return rulesOnly('CHECK_RELEVANCE_ERROR', { asked: true, askedCount: candidates.length, capped });
  if (!asked.ok) return rulesOnly(`CHECK_RELEVANCE_JEV_${asked.reasonCode}`.slice(0, 64), { asked: true, askedCount: candidates.length, capped, jevDecisionId: asked.decisionId });
  const scores = scoresOf(asked.answers, candidates.length);
  const cacheHit = await cacheHitOf(engine, asked.decisionId);
  const used = new Map<string, number>();
  scores.forEach((s, i) => {
    const row = candidates[i];
    if (row !== undefined && s !== null && s.confidence >= RELEVANCE_MIN_CONFIDENCE) used.set(row.id, s.score);
  });
  const base = { asked: true, askedCount: candidates.length, capped, cacheHit, jevDecisionId: asked.decisionId };
  if (used.size === 0) return rulesOnly(scores.every((s) => s === null) ? 'CHECK_RELEVANCE_JEV_NO_ANSWER' : 'CHECK_RELEVANCE_JEV_LOW_CONFIDENCE', base);
  // Failing first, then the asked open checks by Jev's score (the rules' score where Jev's was not
  // used), then the open checks past the cap in rules order, then the passing ones.
  const askedIds = new Set(candidates.map((c) => c.id));
  const failing = rulesRows.filter((r) => STATE_TIER[r.state] === 0);
  const jevOpen = sortRows(candidates, (r) => used.get(r.id) ?? r.rules);
  const rest = open.filter((r) => !askedIds.has(r.id));
  const passing = rulesRows.filter((r) => STATE_TIER[r.state] === 2);
  const ordered = [...failing, ...jevOpen, ...rest, ...passing];
  const firstOpen = jevOpen[0];
  // "Jev rated it most relevant" is said only when its score for the first check beats another's: a tie is the rules' call.
  const firstScore = firstOpen === undefined ? undefined : used.get(firstOpen.id);
  const jevPlaced = failing.length === 0 && firstScore !== undefined && [...used.values()].some((v) => v < firstScore);
  return finish(build({ ordered, source: 'jev', reasonCode: used.size === candidates.length ? 'CHECK_RELEVANCE_JEV' : 'CHECK_RELEVANCE_JEV_PARTIAL', ...base, usedCount: used.size, jevPlaced }));
}

/**
 * The same ranking with no model, no record and no wait: the rules order with a reason code. For a
 * caller that cannot ask (no engine in reach, no time) and for the deadline fallback.
 */
export function rulesOrderOf(input: { readonly checks: readonly RelevanceCheck[]; readonly paths: readonly string[] | null }, reasonCode: string): CheckRanking {
  const { features, rows, rulesRows } = prepare(input);
  const first = rulesRows[0];
  const clause = clauseOf('rules', features.shape, first?.id ?? null, first?.state ?? null, false);
  return {
    order: rulesRows.map((r) => r.id),
    source: 'rules',
    reasonCode,
    shape: features.shape,
    firstId: first?.id ?? null,
    firstKind: first?.kind ?? null,
    firstWhy: clause.firstWhy,
    firstReason: clause.firstReason,
    text: clause.text,
    asked: false,
    askedCount: 0,
    usedCount: 0,
    capped: false,
    cacheHit: null,
    latencyMs: null,
    decisionId: null,
    jevDecisionId: null,
    evidenceIds: evidenceIdsOf(features, rows.length > 0),
  };
}

/** Reorders `items` by `order` (ids first, in that order), keeping every item: a permutation. Pure. */
export function applyCheckOrder<T>(items: readonly T[], idOf: (item: T) => string, order: readonly string[] | undefined): T[] {
  if (order === undefined || order.length === 0) return [...items];
  const position = new Map<string, number>();
  order.forEach((id, i) => {
    if (!position.has(id)) position.set(id, i);
  });
  return items
    .map((item, index) => ({ item, index, at: position.get(idOf(item)) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map((x) => x.item);
}
