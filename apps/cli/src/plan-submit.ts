/**
 * `jevris plan --submit`: hands a task plan and its root budget to D's `plan.submit` sidecar op
 * (ORC-01, ORC-05). It is CLI-only: the op needs the submit scope, which MCP clients and hooks
 * never hold (owned mode grants MCP `task.submit` only). Submitting commits a spending limit and
 * may start owned workers, so it needs `--yes` or a terminal confirmation.
 *
 * A new root budget also needs a person (SR-1, coordinator decision): a single-use terminal
 * authorization for it (`jevris authorize budget.increase --scope <budget-id>`, then
 * `--authorization <id>`, as `jevris budget update` takes it), or a person who answers y at an
 * interactive terminal without --yes. The sidecar's plan.submit refuses a new budget without
 * either (CHANNEL_REFUSED, AUTHORIZATION_REFUSED). A plan under a budget that already exists in
 * the workspace needs neither, so --yes keeps working for it.
 *
 * Money is integer micro-USD. The plan is the same file `jevris plan --graph` reads: a task
 * list, or `{ tasks, requirementIds?, availableResources? }`.
 */
import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { COMMAND_EXIT_CODES } from '@jevris/contracts';
import { defaultPorts } from './public/ports.js';
import { actorName } from './budget-command.js';
import { authorized, contextFor, parse, stdioIsTerminal, type VerifyAdminOptions } from './verify-admin.js';
import { homeRefusal } from './public/home-guard.js';

type Write = (text: string) => void;

/** The store's id pattern for task, budget and owner ids. */
const STORE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const PLAN_ID = /^plan-[0-9a-f]{20}$/;
const POLICIES = ['finish-running', 'cancel-newest', 'pause-all'] as const;
const MAX_LIMIT_MICRO_USD = 1_000_000_000_000;
const MAX_TASKS = 256;
const FILE_CAP = 1_048_576;
const REASONS = new Set(['SUBMITTED', 'PLAN_INVALID', 'DUPLICATE_TASK', 'BUDGET_CONFLICT', 'STORE_UNAVAILABLE', 'CHANNEL_REFUSED', 'AUTHORIZATION_REFUSED']);
const AUTHORIZATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const PLAN_SUBMIT_VALUE_FLAGS = ['--graph', '--owner', '--budget', '--limit-micro-usd', '--reserve-micro-usd', '--budget-policy', '--authorization', '--home', '--workspace'] as const;

/** The plan.submit result as the CLI shows it, rebuilt from checked values only. */
export interface PlanSubmitResult {
  readonly accepted: boolean;
  readonly reasonCode: string;
  readonly planId: string | null;
  readonly rootBudgetId: string | null;
  readonly taskIds: readonly string[];
  readonly waves: readonly (readonly string[])[];
  readonly leaseIds: readonly string[];
  readonly issues: readonly { readonly taskId: string; readonly code: string; readonly detail: string | null }[];
}

function ids(value: unknown, pattern: RegExp, cap: number): readonly string[] | null {
  if (!Array.isArray(value) || value.length > cap) return null;
  return value.every((v) => typeof v === 'string' && pattern.test(v)) ? (value as string[]) : null;
}

/** Checks the sidecar's answer against D's contract; null when it does not match. */
export function checkPlanSubmitResult(raw: unknown): PlanSubmitResult | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as { [key: string]: unknown };
  if (typeof r['accepted'] !== 'boolean' || typeof r['reasonCode'] !== 'string' || !REASONS.has(r['reasonCode'])) return null;
  const planId = r['planId'];
  const rootBudgetId = r['rootBudgetId'];
  if (planId !== null && (typeof planId !== 'string' || !PLAN_ID.test(planId))) return null;
  if (rootBudgetId !== null && (typeof rootBudgetId !== 'string' || !STORE_ID.test(rootBudgetId))) return null;
  const taskIds = ids(r['taskIds'], STORE_ID, MAX_TASKS);
  const leaseIds = ids(r['leaseIds'], /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, MAX_TASKS);
  if (taskIds === null || leaseIds === null || !Array.isArray(r['waves']) || r['waves'].length > MAX_TASKS) return null;
  const waves: (readonly string[])[] = [];
  for (const wave of r['waves']) {
    const checked = ids(wave, STORE_ID, MAX_TASKS);
    if (checked === null) return null;
    waves.push(checked);
  }
  if (!Array.isArray(r['issues']) || r['issues'].length > 64) return null;
  const issues: { taskId: string; code: string; detail: string | null }[] = [];
  for (const item of r['issues']) {
    const issue = item as { taskId?: unknown; code?: unknown; detail?: unknown } | null;
    if (issue === null || typeof issue !== 'object' || typeof issue.taskId !== 'string' || issue.taskId.length > 130 || typeof issue.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(issue.code)) return null;
    if (issue.detail !== null && (typeof issue.detail !== 'string' || issue.detail.length > 200)) return null;
    issues.push({ taskId: issue.taskId, code: issue.code, detail: issue.detail });
  }
  const accepted = r['accepted'];
  // An accepted plan has its ids; a refused one has none.
  if (accepted && (planId === null || rootBudgetId === null || taskIds.length === 0 || r['reasonCode'] !== 'SUBMITTED')) return null;
  if (!accepted && (planId !== null || r['reasonCode'] === 'SUBMITTED')) return null;
  return { accepted, reasonCode: r['reasonCode'], planId, rootBudgetId, taskIds, waves, leaseIds, issues };
}

function integer(text: string | undefined): number | null | undefined {
  if (text === undefined) return undefined;
  if (!/^\d{1,13}$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

function defaultOwner(): string | null {
  try {
    const name = userInfo().username.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 60);
    return STORE_ID.test(name) ? name : `u-${name}`.slice(0, 64);
  } catch {
    return null;
  }
}

function render(result: PlanSubmitResult & { readonly budgetId?: string }): string {
  if (!result.accepted) {
    const lines = [`The plan was not submitted (${result.reasonCode}). Nothing was created.`];
    for (const issue of result.issues) lines.push(`issue: ${issue.taskId} ${issue.code}${issue.detail === null ? '' : ` (${issue.detail})`}`);
    if (result.reasonCode === 'BUDGET_CONFLICT') lines.push('The budget id exists with other settings. Use a new --budget id, or the budget\'s current limit (see jevris budget status) and the same owner; a --reserve-micro-usd or --budget-policy you name must match the recorded one.');
    if (result.reasonCode === 'PLAN_INVALID') {
      // An INVALID_TASK issue names a scheduling field ("<field>: <rule>"); plan --graph checks only the task graph, so it would not show that problem.
      lines.push(
        result.issues.some((issue) => issue.code === 'INVALID_TASK')
          ? 'Fix the task field named above in the plan file. jevris plan --graph <file> checks only the task graph (ids, dependencies, scopes), not fields such as expectedOutputs.'
          : 'Check the plan with jevris plan --graph <file> first.',
      );
    }
    if (result.reasonCode === 'CHANNEL_REFUSED' || result.reasonCode === 'AUTHORIZATION_REFUSED') {
      lines.push(
        `A new root budget needs a person: answer at an interactive terminal without --yes, or run jevris authorize budget.increase --scope ${result.budgetId ?? '<budget-id>'} in a terminal and pass --authorization <id>${result.reasonCode === 'AUTHORIZATION_REFUSED' ? ' (this one is missing, used, expired, for another budget or for another person)' : ''}. A plan under an existing budget needs neither.`,
      );
    }
    return lines.join('\n');
  }
  const lines = [
    `Submitted plan ${result.planId ?? ''} with ${result.taskIds.length} task(s) under budget ${result.rootBudgetId ?? ''}.`,
    `plan: ${result.planId ?? 'none'}`,
    `root budget: ${result.rootBudgetId ?? 'none'}`,
    `tasks: ${result.taskIds.join(', ')}`,
  ];
  result.waves.forEach((wave, index) => lines.push(`wave ${index + 1}: ${wave.join(', ')}`));
  lines.push(result.leaseIds.length === 0 ? 'workers: none started (the tasks are queued; owned workers start only in bounded-auto mode with a worker model)' : `workers started: ${result.leaseIds.join(', ')}`);
  return lines.join('\n');
}

/** Runs `jevris plan --submit ...` (argv after `plan`). */
export async function runPlanSubmit(argv: readonly string[], write: Write, options: VerifyAdminOptions = {}): Promise<number> {
  const parsed = parse(argv, [...PLAN_SUBMIT_VALUE_FLAGS], ['--submit', '--json', '--yes']);
  const json = typeof parsed !== 'string' && parsed.flags.has('--json');
  const out = (result: object, text: string, code: number): number => {
    write(json ? `${JSON.stringify({ schemaVersion: '1.0', command: 'plan submit', ...result })}\n` : `${text}\n`);
    return code;
  };
  const usage = (message: string): number => {
    write(json ? `${JSON.stringify({ error: { code: 'USAGE', message } })}\n` : `${message}\nRun jevris help plan for usage.\n`);
    return COMMAND_EXIT_CODES.usage;
  };
  if (typeof parsed === 'string') return usage(parsed);
  if (parsed.positionals.length > 0) return usage(`Unexpected argument ${String(parsed.positionals[0]).slice(0, 40)}.`);
  const graph = parsed.values.get('--graph');
  if (graph === undefined) return usage('Give the plan file: jevris plan --submit --graph <tasks.json> --budget <id> --limit-micro-usd <n>.');
  const budgetId = parsed.values.get('--budget');
  if (budgetId === undefined || !STORE_ID.test(budgetId)) return usage('Give the root budget id with --budget <id> (a letter, then letters, digits, _ or -).');
  const limit = integer(parsed.values.get('--limit-micro-usd'));
  if (limit === undefined || limit === null || limit <= 0 || limit > MAX_LIMIT_MICRO_USD) return usage('Give the spending limit with --limit-micro-usd <n>, a whole number of micro-USD from 1 to 1000000000000 (1 USD = 1000000).');
  const reserve = integer(parsed.values.get('--reserve-micro-usd'));
  if (reserve === null || (reserve !== undefined && reserve >= limit)) return usage('--reserve-micro-usd must be a whole number below the limit.');
  const policy = parsed.values.get('--budget-policy');
  if (policy !== undefined && !(POLICIES as readonly string[]).includes(policy)) return usage(`--budget-policy is one of ${POLICIES.join(', ')}.`);
  const ownerId = parsed.values.get('--owner') ?? defaultOwner();
  if (ownerId === null || !STORE_ID.test(ownerId)) return usage('Give the plan owner with --owner <id> (a letter, then letters, digits, _ or -).');

  let value: unknown;
  try {
    const bytes = await readFile(graph);
    if (bytes.byteLength > FILE_CAP) return usage(`${graph} is larger than 1 MiB.`);
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return usage(`Cannot read ${graph} as UTF-8 JSON.`);
  }
  const wrapper = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as { [key: string]: unknown }) : null;
  const tasks = Array.isArray(value) ? value : wrapper?.['tasks'];
  if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > MAX_TASKS) return usage(`The plan needs 1 to ${MAX_TASKS} tasks.`);
  const plan: { [key: string]: unknown } = { tasks };
  for (const key of ['requirementIds', 'availableResources'] as const) if (wrapper !== null && wrapper[key] !== undefined) plan[key] = wrapper[key];

  const ctx = contextFor(parsed, options, options.ports ?? (await defaultPorts()));
  const refusedHome = homeRefusal(ctx);
  if (refusedHome !== null) return usage(refusedHome);
  if (ctx.workspaceRoot === null) return usage('No workspace here. Run this inside a repository or pass --workspace <dir>.');
  const authorizationId = parsed.values.get('--authorization');
  if (authorizationId !== undefined && !AUTHORIZATION_ID.test(authorizationId)) return usage('--authorization takes the id jevris authorize printed.');
  const dollars = (limit / 1_000_000).toFixed(6).replace(/\.?0+$/, '');
  if (!(await authorized(parsed, options, `Submit ${tasks.length} task(s) under budget ${budgetId} with a limit of ${dollars} USD? [y/N] `, write, json, 'This commits a spending limit and may start owned workers'))) {
    return COMMAND_EXIT_CODES.usage;
  }
  // A person answered at an interactive terminal (no --yes, --json or authorization, not a test
  // run): that may create a new root budget. The sidecar decides whether the budget is new.
  const atTerminal = authorizationId === undefined && !parsed.flags.has('--yes') && !json && ctx.env['JEVRIS_TEST'] !== '1' && (options.interactive ?? stdioIsTerminal)();

  if (ctx.autostart) {
    const ensured = await ctx.ports.sidecar.ensure({ home: ctx.home, waitMs: 5000 });
    if (!ensured.ok) return out({ accepted: false, reasonCode: `SIDECAR_${ensured.reason.toUpperCase()}` }, 'The Jevris sidecar is not running, so nothing was submitted. Start it with jevris sidecar start and retry.', COMMAND_EXIT_CODES.negative);
  }
  const answer = await ctx.ports.sidecar.request({
    home: ctx.home,
    op: 'plan.submit',
    workspace: ctx.workspaceRoot,
    body: {
      plan,
      ownerId,
      rootBudget: { id: budgetId, limitMicroUsd: limit, ...(reserve === undefined ? {} : { shutdownReserveMicroUsd: reserve }), ...(policy === undefined ? {} : { policy }) },
      ...(authorizationId === undefined ? {} : { authorizationId, actor: actorName(ctx.env) }),
      ...(atTerminal ? { channel: 'terminal' } : {}),
    },
    scope: 'cli',
    timeoutMs: 30_000,
    budget: 'background',
  });
  if (!answer.ok) {
    const code = answer.reasonCode ?? `SIDECAR_${answer.reason.toUpperCase()}`;
    const hint = code === 'KILL_SWITCH' ? ' The kill switch is stopped; see jevris kill-switch status.' : code === 'INVALID_REQUEST' ? ' Check the plan fields and ids.' : answer.reason === 'unavailable' ? ' Start the sidecar with jevris sidecar start and retry.' : '';
    return out({ accepted: false, reasonCode: code }, `Nothing was submitted (${code}).${hint}`, COMMAND_EXIT_CODES.negative);
  }
  const result = checkPlanSubmitResult(answer.result);
  if (result === null) return out({ accepted: false, reasonCode: 'SIDECAR_INVALID_RESULT' }, 'The sidecar answered in an unexpected shape; the plan state is unknown. Run jevris status.', COMMAND_EXIT_CODES.negative);
  // A refusal because no person confirmed the new budget is refused input (2), as the help says;
  // a plan the sidecar could not accept for another reason (invalid, a conflict) is 1.
  const needsPerson = result.reasonCode === 'CHANNEL_REFUSED' || result.reasonCode === 'AUTHORIZATION_REFUSED';
  return out(result, render({ ...result, budgetId }), result.accepted ? COMMAND_EXIT_CODES.ok : needsPerson ? COMMAND_EXIT_CODES.usage : COMMAND_EXIT_CODES.negative);
}
