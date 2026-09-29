/**
 * The evaluation corpus (EVL-02, EVL-13, §18.2, E05).
 *
 * Each row carries its repository, time, stack, OS, model family, failure mode, slice and a
 * consent id. Outcome fields (verified success, cost, rework, defect escape) are labels, never
 * features: `featuresOf` builds the router's input from an allowlist, so an outcome can never
 * leak into a prediction.
 *
 * Splitting is by repository and time: a repository belongs to exactly one split, and every
 * holdout row is later than every development row. A near-duplicate detector (word-shingle
 * Jaccard over the non-sensitive task summary) blocks a split whose duplicates cross it.
 */
import { contentHash, EVAL_MIN_PER_SLICE, EVAL_MIN_TASKS, type CorpusSummary, type HoldoutManifest } from '@jevris/contracts';

export const CORPUS_ROW_FIELDS = ['taskId', 'repository', 'createdAt', 'stack', 'os', 'modelFamily', 'failureMode', 'sliceId', 'consentId', 'summary', 'features', 'outcome'] as const;
export const OUTCOME_FIELDS = ['verified', 'costMicroUsd', 'reworkMinutes', 'defectEscaped', 'humanMinutes'] as const;

export interface CorpusOutcome {
  readonly verified: boolean;
  readonly costMicroUsd: number;
  readonly reworkMinutes: number;
  readonly defectEscaped: boolean;
  readonly humanMinutes: number;
  /** Where the gold label came from. */
  readonly labelSource: 'test' | 'spec-check' | 'adjudicated-review';
}

export interface CorpusRow {
  readonly taskId: string;
  readonly repository: string;
  readonly createdAt: string;
  readonly stack: string;
  readonly os: 'darwin' | 'linux' | 'win32';
  readonly modelFamily: string;
  readonly failureMode: string;
  readonly sliceId: string;
  readonly consentId: string;
  /** A non-sensitive task summary, used only for near-duplicate detection. */
  readonly summary: string;
  /** Observable, pre-outcome task features (§8.2). */
  readonly features: { readonly [key: string]: number | string | boolean };
  readonly outcome: CorpusOutcome;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const FEATURE_KEY = /^[a-z][A-Za-z0-9]{0,63}$/;

export type RowCheck = { readonly ok: true; readonly row: CorpusRow } | { readonly ok: false; readonly reason: string };

/** Validates one untrusted corpus row. Outcome names are refused as feature keys. */
export function validateCorpusRow(value: unknown): RowCheck {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'NOT_OBJECT' };
  const row = value as Record<string, unknown>;
  const extra = Object.keys(row).find((key) => !(CORPUS_ROW_FIELDS as readonly string[]).includes(key));
  if (extra !== undefined) return { ok: false, reason: `UNKNOWN_FIELD:${extra}` };
  for (const key of ['taskId', 'repository', 'stack', 'modelFamily', 'failureMode', 'sliceId', 'consentId']) {
    if (typeof row[key] !== 'string' || !ID.test(row[key] as string)) return { ok: false, reason: `INVALID:${key}` };
  }
  if (typeof row['createdAt'] !== 'string' || !TIME.test(row['createdAt'])) return { ok: false, reason: 'INVALID:createdAt' };
  if (row['os'] !== 'darwin' && row['os'] !== 'linux' && row['os'] !== 'win32') return { ok: false, reason: 'INVALID:os' };
  if (typeof row['summary'] !== 'string' || row['summary'].length === 0 || row['summary'].length > 2000) return { ok: false, reason: 'INVALID:summary' };
  const features = row['features'];
  if (features === null || typeof features !== 'object' || Array.isArray(features)) return { ok: false, reason: 'INVALID:features' };
  for (const [key, v] of Object.entries(features)) {
    if (!FEATURE_KEY.test(key)) return { ok: false, reason: `INVALID_FEATURE:${key}` };
    if ((OUTCOME_FIELDS as readonly string[]).includes(key) || key === 'outcome' || key === 'labelSource') return { ok: false, reason: `OUTCOME_AS_FEATURE:${key}` };
    if (!['number', 'string', 'boolean'].includes(typeof v)) return { ok: false, reason: `INVALID_FEATURE:${key}` };
  }
  const outcome = row['outcome'] as Record<string, unknown> | null;
  if (outcome === null || typeof outcome !== 'object') return { ok: false, reason: 'INVALID:outcome' };
  if (typeof outcome['verified'] !== 'boolean' || typeof outcome['defectEscaped'] !== 'boolean') return { ok: false, reason: 'INVALID:outcome' };
  for (const key of ['costMicroUsd', 'reworkMinutes', 'humanMinutes']) {
    if (typeof outcome[key] !== 'number' || !Number.isFinite(outcome[key]) || (outcome[key] as number) < 0) return { ok: false, reason: `INVALID:outcome.${key}` };
  }
  if (!['test', 'spec-check', 'adjudicated-review'].includes(outcome['labelSource'] as string)) return { ok: false, reason: 'INVALID:outcome.labelSource' };
  return { ok: true, row: value as CorpusRow };
}

/** The router's input for a row: features and descriptive context only, never the outcome. */
export function featuresOf(row: CorpusRow): { readonly [key: string]: number | string | boolean } {
  const out: Record<string, number | string | boolean> = { stack: row.stack, os: row.os, modelFamily: row.modelFamily, sliceId: row.sliceId };
  for (const [key, value] of Object.entries(row.features)) if (!(OUTCOME_FIELDS as readonly string[]).includes(key)) out[key] = value;
  return out;
}

function shingles(text: string, size = 3): ReadonlySet<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 0);
  const out = new Set<string>();
  if (words.length < size) {
    if (words.length > 0) out.add(words.join(' '));
    return out;
  }
  for (let i = 0; i + size <= words.length; i += 1) out.add(words.slice(i, i + size).join(' '));
  return out;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let common = 0;
  for (const x of a) if (b.has(x)) common += 1;
  return common / (a.size + b.size - common);
}

/** Pairs of rows whose summaries are near-duplicates (Jaccard over 3-word shingles >= threshold). */
export function nearDuplicates(rows: readonly CorpusRow[], threshold = 0.8): readonly (readonly [string, string])[] {
  const sets = rows.map((row) => shingles(row.summary));
  const pairs: (readonly [string, string])[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      if (jaccard(sets[i] as ReadonlySet<string>, sets[j] as ReadonlySet<string>) >= threshold) pairs.push([(rows[i] as CorpusRow).taskId, (rows[j] as CorpusRow).taskId]);
    }
  }
  return pairs;
}

export type SplitName = 'development' | 'calibration' | 'holdout';

export interface CorpusSplit {
  readonly development: readonly CorpusRow[];
  readonly calibration: readonly CorpusRow[];
  readonly holdout: readonly CorpusRow[];
  /** Rows dropped because their repository straddles the time cutoff. */
  readonly excluded: readonly { readonly taskId: string; readonly reason: string }[];
}

/**
 * Repository-and-time split. Holdout: repositories whose earliest row is at or after the cutoff.
 * Calibration and development share the earlier repositories, assigned whole by a stable hash.
 * A repository with rows on both sides of the cutoff keeps only its pre-cutoff rows; the later
 * ones are excluded (named) so no repository or time overlaps the holdout.
 */
export function splitCorpus(rows: readonly CorpusRow[], options: { readonly holdoutFrom: string; readonly calibrationShare?: number }): CorpusSplit {
  const cutoff = Date.parse(options.holdoutFrom);
  const share = options.calibrationShare ?? 0.3;
  const earliest = new Map<string, number>();
  for (const row of rows) earliest.set(row.repository, Math.min(earliest.get(row.repository) ?? Number.POSITIVE_INFINITY, Date.parse(row.createdAt)));
  const development: CorpusRow[] = [];
  const calibration: CorpusRow[] = [];
  const holdout: CorpusRow[] = [];
  const excluded: { taskId: string; reason: string }[] = [];
  for (const row of rows) {
    const at = Date.parse(row.createdAt);
    const repoStart = earliest.get(row.repository) as number;
    if (repoStart >= cutoff) {
      holdout.push(row);
      continue;
    }
    if (at >= cutoff) {
      excluded.push({ taskId: row.taskId, reason: 'REPOSITORY_STRADDLES_CUTOFF' });
      continue;
    }
    const bucket = parseInt(contentHash(row.repository).slice(7, 15), 16) / 0xffffffff;
    (bucket < share ? calibration : development).push(row);
  }
  return { development, calibration, holdout, excluded };
}

export interface LeakageReport {
  readonly ok: boolean;
  readonly repositoryOverlap: readonly string[];
  readonly timeOverlap: boolean;
  readonly crossSplitDuplicates: readonly (readonly [string, string])[];
}

/** Blocks a split with a shared repository, a time overlap or a near-duplicate across splits. */
export function checkLeakage(split: CorpusSplit, threshold = 0.8): LeakageReport {
  const where = new Map<string, SplitName>();
  const repos = new Map<string, Set<SplitName>>();
  for (const name of ['development', 'calibration', 'holdout'] as const) {
    for (const row of split[name]) {
      where.set(row.taskId, name);
      const set = repos.get(row.repository) ?? new Set<SplitName>();
      set.add(name);
      repos.set(row.repository, set);
    }
  }
  const repositoryOverlap = [...repos.entries()].filter(([, set]) => set.size > 1).map(([repo]) => repo).sort();
  const early = [...split.development, ...split.calibration].map((row) => Date.parse(row.createdAt));
  const late = split.holdout.map((row) => Date.parse(row.createdAt));
  const timeOverlap = early.length > 0 && late.length > 0 && Math.max(...early) >= Math.min(...late);
  const all = [...split.development, ...split.calibration, ...split.holdout];
  const crossSplitDuplicates = nearDuplicates(all, threshold).filter(([a, b]) => where.get(a) !== where.get(b));
  return { ok: repositoryOverlap.length === 0 && !timeOverlap && crossSplitDuplicates.length === 0, repositoryOverlap, timeOverlap, crossSplitDuplicates };
}

/** The contracts CorpusSummary of a set of rows (consented only when every row names consent). */
export function summarizeCorpus(rows: readonly CorpusRow[]): CorpusSummary {
  const sliceCounts: Record<string, number> = {};
  for (const row of rows) sliceCounts[row.sliceId] = (sliceCounts[row.sliceId] ?? 0) + 1;
  return { labelled: rows.length > 0, consented: rows.length > 0 && rows.every((row) => row.consentId.length > 0), tasks: rows.length, sliceCounts };
}

/** Whether a corpus meets the §18.2 size floor (300 tasks, 30 per automation-eligible slice). */
export function corpusSizeReasons(summary: CorpusSummary): readonly string[] {
  const reasons: string[] = [];
  if (summary.tasks < EVAL_MIN_TASKS) reasons.push('CORPUS_TOO_SMALL');
  for (const [slice, count] of Object.entries(summary.sliceCounts)) if (count < EVAL_MIN_PER_SLICE) reasons.push(`SLICE_TOO_SMALL:${slice}`);
  return reasons;
}

/**
 * A hash-committed manifest for a holdout (EVL-13). The rows stay outside the repository; only
 * this commitment is shipped.
 */
export function holdoutManifest(rows: readonly CorpusRow[], input: { readonly holdoutId: string; readonly releasedAt: string }): HoldoutManifest {
  const sliceCounts: Record<string, number> = {};
  const sources = new Set<'test' | 'spec-check' | 'adjudicated-review'>();
  for (const row of rows) {
    sliceCounts[row.sliceId] = (sliceCounts[row.sliceId] ?? 0) + 1;
    sources.add(row.outcome.labelSource);
  }
  const ordered = [...rows].sort((a, b) => (a.taskId < b.taskId ? -1 : 1));
  return {
    schemaVersion: '1.0',
    kind: 'holdout-manifest',
    holdoutId: input.holdoutId,
    state: rows.length === 0 ? 'empty' : 'released',
    size: rows.length,
    contentHash: contentHash(ordered),
    goldLabelSources: [...sources].sort(),
    sliceCounts,
    releasedAt: rows.length === 0 ? null : input.releasedAt,
  };
}

/** Deterministic synthetic corpus for tests and demonstrations (never presented as real data). */
export function syntheticCorpus(input: { readonly tasks: number; readonly slices: readonly string[]; readonly seed?: number; readonly start?: string; readonly repositories?: number }): readonly CorpusRow[] {
  let state = (input.seed ?? 1) >>> 0;
  const random = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const start = Date.parse(input.start ?? '2026-01-01T00:00:00Z');
  const repositories = input.repositories ?? 20;
  const nouns = ['parser', 'cache', 'router', 'schema', 'client', 'report', 'queue', 'ledger', 'widget', 'importer', 'exporter', 'scheduler'];
  const verbs = ['fix', 'add', 'refactor', 'document', 'test', 'rename', 'harden', 'speed up'];
  const rows: CorpusRow[] = [];
  for (let i = 0; i < input.tasks; i += 1) {
    const repoIndex = i % repositories;
    const slice = input.slices[i % input.slices.length] as string;
    const difficulty = random();
    rows.push({
      taskId: `syn-${String(i).padStart(5, '0')}`,
      repository: `synthetic/repo-${String(repoIndex).padStart(3, '0')}`,
      // Repositories start in order, so later repositories fall after any mid-range cutoff.
      createdAt: new Date(start + repoIndex * 7 * 86_400_000 + Math.floor(i / repositories) * 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z'),
      stack: ['node', 'python', 'go'][i % 3] as string,
      os: (['linux', 'darwin', 'win32'] as const)[i % 3] as CorpusRow['os'],
      modelFamily: ['sonnet', 'opus'][i % 2] as string,
      failureMode: difficulty > 0.8 ? 'interface-ambiguity' : difficulty > 0.6 ? 'test-failure' : 'none',
      sliceId: slice,
      consentId: `consent-synthetic-${repoIndex}`,
      summary: `${verbs[i % verbs.length]} the ${nouns[(i * 7) % nouns.length]} in module ${i} of repository ${repoIndex} task ${i}`,
      features: { changedModules: 1 + (i % 5), publicApiImpact: i % 4 === 0, testCoverage: Math.round((0.4 + 0.5 * random()) * 100) / 100, difficulty: Math.round(difficulty * 100) / 100 },
      outcome: {
        verified: random() > difficulty * 0.4,
        costMicroUsd: Math.round(200_000 + difficulty * 2_000_000),
        reworkMinutes: Math.round(difficulty * 30),
        defectEscaped: random() < 0.02,
        humanMinutes: Math.round(5 + difficulty * 20),
        labelSource: i % 3 === 0 ? 'adjudicated-review' : 'test',
      },
    });
  }
  return rows;
}
