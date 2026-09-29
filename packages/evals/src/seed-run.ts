/**
 * The owner's seed run (quality-trial plan section 3, owner decisions 2026-09-26).
 *
 * The run is 24 runs: 12 SWE-bench-Live/MultiLang tasks created after 2026-02-01, TypeScript and
 * JavaScript first with Go as a top-up, each run once on Opus 5.5 at medium and once on Sonnet 5
 * at high. The Python dataset's newest task predates the cutoff (2025-09-02), so it is not used. They run in Claude Code (`claude -p`, F's
 * `@jevris/cli/claude-worker`) under the owner's subscription login, never an API key.
 *
 * Limits:
 * - Each run is capped at $10 API-equivalent and 45 minutes.
 * - A usage-limit hit (HTTP 429) pauses until the reported reset (5 hours when none is given)
 *   and then reruns the same run. It is never retried into the limit.
 * - An access-limit hit (access limits R63-R67: F's ports report `access-limit` where they
 *   reported `usage-limit`) with a reset pauses the same way. Without a reset (credit or auth,
 *   say) nothing waits it out: the rest of that model's runs are skipped and the seed ends
 *   `stopped-access-limit`, so a rerun resumes once the owner has fixed it.
 * - Both count as limit hits, and the second hit stops the seed.
 * - An overloaded provider (`overloaded`, design 7.4 and OP-7) is retried after 30 s, 60 s and
 *   120 s; a fourth overload stops the seed (`stopped-overloaded`). It is never recorded as a
 *   result.
 *
 * - Only the owner starts it. `seedGuard` refuses:
 *   - inside `npm test` (JEVRIS_TEST, NODE_TEST_CONTEXT);
 *   - inside an agent's shell (CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, CODEX_SANDBOX and similar);
 *   - without a terminal;
 *   - with an Anthropic API key in the environment;
 *   - without JEVRIS_LIVE_HARNESS=1.
 *   The script also asks for a typed confirmation.
 * - Labels are not decided here. The runner writes predictions in the format of SWE-bench-Live's
 *   `python -m evaluation.evaluation` (microsoft/SWE-bench-Live, evaluation/README.md): one JSON
 *   object keyed by instance id, each with `model_patch`. That script runs each task's
 *   FAIL_TO_PASS and PASS_TO_PASS tests in the task's Docker image and writes `results.json`
 *   (`success_ids`, `failure_ids`, `error_ids`, `incomplete_ids`, `empty_patch_ids`).
 *   `seedPriors` turns it into priors, which are bundled only through a reviewed commit.
 * - Protocol deviation, recorded in the priors' source notes: the benchmark expects the agent to
 *   work inside the task's Docker image. This runner gives it a checkout of the repository at
 *   the base commit instead, so the result is a prior for this product's own worker setup, not a
 *   leaderboard entry.
 * - Invalid tasks: a task whose gold patch fails on the owner's machine is not a fair test of
 *   either model. `select --gold` drops such candidates before any run, so the seed stays at 24.
 *
 * Everything here is pure or runs through injected ports, so tests run with no harness, no
 * network and no billing.
 */
import { contentHash } from '@jevris/contracts';
import { bootstrapInterval } from './metrics.js';

export const SEED_PLAN = Object.freeze({
  id: 'seed:swe-bench-live-multilang@2026-09',
  dataset: 'SWE-bench-Live/MultiLang',
  revision: '3638632e8153a10ca422c1022bed79023084b5c9',
  /** Splits the tasks come from, in order of preference. */
  splits: Object.freeze(['ts', 'js']),
  /** Used only when the preferred splits leave fewer than `taskCount` repositories. */
  topUpSplits: Object.freeze(['go']),
  createdAfter: '2026-02-01T00:00:00Z',
  taskCount: 12,
  /** Candidates written for the gold-patch check, in pick order (the 12 and six spares). */
  goldCandidates: 18,
  protocolNote: 'agent in a base-commit checkout, not the task image',
  arms: Object.freeze([
    Object.freeze({ modelId: 'claude-opus-5-5', effort: 'medium' }),
    Object.freeze({ modelId: 'claude-sonnet-5', effort: 'high' }),
  ]),
  perRunUsd: 10,
  perRunMinutes: 45,
  maxTurns: 100,
  maxLimitHits: 2,
  limitFallbackHours: 5,
  authMode: 'subscription' as const,
  selectionSeed: 20260926,
  allowedTools: Object.freeze(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash']),
});

export type SeedPlan = typeof SEED_PLAN;

/** Design 7.4 (OP-7): an overloaded run is retried after 30 s x 2^n, n = 0, 1, 2; then the seed stops. */
export const SEED_OVERLOAD_RETRY = Object.freeze({ attempts: 3, baseMs: 30_000 });

export interface SeedTask {
  readonly instanceId: string;
  /** The dataset split the task came from (ts, js, go and so on). */
  readonly language: string;
  readonly repo: string;
  readonly baseCommit: string;
  readonly createdAt: string;
  readonly problemStatement: string;
}

const INSTANCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SHA = /^[0-9a-f]{40}$/;

/**
 * Reads dataset rows (the SWE-bench-Live JSONL fields); malformed rows are skipped and counted.
 * `created_at` may be an ISO string or epoch time (milliseconds, or seconds below 1e11).
 */
export function parseSeedTasks(rows: readonly unknown[], language = 'unknown'): { readonly tasks: readonly SeedTask[]; readonly skipped: number } {
  const tasks: SeedTask[] = [];
  let skipped = 0;
  for (const row of rows) {
    const r = row !== null && typeof row === 'object' ? (row as { readonly [key: string]: unknown }) : {};
    const instanceId = r['instance_id'];
    const repo = r['repo'];
    const baseCommit = r['base_commit'];
    const createdAt = r['created_at'];
    const problemStatement = r['problem_statement'];
    // `datasets`' to_json writes timestamps as epoch milliseconds; other exports use ISO strings.
    const created = typeof createdAt === 'string' ? Date.parse(createdAt) : typeof createdAt === 'number' && Number.isFinite(createdAt) ? (Math.abs(createdAt) < 1e11 ? createdAt * 1000 : createdAt) : Number.NaN;
    if (typeof instanceId !== 'string' || !INSTANCE.test(instanceId) || typeof repo !== 'string' || !REPO.test(repo) || typeof baseCommit !== 'string' || !SHA.test(baseCommit) || !Number.isFinite(created) || typeof problemStatement !== 'string' || problemStatement.trim() === '') {
      skipped += 1;
      continue;
    }
    tasks.push({ instanceId, language, repo, baseCommit, createdAt: new Date(created).toISOString(), problemStatement });
  }
  return { tasks, skipped };
}

/** The dataset fields a seed task is built from; every other column is dropped while reading. */
export const SEED_TASK_FIELDS: readonly string[] = ['instance_id', 'repo', 'base_commit', 'created_at', 'problem_statement'];

/**
 * Reads dataset rows from JSON lines one at a time (the pinned SWE-bench-Live `full` split is
 * about 550 MB, over V8's longest string). Each row keeps only `SEED_TASK_FIELDS`, so memory
 * holds the task fields, not the dataset. The result is `parseSeedTasks` of the same rows: the
 * same tasks, and so the same selection and selection hash. A line that is not JSON is skipped
 * and counted.
 */
export async function parseSeedTaskLines(lines: AsyncIterable<string> | Iterable<string>, language = 'unknown'): Promise<{ readonly tasks: readonly SeedTask[]; readonly skipped: number }> {
  const rows: { [key: string]: unknown }[] = [];
  let unparsed = 0;
  for await (const line of lines) {
    const text = line.trim();
    if (text === '') continue;
    let row: unknown;
    try {
      row = JSON.parse(text);
    } catch {
      unparsed += 1;
      continue;
    }
    const r = row !== null && typeof row === 'object' ? (row as { readonly [key: string]: unknown }) : {};
    const kept: { [key: string]: unknown } = {};
    for (const field of SEED_TASK_FIELDS) if (field in r) kept[field] = r[field];
    rows.push(kept);
  }
  const parsed = parseSeedTasks(rows, language);
  return { tasks: parsed.tasks, skipped: parsed.skipped + unparsed };
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SeedSelection {
  readonly planId: string;
  readonly dataset: string;
  readonly revision: string;
  readonly instanceIds: readonly string[];
  /** Hash of the plan id, revision and ordered instance ids; recorded before any run. */
  readonly selectionHash: string;
}

export interface SeedPick {
  readonly selection: SeedSelection;
  readonly tasks: readonly SeedTask[];
  /** Every eligible task in pick order: the preferred splits' pool, then the top-up pool. */
  readonly candidates: readonly SeedTask[];
  /** Candidates passed over because their gold patch did not pass (with `gold`). */
  readonly goldExcluded: readonly string[];
}

/**
 * The deterministic pick:
 * 1. tasks created after the cutoff, from the plan's splits and top-up splits;
 * 2. one task per repository: the first by split preference, then instance id;
 * 3. the preferred splits' repositories shuffled with the plan's seed, then the top-up ones;
 * 4. with `gold` (the ids whose gold patch passed on this machine), failing candidates are
 *    skipped;
 * 5. the first `taskCount`.
 */
export function selectSeedTasks(tasks: readonly SeedTask[], plan: SeedPlan = SEED_PLAN, gold: ReadonlySet<string> | null = null): SeedPick | { readonly error: string } {
  const cutoff = Date.parse(plan.createdAfter);
  const order: readonly string[] = [...plan.splits, ...plan.topUpSplits];
  const tier = (language: string): number => (plan.splits.includes(language) ? 0 : plan.topUpSplits.includes(language) ? 1 : -1);
  const byRepo = new Map<string, SeedTask>();
  const sorted = tasks
    .filter((t) => tier(t.language) >= 0 && Date.parse(t.createdAt) > cutoff)
    .sort((a, b) => order.indexOf(a.language) - order.indexOf(b.language) || (a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0));
  for (const t of sorted) if (!byRepo.has(t.repo)) byRepo.set(t.repo, t);
  const random = mulberry(plan.selectionSeed);
  const shuffled = (pool: SeedTask[]): SeedTask[] => {
    pool.sort((a, b) => (a.repo < b.repo ? -1 : 1));
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      const swap = pool[i] as SeedTask;
      pool[i] = pool[j] as SeedTask;
      pool[j] = swap;
    }
    return pool;
  };
  const all = [...byRepo.values()];
  const candidates = [...shuffled(all.filter((t) => tier(t.language) === 0)), ...shuffled(all.filter((t) => tier(t.language) === 1))];
  const chosen: SeedTask[] = [];
  const goldExcluded: string[] = [];
  for (const t of candidates) {
    if (chosen.length >= plan.taskCount) break;
    if (gold === null || gold.has(t.instanceId)) chosen.push(t);
    else goldExcluded.push(t.instanceId);
  }
  if (chosen.length < plan.taskCount) {
    const where = `${order.join(', ')} after ${plan.createdAfter}`;
    return { error: gold === null ? `only ${String(chosen.length)} repositories have tasks in ${where}; the plan needs ${String(plan.taskCount)}` : `only ${String(chosen.length)} candidates passed their gold patch (${where}); the plan needs ${String(plan.taskCount)}: run the gold check on more candidates` };
  }
  const instanceIds = chosen.map((t) => t.instanceId);
  const body = { planId: plan.id, dataset: plan.dataset, revision: plan.revision, instanceIds };
  return { selection: { ...body, selectionHash: contentHash(body) }, tasks: chosen, candidates, goldExcluded };
}

/** Checks a stored selection against its own hash. */
export function selectionValid(selection: SeedSelection): boolean {
  const { selectionHash, ...body } = selection;
  return Array.isArray(body.instanceIds) && contentHash({ planId: body.planId, dataset: body.dataset, revision: body.revision, instanceIds: body.instanceIds }) === selectionHash;
}

export interface SeedRunSpec {
  readonly runId: string;
  readonly instanceId: string;
  readonly modelId: string;
  readonly effort: string;
}

/** 24 runs: every task on both arms, the arm order randomised per task with the plan's seed. */
export function seedRunOrder(selection: SeedSelection, plan: SeedPlan = SEED_PLAN): readonly SeedRunSpec[] {
  const random = mulberry(plan.selectionSeed + 1);
  const out: SeedRunSpec[] = [];
  for (const instanceId of selection.instanceIds) {
    const arms = random() < 0.5 ? [...plan.arms] : [...plan.arms].reverse();
    for (const arm of arms) out.push({ runId: `${instanceId}__${arm.modelId}`, instanceId, modelId: arm.modelId, effort: arm.effort });
  }
  return out;
}

/** Environment markers of a coding agent's shell: the seed never starts from one. */
export const AGENT_ENV_MARKERS: readonly string[] = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_THREAD_ID', 'GEMINI_CLI', 'OPENCODE', 'KILO_CODE', 'CURSOR_AGENT'];

/** Why the seed must not start here, or null. The owner runs it from their own terminal. */
export function seedGuard(env: { readonly [key: string]: string | undefined }, terminal: { readonly stdin: boolean; readonly stdout: boolean }): string | null {
  if (env['JEVRIS_TEST'] !== undefined || env['NODE_TEST_CONTEXT'] !== undefined) return 'the seed run never starts from a test run';
  const agent = AGENT_ENV_MARKERS.find((k) => env[k] !== undefined && env[k] !== '');
  if (agent !== undefined) return `the seed run never starts from an agent's shell (${agent} is set); run it yourself in a terminal`;
  if (!terminal.stdin || !terminal.stdout) return 'the seed run needs an interactive terminal: the owner starts it and confirms it';
  if ((env['ANTHROPIC_API_KEY'] ?? '') !== '' || (env['ANTHROPIC_AUTH_TOKEN'] ?? '') !== '') return 'the seed runs on your Claude subscription login, not an API key: unset ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN in this shell';
  if (env['JEVRIS_LIVE_HARNESS'] !== '1') return 'the seed makes live harness runs against your plan; set JEVRIS_LIVE_HARNESS=1';
  return null;
}

/** The typed confirmation the script asks for. */
export const SEED_CONFIRMATION = 'start the seed run';

/** The task prompt: the issue text and plain instructions; no hints from the benchmark's tests. */
export function seedPrompt(task: SeedTask): string {
  return [
    `Resolve this GitHub issue in the repository ${task.repo}, which is checked out in the current directory.`,
    'Edit the source so the issue is fixed. Keep the change minimal and do not modify or add tests.',
    'When you are done, stop. Do not commit.',
    '',
    '<issue>',
    task.problemStatement.slice(0, 60_000),
    '</issue>',
  ].join('\n');
}

/** What F's claude-worker port reports (the orchestrator's WorkerRunOutcome shape). */
export interface SeedWorkerOutcome {
  readonly status: string;
  readonly reason: string;
  readonly actualModel: string | null;
  readonly costUsd: number | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadInputTokens: number; readonly cacheCreationInputTokens: number } | null;
  readonly durationMs: number;
  readonly authMode?: string;
  /** For `usage-limit` or `access-limit`: when the limit lifts (ISO), if the harness said. */
  readonly resetAt?: string;
  /** For `access-limit`: the port's classification (F's shape); only its reset is read here. */
  readonly accessLimit?: { readonly resetAtMs?: number; readonly resetBasis?: string };
}

export interface SeedPorts {
  /** A fresh checkout of the task's repository at its base commit; returns its directory. */
  prepare(task: SeedTask, spec: SeedRunSpec): Promise<{ readonly cwd: string }>;
  /** One `claude -p` run through F's claude-worker on the subscription login. */
  run(input: {
    readonly prompt: string;
    readonly model: string;
    readonly effort: string;
    readonly cwd: string;
    readonly allowedTools: readonly string[];
    readonly maxTurns: number;
    readonly maxBudgetUsd: number;
    readonly timeoutMs: number;
    readonly auth: 'subscription';
  }): Promise<SeedWorkerOutcome>;
  /** The patch the run made against the base commit (tracked and new files). */
  diff(cwd: string, baseCommit: string): Promise<string>;
  /** Appends one run record (runs.jsonl). */
  record(entry: SeedRunRecord): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(line: string): void;
  /**
   * The API-equivalent estimate from usage at list price, for a run whose worker reports no cost
   * (F's claude-worker reports `costUsd` null on a subscription). Optional.
   */
  estimateUsd?(modelId: string, usage: NonNullable<SeedWorkerOutcome['usage']>): number | null;
}

export interface SeedRunRecord {
  readonly runId: string;
  readonly instanceId: string;
  /** The task's split (language). */
  readonly language?: string;
  readonly modelId: string;
  readonly effort: string;
  readonly status: string;
  readonly reason: string;
  readonly actualModel: string | null;
  /** API-equivalent estimate on a subscription: not a charge. */
  readonly apiEquivalentUsd: number | null;
  /** What the worker reported as charged (null on a subscription). */
  readonly costUsd?: number | null;
  /** Where `apiEquivalentUsd` comes from: the worker's report, or usage at list price. */
  readonly costBasis?: 'reported' | 'list-price-estimate' | null;
  readonly usage?: SeedWorkerOutcome['usage'];
  readonly tokens: number | null;
  /** Wall time of the run. */
  readonly durationMs: number;
  readonly authMode: string;
  readonly patchBytes: number;
  readonly patch: string;
  readonly at: string;
}

export interface SeedSummary {
  readonly outcome: 'complete' | 'stopped-usage-limit' | 'stopped-access-limit' | 'stopped-overloaded';
  /** Models whose runs stopped on an access limit with no reset (`stopped-access-limit`). */
  readonly stoppedModels?: readonly string[];
  readonly runsDone: number;
  readonly runsPlanned: number;
  readonly limitHits: number;
  readonly apiEquivalentUsd: number;
  readonly tokens: number;
}

/**
 * Runs the plan in order, skipping runs already recorded. A usage-limit hit, or an access-limit
 * hit with a reset, pauses until the reset and reruns the same run; an access-limit hit without
 * one skips that model's remaining runs. The plan's second limit hit stops the seed. An overload
 * is retried a few times, then stops the seed. Neither is ever recorded as a result.
 */
export async function runSeed(input: { readonly selection: SeedSelection; readonly tasks: readonly SeedTask[]; readonly done: ReadonlySet<string>; readonly ports: SeedPorts; readonly plan?: SeedPlan }): Promise<SeedSummary> {
  const plan = input.plan ?? SEED_PLAN;
  const { ports } = input;
  const order = seedRunOrder(input.selection, plan);
  const tasks = new Map(input.tasks.map((t) => [t.instanceId, t]));
  let limitHits = 0;
  let runsDone = input.done.size;
  let usd = 0;
  let tokens = 0;
  let overloads = 0;
  const stoppedModels = new Set<string>();
  const totals = () => ({ runsDone, runsPlanned: order.length, limitHits, apiEquivalentUsd: Math.round(usd * 100) / 100, tokens });
  for (const spec of order) {
    if (input.done.has(spec.runId)) continue;
    if (stoppedModels.has(spec.modelId)) continue;
    const task = tasks.get(spec.instanceId);
    if (task === undefined) throw new Error(`task ${spec.instanceId} is not in the selection's task list`);
    for (;;) {
      const { cwd } = await ports.prepare(task, spec);
      ports.log(`run ${String(runsDone + 1)}/${String(order.length)}: ${spec.instanceId} on ${spec.modelId} (${spec.effort})`); // path-hygiene: allow a benchmark progress line, not a path
      const outcome = await ports.run({
        prompt: seedPrompt(task),
        model: spec.modelId,
        effort: spec.effort,
        cwd,
        allowedTools: plan.allowedTools,
        maxTurns: plan.maxTurns,
        maxBudgetUsd: plan.perRunUsd,
        timeoutMs: plan.perRunMinutes * 60_000,
        auth: plan.authMode,
      });
      if (outcome.status === 'overloaded') {
        // Design 7.4 (OP-7): a transient overload, never a result and never a limit hit.
        if (overloads >= SEED_OVERLOAD_RETRY.attempts) {
          ports.log(`provider overloaded ${String(overloads + 1)} times: the seed stops here (${String(runsDone)} of ${String(order.length)} runs done); rerun the same command later to resume`);
          return { outcome: 'stopped-overloaded', ...totals() };
        }
        const wait = SEED_OVERLOAD_RETRY.baseMs * 2 ** overloads;
        overloads += 1;
        ports.log(`provider overloaded: retrying the same run in ${String(wait / 1000)} s`);
        await ports.sleep(wait);
        continue;
      }
      overloads = 0;
      const accessLimited = outcome.status === 'access-limit';
      if (outcome.status === 'usage-limit' || accessLimited) {
        limitHits += 1;
        const label = accessLimited ? 'access limit' : 'usage limit';
        if (limitHits >= plan.maxLimitHits) {
          ports.log(`${label} hit ${String(limitHits)}: the seed stops here (${String(runsDone)} of ${String(order.length)} runs done); rerun the same command after the reset to resume`);
          return { outcome: accessLimited ? 'stopped-access-limit' : 'stopped-usage-limit', ...totals() };
        }
        const reported = limitReset(outcome);
        if (accessLimited && reported === null) {
          // No reset to wait for (credit, auth or another untimed class): this model stops here.
          stoppedModels.add(spec.modelId);
          ports.log(`access limit hit ${String(limitHits)} on ${spec.modelId} with no reset: its remaining runs are skipped; rerun the same command once it is fixed to resume`);
          break;
        }
        const reset = reported ?? ports.now() + plan.limitFallbackHours * 3_600_000;
        const wait = Math.max(0, reset - ports.now()) + 60_000;
        ports.log(`${label} hit ${String(limitHits)}: pausing until ${new Date(reset).toISOString()} (never retried into the limit)`);
        await ports.sleep(wait);
        continue;
      }
      const patch = await ports.diff(cwd, task.baseCommit);
      const u = outcome.usage;
      const t = u === null ? null : u.inputTokens + u.outputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens;
      const listed = outcome.costUsd !== null || u === null || ports.estimateUsd === undefined ? null : ports.estimateUsd(outcome.actualModel ?? spec.modelId, u);
      const estimated = outcome.costUsd ?? listed;
      const costBasis = outcome.costUsd !== null ? ('reported' as const) : listed !== null ? ('list-price-estimate' as const) : null;
      usd += estimated ?? 0;
      tokens += t ?? 0;
      await ports.record({
        runId: spec.runId,
        instanceId: spec.instanceId,
        language: task.language,
        modelId: spec.modelId,
        effort: spec.effort,
        status: outcome.status,
        reason: outcome.reason.slice(0, 500),
        actualModel: outcome.actualModel,
        apiEquivalentUsd: estimated,
        costUsd: outcome.costUsd,
        costBasis,
        usage: u,
        tokens: t,
        durationMs: outcome.durationMs,
        authMode: outcome.authMode ?? 'unknown',
        patchBytes: patch.length,
        patch,
        at: new Date(ports.now()).toISOString(),
      });
      runsDone += 1;
      break;
    }
  }
  if (stoppedModels.size > 0) return { outcome: 'stopped-access-limit', stoppedModels: [...stoppedModels].sort(), ...totals() };
  return { outcome: 'complete', ...totals() };
}

/** A limit's reported reset: the ISO `resetAt`, else an access finding's reset; null when neither. */
function limitReset(outcome: SeedWorkerOutcome): number | null {
  if (outcome.resetAt !== undefined && Number.isFinite(Date.parse(outcome.resetAt))) return Date.parse(outcome.resetAt);
  const ms = outcome.accessLimit?.resetAtMs;
  return typeof ms === 'number' && Number.isSafeInteger(ms) && ms >= 0 && outcome.accessLimit?.resetBasis !== 'none' ? ms : null;
}

/**
 * One model's prediction file for `python -m evaluation.evaluation --patch_dir <file>`: a JSON
 * object keyed by instance id, each entry with `model_patch` (the evaluator reads only that).
 */
export function seedPredictions(records: readonly SeedRunRecord[], modelId: string): { readonly [instanceId: string]: { readonly model_patch: string; readonly model_name_or_path: string } } {
  const out: { [instanceId: string]: { readonly model_patch: string; readonly model_name_or_path: string } } = {};
  for (const r of records) if (r.modelId === modelId) out[r.instanceId] = { model_patch: r.patch, model_name_or_path: `jevris-seed-${modelId}` };
  return out;
}

export interface SeedPrior {
  readonly priorSliceId: 'issue-fix';
  readonly modelId: string;
  readonly effort: string;
  readonly successRate: number;
  readonly successes: number;
  readonly trials: number;
  readonly benchmark: string;
  readonly harness: 'claude-code';
  readonly sourceId: string;
  readonly url: string;
  readonly publishedOn: string;
  readonly fetchedOn: string;
  readonly meanTokens: number | null;
  readonly meanApiEquivalentUsd: number | null;
  /** The seed's task selection hash (selection.json), when given. */
  readonly selectionHash: string | null;
  /** `seedRunsHash` of the run records the prior was computed from. */
  readonly runsHash: string;
}

/** The content hash of the run records, in file order (runs.jsonl parsed line by line). */
export function seedRunsHash(records: readonly SeedRunRecord[]): string {
  return contentHash(records);
}

/**
 * Priors from the recorded runs and the benchmark evaluation's resolved ids (one report per
 * model). A run the evaluation did not resolve, including an empty patch or a capped run, is a
 * failure. Intent-to-treat: every recorded run counts.
 */
export function seedPriors(records: readonly SeedRunRecord[], resolvedByModel: { readonly [modelId: string]: readonly string[] }, on: string, plan: SeedPlan = SEED_PLAN, selectionHash: string | null = null): readonly SeedPrior[] {
  const runsHash = seedRunsHash(records);
  return plan.arms.map((arm) => {
    const runs = records.filter((r) => r.modelId === arm.modelId);
    const resolved = new Set(resolvedByModel[arm.modelId] ?? []);
    const ok = runs.filter((r) => resolved.has(r.instanceId)).length;
    const toks = runs.map((r) => r.tokens).filter((x): x is number => x !== null);
    const usd = runs.map((r) => r.apiEquivalentUsd).filter((x): x is number => x !== null);
    return {
      priorSliceId: 'issue-fix' as const,
      modelId: arm.modelId,
      effort: arm.effort,
      successRate: runs.length === 0 ? 0 : Math.round((ok / runs.length) * 10_000) / 10_000,
      successes: ok,
      trials: runs.length,
      benchmark: `${plan.dataset.split('/')[1] ?? plan.dataset}@${plan.revision.slice(0, 8)} (${languagesOf(runs, plan)}; after ${plan.createdAfter.slice(0, 10)}; ${plan.protocolNote})`,
      harness: 'claude-code' as const,
      sourceId: plan.id,
      url: `https://huggingface.co/datasets/${plan.dataset}`,
      publishedOn: on,
      fetchedOn: on,
      meanTokens: toks.length === 0 ? null : Math.round(toks.reduce((s, x) => s + x, 0) / toks.length),
      meanApiEquivalentUsd: usd.length === 0 ? null : Math.round((usd.reduce((s, x) => s + x, 0) / usd.length) * 100) / 100,
      selectionHash,
      runsHash,
    };
  });
}

function languagesOf(runs: readonly SeedRunRecord[], plan: SeedPlan): string {
  const seen = [...new Set(runs.map((r) => r.language).filter((x): x is string => typeof x === 'string'))];
  const order: readonly string[] = [...plan.splits, ...plan.topUpSplits];
  return (seen.length === 0 ? [...plan.splits] : seen.sort((a, b) => order.indexOf(a) - order.indexOf(b))).join(', ');
}

function stringList(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((x) => typeof x === 'string') ? (value as string[]) : null;
}

/**
 * What an evaluation report says. SWE-bench-Live's `results.json` has `success_ids`,
 * `failure_ids`, `empty_patch_ids` (failures), and `error_ids` and `incomplete_ids` (not
 * scored: the evaluation did not finish, which says nothing about the model). An older
 * SWE-bench report with `resolved_ids` (or `resolved`) is read too, with no submitted list.
 */
export interface SeedEvaluation {
  readonly resolved: readonly string[];
  readonly unscored: readonly string[];
  /** Every instance the evaluator was given; null for a report that does not list them. */
  readonly submitted: readonly string[] | null;
}

export function seedEvaluationOf(report: unknown): SeedEvaluation | null {
  const r = report !== null && typeof report === 'object' ? (report as { readonly [key: string]: unknown }) : null;
  if (r === null) return null;
  const success = stringList(r['success_ids']);
  if (success !== null) {
    const unscored = [...(stringList(r['error_ids']) ?? []), ...(stringList(r['incomplete_ids']) ?? [])];
    return { resolved: success, unscored, submitted: stringList(r['submitted_ids']) };
  }
  const resolved = stringList(r['resolved_ids'] ?? r['resolved']);
  return resolved === null ? null : { resolved, unscored: [], submitted: null };
}

/** Reads the resolved ids from an evaluation report (`success_ids`, `resolved_ids` or `resolved`). */
export function resolvedIdsOf(report: unknown): readonly string[] | null {
  return seedEvaluationOf(report)?.resolved ?? null;
}

/**
 * Why a model's report cannot score its recorded runs, or null: a run the evaluator was not
 * given, or one it did not finish (error or incomplete). Such a run must not count as a failure.
 */
export function seedEvaluationProblem(records: readonly SeedRunRecord[], modelId: string, evaluation: SeedEvaluation): string | null {
  const ids = records.filter((r) => r.modelId === modelId).map((r) => r.instanceId);
  const unscored = ids.filter((id) => evaluation.unscored.includes(id));
  if (unscored.length > 0) return `the evaluation of ${modelId} did not finish ${unscored.join(', ')}; rerun it with --overwrite 0 to complete those`;
  const submitted = evaluation.submitted;
  const missing = submitted === null ? [] : ids.filter((id) => !submitted.includes(id));
  if (missing.length > 0) return `the evaluation of ${modelId} was not given ${missing.join(', ')}; evaluate predictions-${modelId}.json`;
  return null;
}

/** Worker statuses that mean the run hit a per-run cap (budget, wall time or turns). */
export const SEED_CAP_STATUSES: readonly string[] = ['budget-exceeded', 'timeout', 'max-turns'];

export interface SeedArmCost {
  readonly usd: number | null;
  readonly tokens: number | null;
  readonly durationMs: number;
  readonly status: string;
  readonly verified: boolean | null;
  readonly costBasis: 'reported' | 'list-price-estimate' | null;
  readonly authMode: string;
}

export interface SeedArmSummary {
  readonly modelId: string;
  readonly effort: string;
  readonly runs: number;
  /** Runs the benchmark's evaluation resolved; null without the reports. */
  readonly verified: number | null;
  readonly capHits: number;
  readonly authModes: { readonly [mode: string]: number };
  readonly costBases: { readonly [basis: string]: number };
  readonly totalUsd: number | null;
  readonly meanUsd: number | null;
  readonly totalTokens: number | null;
  readonly meanTokens: number | null;
  readonly meanDurationMs: number;
  /** Total API-equivalent dollars per verified run; null with none verified or no reports. */
  readonly usdPerVerified: number | null;
  readonly tokensPerVerified: number | null;
  readonly durationMsPerVerified: number | null;
}

export interface SeedDifference {
  readonly point: number;
  readonly lower: number;
  readonly upper: number;
  /** Tasks with the quantity on both arms. */
  readonly n: number;
}

export interface SeedEconomics {
  readonly planId: string;
  readonly selectionHash: string | null;
  readonly runsHash: string;
  readonly tasks: number;
  readonly runs: number;
  /**
   * On a subscription every dollar figure is the API-equivalent estimate from usage at list price
   * (`costBasis` says so per run), not a charge. Verification is the benchmark's own harness: it
   * uses no model and is the same for both arms, so it is not in these figures.
   */
  readonly note: string;
  readonly baseline: SeedArmSummary;
  readonly candidate: SeedArmSummary;
  readonly pairs: readonly { readonly instanceId: string; readonly baseline: SeedArmCost; readonly candidate: SeedArmCost }[];
  /** Candidate minus baseline per task, 95% bootstrap over tasks (seed = the plan's seed). */
  readonly pairedDifference: { readonly usd: SeedDifference | null; readonly tokens: SeedDifference | null; readonly durationMs: SeedDifference | null };
}

function roundTo(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/**
 * The release economics evidence from the seed (owner decision 2026-09-26): cost, tokens and
 * wall time, baseline arm (the plan's first, Opus 5.5 at medium) against the candidate (Sonnet 5
 * at high), paired on the same tasks. With the evaluation reports each run also says whether it
 * was verified, and each arm gets its cost per verified run.
 */
export function seedEconomics(records: readonly SeedRunRecord[], options: { readonly selectionHash?: string | null; readonly resolvedByModel?: { readonly [modelId: string]: readonly string[] }; readonly plan?: SeedPlan } = {}): SeedEconomics {
  const plan = options.plan ?? SEED_PLAN;
  const [baseArm, candArm] = plan.arms as unknown as readonly [SeedPlan['arms'][number], SeedPlan['arms'][number]];
  const resolved = options.resolvedByModel;
  const costOf = (r: SeedRunRecord): SeedArmCost => ({
    usd: r.apiEquivalentUsd,
    tokens: r.tokens,
    durationMs: r.durationMs,
    status: r.status,
    verified: resolved === undefined ? null : (resolved[r.modelId] ?? []).includes(r.instanceId),
    costBasis: r.costBasis ?? (r.apiEquivalentUsd === null ? null : 'reported'),
    authMode: r.authMode,
  });
  const summary = (arm: SeedPlan['arms'][number]): SeedArmSummary => {
    const runs = records.filter((r) => r.modelId === arm.modelId);
    const costs = runs.map(costOf);
    const count = (values: readonly string[]) => values.reduce<{ [k: string]: number }>((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {});
    const usd = costs.map((c) => c.usd).filter((x): x is number => x !== null);
    const tokens = costs.map((c) => c.tokens).filter((x): x is number => x !== null);
    const verified = resolved === undefined ? null : costs.filter((c) => c.verified === true).length;
    const totalUsd = usd.length === 0 ? null : roundTo(usd.reduce((s, x) => s + x, 0), 2);
    const totalTokens = tokens.length === 0 ? null : tokens.reduce((s, x) => s + x, 0);
    const totalMs = costs.reduce((s, c) => s + c.durationMs, 0);
    const per = (total: number | null, places: number) => (total === null || verified === null || verified === 0 ? null : roundTo(total / verified, places));
    return {
      modelId: arm.modelId,
      effort: arm.effort,
      runs: runs.length,
      verified,
      capHits: runs.filter((r) => SEED_CAP_STATUSES.includes(r.status)).length,
      authModes: count(costs.map((c) => c.authMode)),
      costBases: count(costs.map((c) => c.costBasis ?? 'none')),
      totalUsd,
      meanUsd: usd.length === 0 ? null : roundTo(usd.reduce((s, x) => s + x, 0) / usd.length, 2),
      totalTokens,
      meanTokens: tokens.length === 0 ? null : Math.round(tokens.reduce((s, x) => s + x, 0) / tokens.length),
      meanDurationMs: costs.length === 0 ? 0 : Math.round(totalMs / costs.length),
      usdPerVerified: per(totalUsd, 2),
      tokensPerVerified: per(totalTokens, 0),
      durationMsPerVerified: per(costs.length === 0 ? null : totalMs, 0),
    };
  };
  const byTask = new Map<string, { baseline?: SeedRunRecord; candidate?: SeedRunRecord }>();
  for (const r of records) {
    const entry = byTask.get(r.instanceId) ?? {};
    if (r.modelId === baseArm.modelId) entry.baseline = r;
    else if (r.modelId === candArm.modelId) entry.candidate = r;
    byTask.set(r.instanceId, entry);
  }
  const pairs = [...byTask.entries()]
    .filter((e): e is [string, { baseline: SeedRunRecord; candidate: SeedRunRecord }] => e[1].baseline !== undefined && e[1].candidate !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([instanceId, p]) => ({ instanceId, baseline: costOf(p.baseline), candidate: costOf(p.candidate) }));
  const difference = (pick: (c: SeedArmCost) => number | null, places: number): SeedDifference | null => {
    const deltas = pairs.map((p) => [pick(p.candidate), pick(p.baseline)] as const).filter((d): d is readonly [number, number] => d[0] !== null && d[1] !== null).map(([c, b]) => c - b);
    if (deltas.length === 0) return null;
    const mean = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const ci = bootstrapInterval(deltas, mean, { seed: plan.selectionSeed });
    return { point: roundTo(ci.point, places), lower: roundTo(ci.lower, places), upper: roundTo(ci.upper, places), n: deltas.length };
  };
  return {
    planId: plan.id,
    selectionHash: options.selectionHash ?? null,
    runsHash: seedRunsHash(records),
    tasks: new Set(records.map((r) => r.instanceId)).size,
    runs: records.length,
    note: 'Dollar figures on a subscription are API-equivalent estimates from usage at list price, not charges. Verification is the benchmark harness (no model usage, the same for both arms) and is not included.',
    baseline: summary(baseArm),
    candidate: summary(candArm),
    pairs,
    pairedDifference: { usd: difference((c) => c.usd, 4), tokens: difference((c) => c.tokens, 0), durationMs: difference((c) => c.durationMs, 0) },
  };
}
