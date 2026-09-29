/**
 * The trial runner (EVL-05, §18.4, US35, E17).
 *
 * Every task runs under every arm (paired design) in a seeded random arm order, each in its own
 * sandbox directory that is created before the run and removed after it. The runner captures
 * completion, verification receipts, retries, tokens, cost, wall time, human minutes and defect
 * escapes. Analysis is intent-to-treat: a run that throws, times out or is abandoned stays in the
 * denominator as a failed task; nothing assigned is dropped after the fact.
 *
 * The harness driver and providers are injected, so the whole trial runs end to end against a
 * mock harness driver and mock providers in tests, and against real ones in a release trial.
 */
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapInterval, seededRandom, wilsonInterval } from './metrics.js';

export const TRIAL_ARMS = ['native', 'static', 'rules-only', 'jev-routed', 'generative'] as const;
export const ABLATION_ARMS = ['routing-only', 'memory-only', 'log-reduction-only', 'combined'] as const;
export type TrialArm = (typeof TRIAL_ARMS)[number] | (typeof ABLATION_ARMS)[number];
/** Arms every trial must include; `generative` is optional. */
export const REQUIRED_ARMS: readonly TrialArm[] = ['native', 'static', 'rules-only', 'jev-routed', 'routing-only', 'memory-only', 'log-reduction-only', 'combined'];

export interface TrialTask {
  readonly taskId: string;
  readonly repository: string;
  readonly sliceId: string;
  /** Pre-assignment difficulty stratum (for balance checks only). */
  readonly difficulty: 'easy' | 'medium' | 'hard';
}

export interface Sandbox {
  readonly path: string;
  dispose(): Promise<void>;
}

export interface SandboxFactory {
  create(task: TrialTask, arm: TrialArm): Promise<Sandbox>;
}

/** What a harness driver reports for one task under one arm. */
export interface RunOutcome {
  readonly completed: boolean;
  /** Ids of independent verification receipts; a task counts as verified only with at least one passing receipt. */
  readonly receipts: readonly { readonly id: string; readonly passed: boolean }[];
  readonly retries: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicroUsd: number;
  /** Where the cost number comes from. */
  readonly costSource: 'provider-reported' | 'billing-export' | 'estimate';
  readonly estimatedCostMicroUsd: number;
  readonly wallMs: number;
  readonly humanMinutes: number;
  readonly defectEscaped: boolean;
  readonly abandoned: boolean;
  /** Safety failures observed (policy violations, out-of-scope writes); never expected. */
  readonly safetyFailures: readonly string[];
  /** Cost components this run's `costMicroUsd` and `humanMinutes` actually include. */
  readonly measuredComponents: readonly ('retries' | 'cache' | 'verification' | 'human-minutes')[];
}

export interface HarnessDriver {
  run(input: { readonly task: TrialTask; readonly arm: TrialArm; readonly sandbox: Sandbox; readonly signal: AbortSignal }): Promise<RunOutcome>;
}

export interface TrialRow extends RunOutcome {
  readonly taskId: string;
  readonly repository: string;
  readonly sliceId: string;
  readonly difficulty: TrialTask['difficulty'];
  readonly arm: TrialArm;
  readonly verified: boolean;
  /** Set when the run failed to report; the row still counts (intent-to-treat). */
  readonly errorCode: string | null;
  readonly order: number;
}

export interface TrialResult {
  readonly ok: true;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly arms: readonly TrialArm[];
  readonly tasks: number;
  readonly rows: readonly TrialRow[];
  /** Always empty: exclusions happen before assignment, never after a result is seen. */
  readonly postAssignmentExclusions: readonly never[];
}

export type TrialRefusal = { readonly ok: false; readonly reasonCode: 'PRE_REGISTRATION_NOT_LOCKED' | 'ARMS_MISSING' | 'NO_TASKS' | 'DUPLICATE_TASK'; readonly detail?: string };

const FAILED: Omit<RunOutcome, 'wallMs'> = {
  completed: false,
  receipts: [],
  retries: 0,
  inputTokens: 0,
  outputTokens: 0,
  costMicroUsd: 0,
  costSource: 'estimate',
  estimatedCostMicroUsd: 0,
  humanMinutes: 0,
  defectEscaped: false,
  abandoned: true,
  safetyFailures: [],
  measuredComponents: [],
};

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** Sandboxes as fresh copies of a fixture repository under `baseDir`, one per task and arm. */
export function directorySandboxes(baseDir: string, template: string | null): SandboxFactory {
  return {
    async create(task, arm) {
      const path = await mkdtemp(join(baseDir, ['trial', arm, ''].join('-')));
      if (template !== null) await cp(template, path, { recursive: true, force: true });
      void task;
      return { path, dispose: () => rm(path, { recursive: true, force: true }) };
    },
  };
}

/**
 * Runs the trial. The pre-registration must be locked before the trial starts (EVL-12): a trial
 * whose start is not after `lockedAt` is refused.
 */
export async function runTrial(input: {
  readonly tasks: readonly TrialTask[];
  readonly arms: readonly TrialArm[];
  readonly driver: HarnessDriver;
  readonly sandboxes: SandboxFactory;
  readonly preRegistrationLockedAt: string;
  readonly seed: number;
  readonly now: () => number;
  readonly timeoutMs?: number;
}): Promise<TrialResult | TrialRefusal> {
  if (input.tasks.length === 0) return { ok: false, reasonCode: 'NO_TASKS' };
  const missing = REQUIRED_ARMS.filter((arm) => !input.arms.includes(arm));
  if (missing.length > 0) return { ok: false, reasonCode: 'ARMS_MISSING', detail: missing.join(',') };
  const ids = new Set(input.tasks.map((t) => t.taskId));
  if (ids.size !== input.tasks.length) return { ok: false, reasonCode: 'DUPLICATE_TASK' };
  const startedMs = input.now();
  const locked = Date.parse(input.preRegistrationLockedAt);
  if (!Number.isFinite(locked) || locked >= startedMs) return { ok: false, reasonCode: 'PRE_REGISTRATION_NOT_LOCKED' };
  const random = seededRandom(input.seed);
  const rows: TrialRow[] = [];
  let order = 0;
  for (const task of shuffle(input.tasks, random)) {
    for (const arm of shuffle(input.arms, random)) {
      order += 1;
      const begin = input.now();
      let outcome: RunOutcome;
      let errorCode: string | null = null;
      let sandbox: Sandbox | null = null;
      const controller = new AbortController();
      try {
        sandbox = await input.sandboxes.create(task, arm);
        const run = input.driver.run({ task, arm, sandbox, signal: controller.signal });
        const limit = input.timeoutMs;
        outcome = await (limit === undefined
          ? run
          : Promise.race([
              run,
              new Promise<never>((_, reject) => {
                const timer = setTimeout(() => reject(new Error('TRIAL_TIMEOUT')), limit);
                void run.finally(() => clearTimeout(timer)).catch(() => undefined);
              }),
            ]));
      } catch (error) {
        controller.abort();
        errorCode = error instanceof Error && error.message === 'TRIAL_TIMEOUT' ? 'TRIAL_TIMEOUT' : 'DRIVER_ERROR';
        outcome = { ...FAILED, wallMs: Math.max(0, input.now() - begin) };
      } finally {
        if (sandbox !== null) await sandbox.dispose().catch(() => undefined);
      }
      const verified = outcome.completed && !outcome.abandoned && outcome.receipts.some((r) => r.passed);
      rows.push({ ...outcome, taskId: task.taskId, repository: task.repository, sliceId: task.sliceId, difficulty: task.difficulty, arm, verified, errorCode, order });
    }
  }
  return {
    ok: true,
    startedAt: new Date(startedMs).toISOString(),
    finishedAt: new Date(Math.max(startedMs + 1, input.now())).toISOString(),
    arms: [...input.arms],
    tasks: input.tasks.length,
    rows,
    postAssignmentExclusions: [],
  };
}

export interface ArmSummary {
  readonly arm: TrialArm;
  readonly tasks: number;
  readonly verified: number;
  readonly successRate: { readonly point: number; readonly lower: number; readonly upper: number };
  readonly totalCostMicroUsd: number;
  readonly estimatedCostMicroUsd: number;
  readonly costPerVerifiedTaskMicroUsd: number | null;
  readonly medianCostMicroUsd: number;
  readonly wallMsP50: number;
  readonly wallMsP95: number;
  readonly retries: number;
  readonly humanMinutes: number;
  readonly defectEscapes: number;
  readonly abandoned: number;
  readonly safetyFailures: number;
}

function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] as number;
}

export function summarizeArm(rows: readonly TrialRow[], arm: TrialArm): ArmSummary {
  const own = rows.filter((r) => r.arm === arm);
  const verified = own.filter((r) => r.verified).length;
  const total = own.reduce((s, r) => s + r.costMicroUsd, 0);
  const interval = own.length === 0 ? { point: 0, lower: 0, upper: 1 } : wilsonInterval(verified, own.length);
  return {
    arm,
    tasks: own.length,
    verified,
    successRate: { point: interval.point, lower: interval.lower, upper: interval.upper },
    totalCostMicroUsd: total,
    estimatedCostMicroUsd: own.reduce((s, r) => s + r.estimatedCostMicroUsd, 0),
    costPerVerifiedTaskMicroUsd: verified === 0 ? null : total / verified,
    medianCostMicroUsd: quantile(own.map((r) => r.costMicroUsd), 0.5),
    wallMsP50: quantile(own.map((r) => r.wallMs), 0.5),
    wallMsP95: quantile(own.map((r) => r.wallMs), 0.95),
    retries: own.reduce((s, r) => s + r.retries, 0),
    humanMinutes: own.reduce((s, r) => s + r.humanMinutes, 0),
    defectEscapes: own.filter((r) => r.defectEscaped).length,
    abandoned: own.filter((r) => r.abandoned).length,
    safetyFailures: own.reduce((s, r) => s + r.safetyFailures.length, 0),
  };
}

export interface Interval3 {
  readonly point: number;
  readonly lower: number;
  readonly upper: number;
}

export interface ArmComparison {
  readonly treatment: TrialArm;
  readonly baseline: TrialArm;
  readonly tasks: number;
  /** Paired difference in verified success rate (treatment minus baseline). */
  readonly successDifference: Interval3;
  /** Ratio of verified success rates (treatment / baseline). */
  readonly successRatio: Interval3 | null;
  /** Full cost per verified task, treatment / baseline (cost of failed runs included). */
  readonly costPerVerifiedRatio: Interval3 | null;
  /** Wall time per verified task, treatment / baseline. */
  readonly timePerVerifiedRatio: Interval3 | null;
  readonly confidence: number;
  readonly method: 'paired-bootstrap';
}

interface Pair {
  readonly t: TrialRow;
  readonly b: TrialRow;
}

function finite(value: { readonly point: number; readonly lower: number; readonly upper: number }): Interval3 | null {
  const round = (x: number) => Math.round(x * 1e6) / 1e6;
  return [value.point, value.lower, value.upper].every(Number.isFinite) ? { point: round(value.point), lower: round(value.lower), upper: round(value.upper) } : null;
}

function perVerified(pairs: readonly Pair[], pick: (r: TrialRow) => number): number {
  let tSum = 0;
  let tOk = 0;
  let bSum = 0;
  let bOk = 0;
  for (const { t, b } of pairs) {
    tSum += pick(t);
    bSum += pick(b);
    if (t.verified) tOk += 1;
    if (b.verified) bOk += 1;
  }
  if (tOk === 0 || bOk === 0 || bSum === 0) return Number.POSITIVE_INFINITY;
  return tSum / tOk / (bSum / bOk);
}

/** Paired, intent-to-treat comparison with seeded bootstrap intervals over tasks. */
export function compareArms(rows: readonly TrialRow[], treatment: TrialArm, baseline: TrialArm, options: { readonly confidence?: number; readonly seed?: number; readonly resamples?: number } = {}): ArmComparison {
  const byTask = new Map<string, { t?: TrialRow; b?: TrialRow }>();
  for (const row of rows) {
    if (row.arm !== treatment && row.arm !== baseline) continue;
    const entry = byTask.get(row.taskId) ?? {};
    if (row.arm === treatment) entry.t = row;
    else entry.b = row;
    byTask.set(row.taskId, entry);
  }
  const pairs: Pair[] = [];
  for (const entry of byTask.values()) if (entry.t !== undefined && entry.b !== undefined) pairs.push({ t: entry.t, b: entry.b });
  const confidence = options.confidence ?? 0.95;
  const boot = (statistic: (sample: readonly Pair[]) => number) =>
    pairs.length === 0 ? { point: Number.NaN, lower: Number.NaN, upper: Number.NaN } : bootstrapInterval(pairs, statistic, { confidence, seed: options.seed ?? 17, resamples: options.resamples ?? 2000 });
  const rate = (sample: readonly Pair[], side: 't' | 'b') => sample.filter((p) => p[side].verified).length / sample.length;
  const difference = boot((s) => rate(s, 't') - rate(s, 'b'));
  const ratio = boot((s) => (rate(s, 'b') === 0 ? Number.POSITIVE_INFINITY : rate(s, 't') / rate(s, 'b')));
  return {
    treatment,
    baseline,
    tasks: pairs.length,
    successDifference: finite(difference) ?? { point: 0, lower: -1, upper: 1 },
    successRatio: finite(ratio),
    costPerVerifiedRatio: finite(boot((s) => perVerified(s, (r) => r.costMicroUsd))),
    timePerVerifiedRatio: finite(boot((s) => perVerified(s, (r) => r.wallMs))),
    confidence,
    method: 'paired-bootstrap',
  };
}

/** Balance of repositories and difficulty across arms (paired design: identical by construction). */
export function armBalance(rows: readonly TrialRow[]): { readonly balanced: boolean; readonly detail: Readonly<Record<string, string>> } {
  const detail: Record<string, string> = {};
  const signature = (arm: TrialArm) => {
    const own = rows.filter((r) => r.arm === arm);
    const count = (key: (r: TrialRow) => string) => {
      const out: Record<string, number> = {};
      for (const r of own) out[key(r)] = (out[key(r)] ?? 0) + 1;
      return Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, v].join('=')).join(',');
    };
    return [count((r) => r.repository), count((r) => r.difficulty)].join('|');
  };
  const arms = [...new Set(rows.map((r) => r.arm))];
  for (const arm of arms) detail[arm] = signature(arm);
  return { balanced: new Set(Object.values(detail)).size <= 1, detail };
}

// ------------------------------------------------------------------ harness driver contract

const COST_SOURCES = ['provider-reported', 'billing-export', 'estimate'] as const;
const COMPONENTS = ['retries', 'cache', 'verification', 'human-minutes'] as const;

const count = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * The contract a product HarnessDriver's RunOutcome must meet (EVL-05). Returns the problems,
 * empty when the outcome is usable. A completed run claims verification only through receipts.
 */
export function validateRunOutcome(value: unknown): readonly string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return ['not an object'];
  const v = value as Record<string, unknown>;
  const issues: string[] = [];
  if (typeof v['completed'] !== 'boolean') issues.push('completed');
  const receipts = v['receipts'];
  if (!Array.isArray(receipts) || receipts.some((r) => r === null || typeof r !== 'object' || typeof (r as Record<string, unknown>)['id'] !== 'string' || typeof (r as Record<string, unknown>)['passed'] !== 'boolean')) issues.push('receipts');
  for (const key of ['retries', 'inputTokens', 'outputTokens', 'costMicroUsd', 'estimatedCostMicroUsd', 'wallMs', 'humanMinutes']) if (!count(v[key])) issues.push(key);
  if (!(COST_SOURCES as readonly unknown[]).includes(v['costSource'])) issues.push('costSource');
  for (const key of ['defectEscaped', 'abandoned']) if (typeof v[key] !== 'boolean') issues.push(key);
  if (!Array.isArray(v['safetyFailures']) || v['safetyFailures'].some((s) => typeof s !== 'string')) issues.push('safetyFailures');
  const measured = v['measuredComponents'];
  if (!Array.isArray(measured) || measured.some((c) => !(COMPONENTS as readonly unknown[]).includes(c)) || new Set(measured).size !== measured.length) issues.push('measuredComponents');
  if (v['costSource'] === 'estimate' && v['costMicroUsd'] !== v['estimatedCostMicroUsd']) issues.push('costMicroUsd: an estimate must equal estimatedCostMicroUsd');
  return issues;
}

export interface DriverConformance {
  readonly passed: boolean;
  readonly checks: readonly { readonly name: string; readonly passed: boolean; readonly detail: string }[];
}

/**
 * A contract test for a product HarnessDriver: one real run of `task` on each of `arms` gives a
 * valid RunOutcome in its own sandbox, and a run whose signal is aborted settles within
 * `cancelWithinMs` as not completed. It runs the driver for real; run it against a disposable
 * task, never in `npm test` with a real harness binary.
 */
export async function driverConformance(input: {
  readonly driver: HarnessDriver;
  readonly sandboxes: SandboxFactory;
  readonly task: TrialTask;
  readonly arms?: readonly TrialArm[];
  readonly cancelWithinMs?: number;
}): Promise<DriverConformance> {
  const checks: { name: string; passed: boolean; detail: string }[] = [];
  const paths = new Set<string>();
  for (const arm of input.arms ?? ['native', 'jev-routed']) {
    const sandbox = await input.sandboxes.create(input.task, arm);
    try {
      const fresh = !paths.has(sandbox.path);
      paths.add(sandbox.path);
      const outcome = await input.driver.run({ task: input.task, arm, sandbox, signal: new AbortController().signal });
      const issues = validateRunOutcome(outcome);
      checks.push({ name: `${arm}: outcome`, passed: issues.length === 0, detail: issues.join(', ') });
      checks.push({ name: `${arm}: own sandbox`, passed: fresh, detail: fresh ? '' : 'sandbox reused across arms' });
    } catch (error) {
      checks.push({ name: `${arm}: outcome`, passed: false, detail: error instanceof Error ? error.message.slice(0, 200) : 'threw' });
    } finally {
      await sandbox.dispose();
    }
  }
  const limit = input.cancelWithinMs ?? 10_000;
  const sandbox = await input.sandboxes.create(input.task, 'native');
  try {
    const controller = new AbortController();
    controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      input.driver.run({ task: input.task, arm: 'native', sandbox, signal: controller.signal }).then(
        (outcome) => ({ kind: 'outcome' as const, outcome }),
        () => ({ kind: 'threw' as const }),
      ),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), limit);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    const ok = settled.kind === 'threw' || (settled.kind === 'outcome' && settled.outcome.completed === false);
    checks.push({ name: 'cancel', passed: ok, detail: settled.kind === 'timeout' ? `did not settle within ${limit} ms` : ok ? '' : 'an aborted run reported completed' });
  } finally {
    await sandbox.dispose();
  }
  return { passed: checks.every((c) => c.passed), checks };
}
