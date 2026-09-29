/**
 * The product HarnessDriver for the EVL-05 trial runner (`runTrial` in @jevris/evals, §18.4,
 * RLS-08, RLS-09). It meets that interface structurally, so the CLI does not depend on the evals
 * package.
 *
 * One run = one trial task under one arm, in the sandbox runTrial made, with a fresh temporary
 * profile as HOME. The driver:
 * - picks the model for the arm (default, the pre-registered static table, or `jevris route`);
 * - applies only that arm's Jevris components (routing, memory, log reduction), or the
 *   installed product for the rules-only and jev-routed arms;
 * - runs the harness through a HarnessRunner (the Claude Agent SDK is the primary one);
 * - then runs the task's own check commands in the sandbox. Each check is one receipt, so
 *   "verified" always means an independent command passed, never the model's word.
 *
 * Cost and tokens come from what the harness reports ('provider-reported'). When it reports
 * none, they are an estimate from the pre-registered price table, at the most expensive listed
 * rate when the model is not in it, and labelled 'estimate'. Human minutes are not measured
 * (0, and 'human-minutes' is never in measuredComponents).
 *
 * An arm the driver cannot really apply is refused before the trial by `unsupportedArms`. It
 * never runs as a look-alike of another arm, and it is never left to throw inside `run`, where
 * runTrial would count it as a failed task.
 */
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCaptured } from './live-harness.js';

// ------------------------------------------------------------------------ the trial interface

export const DRIVER_ARMS = ['native', 'static', 'rules-only', 'jev-routed', 'generative', 'routing-only', 'memory-only', 'log-reduction-only', 'combined'] as const;
export type DriverArm = (typeof DRIVER_ARMS)[number];

export interface DriverTask {
  readonly taskId: string;
  readonly repository: string;
  readonly sliceId: string;
  readonly difficulty: 'easy' | 'medium' | 'hard';
}

export interface DriverSandbox {
  readonly path: string;
}

/** The RunOutcome runTrial reads (see validateRunOutcome in @jevris/evals). */
export interface DriverOutcome {
  readonly completed: boolean;
  readonly receipts: readonly { readonly id: string; readonly passed: boolean }[];
  readonly retries: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicroUsd: number;
  readonly costSource: 'provider-reported' | 'billing-export' | 'estimate';
  readonly estimatedCostMicroUsd: number;
  readonly wallMs: number;
  readonly humanMinutes: number;
  readonly defectEscaped: boolean;
  readonly abandoned: boolean;
  readonly safetyFailures: readonly string[];
  readonly measuredComponents: readonly ('retries' | 'cache' | 'verification' | 'human-minutes')[];
}

export interface TrialHarnessDriver {
  run(input: { readonly task: DriverTask; readonly arm: DriverArm; readonly sandbox: DriverSandbox; readonly signal: AbortSignal }): Promise<DriverOutcome>;
}

// ------------------------------------------------------------------------------- arm plans

export type TrialComponent = 'routing' | 'memory' | 'log-reduction';

export interface ArmPlan {
  /** Jevris installed into the harness (plugin, hooks and MCP), as a user would have it. */
  readonly product: boolean;
  /** Where Jevris decisions come from: none, rules only (no sidecar, no Jev key), or Jev. */
  readonly decisions: 'none' | 'rules' | 'jev';
  readonly model: 'default' | 'static' | 'routed';
  /** Components the driver applies itself (ablations). */
  readonly components: readonly TrialComponent[];
}

/**
 * What each arm means. `generative` has no plan: the driver has no generative decision layer to
 * run, so the arm is refused.
 */
export const ARM_PLANS: Readonly<Record<DriverArm, ArmPlan | null>> = {
  native: { product: false, decisions: 'none', model: 'default', components: [] },
  static: { product: false, decisions: 'none', model: 'static', components: [] },
  'rules-only': { product: true, decisions: 'rules', model: 'routed', components: [] },
  'jev-routed': { product: true, decisions: 'jev', model: 'routed', components: [] },
  generative: null,
  'routing-only': { product: false, decisions: 'jev', model: 'routed', components: ['routing'] },
  'memory-only': { product: false, decisions: 'jev', model: 'default', components: ['memory'] },
  'log-reduction-only': { product: false, decisions: 'jev', model: 'default', components: ['log-reduction'] },
  combined: { product: false, decisions: 'jev', model: 'routed', components: ['routing', 'memory', 'log-reduction'] },
};

// --------------------------------------------------------------------------- trial config

export const TRIAL_CONFIG_SCHEMA = 'jevris.trial-config/1';
export const TRIAL_HARNESSES = ['claude-sdk', 'claude', 'kilocode', 'opencode', 'codex', 'antigravity'] as const;
export type TrialHarness = (typeof TRIAL_HARNESSES)[number];

export interface TrialCheck {
  readonly id: string;
  /** Run with shell false in the sandbox; exit 0 passes. */
  readonly argv: readonly string[];
}

export interface TrialTaskSpec {
  readonly taskId: string;
  readonly prompt: string;
  readonly constraints: readonly string[];
  readonly checks: readonly TrialCheck[];
}

export interface TrialPrice {
  readonly inputPerMTokUsd: number;
  readonly outputPerMTokUsd: number;
}

/** The pre-registered trial configuration: pinned in the pre-registration before any run. */
export interface TrialConfig {
  readonly schema: typeof TRIAL_CONFIG_SCHEMA;
  readonly harness: TrialHarness;
  readonly defaultModel: string;
  /** The static routing arm's table. Never taken from Jevris. */
  readonly staticModels: { readonly easy: string; readonly medium: string; readonly hard: string };
  readonly allowedTools: readonly string[];
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  readonly runTimeoutMs: number;
  readonly checkTimeoutMs: number;
  /** Extra arguments for a CLI harness (for example its non-interactive permission flag). */
  readonly extraArgs: readonly string[];
  readonly prices: { readonly [model: string]: TrialPrice };
  readonly tasks: readonly TrialTaskSpec[];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/\-[\]]{0,127}$/;

function rec(value: unknown): { readonly [key: string]: unknown } | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as { readonly [key: string]: unknown }) : null;
}

function strings(value: unknown, max: number, each: number): string[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  return value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= each) ? (value as string[]) : null;
}

function positive(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max;
}

/** Validates a trial config. Every problem is listed; the config is returned only when there are none. */
export function parseTrialConfig(value: unknown): { readonly ok: true; readonly config: TrialConfig } | { readonly ok: false; readonly problems: readonly string[] } {
  const problems: string[] = [];
  const v = rec(value);
  if (v === null) return { ok: false, problems: ['the trial config is not a JSON object'] };
  if (v['schema'] !== TRIAL_CONFIG_SCHEMA) problems.push(`schema must be ${TRIAL_CONFIG_SCHEMA}`);
  if (!(TRIAL_HARNESSES as readonly unknown[]).includes(v['harness'])) problems.push(`harness must be one of ${TRIAL_HARNESSES.join(', ')}`);
  const model = (key: string, raw: unknown): void => {
    if (typeof raw !== 'string' || !MODEL.test(raw)) problems.push(`${key} must be a model id`);
  };
  model('defaultModel', v['defaultModel']);
  const table = rec(v['staticModels']);
  if (table === null) problems.push('staticModels must give a model for easy, medium and hard');
  else for (const level of ['easy', 'medium', 'hard']) model(`staticModels.${level}`, table[level]);
  const tools = strings(v['allowedTools'], 32, 64);
  if (tools === null) problems.push('allowedTools must be a list of tool names');
  if (!Number.isInteger(v['maxTurns']) || !positive(v['maxTurns'], 500)) problems.push('maxTurns must be an integer from 1 to 500');
  if (!positive(v['maxBudgetUsd'], 1_000)) problems.push('maxBudgetUsd must be above 0 and at most 1000');
  if (!Number.isInteger(v['runTimeoutMs']) || !positive(v['runTimeoutMs'], 24 * 3_600_000) || (v['runTimeoutMs'] as number) < 1_000) problems.push('runTimeoutMs must be an integer from 1000 to 86400000');
  if (!Number.isInteger(v['checkTimeoutMs']) || !positive(v['checkTimeoutMs'], 3_600_000)) problems.push('checkTimeoutMs must be an integer up to 3600000');
  const extra = v['extraArgs'] === undefined ? [] : strings(v['extraArgs'], 16, 200);
  if (extra === null) problems.push('extraArgs must be a list of arguments');
  const prices = rec(v['prices']);
  if (prices === null || Object.keys(prices).length === 0) problems.push('prices must give an input and output price per million tokens for at least one model');
  else
    for (const [name, price] of Object.entries(prices)) {
      const p = rec(price);
      if (!MODEL.test(name) || p === null || !positive(p['inputPerMTokUsd'], 10_000) || !positive(p['outputPerMTokUsd'], 10_000)) problems.push(`prices.${name.slice(0, 64)} needs inputPerMTokUsd and outputPerMTokUsd above 0`);
    }
  const tasks: TrialTaskSpec[] = [];
  if (!Array.isArray(v['tasks']) || v['tasks'].length === 0) problems.push('tasks must be a non-empty list');
  else {
    const seen = new Set<string>();
    for (const [i, raw] of (v['tasks'] as unknown[]).entries()) {
      const t = rec(raw);
      const where = `tasks[${String(i)}]`;
      if (t === null) {
        problems.push(`${where} is not an object`);
        continue;
      }
      const taskId = t['taskId'];
      if (typeof taskId !== 'string' || !ID.test(taskId)) problems.push(`${where}.taskId must be an id`);
      else if (seen.has(taskId)) problems.push(`${where}.taskId ${taskId} is listed twice`);
      else seen.add(taskId);
      if (typeof t['prompt'] !== 'string' || t['prompt'].length === 0 || t['prompt'].length > 100_000) problems.push(`${where}.prompt must be 1 to 100000 characters`);
      const constraints = t['constraints'] === undefined ? [] : strings(t['constraints'], 64, 1_000);
      if (constraints === null) problems.push(`${where}.constraints must be a list of text`);
      const checks: TrialCheck[] = [];
      if (!Array.isArray(t['checks']) || t['checks'].length === 0 || t['checks'].length > 32) problems.push(`${where}.checks must list 1 to 32 checks`);
      else
        for (const [j, c] of (t['checks'] as unknown[]).entries()) {
          const check = rec(c);
          const argv = check === null ? null : strings(check['argv'], 64, 4_096);
          if (check === null || typeof check['id'] !== 'string' || !ID.test(check['id']) || argv === null || argv.length === 0) problems.push(`${where}.checks[${String(j)}] needs an id and a non-empty argv`);
          else checks.push({ id: check['id'], argv });
        }
      if (typeof taskId === 'string' && typeof t['prompt'] === 'string') tasks.push({ taskId, prompt: t['prompt'], constraints: constraints ?? [], checks });
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    config: {
      schema: TRIAL_CONFIG_SCHEMA,
      harness: v['harness'] as TrialHarness,
      defaultModel: v['defaultModel'] as string,
      staticModels: { easy: table?.['easy'] as string, medium: table?.['medium'] as string, hard: table?.['hard'] as string },
      allowedTools: tools ?? [],
      maxTurns: v['maxTurns'] as number,
      maxBudgetUsd: v['maxBudgetUsd'] as number,
      runTimeoutMs: v['runTimeoutMs'] as number,
      checkTimeoutMs: v['checkTimeoutMs'] as number,
      extraArgs: extra ?? [],
      prices: prices as { readonly [model: string]: TrialPrice },
      tasks,
    },
  };
}

// ------------------------------------------------------------------------ runner and ports

/** A shell tool whose output the model sees through Jevris log reduction. */
export interface ShellTool {
  run(command: string, signal: AbortSignal): Promise<string>;
}

export interface HarnessRunInput {
  readonly prompt: string;
  readonly model: string;
  readonly cwd: string;
  /** The run's temporary profile (HOME). */
  readonly home: string;
  readonly env: { readonly [key: string]: string };
  readonly allowedTools: readonly string[];
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  readonly timeoutMs: number;
  readonly extraArgs: readonly string[];
  readonly signal: AbortSignal;
  /** The installed Jevris plugin folder in `home`, for product arms. */
  readonly plugin: string | null;
  /** Replaces the harness shell tool with a log-reduced one (log-reduction component). */
  readonly shellTool: ShellTool | null;
}

export interface HarnessRunReport {
  readonly status: 'completed' | 'failed' | 'max-turns' | 'budget-exceeded' | 'aborted' | 'timeout' | 'unsupported' | 'refused';
  readonly reason: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Cache reads and writes, when the harness reports them. */
  readonly cacheTokens: number;
  /** What the harness reported for the whole session (retries and cache included), else null. */
  readonly costUsd: number | null;
  /** API retries the harness reported, else null when it does not say. */
  readonly retries: number | null;
  readonly actualModel: string | null;
  /** The auth mode the run used, when the runner knows it (never a key or token value). */
  readonly authMode?: 'api-key' | 'subscription';
}

export interface HarnessRunner {
  readonly harness: TrialHarness;
  /** Why this runner cannot apply the plan, or null when it can. */
  unsupported(plan: ArmPlan): string | null;
  run(input: HarnessRunInput): Promise<HarnessRunReport>;
}

export interface JevrisPrepared {
  /** A profile folder copied as each run's HOME. */
  readonly seed: string;
  /** The installed plugin folder, relative to the profile, for product arms. */
  readonly pluginRel: string | null;
}

/** The Jevris product surfaces the driver calls. `trial-jevris.ts` has the product implementation. */
export interface JevrisPort {
  /** Called once per distinct (product, decisions) pair before the first run that needs it. */
  prepare(input: { readonly product: boolean; readonly decisions: ArmPlan['decisions'] }): Promise<{ readonly ok: true; readonly prepared: JevrisPrepared } | { readonly ok: false; readonly reason: string }>;
  /** The environment a run's harness gets for this profile. */
  env(home: string, decisions: ArmPlan['decisions']): { readonly [key: string]: string };
  /** `jevris route`: the recommended main model, or null to keep the current one. */
  route(input: { readonly home: string; readonly cwd: string; readonly taskId: string; readonly currentModel: string; readonly decisions: ArmPlan['decisions'] }): Promise<string | null>;
  /** `jevris checkpoint`: the capsule text to put before the prompt, or null when there is none. */
  capsule(input: { readonly home: string; readonly cwd: string; readonly taskId: string; readonly objective: string; readonly constraints: readonly string[]; readonly decisions: ArmPlan['decisions'] }): Promise<string | null>;
  /** A shell tool whose output goes through the product's tool-output distillation (C22). */
  shellTool(input: { readonly home: string; readonly cwd: string; readonly env: { readonly [key: string]: string } }): ShellTool;
}

/** Runs one check; the default runs argv with shell false in the sandbox. */
export type CheckRunner = (check: TrialCheck, input: { readonly cwd: string; readonly env: { readonly [key: string]: string }; readonly timeoutMs: number; readonly signal: AbortSignal }) => Promise<boolean>;

export const defaultCheckRunner: CheckRunner = async (check, input) => {
  const [file, ...args] = check.argv;
  if (file === undefined) return false;
  const ran = await runCaptured(file, args, { cwd: input.cwd, env: input.env, timeoutMs: input.timeoutMs, signal: input.signal });
  return ran.spawned && !ran.timedOut && !ran.aborted && ran.code === 0;
};

// ----------------------------------------------------------------------------- the driver

export interface UnsupportedArm {
  readonly arm: string;
  readonly reason: string;
}

/**
 * Arms this driver cannot really run with this runner and environment. Call it before
 * runTrial and refuse the trial when it is not empty. Jev decisions need JEVRIS_LIVE_JEV=1,
 * and every run needs JEVRIS_LIVE_HARNESS=1 unless the runner is injected (tests).
 */
export function unsupportedArms(arms: readonly string[], runner: HarnessRunner, env: { readonly [key: string]: string | undefined } = process.env): readonly UnsupportedArm[] {
  const out: UnsupportedArm[] = [];
  for (const arm of arms) {
    const plan = (DRIVER_ARMS as readonly string[]).includes(arm) ? ARM_PLANS[arm as DriverArm] : null;
    if (plan === null) {
      out.push({ arm, reason: arm === 'generative' ? 'the driver has no generative decision layer to run' : 'not a trial arm' });
      continue;
    }
    if (plan.decisions === 'jev' && env['JEVRIS_LIVE_JEV'] !== '1') {
      out.push({ arm, reason: 'Jev decisions are a billed live call; set JEVRIS_LIVE_JEV=1' });
      continue;
    }
    const why = runner.unsupported(plan);
    if (why !== null) out.push({ arm, reason: why });
  }
  return out;
}

/** Task ids runTrial will ask for that the config does not describe. */
export function missingTaskSpecs(tasks: readonly { readonly taskId: string }[], config: TrialConfig): readonly string[] {
  const known = new Set(config.tasks.map((t) => t.taskId));
  return tasks.map((t) => t.taskId).filter((id) => !known.has(id));
}

/** Which components and model a run used, for the trial report (RLS-08 known limitations). */
export interface RunNote {
  readonly taskId: string;
  readonly arm: DriverArm;
  readonly model: string;
  readonly actualModel: string | null;
  readonly components: readonly TrialComponent[];
  readonly product: boolean;
  readonly decisions: ArmPlan['decisions'];
  readonly status: HarnessRunReport['status'];
  readonly reason: string;
  readonly costSource: DriverOutcome['costSource'];
}

export interface CreateTrialDriverInput {
  readonly config: TrialConfig;
  readonly runner: HarnessRunner;
  readonly jevris: JevrisPort;
  readonly checks?: CheckRunner;
  readonly now?: () => number;
  /** Receives one note per run. */
  readonly onRun?: (note: RunNote) => void;
  /** Where run profiles are made; default the OS temp folder. */
  readonly tempRoot?: string;
}

function micro(usd: number): number {
  return Math.max(0, Math.round(usd * 1_000_000));
}

function estimateMicroUsd(config: TrialConfig, model: string, inputTokens: number, outputTokens: number): number {
  const listed = config.prices[model];
  const all = Object.values(config.prices);
  const price: TrialPrice = listed ?? {
    inputPerMTokUsd: Math.max(...all.map((p) => p.inputPerMTokUsd)),
    outputPerMTokUsd: Math.max(...all.map((p) => p.outputPerMTokUsd)),
  };
  return micro((inputTokens * price.inputPerMTokUsd + outputTokens * price.outputPerMTokUsd) / 1_000_000);
}

function count(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export function createTrialDriver(input: CreateTrialDriverInput): TrialHarnessDriver {
  const { config, runner, jevris } = input;
  const now = input.now ?? Date.now;
  const checks = input.checks ?? defaultCheckRunner;
  const specs = new Map(config.tasks.map((t) => [t.taskId, t]));
  const prepared = new Map<string, Promise<{ readonly ok: true; readonly prepared: JevrisPrepared } | { readonly ok: false; readonly reason: string }>>();
  const prepare = (plan: ArmPlan) => {
    const key = `${String(plan.product)}:${plan.decisions}`;
    let entry = prepared.get(key);
    if (entry === undefined) {
      entry = jevris.prepare({ product: plan.product, decisions: plan.decisions });
      prepared.set(key, entry);
    }
    return entry;
  };
  return {
    async run({ task, arm, sandbox, signal }) {
      const begin = now();
      const spec = specs.get(task.taskId);
      if (spec === undefined) throw new Error(`TASK_SPEC_MISSING ${task.taskId}`);
      const plan = ARM_PLANS[arm];
      if (plan === null || plan === undefined) throw new Error(`ARM_UNSUPPORTED ${arm}`);
      const why = runner.unsupported(plan);
      if (why !== null) throw new Error(`ARM_UNSUPPORTED ${arm}: ${why}`);
      const ready = await prepare(plan);
      if (!ready.ok) throw new Error(`PREPARE_FAILED ${arm}: ${ready.reason}`);
      const home = await mkdtemp(join(input.tempRoot ?? tmpdir(), 'jevris-trial-run-'));
      try {
        await cp(ready.prepared.seed, home, { recursive: true });
        const env = jevris.env(home, plan.decisions);
        const components: TrialComponent[] = [];
        let model = plan.model === 'static' ? config.staticModels[task.difficulty] : config.defaultModel;
        if (plan.model === 'routed' && !signal.aborted) {
          const routed = await jevris.route({ home, cwd: sandbox.path, taskId: task.taskId, currentModel: config.defaultModel, decisions: plan.decisions });
          if (routed !== null) model = routed;
          if (plan.components.includes('routing')) components.push('routing');
        }
        let prompt = spec.prompt;
        if (plan.components.includes('memory') && !signal.aborted) {
          const capsule = await jevris.capsule({ home, cwd: sandbox.path, taskId: task.taskId, objective: spec.prompt.slice(0, 4_000), constraints: spec.constraints, decisions: plan.decisions });
          if (capsule !== null && capsule.length > 0) prompt = `${capsule}\n\n${spec.prompt}`;
          components.push('memory');
        }
        let shellTool: ShellTool | null = null;
        if (plan.components.includes('log-reduction')) {
          shellTool = jevris.shellTool({ home, cwd: sandbox.path, env });
          components.push('log-reduction');
        }
        const report: HarnessRunReport = signal.aborted
          ? { status: 'aborted', reason: 'aborted before start', inputTokens: 0, outputTokens: 0, cacheTokens: 0, costUsd: null, retries: null, actualModel: null }
          : await runner.run({
              prompt,
              model,
              cwd: sandbox.path,
              home,
              env,
              allowedTools: config.allowedTools,
              maxTurns: config.maxTurns,
              maxBudgetUsd: config.maxBudgetUsd,
              timeoutMs: config.runTimeoutMs,
              extraArgs: config.extraArgs,
              signal,
              plugin: plan.product && ready.prepared.pluginRel !== null ? join(home, ready.prepared.pluginRel) : null,
              shellTool,
            });
        const abandoned = report.status === 'aborted' || report.status === 'timeout' || signal.aborted;
        const receipts: { id: string; passed: boolean }[] = [];
        if (!abandoned) {
          for (const check of spec.checks) {
            const passed = await checks(check, { cwd: sandbox.path, env, timeoutMs: config.checkTimeoutMs, signal }).catch(() => false);
            receipts.push({ id: `${task.taskId}:${arm}:${check.id}`, passed });
          }
        }
        const inputTokens = count(report.inputTokens);
        const outputTokens = count(report.outputTokens);
        const estimated = estimateMicroUsd(config, report.actualModel ?? model, inputTokens + count(report.cacheTokens), outputTokens);
        const reported = report.costUsd !== null && Number.isFinite(report.costUsd) && report.costUsd >= 0;
        const costSource: DriverOutcome['costSource'] = reported ? 'provider-reported' : 'estimate';
        const measured: DriverOutcome['measuredComponents'][number][] = reported ? ['retries', 'cache'] : ['retries'];
        input.onRun?.({ taskId: task.taskId, arm, model, actualModel: report.actualModel, components, product: plan.product, decisions: plan.decisions, status: report.status, reason: report.reason.slice(0, 200), costSource });
        return {
          completed: report.status === 'completed' && !abandoned,
          receipts,
          retries: count(report.retries ?? 0),
          inputTokens,
          outputTokens,
          costMicroUsd: reported ? micro(report.costUsd as number) : estimated,
          costSource,
          estimatedCostMicroUsd: estimated,
          wallMs: Math.max(0, now() - begin),
          humanMinutes: 0,
          defectEscaped: false,
          abandoned,
          safetyFailures: [],
          measuredComponents: measured,
        };
      } finally {
        await rm(home, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
